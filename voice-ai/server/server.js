"use strict";

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const vosk = require("vosk");

// --- Load .env file (for NVIDIA_API_KEY + QWEN cookies) ----------------
const envPath = path.join(__dirname, "..", "..", ".env");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
  console.log(`[voice-ai] loaded .env from ${envPath}`);
}

// --- Config -------------------------------------------------------------
const PORT = 3005;
const SAMPLE_RATE = 16000;
const MODEL_DIR = path.join(__dirname, "model", "vosk-model-small");

const PYTHON_CANDIDATES = ["/home/z/.venv/bin/python3", "/usr/bin/python3", "python3"];
let PYTHON_BIN = null;
for (const candidate of PYTHON_CANDIDATES) {
  try {
    const { spawnSync } = require("child_process");
    const r = spawnSync(candidate, ["-c", "import edge_tts"], { stdio: "ignore", timeout: 5000 });
    if (r.status === 0) { PYTHON_BIN = candidate; break; }
  } catch {}
}
if (!PYTHON_BIN) PYTHON_BIN = "python3";
console.log(`[voice-ai] using python: ${PYTHON_BIN}`);

// --- Vosk model ---------------------------------------------------------
vosk.setLogLevel(-1);
console.log(`[voice-ai] loading Vosk model from ${MODEL_DIR}…`);
const MODEL = new vosk.Model(MODEL_DIR);
console.log("[voice-ai] Vosk model loaded.");

// --- WebSocket server ---------------------------------------------------
const wss = new WebSocket.Server({ port: PORT });
console.log(`[voice-ai] WebSocket server on ws://localhost:${PORT}`);

wss.on("connection", (ws, req) => {
  console.log("[voice-ai] client connected", req.socket.remoteAddress);
  const recognizer = new vosk.Recognizer({ model: MODEL, sampleRate: SAMPLE_RATE });
  let ttsProcess = null, ttsPlaying = false, closed = false;
  let aiProcess = null, aiCancelled = false, aiSegmentQueue = [], aiTtsRunning = false;

  const sendJson = (obj) => { if (!closed && ws.readyState === WebSocket.OPEN) try { ws.send(JSON.stringify(obj)); } catch {} };
  const sendBinary = (buf) => { if (!closed && ws.readyState === WebSocket.OPEN) try { ws.send(buf); } catch {} };

  const killTts = () => {
    if (ttsProcess) { try { ttsProcess.kill("SIGKILL"); } catch {} ttsProcess = null; }
    if (ttsPlaying) { ttsPlaying = false; sendJson({ type: "tts_end" }); }
  };

  const killAi = () => {
    aiCancelled = true;
    if (aiProcess) { try { aiProcess.kill("SIGKILL"); } catch {} aiProcess = null; }
    aiSegmentQueue = [];
    killTts();
  };

  const speak = (text) => {
    if (!text || typeof text !== "string") return;
    if (ttsProcess) killTts();
    console.log(`[voice-ai] TTS: ${text.slice(0, 80)}`);
    ttsPlaying = true; sendJson({ type: "tts_start", text });
    const child = spawn(PYTHON_BIN, [path.join(__dirname, "tts.py"), text], { stdio: ["ignore", "pipe", "inherit"] });
    ttsProcess = child;
    child.stdout.on("data", (chunk) => sendBinary(chunk));
    child.on("error", (err) => { console.error("[voice-ai] TTS err:", err.message); ttsProcess = null; if (ttsPlaying) { ttsPlaying = false; sendJson({ type: "tts_end", error: err.message }); } });
    child.on("exit", (code) => { ttsProcess = null; if (ttsPlaying) { ttsPlaying = false; sendJson({ type: "tts_end", code: code ?? 0 }); } });
  };

  const processNextSegment = () => {
    if (closed || aiCancelled || aiSegmentQueue.length === 0) { aiTtsRunning = false; return; }
    aiTtsRunning = true;
    speak(aiSegmentQueue.shift());
    const checkDone = () => { if (closed || aiCancelled) return; if (!ttsProcess) processNextSegment(); else setTimeout(checkDone, 50); };
    setTimeout(checkDone, 100);
  };

  const startAiPipeline = (userText) => {
    if (!userText || typeof userText !== "string") return;
    killAi(); aiCancelled = false; aiSegmentQueue = []; aiTtsRunning = false;
    console.log(`[voice-ai] AI pipeline: ${userText.slice(0, 80)}`);
    sendJson({ type: "ai_start", text: userText });

    const child = spawn(PYTHON_BIN, [path.join(__dirname, "ai_stream.py"), userText], {
      cwd: __dirname, stdio: ["ignore", "pipe", "pipe"],
      env: { PYTHONUNBUFFERED: "1", ...process.env },
    });
    aiProcess = child;
    let textBuffer = "";

    child.stdout.on("data", (chunk) => {
      if (closed || aiCancelled) return;
      const text = chunk.toString("utf8");
      console.log(`[voice-ai] AI stdout: ${text.length}B: ${text.slice(0, 80)}`);
      textBuffer += text;
      sendJson({ type: "ai_text", text });

      const boundary = Math.max(textBuffer.lastIndexOf(". "), textBuffer.lastIndexOf("! "), textBuffer.lastIndexOf("? "), textBuffer.lastIndexOf("\n"), textBuffer.lastIndexOf("; "));
      if (boundary >= 0 && boundary < textBuffer.length - 1) {
        const segment = textBuffer.slice(0, boundary + 1).trim();
        textBuffer = textBuffer.slice(boundary + 1);
        if (segment) { aiSegmentQueue.push(segment); if (!aiTtsRunning) processNextSegment(); }
      } else if (textBuffer.length > 200) {
        const segment = textBuffer.trim(); textBuffer = "";
        if (segment) { aiSegmentQueue.push(segment); if (!aiTtsRunning) processNextSegment(); }
      }
    });
    child.stderr.on("data", (chunk) => console.error("[voice-ai] AI stderr:", chunk.toString("utf8").slice(0, 200)));
    child.on("error", (err) => { console.error("[voice-ai] AI err:", err.message); aiProcess = null; sendJson({ type: "ai_end", error: err.message }); });
    child.on("exit", (code) => {
      aiProcess = null;
      if (!closed && !aiCancelled && textBuffer.trim()) { aiSegmentQueue.push(textBuffer.trim()); if (!aiTtsRunning) processNextSegment(); }
      sendJson({ type: "ai_end", code: code ?? 0 });
      console.log(`[voice-ai] AI pipeline ended (${code ?? 0})`);
    });
  };

  ws.on("message", (data, isBinary) => {
    if (closed) return;
    if (isBinary) {
      if (ttsPlaying || aiProcess) killAi();
      try {
        const final = recognizer.acceptWaveform(data);
        if (final) {
          const result = recognizer.finalResult();
          const text = (result && typeof result.text === "string" ? result.text : "").trim();
          if (text) { console.log(`[voice-ai] STT final: ${text}`); sendJson({ type: "stt_final", text }); startAiPipeline(text); }
        } else {
          const partial = recognizer.partialResult();
          const ptext = (partial && typeof partial.partial === "string" ? partial.partial : "").trim();
          if (ptext) sendJson({ type: "stt_partial", text: ptext });
        }
      } catch (err) { console.error("[voice-ai] Vosk error:", err.message); }
      return;
    }
    try {
      const msg = JSON.parse(data.toString("utf8"));
      if (msg && msg.type === "speak" && typeof msg.text === "string") speak(msg.text);
      else if (msg && msg.type === "ai" && typeof msg.text === "string") startAiPipeline(msg.text);
    } catch {}
  });

  ws.on("close", () => { closed = true; console.log("[voice-ai] disconnected"); killAi(); try { recognizer.free(); } catch {} });
  ws.on("error", (err) => console.error("[voice-ai] ws err:", err.message));
});

process.on("SIGINT", () => { try { MODEL.free(); } catch {} process.exit(0); });
process.on("SIGTERM", () => { try { MODEL.free(); } catch {} process.exit(0); });
