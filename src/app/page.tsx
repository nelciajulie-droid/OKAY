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
// Realtime AI section — ChatGPT / Perplexity / Gemini / Inworld / Qwen voice
// ---------------------------------------------------------------------------

type RealtimeProvider = "chatgpt" | "perplexity" | "gemini" | "inworld" | "qwen";

// The 9 ChatGPT Realtime voices (the consumer chatgpt.com session.update
// event accepts any of these). Perplexity, Gemini, and Inworld have their
// own voice handling so we don't show this selector for those providers.
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

  // Refs that don't trigger re-renders — shared (WebRTC + Gemini).
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const voiceRef = useRef(voice);
  const providerRef = useRef(provider);

  // Refs that don't trigger re-renders — Gemini bidi + Inworld WebSocket
  // (both use a 16kHz AudioContext + ScriptProcessor for mic PCM16 capture
  // and an AudioBufferSourceNode for AI playback; only one is active at a
  // time per RealtimeChat instance, so they safely share these refs).
  // `geminiSessionRef` holds { gsessionid, sid, rid } after start (Gemini).
  // `audioCtxRef` is the AudioContext (16kHz for PCM encode/decode).
  // `micStreamRef` is the MediaStream for the mic (16kHz).
  // `scriptNodeRef` is the ScriptProcessorNode for mic capture.
  // `pollControllerRef` aborts the receive long-poll loop (Gemini only).
  // `sendTimerRef` is the setInterval that flushes the mic buffer.
  // `micBufferRef` accumulates Int16 PCM samples between flushes.
  // `inworldWsRef` is the WebSocket to api.inworld.ai (Inworld only).
  const geminiSessionRef = useRef<{
    gsessionid: string;
    sid: string;
    rid: string;
  } | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const scriptNodeRef = useRef<ScriptProcessorNode | null>(null);
  const pollControllerRef = useRef<AbortController | null>(null);
  const sendTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const micBufferRef = useRef<Int16Array[]>([]);
  const inworldWsRef = useRef<WebSocket | null>(null);
  // `qwenEngineRef` holds the Aliyun RTC engine instance for the Qwen
  // provider. The SDK is dynamically imported inside `connectQwen` (it
  // uses browser-only APIs like navigator.mediaDevices + RTCPeerConnection
  // so it cannot be imported at module top-level — Next.js SSR would
  // fail). We use a loose `any` type because the SDK is loaded via dynamic
  // `import()` and its types are not easily reachable at the ref
  // declaration site. `teardown` calls `publishLocalAudioStream(false)`,
  // `leaveChannel()`, + `destroy()` on this instance to release the mic
  // + the WebRTC resources.
  const qwenEngineRef = useRef<any>(null);
  useEffect(() => {
    voiceRef.current = voice;
  }, [voice]);
  useEffect(() => {
    providerRef.current = provider;
  }, [provider]);

  const log = useCallback((line: string) => {
    setTranscript((t) => [...t.slice(-200), `[${new Date().toLocaleTimeString()}] ${line}`]);
  }, []);

  /** Tear down the current connection + release the mic. Cleans up all
   * three resource sets — WebRTC (ChatGPT/Perplexity), Gemini bidi, and
   * Inworld WebSocket. Only the set for the active provider will be set,
   * so calling close() on the unset ones is a no-op. */
  const teardown = useCallback(() => {
    // --- WebRTC resources ---
    if (dcRef.current) {
      try { dcRef.current.close(); } catch { /* ignore */ }
      dcRef.current = null;
    }
    if (pcRef.current) {
      try { pcRef.current.close(); } catch { /* ignore */ }
      pcRef.current = null;
    }
    // --- Inworld WebSocket (close before clearing the audio path so the
    //     mic-flush loop stops sending into a closing socket) ---
    if (inworldWsRef.current) {
      try {
        if (inworldWsRef.current.readyState === WebSocket.OPEN ||
            inworldWsRef.current.readyState === WebSocket.CONNECTING) {
          inworldWsRef.current.close(1000, "client-teardown");
        }
      } catch { /* ignore */ }
      // Detach the handlers so we don't log a spurious "WebSocket closed"
      // event during teardown.
      inworldWsRef.current.onmessage = null;
      inworldWsRef.current.onerror = null;
      inworldWsRef.current.onclose = null;
      inworldWsRef.current = null;
    }
    // --- Gemini bidi resources ---
    // Cancel the receive long-poll loop first so we don't fire any more
    // requests after we've started tearing down.
    if (pollControllerRef.current) {
      pollControllerRef.current.abort();
      pollControllerRef.current = null;
    }
    if (sendTimerRef.current) {
      clearInterval(sendTimerRef.current);
      sendTimerRef.current = null;
    }
    // Stop all active AI audio playback (barge-in / teardown cleanup).
    clearAudioQueue();
    if (scriptNodeRef.current) {
      try { scriptNodeRef.current.disconnect(); } catch { /* ignore */ }
      scriptNodeRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close(); } catch { /* ignore */ }
      audioCtxRef.current = null;
    }
    geminiSessionRef.current = null;
    micBufferRef.current = [];
    // --- Qwen Aliyun RTC engine ---
    // Tear down the engine BEFORE clearing the shared mic — the engine
    // owns its own getUserMedia stream internally, but `destroy()` is
    // async + we want to start it as early as possible. All three calls
    // return Promises (per the Aliyun RTC SDK types); we fire-and-forget
    // them with `.catch(() => {})` so a rejected promise doesn't crash
    // the React app. Clearing the ref first means a duplicate teardown
    // (e.g. on unmount after explicit disconnect) is a no-op.
    if (qwenEngineRef.current) {
      const eng = qwenEngineRef.current;
      qwenEngineRef.current = null;
      try { void eng.publishLocalAudioStream(false).catch(() => { /* ignore */ }); } catch { /* ignore */ }
      try { void eng.leaveChannel().catch(() => { /* ignore */ }); } catch { /* ignore */ }
      try { void eng.destroy().catch(() => { /* ignore */ }); } catch { /* ignore */ }
    }
    // --- Shared mic ---
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    setMuted(false);
  }, []);

  // -------------------------------------------------------------------------
  // WebRTC path — ChatGPT + Perplexity (SDP offer/answer exchange).
  // -------------------------------------------------------------------------

  /** Connect via WebRTC (ChatGPT or Perplexity). Builds an SDP offer,
   * POSTs it to the backend, applies the SDP answer. */
  const connectWebRtc = useCallback(async () => {
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
      // Qwen: send a session.update matching the Qwen Omni SDK's config
      // (model qwen3.8-omni-flash-realtime, voice Tina, server_vad with
      // 800ms silence, input/output pcm16). Qwen's session.created already
      // configures these defaults, but sending an explicit update is
      // harmless + matches the playground's `sendUpdate` behavior.
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
      } else if (providerRef.current === "qwen") {
        // Qwen Voice session.update — matches the SDK's sendUpdateOptions
        // pattern. The server's session.created already set sensible
        // defaults (model qwen3.8-omni-flash-realtime, voice Tina,
        // server_vad 800ms silence, pcm16 audio), but we send an explicit
        // update to be safe + match the Qwen web client.
        const update = {
          type: "session.update",
          session: {
            modalities: ["text", "audio"],
            voice: "Tina",
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 800,
              create_response: true,
              interrupt_response: true,
            },
            input_audio_transcription: { model: "qwen3-asr-flash-realtime" },
          },
        };
        dc.send(JSON.stringify(update));
        log(`Qwen session configured (model: qwen3.8-omni-flash-realtime, voice: Tina).`);
      }
    };
    dc.onmessage = (e) => {
      // Surface conversation events (transcripts etc.) in the transcript.
      // Handles both standard OpenAI Realtime API event names (ChatGPT) AND
      // the `output_`-infix variants used by Inworld + Qwen
      // (`response.output_audio_transcript.delta` instead of
      // `response.audio_transcript.delta`).
      try {
        const msg = JSON.parse(typeof e.data === "string" ? e.data : "");
        const t = msg.type as string | undefined;
        if (!t) return;
        // User mic transcript (final) — collapse duplicates per speech.
        if (t === "conversation.item.input_audio_transcription.completed" && msg.transcript) {
          log(`You: ${msg.transcript}`);
        }
        // AI transcript (streaming) — both standard + output_ variants.
        else if ((t === "response.audio_transcript.delta" || t === "response.output_audio_transcript.delta") && msg.delta) {
          setTranscript((prev) => {
            const next = [...prev];
            const last = next[next.length - 1] ?? "";
            if (last.includes("] AI:")) {
              next[next.length - 1] = last + msg.delta;
            } else {
              next.push(`[${new Date().toLocaleTimeString()}] AI: ${msg.delta}`);
            }
            return next.slice(-200);
          });
        }
        // AI transcript (final) — only log if no streaming deltas were received.
        else if ((t === "response.audio_transcript.done" || t === "response.output_audio_transcript.done") && msg.transcript) {
          setTranscript((prev) => {
            const last = prev[prev.length - 1] ?? "";
            if (last.includes("] AI:")) return prev; // already have streaming text
            return [...prev.slice(-199), `[${new Date().toLocaleTimeString()}] AI: ${msg.transcript}`];
          });
        }
        // Session lifecycle (Qwen sends session.created on connect).
        else if (t === "session.created") {
          log(`[dc] session created`);
        }
        // Server VAD state (user speech start/stop).
        else if (t === "input_audio_buffer.speech_started") {
          log(`[dc] speech started`);
        }
        else if (t === "input_audio_buffer.speech_stopped") {
          log(`[dc] speech stopped`);
        }
        else if (t === "input_audio_buffer.committed") {
          log(`[dc] audio committed`);
        }
        // Errors.
        else if (t === "error") {
          const errMsg = msg.error?.message ?? msg.error?.code ?? JSON.stringify(msg);
          log(`Server error: ${errMsg}`);
        }
        // Other events are silently ignored (response.created, response.done,
        // rate_limits.updated, etc. — they don't carry user-visible payload).
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

    // 6. POST the offer to the backend, which forwards it to ChatGPT,
    //    Perplexity, or Qwen and returns the SDP answer.
    const endpoint =
      providerRef.current === "chatgpt" ? "/api/realtime/connect"
      : providerRef.current === "perplexity" ? "/api/perplexity/connect"
      : providerRef.current === "qwen" ? "/api/qwen/token"
      : "/api/realtime/connect";
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
    const data = (await res.json()) as { sdp?: string; sdp_token?: string; type?: string };
    // Qwen's backend returns the answer SDP in `sdp_token`; ChatGPT/Perplexity
    // return it in `sdp`. Accept either.
    const answerSdp = data.sdp ?? data.sdp_token;
    if (!answerSdp) throw new Error("Backend returned no SDP answer.");

    // 7. Apply the remote answer.
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    setStatus("connected");
    log("Connected. Speak when ready.");
  }, [log]);

  // -------------------------------------------------------------------------
  // Gemini bidi path — Google AI Studio Web Channel.
  // -------------------------------------------------------------------------

  /** Decode a base64 PCM16 (16kHz mono) string and play it via the
   * AudioContext. Each chunk is scheduled right after the previous one
   * (we keep a `nextStartTime` so chunks don't overlap or stutter). */
  const playPcmChunkRef = useRef<((b64: string) => void) | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  /** Active AudioBufferSourceNodes currently scheduled/playing. Used to
   *  stop all playback immediately on barge-in (when the user starts
   *  speaking, the server sends `input_audio_buffer.speech_started` and
   *  we clear the AI's audio queue so the user can interrupt). Matches
   *  the Inworld playground's `o.current` source-tracking pattern. */
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  /** Whether we're currently in a user speech (between speech_started and
   *  the next speech_started). Used to collapse all user transcription
   *  deltas + completed events into ONE growing "You:" line per speech
   *  — matches the Inworld playground's `userTranscriptItemId.current`
   *  pattern. Reset to false on `speech_started` so the next speech
   *  creates a fresh "You:" line. */
  const inUserSpeechRef = useRef<boolean>(false);
  /** Clear all active audio playback (barge-in). Stops every scheduled
   *  AudioBufferSourceNode and resets `nextStartTimeRef` to "now" so the
   *  next AI response starts fresh. Used on `input_audio_buffer.speech_started`
   *  + on disconnect/teardown. */
  const clearAudioQueue = useCallback(() => {
    for (const src of activeSourcesRef.current) {
      try { src.stop(); } catch { /* already ended */ }
    }
    activeSourcesRef.current.clear();
    const ctx = audioCtxRef.current;
    if (ctx) nextStartTimeRef.current = ctx.currentTime;
  }, []);
  /** Upsert the user's "You:" transcript line. If we're in a user speech
   *  AND the last transcript line is a "You:" line, UPDATE it (replace the
   *  content — each delta is the FULL current transcription, not a chunk
   *  to append, per the OpenAI Realtime API + Inworld playground behavior).
   *  Otherwise, create a new "You:" line + mark `inUserSpeechRef = true`.
   *  This collapses all deltas + completed events for one speech into ONE
   *  line (fixes the "parle en plusieurs audio" / multiple-You: bug). */
  const upsertUserLine = useCallback((text: string) => {
    if (!text) return;
    const prefix = `[${new Date().toLocaleTimeString()}] You:`;
    setTranscript((prev) => {
      const next = [...prev];
      const last = next[next.length - 1] ?? "";
      if (inUserSpeechRef.current && last.includes("] You:")) {
        // UPDATE: replace the content (delta/completed carries the full
        // current transcription, so REPLACE not append).
        next[next.length - 1] = `${prefix} ${text}`;
      } else {
        // CREATE new line + mark as in-speech.
        next.push(`${prefix} ${text}`);
        inUserSpeechRef.current = true;
      }
      return next.slice(-200);
    });
  }, []);

  /** Convert a Float32 PCM buffer to PCM16 (Int16) little-endian. */
  const float32ToInt16 = useCallback((float32: Float32Array): Int16Array => {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const clamped = Math.max(-1, Math.min(1, float32[i]));
      out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }
    return out;
  }, []);

  /** Encode an Int16Array to a base64 string (little-endian bytes). */
  const int16ToBase64 = useCallback((int16: Int16Array): string => {
    const bytes = new Uint8Array(int16.length * 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < int16.length; i++) view.setInt16(i * 2, int16[i], true);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }, []);

  /** Decode a base64 PCM16 (little-endian) string → Float32Array. */
  const base64ToFloat32 = useCallback((b64: string): Float32Array => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const view = new DataView(bytes.buffer);
    const int16 = new Int16Array(bytes.length / 2);
    for (let i = 0; i < int16.length; i++) int16[i] = view.getInt16(i * 2, true);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 0x8000;
    return float32;
  }, []);

  /** Connect via the Gemini bidi (Web Channel) protocol.
   *
   * Flow:
   *   1. POST /api/gemini/connect { action: "start" } → { gsessionid, sid, rid }
   *   2. Open AudioContext (16kHz) + getUserMedia (16kHz) + ScriptProcessor
   *   3. ScriptProcessor onaudioprocess → Float32 → Int16 → queue
   *   4. setInterval(200ms) flushes the queued PCM as base64 → POST send
   *   5. Concurrent long-poll loop: POST receive → audioChunks → play via AudioContext
   */
  const connectGemini = useCallback(async () => {
    // 1. Create an AudioContext at 16kHz so the PCM encode/decode round-
    //    trips match what the Gemini bidi endpoint expects.
    const AudioCtor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const audioCtx = new AudioCtor({ sampleRate: 16000 });
    audioCtxRef.current = audioCtx;
    // Some browsers ignore the requested sample rate; we resample below
    // by routing the mic through a ScriptProcessor at the ctx rate.

    // 2. Get the user's mic (no constraints on sample rate — we'll
    //    capture at whatever the AudioContext uses).
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    micStreamRef.current = micStream;
    // Reuse the shared localStreamRef so the existing mute toggle works
    // for Gemini too.
    localStreamRef.current = micStream;

    // 3. Wire the mic into the AudioContext + a ScriptProcessor for PCM
    //    capture. 4096-sample buffer at 16kHz = 256ms per callback.
    const source = audioCtx.createMediaStreamSource(micStream);
    const scriptNode = audioCtx.createScriptProcessor(4096, 1, 1);
    scriptNodeRef.current = scriptNode;
    scriptNode.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      micBufferRef.current.push(float32ToInt16(new Float32Array(input)));
    };
    source.connect(scriptNode);
    // ScriptProcessor needs a destination to fire — connect to a muted
    // gain so we don't echo the mic back out the speakers.
    const mutedGain = audioCtx.createGain();
    mutedGain.gain.value = 0;
    scriptNode.connect(mutedGain);
    mutedGain.connect(audioCtx.destination);

    // 4. Start the bidi session.
    log("POST /api/gemini/connect {start}…");
    const startRes = await fetch("/api/gemini/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start" }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!startRes.ok) {
      const text = await startRes.text().catch(() => "");
      throw new Error(`Gemini start ${startRes.status}: ${text.slice(0, 300)}`);
    }
    const startData = (await startRes.json()) as {
      ok?: boolean;
      gsessionid?: string;
      sid?: string;
      rid?: string;
      audioChunks?: string[];
      textChunks?: string[];
      error?: string;
    };
    if (!startData.ok || !startData.gsessionid || !startData.rid) {
      throw new Error(startData.error ?? "Gemini start returned no session.");
    }
    geminiSessionRef.current = {
      gsessionid: startData.gsessionid,
      sid: startData.sid ?? "",
      rid: startData.rid,
    };
    log(`Gemini session started (rid=${startData.rid}).`);

    // Play any audio returned in the start response (a greeting).
    if (startData.audioChunks && startData.audioChunks.length > 0) {
      for (const chunk of startData.audioChunks) playPcmChunkRef.current?.(chunk);
    }
    if (startData.textChunks && startData.textChunks.length > 0) {
      log(`AI: ${startData.textChunks.join("")}`);
    }

    // 5. Set up the play-PCM helper (closure over audioCtx + nextStartTime).
    nextStartTimeRef.current = audioCtx.currentTime;
    playPcmChunkRef.current = (b64: string) => {
      const ctx = audioCtxRef.current;
      if (!ctx) return;
      const float32 = base64ToFloat32(b64);
      const buffer = ctx.createBuffer(1, float32.length, 16000);
      buffer.copyToChannel(float32, 0);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      // Schedule right after the previous chunk (or now if it lapsed).
      const startTime = Math.max(ctx.currentTime, nextStartTimeRef.current);
      src.start(startTime);
      nextStartTimeRef.current = startTime + buffer.duration;
    };

    // 6. Start the mic-flush loop — every 200ms, drain micBufferRef into
    //    a single base64 PCM and POST it to /api/gemini/connect {send}.
    sendTimerRef.current = setInterval(async () => {
      const session = geminiSessionRef.current;
      if (!session) return;
      const chunks = micBufferRef.current.splice(0, micBufferRef.current.length);
      if (chunks.length === 0) return; // nothing captured this window
      // Concat all Int16 chunks into one.
      let total = 0;
      for (const c of chunks) total += c.length;
      const merged = new Int16Array(total);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.length;
      }
      const b64 = int16ToBase64(merged);
      try {
        await fetch("/api/gemini/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "send",
            gsessionid: session.gsessionid,
            sid: session.sid,
            rid: session.rid,
            audio: b64,
          }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        // Network blips are OK — we'll try again next tick.
        console.warn("[gemini] send failed:", (err as Error).message);
      }
    }, 200);

    // 7. Start the receive long-poll loop. Each call waits up to ~25s
    //    for an AI audio chunk; the AbortController lets us stop cleanly
    //    on disconnect.
    const pollOnce = async () => {
      const session = geminiSessionRef.current;
      if (!session) return;
      const ctrl = new AbortController();
      pollControllerRef.current = ctrl;
      try {
        const res = await fetch("/api/gemini/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "receive",
            gsessionid: session.gsessionid,
            sid: session.sid,
            rid: session.rid,
          }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          log(`Gemini receive ${res.status}: ${text.slice(0, 200)}`);
          return;
        }
        const data = (await res.json()) as {
          ok?: boolean;
          audioChunks?: string[];
          textChunks?: string[];
          done?: boolean;
          error?: string;
        };
        if (data.audioChunks) {
          for (const chunk of data.audioChunks) playPcmChunkRef.current?.(chunk);
        }
        if (data.textChunks && data.textChunks.length > 0) {
          log(`AI: ${data.textChunks.join("")}`);
        }
        if (data.done) log("[gemini] turn complete.");
      } catch (err) {
        if ((err as Error).name === "AbortError") return; // expected on teardown
        log(`Gemini receive error: ${(err as Error).message}`);
      } finally {
        if (pollControllerRef.current === ctrl) pollControllerRef.current = null;
      }
      // Loop if we still have a session.
      if (geminiSessionRef.current && !ctrl.signal.aborted) {
        // Use setTimeout so React state updates + cleanup can interleave.
        setTimeout(pollOnce, 100);
      }
    };
    void pollOnce();

    setStatus("connected");
    log("Connected. Speak when ready.");
  }, [base64ToFloat32, float32ToInt16, int16ToBase64, log]);

  // -------------------------------------------------------------------------
  // Inworld path — direct browser WebSocket to api.inworld.ai.
  // -------------------------------------------------------------------------

  /** Connect via Inworld's realtime WebSocket. This is the simplest of the
   * 4 providers — there's NO backend audio proxy: the browser opens a
   * WebSocket directly to `wss://api.inworld.ai/api/v1/realtime/session`
   * with the Inworld API token as the WebSocket subprotocol. The token is
   * fetched from `/api/inworld/token` (which reads INWORLD_TOKEN from the
   * env, falling back to the vault).
   *
   * PROTOCOL (confirmed by first-run testing — Task 57):
   * Inworld's realtime session endpoint speaks the **OpenAI Realtime API
   * event protocol**, NOT a custom `{type:"audio",data,...}` shape. The
   * telltale is the error response shape
   * `{"type":"invalid_request_error","code":"unknown_event_type",...,
   *  "event_id":null}` (OpenAI-style) returned when the client sends an
   * unknown event type. So:
   *
   *   - Client→server audio: `input_audio_buffer.append` with an `audio`
   *     field (base64 PCM16, 16kHz mono). NOT `{type:"audio",data,...}`.
   *   - Server→client AI audio: `response.audio.delta` with a `delta`
   *     field (base64 PCM16). Play via the AudioContext.
   *   - Server→client AI transcript: `response.audio_transcript.delta` /
   *     `.done` (streaming text of the AI's spoken reply).
   *   - Server→client user transcript: `conversation.item.input_audio_
   *     transcription.completed` (server's transcription of the user mic).
   *   - Server-side VAD: `input_audio_buffer.speech_started` / `.stopped`
   *     / `.committed` — the server auto-commits + triggers a response
   *     when it detects end-of-speech (default `turn_detection: server_vad`).
   *   - Session lifecycle: `session.created` / `session.updated`.
   *   - Errors: `{type:"error", error:{type,code,message,...}}`.
   *
   * Flow:
   *   1. GET /api/inworld/token → { token } (basic_<base64>).
   *   2. Open WebSocket to our PROXY (NOT directly to api.inworld.ai):
   *      `wss://<page-host>/?protocol=realtime&key=browser-session-<ts>
   *      &XTransformPort=3003`, subprotocol = [token]. The Caddy gateway
   *      sees `XTransformPort=3003` + forwards to our `mini-services/
   *      inworld-proxy` (port 3003). The proxy opens the upstream
   *      WebSocket to `wss://api.inworld.ai/api/v1/realtime/session` with
   *      `Origin: https://platform.inworld.ai` set server-side (the
   *      browser can't override Origin — it's a forbidden header — so
   *      we proxy through a server-side helper). On open, the server
   *      sends `session.created` with the default config
   *      (modalities:["text","audio"], turn_detection:server_vad,
   *      input_audio_format:"pcm16"). No `session.update` is needed.
   *   3. AudioContext at **24 kHz** (OpenAI Realtime API default for
   *      `pcm16` audio — NOT 16 kHz, which was the previous setting and
   *      made the AI voice play 1.5x slower). + getUserMedia +
   *      ScriptProcessor for PCM capture.
   *   4. setInterval(200ms) flushes mic PCM16 → base64 → JSON
   *      `{type:"input_audio_buffer.append", audio:<b64>}` → ws.send.
   *   5. ws.onmessage: text frames are JSON (handled by `handleInworldMsg`
   *      which dispatches on OpenAI Realtime API event names); binary
   *      frames are raw PCM16 → played via the AudioContext (kept as a
   *      fallback in case Inworld sends any binary audio frames).
   *   6. Playback uses GAPLESS scheduling (matches the Inworld playground's
   *      `scheduleChunk` — confirmed by reading the playground's minified
   *      JS bundle in Task 61): `Math.max(ctx.currentTime, nextStartTime)`
   *      with NO jitter cap. Active sources are tracked in
   *      `activeSourcesRef` for barge-in (stop all AI audio when the user
   *      starts speaking → `input_audio_buffer.speech_started`).
   *
   * NOTE: Inworld checks the `Origin` header. The deployed Vercel origin
   * (`https://ace-studio-*.vercel.app`) is NOT `https://platform.inworld.ai`,
   * so Inworld may reject the upgrade with 4xx. If that happens we need a
   * WebSocket proxy mini-service; we try direct first per the task spec.
   */
  const connectInworld = useCallback(async () => {
    // 1. Fetch the Inworld token from the backend route (env var OR vault).
    log("GET /api/inworld/token…");
    const tokenRes = await fetch("/api/inworld/token", {
      signal: AbortSignal.timeout(15_000),
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text().catch(() => "");
      throw new Error(`Inworld token fetch ${tokenRes.status}: ${text.slice(0, 300)}`);
    }
    const tokenData = (await tokenRes.json()) as {
      ok?: boolean;
      token?: string;
      source?: string;
      error?: string;
    };
    if (!tokenData.ok || !tokenData.token) {
      throw new Error(tokenData.error ?? "Inworld token route returned no token.");
    }
    const token = tokenData.token;
    log(`Inworld token acquired (source: ${tokenData.source ?? "?"}).`);

    // 2. Open the WebSocket with the token as the subprotocol. The
    //    `key` query param is just a session identifier (browser-session-
    //    <timestamp>), not the auth token — the auth lives in the
    //    `Sec-WebSocket-Protocol` header (which the browser sets from
    //    the second argument to `new WebSocket`).
    //
    //    PROXY PATH (Task 63 — Origin fix):
    //    Inworld rejects WebSocket upgrades from non-platform.inworld.ai
    //    origins. The browser can't override the `Origin` header (it's a
    //    forbidden header), so we route the WebSocket through our own
    //    proxy mini-service (port 3003, `mini-services/inworld-proxy`),
    //    which sets `Origin: https://platform.inworld.ai` server-side
    //    before forwarding to `wss://api.inworld.ai/api/v1/realtime/session`.
    //    The browser connects to `wss://<page-host>/?XTransformPort=3003`
    //    — the Caddy gateway sees the `XTransformPort` query + forwards
    //    to localhost:3003 on the VPS. The proxy opens the upstream
    //    WebSocket to Inworld with the spoofed Origin + forwards the
    //    `Sec-WebSocket-Protocol: basic_<base64>` subprotocol (the token).
    //
    //    The `protocol=realtime&key=browser-session-<ts>` query params
    //    are passed through to the proxy URL → the proxy forwards them
    //    to Inworld's `/api/v1/realtime/session` endpoint (the `protocol`
    //    param tells Inworld to use the realtime API; the `key` is just
    //    a session id for logging).
    const wsHost = window.location.host; // e.g. ace-studio-orcin.vercel.app OR sandbox-host
    const wsUrl =
      `wss://${wsHost}/?protocol=realtime&key=browser-session-${Date.now()}&XTransformPort=3003`;
    log(`Opening Inworld WebSocket via proxy (XTransformPort=3003)…`);
    const ws = new WebSocket(wsUrl, [token]);
    inworldWsRef.current = ws;

    // Wait for open (or close/error within 15s).
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Inworld WebSocket did not open within 15s."));
      }, 15_000);
      const onOpen = () => {
        clearTimeout(timeout);
        cleanup();
        resolve();
      };
      const onError = () => {
        clearTimeout(timeout);
        cleanup();
        reject(new Error("Inworld WebSocket error during open (Origin may be rejected)."));
      };
      const onClose = (e: CloseEvent) => {
        clearTimeout(timeout);
        cleanup();
        reject(new Error(`Inworld WebSocket closed during open (code ${e.code}${e.reason ? `, ${e.reason.slice(0, 120)}` : ""}).`));
      };
      const cleanup = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        ws.removeEventListener("close", onClose);
      };
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
      ws.addEventListener("close", onClose);
    });
    log("Inworld WebSocket open.");

    // 3. Create an AudioContext at 24 kHz + get the user's mic. The OpenAI
    //    Realtime API (which Inworld speaks — confirmed in Task 57) uses
    //    PCM16 @ **24 kHz** for BOTH input and output by default
    //    (`input_audio_format:"pcm16"` + `output_audio_format:"pcm16"`
    //    → 24000 Hz). The previous 16 kHz context was playing 24 kHz
    //    chunks at 16 kHz speed → 1.5x slower = "voix grave et lente"
    //    (Task 59 user report). 24 kHz matches what the server sends +
    //    what it expects back.
    //
    //    Some older browsers may refuse a non-default sample rate; we
    //    try 24 kHz first and fall back to the default. If the fallback
    //    fires, the mic capture rate won't match the server's expected
    //    24 kHz (the server would hear the mic at the wrong speed), but
    //    playback still works because Web Audio resamples the 24 kHz
    //    buffer to the context rate automatically on BufferSource.start.
    const AudioCtor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    let audioCtx: AudioContext;
    try {
      audioCtx = new AudioCtor({ sampleRate: 24000 });
    } catch {
      // Browser rejected 24 kHz — fall back to default.
      audioCtx = new AudioCtor();
    }
    // Browsers can suspend the AudioContext until a user gesture (Chrome
    // autoplay policy). The "Connect" button click counts as a gesture,
    // but some browsers still start the context in "suspended" state —
    // resume explicitly so playback works.
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => { /* ignore */ });
    }
    audioCtxRef.current = audioCtx;
    // Log the actual context sample rate so the user can verify the 24 kHz
    // request was honoured (some browsers silently fall back to 48 kHz —
    // playback still works via Web Audio resampling, but the mic capture
    // would be at the wrong rate in that case).
    log(`AudioContext @ ${audioCtx.sampleRate} Hz (requested 24000).`);

    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    micStreamRef.current = micStream;
    // Reuse the shared localStreamRef so the existing mute toggle works.
    localStreamRef.current = micStream;

    // 4. Wire mic → ScriptProcessor → PCM16 buffer (same as Gemini).
    const source = audioCtx.createMediaStreamSource(micStream);
    const scriptNode = audioCtx.createScriptProcessor(4096, 1, 1);
    scriptNodeRef.current = scriptNode;
    scriptNode.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      micBufferRef.current.push(float32ToInt16(new Float32Array(input)));
    };
    source.connect(scriptNode);
    // ScriptProcessor needs a destination to fire — connect to a muted
    // gain so we don't echo the mic back out the speakers.
    const mutedGain = audioCtx.createGain();
    mutedGain.gain.value = 0;
    scriptNode.connect(mutedGain);
    mutedGain.connect(audioCtx.destination);

    // 5. Set up the play-PCM helper (closure over audioCtx + nextStartTime).
    //    Matches the Inworld playground's `scheduleChunk` implementation
    //    (extracted from the playground's minified JS bundle — Task 61):
    //      const A = Math.max(l.current, h.currentTime);  // gapless, NO cap
    //      C.start(A);
    //      l.current = A + m.duration;
    //      o.current.push(C);  // track for barge-in
    //
    //    KEY FIX (Task 61): the previous Task 60 jitter buffer cap
    //    (`Math.min(..., ctx.currentTime + 0.3)`) caused chunks to OVERLAP
    //    when the queue grew past 300ms ahead — multiple chunks got
    //    scheduled at the same `ctx.currentTime + 0.3` timestamp, playing
    //    simultaneously → garbled "parle en plusieurs audio". The playground
    //    uses pure gapless scheduling with NO cap. At 24 kHz, gapless IS
    //    real-time because the sample rate matches the server's output
    //    format (the lag the user reported in Task 59 was caused by the
    //    16 kHz mismatch, which the 24 kHz fix in Task 60 already solved).
    //
    //    We also track active sources in `activeSourcesRef` so the
    //    `clearAudioQueue` helper can stop all playback on barge-in (when
    //    the user starts speaking → `input_audio_buffer.speech_started` →
    //    stop the AI's current audio so the user can interrupt).
    nextStartTimeRef.current = audioCtx.currentTime;
    activeSourcesRef.current = new Set();
    playPcmChunkRef.current = (b64: string) => {
      const ctx = audioCtxRef.current;
      if (!ctx) return;
      const float32 = base64ToFloat32(b64);
      // 24 kHz source rate (OpenAI Realtime API default for `pcm16`).
      // Web Audio resamples this to the context rate on playback
      // automatically, so even if the context fell back to 48 kHz
      // (Safari/etc.), the audio plays at the correct pitch.
      const buffer = ctx.createBuffer(1, float32.length, 24000);
      buffer.copyToChannel(float32, 0);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      // Gapless scheduling: play right after the previous chunk, or
      // "now" if the queue has lapsed. NO jitter cap (matches the
      // Inworld playground — at 24 kHz, gapless IS real-time).
      const startTime = Math.max(ctx.currentTime, nextStartTimeRef.current);
      src.start(startTime);
      nextStartTimeRef.current = startTime + buffer.duration;
      // Track for barge-in + auto-remove on end.
      activeSourcesRef.current.add(src);
      src.onended = () => {
        activeSourcesRef.current.delete(src);
      };
    };

    // 6. Handle incoming messages. Inworld's realtime protocol sends both
    //    JSON text frames (transcripts, state updates, errors) and binary
    //    frames (raw PCM16 audio chunks). We branch on the frame type.
    ws.onmessage = (e) => {
      if (typeof e.data === "string") {
        // JSON text frame — try to parse and dispatch on `type`.
        try {
          const msg = JSON.parse(e.data) as Record<string, unknown>;
          handleInworldMsg(msg);
        } catch {
          // Not JSON — log the raw text.
          log(`[inworld] ${e.data.slice(0, 200)}`);
        }
      } else if (e.data instanceof Blob) {
        // Binary frame as Blob — read it and play as PCM16.
        e.data
          .arrayBuffer()
          .then((buf) => {
            const bytes = new Uint8Array(buf);
            let bin = "";
            for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            playPcmChunkRef.current?.(btoa(bin));
          })
          .catch(() => { /* ignore */ });
      } else if (e.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(e.data);
        let bin = "";
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        playPcmChunkRef.current?.(btoa(bin));
      }
    };

    /** Dispatch an incoming Inworld JSON message. Inworld's realtime
     * session endpoint (`wss://api.inworld.ai/api/v1/realtime/session`)
     * speaks a variant of the OpenAI Realtime API event protocol —
     * confirmed by the error response shape `{"type":"invalid_request_error",
     * "code":"unknown_event_type",...,"event_id":null}` (OpenAI-style)
     * returned when we sent a `{type:"audio"}` event, AND by the live
     * event stream captured on first run (Task 58):
     *
     * Inworld's event names use the `output_` infix — e.g. it sends
     * `response.output_audio.delta` (NOT the standard OpenAI name
     * `response.audio.delta`), and `response.output_audio_transcript.delta`
     * (NOT `response.audio_transcript.delta`). To support BOTH Inworld's
     * names AND the standard OpenAI names (for forward-compat), each
     * case below accepts both names via fallthrough.
     *
     * Confirmed Inworld server→client events (from the user's first live run):
     *   - `session.created` / `session.updated` — session lifecycle.
     *   - `input_audio_buffer.speech_started` / `.speech_stopped` — VAD.
     *   - `input_audio_buffer.turn_suggestion` — Inworld-specific: the
     *     server suggests a turn boundary was detected (we treat as no-op
     *     since server_vad auto-commits).
     *   - `conversation.item.added` / `.done` — a conversation item (user
     *     input OR AI output) was added / finalised.
     *   - `conversation.item.input_audio_transcription.completed` / `.delta`
     *     — streaming + final transcription of the user's mic audio.
     *   - `response.output_item.added` / `.done` — AI response item lifecycle.
     *   - `response.content_part.added` / `.done` — content part lifecycle.
     *   - `response.output_audio.delta` (77 per response) — base64 PCM16
     *     chunks of the AI's spoken reply. PLAY these via the AudioContext.
     *   - `response.output_audio.done` — end of AI audio stream.
     *   - `response.output_audio_transcript.delta` (31 per response) —
     *     streaming text transcript of the AI's spoken reply. APPEND to
     *     the last AI: log line (not one line per delta — that would spam).
     *   - `response.output_audio_transcript.done` — final AI transcript.
     *   - `response.output_text.done` — final text-only reply.
     *   - `error` — `{type:"error", error:{type,code,message,...}}`.
     *
     * We ALSO keep the legacy generic handlers (audio / transcript /
     * text / user / state / error / default) as fallbacks in case
     * Inworld deviates for any event. */
    const handleInworldMsg = (msg: Record<string, unknown>) => {
      if (!msg || typeof msg !== "object") return;
      const type =
        (msg.type as string) ??
        (msg.event as string) ??
        (msg.kind as string) ??
        "message";
      // Helper: append an AI transcript delta to the last AI: log line
      // (or create a new one if the last line isn't an AI: line). This
      // avoids producing 31 separate "AI: <chunk>" log lines per AI
      // response — instead we get one streaming AI: line that grows.
      const appendAiDelta = (delta: string) => {
        if (!delta) return;
        setTranscript((t) => {
          const next = [...t];
          const last = next[next.length - 1] ?? "";
          // Robust against second boundaries: just check the line is an
          // AI: line, regardless of the timestamp prefix.
          if (last.includes("] AI:")) {
            next[next.length - 1] = last + delta;
          } else {
            next.push(`[${new Date().toLocaleTimeString()}] AI: ${delta}`);
          }
          return next.slice(-200);
        });
      };
      switch (type) {
        // --- AI audio output (THE KEY AUDIO FIX — Task 58) ---
        // Inworld sends `response.output_audio.delta` (with the `output_`
        // infix), NOT the standard OpenAI `response.audio.delta`. Both
        // names are accepted here via case fallthrough so audio plays.
        case "response.output_audio.delta":
        case "response.audio.delta": {
          // `delta` is a base64 PCM16 chunk of the AI's spoken reply.
          const b64 = (msg.delta as string) ?? (msg.audio as string) ?? (msg.data as string);
          if (typeof b64 === "string" && b64.length > 0) playPcmChunkRef.current?.(b64);
          // SILENT handler — do NOT log (77 chunks/sec would spam the
          // transcript). The user hears the audio; the transcript shows
          // the AI text via the transcript.delta handler below.
          break;
        }
        case "response.output_audio.done":
        case "response.audio.done": {
          // Final audio chunk for the response — already streamed via
          // .delta events; nothing to do here.
          break;
        }
        // --- AI transcript (streaming text of the spoken reply) ---
        // Inworld sends `response.output_audio_transcript.delta` (with
        // the `output_` infix). Use appendAiDelta so we get ONE growing
        // AI: line per response, not 31 separate "AI: <chunk>" lines.
        case "response.output_audio_transcript.delta":
        case "response.audio_transcript.delta": {
          appendAiDelta((msg.delta as string) ?? "");
          break;
        }
        case "response.output_audio_transcript.done":
        case "response.audio_transcript.done": {
          // The .done event carries the FINAL transcript. If we already
          // appended deltas above, this is redundant — only log if no AI
          // line was started (e.g. the deltas were empty / not received).
          const t = (msg.transcript as string) ?? (msg.text as string) ?? "";
          if (t) {
            setTranscript((prev) => {
              const last = prev[prev.length - 1] ?? "";
              if (last.includes("] AI:")) {
                // Already have an AI line from the deltas — skip.
                return prev;
              }
              return [...prev.slice(-199), `[${new Date().toLocaleTimeString()}] AI: ${t}`];
            });
          }
          break;
        }
        case "response.output_text.delta":
        case "response.text.delta": {
          appendAiDelta((msg.delta as string) ?? "");
          break;
        }
        case "response.output_text.done":
        case "response.text.done": {
          const t = (msg.text as string) ?? "";
          if (t) {
            setTranscript((prev) => {
              const last = prev[prev.length - 1] ?? "";
              if (last.includes("] AI:")) return prev;
              return [...prev.slice(-199), `[${new Date().toLocaleTimeString()}] AI: ${t}`];
            });
          }
          break;
        }
        // --- User mic transcript (server-side transcription) ---
        // Both `.delta` and `.completed` UPDATE the same "You:" line via
        // `upsertUserLine` (collapses all deltas + completed events for
        // one speech into ONE growing line — fixes the multiple-You:
        // bug the user reported in Task 62). `inUserSpeechRef` is reset
        // on `speech_started` so the next speech creates a fresh line.
        case "conversation.item.input_audio_transcription.completed": {
          const t = (msg.transcript as string) ?? (msg.text as string) ?? "";
          upsertUserLine(t);
          break;
        }
        case "conversation.item.input_audio_transcription.delta": {
          const d = (msg.delta as string) ?? "";
          upsertUserLine(d);
          break;
        }
        // --- Server-side VAD (voice activity detection) state ---
        case "input_audio_buffer.speech_started": {
          // The server detected the start of user speech → BARGE-IN:
          // stop the AI's current audio playback so the user can
          // interrupt. Matches the Inworld playground's `clearQueue`
          // behavior (stops all active AudioBufferSourceNodes + resets
          // nextStartTime so the next AI response starts fresh).
          clearAudioQueue();
          // Reset the user speech tracking so the next transcription
          // creates a FRESH "You:" line (don't append to the previous
          // speech's line).
          inUserSpeechRef.current = false;
          log("[inworld] speech started");
          break;
        }
        case "input_audio_buffer.speech_stopped": {
          log("[inworld] speech stopped");
          break;
        }
        case "input_audio_buffer.committed": {
          // The audio buffer was committed (either by VAD or by an
          // explicit commit). A `response.created` will follow.
          break;
        }
        case "input_audio_buffer.turn_suggestion": {
          // Inworld-specific: the server suggests a turn boundary was
          // detected (trailing silence reached the threshold). The
          // server_vad turn detection already auto-commits, so we don't
          // need to send `input_audio_buffer.commit` ourselves. No-op.
          break;
        }
        // --- Conversation item lifecycle (Inworld sends these for both
        //     user input items AND AI output items — silent no-ops to
        //     keep the transcript clean) ---
        case "conversation.item.added":
        case "conversation.item.done": {
          // The user's input item OR the AI's output item was added /
          // finalised. The actual content (user transcript / AI text) is
          // delivered via the dedicated transcript events above.
          break;
        }
        // --- Response item / content part lifecycle (silent no-ops) ---
        case "session.created":
        case "session.updated":
        case "response.created":
        case "response.done":
        case "response.cancelled":
        case "response.output_item.added":
        case "response.output_item.done":
        case "response.content_part.added":
        case "response.content_part.done":
        case "rate_limits.updated": {
          // Response / output-item / content-part lifecycle. The actual
          // audio + transcript data arrives via the .delta handlers
          // above; these lifecycle events are noisy and carry no user
          // -visible payload. No-op.
          break;
        }
        // --- Errors (OpenAI shape: {type:"error", error:{...}}) ---
        case "error": {
          const errObj = msg.error as Record<string, unknown> | undefined;
          const errMsg =
            (typeof errObj === "object" && errObj
              ? ((errObj.message as string) ??
                (errObj.code as string) ??
                (errObj.type as string))
              : undefined) ??
            (msg.message as string) ??
            JSON.stringify(msg);
          const errStr = typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg);
          log(`[inworld] error: ${errStr}`);
          break;
        }
        // --- Legacy / generic fallbacks (kept in case Inworld deviates
        //     for any event) ---
        case "audio":
        case "audio_chunk":
        case "audioChunk": {
          const b64 =
            (msg.data as string) ??
            ((msg.audio as Record<string, unknown> | undefined)?.data as string) ??
            (msg.payload as string) ??
            (msg.delta as string);
          if (typeof b64 === "string" && b64.length > 0) playPcmChunkRef.current?.(b64);
          break;
        }
        case "transcript":
        case "text":
        case "utterance":
        case "answer": {
          const text =
            (msg.text as string) ??
            (msg.transcript as string) ??
            (msg.data as string) ??
            (msg.content as string) ??
            (msg.delta as string);
          if (typeof text === "string" && text.length > 0) log(`AI: ${text}`);
          break;
        }
        case "user_transcript":
        case "userText":
        case "input_transcript":
        case "user": {
          const text =
            (msg.text as string) ??
            (msg.transcript as string) ??
            (msg.data as string) ??
            (msg.delta as string);
          if (typeof text === "string" && text.length > 0) log(`You: ${text}`);
          break;
        }
        case "state":
        case "status":
        case "ready": {
          log(`[inworld] state: ${JSON.stringify(msg).slice(0, 600)}`);
          break;
        }
        default: {
          // Unknown type — log a compact summary so the user can see
          // what Inworld is sending (and we can refine the handler).
          log(`[inworld] ${type}: ${JSON.stringify(msg).slice(0, 600)}`);
        }
      }
    };

    ws.onerror = () => {
      log("Inworld WebSocket error.");
    };
    ws.onclose = (e) => {
      log(`Inworld WebSocket closed (code ${e.code}${e.reason ? `, ${e.reason.slice(0, 100)}` : ""}).`);
      inworldWsRef.current = null;
      // If the socket closed on its own (not via teardown), reflect it in
      // the UI so the user knows they need to reconnect.
      if (status !== "idle" && providerRef.current === "inworld") {
        setStatus("idle");
        // Clean up the audio path but leave the React state otherwise
        // intact (transcript stays so the user can read what happened).
        if (sendTimerRef.current) {
          clearInterval(sendTimerRef.current);
          sendTimerRef.current = null;
        }
        if (scriptNodeRef.current) {
          try { scriptNodeRef.current.disconnect(); } catch { /* ignore */ }
          scriptNodeRef.current = null;
        }
        if (micStreamRef.current) {
          micStreamRef.current.getTracks().forEach((t) => t.stop());
          micStreamRef.current = null;
        }
        if (localStreamRef.current) {
          localStreamRef.current = null;
        }
        if (audioCtxRef.current) {
          try { audioCtxRef.current.close(); } catch { /* ignore */ }
          audioCtxRef.current = null;
        }
        micBufferRef.current = [];
      }
    };

    // 7. Start the mic-flush loop — every 200ms, drain micBufferRef into
    //    a single base64 PCM and send it as an OpenAI-Realtime-API-style
    //    `input_audio_buffer.append` event. Inworld's realtime session
    //    endpoint (`wss://api.inworld.ai/api/v1/realtime/session`) speaks
    //    the OpenAI Realtime API event protocol (confirmed by the error
    //    response shape `{"type":"invalid_request_error","code":
    //    "unknown_event_type",...,"event_id":null}`), so the client→server
    //    audio event is `input_audio_buffer.append` with an `audio` field
    //    (base64 PCM16) — NOT a custom `{type:"audio",data,...}` shape.
    sendTimerRef.current = setInterval(() => {
      const sock = inworldWsRef.current;
      if (!sock || sock.readyState !== WebSocket.OPEN) return;
      const chunks = micBufferRef.current.splice(0, micBufferRef.current.length);
      if (chunks.length === 0) return;
      let total = 0;
      for (const c of chunks) total += c.length;
      const merged = new Int16Array(total);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.length;
      }
      const b64 = int16ToBase64(merged);
      try {
        // OpenAI Realtime API: `input_audio_buffer.append` with an `audio`
        // field containing base64-encoded PCM16. The session's input
        // audio format is `pcm16` (16kHz mono) by default for Inworld.
        sock.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: b64,
          }),
        );
      } catch (err) {
        console.warn("[inworld] send failed:", (err as Error).message);
      }
    }, 200);

    setStatus("connected");
    log("Connected. Speak when ready.");
  }, [base64ToFloat32, float32ToInt16, int16ToBase64, log, status]);

  // -------------------------------------------------------------------------
  // Qwen path — Aliyun Bailian RTC (NOT standard WebRTC).
  // -------------------------------------------------------------------------

  /** Connect via Qwen Voice. Unlike ChatGPT/Perplexity (standard WebRTC
   *  SDP exchange via RTCPeerConnection), Qwen uses Aliyun Bailian RTC —
   *  a proprietary WebRTC SDK (`aliyun-rtc-sdk`, 242 KB) that handles the
   *  WebRTC handshake internally with its own protocol (NOT standard SDP
   *  offer/answer). The flow is:
   *    1. GET /api/qwen/token → health-check (token configured? expired?).
   *    2. POST /api/qwen/token → { rtc_token, rtc_channel, rtc_app_id,
   *       rtc_gslb, rtc_user_id_client, rtc_user_id_voicechat, ... }
   *       (Aliyun RTC channel credentials from chat.qwen.ai).
   *    3. Dynamically `import("aliyun-rtc-sdk")` — the SDK uses
   *       browser-only APIs (navigator.mediaDevices, RTCPeerConnection)
   *       so it MUST be dynamically imported (Next.js SSR would fail if
   *       imported at module top-level). The dynamic import also keeps
   *       the 242 KB SDK out of the main bundle — it only loads when the
   *       user clicks Connect with Qwen selected.
   *    4. AliRtcEngine.createInstance() → joinChannel(authInfo) — joins
   *       the Aliyun RTC channel using the credentials from step 2.
   *    5. publishLocalAudioStream(true) — the SDK handles getUserMedia
   *       internally; we don't need to call getUserMedia ourselves.
   *    6. subscribeAllRemoteAudioStreams(true) + on
   *       `remoteTrackAvailableNotify` for the AI user
   *       (rtc_user_id_voicechat) → getAudioTrack + play via a hidden
   *       <audio> element (reuses audioElRef).
   *    7. on `dataChannelMsg` — decode the ArrayBuffer as JSON + dispatch
   *       on the OpenAI Realtime API event name (session.created,
   *       input_audio_buffer.*, conversation.item.input_audio_transcription.*,
   *       response.output_audio_transcript.*, error, etc.).
   *    8. On `session.created`, send a `session.update` event to the
   *       server via sendDataChannelMessage (voice: Tina, server_vad
   *       800ms silence, pcm16 audio, ASR model qwen3-asr-flash-realtime).
   *
   *  Teardown is handled by the shared `teardown` function, which calls
   *  `engine.publishLocalAudioStream(false)`, `engine.leaveChannel()`,
   *  and `engine.destroy()` on `qwenEngineRef.current`.
   *
   *  The other 4 providers (ChatGPT, Perplexity, Gemini, Inworld) are
   *  unaffected — only the `provider === "qwen"` branch in `connect`
   *  dispatches here. */
  const connectQwen = useCallback(async () => {
    // 1. Health-check the token (GET /api/qwen/token). The route returns
    //    { ok, configured, source, tokenMasked, exp, expired }. We bail
    //    out with a clear actionable message BEFORE attempting the SDK
    //    load (saves the 242 KB download + the Aliyun RTC handshake if
    //    the token is missing or expired).
    log("Checking Qwen token status…");
    const healthRes = await fetch("/api/qwen/token", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!healthRes.ok) {
      throw new Error(`Qwen health-check ${healthRes.status}`);
    }
    const health = (await healthRes.json()) as {
      ok?: boolean;
      configured?: boolean;
      source?: string | null;
      tokenMasked?: string | null;
      exp?: number | null;
      expired?: boolean;
    };
    if (!health.configured) {
      throw new Error(
        "QWEN_ACCESS_TOKEN is not set. Set it via: " +
        "curl -X PUT /api/qwen/token -H 'Content-Type: application/json' " +
        "-d '{\"token\":\"<JWT from chat.qwen.ai>\"}'",
      );
    }
    if (health.expired) {
      throw new Error(
        `Qwen token is EXPIRED${health.exp ? ` (expired ${new Date(health.exp * 1000).toLocaleTimeString()})` : ""}. ` +
        "Get a fresh JWT from chat.qwen.ai → DevTools → Network → Authorization: Bearer, " +
        "then: curl -X PUT /api/qwen/token -H 'Content-Type: application/json' -d '{\"token\":\"<new JWT>\"}'",
      );
    }
    log(
      `Qwen token OK (source: ${health.source ?? "?"}, masked: ${health.tokenMasked ?? "?"}${health.exp ? `, expires in ${Math.round((health.exp - Date.now() / 1000) / 60)} min` : ""}).`,
    );

    // 2. Fetch the Aliyun RTC credentials (POST /api/qwen/token). The
    //    backend requires the SDP body to start with `v=0` (its
    //    validation check), but the SDP content is NOT actually used —
    //    chat.qwen.ai just creates a new RTC channel + returns the
    //    credentials regardless of the SDP. The Aliyun RTC SDK handles
    //    the WebRTC handshake internally. We send a minimal valid SDP
    //    to pass the backend check.
    log("Fetching Aliyun RTC credentials…");
    const fakeSdp =
      "v=0\r\n" +
      "o=- 0 0 IN IP4 0.0.0.0\r\n" +
      "s=-\r\n" +
      "t=0 0\r\n" +
      "m=audio 9 UDP/TLS/RTP/SAVPF 0\r\n" +
      "c=IN IP4 0.0.0.0\r\n" +
      "a=rtpmap:0 PCMU/8000\r\n";
    const rtcRes = await fetch("/api/qwen/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sdp: fakeSdp }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!rtcRes.ok) {
      const text = await rtcRes.text().catch(() => "");
      throw new Error(`Qwen backend ${rtcRes.status}: ${text.slice(0, 300)}`);
    }
    const rtc = (await rtcRes.json()) as {
      ok?: boolean;
      rtc_token?: string;
      rtc_channel?: string;
      rtc_app_id?: string;
      rtc_gslb?: string;
      rtc_user_id_client?: string;
      rtc_user_id_voicechat?: string;
      // CRITICAL — timestamp + nonce are cryptographically bound to the
      // token. Must be passed through from Qwen's response (not Date.now()).
      rtc_timestamp?: number;
      rtc_nonce?: string;
      chat_id?: string;
      times_left?: number | null;
      audio_timeout?: number | null;
      error?: string;
    };
    if (!rtc.ok || !rtc.rtc_token) {
      throw new Error(rtc.error ?? "Qwen backend returned no RTC credentials.");
    }
    log(
      `Aliyun RTC credentials acquired:` +
      ` channel=${rtc.rtc_channel ?? "?"}` +
      ` app_id=${rtc.rtc_app_id?.slice(0, 8) ?? "?"}…` +
      ` gslb=${rtc.rtc_gslb ?? "?"}` +
      (rtc.times_left != null ? ` (times_left: ${rtc.times_left})` : "") +
      (rtc.audio_timeout != null ? ` (timeout: ${rtc.audio_timeout}s)` : ""),
    );

    // 3. Dynamically import the Aliyun RTC SDK. The SDK uses browser-only
    //    APIs (navigator.mediaDevices, RTCPeerConnection, MediaStream,
    //    MediaStreamTrack, etc.) so it MUST be loaded via dynamic
    //    `import()` — importing it at module top-level would crash
    //    Next.js SSR (those APIs don't exist on the server). The dynamic
    //    import also keeps the 242 KB SDK out of the main page bundle —
    //    it loads as a separate chunk only when the user clicks Connect
    //    with Qwen selected.
    log("Loading Aliyun RTC SDK…");
    let AliRtcEngine: any;
    let AliRtcDataChannelMsg: any;
    try {
      const mod = await import("aliyun-rtc-sdk");
      AliRtcEngine = mod.default;
      AliRtcDataChannelMsg = mod.AliRtcDataChannelMsg;
    } catch (err) {
      throw new Error(
        `Failed to load Aliyun RTC SDK: ${(err as Error).message}. ` +
        "The `aliyun-rtc-sdk` package is installed; run `bun install` if missing.",
      );
    }
    if (!AliRtcEngine || typeof AliRtcEngine.createInstance !== "function") {
      throw new Error(
        "Aliyun RTC SDK loaded but `createInstance` is missing — the " +
        "package may be corrupted. Try `bun remove aliyun-rtc-sdk && bun add aliyun-rtc-sdk`.",
      );
    }

    // 4. Create the AliRtcEngine instance + store it in qwenEngineRef so
    //    `teardown` can destroy it on disconnect/unmount. Clearing the
    //    ref first would let a duplicate connect call tear down the old
    //    engine — but the connect dispatcher disables the Connect button
    //    while connected, so this is a no-op safety net.
    if (qwenEngineRef.current) {
      try { void qwenEngineRef.current.destroy().catch(() => { /* ignore */ }); } catch { /* ignore */ }
      qwenEngineRef.current = null;
    }
    const engine = AliRtcEngine.createInstance();
    qwenEngineRef.current = engine;

    // 5. Listen for connection status changes + errors. These are
    //    informational logs — the user can see the channel lifecycle.
    engine.on("connectionStatusChange", (status: number, reason: number) => {
      log(`[qwen] connection status: ${status} (reason: ${reason})`);
    });
    engine.on("occurError", (err: unknown, uid?: string) => {
      log(`[qwen] error: ${JSON.stringify(err).slice(0, 200)}${uid ? ` (uid: ${uid})` : ""}`);
    });
    engine.on("bye", (code: number) => {
      log(`[qwen] kicked from channel (code: ${code}).`);
    });

    // DEBUG: log ALL remote user events to understand the channel lifecycle.
    // The AI user (rtc_user_id_voicechat = "rtc-user-voiceChat") should join
    // the channel after we do — that's when the data channel opens.
    engine.on("remoteUserOnLineNotify", (uid: string) => {
      log(`[qwen] remote user online: ${uid}`);
    });
    engine.on("remoteUserOffLineNotify", (uid: string) => {
      log(`[qwen] remote user offline: ${uid}`);
    });
    engine.on("remoteUserSubscribedDataChannel", (uid: string) => {
      log(`[qwen] remote user subscribed data channel: ${uid}`);
    });
    engine.on("dataSubscribeStateChanged", (state: unknown) => {
      log(`[qwen] data subscribe state: ${JSON.stringify(state).slice(0, 200)}`);
    });
    engine.on("dataPublishStateChanged", (state: unknown) => {
      log(`[qwen] data publish state: ${JSON.stringify(state).slice(0, 200)}`);
    });
    // Also listen for the alternative event name (some SDK versions use
    // `remoteDataChannelMessage` instead of `dataChannelMsg`).
    engine.on("remoteDataChannelMessage", (uid: string, message: unknown) => {
      log(`[qwen] remoteDataChannelMessage from ${uid}: ${JSON.stringify(message).slice(0, 200)}`);
    });

    // 6. Join the Aliyun RTC channel. The auth info matches the
    //    AliRtcAuthInfo shape from the SDK types (channelId, userId,
    //    appId, nonce, timestamp, token). CRITICAL: the `timestamp` and
    //    `nonce` MUST be the values Qwen returned (the token is
    //    cryptographically bound to them). Using `Date.now()` →
    //    "Signaling connect failed" (the SDK rejects the token because
    //    the timestamp doesn't match the one the token was issued for).
    const authInfo = {
      channelId: rtc.rtc_channel ?? "",
      userId: rtc.rtc_user_id_client ?? "",
      appId: rtc.rtc_app_id ?? "",
      nonce: rtc.rtc_nonce ?? "",
      timestamp: rtc.rtc_timestamp ?? 0,
      token: rtc.rtc_token ?? "",
    };
    log(`Joining Aliyun RTC channel ${authInfo.channelId.slice(0, 24)} (timestamp: ${authInfo.timestamp})…`);
    try {
      await engine.joinChannel(authInfo, "rtc-user-client");
    } catch (err) {
      throw new Error(
        `Failed to join Aliyun RTC channel: ${(err as Error).message}. ` +
        "The token may be expired or the channel may be full.",
      );
    }
    log("Joined Aliyun RTC channel.");

    // 7. Publish local mic audio. The Aliyun RTC SDK handles
    //    getUserMedia internally — we don't need to call
    //    navigator.mediaDevices.getUserMedia ourselves. The SDK creates
    //    its own RTCPeerConnection + audio track + RTP encapsulation.
    //    Note: this means `localStreamRef.current` stays null for Qwen,
    //    so the existing `toggleMute` (which reads localStreamRef) is a
    //    no-op — see the toggleMute update below for the Qwen-specific
    //    path via `engine.muteLocalMic`.
    try {
      await engine.publishLocalAudioStream(true);
      log("[qwen] publishing local mic audio.");
    } catch (err) {
      throw new Error(
        `Failed to publish local mic audio: ${(err as Error).message}. ` +
        "Check that the mic permission is granted + no other app is using it.",
      );
    }

    // 8. Subscribe to all remote audio (the AI's voice). The AI user is
    //    `rtc_user_id_voicechat` — it joins the channel after we do.
    engine.subscribeAllRemoteAudioStreams(true);
    log("[qwen] subscribed to remote audio.");

    // 9. When the AI's audio track arrives, get it via getAudioTrack +
    //    play it via a hidden <audio> element. We listen for the
    //    `remoteTrackAvailableNotify` event — fires when a remote
    //    user's audio track becomes available. The audioTrack enum
    //    value 0 = no track, 1 = mic, 2 = dual stream — we check it's
    //    non-zero. Reuses the shared audioElRef so teardown can stop
    //    playback by setting srcObject = null.
    const voiceChatUid = rtc.rtc_user_id_voicechat ?? "";
    const playRemoteAudio = async () => {
      try {
        const track = await engine.getAudioTrack(voiceChatUid);
        if (!track) return;
        const remoteStream = new MediaStream([track]);
        if (!audioElRef.current) {
          audioElRef.current = new Audio();
          audioElRef.current.autoplay = true;
        }
        audioElRef.current.srcObject = remoteStream;
        await audioElRef.current.play().catch(() => {
          /* autoplay may need a user gesture — the Connect click counts */
        });
        log("[qwen] remote audio track playing.");
      } catch (err) {
        log(`[qwen] failed to play remote audio: ${(err as Error).message}`);
      }
    };
    engine.on("remoteTrackAvailableNotify", (uid: string, audioTrack: number, _videoTrack: number) => {
      if (uid === voiceChatUid && audioTrack !== 0) {
        void playRemoteAudio();
      }
    });

    // 10. Helper: append an AI transcript delta to the last AI: log
    //     line (or create a new one if the last line isn't an AI: line).
    //     Matches the Inworld `appendAiDelta` pattern — gives ONE
    //     growing AI: line per response instead of N separate lines.
    const appendAiDelta = (delta: string) => {
      if (!delta) return;
      setTranscript((t) => {
        const next = [...t];
        const last = next[next.length - 1] ?? "";
        if (last.includes("] AI:")) {
          next[next.length - 1] = last + delta;
        } else {
          next.push(`[${new Date().toLocaleTimeString()}] AI: ${delta}`);
        }
        return next.slice(-200);
      });
    };

    // 11. Listen for OpenAI Realtime API events on the data channel.
    //     The Qwen Omni server sends events as JSON-encoded strings
    //     over the Aliyun RTC data channel. We decode the ArrayBuffer
    //     + dispatch on the event `type`. The event names match the
    //     OpenAI Realtime API (with the `output_` infix used by Qwen
    //     + Inworld, e.g. `response.output_audio_transcript.delta`).
    engine.on("dataChannelMsg", (_uid: string, message: { data: ArrayBuffer }) => {
      try {
        const text = new TextDecoder().decode(message.data);
        const msg = JSON.parse(text) as { type?: string; [k: string]: unknown };
        const t = msg.type ?? "";
        switch (t) {
          // --- Session lifecycle ---
          case "session.created": {
            log("[qwen] session created");
            // Send a session.update event to configure the AI voice +
            // VAD. Matches the Qwen Omni SDK's `sendUpdate` behavior +
            // the Qwen web client's session config (Task 64
            // reverse-engineering). The server's session.created
            // already set sensible defaults, but we send an explicit
            // update to be safe + match the web client.
            const updateEvent = {
              type: "session.update",
              session: {
                modalities: ["text", "audio"],
                voice: "Tina",
                input_audio_format: "pcm16",
                output_audio_format: "pcm16",
                turn_detection: {
                  type: "server_vad",
                  threshold: 0.5,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 800,
                  create_response: true,
                  interrupt_response: true,
                },
                input_audio_transcription: { model: "qwen3-asr-flash-realtime" },
              },
            };
            try {
              const encoder = new TextEncoder();
              const data = encoder.encode(JSON.stringify(updateEvent));
              // Build the AliRtcDataChannelMsg instance if the class is
              // available; otherwise fall back to a plain object (the
              // SDK reads only `.data` + `.type` at runtime). `type: 1`
              // matches the Qwen Omni SDK's sendUpdate behavior.
              const dcMsg = AliRtcDataChannelMsg
                ? new AliRtcDataChannelMsg(data.buffer, 1)
                : { data: data.buffer, type: 1 };
              engine.sendDataChannelMessage(dcMsg);
              log("[qwen] sent session.update (voice: Tina, server_vad 800ms).");
            } catch (err) {
              log(`[qwen] failed to send session.update: ${(err as Error).message}`);
            }
            break;
          }
          // --- Server-side VAD (voice activity detection) ---
          case "input_audio_buffer.speech_started": {
            log("[qwen] speech started");
            // Barge-in: stop any active audio playback (matches the
            // Inworld pattern). For Qwen the AI's audio is played via
            // a MediaStreamTrack (not Web Audio), so `clearAudioQueue`
            // is effectively a no-op — but the server's
            // `interrupt_response: true` already stops the AI's audio
            // at the source. Reset the user-speech tracking so the
            // next transcription creates a fresh "You:" line.
            clearAudioQueue();
            inUserSpeechRef.current = false;
            break;
          }
          case "input_audio_buffer.speech_stopped": {
            log("[qwen] speech stopped");
            break;
          }
          // --- User mic transcript (server-side transcription) ---
          // Both `.delta` and `.completed` UPDATE the same "You:" line
          // via `upsertUserLine` (collapses all deltas + completed
          // events for one speech into ONE growing line — matches
          // the Inworld pattern from Task 62).
          case "conversation.item.input_audio_transcription.completed": {
            const transcript = (msg.transcript as string) ?? (msg.text as string) ?? "";
            upsertUserLine(transcript);
            break;
          }
          case "conversation.item.input_audio_transcription.delta": {
            const d = (msg.delta as string) ?? "";
            upsertUserLine(d);
            break;
          }
          // --- AI transcript (streaming text of the spoken reply) ---
          // Qwen uses the `output_` infix (response.output_audio_transcript.delta),
          // but we also accept the standard OpenAI name (response.audio_transcript.delta)
          // for forward-compat. Use appendAiDelta → ONE growing AI: line per response.
          case "response.output_audio_transcript.delta":
          case "response.audio_transcript.delta": {
            appendAiDelta((msg.delta as string) ?? "");
            break;
          }
          case "response.output_audio_transcript.done":
          case "response.audio_transcript.done": {
            // The .done event carries the FINAL transcript. If we
            // already appended deltas above, this is redundant — only
            // log if no AI line was started (e.g. the deltas were
            // empty / not received). Matches the Inworld pattern.
            const finalText = (msg.transcript as string) ?? (msg.text as string) ?? "";
            if (finalText) {
              setTranscript((prev) => {
                const last = prev[prev.length - 1] ?? "";
                if (last.includes("] AI:")) return prev; // already have streaming text
                return [...prev.slice(-199), `[${new Date().toLocaleTimeString()}] AI: ${finalText}`];
              });
            }
            break;
          }
          // --- Errors (OpenAI shape: {type:"error", error:{...}}) ---
          case "error": {
            const errObj = msg.error as Record<string, unknown> | undefined;
            const errMsg =
              (typeof errObj === "object" && errObj
                ? ((errObj.message as string) ??
                  (errObj.code as string) ??
                  (errObj.type as string))
                : undefined) ??
              JSON.stringify(msg);
            log(`[qwen] Server error: ${errMsg}`);
            break;
          }
          // --- Other events (response.created, response.done,
          //     conversation.item.added, rate_limits.updated, etc.)
          //     are silent no-ops — they don't carry user-visible
          //     payload (matches the Inworld pattern). ---
          default:
            break;
        }
      } catch {
        // Non-JSON message — ignore. The Qwen Omni server may send
        // binary control frames that aren't valid JSON.
      }
    });

    setStatus("connected");
    log("Connected. Speak when ready.");
  }, [clearAudioQueue, log, upsertUserLine]);

  /** Connect to the selected provider's realtime endpoint. Dispatches to
   * the WebRTC path (ChatGPT / Perplexity), the Gemini bidi path, or the
   * Inworld WebSocket path. */
  const connect = useCallback(async () => {
    setError(null);
    setStatus("connecting");
    setTranscript([]);
    log(`Connecting to ${providerRef.current}…`);
    try {
      if (providerRef.current === "gemini") {
        await connectGemini();
      } else if (providerRef.current === "inworld") {
        await connectInworld();
      } else if (providerRef.current === "qwen") {
        await connectQwen();
      } else {
        await connectWebRtc();
      }
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      setError(message);
      setStatus("error");
      log(`Error: ${message}`);
      teardown();
    }
  }, [connectGemini, connectInworld, connectQwen, connectWebRtc, log, teardown]);

  /** Toggle the mic on/off (mutes the local audio track). Works for the
   * WebRTC path (localStream), the Gemini/Inworld paths (micStream), AND
   * the Qwen path (Aliyun RTC SDK owns the mic — uses `muteLocalMic`). */
  const toggleMute = useCallback(() => {
    const next = !muted;
    // Qwen path — the Aliyun RTC SDK owns the mic stream.
    if (qwenEngineRef.current) {
      try { qwenEngineRef.current.muteLocalMic(next); } catch { /* ignore */ }
      setMuted(next);
      log(next ? "Mic muted." : "Mic unmuted.");
      return;
    }
    // ChatGPT / Perplexity / Gemini / Inworld path — toggle the shared
    // MediaStream tracks' `enabled` property.
    const stream = localStreamRef.current;
    if (!stream) return;
    stream.getAudioTracks().forEach((t) => (t.enabled = !next));
    setMuted(next);
    log(next ? "Mic muted." : "Mic unmuted.");
  }, [muted, log]);

  /** Disconnect from the provider. For Gemini this fires a best-effort
   * stop call to the backend; for Inworld the WebSocket close (handled
   * inside `teardown`) IS the stop; for the WebRTC providers there's no
   * explicit teardown call — closing the peer connection is enough. */
  const disconnect = useCallback(() => {
    // Best-effort stop call for Gemini (the server doesn't really need a
    // stop — we just stop long-polling — but it's polite).
    const session = geminiSessionRef.current;
    if (session) {
      void fetch("/api/gemini/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "stop",
          gsessionid: session.gsessionid,
          sid: session.sid,
          rid: session.rid,
        }),
        signal: AbortSignal.timeout(5_000),
      }).catch(() => { /* best-effort */ });
    }
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
          Talk to a realtime AI model. ChatGPT, Perplexity, and Qwen use
          WebRTC; Gemini Live uses Google's bidi (Web Channel) protocol;
          Inworld uses a direct browser WebSocket to api.inworld.ai. ChatGPT
          needs a JWT in the vault; Perplexity + Gemini need their session
          cookies there (refreshed by the Chrome extension); Inworld needs
          an `INWORLD_TOKEN` env var (or a token in the vault); Qwen needs
          a `QWEN_ACCESS_TOKEN` env var (the chat.qwen.ai JWT).
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
            <ProviderButton
              active={provider === "gemini"}
              onClick={() => setProvider("gemini")}
              disabled={connected || status === "connecting"}
            >
              Gemini
            </ProviderButton>
            <ProviderButton
              active={provider === "inworld"}
              onClick={() => setProvider("inworld")}
              disabled={connected || status === "connecting"}
            >
              Inworld
            </ProviderButton>
            <ProviderButton
              active={provider === "qwen"}
              onClick={() => setProvider("qwen")}
              disabled={connected || status === "connecting"}
            >
              Qwen
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
