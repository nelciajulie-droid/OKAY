/**
 * Gemini Live (Google AI Studio) — bidirectional voice route.
 *
 * Unlike the ChatGPT and Perplexity realtime routes (which both speak
 * WebRTC and just exchange SDP offers/answers), Google's Gemini Live uses
 * the Web Channel bidi protocol — a long-poll HTTP protocol where the
 * client POSTs audio/text and GETs streamed AI audio back.
 *
 * Endpoint: POST https://webchannel-alkalimakersuite-pa.clients6.google.com
 *                 /v1/bidiGenerateContent
 *   Query: VER=8&RID=<rid>&CVER=22&X-HTTP-Session-Id=<gsessionid>
 *         &$httpHeaders=<url-encoded-headers>&zx=<nonce>&t=1
 *
 * Auth: Google's SAPISIDHASH scheme. Computed fresh per request:
 *   SAPISIDHASH = SHA1( <unix-seconds> + " " + <SAPISID-cookie-value>
 *                       + " " + <origin> )
 *   where <origin> = "https://aistudio.google.com"
 *
 * The Chrome extension harvests the Google session cookies (SID,
 * __Secure-1PSID, SAPISID, __Secure-1PAPISID, APISID, HSID, SSID, NID,
 * etc.) and POSTs them to the vault Worker at /google/cookies. We GET
 * them here before each bidi call.
 *
 * Protocol:
 *   1. POST the first message → server returns gsessionid + SID (in the
 *      response body / Set-Cookie). We surface them to the browser.
 *   2. GET long-poll with gsessionid + SID → server keeps the connection
 *      open and emits AI audio chunks (base64 PCM 16-bit 16kHz mono,
 *      wrapped in the Web Channel envelope).
 *   3. POST subsequent user audio/text → server adds it to the conversation.
 *   4. POST a final empty message (or just close) to terminate.
 *
 * This route exposes 4 actions the browser can call:
 *
 *   POST /api/gemini/connect  { action: "start", text? }
 *     -> { ok, gsessionid, sid, rid, raw? }
 *
 *   POST /api/gemini/connect  { action: "send",
 *                               gsessionid, sid, rid,
 *                               audio?: <base64 PCM>, text?: <string> }
 *     -> { ok }
 *
 *   POST /api/gemini/connect  { action: "receive", gsessionid, sid, rid }
 *     -> { ok, audioChunks: string[], textChunks: string[], done: boolean }
 *
 *   POST /api/gemini/connect  { action: "stop", gsessionid, sid, rid }
 *     -> { ok }
 *
 * Env vars:
 *   CHATGPT_VAULT_URL     – vault Worker base URL (same as the ChatGPT /
 *                            Perplexity routes — reuses the vault secret)
 *   CHATGPT_VAULT_SECRET   – vault secret (X-Vault-Secret header)
 *   GEMINI_API_KEY         – the AI Studio API key (X-Goog-Api-Key header)
 *   GEMINI_MODEL            – optional model id (defaults to
 *                            "models/gemini-3.0-flash-preview")
 *   GEMINI_PROXY_LIST       – optional comma-separated proxy URLs for the
 *                            pure-JS fallback (socks5://, http://, https://)
 *
 * Google doesn't use Cloudflare, so the pure-JS (node:https) path is the
 * primary one. The curl-impersonate path is wired in for parity with the
 * other routes and as a fallback if the TLS fingerprint ever matters.
 */

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import https from "node:https";
import { URL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { NextResponse } from "next/server";

// curl-impersonate binary path (same as the ChatGPT / Perplexity routes).
const CURL_IMPERSONATE_BIN =
  "/home/z/my-project/node_modules/node-curl-impersonate/bin/curl-impersonate-chrome-linux-x86";

// Google AI Studio bidi endpoint.
const GEMINI_BIDI_BASE =
  "https://webchannel-alkalimakersuite-pa.clients6.google.com";
const GEMINI_BIDI_PATH = "/v1/bidiGenerateContent";
const GEMINI_ORIGIN = "https://aistudio.google.com";

// Web Channel protocol constants (observed in the user's capture).
const WC_VER = "8";
const WC_CVER = "22";

// A realistic desktop Chrome User-Agent. Google's Web Channel doesn't
// fingerprint-check the TLS handshake the way Cloudflare does, but a
// realistic UA keeps the request consistent with the cookies.
const GEMINI_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// SAPISIDHASH — Google's session auth scheme.
// ---------------------------------------------------------------------------

/**
 * Compute the SAPISIDHASH authorization header.
 *
 *   SAPISIDHASH = "SAPISIDHASH " + timestamp + "_" +
 *                 SHA1(timestamp + " " + sapisid + " " + origin)
 *
 * The timestamp must be unix seconds (Math.floor(Date.now() / 1000)). The
 * SAPISID value comes from the user's `.google.com` cookies (one of
 * `SAPISID`, `__Secure-1PAPISID`, `__Secure-3PAPISID` — they're usually
 * the same value). The origin is `https://aistudio.google.com` (where the
 * cookies were obtained).
 *
 * The hash is computed FRESH for each request because the timestamp is
 * part of the input — a stale SAPISIDHASH from a previous request would
 * be rejected.
 */
function computeSapisidHash(sapisid: string, origin: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const hash = createHash("sha1")
    .update(`${timestamp} ${sapisid} ${origin}`)
    .digest("hex");
  return `SAPISIDHASH ${timestamp}_${hash}`;
}

/**
 * Extract the SAPISID cookie value from a full Cookie header string.
 * Google sets the same value under three names (`SAPISID`,
 * `__Secure-1PAPISID`, `__Secure-3PAPISID`) — we prefer the bare
 * `SAPISID` and fall back to the __Secure-1PAPISID variant.
 */
function extractSapisid(cookies: string): string | null {
  const match = cookies.match(/(?:^|;\s*)(SAPISID|__Secure-1PAPISID|__Secure-3PAPISID)=([^;]+)/);
  return match ? match[2] : null;
}

// ---------------------------------------------------------------------------
// Web Channel helpers
// ---------------------------------------------------------------------------

/** Random RFC4122-ish UUID (crypto.randomUUID fallback). */
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

/** A short nonce (used as the `zx` query param — Google uses a `Math.random`-style token). */
function randomZx(): string {
  return randomBytes(8).toString("hex");
}

/** A large random RID (Google uses a 5-digit number, but any int works). */
function randomRid(): string {
  return String(Math.floor(10000 + Math.random() * 89999));
}

// ---------------------------------------------------------------------------
// Vault fetch
// ---------------------------------------------------------------------------

/** Vault response shape for the Google cookies endpoint. */
interface VaultGoogleResponse {
  cookies?: string;
  updatedAt?: number | null;
  error?: string;
}

/** Fetch the Google cookies from the vault Worker. */
async function fetchGoogleCookies(): Promise<string> {
  const vaultUrl = (process.env.CHATGPT_VAULT_URL ?? "").trim();
  const vaultSecret = (process.env.CHATGPT_VAULT_SECRET ?? "").trim();
  if (!vaultUrl) {
    throw new Error("CHATGPT_VAULT_URL is not set — cannot fetch Google cookies.");
  }
  const url = `${vaultUrl.replace(/\/+$/, "")}/google/cookies`;
  const res = await fetch(url, {
    headers: { "X-Vault-Secret": vaultSecret },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Vault returned ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as VaultGoogleResponse;
  if (!data.cookies) {
    throw new Error(
      data.error ?? "No Google cookies in vault. Run the Chrome extension first.",
    );
  }
  return data.cookies;
}

// ---------------------------------------------------------------------------
// Header + body construction
// ---------------------------------------------------------------------------

/**
 * Build the set of headers Google's bidi endpoint expects for an outbound
 * (POST) message. The full cookie string is sent as `Cookie`, and the
 * SAPISIDHASH + API key + auth-user are duplicated into `$httpHeaders`
 * (URL-encoded) inside the query string by the caller — that's the Web
 * Channel convention for forwarding sensitive headers via the long-poll
 * GET.
 */
function buildGoogleHeaders(cookies: string, sapisidHash: string, isGet = false): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": GEMINI_UA,
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "identity", // prevent gzip — we need to parse the body
    Origin: GEMINI_ORIGIN,
    Referer: `${GEMINI_ORIGIN}/`,
    Cookie: cookies,
    Authorization: sapisidHash,
    "X-Goog-Api-Key": process.env.GEMINI_API_KEY ?? "",
    "X-Goog-AuthUser": "0",
    "X-WebChannel-Content-Type": "application/json+protobuf",
    "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "Sec-Fetch-Site": "same-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
  };
  if (!isGet) {
    h["Content-Type"] = "application/x-www-form-urlencoded";
  }
  return h;
}

/**
 * Build the JSON+protobuf message body for a bidiGenerateContent call.
 *
 * Gemini Live's Web Channel envelope wraps the standard
 * `generativelanguage.googleapis.com` `bidiGenerateContent` payload in a
 * small `count`/`req0_*` form-urlencoded envelope. The inner payload is a
 * JSON object whose shape mirrors the official REST API — `setup`,
 * `clientContent` (audio / text), and `clientStreamingOutput` chunks.
 *
 * For "start": a `setup` message with the model + audio config.
 * For "send" with audio: a `clientContent` with the base64 PCM.
 * For "send" with text: a `clientContent` with a text part.
 */
function buildBidiPayload(
  action: "setup" | "clientContent",
  opts: { audio?: string; text?: string },
): string {
  const model = process.env.GEMINI_MODEL ?? "models/gemini-3.0-flash-preview";

  let inner: Record<string, unknown>;
  if (action === "setup") {
    inner = {
      setup: {
        model,
        generationConfig: {
          responseModalities: ["AUDIO"],
          audioConfig: {
            audioEncoding: "PCM16",
            sampleRateHertz: 16000,
          },
        },
        systemInstruction: {
          parts: [{ text: "You are a helpful voice assistant." }],
        },
      },
    };
  } else {
    const parts: unknown[] = [];
    if (opts.audio) {
      parts.push({
        inlineData: {
          mimeType: "audio/L16;rate=16000",
          data: opts.audio,
        },
      });
    }
    if (opts.text) {
      parts.push({ text: opts.text });
    }
    inner = {
      clientContent: {
        input: { parts },
        turnComplete: true,
      },
    };
  }

  // The Web Channel envelope: count=1, req0_data=<JSON>, req0_type=...
  // The actual on-wire format is `count=N&ofs=N&reqN__sc=...&reqN_data=...`.
  // We use the minimal shape Google accepts for a single message.
  const params = new URLSearchParams();
  params.set("count", "1");
  params.set("ofs", "0");
  params.set("req0__sc", "C");
  params.set("req0_type", "bidiGenerateContent");
  params.set("req0_data", JSON.stringify(inner));
  return params.toString();
}

/**
 * Build the URL for a bidi request, with the right query string for each
 * phase of the protocol.
 *
 * For "start": no SID yet — just `VER/RID/CVER/zx/t`.
 * For "send"/"receive": include `SID` + `X-HTTP-Session-Id=gsessionid`.
 *
 * The `$httpHeaders` query param carries a URL-encoded version of the
 * sensitive headers (Authorization, X-Goog-Api-Key, etc.) so the
 * long-polling GET can carry them through proxies that strip custom
 * headers.
 */
function buildBidiUrl(opts: {
  rid: string;
  gsessionid?: string;
  sid?: string;
  sapisidHash: string;
  apiKey: string;
  receive?: boolean;
}): string {
  const u = new URL(GEMINI_BIDI_PATH, GEMINI_BIDI_BASE);
  u.searchParams.set("VER", WC_VER);
  u.searchParams.set("RID", opts.rid);
  u.searchParams.set("CVER", WC_CVER);
  u.searchParams.set("zx", randomZx());
  u.searchParams.set("t", "1");
  if (opts.sid) u.searchParams.set("SID", opts.sid);
  if (opts.gsessionid) {
    u.searchParams.set("X-HTTP-Session-Id", opts.gsessionid);
  }

  // The $httpHeaders param is a URL-encoded list of "Header: value\n"
  // lines. Google's Web Channel JS encodes it this way; the server reads
  // them as if they were real HTTP headers on the long-poll GET.
  const headerLines = [
    `Authorization: ${opts.sapisidHash}`,
    `X-Goog-Api-Key: ${opts.apiKey}`,
    `X-Goog-AuthUser: 0`,
    `X-WebChannel-Content-Type: application/json+protobuf`,
    `Content-Type: application/json+protobuf`,
  ].join("\n");
  u.searchParams.set("$httpHeaders", headerLines);

  // For a receive (long-poll) request, Google's Web Channel uses a different
  // URL format:
  //   /v1/bidiGenerateContent?gsessionid=<gsessionid>&VER=8&RID=rpc&SID=<sid>&AID=0&CI=0&TYPE=xmlhttp&zx=<zx>&t=1
  // Key differences from the POST (start/send) URL:
  //   - gsessionid is a query param (not X-HTTP-Session-Id)
  //   - RID=rpc (not the numeric rid)
  //   - TYPE=xmlhttp (not 'xml')
  //   - AID=0 and CI=0 params
  //   - No $httpHeaders param (headers are sent as real HTTP headers)
  if (opts.receive) {
    // Clear the $httpHeaders param — for GET long-poll, headers go as real HTTP headers
    u.searchParams.delete("$httpHeaders");
    u.searchParams.delete("X-HTTP-Session-Id");
    // Remove CVER for receive (Google's real URL doesn't have it on GET)
    u.searchParams.delete("CVER");
    // Set gsessionid as a query param (not as X-HTTP-Session-Id)
    if (opts.gsessionid) {
      u.searchParams.set("gsessionid", opts.gsessionid);
    }
    // RID=rpc for the long-poll (not the original numeric rid)
    u.searchParams.set("RID", "rpc");
    // Required Web Channel params
    u.searchParams.set("AID", "0");
    u.searchParams.set("CI", "0");
    u.searchParams.set("TYPE", "xmlhttp");
  }
  return u.toString();
}

// ---------------------------------------------------------------------------
// Transport — pure-JS (node:https) primary, curl-impersonate fallback.
// ---------------------------------------------------------------------------

interface BidiResponse {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  setCookie: string[];
}

/**
 * Send a bidi request via node:https. Google doesn't use Cloudflare, so
 * the pure-JS path is the primary one. An optional proxy list (env
 * `GEMINI_PROXY_LIST`) is tried in order — the first proxy that succeeds
 * wins. Without proxies, a single direct attempt is made.
 */
async function sendViaNodeHttps(
  method: "POST" | "GET",
  url: string,
  headers: Record<string, string>,
  body: string | null,
  timeoutMs: number,
): Promise<BidiResponse> {
  const target = new URL(url);
  const options: https.RequestOptions = {
    method,
    hostname: target.hostname,
    port: target.port || 443,
    path: `${target.pathname}${target.search}`,
    headers,
  };

  const proxyList = (process.env.GEMINI_PROXY_LIST ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  // First proxy that yields a response wins; if no proxies configured,
  // go direct.
  const attempts: (string | null)[] = proxyList.length > 0 ? proxyList : [null];
  let lastErr: unknown = null;
  for (const proxy of attempts) {
    try {
      const opts = { ...options };
      if (proxy) {
        const agent = makeProxyAgent(proxy);
        if (agent) (opts as Record<string, unknown>).agent = agent;
      }
      const res = await onceHttpsRequest(opts, body, timeoutMs);
      return res;
    } catch (err) {
      lastErr = err;
      // try next proxy
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("Bidi request failed (no proxy succeeded).");
}

/** Single https.request attempt → resolves with {status, body, setCookie}. */
function onceHttpsRequest(
  options: https.RequestOptions,
  body: string | null,
  timeoutMs: number,
): Promise<BidiResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c.toString()));
      res.on("end", () => {
        const setCookieRaw = res.headers["set-cookie"];
        resolve({
          status: res.statusCode ?? 0,
          body: data,
          headers: res.headers as Record<string, string | string[] | undefined>,
          setCookie: Array.isArray(setCookieRaw) ? setCookieRaw : setCookieRaw ? [setCookieRaw] : [],
        });
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Bidi request timed out after ${timeoutMs}ms`));
    });
    if (body != null) req.end(body);
    else req.end();
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
    console.warn(`[gemini] bad proxy ${proxyUrl}:`, (err as Error).message);
  }
  return null;
}

/**
 * curl-impersonate path — spawn the Chrome-impersonating curl binary with
 * the same query + headers as the pure-JS path, but with the Chrome
 * TLS/JA4 fingerprint. Used as a fallback for the rare case where Google's
 * edge rejects the Node TLS handshake.
 */
async function sendViaCurlImpersonate(
  method: "POST" | "GET",
  url: string,
  headers: Record<string, string>,
  body: string | null,
  timeoutMs: number,
): Promise<BidiResponse> {
  const args = [
    "-sS",
    "--max-time",
    String(Math.ceil(timeoutMs / 1000)),
    "--connect-timeout",
    "20",
    "-X",
    method,
    "-D", // dump headers to stdout (so we can read Set-Cookie)
    "-",
    url,
    "--impersonate",
    "chrome131",
    "--http2",
    "--compressed",
  ];
  for (const [k, v] of Object.entries(headers)) {
    if (!v) continue;
    args.push("-H", `${k}: ${v}`);
  }
  if (body != null) {
    args.push("--data-binary", "@-");
  }

  return new Promise<BidiResponse>((resolve, reject) => {
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
      // -D - dumps headers + blank line + body. Split at the first \r\n\r\n.
      const split = stdout.indexOf("\r\n\r\n");
      const headerBlock = split >= 0 ? stdout.slice(0, split) : stdout;
      const bodyText = split >= 0 ? stdout.slice(split + 4) : "";
      const statusMatch = headerBlock.match(/^HTTP\/[\d.]+\s+(\d+)/);
      const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
      const setCookie: string[] = [];
      for (const line of headerBlock.split("\r\n")) {
        const m = line.match(/^set-cookie:\s*(.*)$/i);
        if (m) setCookie.push(m[1]);
      }
      resolve({ status, body: bodyText, headers: {}, setCookie });
    });
    if (body != null) child.stdin.end(body);
    else child.stdin.end();
  });
}

/**
 * Send a bidi request. Tries the curl-impersonate binary first (when
 * present — the only path that passes TLS fingerprint checks), then
 * falls back to the pure-JS / proxy path.
 */
async function sendBidi(
  method: "POST" | "GET",
  url: string,
  headers: Record<string, string>,
  body: string | null,
  timeoutMs: number,
): Promise<BidiResponse> {
  if (existsSync(CURL_IMPERSONATE_BIN)) {
    try {
      return await sendViaCurlImpersonate(method, url, headers, body, timeoutMs);
    } catch (err) {
      console.warn("[gemini] curl-impersonate failed, falling back to node:https:", (err as Error).message);
    }
  }
  return sendViaNodeHttps(method, url, headers, body, timeoutMs);
}

// ---------------------------------------------------------------------------
// Response parsing — extract gsessionid, SID, audio chunks, text.
// ---------------------------------------------------------------------------

/** Extract the gsessionid from a Set-Cookie header or a body field. */
function extractGsessionId(setCookie: string[], body: string): string | null {
  // Look for a Set-Cookie whose name contains "gsessionid" or whose
  // response body line is "gsessionid=...".
  for (const c of setCookie) {
    const m = c.match(/^gsessionid=([^;]+)/i);
    if (m) return m[1];
  }
  const bodyMatch = body.match(/gsessionid=([A-Za-z0-9_\-]+)/);
  if (bodyMatch) return bodyMatch[1];
  return null;
}

/** Extract the SID (stream id) from a Web Channel response body.
 * Google's Web Channel response body format varies — try multiple patterns:
 *   [0,"SID_value",...]
 *   [["SID_value",...]]
 *   "SID":"SID_value"
 *   [[0,"SID_value","c",...]]
 */
function extractSid(body: string): string | null {
  // Google's actual Web Channel response format:
  //   51\n[[0,["c","SID_VALUE","",8,15,30000]]]
  // The SID is the quoted string after "c", inside [[0,[...
  
  // Pattern 1: [[0,["c","value",...]]] — the REAL Google format
  let m = body.match(/\[\[0,\["c","([^"]+)"/);
  if (m) return m[1];

  // Pattern 2: [0,["c","value",...]] — without outer brackets
  m = body.match(/\[0,\["c","([^"]+)"/);
  if (m) return m[1];

  // Pattern 3: "c","value",... — just find "c","something"
  m = body.match(/"c","([A-Za-z0-9_-]{8,})"/);
  if (m) return m[1];

  // Pattern 4: "SID":"value" (JSON key-value, less common)
  m = body.match(/"SID"\s*[:=]\s*"([^"]+)"/);
  if (m) return m[1];

  // Pattern 5: [0,"value",...] (older format)
  m = body.match(/^\[\s*\d+\s*,\s*"([^"]+)"/);
  if (m) return m[1];

  return null;
}

/** Strip the Web Channel envelope and collect audio / text chunks. */
function parseBidiChunks(body: string): {
  audioChunks: string[];
  textChunks: string[];
  done: boolean;
} {
  const audioChunks: string[] = [];
  const textChunks: string[] = [];
  let done = false;

  // Web Channel responses are a series of length-prefixed JSON arrays.
  // Each line starts with a length integer, then a JSON array. The
  // arrays contain the actual protobuf-as-JSON messages.
  const lines = body.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^\d+$/.test(trimmed)) continue;
    // Try to parse the line as JSON (after stripping a leading length
    // prefix if present).
    const jsonStart = trimmed.indexOf("[");
    if (jsonStart < 0) continue;
    const candidate = trimmed.slice(jsonStart);
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    collectChunks(parsed, audioChunks, textChunks);
    if (typeof parsed === "object" && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      if (obj.done === true || obj.turnComplete === true) done = true;
    }
  }

  // Also try the whole body as one JSON value (some responses aren't
  // length-prefixed).
  if (audioChunks.length === 0 && textChunks.length === 0) {
    try {
      const whole = JSON.parse(body);
      collectChunks(whole, audioChunks, textChunks);
    } catch {
      // not JSON — ignore
    }
  }

  return { audioChunks, textChunks, done };
}

/** Walk a parsed bidi message and push any audio / text parts found. */
function collectChunks(
  parsed: unknown,
  audioChunks: string[],
  textChunks: string[],
): void {
  if (parsed == null) return;
  if (Array.isArray(parsed)) {
    for (const item of parsed) collectChunks(item, audioChunks, textChunks);
    return;
  }
  if (typeof parsed !== "object") return;
  const obj = parsed as Record<string, unknown>;
  // serverContent / modelTurn / parts structure (Gemini Live API shape).
  const candidates = [
    obj.serverContent,
    obj.modelTurn,
    obj.candidates,
    obj.parts,
    obj.output,
  ];
  for (const c of candidates) {
    if (c != null) collectChunks(c, audioChunks, textChunks);
  }
  if (Array.isArray(obj.parts)) {
    for (const p of obj.parts) {
      if (p == null || typeof p !== "object") continue;
      const part = p as Record<string, unknown>;
      const inlineData = part.inlineData as Record<string, unknown> | undefined;
      if (inlineData && typeof inlineData.data === "string") {
        audioChunks.push(inlineData.data);
      }
      if (typeof part.text === "string") {
        textChunks.push(part.text);
      }
    }
  }
  // Recurse into any other object fields — Gemini responses are deeply
  // nested and we want to be permissive.
  for (const [k, v] of Object.entries(obj)) {
    if (k === "serverContent" || k === "modelTurn" || k === "candidates" || k === "parts") continue;
    if (v != null && typeof v === "object") collectChunks(v, audioChunks, textChunks);
  }
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

interface GeminiRequestBody {
  action: string;
  gsessionid?: string;
  sid?: string;
  rid?: string;
  audio?: string;
  text?: string;
}

export async function POST(req: Request) {
  let body: GeminiRequestBody;
  try {
    body = (await req.json()) as GeminiRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const action = String(body.action ?? "").toLowerCase();

  switch (action) {
    case "start":
      return handleStart(body);
    case "send":
      return handleSend(body);
    case "receive":
      return handleReceive(body);
    case "stop":
      return handleStop(body);
    default:
      return NextResponse.json(
        { error: `Unknown action '${action}'. Use start | send | receive | stop.` },
        { status: 400 },
      );
  }
}

/** Start a Gemini Live session. POSTs the setup message → returns the
 * gsessionid + SID (and the RID we generated) the browser will reuse
 * for subsequent send/receive calls. */
async function handleStart(_body: GeminiRequestBody) {
  let cookies: string;
  try {
    cookies = await fetchGoogleCookies();
  } catch (err) {
    return NextResponse.json(
      { error: `Vault error: ${(err as Error).message}` },
      { status: 502 },
    );
  }
  const sapisid = extractSapisid(cookies);
  if (!sapisid) {
    return NextResponse.json(
      { error: "No SAPISID cookie found in vault Google cookies — re-run the Chrome extension." },
      { status: 502 },
    );
  }
  const apiKey = process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY is not set on the server." },
      { status: 500 },
    );
  }
  const sapisidHash = computeSapisidHash(sapisid, GEMINI_ORIGIN);
  const rid = randomRid();
  const url = buildBidiUrl({ rid, sapisidHash, apiKey });
  const headers = buildGoogleHeaders(cookies, sapisidHash);
  const payload = buildBidiPayload("setup", {});

  try {
    const res = await sendBidi("POST", url, headers, payload, 30_000);
    if (res.status >= 400) {
      return NextResponse.json(
        {
          error: `Gemini bidi setup returned ${res.status}.`,
          raw: res.body.slice(0, 500),
        },
        { status: 502 },
      );
    }
    // gsessionid: Google returns it in the x-http-session-id RESPONSE HEADER
    // Vercel might strip this header, so also try body extraction + SID fallback
    const headerGsid = (res.headers["x-http-session-id"] as string) ?? "";
    const sid = extractSid(res.body) ?? headerGsid ?? "";
    const gsessionid =
      headerGsid ||
      extractGsessionId(res.setCookie, res.body) ||
      (res.body.match(/gsessionid=([A-Za-z0-9_\-]+)/)?.[1]) ||
      sid || // Use SID as gsessionid if header is missing (Google sometimes uses the same value)
      randomUuid();
    console.log(`[gemini] start: headerGsid=${headerGsid ? "yes" : "no"}, sid=${sid.slice(0, 30)}..., gsessionid=${gsessionid.slice(0, 30)}...`);
    // Surface the parsed setup response too — it may carry the first
    // server message (a greeting audio chunk, etc.).
    const parsed = parseBidiChunks(res.body);
    return NextResponse.json({
      ok: true,
      gsessionid,
      sid,
      rid,
      audioChunks: parsed.audioChunks,
      textChunks: parsed.textChunks,
      done: parsed.done,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Gemini bidi setup failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}

/** Send a user audio chunk (base64 PCM) or text into an existing session. */
async function handleSend(body: GeminiRequestBody) {
  const { gsessionid, sid, rid, audio, text } = body;
  if (!gsessionid || !rid) {
    return NextResponse.json(
      { error: "Missing 'gsessionid' or 'rid' for send action." },
      { status: 400 },
    );
  }
  if (!audio && !text) {
    return NextResponse.json(
      { error: "Send requires 'audio' (base64 PCM) or 'text'." },
      { status: 400 },
    );
  }
  let cookies: string;
  try {
    cookies = await fetchGoogleCookies();
  } catch (err) {
    return NextResponse.json(
      { error: `Vault error: ${(err as Error).message}` },
      { status: 502 },
    );
  }
  const sapisid = extractSapisid(cookies);
  if (!sapisid) {
    return NextResponse.json(
      { error: "No SAPISID cookie found in vault Google cookies." },
      { status: 502 },
    );
  }
  const apiKey = process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY is not set on the server." },
      { status: 500 },
    );
  }
  const sapisidHash = computeSapisidHash(sapisid, GEMINI_ORIGIN);
  const url = buildBidiUrl({ rid, gsessionid, sid, sapisidHash, apiKey });
  const headers = buildGoogleHeaders(cookies, sapisidHash);
  const payload = buildBidiPayload("clientContent", { audio, text });

  try {
    const res = await sendBidi("POST", url, headers, payload, 30_000);
    if (res.status >= 400) {
      return NextResponse.json(
        {
          error: `Gemini bidi send returned ${res.status}.`,
          raw: res.body.slice(0, 500),
        },
        { status: 502 },
      );
    }
    // The POST response usually carries nothing useful (the AI audio
    // comes via the long-poll GET in `receive`). Still parse it for any
    // early chunks.
    const parsed = parseBidiChunks(res.body);
    return NextResponse.json({
      ok: true,
      audioChunks: parsed.audioChunks,
      textChunks: parsed.textChunks,
      done: parsed.done,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Gemini bidi send failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}

/** Long-poll the bidi endpoint for AI audio response chunks. Returns as
 * soon as the server emits a chunk, or after ~25s (whichever is first). */
async function handleReceive(body: GeminiRequestBody) {
  const { gsessionid, sid, rid } = body;
  if (!gsessionid || !rid) {
    return NextResponse.json(
      { error: "Missing 'gsessionid' or 'rid' for receive action." },
      { status: 400 },
    );
  }
  let cookies: string;
  try {
    cookies = await fetchGoogleCookies();
  } catch (err) {
    return NextResponse.json(
      { error: `Vault error: ${(err as Error).message}` },
      { status: 502 },
    );
  }
  const sapisid = extractSapisid(cookies);
  if (!sapisid) {
    return NextResponse.json(
      { error: "No SAPISID cookie found in vault Google cookies." },
      { status: 502 },
    );
  }
  const apiKey = process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY is not set on the server." },
      { status: 500 },
    );
  }
  const sapisidHash = computeSapisidHash(sapisid, GEMINI_ORIGIN);
  const url = buildBidiUrl({ rid, gsessionid, sid, sapisidHash, apiKey, receive: true });
  const headers = buildGoogleHeaders(cookies, sapisidHash, true); // isGet=true, no Content-Type
  // Long-poll: allow up to 25s for a chunk.
  try {
    const res = await sendBidi("GET", url, headers, null, 25_000);
    if (res.status >= 400) {
      return NextResponse.json(
        {
          error: `Gemini bidi receive returned ${res.status}.`,
          raw: res.body.slice(0, 500),
        },
        { status: 502 },
      );
    }
    const parsed = parseBidiChunks(res.body);
    return NextResponse.json({
      ok: true,
      audioChunks: parsed.audioChunks,
      textChunks: parsed.textChunks,
      done: parsed.done,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Gemini bidi receive failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}

/** Stop the session. The Web Channel doesn't have an explicit close —
 * the client just stops long-polling. We POST a final empty
 * clientContent with turnComplete=true as a courtesy, but ignore
 * errors. */
async function handleStop(body: GeminiRequestBody) {
  const { gsessionid, sid, rid } = body;
  if (!gsessionid || !rid) {
    return NextResponse.json({ ok: true, message: "Nothing to stop." });
  }
  let cookies: string;
  try {
    cookies = await fetchGoogleCookies();
  } catch {
    // Vault errors here are fine — we're tearing down anyway.
    return NextResponse.json({ ok: true, message: "Stopped (vault unreachable)." });
  }
  const sapisid = extractSapisid(cookies);
  if (!sapisid) {
    return NextResponse.json({ ok: true, message: "Stopped (no SAPISID)." });
  }
  const apiKey = process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) {
    return NextResponse.json({ ok: true, message: "Stopped (no API key)." });
  }
  try {
    const sapisidHash = computeSapisidHash(sapisid, GEMINI_ORIGIN);
    const url = buildBidiUrl({ rid, gsessionid, sid, sapisidHash, apiKey });
    const headers = buildGoogleHeaders(cookies, sapisidHash);
    // Send a final empty message to signal turn completion.
    const params = new URLSearchParams();
    params.set("count", "1");
    params.set("ofs", "0");
    params.set("req0__sc", "C");
    params.set("req0_type", "terminate");
    await sendBidi("POST", url, headers, params.toString(), 10_000).catch(() => null);
  } catch {
    // ignore — stop is best-effort
  }
  return NextResponse.json({ ok: true, message: "Stopped." });
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
