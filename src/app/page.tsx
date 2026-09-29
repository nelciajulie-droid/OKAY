"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { AudioLines, AudioWaveform, RefreshCw, Settings } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PromptComposer } from "@/components/boppy/prompt-composer";
import { SettingsDialog } from "@/components/boppy/settings-dialog";
import { TrackCard } from "@/components/boppy/track-card";
import {
  type TrackDTO,
  type TracksResponse,
  isTrackPending,
} from "@/components/boppy/types";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// API fetchers
// ---------------------------------------------------------------------------

async function fetchTracks(): Promise<TracksResponse> {
  const res = await fetch("/api/tracks");
  if (!res.ok) throw new Error("Could not load tracks.");
  return (await res.json()) as TracksResponse;
}

// ---------------------------------------------------------------------------
// Tracks section
// ---------------------------------------------------------------------------

interface TracksSectionProps {
  tracks: TrackDTO[];
  isLoading: boolean;
  isFetching: boolean;
  playingId: string | null;
  onTogglePlay: (track: TrackDTO) => void;
  onRefresh: () => void;
}

function TracksSection({
  tracks,
  isLoading,
  isFetching,
  playingId,
  onTogglePlay,
  onRefresh,
}: TracksSectionProps) {
  return (
    <section aria-label="Generations" className="space-y-4">
      {/* Heading row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold">Generations</h2>
          <Badge
            variant="secondary"
            className="bg-zinc-800 text-zinc-400"
            aria-label={`${tracks.length} generations`}
          >
            {tracks.length}
          </Badge>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onRefresh}
          disabled={isFetching}
          aria-label="Refresh generations"
          className="size-8 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        >
          <RefreshCw
            className={cn("size-4", isFetching && "animate-spin")}
            aria-hidden
          />
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[120px] rounded-xl" />
          ))}
        </div>
      ) : tracks.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <AudioLines className="size-10 text-zinc-700" aria-hidden />
          <p className="mt-3 font-medium">No tracks yet</p>
          <p className="text-sm text-zinc-600">
            Describe a song and hit generate.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <AnimatePresence>
            {tracks.map((track) => (
              <motion.div
                key={track.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25, ease: "easeOut" }}
              >
                <TrackCard
                  track={track}
                  isPlaying={playingId === track.id}
                  onTogglePlay={onTogglePlay}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main studio page
// ---------------------------------------------------------------------------

function BoppyStudio() {
  const queryClient = useQueryClient();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const openSettings = useCallback(() => setSettingsOpen(true), []);

  // Tracks, polling while any generation is in flight.
  const tracksQuery = useQuery<TracksResponse>({
    queryKey: ["tracks"],
    queryFn: fetchTracks,
    staleTime: 0,
    refetchInterval: (query) => {
      const tracks = query.state.data?.tracks;
      if (!tracks) return false;
      return tracks.some((t) => isTrackPending(t)) ? 4000 : false;
    },
  });
  const tracks = tracksQuery.data?.tracks ?? [];

  const refreshTracks = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["tracks"] });
  }, [queryClient]);

  // --- Shared audio playback (single <audio> element) ---
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  const togglePlay = useCallback(
    (track: TrackDTO) => {
      if (!track.songPath) return;

      let audio = audioRef.current;
      if (!audio) {
        audio = new Audio();
        audio.preload = "metadata";
        audio.addEventListener("ended", () => setIsPlaying(false));
        audioRef.current = audio;
      }

      if (currentId === track.id) {
        if (audio.paused) {
          audio
            .play()
            .then(() => setIsPlaying(true))
            .catch(() => setIsPlaying(false));
        } else {
          audio.pause();
          setIsPlaying(false);
        }
        return;
      }

      audio.src = `/api/audio/${track.id}`;
      setCurrentId(track.id);
      audio
        .play()
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false));
    },
    [currentId],
  );

  useEffect(() => {
    return () => {
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
        audioRef.current = null;
      }
    };
  }, []);

  const playingId = isPlaying && currentId ? currentId : null;

  return (
    <>
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-zinc-800/60 bg-zinc-950/80 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between px-4">
          <div className="flex items-center gap-2.5">
            <span
              className="flex size-8 items-center justify-center rounded-lg bg-amber-500 text-zinc-950"
              aria-hidden
            >
              <AudioWaveform className="size-4.5" />
            </span>
            <span className="font-semibold">Boppy Studio</span>
            <Badge variant="outline" className="border-zinc-800 text-zinc-500">
              ACE-Step
            </Badge>
          </div>

          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={openSettings}
                  aria-label="Open settings"
                  className="text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                >
                  <Settings className="size-4.5" aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Settings</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1">
        <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-8">
          <PromptComposer />
          <TracksSection
            tracks={tracks}
            isLoading={tracksQuery.isLoading}
            isFetching={tracksQuery.isFetching}
            playingId={playingId}
            onTogglePlay={togglePlay}
            onRefresh={refreshTracks}
          />
        </div>
      </main>

      {/* Footer */}
      <footer className="mt-auto border-t border-zinc-800/60">
        <div className="mx-auto w-full max-w-3xl px-4 py-4 text-center text-xs text-zinc-600">
          <p>
            Unofficial client for the public boppy.me API (ACE-Step) · No
            affiliation with boppy.me
          </p>
        </div>
      </footer>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}

export default function Page() {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <div className="dark flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
        <BoppyStudio />
      </div>
    </QueryClientProvider>
  );
}
