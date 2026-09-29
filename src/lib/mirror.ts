/**
 * Local audio mirror — downloads finished boppy.me MP3s into public/uploads/
 * so replays, seeks and downloads never hit boppy.me again (rate-limit
 * friendly: one upstream request per track, ever).
 *
 * Files are served by GET /api/audio/{trackId} with full HTTP Range (206)
 * support, nginx-style ETags and long-lived caching — mirroring boppy.me's
 * own /uploads/{file}.mp3 behaviour.
 */

import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { fetchAudio } from "@/lib/boppy";

const UPLOADS_DIR = path.join(process.cwd(), "public", "uploads");

/** Absolute FS path of the mirrored copy for a track. */
export function localAudioFile(trackId: string): string {
  return path.join(UPLOADS_DIR, `${trackId}.mp3`);
}

/** Whether a non-empty mirrored MP3 already exists on disk. */
export async function hasLocalAudio(trackId: string): Promise<boolean> {
  try {
    const info = await stat(localAudioFile(trackId));
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

// One download per track even under concurrent triggers (poll + first play).
const inflight = new Map<string, Promise<boolean>>();

/**
 * Download `remoteUrl` (absolute) into public/uploads/{trackId}.mp3.
 * Idempotent: skips when the file already exists. Never throws —
 * on failure the track simply keeps being served by remote passthrough.
 */
export function mirrorAudio(trackId: string, remoteUrl: string): Promise<boolean> {
  const running = inflight.get(trackId);
  if (running) return running;
  const promise = doMirror(trackId, remoteUrl).finally(() => inflight.delete(trackId));
  inflight.set(trackId, promise);
  return promise;
}

async function doMirror(trackId: string, remoteUrl: string): Promise<boolean> {
  if (!/^https?:\/\//i.test(remoteUrl)) return false;
  if (await hasLocalAudio(trackId)) return true;
  try {
    const res = await fetchAudio(remoteUrl, null);
    if (!res.ok || !res.body) return false;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0) return false;
    await mkdir(UPLOADS_DIR, { recursive: true });
    const tmp = path.join(UPLOADS_DIR, `.${trackId}.${Date.now()}.tmp`);
    await writeFile(tmp, bytes);
    await rename(tmp, localAudioFile(trackId)); // atomic swap
    return true;
  } catch {
    return false;
  }
}
