"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  Loader2,
  Music,
  Sparkles,
  Timer,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  ApiMutationError,
  type ApiErrorBody,
  type GeneratePayload,
  type GenerateResponse,
  type LyricsPayload,
  type LyricsResponse,
} from "./types";
import { cn } from "@/lib/utils";

const MAX_PROMPT_LENGTH = 1000;
const MAX_LYRICS_LENGTH = 3000;
const MAX_TAGS_LENGTH = 300;
const BPM_MIN = 40;
const BPM_MAX = 220;
const DEFAULT_BPM = 120;

/** Sentinel for "no selection" — Radix Select items can't use empty strings. */
const ANY_VALUE = "any";

const DURATIONS: { value: number; label: string }[] = [
  { value: 30, label: "30s" },
  { value: 60, label: "1 min" },
  { value: 120, label: "2 min" },
  { value: 180, label: "3 min" },
];

const KEYSCALES = [
  "C major", "C minor",
  "C# major", "C# minor",
  "D major", "D minor",
  "Eb major", "Eb minor",
  "E major", "E minor",
  "F major", "F minor",
  "F# major", "F# minor",
  "G major", "G minor",
  "Ab major", "Ab minor",
  "A major", "A minor",
  "Bb major", "Bb minor",
  "B major", "B minor",
] as const;

const TIME_SIGNATURES = ["2/4", "3/4", "4/4", "6/8"] as const;

/** Turn an API error body into a human message, special-casing boppy rate limits. */
function apiErrorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === "object" && "error" in data) {
    const body = data as ApiErrorBody;
    if (body.code === "rate_limited_network" && typeof body.retryAfter === "number") {
      return `Rate limited — retry in ~${Math.ceil(body.retryAfter / 60)} min (${
        body.kind === "daily" ? "daily limit" : "burst"
      })`;
    }
    if (body.error) return body.error;
  }
  return fallback;
}

/** Build an ApiMutationError carrying structured rate-limit fields when present. */
function apiMutationError(data: unknown, fallback: string): ApiMutationError {
  const err = new ApiMutationError(apiErrorMessage(data, fallback));
  if (data && typeof data === "object") {
    const body = data as ApiErrorBody;
    if (typeof body.retryAfter === "number") err.retryAfter = body.retryAfter;
    if (body.kind === "burst" || body.kind === "daily") err.kind = body.kind;
  }
  return err;
}

/** "1h 05m" / "4m 12s" / "42s" for the rate-limit banner. */
function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function PromptComposer() {
  const queryClient = useQueryClient();

  // --- form state ---
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [styleTags, setStyleTags] = useState("");
  const [promptId, setPromptId] = useState<string | null>(null);
  const [duration, setDuration] = useState(120);
  const [bpmInput, setBpmInput] = useState(String(DEFAULT_BPM));
  const [keyscale, setKeyscale] = useState("");
  const [timesignature, setTimesignature] = useState("");

  // Rate-limit cooldown (429 burst/daily): blocks Generate with a countdown.
  const [cooldown, setCooldown] = useState<{
    until: number;
    kind: "burst" | "daily";
  } | null>(null);
  const [nowTs, setNowTs] = useState(() => Date.now());
  const cooldownRemaining = cooldown ? Math.max(0, cooldown.until - nowTs) : 0;

  useEffect(() => {
    if (!cooldown) return;
    const id = setInterval(() => {
      if (Date.now() >= cooldown.until) {
        setCooldown(null);
      } else {
        setNowTs(Date.now());
      }
    }, 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  /** Parse + clamp the BPM input (empty/invalid falls back to the default). */
  const parsedBpm = (): number => {
    const value = Math.round(Number(bpmInput));
    if (!Number.isFinite(value)) return DEFAULT_BPM;
    return Math.min(BPM_MAX, Math.max(BPM_MIN, value));
  };

  // --- AI lyrics composition (boppy.me /api/llm/compose via our proxy) ---
  const lyricsMutation = useMutation<LyricsResponse, Error, void>({
    mutationFn: async () => {
      const payload: LyricsPayload = { prompt: prompt.trim() };
      const res = await fetch("/api/lyrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => null)) as
        | LyricsResponse
        | ApiErrorBody
        | null;
      if (!res.ok) {
        throw apiMutationError(data, "Lyrics composition failed.");
      }
      return data as LyricsResponse;
    },
    onSuccess: (data) => {
      if (data.title) setTitle(data.title.slice(0, 200));
      if (data.lyrics) {
        setLyrics(data.lyrics.slice(0, MAX_LYRICS_LENGTH));
        setLyricsOpen(true);
      }
      if (data.caption) setStyleTags(data.caption.slice(0, MAX_TAGS_LENGTH));
      if (data.promptId) setPromptId(data.promptId);
      toast.success("Lyrics composed — tweak anything before generating");
    },
    onError: (err) => {
      if (err instanceof ApiMutationError && (err.retryAfter ?? 0) > 0) {
        setCooldown({
          until: Date.now() + (err.retryAfter ?? 0) * 1000 + 2_000,
          kind: err.kind ?? "burst",
        });
        setNowTs(Date.now());
      }
      toast.error(err.message || "Lyrics composition failed.");
    },
  });

  // --- track generation ---
  const generateMutation = useMutation<GenerateResponse, Error, void>({
    mutationFn: async () => {
      const payload: GeneratePayload = {
        prompt: prompt.trim(),
        duration,
        bpm: parsedBpm(),
      };
      const trimmedTitle = title.trim();
      if (trimmedTitle) payload.title = trimmedTitle;
      const trimmedLyrics = lyrics.trim();
      if (trimmedLyrics) payload.lyrics = trimmedLyrics;
      const trimmedTags = styleTags.trim();
      if (trimmedTags) payload.styleTags = trimmedTags;
      if (keyscale) payload.keyscale = keyscale;
      if (timesignature) payload.timesignature = timesignature;
      if (promptId) payload.promptId = promptId;

      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => null)) as
        | GenerateResponse
        | ApiErrorBody
        | null;
      if (!res.ok) {
        throw apiMutationError(data, "Generation failed.");
      }
      return data as GenerateResponse;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["tracks"] });
      if (data.deduped) {
        toast.info("Identical generation already exists — reusing it (no quota used)");
      } else {
        toast.success("Track queued — usually ready in 10-20 seconds");
      }
    },
    onError: (err) => {
      if (err instanceof ApiMutationError && (err.retryAfter ?? 0) > 0) {
        setCooldown({
          until: Date.now() + (err.retryAfter ?? 0) * 1000 + 2_000,
          kind: err.kind ?? "burst",
        });
        setNowTs(Date.now());
      }
      toast.error(err.message || "Generation failed.");
    },
  });

  const generating = generateMutation.isPending;
  const composing = lyricsMutation.isPending;
  const rateLimited = cooldown !== null;
  const canGenerate =
    !rateLimited &&
    !generating &&
    (prompt.trim().length > 0 || styleTags.trim().length > 0);

  return (
    <Card className="gap-5 border-zinc-800/80 bg-zinc-900 py-5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="size-5 text-amber-500" aria-hidden />
          Describe your track
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* Prompt */}
        <div className="relative">
          <label htmlFor="boppy-prompt" className="sr-only">
            Track description
          </label>
          <Textarea
            id="boppy-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value.slice(0, MAX_PROMPT_LENGTH))}
            placeholder="e.g. An upbeat summer pop song about road trips with bright synths and catchy hooks"
            maxLength={MAX_PROMPT_LENGTH}
            className="min-h-[88px] resize-none border-zinc-800 bg-zinc-950 pr-3 focus-visible:ring-amber-500/40"
          />
          <span className="pointer-events-none absolute right-3 bottom-2 text-xs text-zinc-600">
            {prompt.length}/{MAX_PROMPT_LENGTH}
          </span>
        </div>

        {/* Actions — AI compose */}
        <div className="flex justify-end">
          <Button
            variant="secondary"
            onClick={() => lyricsMutation.mutate()}
            disabled={prompt.trim().length === 0 || composing}
            className="bg-zinc-800 text-zinc-100 hover:bg-zinc-700"
          >
            {composing ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <Sparkles aria-hidden />
            )}
            {composing ? "Composing…" : "Generate with AI"}
          </Button>
        </div>

        {/* Title (editable — prefilled by the AI composer) */}
        <div className="space-y-1.5">
          <label htmlFor="boppy-title" className="sr-only">
            Title
          </label>
          <Input
            id="boppy-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title"
            maxLength={200}
            autoComplete="off"
            className="border-zinc-800 bg-zinc-950 text-zinc-100 placeholder:text-zinc-600 focus-visible:ring-amber-500/40"
          />
        </div>

        {/* Lyrics (optional — editable, or write your own) */}
        <Collapsible open={lyricsOpen} onOpenChange={setLyricsOpen}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              aria-expanded={lyricsOpen}
              className="flex min-h-[24px] items-center gap-1 rounded text-sm text-zinc-400 transition-colors hover:text-zinc-200"
            >
              Lyrics <span className="text-zinc-600">(optional)</span>
              <ChevronDown
                className={cn(
                  "size-3.5 transition-transform",
                  lyricsOpen && "rotate-180",
                )}
                aria-hidden
              />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2">
            <label htmlFor="boppy-lyrics" className="sr-only">
              Lyrics
            </label>
            <Textarea
              id="boppy-lyrics"
              value={lyrics}
              onChange={(e) => setLyrics(e.target.value.slice(0, MAX_LYRICS_LENGTH))}
              placeholder={"[Verse]\nWrite your own lyrics here — or leave empty for an instrumental-style generation"}
              maxLength={MAX_LYRICS_LENGTH}
              className="custom-scrollbar max-h-64 min-h-[120px] resize-y border-zinc-800 bg-zinc-950 font-mono text-sm text-zinc-100 placeholder:text-zinc-600 focus-visible:ring-amber-500/40"
            />
          </CollapsibleContent>
        </Collapsible>

        {/* Style tags */}
        <div className="space-y-1.5">
          <label htmlFor="boppy-style-tags" className="sr-only">
            Style tags
          </label>
          <Input
            id="boppy-style-tags"
            value={styleTags}
            onChange={(e) => setStyleTags(e.target.value.slice(0, MAX_TAGS_LENGTH))}
            placeholder="pop, catchy hooks, bright synths"
            maxLength={MAX_TAGS_LENGTH}
            autoComplete="off"
            className="border-zinc-800 bg-zinc-950 text-zinc-100 placeholder:text-zinc-600 focus-visible:ring-amber-500/40"
          />
          <p className="text-xs text-zinc-500">Comma-separated style tags</p>
        </div>

        {/* Options row */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="space-y-1.5">
            <Label htmlFor="boppy-duration" className="text-xs text-zinc-400">
              Duration
            </Label>
            <Select
              value={String(duration)}
              onValueChange={(value) => setDuration(Number(value))}
            >
              <SelectTrigger
                id="boppy-duration"
                className="border-zinc-800 bg-zinc-950 text-zinc-100"
                aria-label="Duration"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-zinc-800/80 bg-zinc-900 text-zinc-100">
                {DURATIONS.map((d) => (
                  <SelectItem
                    key={d.value}
                    value={String(d.value)}
                    className="focus:bg-zinc-800 focus:text-zinc-100"
                  >
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="boppy-bpm" className="text-xs text-zinc-400">
              BPM
            </Label>
            <Input
              id="boppy-bpm"
              type="number"
              inputMode="numeric"
              min={BPM_MIN}
              max={BPM_MAX}
              value={bpmInput}
              onChange={(e) => setBpmInput(e.target.value)}
              autoComplete="off"
              className="border-zinc-800 bg-zinc-950 text-zinc-100 focus-visible:ring-amber-500/40"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="boppy-keyscale" className="text-xs text-zinc-400">
              Key
            </Label>
            <Select
              value={keyscale || ANY_VALUE}
              onValueChange={(value) => setKeyscale(value === ANY_VALUE ? "" : value)}
            >
              <SelectTrigger
                id="boppy-keyscale"
                className="border-zinc-800 bg-zinc-950 text-zinc-100"
                aria-label="Keyscale"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="custom-scrollbar max-h-64 border-zinc-800/80 bg-zinc-900 text-zinc-100">
                <SelectItem
                  value={ANY_VALUE}
                  className="focus:bg-zinc-800 focus:text-zinc-100"
                >
                  Any
                </SelectItem>
                {KEYSCALES.map((k) => (
                  <SelectItem
                    key={k}
                    value={k}
                    className="focus:bg-zinc-800 focus:text-zinc-100"
                  >
                    {k}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="boppy-timesignature" className="text-xs text-zinc-400">
              Time
            </Label>
            <Select
              value={timesignature || ANY_VALUE}
              onValueChange={(value) =>
                setTimesignature(value === ANY_VALUE ? "" : value)
              }
            >
              <SelectTrigger
                id="boppy-timesignature"
                className="border-zinc-800 bg-zinc-950 text-zinc-100"
                aria-label="Time signature"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-zinc-800/80 bg-zinc-900 text-zinc-100">
                <SelectItem
                  value={ANY_VALUE}
                  className="focus:bg-zinc-800 focus:text-zinc-100"
                >
                  Any
                </SelectItem>
                {TIME_SIGNATURES.map((ts) => (
                  <SelectItem
                    key={ts}
                    value={ts}
                    className="focus:bg-zinc-800 focus:text-zinc-100"
                  >
                    {ts}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Rate-limit countdown (429 from the API) */}
        {rateLimited && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-200"
          >
            <Timer className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden />
            <span>
              Rate limit reached ({cooldown?.kind === "daily" ? "daily limit" : "burst"}) — new
              generations unlock in{" "}
              <span className="font-mono font-semibold">
                {formatCountdown(cooldownRemaining)}
              </span>
              . Your existing tracks stay playable and downloadable.
            </span>
          </div>
        )}

        {/* Generate */}
        <div className="flex justify-end">
          <Button
            onClick={() => generateMutation.mutate()}
            disabled={!canGenerate}
            aria-label="Generate track"
            className="min-h-9 w-full bg-amber-500 font-semibold text-zinc-950 hover:bg-amber-600 sm:w-auto"
          >
            {generating ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <Music aria-hidden />
            )}
            {generating ? "Queuing…" : "Generate track"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
