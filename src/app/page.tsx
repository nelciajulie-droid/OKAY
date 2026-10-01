"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import {
  AudioLines,
  AudioWaveform,
  Loader2,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Radio,
  RefreshCw,
  Settings,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
// Realtime AI section — ChatGPT / Perplexity voice via WebRTC SDP exchange
// ---------------------------------------------------------------------------

type RealtimeProvider = "chatgpt" | "perplexity";

// The 9 ChatGPT Realtime voices (the consumer chatgpt.com session.update
// event accepts any of these). Perplexity has its own voice handling so we
// don't show this selector for the Perplexity provider.
const CHATGPT_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "nova",
  "sage",
  "shimmer",
  "verse",
] as const;

type ConnectionStatus = "idle" | "connecting" | "connected" | "error";

function RealtimeChat() {
  const [provider, setProvider] = useState<RealtimeProvider>("chatgpt");
  const [voice, setVoice] = useState<(typeof CHATGPT_VOICES)[number]>("alloy");
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string[]>([]);

  // Refs that don't trigger re-renders.
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const voiceRef = useRef(voice);
  const providerRef = useRef(provider);
  useEffect(() => {
    voiceRef.current = voice;
  }, [voice]);
  useEffect(() => {
    providerRef.current = provider;
  }, [provider]);

  const log = useCallback((line: string) => {
    setTranscript((t) => [...t.slice(-200), `[${new Date().toLocaleTimeString()}] ${line}`]);
  }, []);

  /** Tear down the current connection + release the mic. */
  const teardown = useCallback(() => {
    if (dcRef.current) {
      try { dcRef.current.close(); } catch { /* ignore */ }
      dcRef.current = null;
    }
    if (pcRef.current) {
      try { pcRef.current.close(); } catch { /* ignore */ }
      pcRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    setMuted(false);
  }, []);

  /** Connect to the selected provider's realtime endpoint. */
  const connect = useCallback(async () => {
    setError(null);
    setStatus("connecting");
    setTranscript([]);
    log(`Connecting to ${providerRef.current}…`);

    try {
      // 1. Get the user's mic.
      const localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      localStreamRef.current = localStream;

      // 2. Create the peer connection + add the mic track.
      const pc = new RTCPeerConnection();
      pcRef.current = pc;
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

      // 3. Open the data channel BEFORE creating the offer (the OpenAI
      //    Realtime protocol uses a data channel named "oai-events" for
      //    conversation events). Perplexity may use its own channel —
      //    creating one upfront is harmless; the server opens its own if it
      //    needs a different name).
      const dc = pc.createDataChannel("oai-events", { ordered: true });
      dcRef.current = dc;
      dc.onopen = () => {
        log("Data channel open.");
        // ChatGPT: send a session.update to set the selected voice + audio
        // modalities. Perplexity has its own protocol so we skip this.
        if (providerRef.current === "chatgpt") {
          const update = {
            type: "session.update",
            session: {
              modalities: ["text", "audio"],
              voice: voiceRef.current,
              input_audio_format: "pcm16",
              output_audio_format: "pcm16",
              turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 200 },
            },
          };
          dc.send(JSON.stringify(update));
          log(`Voice set to "${voiceRef.current}".`);
        }
      };
      dc.onmessage = (e) => {
        // Surface conversation events (transcripts etc.) in the transcript.
        try {
          const msg = JSON.parse(typeof e.data === "string" ? e.data : "");
          if (msg.type === "conversation.item.input_audio_transcription.completed" && msg.transcript) {
            log(`You: ${msg.transcript}`);
          } else if (msg.type === "response.audio_transcript.delta" && msg.delta) {
            // Append delta to the last assistant line.
            setTranscript((t) => {
              const next = [...t];
              const last = next[next.length - 1] ?? "";
              if (last.startsWith(`[${new Date().toLocaleTimeString()}] AI:`)) {
                next[next.length - 1] = last + msg.delta;
              } else {
                next.push(`[${new Date().toLocaleTimeString()}] AI: ${msg.delta}`);
              }
              return next;
            });
          } else if (msg.type === "error") {
            log(`Server error: ${msg.error?.message ?? JSON.stringify(msg)}`);
          }
        } catch {
          // Non-JSON message — ignore.
        }
      };

      // 4. Play the remote audio track on a hidden <audio> element.
      pc.ontrack = (event) => {
        log("Remote audio track received.");
        if (!audioElRef.current) {
          audioElRef.current = new Audio();
          audioElRef.current.autoplay = true;
        }
        audioElRef.current.srcObject = event.streams[0];
        audioElRef.current.play().catch(() => { /* autoplay may need a user gesture */ });
      };

      // 5. Create the SDP offer.
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      // Wait for ICE gathering to complete (or a short timeout) so the offer
      // contains ICE candidates — saves a round-trip.
      await waitForIceGathering(pc, 2000);

      // 6. POST the offer to the backend, which forwards it to ChatGPT or
      //    Perplexity and returns the SDP answer.
      const endpoint =
        providerRef.current === "chatgpt" ? "/api/realtime/connect" : "/api/perplexity/connect";
      log(`POST ${endpoint}…`);
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sdp: pc.localDescription?.sdp ?? offer.sdp }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Backend ${res.status}: ${text.slice(0, 300)}`);
      }
      const data = (await res.json()) as { sdp?: string; type?: string };
      if (!data.sdp) throw new Error("Backend returned no SDP answer.");

      // 7. Apply the remote answer.
      await pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
      setStatus("connected");
      log("Connected. Speak when ready.");
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      setError(message);
      setStatus("error");
      log(`Error: ${message}`);
      teardown();
    }
  }, [log, teardown]);

  /** Toggle the mic on/off (mutes the local audio track). */
  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !muted;
    stream.getAudioTracks().forEach((t) => (t.enabled = !next));
    setMuted(next);
    log(next ? "Mic muted." : "Mic unmuted.");
  }, [muted, log]);

  /** Disconnect from the provider. */
  const disconnect = useCallback(() => {
    teardown();
    setStatus("idle");
    log("Disconnected.");
  }, [teardown, log]);

  // Clean up on unmount.
  useEffect(() => {
    return () => teardown();
  }, [teardown]);

  const connected = status === "connected";

  return (
    <Card className="border-zinc-800 bg-zinc-900/40">
      <CardHeader className="gap-2">
        <div className="flex items-center gap-2">
          <Radio className="size-4 text-amber-500" aria-hidden />
          <CardTitle className="text-base">Realtime AI Voice</CardTitle>
          <Badge
            variant="secondary"
            className={
              connected
                ? "bg-emerald-600/20 text-emerald-300"
                : status === "connecting"
                  ? "bg-amber-600/20 text-amber-300"
                  : status === "error"
                    ? "bg-rose-600/20 text-rose-300"
                    : "bg-zinc-800 text-zinc-400"
            }
            aria-live="polite"
          >
            {connected ? "Live" : status === "connecting" ? "Connecting…" : status === "error" ? "Error" : "Idle"}
          </Badge>
        </div>
        <CardDescription className="text-zinc-500">
          Talk to a realtime AI model over WebRTC. ChatGPT needs a JWT in the
          vault; Perplexity needs its session cookies there.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Provider selector */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-zinc-400" id="rt-provider-label">
            Provider
          </span>
          <div
            role="radiogroup"
            aria-labelledby="rt-provider-label"
            className="inline-flex overflow-hidden rounded-lg border border-zinc-800"
          >
            <ProviderButton
              active={provider === "chatgpt"}
              onClick={() => setProvider("chatgpt")}
              disabled={connected || status === "connecting"}
            >
              ChatGPT
            </ProviderButton>
            <ProviderButton
              active={provider === "perplexity"}
              onClick={() => setProvider("perplexity")}
              disabled={connected || status === "connecting"}
            >
              Perplexity
            </ProviderButton>
          </div>

          {/* Voice selector — ChatGPT only. */}
          {provider === "chatgpt" && (
            <Select value={voice} onValueChange={(v) => setVoice(v as typeof voice)} disabled={connected}>
              <SelectTrigger
                className="ml-auto h-9 w-36 border-zinc-800 bg-zinc-950 text-zinc-200"
                aria-label="ChatGPT voice"
              >
                <SelectValue placeholder="Voice" />
              </SelectTrigger>
              <SelectContent className="border-zinc-800 bg-zinc-950 text-zinc-200">
                {CHATGPT_VOICES.map((v) => (
                  <SelectItem key={v} value={v} className="capitalize focus:bg-zinc-800">
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {/* Connect / disconnect + mic */}
        <div className="flex items-center gap-2">
          {connected ? (
            <Button
              variant="destructive"
              onClick={disconnect}
              className="gap-2"
            >
              <PhoneOff className="size-4" aria-hidden />
              Disconnect
            </Button>
          ) : (
            <Button
              onClick={connect}
              disabled={status === "connecting"}
              className="gap-2 bg-emerald-600 text-zinc-50 hover:bg-emerald-500"
            >
              {status === "connecting" ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Phone className="size-4" aria-hidden />
              )}
              {status === "connecting" ? "Connecting…" : "Connect"}
            </Button>
          )}

          <Button
            variant="outline"
            onClick={toggleMute}
            disabled={!connected}
            className={cn(
              "gap-2 border-zinc-800 bg-zinc-950 text-zinc-200 hover:bg-zinc-800",
              muted && "border-rose-800 text-rose-300",
            )}
            aria-pressed={muted}
          >
            {muted ? <MicOff className="size-4" aria-hidden /> : <Mic className="size-4" aria-hidden />}
            {muted ? "Unmute" : "Mute"}
          </Button>
        </div>

        {/* Error */}
        {error && (
          <p className="rounded-md border border-rose-800/60 bg-rose-950/30 px-3 py-2 text-sm text-rose-300">
            {error}
          </p>
        )}

        {/* Transcript / event log */}
        <div
          aria-label="Realtime event log"
          className="max-h-40 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950/60 p-3 text-xs text-zinc-400"
        >
          {transcript.length === 0 ? (
            <span className="text-zinc-600">
              Event log appears here once you connect.
            </span>
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono leading-relaxed">
              {transcript.join("\n")}
            </pre>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Small pill button used in the provider radiogroup. */
function ProviderButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        active
          ? "bg-amber-500 text-zinc-950"
          : "bg-zinc-950 text-zinc-300 hover:bg-zinc-800",
      )}
    >
      {children}
    </button>
  );
}

/** Wait for ICE gathering to complete, or fall back after `timeoutMs`. */
function waitForIceGathering(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const timer = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    }, timeoutMs);
    const check = () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", check);
  });
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
          <RealtimeChat />
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
