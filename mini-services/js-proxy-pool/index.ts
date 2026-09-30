/**
 * js-proxy-pool — pure-JS/TS free proxy pool + rotator.
 *
 * Built on top of `proxy-chain` (Apify, MIT) — the production-grade HTTP
 * proxy server for Node.js used by Crawlee. Handles HTTP CONNECT tunneling,
 * SSL/TLS, SOCKS4/5, authentication, and upstream proxy chaining.
 *
 * WHAT IT DOES:
 *   1. Scrapes free HTTP proxy lists from public GitHub raw files.
 *   2. Validates each proxy: fetches https://api.ipify.org through it via
 *      undici ProxyAgent (CONNECT + TLS + GET → exit IP). Drops honeypots
 *      and slow proxies (>8s latency).
 *   3. Exposes a rotating local proxy server on http://0.0.0.0:8792 via
 *      proxy-chain's Server class. The `prepareRequestFunction` callback
 *      picks a proxy that's actually alive RIGHT NOW (on-demand re-validation
 *      with 3s timeout) from a round-robin pool. Dead proxies are dropped
 *      aggressively after just 1 fail (free proxies die fast — keep no
      stale state).
 *   4. Background refill every 15 minutes: scrapes + validates fresh
 *      proxies so the pool stays healthy.
 *
 * RETRY STORY:
 *   proxy-chain itself does NOT retry on upstream proxy failure (if a proxy
 *   dies mid-request, the request fails). The retry happens at the boppy.ts
 *   layer: boppy.ts's fetchWithProxyRetry wraps every API call with up to
 *   MAX_PROXY_RETRIES=6 retries. Each retry creates a NEW ProxyAgent, which
 *   opens a NEW connection to this proxy-chain server, which calls
 *   prepareRequestFunction again, which picks a DIFFERENT alive proxy via
 *   round-robin + on-demand validation. So a dead proxy → boppy.ts retries
 *   → new connection → new alive proxy. Combined with this server's
 *   aggressive fail-tracking, we get a robust retry chain that survives
 *   free proxy churn.
 *
 * USAGE:
 *   node index.ts                    # listens on http://0.0.0.0:8792
 *   node index.ts --port 8793        # custom port
 *   node index.ts --want 100         # validate 100 proxies before serving
 *   node index.ts --v                # verbose
 *
 * In Boppy Studio → Settings → "FireProx URL (advanced)":
 *   http://127.0.0.1:8792
 */

import { Server } from "proxy-chain";
import { ProxyAgent, fetch as undiciFetch } from "undici";
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
const WANT = parseInt(arg("want", "100"), 10);
const MAX_LATENCY_MS = parseInt(arg("max-latency", "8000"), 10);
const REFILL_INTERVAL_MS = parseInt(arg("refill-min", "15"), 10) * 60_000;
const VERBOSE = flag("v") || flag("verbose");
const ODM_TIMEOUT_MS = parseInt(arg("odm-timeout", "3000"), 10);
const ODM_MAX_TRIES = parseInt(arg("odm-tries", "10"), 10);
const FAIL_THRESHOLD = parseInt(arg("fail-threshold", "2"), 10);

// ---------------------------------------------------------------------------
// Curated free proxy sources (GitHub raw files only — no auth, no API keys).
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
    name: "monosans/http",
    url: "https://raw.githubusercontent.com/monosans/proxylist/main/proxies/http.txt",
    parse: (t) => t.split("\n").map((l) => l.trim()).filter((l) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l)),
  },
  {
    name: "monosans/https",
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
  url: string;
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
// ProxyAgent (CONNECT + TLS + GET → exit IP).
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
    if (latency > MAX_LATENCY_MS) return null;
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
    log("INFO", `Refilling: validating up to ${Math.min(fresh.length, 2000)} fresh proxies...`);
    const validated = await validateBatch(fresh.slice(0, 2000), WANT * 2, 100);
    pool.push(...validated);
    const before = pool.length;
    // Drop dead proxies (fails > 0 — aggressive: free proxies die fast).
    for (let i = pool.length - 1; i >= 0; i--) {
      if (pool[i]!.fails >= FAIL_THRESHOLD) pool.splice(i, 1);
    }
    log("OK", `Refill complete: +${validated.length} added, ${before - pool.length} dropped, pool=${pool.length}`);
  } catch (err) {
    log("ERR", `Refill failed: ${(err as Error).message}`);
  } finally {
    refillRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Pick next proxy (round-robin). Skips proxies that have failed.
// ---------------------------------------------------------------------------
function nextProxy(): Proxy | null {
  if (pool.length === 0) return null;
  for (let i = 0; i < pool.length; i++) {
    poolIdx = (poolIdx + 1) % pool.length;
    const p = pool[poolIdx]!;
    if (p.fails < FAIL_THRESHOLD) return p;
  }
  return pool[0] ?? null;
}

/**
 * Pick a proxy that ACTUALLY works RIGHT NOW by re-validating on-demand.
 * Tries up to ODM_MAX_TRIES proxies, validating each with ODM_TIMEOUT_MS.
 * If all fail, returns null (the request will fail with 502, and boppy.ts
 * will retry with a fresh ProxyAgent connection → new prepareRequestFunction
 * call → new alive proxy from a possibly-refilled pool).
 *
 * On-demand validation is the key to making free proxies usable: a pool
 * validated 1 minute ago may be 50% dead now. Re-checking each candidate
 * at request time guarantees we hand boppy a proxy that responds NOW.
 */
const inflightValidations = new Map<string, Promise<boolean>>();
async function isProxyAliveNow(proxyUrl: string): Promise<boolean> {
  let p = inflightValidations.get(proxyUrl);
  if (!p) {
    p = (async () => {
      try {
        const agent = new ProxyAgent({ uri: proxyUrl });
        const res = await undiciFetch("https://api.ipify.org", {
          dispatcher: agent,
          signal: AbortSignal.timeout(ODM_TIMEOUT_MS),
        });
        try { await (agent as unknown as { close?: () => Promise<void> }).close?.(); } catch { /* ignore */ }
        return res.status === 200;
      } catch {
        return false;
      }
    })();
    inflightValidations.set(proxyUrl, p);
    p.finally(() => inflightValidations.delete(proxyUrl));
  }
  return p;
}

async function pickAliveProxy(): Promise<Proxy | null> {
  if (pool.length === 0) return null;
  for (let i = 0; i < Math.min(ODM_MAX_TRIES, pool.length); i++) {
    const proxy = nextProxy();
    if (!proxy) return null;
    const alive = await isProxyAliveNow(proxy.url);
    if (alive) {
      proxy.lastOk = Date.now();
      return proxy;
    }
    proxy.fails++;
    vlog(`  proxy ${proxy.url} dead on-demand (fails=${proxy.fails})`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// proxy-chain server — production-grade HTTP/HTTPS proxy with CONNECT
// tunneling. The `prepareRequestFunction` callback is called for each
// incoming request and returns the upstream proxy URL to chain through.
// We rotate through the pool here, with on-demand re-validation.
// ---------------------------------------------------------------------------
const server = new Server({
  port: PORT,
  host: LISTEN,
  verbose: VERBOSE,
  prepareRequestFunction: async ({ request, hostname }) => {
    if (hostname === "127.0.0.1" || hostname === "localhost") {
      return { requestAuthentication: false, upstreamProxyUrl: undefined };
    }
    const proxy = await pickAliveProxy();
    if (!proxy) {
      vlog(`No live proxy in pool — request to ${hostname} will fail (boppy.ts will retry)`);
      return { requestAuthentication: false, upstreamProxyUrl: undefined };
    }
    vlog(`[${request.method}] ${hostname} → via ${proxy.url} (exit ${proxy.exitIp})`);
    return {
      requestAuthentication: false,
      upstreamProxyUrl: proxy.url,
    };
  },
});

// ---------------------------------------------------------------------------
// Health + stats HTTP server on PORT+1.
// ---------------------------------------------------------------------------
const HEALTH_PORT = PORT + 1;
const healthServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        type: "js-proxy-pool",
        backend: "proxy-chain",
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
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found. Use as HTTP proxy (set as proxy URL) or GET /health.");
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
log("INFO", `js-proxy-pool (proxy-chain) starting on http://${LISTEN}:${PORT}`);
log("INFO", `WANT=${WANT}, MAX_LATENCY=${MAX_LATENCY_MS}ms, REFILL=${REFILL_INTERVAL_MS}ms, ODM_TIMEOUT=${ODM_TIMEOUT_MS}ms, ODM_TRIES=${ODM_MAX_TRIES}, FAIL_THRESHOLD=${FAIL_THRESHOLD}, VERBOSE=${VERBOSE}`);

healthServer.listen(HEALTH_PORT, LISTEN, () => {
  log("INFO", `Health endpoint on http://${LISTEN}:${HEALTH_PORT}/health`);
});

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
  log("OK", `Pool ready: ${pool.length} validated proxies in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  await server.listen();
  log("OK", `Proxy server listening on http://${LISTEN}:${PORT}`);

  setInterval(() => {
    void refillPool();
  }, REFILL_INTERVAL_MS);
})();
