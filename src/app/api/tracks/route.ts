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
 *   - provider="boppy" (default): GET /api/generate/jobs/{jobId} on boppy.me → 1 track
 *   - provider="ace": POST /engine/api/engine/query_result on acemusic.ai → 2 variations
 *
 * ACE generates 2 variations per job. Both tracks in our DB share the same
 * jobId — we poll once per unique jobId and update each track with its
 * corresponding variation (track[0] → variation[0], track[1] → variation[1]).
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
    // Group stale tracks by jobId — ACE creates 2 tracks per job, both with
    // the same jobId. We poll once per jobId to avoid duplicate ACE API calls.
    const staleByJobId = new Map<string, typeof stale>();
    for (const t of stale) {
      const jobId = t.generation?.jobId;
      if (!jobId) continue;
      if (!staleByJobId.has(jobId)) staleByJobId.set(jobId, []);
      staleByJobId.get(jobId)!.push(t);
    }

    await Promise.all(
      Array.from(staleByJobId.entries()).map(async ([jobId, jobTracks]) => {
        try {
          if (provider === "ace") {
            // ACE: poll query_result once, get 2 variations, update both tracks.
            const result = await aceFetchResult(jobId);
            if (result.variations.length === 0) {
              // Still pending — bump lastCheckedAt for both tracks.
              await Promise.all(
                jobTracks.map((t) =>
                  db.track
                    .update({ where: { id: t.id }, data: { lastCheckedAt: new Date() } })
                    .catch(() => undefined),
                ),
              );
              return;
            }
            // Update each track with its corresponding variation.
            await Promise.all(
              jobTracks.map(async (track, idx) => {
                const variation = result.variations[idx];
                if (!variation) {
                  // Fewer variations than tracks — mark as FAILED.
                  await db.track.update({
                    where: { id: track.id },
                    data: {
                      status: "FAILED",
                      lastCheckedAt: new Date(),
                    },
                  });
                  return;
                }
                // Stale-track timeout guard.
                let finalStatus = "SUCCESS";
                if (now - track.createdAt.getTime() > STALE_TRACK_TIMEOUT_MS) {
                  finalStatus = "TIMEOUT";
                }
                await db.track.update({
                  where: { id: track.id },
                  data: {
                    status: finalStatus,
                    progress: 100,
                    songPath: variation.audioUrl,
                    title: variation.title || track.title,
                    lyrics: variation.lyrics || track.lyrics,
                    lastCheckedAt: new Date(),
                  },
                });
                // Mirror the finished AAC locally.
                if (finalStatus === "SUCCESS") {
                  void mirrorAudio(track.id, variation.audioUrl);
                }
              }),
            );
          } else {
            // boppy: 1 track per job — poll fetchJob once, update the single track.
            const job = await fetchJob(jobId);
            const finalStatus =
              !isTerminal(mapJobStatus(job.status)) &&
              now - jobTracks[0]!.createdAt.getTime() > STALE_TRACK_TIMEOUT_MS
                ? "TIMEOUT"
                : mapJobStatus(job.status);
            const audioUrl = job.audioUrl;
            await Promise.all(
              jobTracks.map(async (track) => {
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
                      finalStatus === "SUCCESS" && audioUrl
                        ? await resolveAudioUrl(audioUrl)
                        : undefined,
                    lastCheckedAt: new Date(),
                  },
                });
                if (finalStatus === "SUCCESS" && audioUrl) {
                  void mirrorAudio(track.id, await resolveAudioUrl(audioUrl, base));
                }
              }),
            );
          }
        } catch {
          // Network error on this poll: bump lastCheckedAt for all tracks of this job.
          await Promise.all(
            jobTracks.map((t) =>
              db.track
                .update({ where: { id: t.id }, data: { lastCheckedAt: new Date() } })
                .catch(() => undefined),
            ),
          );
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
