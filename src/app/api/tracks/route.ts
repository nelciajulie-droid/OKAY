import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fetchJob, getBoppyBase, resolveAudioUrl } from "@/lib/boppy";
import { mirrorAudio } from "@/lib/mirror";

const REFRESH_MIN_AGE_MS = 2_000; // official client polls every ~2s
const TERMINAL_SUCCESS = new Set(["SUCCESS"]);
const TERMINAL_FAILURE = new Set(["FAILED", "ERROR", "TIMEOUT"]);
const STALE_TRACK_TIMEOUT_MS = 20 * 60 * 1_000; // 20 min → mark TIMEOUT

/** Map a boppy job status to our local track status. */
function mapJobStatus(jobStatus: string): string {
  switch (jobStatus) {
    case "done":
      return "SUCCESS";
    case "failed":
      return "FAILED";
    case "error":
      return "ERROR";
    default:
      return "PENDING";
  }
}

function isTerminal(status: string): boolean {
  return TERMINAL_SUCCESS.has(status) || TERMINAL_FAILURE.has(status);
}

const trackInclude = {
  generation: {
    select: {
      jobId: true,
      prompt: true,
      styleTags: true,
      title: true,
      lyrics: true,
      duration: true,
      bpm: true,
      keyscale: true,
      timesignature: true,
      createdAt: true,
    },
  },
} as const;

async function listTracks() {
  return db.track.findMany({
    orderBy: { createdAt: "desc" },
    include: trackInclude,
  });
}

/**
 * GET /api/tracks — all local tracks; non-terminal tracks are refreshed
 * from GET /api/generate/jobs/{jobId} (boppy.me) when stale (> 2s).
 */
export async function GET() {
  let tracks = await listTracks();

  const now = Date.now();
  const stale = tracks.filter(
    (t) => !isTerminal(t.status) && now - t.lastCheckedAt.getTime() > REFRESH_MIN_AGE_MS,
  );

  if (stale.length > 0) {
    const base = await getBoppyBase();
    await Promise.all(
      stale.map(async (track) => {
        const jobId = track.generation?.jobId;
        if (!jobId) return;
        try {
          const job = await fetchJob(jobId);
          const status = mapJobStatus(job.status);

          // Guard against jobs stuck in a non-terminal state forever.
          const finalStatus =
            !isTerminal(status) && now - track.createdAt.getTime() > STALE_TRACK_TIMEOUT_MS
              ? "TIMEOUT"
              : status;

          await db.track.update({
            where: { id: track.id },
            data: {
              status: finalStatus,
              progress:
                finalStatus === "SUCCESS"
                  ? 100
                  : typeof job.progress === "number"
                    ? Math.round(job.progress)
                    : null,
              songPath:
                finalStatus === "SUCCESS" && job.audioUrl
                  ? resolveAudioUrl(job.audioUrl)
                  : undefined,
              lastCheckedAt: new Date(),
            },
          });

          // Mirror the finished MP3 locally: replays/seeks/downloads then
          // never hit boppy.me again (see src/lib/mirror.ts).
          if (finalStatus === "SUCCESS" && job.audioUrl) {
            void mirrorAudio(track.id, resolveAudioUrl(job.audioUrl, base));
          }
        } catch {
          // Network error on this poll: keep the track pending,
          // just bump lastCheckedAt so we don't hammer the API.
          await db.track
            .update({ where: { id: track.id }, data: { lastCheckedAt: new Date() } })
            .catch(() => undefined);
        }
      }),
    );
    tracks = await listTracks();
  }

  // Self-heal mirror: every SUCCESS track with a remote songPath gets its MP3
  // downloaded once (mirrorAudio is idempotent, deduped and stat-only when the
  // file already exists) so playback never depends on boppy uptime/quota.
  for (const t of tracks) {
    if (t.status === "SUCCESS" && t.songPath && /^https?:\/\//i.test(t.songPath)) {
      void mirrorAudio(t.id, t.songPath);
    }
  }

  return NextResponse.json({ tracks });
}
