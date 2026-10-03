/**
 * Perplexity Realtime voice — SDP exchange route.
 *
 * The browser does the WebRTC handshake client-side and POSTs its SDP offer
 * here. We forward that offer to Perplexity's realtime session endpoint,
 * along with the Perplexity session cookies (stored in the vault Worker by
 * the Chrome extension). Perplexity replies with an SDP answer (wrapped in
 * a small JSON envelope), which we relay back to the browser.
 *
 * Perplexity's realtime endpoint is Cloudflare-fronted, so it is both
 * TLS-fingerprint sensitive (a plain Node fetch gets challenged) and the
 * `cf_clearance` cookie is bound to the IP that solved the challenge. We
 * therefore mirror the same two-tier strategy used by the ChatGPT realtime
 * route (`src/app/api/realtime/connect/route.ts`):
 *
 *   1. curl-impersonate (Chrome JA3/JA4) when the binary is available — the
 *      only path that can pass Cloudflare's TLS check without a proxy that
 *      matches the cookie's IP.
 *   2. Pure-JS fallback (socks-proxy-agent / https-proxy-agent) — tries the
 *      configured proxies in parallel, 5 at a time, and returns the first
 *      valid SDP answer. This is the Vercel-friendly path.
 *
 * Env vars:
 *   CHATGPT_VAULT_URL     – vault Worker base URL (e.g. https://chatgpt-jwt-vault…)
 *   CHATGPT_VAULT_SECRET   – vault secret (X-Vault-Secret header)
 *   PERPLEXITY_PROXY_LIST  – optional comma-separated proxy URLs for the
 *                            pure-JS fallback (socks5://, http://, https://)
 *
 * The vault KV key for Perplexity cookies is `perplexity_cookies` and the
 * vault endpoints are GET/POST /perplexity/cookies.
 */

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import https from "node:https";
import { URL } from "node:url";
import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { NextResponse } from "next/server";

// curl-impersonate binary path (same as the ChatGPT route).
const CURL_IMPERSONATE_BIN =
  "/home/z/my-project/node_modules/node-curl-impersonate/bin/curl-impersonate-chrome-linux-x86";

// Perplexity realtime session endpoint.
const PERPLEXITY_SESSION_URL =
  "https://www.perplexity.ai/rest/realtime/v2/session?version=2.18&source=default";

// A realistic desktop Chrome User-Agent (must match the one that solved the
// Cloudflare challenge — the Chrome extension re-uses the browser cookies).
const PERPLEXITY_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

// sec-ch-ua header values that match the User-Agent above.
const SEC_CH_UA =
  '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"';

/** Build the full set of headers Perplexity's edge expects for an SDP exchange. */
function buildPerplexityHeaders(
  cookies: string,
  account: string | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": PERPLEXITY_UA,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Content-Type": "application/json",
    Origin: "https://www.perplexity.ai",
    Referer: "https://www.perplexity.ai/",
    "sec-ch-ua": SEC_CH_UA,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    Cookie: cookies,
    // Perplexity-specific headers (captured from the live site).
    "x-app-apiclient": "default",
    "x-app-apiversion": "2.18",
    "x-perplexity-request-endpoint": PERPLEXITY_SESSION_URL,
    "x-perplexity-request-reason": "realtime-sdp-exchange",
    "x-request-id": randomUuid(),
  };
  if (account) headers["x-pplx-account"] = account;
  return headers;
}

/** RFC4122-ish UUID using Web crypto. */
function randomUuid(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0"));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h
    .slice(8, 10)
    .join("")}-${h.slice(10, 16).join("")}`;
}

/** Vault response shape for the Perplexity cookies endpoint. */
interface VaultPerplexityResponse {
  cookies?: string;
  account?: string | null;
  updatedAt?: number | null;
  error?: string;
}

/** Fetch the Perplexity cookies (and account UUID) from the vault Worker. */
async function fetchPerplexityCookies(): Promise<{ cookies: string; account: string | null }> {
  const vaultUrl = (process.env.CHATGPT_VAULT_URL ?? "").trim();
  const vaultSecret = (process.env.CHATGPT_VAULT_SECRET ?? "").trim();
  if (!vaultUrl) {
    throw new Error("CHATGPT_VAULT_URL is not set — cannot fetch Perplexity cookies.");
  }
  const url = `${vaultUrl.replace(/\/+$/, "")}/perplexity/cookies`;
  const res = await fetch(url, {
    headers: { "X-Vault-Secret": vaultSecret },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Vault returned ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as VaultPerplexityResponse;
  if (!data.cookies) {
    throw new Error(
      data.error ?? "No Perplexity cookies in vault. Run the Chrome extension first.",
    );
  }
  return { cookies: data.cookies, account: data.account ?? null };
}

/**
 * Extract the SDP answer from a Perplexity realtime response.
 * The response is a JSON envelope; the answer SDP has been seen under a few
 * possible field names, so we try them in order of likelihood.
 */
function extractSdpAnswer(body: string): string | null {
  // Some edge responses are plain-text SDP — accept that too.
  if (body.startsWith("v=0")) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed === "string") return parsed.startsWith("v=0") ? parsed : null;
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    for (const key of ["answer_sdp", "sdp", "answerSdp", "answer", "data", "result"]) {
      const v = obj[key];
      if (typeof v === "string" && v.startsWith("v=0")) return v;
      // Nested envelope, e.g. { data: { answer_sdp: "v=0..." } }
      if (v && typeof v === "object") {
        const inner = v as Record<string, unknown>;
        for (const innerKey of ["answer_sdp", "sdp", "answerSdp", "answer"]) {
          const iv = inner[innerKey];
          if (typeof iv === "string" && iv.startsWith("v=0")) return iv;
        }
      }
    }
  }
  return null;
}

/** Build the JSON body for the Perplexity session request.
 * Perplexity requires: source, timezone, voice, sdp (all required). */
function buildPerplexityBody(sdp: string): string {
  return JSON.stringify({
    source: "default",
    timezone: "Africa/Nairobi",
    voice: "default",
    sdp,
    offer_sdp: sdp,
    type: "offer",
  });
}

/**
 * curl-impersonate path — spawn the Chrome-impersonating curl binary with the
 * TLS/JA3 flags that match desktop Chrome. Returns the raw response body or
 * throws on non-2xx.
 */
async function connectViaCurlImpersonate(
  cookies: string,
  account: string | null,
  sdp: string,
  proxy?: string | null,
): Promise<string> {
  const body = buildPerplexityBody(sdp);
  const headers = buildPerplexityHeaders(cookies, account);

  const args = [
    "-sS", // silent + show errors
    "--max-time",
    "60",
    "--connect-timeout",
    "20",
    "-X",
    "POST",
    PERPLEXITY_SESSION_URL,
    "--data-binary",
    "@-", // read body from stdin
    // NOTE: this curl-impersonate binary (8.1.1, BoringSSL) has the Chrome
    // TLS fingerprint BUILT-IN — no `--impersonate chrome131` flag needed.
    "--http2",
    "--compressed",
  ];
  // If a proxy is provided, add it to the curl args. curl-impersonate
  // supports --socks5, --socks4, and -x (HTTP proxy) flags.
  if (proxy) {
    if (proxy.startsWith("socks5://")) {
      args.push("--socks5", proxy.replace("socks5://", ""));
    } else if (proxy.startsWith("socks4://")) {
      args.push("--socks4", proxy.replace("socks4://", ""));
    } else {
      args.push("-x", proxy);
    }
  }
  for (const [k, v] of Object.entries(headers)) {
    args.push("-H", `${k}: ${v}`);
  }

  return new Promise<string>((resolve, reject) => {
    const child = spawn(CURL_IMPERSONATE_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) =>
      reject(new Error(`curl-impersonate spawn failed: ${err.message}`)),
    );
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`curl-impersonate exited ${code}: ${stderr.slice(0, 400)}`));
        return;
      }
      resolve(stdout);
    });
    child.stdin.end(body);
  });
}

/**
 * Pure-JS fallback — try the configured proxies in parallel, 5 at a time.
 * Returns the first valid SDP answer. Uses SocksProxyAgent for socks5:// and
 * HttpsProxyAgent for http(s):// proxies.
 */
async function connectViaProxies(
  cookies: string,
  account: string | null,
  sdp: string,
): Promise<string> {
  const proxyList = (process.env.PERPLEXITY_PROXY_LIST ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  const body = buildPerplexityBody(sdp);
  const headers = buildPerplexityHeaders(cookies, account);

  // No proxies → one direct attempt (will likely be Cloudflare-challenged,
  // but try anyway — some endpoints let datacenter IPs through).
  const attempts: (string | null)[] = proxyList.length > 0 ? proxyList : [null];

  const CONCURRENCY = 5;
  for (let i = 0; i < attempts.length; i += CONCURRENCY) {
    const batch = attempts.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((proxy) => connectViaNodeHttps(proxy, headers, body)),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) return r.value;
    }
  }
  throw new Error(
    "All proxy attempts failed (or no proxies configured and direct connection was blocked).",
  );
}

/**
 * Single attempt through one proxy (or direct when proxy is null). Uses
 * Node's `https` module so the SocksProxyAgent / HttpsProxyAgent agents are
 * honoured (Node's global fetch doesn't accept an `agent` option).
 */
function connectViaNodeHttps(
  proxy: string | null,
  headers: Record<string, string>,
  body: string,
): Promise<string | null> {
  const target = new URL(PERPLEXITY_SESSION_URL);
  const options: https.RequestOptions = {
    method: "POST",
    hostname: target.hostname,
    port: target.port || 443,
    path: `${target.pathname}${target.search}`,
    headers,
  };
  if (proxy) {
    const agent = makeProxyAgent(proxy);
    if (agent) (options as Record<string, unknown>).agent = agent;
  }

  return new Promise<string | null>((resolve) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c.toString()));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(60_000, () => {
      req.destroy();
      resolve(null);
    });
    req.end(body);
  });
}

/** Build a proxy agent for socks5://, http://, or https:// URLs. */
function makeProxyAgent(proxyUrl: string): unknown {
  try {
    if (proxyUrl.startsWith("socks")) return new SocksProxyAgent(proxyUrl);
    if (proxyUrl.startsWith("http://") || proxyUrl.startsWith("https://")) {
      return new HttpsProxyAgent(proxyUrl);
    }
  } catch (err) {
    console.warn(`[perplexity] bad proxy ${proxyUrl}:`, (err as Error).message);
  }
  return null;
}

/** Chrome extension relay — stores the SDP offer in the vault, polls for
 *  the SDP answer. The Chrome extension (running in the user's browser with
 *  the real IP) picks up the offer, does the fetch to perplexity.ai, and
 *  stores the answer. Timeout: 60s (the extension polls every 2s). */
async function exchangeSdpViaExtensionRelay(sdp: string): Promise<string | null> {
  const vaultUrl = (process.env.CHATGPT_VAULT_URL ?? "").trim();
  const vaultSecret = (process.env.CHATGPT_VAULT_SECRET ?? "").trim();
  if (!vaultUrl) return null;

  const baseUrl = vaultUrl.replace(/\/+$/, "");
  const headers = { "X-Vault-Secret": vaultSecret, "Content-Type": "application/json" };

  // 1. Store the SDP offer in the vault.
  const offerRes = await fetch(`${baseUrl}/perplexity/sdp-offer`, {
    method: "POST",
    headers,
    body: JSON.stringify({ sdp }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!offerRes.ok) {
    throw new Error(`Vault SDP offer store failed: ${offerRes.status}`);
  }
  console.log("[perplexity] SDP offer stored in vault, waiting for extension relay…");

  // 2. Poll for the SDP answer (up to 60s, every 1s).
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const answerRes = await fetch(`${baseUrl}/perplexity/sdp-answer`, {
        headers: { "X-Vault-Secret": vaultSecret },
        signal: AbortSignal.timeout(5000),
      });
      if (!answerRes.ok) continue;
      const data = (await answerRes.json()) as { sdp?: string | null; ts?: number | null };
      if (data.sdp) {
        console.log("[perplexity] SDP answer received from extension relay!");
        // Check if it's an error response.
        if (data.sdp.startsWith("{")) {
          try {
            const errObj = JSON.parse(data.sdp) as { error?: string };
            if (errObj.error) {
              throw new Error(errObj.error);
            }
          } catch (e) {
            if (e instanceof SyntaxError) {
              // Not JSON — it's a real SDP answer.
              return data.sdp;
            }
            throw e;
          }
        }
        return data.sdp;
      }
    } catch {
      // Continue polling.
    }
  }
  throw new Error("Extension relay timeout — the Chrome extension didn't pick up the SDP offer within 60s. Make sure the extension is running.");
}

export async function POST(req: Request) {
  // 1. Parse the browser's SDP offer.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const sdp =
    typeof (body as Record<string, unknown>)?.sdp === "string"
      ? ((body as Record<string, unknown>).sdp as string).trim()
      : "";
  if (!sdp.startsWith("v=0")) {
    return NextResponse.json(
      { error: "Missing or invalid 'sdp' (must start with 'v=0')." },
      { status: 400 },
    );
  }

  // 2. Fetch the Perplexity cookies from the vault.
  let cookies: string;
  let account: string | null;
  try {
    ({ cookies, account } = await fetchPerplexityCookies());
  } catch (err) {
    return NextResponse.json(
      { error: `Vault error: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  // 3. Try curl-impersonate (with proxies if configured), then fall back to
  //    the pure-JS proxy path. curl-impersonate has the Chrome TLS fingerprint
  //    built-in, so it can pass Cloudflare's TLS check. If proxies are
  //    configured, we try curl-impersonate through each proxy first.
  const proxyList = (process.env.PERPLEXITY_PROXY_LIST ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  let rawResponse: string | null = null;

  if (existsSync(CURL_IMPERSONATE_BIN)) {
    // Try direct first (no proxy) — works if the sandbox IP isn't blocked.
    rawResponse = await connectViaCurlImpersonate(cookies, account, sdp, null).catch((err) => {
      console.warn("[perplexity] curl-impersonate direct failed:", err.message);
      return null;
    });

    // If direct failed, try each proxy with curl-impersonate (Chrome TLS + proxy).
    if (!rawResponse && proxyList.length > 0) {
      for (const proxy of proxyList) {
        rawResponse = await connectViaCurlImpersonate(cookies, account, sdp, proxy).catch((err) => {
          console.warn(`[perplexity] curl-impersonate via ${proxy} failed:`, err.message);
          return null;
        });
        if (rawResponse) {
          console.log(`[perplexity] success via curl-impersonate + proxy ${proxy}`);
          break;
        }
      }
    }
  }

  // Fall back to pure-JS proxy path if curl-impersonate didn't work.
  if (!rawResponse) {
    rawResponse = await connectViaProxies(cookies, account, sdp).catch((err) => {
      console.warn("[perplexity] proxy fallback failed:", err.message);
      return null;
    });
  }

  // 3b. If all direct/proxy paths failed, try the Chrome extension relay.
  // The extension polls the vault for pending SDP offers, does the fetch
  // to perplexity.ai from the user's real browser IP (no Cloudflare block,
  // no rate limit), and stores the SDP answer in the vault.
  if (!rawResponse) {
    console.log("[perplexity] all direct/proxy paths failed, trying Chrome extension relay…");
    try {
      const answer = await exchangeSdpViaExtensionRelay(sdp);
      if (answer) {
        return NextResponse.json({ sdp: answer, type: "answer" });
      }
    } catch (err) {
      console.warn("[perplexity] extension relay failed:", (err as Error).message);
    }
  }

  if (!rawResponse) {
    return NextResponse.json(
      {
        error:
          "Perplexity session request failed. All paths exhausted (direct, proxy, extension relay). " +
          "Make sure the Chrome extension is running + the user is logged in to perplexity.ai.",
      },
      { status: 502 },
    );
  }

  // 4. Extract the SDP answer from the (JSON or plain) response.
  const answer = extractSdpAnswer(rawResponse);
  if (!answer) {
    return NextResponse.json(
      {
        error: "Could not extract SDP answer from Perplexity response.",
        raw: rawResponse.slice(0, 500),
      },
      { status: 502 },
    );
  }

  // 5. Return the answer to the browser.
  return NextResponse.json({ sdp: answer, type: "answer" });
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
