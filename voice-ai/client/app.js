/**
 * voice-ai/client/app.js — standalone client for the Vosk + Edge TTS server.
 *
 * Connects to `ws://localhost:3005`, captures mic via AudioWorklet at
 * 16 kHz, sends Int16 PCM as binary frames, plays back TTS MP3 chunks.
 *
 * V1 TTS playback: accumulate all MP3 chunks into a single Blob, then
 * play via a fresh `<audio>` element with a Blob URL. Edge TTS is fast
 * enough (~150ms for a short sentence) that this gives a near-real-
 * time experience without MediaSource Extensions complexity.
 *
 * Barge-in: when the user speaks while TTS is playing, the server
 * kills the TTS process + sends `{type:"tts_end"}`. The client also
 * drops any accumulated MP3 buffer on barge-in so the next TTS start
 * is clean.
 */

"use strict";

// --- DOM refs -----------------------------------------------------------
const connectBtn = document.getElementById("connect-btn");
const disconnectBtn = document.getElementById("disconnect-btn");
const muteBtn = document.getElementById("mute-btn");
const statusEl = document.getElementById("status");
const statusLabel = document.getElementById("status-label");
const logEl = document.getElementById("log");
const speakForm = document.getElementById("speak-form");
const speakInput = document.getElementById("speak-input");

// --- State --------------------------------------------------------------
let ws = null;
let audioCtx = null;
let micStream = null;
let workletNode = null;
let muted = false;
let ttsChunks = []; // ArrayBuffer[] — MP3 chunks accumulated for current TTS
let ttsAudioEl = null;
let ttsActive = false;

// --- Helpers ------------------------------------------------------------
function setStatus(state, label) {
  statusEl.classList.remove("live", "error", "connecting");
  if (state) statusEl.classList.add(state);
  statusLabel.textContent = label;
}

function logLine(text, kind) {
  const line = document.createElement("div");
  line.className = kind || "system";
  const time = new Date().toLocaleTimeString();
  line.textContent = `[${time}] ${text}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  // Keep the log under 500 lines.
  while (logEl.children.length > 500) {
    logEl.removeChild(logEl.firstChild);
  }
}

function setButtons(connected) {
  connectBtn.disabled = connected;
  disconnectBtn.disabled = !connected;
  muteBtn.disabled = !connected;
}

// --- Connect ------------------------------------------------------------
async function connect() {
  setStatus("connecting", "Connecting…");
  logLine("Connecting to ws://localhost:3005…");

  // 1. Open WebSocket. The standalone client connects directly to
  //    port 3005 — when integrated into the Next.js app, the URL
  //    becomes `wss://<host>/?XTransformPort=3005` (Caddy gateway).
  const wsUrl = "ws://localhost:3005";
  ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  await new Promise((resolve, reject) => {
    const onOpen = () => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      resolve();
    };
    const onError = () => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      reject(new Error("WebSocket connection failed."));
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
  }).catch((err) => {
    setStatus("error", "Error");
    logLine(err.message, "err");
    ws = null;
    return;
  });

  if (!ws) return;

  logLine("WebSocket open.");

  // 2. AudioContext at 16 kHz (Vosk's rate). The AudioWorklet will
  //    receive mic audio at this rate + downsample (a no-op if the
  //    context is already 16 kHz).
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AudioCtor({ sampleRate: 16000 });
  if (audioCtx.state === "suspended") await audioCtx.resume();

  // 3. Get the mic.
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  // 4. Load the AudioWorklet module + wire the mic through it.
  await audioCtx.audioWorklet.addModule("audio-worklet.js");
  const source = audioCtx.createMediaStreamSource(micStream);
  workletNode = new AudioWorkletNode(audioCtx, "downsample-processor");
  source.connect(workletNode);
  // The worklet posts Int16Array chunks — forward each to the server.
  workletNode.port.onmessage = (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (muted) return; // don't send silence frames
    ws.send(e.data.buffer);
  };
  // Worklet needs a destination to fire — connect to a muted gain.
  const mutedGain = audioCtx.createGain();
  mutedGain.gain.value = 0;
  workletNode.connect(mutedGain);
  mutedGain.connect(audioCtx.destination);

  // 5. Handle incoming messages.
  ws.onmessage = onMessage;
  ws.onclose = () => {
    logLine("WebSocket closed.", "system");
    teardown();
  };
  ws.onerror = () => {
    logLine("WebSocket error.", "err");
  };

  setStatus("live", "Live");
  logLine("Connected. Speak when ready.", "system");
  setButtons(true);
}

// --- Message handler ----------------------------------------------------
function onMessage(e) {
  // Binary frame = TTS MP3 chunk.
  if (e.data instanceof ArrayBuffer) {
    if (!ttsActive) return; // stale chunk after tts_end
    ttsChunks.push(e.data);
    return;
  }
  // Text frame = JSON control message.
  if (typeof e.data !== "string") return;
  let msg;
  try {
    msg = JSON.parse(e.data);
  } catch {
    return;
  }
  switch (msg.type) {
    case "stt_partial":
      logLine(`You (partial): ${msg.text}`, "user");
      break;
    case "stt_final":
      logLine(`You: ${msg.text}`, "user");
      break;
    case "tts_start":
      ttsActive = true;
      ttsChunks = [];
      // Stop any currently-playing TTS audio (barge-in safety).
      if (ttsAudioEl) {
        try { ttsAudioEl.pause(); } catch {}
        try { URL.revokeObjectURL(ttsAudioEl.src); } catch {}
        ttsAudioEl = null;
      }
      logLine(`AI (TTS): ${msg.text ?? ""}`, "ai");
      break;
    case "tts_end":
      // Play the accumulated MP3.
      if (ttsActive && ttsChunks.length > 0) {
        const blob = new Blob(ttsChunks, { type: "audio/mpeg" });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        ttsAudioEl = audio;
        audio.onended = () => {
          URL.revokeObjectURL(url);
          if (ttsAudioEl === audio) ttsAudioEl = null;
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          if (ttsAudioEl === audio) ttsAudioEl = null;
        };
        audio.play().catch((err) => {
          logLine(`Audio playback failed: ${err.message}`, "err");
        });
      }
      ttsActive = false;
      ttsChunks = [];
      logLine("AI audio complete.", "system");
      break;
    default:
      // Unknown control message — ignore.
      break;
  }
}

// --- Disconnect ---------------------------------------------------------
function teardown() {
  if (workletNode) {
    try { workletNode.disconnect(); } catch {}
    workletNode = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  if (audioCtx) {
    try { audioCtx.close(); } catch {}
    audioCtx = null;
  }
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
  if (ttsAudioEl) {
    try { ttsAudioEl.pause(); } catch {}
    try { URL.revokeObjectURL(ttsAudioEl.src); } catch {}
    ttsAudioEl = null;
  }
  ttsActive = false;
  ttsChunks = [];
  muted = false;
  muteBtn.classList.remove("muted");
  muteBtn.textContent = "Mute";
  setStatus(null, "Idle");
  setButtons(false);
}

function disconnect() {
  logLine("Disconnecting.", "system");
  teardown();
}

// --- Mute ---------------------------------------------------------------
function toggleMute() {
  muted = !muted;
  if (muted) {
    muteBtn.classList.add("muted");
    muteBtn.textContent = "Unmute";
    logLine("Mic muted.", "system");
  } else {
    muteBtn.classList.remove("muted");
    muteBtn.textContent = "Mute";
    logLine("Mic unmuted.", "system");
  }
}

// --- Speak form (TTS test, no STT) --------------------------------------
speakForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = speakInput.value.trim();
  if (!text) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    logLine("Not connected.", "err");
    return;
  }
  ws.send(JSON.stringify({ type: "speak", text }));
  speakInput.value = "";
});

// --- Wire up buttons ----------------------------------------------------
connectBtn.addEventListener("click", connect);
disconnectBtn.addEventListener("click", disconnect);
muteBtn.addEventListener("click", toggleMute);

// Initial state.
setStatus(null, "Idle");
setButtons(false);
