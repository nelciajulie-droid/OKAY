/**
 * js-proxy-pool — pure-JS/TS replacement for proxy-scraper-cli (Python).
 *
 * WHY: User asked to remove all Python code from the project. The previous
 * free-proxy solution (`proxy-scraper-cli`) was Python; this mini-service
 * replaces it 1:1 in pure TypeScript. No pip, no venv, no Python runtime.
 *
 * WHAT IT DOES:
 *   1. Scrapes free HTTP proxy lists from public GitHub raw files
 *      (proxifly, TheSpeedX, monosans, clarketm, etc. — same sources as
 *      proxy-scraper-cli but a curated subset).
 *   2. Validates each proxy: connects via undici ProxyAgent, fetches
 *      https://api.ipify.org (so we know it supports HTTPS CONNECT),
 *      measures latency, records the exit IP. Drops honeypots (proxies
 *      that inject scripts into responses — checked by comparing the
 *      body to a known IPv4 regex).
 *   3. Exposes a rotating local proxy server on http://0.0.0.0:8792.
 *      Supports BOTH:
 *        - HTTP proxy mode (absolute URL in request line — undici
 *          ProxyAgent sends GET https://target)
 *        - HTTPS CONNECT tunneling (CONNECT host:443 — undici ProxyAgent
 *          sends this for HTTPS targets). The server tunnels the CONNECT
 *          through the upstream proxy by opening a raw TCP socket to the
 *          proxy, sending CONNECT, and piping the client socket through.
 *      Each incoming request is forwarded through a DIFFERENT validated
 *      proxy (round-robin rotation). If a proxy dies (network error), the
 *      server transparently retries with the next one in the pool.
 *   4. Background refill: every 30 minutes, scrapes + validates fresh
 *      proxies to keep the pool healthy (free proxies die fast).
 *
 * USAGE:
 *   bun run dev                         # listens on http://0.0.0.0:8792
 *   bun run dev -- --port 8793          # custom port
 *   bun run dev -- --want 50            # validate 50 proxies minimum before serving
 *   bun run dev -- --v                   # verbose
 *
 * Then in Boppy Studio → Settings → "FireProx URL (advanced)":
 *   http://127.0.0.1:8792
 *
 * The boppy.ts auto-retry (fetchWithProxyRetry, MAX_PROXY_RETRIES=3)
 * complements this: if a proxy dies mid-request, boppy resets the
 * ProxyAgent and retries — js-proxy-pool will route the retry through
 * a different proxy. Combined: dead proxies are transparently replaced.
 */

import { ProxyAgent, fetch as undiciFetch } from "undici";
import * as net from "node:net";
import * as http from "node:http";

// ---------------------------------------------------------------------------
// Config (CLI flags override env vars)
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : process.env[`JSPP_${name.toUpperCase()}`] ?? fallback;
}
function flag(name: string): boolean {
  return args.includes(`--${name}`);
}

const PORT = parseInt(arg("port", "8792"), 10);
const LISTEN = arg("listen", "0.0.0.0");
const WANT = parseInt(arg("want", "50"), 10); // minimum validated proxies before serving
const MAX_LATENCY_MS = parseInt(arg("max-latency", "8000"), 10);
const REFILL_INTERVAL_MS = parseInt(arg("refill-min", "30"), 10) * 60_000;
const VERBOSE = flag("v") || flag("verbose");

// ---------------------------------------------------------------------------
// Curated free proxy sources (same as proxy-scraper-cli's defaults but
// limited to GitHub raw files — no auth, no API keys, no rate limits).
// ---------------------------------------------------------------------------
const SOURCES: { name: string; url: string; parse: (text: string) => string[] }[] = [
  {
    name: "proxifly/http",
    url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt",
    parse: (t) => t.split("\n").map((l) => l.trim()).filter((l) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l)),
  },
  {
    name: "proxifly/https",
    url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/https/data.txt",
    parse: (t) => t.split("\n").map((l) => l.trim()).filter((l) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l)),
  },
  {
    name: "TheSpeedX/http",
    url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
    parse: (t) => t.split("\n").map((l) => l.trim()).filter((l) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l)),
  },
  {
    name: "monosans/proxylist/http",
    url: "https://raw.githubusercontent.com/monosans/proxylist/main/proxies/http.txt",
    parse: (t) => t.split("\n").map((l) => l.trim()).filter((l) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l)),
  },
  {
    name: "monosans/proxylist/https",
    url: "https://raw.githubusercontent.com/monosans/proxylist/main/proxies/https.txt",
    parse: (t) => t.split("\n").map((l) => l.trim()).filter((l) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l)),
  },
  {
    name: "clarketm/proxy-list",
    url: "https://raw.githubusercontent.com/clarketm/http-proxy-list/master/proxy-list-raw.txt",
    parse: (t) =>
      t
        .split("\n")
        .map((l) => l.trim().split(/\s+/)[0])
        .filter((l) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l)),
  },
  {
    name: "roosterkid/openproxylist",
    url: "https://raw.githubusercontent.com/roosterkid/open-proxy-list/main/proxy-list/data.txt",
    parse: (t) => t.split("\n").map((l) => l.trim()).filter((l) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l)),
  },
];

// ---------------------------------------------------------------------------
// Proxy pool
// ---------------------------------------------------------------------------
interface Proxy {
  url: string; // "http://ip:port"
  ip: string;
  port: number;
  exitIp?: string;
  latencyMs?: number;
  lastOk?: number;
  fails: number;
}

const pool: Proxy[] = [];
let poolIdx = 0;

function log(level: "INFO" | "OK" | "WARN" | "ERR", msg: string): void {
  const ts = new Date().toISOString().split("T")[1]!.split(".")[0];
  console.log(`[${ts}] [${level}] ${msg}`);
}
function vlog(msg: string): void {
  if (VERBOSE) log("INFO", msg);
}

const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

// ---------------------------------------------------------------------------
// Validate one proxy: fetch https://api.ipify.org through it via undici
// ProxyAgent. This tests the full path (CONNECT + TLS + GET) and returns
// the exit IP, which is exactly what boppy.ts will do to reach boppy.me.
// ---------------------------------------------------------------------------
async function validateProxy(proxyUrl: string, timeoutMs = 8000): Promise<Proxy | null> {
  const start = Date.now();
  try {
    const agent = new ProxyAgent({ uri: proxyUrl });
    const res = await undiciFetch("https://api.ipify.org", {
      dispatcher: agent,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latency = Date.now() - start;
    if (res.status !== 200) return null;
    const body = (await res.text()).trim();
    try { await (agent as unknown as { close?: () => Promise<void> }).close?.(); } catch { /* ignore */ }
    if (!IPV4_RE.test(body) || body.length > 20) {
      vlog(`honeypot detected on ${proxyUrl}: body[:50]=${body.slice(0, 50)}`);
      return null;
    }
    if (latency > MAX_LATENCY_MS) {
      vlog(`slow proxy ${proxyUrl}: ${latency}ms (max ${MAX_LATENCY_MS}ms)`);
      return null;
    }
    return {
      url: proxyUrl,
      ip: proxyUrl.replace(/^https?:\/\//, "").split(":")[0]!,
      port: parseInt(proxyUrl.replace(/^https?:\/\//, "").split(":")[1] ?? "0", 10),
      exitIp: body,
      latencyMs: latency,
      lastOk: Date.now(),
      fails: 0,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scrape all sources in parallel, dedupe, return unique proxy URLs.
// ---------------------------------------------------------------------------
async function scrapeSources(): Promise<Set<string>> {
  log("INFO", `Scraping ${SOURCES.length} sources in parallel...`);
  const results = await Promise.allSettled(
    SOURCES.map(async (s) => {
      try {
        const res = await fetch(s.url, {
          signal: AbortSignal.timeout(30_000),
          headers: { "User-Agent": "js-proxy-pool/1.0" },
        });
        if (!res.ok) throw new Error(`${res.status}`);
        const text = await res.text();
        const proxies = s.parse(text);
        vlog(`source ${s.name}: ${proxies.length} proxies`);
        return proxies;
      } catch (err) {
        vlog(`source ${s.name} failed: ${(err as Error).message}`);
        return [] as string[];
      }
    }),
  );
  const all = new Set<string>();
  let total = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      for (const p of r.value) {
        total++;
        all.add(`http://${p}`);
      }
    }
  }
  log("INFO", `Collected ${total} raw proxies → ${all.size} unique URLs`);
  return all;
}

// ---------------------------------------------------------------------------
// Validate a batch of proxies with bounded concurrency. Stops early when
// WANT validated proxies are found.
// ---------------------------------------------------------------------------
async function validateBatch(urls: string[], want: number, concurrency = 50): Promise<Proxy[]> {
  const validated: Proxy[] = [];
  let idx = 0;
  let inFlight = 0;
  return new Promise((resolve) => {
    const next = (): void => {
      if (validated.length >= want) {
        if (inFlight === 0) resolve(validated);
        return;
      }
      if (idx >= urls.length) {
        if (inFlight === 0) resolve(validated);
        return;
      }
      const url = urls[idx++]!;
      inFlight++;
      validateProxy(url)
        .then((p) => {
          if (p) {
            validated.push(p);
            if (validated.length % 10 === 0 || validated.length >= want) {
              log("OK", `Validated ${validated.length}/${want} proxies (latency=${p.latencyMs}ms)`);
            }
          }
        })
        .catch(() => {})
        .finally(() => {
          inFlight--;
          next();
        });
    };
    for (let i = 0; i < concurrency; i++) next();
  });
}

// ---------------------------------------------------------------------------
// Background refill — scrapes + validates fresh proxies periodically.
// ---------------------------------------------------------------------------
let refillRunning = false;
async function refillPool(): Promise<void> {
  if (refillRunning) return;
  refillRunning = true;
  try {
    const urls = await scrapeSources();
    const existing = new Set(pool.map((p) => p.url));
    const fresh = Array.from(urls).filter((u) => !existing.has(u));
    for (let i = fresh.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [fresh[i], fresh[j]] = [fresh[j]!, fresh[i]!];
    }
    log("INFO", `Refilling: validating up to ${Math.min(fresh.length, 1000)} fresh proxies...`);
    const validated = await validateBatch(fresh.slice(0, 1000), WANT, 100);
    pool.push(...validated);
    const before = pool.length;
    for (let i = pool.length - 1; i >= 0; i--) {
      if (pool[i]!.fails > 3) pool.splice(i, 1);
    }
    log("OK", `Refill complete: +${validated.length} added, ${before - pool.length} dropped, pool=${pool.length}`);
  } catch (err) {
    log("ERR", `Refill failed: ${(err as Error).message}`);
  } finally {
    refillRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Pick next proxy (round-robin). Skips proxies that have failed too often.
// ---------------------------------------------------------------------------
function nextProxy(): Proxy | null {
  if (pool.length === 0) return null;
  for (let i = 0; i < pool.length; i++) {
    poolIdx = (poolIdx + 1) % pool.length;
    const p = pool[poolIdx]!;
    if (p.fails < 3) return p;
  }
  return pool[0] ?? null;
}

// ---------------------------------------------------------------------------
// Handle CONNECT (HTTPS tunneling). Opens a TCP socket to the upstream
// proxy, sends "CONNECT host:port HTTP/1.1\r\n\r\n", waits for "200
// Connection established", then pipes the client socket through.
// ---------------------------------------------------------------------------
function handleConnect(
  clientSocket: net.Socket,
  targetHost: string,
  targetPort: number,
  maxTries = 3,
): void {
  let tryCount = 0;
  const attempt = (): void => {
    if (tryCount >= maxTries) {
      try { clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch { /* ignore */ }
      return;
    }
    tryCount++;
    const proxy = nextProxy();
    if (!proxy) {
      try { clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nX-JSProxyPool: empty\r\n\r\n"); } catch { /* ignore */ }
      return;
    }
    vlog(`[CONNECT ${tryCount}/${maxTries}] ${targetHost}:${targetPort} via ${proxy.url} (exit ${proxy.exitIp})`);

    // Parse proxy host:port.
    const proxyHost = proxy.ip;
    const proxyPort = proxy.port;
    const upstream = net.createConnection({
      host: proxyHost,
      port: proxyPort,
      timeout: 15_000,
    });

    let connected = false;
    let buffer = "";

    upstream.on("connect", () => {
      // Send CONNECT request to the upstream proxy.
      upstream.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`,
      );
    });

    upstream.on("data", function onData(chunk: Buffer): void {
      if (!connected) {
        buffer += chunk.toString("utf8");
        // Look for end of HTTP response headers.
        const endOfHeaders = buffer.indexOf("\r\n\r\n");
        if (endOfHeaders >= 0) {
          const statusLine = buffer.split("\r\n")[0] ?? "";
          if (/^HTTP\/1\.[01] 2\d\d /.test(statusLine)) {
            // CONNECT succeeded — pipe both ways.
            connected = true;
            // Send any remaining bytes (after headers) to the client.
            const remaining = buffer.slice(endOfHeaders + 4);
            buffer = "";
            // Tell the client the tunnel is established.
            try { clientSocket.write("HTTP/1.1 200 Connection established\r\n\r\n"); } catch { /* ignore */ }
            if (remaining.length > 0) {
              try { clientSocket.write(remaining); } catch { /* ignore */ }
            }
            // Pipe bidirectionally.
            upstream.removeAllListeners("data");
            upstream.on("data", (c: Buffer) => { try { clientSocket.write(c); } catch { /* ignore */ } });
            clientSocket.on("data", (c: Buffer) => { try { upstream.write(c); } catch { /* ignore */ } });
            // Done.
            proxy.lastOk = Date.now();
            vlog(`  CONNECT tunnel established via ${proxy.url}`);
          } else {
            // Proxy rejected CONNECT — try next proxy.
            vlog(`  CONNECT rejected by ${proxy.url}: ${statusLine}, retrying with next proxy...`);
            proxy.fails++;
            try { upstream.destroy(); } catch { /* ignore */ }
            attempt();
          }
        }
      }
    });

    upstream.on("error", (err: Error) => {
      if (!connected) {
        vlog(`  upstream CONNECT error on ${proxy.url}: ${err.message}, retrying...`);
        proxy.fails++;
        attempt();
      }
    });

    upstream.on("timeout", () => {
      if (!connected) {
        vlog(`  upstream CONNECT timeout on ${proxy.url}, retrying...`);
        proxy.fails++;
        try { upstream.destroy(); } catch { /* ignore */ }
        attempt();
      }
    });

    clientSocket.on("error", () => { try { upstream.destroy(); } catch { /* ignore */ } });
    clientSocket.on("close", () => { try { upstream.destroy(); } catch { /* ignore */ } });
  };
  attempt();
}

// ---------------------------------------------------------------------------
// Handle absolute-URL HTTP request (HTTP proxy mode for HTTP targets).
// ---------------------------------------------------------------------------
const FORWARDABLE_REQUEST_HEADERS = [
  "content-type",
  "user-agent",
  "accept",
  "origin",
  "referer",
  "range",
  "x-my-x-forwarded-for",
];
const FORWARDABLE_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
  "cache-control",
];

async function forwardHttpProxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: string,
): Promise<void> {
  const MAX_TRIES = 3;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const proxy = nextProxy();
    if (!proxy) {
      res.writeHead(502, { "Content-Type": "application/json", "X-JSProxyPool": "empty" });
      res.end(JSON.stringify({ error: "No validated proxies in pool" }));
      return;
    }
    const upstreamHeaders: Record<string, string> = {};
    for (const name of FORWARDABLE_REQUEST_HEADERS) {
      const v = req.headers[name];
      if (typeof v === "string") upstreamHeaders[name] = v;
    }
    const octet = () => Math.floor(Math.random() * 223) + 1;
    upstreamHeaders["X-Forwarded-For"] = `${octet()}.${octet()}.${octet()}.${octet()}`;

    const agent = new ProxyAgent({ uri: proxy.url });
    try {
      vlog(`[HTTP ${attempt}/${MAX_TRIES}] ${req.method} ${target} via ${proxy.url} (exit ${proxy.exitIp})`);
      const body = req.method === "GET" || req.method === "HEAD" ? null : await new Promise<Buffer>((r) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => r(Buffer.concat(chunks)));
        req.on("error", () => r(Buffer.alloc(0)));
      });
      const upstream = await undiciFetch(target, {
        method: req.method,
        headers: upstreamHeaders,
        body: body ?? null,
        dispatcher: agent,
        signal: AbortSignal.timeout(60_000),
      });
      try { await (agent as unknown as { close?: () => Promise<void> }).close?.(); } catch { /* ignore */ }

      if (upstream.status === 502 || upstream.status === 503 || upstream.status === 504) {
        proxy.fails++;
        vlog(`  upstream ${upstream.status} on ${proxy.url}, retrying...`);
        try { await upstream.arrayBuffer(); } catch { /* ignore */ }
        continue;
      }
      proxy.lastOk = Date.now();

      const outHeaders: Record<string, string> = { "X-JSProxyPool": "1", "X-JSProxyPool-Proxy": proxy.ip };
      for (const name of FORWARDABLE_RESPONSE_HEADERS) {
        const v = upstream.headers.get(name);
        if (v) outHeaders[name] = v;
      }
      res.writeHead(upstream.status, outHeaders);
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.end(buf);
      return;
    } catch (err) {
      proxy.fails++;
      try { await (agent as unknown as { close?: () => Promise<void> }).close?.(); } catch { /* ignore */ }
      vlog(`  proxy ${proxy.url} failed: ${(err as Error).message}, retrying...`);
      continue;
    }
  }
  res.writeHead(502, { "Content-Type": "application/json", "X-JSProxyPool": "exhausted" });
  res.end(JSON.stringify({ error: "All proxy retries exhausted" }));
}

// ---------------------------------------------------------------------------
// HTTP server (node:http — supports both CONNECT and normal requests).
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        type: "js-proxy-pool",
        poolSize: pool.length,
        uniqueExitIps: new Set(pool.map((p) => p.exitIp)).size,
        avgLatencyMs: pool.length
          ? Math.round(pool.reduce((s, p) => s + (p.latencyMs ?? 0), 0) / pool.length)
          : 0,
        refillRunning,
      }),
    );
    return;
  }
  if (url.pathname === "/stats") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        poolSize: pool.length,
        proxies: pool.slice(0, 50).map((p) => ({
          ip: p.ip,
          port: p.port,
          exitIp: p.exitIp,
          latencyMs: p.latencyMs,
          fails: p.fails,
        })),
      }),
    );
    return;
  }

  // HTTP proxy mode — absolute URL in request line.
  if (req.url && /^https?:\/\//i.test(req.url)) {
    void forwardHttpProxy(req, res, req.url);
    return;
  }

  // Unknown request — 404.
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found. Use as HTTP proxy (set as proxy URL) or GET /health.");
});

// CONNECT method — HTTPS tunneling through upstream proxy.
server.on("connect", (req, clientSocket) => {
  const [host, portStr] = (req.url ?? "").split(":");
  const port = parseInt(portStr ?? "443", 10);
  if (!host || !Number.isFinite(port)) {
    try { clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch { /* ignore */ }
    return;
  }
  handleConnect(clientSocket, host, port);
});

server.listen(PORT, LISTEN, () => {
  log("INFO", `js-proxy-pool listening on http://${LISTEN}:${PORT} (HTTP + CONNECT)`);
});

// ---------------------------------------------------------------------------
// Initial pool warmup + background refill
// ---------------------------------------------------------------------------
log("INFO", `WANT=${WANT} proxies, MAX_LATENCY=${MAX_LATENCY_MS}ms, REFILL=${REFILL_INTERVAL_MS}ms, VERBOSE=${VERBOSE}`);

(async () => {
  log("INFO", `Warming up pool — scraping + validating ${WANT} proxies...`);
  const t0 = Date.now();
  const urls = await scrapeSources();
  const arr = Array.from(urls);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  const validated = await validateBatch(arr.slice(0, 2000), WANT, 100);
  pool.push(...validated);
  log("OK", `Pool ready: ${pool.length} validated proxies in ${(Date.now() - t0) / 1000}s`);

  setInterval(() => {
    void refillPool();
  }, REFILL_INTERVAL_MS);
})();
