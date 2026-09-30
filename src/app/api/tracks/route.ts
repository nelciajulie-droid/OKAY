import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  aceFetchResult,
  fetchJob,
  getBoppyBase,
  getProvider,
  resolveAudioUrl,
} from "@/lib/boppy";
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
 * from the provider's job status endpoint when stale (> 2s).
 *
 * Routing:
 *   - provider="boppy" (default): GET /api/generate/jobs/{jobId} on boppy.me
 *   - provider="ace": POST /api/acem/works/ai/status + POST /engine/api/engine/query_result on acemusic.ai
 */
export async function GET() {
  let tracks = await listTracks();
  const provider = await getProvider();
  const base = await getBoppyBase();

  const now = Date.now();
  const stale = tracks.filter(
    (t) => !isTerminal(t.status) && now - t.lastCheckedAt.getTime() > REFRESH_MIN_AGE_MS,
  );

  if (stale.length > 0) {
    await Promise.all(
      stale.map(async (track) => {
        const jobId = track.generation?.jobId;
        if (!jobId) return;
        try {
          let finalStatus: string;
          let progress: number | null;
          let audioUrl: string | null = null;

          if (provider === "ace") {
            // ACE: polling is done via query_result (NOT status endpoint).
            // The status endpoint is just a client → server ack, not a poll.
            const result = await aceFetchResult(jobId);
            if (result.audioUrl) {
              finalStatus = "SUCCESS";
              progress = 100;
              audioUrl = result.audioUrl;
            } else {
              finalStatus = "PENDING";
              progress = null;
            }
          } else {
            const job = await fetchJob(jobId);
            finalStatus = mapJobStatus(job.status);
            progress = finalStatus === "SUCCESS" ? 100 : job.progress;
            audioUrl = job.audioUrl;
          }

          // Guard against jobs stuck in a non-terminal state forever.
          if (!isTerminal(finalStatus) && now - track.createdAt.getTime() > STALE_TRACK_TIMEOUT_MS) {
            finalStatus = "TIMEOUT";
          }

          await db.track.update({
            where: { id: track.id },
            data: {
              status: finalStatus,
              progress: progress !== null ? Math.round(progress) : null,
              songPath:
                finalStatus === "SUCCESS" && audioUrl
                  ? (provider === "ace"
                    ? audioUrl
                    : await resolveAudioUrl(audioUrl))
                  : undefined,
              lastCheckedAt: new Date(),
            },
          });

          // Mirror the finished MP3 locally: replays/seeks/downloads then
          // never hit boppy.me again (see src/lib/mirror.ts).
          if (finalStatus === "SUCCESS" && audioUrl) {
            const mirrorSource =
              provider === "ace" ? audioUrl : await resolveAudioUrl(audioUrl, base);
            void mirrorAudio(track.id, mirrorSource);
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
