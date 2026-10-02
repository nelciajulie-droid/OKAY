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
// Realtime AI section — ChatGPT / Perplexity / Gemini / Inworld voice
// ---------------------------------------------------------------------------

type RealtimeProvider = "chatgpt" | "perplexity" | "gemini" | "inworld";

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
  }, [log]);

  // -------------------------------------------------------------------------
  // Gemini bidi path — Google AI Studio Web Channel.
  // -------------------------------------------------------------------------

  /** Decode a base64 PCM16 (16kHz mono) string and play it via the
   * AudioContext. Each chunk is scheduled right after the previous one
   * (we keep a `nextStartTime` so chunks don't overlap or stutter). */
  const playPcmChunkRef = useRef<((b64: string) => void) | null>(null);
  const nextStartTimeRef = useRef<number>(0);

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
   * Flow:
   *   1. GET /api/inworld/token → { token } (basic_<base64>).
   *   2. Open WebSocket: `wss://api.inworld.ai/api/v1/realtime/session
   *      ?protocol=realtime&key=browser-session-<ts>`, subprotocol = [token].
   *   3. AudioContext (16kHz) + getUserMedia + ScriptProcessor for PCM
   *      capture (same as Gemini).
   *   4. setInterval(200ms) flushes mic PCM16 → base64 → JSON
   *      { type:"audio", data:<b64>, sampleRate:16000, encoding:"linear16" }
   *      → ws.send.
   *   5. ws.onmessage: text frames are JSON (handled by `handleInworldMsg`);
   *      binary frames are raw PCM16 → played via the AudioContext.
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
    const wsUrl =
      "wss://api.inworld.ai/api/v1/realtime/session?protocol=realtime&key=browser-session-" +
      Date.now();
    log(`Opening Inworld WebSocket…`);
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

    // 3. Create an AudioContext at 16kHz + get the user's mic. Same shape
    //    as the Gemini path (the PCM encode/decode round-trip matches what
    //    Inworld's realtime endpoint expects).
    const AudioCtor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const audioCtx = new AudioCtor({ sampleRate: 16000 });
    audioCtxRef.current = audioCtx;

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
      const startTime = Math.max(ctx.currentTime, nextStartTimeRef.current);
      src.start(startTime);
      nextStartTimeRef.current = startTime + buffer.duration;
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

    /** Dispatch an incoming Inworld JSON message. The exact protocol is
     * under-documented; this handler is deliberately permissive (looks
     * for the message type under several common keys, handles audio +
     * transcripts + state + errors, and logs anything unknown). */
    const handleInworldMsg = (msg: Record<string, unknown>) => {
      if (!msg || typeof msg !== "object") return;
      const type =
        (msg.type as string) ??
        (msg.event as string) ??
        (msg.kind as string) ??
        "message";
      switch (type) {
        case "audio":
        case "audio_chunk":
        case "audioChunk": {
          const b64 =
            (msg.data as string) ??
            ((msg.audio as Record<string, unknown> | undefined)?.data as string) ??
            (msg.payload as string);
          if (typeof b64 === "string") playPcmChunkRef.current?.(b64);
          break;
        }
        case "transcript":
        case "text":
        case "utterance":
        case "response":
        case "answer": {
          const text =
            (msg.text as string) ??
            (msg.transcript as string) ??
            (msg.data as string) ??
            (msg.content as string);
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
            (msg.data as string);
          if (typeof text === "string" && text.length > 0) log(`You: ${text}`);
          break;
        }
        case "state":
        case "status":
        case "ready": {
          log(`[inworld] state: ${JSON.stringify(msg).slice(0, 200)}`);
          break;
        }
        case "error": {
          const errMsg =
            (msg.error as string) ??
            (msg.message as string) ??
            JSON.stringify(msg);
          // Ensure it's a string (avoid [object Object])
          const errStr = typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg);
          log(`[inworld] error: ${errStr}`);
          break;
        }
        default: {
          // Unknown type — log a compact summary so the user can see what
          // Inworld is sending (and we can refine the handler later).
          log(`[inworld] ${type}: ${JSON.stringify(msg).slice(0, 200)}`);
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
    //    a single base64 PCM and send it as a JSON audio message. This
    //    mirrors the Gemini flush loop, just over a WebSocket instead of
    //    a long-poll HTTP POST.
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
        sock.send(
          JSON.stringify({
            type: "audio",
            data: b64,
            sampleRate: 16000,
            encoding: "linear16",
          }),
        );
      } catch (err) {
        console.warn("[inworld] send failed:", (err as Error).message);
      }
    }, 200);

    setStatus("connected");
    log("Connected. Speak when ready.");
  }, [base64ToFloat32, float32ToInt16, int16ToBase64, log, status]);

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
  }, [connectGemini, connectInworld, connectWebRtc, log, teardown]);

  /** Toggle the mic on/off (mutes the local audio track). Works for both
   * the WebRTC path (localStream) and the Gemini path (micStream) since
   * both store the MediaStream in localStreamRef. */
  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !muted;
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
          Talk to a realtime AI model. ChatGPT and Perplexity use WebRTC;
          Gemini Live uses Google's bidi (Web Channel) protocol; Inworld
          uses a direct browser WebSocket to api.inworld.ai. ChatGPT needs
          a JWT in the vault; Perplexity + Gemini need their session cookies
          there (refreshed by the Chrome extension); Inworld just needs an
          `INWORLD_TOKEN` env var (or a token in the vault).
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
