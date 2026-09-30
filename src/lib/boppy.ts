/**
 * Boppy.me API client (server-side only).
 *
 * Boppy is a free AI music generator (ACE-Step 1.5 XL Turbo) with an
 * unauthenticated, job-based API. The contract below is reverse-engineered
 * exclusively from the public boppy.me frontend bundle and captured DevTools
 * traces — no invented endpoints, no invented fields:
 *
 *   POST /api/llm/compose   {prompt, style?, language?, boost?}
 *                            → {prompt_id?, title?, lyrics?, caption?}
 *   POST /api/generate      {caption, lyrics?, model, duration, bpm, format,
 *                            keyscale?, timesignature?, prompt_id?}
 *                            → {jobId}
 *   GET  /api/generate/jobs/{id}  (poll every ~2s)
 *                            → {status, progress?, audioUrl?}
 *                             status: "done" | "processing" | "failed" | "error"
 *   GET  /uploads/{file}.mp3      → public audio (supports Range → 206)
 *
 * No credentials are involved. An optional relay (see src/lib/relay.ts) can
 * forward everything through a trusted IP if boppy.me ever starts
 * challenging the server's IP.
 */

import { db } from "@/lib/db";
import { getRelay, viaRelay } from "@/lib/relay";

// IMPORTANT: undici (ProxyAgent + fetch) is imported LAZILY via dynamic
// import() inside getProxyAgent() — not at module top-level. This is critical
// for production deployments that may not have undici installed (or have an
// older version): if undici is imported at the top of this file, any API
// route that imports boppy.ts (e.g. /api/tracks, /api/lyrics, /api/generate,
// /api/audio) would 500 at module-load time whenever undici is missing or
// incompatible. With lazy import, the routes work fine without undici when
// no proxy is configured — undici only loads when a plain HTTP proxy URL is
// actually set in Settings → "FireProx URL". This makes the app resilient
// to missing optional dependencies in production.

const DEFAULT_BASE = "https://boppy.me";
export const BOPPY_MODEL = "AceStep_1_5_XL_Turbo_INT8";

/**
 * Effective API base URL: AppSettings.apiBaseUrl (DB) > BOPPY_API_BASE env
 * > https://boppy.me. Lets the whole app point at a self-hosted,
 * boppy-compatible deployment (e.g. self-hosted ACE-Step) — no rate limits.
 */
export async function getBoppyBase(): Promise<string> {
  const settings = await db.appSettings
    .findUnique({ where: { id: "singleton" } })
    .catch(() => null);
  const raw = settings?.apiBaseUrl?.trim() || process.env.BOPPY_API_BASE?.trim() || "";
  if (!raw) return DEFAULT_BASE;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : DEFAULT_BASE;
  } catch {
    return DEFAULT_BASE;
  }
}

/**
 * Effective FireProx endpoint URL (no trailing path): AppSettings.fireproxUrl
 * (DB) > BOPPY_FIREPROX_URL env > null. When set, every boppy request is
 * rewritten through it. Three formats are auto-detected:
 *
 *  1. AWS API Gateway (real FireProx) — `https://abc.execute-api....amazonaws.com/fireprox`
 *     Path-prefix rewriting: `${fireproxUrl}${boppyPath}`. AWS rotates its
 *     egress IP per request (~12k IPs/region).
 *  2. ScraperAPI (commercial scraping proxy with free tier) —
 *     `https://api.scraperapi.com?api_key=KEY` (or with `&` for more params).
 *     Query-param rewriting: `${fireproxUrl}&url=${encodeURIComponent(target)}&method=...`.
 *     Per-request residential IP rotation, harder to fingerprint than AWS.
 *  3. Plain HTTP/HTTPS proxy (Oxylabs residential, TorProxy, Squid,
 *     node-rotating-proxy-manager, ...) — `http://host:port` or
 *     `http://user:pass@host:port`. Uses undici ProxyAgent. Each request
 *     uses a new connection → with TorProxy each request exits through a
 *     different Tor circuit (~1.1k unique exit IPs, free, anonymous). With
 *     Oxylabs residential, each request exits through a different real ISP
 *     IP (millions of IPs, very high trust score, paid ~$6/GB but free trial
 *     available — see https://oxylabs.io). Example:
 *     `http://customer-USER:PASS@pr.oxylabs.io:7777`.
 *
 * All formats take precedence over the relay when set, and all spoof
 * X-Forwarded-For via X-My-X-Forwarded-For (FireProx AWS) or directly
 * (ScraperAPI / Oxylabs / TorProxy pass through client headers).
 */
export async function getFireproxUrl(): Promise<string | null> {
  try {
    const settings = await db.appSettings.findUnique({ where: { id: "singleton" } });
    const fromDb = settings?.fireproxUrl?.trim();
    if (fromDb) return fromDb;
  } catch {
    // DB unavailable — fall through to env.
  }
  const fromEnv = process.env.BOPPY_FIREPROX_URL?.trim();
  return fromEnv || null;
}

/** Detect ScraperAPI URLs (api.scraperapi.com). Used to switch rewrite mode. */
function isScraperApi(url: string): boolean {
  return /\/\/api\.scraperapi\.com\//i.test(url);
}

/** Detect AWS API Gateway URLs (amazonaws.com) — real FireProx endpoint. */
function isFireProxAws(url: string): boolean {
  return /amazonaws\.com\//i.test(url);
}

/**
 * Detect plain HTTP/HTTPS proxy URLs (Oxylabs, TorProxy, Squid, etc.). A plain
 * proxy is one that doesn't have a known host signature (amazonaws.com for
 * AWS FireProx, api.scraperapi.com for ScraperAPI) — we use undici ProxyAgent
 * to route through it. Examples:
 *   http://127.0.0.1:8790                                     (TorProxy)
 *   http://user:pass@127.0.0.1:8080                           (any HTTP proxy with auth)
 *   http://customer-USER:PASS@pr.oxylabs.io:7777              (Oxylabs residential)
 *   http://your-vps.example.com:3128                          (Squid)
 */
function isPlainProxy(url: string): boolean {
  if (isScraperApi(url)) return false;
  if (isFireProxAws(url)) return false;
  return /^https?:\/\//i.test(url);
}

// IMPORTANT: Proxy routing uses RUNTIME-AWARE fetch.
//
// Two runtime paths are supported, detected once at module load:
//
//   • Bun (Aliyun FC bun runtime, local `bun run dev`): use Bun.fetch with
//     the native `proxy` option. Bun handles connection pooling, CONNECT
//     tunneling, and TLS internally — no undici needed. This avoids the
//     `s.util.markAsUncloneable is not a function` crash that undici 8.x
//     triggers on Bun (undici's ProxyAgent calls `util.markAsUncloneable`,
//     which exists in Node 22+ but not in Bun's `util` polyfill).
//
//   • Node 18+: use undici's ProxyAgent + undici.fetch (lazy-imported only
//     when a proxy URL is actually set, so the app works without undici
//     installed when no proxy is configured — production resilience).
//
// Both paths feed into fetchWithProxyRetry (dead-proxy auto-retry with a
// fresh connection).
const IS_BUN = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

type ProxyFetchFn = (
  target: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string | null;
    signal?: AbortSignal;
  },
) => Promise<Response>;

interface ProxyHandler {
  fetch: ProxyFetchFn;
  /** Reset the connection pool / agent so the next fetch opens a fresh
   *  connection to the proxy gateway → different upstream proxy IP. */
  reset: () => Promise<void>;
}

// Cache one handler per proxy URL — Bun handles pooling internally, undici
// ProxyAgent manages its own pool, so we don't want to recreate either on
// every request.
const proxyHandlerCache = new Map<string, ProxyHandler>();
let activeProxyUrl: string | null = null;

// Bun path — uses the native Bun.fetch with `proxy` option.
const bunFetchNative: typeof fetch =
  (globalThis as { Bun?: { fetch: typeof fetch } }).Bun?.fetch ?? fetch;

function makeBunProxyHandler(proxyUrl: string): ProxyHandler {
  return {
    fetch: (target, init) =>
      bunFetchNative(target, {
        method: init.method,
        headers: init.headers,
        body: init.body ?? null,
        signal: init.signal,
        // Bun's native proxy option — accepts http://user:pass@host:port
        proxy: proxyUrl,
      // The `proxy` field isn't in the standard RequestInit type yet, but
      // Bun's fetch accepts it. Cast to satisfy TS without breaking runtime.
      } as unknown as RequestInit),
    // Bun manages connections internally — reset is a no-op.
    reset: async () => {},
  };
}

// Node path — uses undici's ProxyAgent + undici.fetch (lazy import).
type UndiciModule = typeof import("undici");
let undiciPromise: Promise<UndiciModule> | null = null;
async function loadUndici(): Promise<UndiciModule> {
  if (!undiciPromise) {
    undiciPromise = import("undici").catch((err) => {
      undiciPromise = null; // allow retry after install
      throw new Error(
        `undici is not installed but a plain HTTP proxy is configured. ` +
          `Install it with \`bun add undici\` or \`npm install undici\`. ` +
          `Original error: ${(err as Error).message}`,
      );
    });
  }
  return undiciPromise;
}

async function makeNodeProxyHandler(proxyUrl: string): Promise<ProxyHandler> {
  const { ProxyAgent, fetch: undiciFetch } = await loadUndici();
  const agent = new ProxyAgent({ uri: proxyUrl });
  return {
    fetch: (target, init) =>
      undiciFetch(target, {
        method: init.method,
        headers: init.headers,
        body: init.body ?? null,
        signal: init.signal,
        dispatcher: agent,
      // `dispatcher` is an undici-specific init option — cast for TS.
      } as unknown as RequestInit),
    reset: async () => {
      try {
        await (agent as unknown as { close?: () => Promise<void> }).close?.();
      } catch {
        // Ignore — agent close is best-effort.
      }
    },
  };
}

async function getProxyHandler(proxyUrl: string): Promise<ProxyHandler> {
  if (activeProxyUrl === proxyUrl) {
    const cached = proxyHandlerCache.get(proxyUrl);
    if (cached) return cached;
  }
  // Different proxy URL → reset the previous one (free its connection pool).
  if (activeProxyUrl && activeProxyUrl !== proxyUrl) {
    const prev = proxyHandlerCache.get(activeProxyUrl);
    if (prev) await prev.reset();
    proxyHandlerCache.delete(activeProxyUrl);
  }
  activeProxyUrl = proxyUrl;
  let handler = proxyHandlerCache.get(proxyUrl);
  if (!handler) {
    handler = IS_BUN
      ? makeBunProxyHandler(proxyUrl)
      : await makeNodeProxyHandler(proxyUrl);
    proxyHandlerCache.set(proxyUrl, handler);
  }
  return handler;
}

async function resetProxyHandler(proxyUrl: string): Promise<void> {
  const handler = proxyHandlerCache.get(proxyUrl);
  if (handler) {
    proxyHandlerCache.delete(proxyUrl);
    if (activeProxyUrl === proxyUrl) activeProxyUrl = null;
    await handler.reset();
  }
}

/**
 * Retry wrapper for proxy-routed fetches. When a free proxy dies mid-request
 * (network error, 502/503/504, or aborted), the wrapper:
 *   1. Resets the cached proxy handler (drops the dead connection pool).
 *   2. Re-runs the fetch — opens a fresh connection to the proxy gateway,
 *      which assigns a different upstream proxy IP (proxy-scraper rotates
 *      per connection, mubeng rotates per request, Oxylabs rotates per
 *      request on port 7777, Bun.fetch pool picks a fresh connection).
 *
 * Idempotent for GET/HEAD (safe retries). For POST it retries up to
 * MAX_PROXY_RETRIES times — boppy's POST /api/llm/compose and
 * POST /api/generate are idempotent via the dedupe mechanism (identical
 * params reuse the existing generation), so retrying is safe.
 *
 * Non-proxy errors (4xx other than 429-like, 2xx) are returned as-is.
 * 429 is returned as-is so the upper-layer 429 banner shows the real
 * retryAfter — retrying on a 429 with a different proxy WOULD work but
 * boppy rate-limits by IP, so the 429 will clear naturally.
 */
const MAX_PROXY_RETRIES = 4;
const PROXY_RETRY_BACKOFF_MS = 250;

async function fetchWithProxyRetry(
  target: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    range?: string | null;
    timeoutMs: number;
  },
  proxyUrl: string,
): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_PROXY_RETRIES; attempt++) {
    try {
      const handler = await getProxyHandler(proxyUrl);
      const res = await handler.fetch(target, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: AbortSignal.timeout(init.timeoutMs),
      });
      // 502 / 503 / 504 → proxy died or upstream unavailable. Retry.
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        // Drain the body so the connection can be reused/closed cleanly.
        try { await res.arrayBuffer(); } catch { /* ignore */ }
        lastError = new Error(`upstream ${res.status} via proxy`);
        if (attempt < MAX_PROXY_RETRIES) {
          await resetProxyHandler(proxyUrl);
          await new Promise((r) => setTimeout(r, PROXY_RETRY_BACKOFF_MS * attempt));
          continue;
        }
        return res;
      }
      return res;
    } catch (err) {
      lastError = err;
      // Network failure / aborted / timeout → try a fresh proxy connection.
      if (attempt < MAX_PROXY_RETRIES) {
        await resetProxyHandler(proxyUrl);
        await new Promise((r) => setTimeout(r, PROXY_RETRY_BACKOFF_MS * attempt));
        continue;
      }
      throw err;
    }
  }
  // All retries exhausted — rethrow the last error so the caller can
  // surface it (typically a 502 to /api/lyrics or /api/generate).
  throw lastError instanceof Error
    ? lastError
    : new Error("proxy retry exhausted");
}

/**
 * Generate a random IPv4 for the X-My-X-Forwarded-For header. FireProx's AWS
 * API Gateway config copies this into the X-Forwarded-For header sent to the
 * upstream, so boppy sees a fresh client IP per request instead of the
 * actual AWS egress IP. Without it, AWS would set X-Forwarded-For to the
 * real caller (us) — defeating the rotation purpose.
 */
function randomForwardedIp(): string {
  // Random IPv4. Avoid private/reserved ranges so the upstream sees a
  // plausible public client address.
  const octet = () => Math.floor(Math.random() * 223) + 1; // 1..223 (skip 224+ multicast/reserved)
  return `${octet()}.${octet()}.${octet()}.${octet()}`;
}

/** Build a ScraperAPI URL with the target encoded as a query param. */
function buildScraperApiUrl(
  scraperApiBase: string,
  targetUrl: string,
  method: string,
): string {
  // ScraperAPI base typically already contains "?api_key=KEY". We append with
  // "&" if there's a "?" in the base, otherwise add "?" ourselves.
  const sep = scraperApiBase.includes("?") ? "&" : "?";
  return `${scraperApiBase}${sep}url=${encodeURIComponent(targetUrl)}&method=${method}`;
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

/** Durations offered by the official client. */
export const BOPPY_DURATIONS = [30, 60, 120, 180] as const;
/** Time signatures offered by the official client. */
export const BOPPY_TIME_SIGNATURES = ["2/4", "3/4", "4/4", "6/8"] as const;

/** Error mirroring the official client's mapping (nh()): status + API fields. */
export class BoppyError extends Error {
  status: number;
  code?: string;
  retryAfter?: number;
  kind?: string;

  constructor(status: number, message: string, fields: { code?: string; retryAfter?: number; kind?: string } = {}) {
    super(message);
    this.name = "BoppyError";
    this.status = status;
    this.code = fields.code;
    this.retryAfter = fields.retryAfter;
    this.kind = fields.kind;
  }
}

type BoppyPath = `/api/llm/compose` | `/api/generate` | `/api/generate/jobs/${string}`;

async function boppyFetch(
  path: BoppyPath,
  options: { method: "GET" | "POST"; body?: string; range?: string | null; timeoutMs?: number },
): Promise<Response> {
  const base = await getBoppyBase();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": BROWSER_UA,
    Accept: "application/json",
    Origin: base,
    Referer: `${base}/fr/create`,
  };
  if (options.range) headers.Range = options.range;

  const target = `${base}${path}`;

  // FireProx takes precedence over the relay when set — both serve the same
  // "rotate source IP" purpose, but FireProx is serverless (AWS-managed) and
  // rotates per request, while the relay is self-hosted on a single trusted IP.
  const fireproxUrl = await getFireproxUrl();
  if (fireproxUrl) {
    // Spoof X-Forwarded-For via the X-My-X-Forwarded-For convention. For real
    // FireProx (AWS), the AWS config copies it into upstream XFF. For
    // ScraperAPI, they pass through client headers including XFF directly.
    headers["X-My-X-Forwarded-For"] = randomForwardedIp();

    // Auto-detect proxy format and rewrite URL accordingly.
    if (isScraperApi(fireproxUrl)) {
      // ScraperAPI: query-param rewriting (target URL encoded as ?url=).
      const scraperUrl = buildScraperApiUrl(fireproxUrl, target, options.method);
      return fetch(scraperUrl, {
        method: "POST", // ScraperAPI always uses POST (method passed in body/query)
        headers,
        body: options.body,
        signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
      });
    }
    if (isPlainProxy(fireproxUrl)) {
      // Plain HTTP proxy (TorProxy, Oxylabs, proxy-scraper-cli, mubeng,
      // Squid, ...) — tunnel via undici ProxyAgent. Use undici's own fetch
      // (not the global) so the ProxyAgent dispatcher is from the same
      // package version (see top-of-file import comment). Wrapped with
      // fetchWithProxyRetry so dead free proxies (502/network error) auto
      // retry with a fresh proxy connection from the rotation pool.
      return fetchWithProxyRetry(
        target,
        { method: options.method, headers, body: options.body, timeoutMs: options.timeoutMs ?? 60_000 },
        fireproxUrl,
      );
    }
    // AWS FireProx (default): path-prefix rewriting.
    return fetch(`${fireproxUrl.replace(/\/+$/, "")}${path}`, {
      method: options.method,
      headers,
      body: options.body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
  }

  const relay = await getRelay();
  if (relay) {
    return viaRelay(relay, target, {
      method: options.method,
      headers,
      body: options.body,
      range: options.range ?? null,
    });
  }
  return fetch(target, {
    method: options.method,
    headers,
    body: options.body,
    signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
  });
}

/** Parse a non-OK upstream response into a BoppyError (mirrors nh()). */
async function toBoppyError(res: Response): Promise<BoppyError> {
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const message =
    (typeof data?.error === "string" && data.error) || `Request failed: ${res.status}`;
  return new BoppyError(res.status, message, {
    code: typeof data?.code === "string" ? data.code : undefined,
    retryAfter: typeof data?.retryAfter === "number" ? data.retryAfter : undefined,
    kind: (data?.kind === "burst" || data?.kind === "daily" ? data.kind : undefined) as
      | string
      | undefined,
  });
}

// ---------------------------------------------------------------------------
// POST /api/llm/compose — AI lyrics / title / blueprint caption
// ---------------------------------------------------------------------------

export interface ComposeInput {
  prompt: string;
  /** Optional style hint string (comma-separated tags). */
  style?: string;
  /** Optional lyrics language (e.g. "auto"). Omitted when not provided. */
  language?: string;
  /** Boost prompt adherence for the retry flow. */
  boost?: boolean;
}

export interface ComposeResult {
  promptId: string | null;
  title: string | null;
  lyrics: string | null;
  /** Blueprint caption (comma-separated style tags) for POST /api/generate. */
  caption: string | null;
}

export async function composeLyrics(input: ComposeInput): Promise<ComposeResult> {
  const payload: Record<string, unknown> = { prompt: input.prompt };
  if (input.style) payload.style = input.style;
  if (input.language) payload.language = input.language;
  if (input.boost !== undefined) payload.boost = input.boost;

  const res = await boppyFetch("/api/llm/compose", {
    method: "POST",
    body: JSON.stringify(payload),
    timeoutMs: 90_000,
  });
  if (!res.ok) throw await toBoppyError(res);

  const data = (await res.json()) as Record<string, unknown>;
  return {
    promptId: typeof data.prompt_id === "string" ? data.prompt_id : null,
    title: typeof data.title === "string" && data.title.trim() ? data.title.trim() : null,
    lyrics: typeof data.lyrics === "string" && data.lyrics.trim() ? data.lyrics : null,
    caption: typeof data.caption === "string" && data.caption.trim() ? data.caption : null,
  };
}

// ---------------------------------------------------------------------------
// POST /api/generate — create a generation job
// ---------------------------------------------------------------------------

export interface GenerateInput {
  /** Blueprint caption (style description). At least caption or lyrics. */
  caption: string;
  lyrics?: string;
  /** Duration in seconds — one of 30 | 60 | 120 | 180. */
  duration: number;
  bpm: number;
  keyscale?: string;
  timesignature?: string;
  /** prompt_id returned by /api/llm/compose when AI lyrics were used. */
  promptId?: string;
}

export async function createJob(input: GenerateInput): Promise<string> {
  const payload: Record<string, unknown> = {
    caption: input.caption,
    model: BOPPY_MODEL,
    duration: input.duration,
    bpm: input.bpm,
    format: "mp3",
  };
  if (input.lyrics && input.lyrics.trim()) payload.lyrics = input.lyrics.trim();
  if (input.keyscale) payload.keyscale = input.keyscale;
  if (input.timesignature) payload.timesignature = input.timesignature;
  if (input.promptId) payload.prompt_id = input.promptId;

  const res = await boppyFetch("/api/generate", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw await toBoppyError(res);

  const data = (await res.json()) as Record<string, unknown>;
  const jobId =
    typeof data.jobId === "string" && data.jobId
      ? data.jobId
      : typeof data.job_id === "string" && data.job_id
        ? data.job_id
        : null;
  if (!jobId) {
    throw new BoppyError(res.status, "Unexpected generate response: missing jobId.");
  }
  return jobId;
}

// ---------------------------------------------------------------------------
// GET /api/generate/jobs/{id} — poll a job
// ---------------------------------------------------------------------------

export interface BoppyJob {
  /** "done" | "processing" | "failed" | "error" (defensive: any string). */
  status: string;
  progress: number | null;
  audioUrl: string | null;
}

export async function fetchJob(jobId: string): Promise<BoppyJob> {
  const res = await boppyFetch(`/api/generate/jobs/${encodeURIComponent(jobId)}`, {
    method: "GET",
  });
  if (!res.ok) throw await toBoppyError(res);

  const data = (await res.json()) as Record<string, unknown>;
  const audioUrl =
    (typeof data.audioUrl === "string" && data.audioUrl) ||
    (typeof data.audio_url === "string" && data.audio_url) ||
    null;
  return {
    status: typeof data.status === "string" ? data.status : "processing",
    progress: typeof data.progress === "number" ? data.progress : null,
    audioUrl,
  };
}

// ---------------------------------------------------------------------------
// GET /uploads/{file}.mp3 — generated audio (public, Range → 206)
// ---------------------------------------------------------------------------

/**
 * Resolve a possibly-relative boppy audio URL to an absolute URL the
 * backend can fetch. Honors the FireProx proxy: when set AND the proxy is a
 * URL-rewriting proxy (AWS FireProx or ScraperAPI), the absolute boppy
 * origin is rewritten to the proxy endpoint so audio streaming also
 * rotates. Plain HTTP proxies (TorProxy, Squid, ...) are NOT applied here
 * — they're connection-level tunnels handled by undici ProxyAgent in
 * fetchAudio (no URL rewriting needed).
 */
export async function resolveAudioUrl(urlOrPath: string, base?: string): Promise<string> {
  const boppyBase = base ?? DEFAULT_BASE;
  const absolute = /^https?:\/\//i.test(urlOrPath)
    ? urlOrPath
    : `${boppyBase}${urlOrPath.startsWith("/") ? "" : "/"}${urlOrPath}`;
  const fireproxUrl = await getFireproxUrl();
  if (fireproxUrl && !isPlainProxy(fireproxUrl)) {
    try {
      const u = new URL(absolute);
      // Only rewrite boppy-origin URLs — never touch absolute URLs pointing
      // elsewhere (e.g. a self-hosted apiBaseUrl's /uploads).
      if (u.origin === boppyBase) {
        if (isScraperApi(fireproxUrl)) {
          // ScraperAPI: encode the whole target URL as a query param.
          const sep = fireproxUrl.includes("?") ? "&" : "?";
          return `${fireproxUrl}${sep}url=${encodeURIComponent(absolute)}&method=GET`;
        }
        // AWS FireProx: path-prefix rewrite.
        return `${fireproxUrl.replace(/\/+$/, "")}${u.pathname}${u.search}`;
      }
    } catch {
      // Malformed absolute URL — return as-is, fetch will fail loudly.
    }
  }
  return absolute;
}

/** Synchronous variant for callers that already know the base. Kept for
 *  backward compatibility with non-FireProx callers. */
export function resolveAudioUrlSync(urlOrPath: string, base: string = DEFAULT_BASE): string {
  if (/^https?:\/\//i.test(urlOrPath)) return urlOrPath;
  return `${base}${urlOrPath.startsWith("/") ? "" : "/"}${urlOrPath}`;
}

export async function fetchAudio(audioUrl: string, range: string | null): Promise<Response> {
  const base = await getBoppyBase();
  const target = await resolveAudioUrl(audioUrl, base);
  const fireproxUrl = await getFireproxUrl();
  const relay = await getRelay();
  const headers: Record<string, string> = {
    "User-Agent": BROWSER_UA,
    Accept: "*/*",
    Referer: `${base}/fr/create`,
  };
  if (fireproxUrl) {
    // Same spoof as boppyFetch — keeps audio Range requests rotating too.
    headers["X-My-X-Forwarded-For"] = randomForwardedIp();
    if (isScraperApi(fireproxUrl)) {
      // ScraperAPI does NOT reliably support Range/206 — do a full GET and let
      // the local mirror handle replays/seeks (one upstream per track, ever).
      const scraperUrl = buildScraperApiUrl(fireproxUrl, target, "GET");
      return fetch(scraperUrl, {
        method: "POST",
        headers,
        body: null,
        signal: AbortSignal.timeout(120_000),
      });
    }
    if (isPlainProxy(fireproxUrl)) {
      // Plain HTTP proxy (TorProxy, Oxylabs, proxy-scraper-cli, mubeng,
      // Squid, ...) — tunnel via undici ProxyAgent. Wrapped with
      // fetchWithProxyRetry so dead free proxies (502/network error) auto
      // retry with a fresh proxy connection from the rotation pool.
      return fetchWithProxyRetry(
        target,
        {
          method: "GET",
          headers: range ? { ...headers, Range: range } : headers,
          timeoutMs: 120_000,
        },
        fireproxUrl,
      );
    }
    return fetch(target, {
      headers: range ? { ...headers, Range: range } : headers,
      signal: AbortSignal.timeout(120_000),
    });
  }
  if (relay) {
    return viaRelay(relay, audioUrl, { method: "GET", headers, range });
  }
  return fetch(target, {
    headers: range ? { ...headers, Range: range } : headers,
    signal: AbortSignal.timeout(120_000),
  });
}
