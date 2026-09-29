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
 * rewritten through it: `${fireproxUrl}${boppyPath}` (e.g.
 * `https://abc.execute-api.eu-west-1.amazonaws.com/fireprox/api/generate`).
 * AWS API Gateway rotates its egress IP per request, so each call appears
 * to come from a different source. Takes precedence over the relay.
 */
export async function getFireproxUrl(): Promise<string | null> {
  try {
    const settings = await db.appSettings.findUnique({ where: { id: "singleton" } });
    const fromDb = settings?.fireproxUrl?.trim();
    if (fromDb) return fromDb.replace(/\/+$/, "");
  } catch {
    // DB unavailable — fall through to env.
  }
  const fromEnv = process.env.BOPPY_FIREPROX_URL?.trim();
  return fromEnv ? fromEnv.replace(/\/+$/, "") : null;
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
    // Spoof X-Forwarded-For via FireProx's X-My-X-Forwarded-For convention so
    // boppy sees a fresh client IP per request (not the AWS egress IP).
    headers["X-My-X-Forwarded-For"] = randomForwardedIp();
    return fetch(`${fireproxUrl}${path}`, {
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
 * backend can fetch. Honors the FireProx proxy: when set, the absolute
 * boppy origin is rewritten to the FireProx endpoint so audio streaming
 * (Range, mirroring) also rotates through AWS API Gateway.
 */
export async function resolveAudioUrl(urlOrPath: string, base?: string): Promise<string> {
  const boppyBase = base ?? DEFAULT_BASE;
  const absolute = /^https?:\/\//i.test(urlOrPath)
    ? urlOrPath
    : `${boppyBase}${urlOrPath.startsWith("/") ? "" : "/"}${urlOrPath}`;
  const fireproxUrl = await getFireproxUrl();
  if (fireproxUrl) {
    try {
      const u = new URL(absolute);
      // Only rewrite boppy-origin URLs — never touch absolute URLs pointing
      // elsewhere (e.g. a self-hosted apiBaseUrl's /uploads).
      if (u.origin === boppyBase) {
        return `${fireproxUrl}${u.pathname}${u.search}`;
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
