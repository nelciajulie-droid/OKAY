import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  BOPPY_DURATIONS,
  BOPPY_TIME_SIGNATURES,
  BoppyError,
  createJob,
} from "@/lib/boppy";

const KEYSCALE_RE = /^[A-G][#b]? (major|minor)$/;
const BPM_MIN = 40;
const BPM_MAX = 220;

/** Snap a requested duration to the durations offered by the official client. */
function snapDuration(value: number): number {
  return BOPPY_DURATIONS.reduce((best, d) =>
    Math.abs(d - value) < Math.abs(best - value) ? d : best,
  BOPPY_DURATIONS[0]);
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * POST /api/generate — create a boppy.me generation job.
 * Body: { prompt, lyrics?, title?, styleTags?, duration?, bpm?,
 *         keyscale?, timesignature?, promptId? }
 * `caption` sent upstream = prompt + styleTags joined with ", " (the exact
 * join format used by the official client).
 * Identical parameters reuse an existing SUCCESS/PENDING generation
 * (quota-friendly dedup) → 200 { generation, deduped: true }.
 * → 201 { generation } | 200 { generation, deduped: true } | 4xx/502 { error }
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;

  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  const lyrics = typeof body?.lyrics === "string" ? body.lyrics.trim() : "";
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const styleTags = typeof body?.styleTags === "string" ? body.styleTags.trim() : "";

  const caption = [prompt, styleTags].filter(Boolean).join(", ");
  if (!caption) {
    return NextResponse.json(
      { error: "A description (or at least style tags) is required." },
      { status: 400 },
    );
  }

  const duration = snapDuration(clamp(Number(body?.duration ?? 120), 10, 600));
  const bpm = Math.round(clamp(Number(body?.bpm ?? 120), BPM_MIN, BPM_MAX));

  const keyscaleRaw = typeof body?.keyscale === "string" ? body.keyscale.trim() : "";
  const keyscale = KEYSCALE_RE.test(keyscaleRaw) ? keyscaleRaw : null;
  const timesigRaw = typeof body?.timesignature === "string" ? body.timesignature.trim() : "";
  const timesignature = (BOPPY_TIME_SIGNATURES as readonly string[]).includes(timesigRaw)
    ? timesigRaw
    : null;
  const promptId = typeof body?.promptId === "string" && body.promptId.trim() ? body.promptId.trim() : null;

  // Quota-friendly dedup: identical parameters → reuse the existing job/track
  // instead of burning another boppy.me request (PENDING = same job continues,
  // SUCCESS = same audio replayed). Failures are retried with a fresh job.
  const identical = await db.generation.findFirst({
    where: {
      prompt,
      styleTags: styleTags || null,
      lyrics: lyrics || null,
      duration,
      bpm,
      keyscale,
      timesignature,
    },
    orderBy: { createdAt: "desc" },
    include: { tracks: true },
  });
  const existingTrack = identical?.tracks[0];
  if (
    existingTrack &&
    (existingTrack.status === "SUCCESS" || existingTrack.status === "PENDING")
  ) {
    return NextResponse.json({ generation: identical, deduped: true }, { status: 200 });
  }

  try {
    const jobId = await createJob({
      caption,
      lyrics: lyrics || undefined,
      duration,
      bpm,
      keyscale: keyscale ?? undefined,
      timesignature: timesignature ?? undefined,
      promptId: promptId ?? undefined,
    });

    const generation = await db.generation.create({
      data: {
        jobId,
        prompt,
        styleTags: styleTags || null,
        lyrics: lyrics || null,
        title: title || null,
        duration,
        bpm,
        keyscale,
        timesignature,
        promptId,
        tracks: {
          create: {
            status: "PENDING",
            title: title || null,
            prompt: caption,
            lyrics: lyrics || null,
            version: "v1",
          },
        },
      },
      include: { tracks: true },
    });

    return NextResponse.json({ generation }, { status: 201 });
  } catch (err) {
    if (err instanceof BoppyError) {
      const payload: Record<string, unknown> = { error: err.message };
      if (err.code) payload.code = err.code;
      if (err.retryAfter !== undefined) payload.retryAfter = err.retryAfter;
      if (err.kind) payload.kind = err.kind;
      return NextResponse.json(payload, {
        status: err.status === 429 ? 429 : 502,
      });
    }
    const message = err instanceof Error ? err.message : "Generation failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
