import { stat, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

import { db } from "@/lib/db";
import { fetchAudio } from "@/lib/boppy";
import { hasLocalAudio, localAudioFile, mirrorAudio } from "@/lib/mirror";

const PASSTHROUGH_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
];

// Mirrored files are immutable → cache for 30 days (like boppy's /uploads).
const LOCAL_CACHE_CONTROL = "public, max-age=2592000";
// Guard against path traversal via the URL param — only cuid-like ids pass.
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

/** nginx-style ETag: "hex(mtime)-hex(size)" (same shape as boppy's /uploads). */
function etagFor(size: number, mtimeMs: number): string {
  return `"${Math.floor(mtimeMs).toString(16)}-${size.toString(16)}"`;
}

/** Parse a single-range "bytes=a-b" / "bytes=a-" / "bytes=-n" header. */
function parseRange(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, startRaw, endRaw] = m;
  if (startRaw === "" && endRaw === "") return null;

  if (startRaw === "") {
    // Suffix range: the last N bytes.
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(startRaw);
  if (!Number.isFinite(start) || start >= size) return null;
  const end = endRaw === "" ? size - 1 : Math.min(Number(endRaw), size - 1);
  if (!Number.isFinite(end) || end < start) return null;
  return { start, end };
}

/** Serve the mirrored MP3 from disk with Range (206) / conditional (304) support. */
async function serveLocalFile(req: Request, trackId: string): Promise<Response> {
  const filePath = localAudioFile(trackId);
  const info = await stat(filePath);
  const size = info.size;
  const etag = etagFor(size, info.mtimeMs);

  const baseHeaders: Record<string, string> = {
    "Content-Type": "audio/mpeg",
    "Accept-Ranges": "bytes",
    "Cache-Control": LOCAL_CACHE_CONTROL,
    ETag: etag,
    "Last-Modified": info.mtime.toUTCString(),
  };

  const ifNoneMatch = req.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch.split(",").some((t) => t.trim() === etag)) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }

  const rangeHeader = req.headers.get("range");
  const range = rangeHeader ? parseRange(rangeHeader, size) : null;
  if (rangeHeader && !range) {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, "Content-Range": `bytes */${size}` },
    });
  }

  let handle: FileHandle | null = null;
  try {
    handle = await open(filePath, "r");
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const length = end - start + 1;
    const buf = Buffer.allocUnsafe(length);
    await handle.read(buf, 0, length, start);

    const headers = { ...baseHeaders, "Content-Length": String(length) };
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    return new Response(new Uint8Array(buf), { status: range ? 206 : 200, headers });
  } finally {
    await handle?.close();
  }
}

/**
 * GET /api/audio/{trackId} — serves the generated audio.
 *
 * 1. Locally mirrored copy (public/uploads/{id}.mp3) when present: zero
 *    boppy.me requests, full Range/304 support, 30-day immutable caching.
 * 2. Otherwise: streamed passthrough from boppy.me /uploads (Range kept),
 *    and a full-file response triggers a background mirror for next time.
 */
export async function GET(req: Request, ctx: { params: Promise<{ trackId: string }> }) {
  const { trackId } = await ctx.params;

  const track = await db.track.findUnique({ where: { id: trackId } });
  if (!track?.songPath) {
    return new Response("Audio not available for this track.", { status: 404 });
  }

  // 1) Local mirror first.
  if (SAFE_ID_RE.test(trackId) && (await hasLocalAudio(trackId))) {
    try {
      return await serveLocalFile(req, trackId);
    } catch {
      // Unexpected FS error → fall back to upstream below.
    }
  }

  // 2) Remote passthrough (+ lazy mirror for subsequent plays).
  let upstream: Response;
  try {
    upstream = await fetchAudio(track.songPath, req.headers.get("range"));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upstream audio request failed.";
    return new Response(message, { status: 502 });
  }

  if (!upstream.ok && upstream.status !== 206) {
    return new Response(`Upstream audio error (${upstream.status}).`, { status: 502 });
  }

  if (upstream.status === 200 && SAFE_ID_RE.test(trackId)) {
    void mirrorAudio(trackId, track.songPath);
  }

  const headers = new Headers();
  for (const name of PASSTHROUGH_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has("content-type")) headers.set("content-type", "audio/mpeg");
  headers.set("cache-control", "public, max-age=3600");

  return new Response(upstream.body, { status: upstream.status, headers });
}
