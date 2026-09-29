"use client";

import { useEffect, useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Clock,
  Copy,
  Download,
  FileText,
  Loader2,
  Pause,
  Play,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  FAILURE_STATUSES,
  SUCCESS_STATUSES,
  isTrackFailed,
  isTrackPending,
  isTrackSuccess,
  type TrackDTO,
  type TrackStatus,
} from "./types";
import { cn } from "@/lib/utils";

/** Format a duration in seconds as m:ss. */
function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function StatusBadge({
  status,
  progress,
}: {
  status: TrackStatus;
  progress: number | null;
}) {
  if (SUCCESS_STATUSES.has(status)) {
    return (
      <Badge className="border border-emerald-500/20 bg-emerald-500/10 text-emerald-400">
        Ready
      </Badge>
    );
  }
  if (FAILURE_STATUSES.has(status)) {
    return (
      <Badge className="border border-red-500/20 bg-red-500/10 text-red-400">
        {status}
      </Badge>
    );
  }
  return (
    <Badge className="border border-amber-500/20 bg-amber-500/10 text-amber-400">
      <span
        className="size-1.5 animate-pulse rounded-full bg-amber-500"
        aria-hidden
      />
      {progress != null ? `Generating ${progress}%` : "Generating"}
    </Badge>
  );
}

interface TrackCardProps {
  track: TrackDTO;
  isPlaying: boolean;
  onTogglePlay: (track: TrackDTO) => void;
}

export function TrackCard({ track, isPlaying, onTogglePlay }: TrackCardProps) {
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  const playable = isTrackSuccess(track) && Boolean(track.songPath);
  const pending = isTrackPending(track);
  const failed = isTrackFailed(track);
  const title = track.title ?? track.generation.title ?? "Untitled track";

  const copyLyrics = async () => {
    if (!track.lyrics) return;
    try {
      await navigator.clipboard.writeText(track.lyrics);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable — nothing sensible to do besides ignoring.
    }
  };

  return (
    <article
      aria-label={title}
      className="rounded-xl border border-zinc-800/80 bg-zinc-900 p-5 transition-colors hover:border-zinc-700/80"
    >
      <Collapsible open={lyricsOpen} onOpenChange={setLyricsOpen}>
        {/* Main row */}
        <div className="flex items-center gap-4">
          {/* Play / status button */}
          {playable ? (
            <Button
              size="icon"
              onClick={() => onTogglePlay(track)}
              aria-label={isPlaying ? `Pause ${title}` : `Play ${title}`}
              className="h-11 w-11 shrink-0 rounded-full bg-amber-500 text-zinc-950 hover:bg-amber-600"
            >
              {isPlaying ? (
                <Pause className="size-5" aria-hidden />
              ) : (
                <Play className="size-5 translate-x-px" aria-hidden />
              )}
            </Button>
          ) : pending ? (
            <Button
              size="icon"
              disabled
              aria-label="Generation in progress"
              className="h-11 w-11 shrink-0 rounded-full border border-zinc-800 bg-zinc-950 text-amber-500 disabled:opacity-100"
            >
              <Loader2 className="size-5 animate-spin" aria-hidden />
            </Button>
          ) : (
            <Button
              size="icon"
              disabled
              aria-label={failed ? "Generation failed" : "No audio available"}
              className={cn(
                "h-11 w-11 shrink-0 rounded-full border border-zinc-800 bg-zinc-950 disabled:opacity-100",
                failed ? "text-red-500" : "text-zinc-600",
              )}
            >
              <AlertTriangle className="size-5" aria-hidden />
            </Button>
          )}

          {/* Title + meta */}
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium">{title}</span>
              {isPlaying && (
                <span
                  className="flex h-4 shrink-0 items-end gap-[2px]"
                  aria-hidden
                >
                  <span className="eq-bar h-full w-[3px] rounded-full bg-amber-500" />
                  <span className="eq-bar h-full w-[3px] rounded-full bg-amber-500" />
                  <span className="eq-bar h-full w-[3px] rounded-full bg-amber-500" />
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              <StatusBadge status={track.status} progress={track.progress} />

              <span className="flex items-center gap-1">
                <Clock className="size-3" aria-hidden />
                {formatDuration(track.duration ?? track.generation.duration)}
              </span>

              <Badge
                variant="outline"
                className="border-zinc-800 text-zinc-500"
              >
                {track.generation.bpm} BPM
              </Badge>

              {track.generation.keyscale && (
                <Badge
                  variant="outline"
                  className="border-zinc-800 text-zinc-500"
                >
                  {track.generation.keyscale}
                </Badge>
              )}

              {track.generation.timesignature && (
                <Badge
                  variant="outline"
                  className="border-zinc-800 text-zinc-500"
                >
                  {track.generation.timesignature}
                </Badge>
              )}

              {track.version && (
                <Badge
                  variant="outline"
                  className="border-zinc-800 text-zinc-500"
                >
                  {track.version}
                </Badge>
              )}

              <time
                dateTime={track.createdAt}
                suppressHydrationWarning
              >
                {formatDistanceToNow(new Date(track.createdAt), {
                  addSuffix: true,
                })}
              </time>

              {track.lyrics && (
                <span className="flex items-center gap-1">
                  <FileText className="size-3" aria-hidden />
                  Lyrics
                </span>
              )}
            </div>

            <p className="line-clamp-1 text-xs text-zinc-600 italic">
              “{track.prompt ?? track.generation.prompt}”
            </p>
          </div>

          {/* Actions */}
          <div className="flex shrink-0 items-center gap-1">
            {track.songPath && (
              <Button
                variant="ghost"
                size="icon"
                asChild
                className="text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              >
                <a
                  href={`/api/audio/${track.id}`}
                  download
                  aria-label={`Download ${title}`}
                >
                  <Download className="size-4" aria-hidden />
                </a>
              </Button>
            )}

            {track.lyrics && (
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={lyricsOpen ? "Hide lyrics" : "Show lyrics"}
                  aria-expanded={lyricsOpen}
                  className="text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                >
                  <ChevronDown
                    className={cn(
                      "size-4 transition-transform",
                      lyricsOpen && "rotate-180",
                    )}
                    aria-hidden
                  />
                </Button>
              </CollapsibleTrigger>
            )}
          </div>
        </div>

        {/* Lyrics panel */}
        {track.lyrics && (
          <CollapsibleContent className="data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-1">
            <div className="mt-4 space-y-3 border-t border-zinc-800/80 pt-4">
              <div className="flex items-center justify-between">
                <span className="text-xs tracking-wide text-zinc-500 uppercase">
                  Lyrics
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={copyLyrics}
                  aria-label={copied ? "Lyrics copied" : "Copy lyrics"}
                  className="size-7 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                >
                  {copied ? (
                    <Check className="size-3.5 text-emerald-500" aria-hidden />
                  ) : (
                    <Copy className="size-3.5" aria-hidden />
                  )}
                </Button>
              </div>

              <p className="custom-scrollbar max-h-48 overflow-y-auto text-sm whitespace-pre-wrap text-zinc-300">
                {track.lyrics}
              </p>
            </div>
          </CollapsibleContent>
        )}
      </Collapsible>
    </article>
  );
}
