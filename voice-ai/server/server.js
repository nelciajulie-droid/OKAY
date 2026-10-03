/**
 * voice-ai/server/server.js
 *
 * Realtime voice AI backend — Vosk STT + Edge TTS over WebSocket.
 *
 * - Listens on port 3005 (NOT 3000 — that's the Next.js dev server).
 * - Loads the Vosk model once at boot from ./model/vosk-model-small.
 * - On connection: creates a fresh Vosk Recognizer (16 kHz, mono).
 * - On binary message: feeds Int16 PCM to the recognizer → sends
 *   {type:"stt_partial", text} / {type:"stt_final", text}.
 * - On final result OR JSON `{type:"speak", text}`: spawns
 *   `python3 tts.py "<text>"` → streams stdout (MP3 audio chunks) back
 *   to the client as binary frames, then sends `{type:"tts_end"}`.
 * - Barge-in: if new PCM audio arrives while a TTS process is still
 *   running → kill the TTS process + send `{type:"tts_end"}` so the
 *   client knows playback was interrupted.
 * - Cleanup on disconnect: free the recognizer + kill any active TTS.
 *
 * The Vosk + ws packages are symlinked from the parent Next.js project
 * (see `node_modules` symlink) — they are NOT installed separately so
 * the version stays in lockstep with the main app.
 */

"use strict";

const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const vosk = require("vosk");

// --- Config -------------------------------------------------------------
const PORT = 3005;
const SAMPLE_RATE = 16000;
const MODEL_DIR = path.join(__dirname, "model", "vosk-model-small");

// Prefer the venv python (per the task spec), but fall back to `python3`
// if the venv binary doesn't have edge_tts installed. In this sandbox,
// edge_tts is installed for /usr/bin/python3 (system python3.13), not for
// /home/z/.venv/bin/python3 — so we probe both before binding the path.
const PYTHON_CANDIDATES = [
  "/home/z/.venv/bin/python3",
  "/usr/bin/python3",
  "python3",
];
let PYTHON_BIN = null;
for (const candidate of PYTHON_CANDIDATES) {
  try {
    // Synchronous probe: spawn with -c "import edge_tts" + check exit.
    const { spawnSync } = require("child_process");
    const r = spawnSync(candidate, ["-c", "import edge_tts"], {
      stdio: "ignore",
      timeout: 5000,
    });
    if (r.status === 0) {
      PYTHON_BIN = candidate;
      break;
    }
  } catch {
    // try next candidate
  }
}
if (!PYTHON_BIN) {
  console.error(
    "[voice-ai] WARNING: no python3 with edge_tts found — TTS will fail.",
  );
  // Fall back to python3 anyway so the spawn error surfaces clearly.
  PYTHON_BIN = "python3";
}
console.log(`[voice-ai] using python: ${PYTHON_BIN}`);

// --- Vosk model (loaded once) -------------------------------------------
vosk.setLogLevel(-1); // silence Vosk's INFO logs
console.log(`[voice-ai] loading Vosk model from ${MODEL_DIR}…`);
const MODEL = new vosk.Model(MODEL_DIR);
console.log("[voice-ai] Vosk model loaded.");

// --- WebSocket server ---------------------------------------------------
const wss = new WebSocket.Server({ port: PORT });
console.log(`[voice-ai] WebSocket server listening on ws://localhost:${PORT}`);

wss.on("connection", (ws, req) => {
  console.log("[voice-ai] client connected", req.socket.remoteAddress);

  // Per-connection state.
  const recognizer = new vosk.Recognizer({
    model: MODEL,
    sampleRate: SAMPLE_RATE,
  });
  let ttsProcess = null;       // current TTS child process (if any)
  let ttsPlaying = false;      // true while TTS chunks are streaming
  let closed = false;          // set true on ws close so async loops bail

  /** Send a JSON message to the client (swallows errors after close). */
  const sendJson = (obj) => {
    if (closed || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* client gone — ignore */
    }
  };

  /** Send raw binary to the client (TTS audio chunks). */
  const sendBinary = (buf) => {
    if (closed || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(buf);
    } catch {
      /* client gone — ignore */
    }
  };

  /** Kill the active TTS process (if any) + notify the client that
   *  playback was interrupted. Used for barge-in + teardown. */
  const killTts = () => {
    if (ttsProcess) {
      try { ttsProcess.kill("SIGKILL"); } catch { /* ignore */ }
      ttsProcess = null;
    }
    if (ttsPlaying) {
      ttsPlaying = false;
      sendJson({ type: "tts_end" });
    }
  };

  /** Spawn the TTS python child for `text` + stream stdout MP3 chunks
   *  back to the client. Sets `ttsPlaying` true until the process
   *  exits + we send `{type:"tts_end"}`. */
  const speak = (text) => {
    if (!text || typeof text !== "string") return;
    // Barge-in: kill any TTS that's still streaming.
    if (ttsProcess) killTts();
    console.log(`[voice-ai] TTS starting for: ${text.slice(0, 80)}`);
    ttsPlaying = true;
    sendJson({ type: "tts_start", text });

    const child = spawn(PYTHON_BIN, [path.join(__dirname, "tts.py"), text], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    ttsProcess = child;

    child.stdout.on("data", (chunk) => {
      sendBinary(chunk);
    });
    child.on("error", (err) => {
      console.error("[voice-ai] TTS spawn error:", err.message);
      ttsProcess = null;
      if (ttsPlaying) {
        ttsPlaying = false;
        sendJson({ type: "tts_end", error: err.message });
      }
    });
    child.on("exit", (code) => {
      ttsProcess = null;
      if (ttsPlaying) {
        ttsPlaying = false;
        sendJson({ type: "tts_end", code: code ?? 0 });
      }
      if (code !== 0) {
        console.warn(`[voice-ai] TTS process exited with code ${code}.`);
      }
    });
  };

  // --- NVIDIA Nemotron streaming pipeline --------------------------------
  // When Vosk produces a final transcript, we:
  // 1. Stream the transcript to NVIDIA Nemotron (Python subprocess).
  // 2. Accumulate the text chunks until we detect a sentence boundary.
  // 3. As soon as a segment is ready → spawn Edge TTS for that segment.
  // 4. Continue accumulating → next segment → next TTS → pipeline.
  // This gives near-zero latency: the first sentence starts speaking
  // while NVIDIA is still generating the rest.

  let aiProcess = null;     // current NVIDIA streaming process
  let aiTextBuffer = "";   // accumulated text from NVIDIA
  let aiCancelled = false;  // set true on barge-in / disconnect
  let aiSegmentQueue = [];  // pending segments to TTS
  let aiTtsRunning = false;  // is a TTS for a segment currently running?

  /** Kill the AI streaming process + cancel pending segments. */
  const killAi = () => {
    aiCancelled = true;
    if (aiProcess) {
      try { aiProcess.kill("SIGKILL"); } catch { /* ignore */ }
      aiProcess = null;
    }
    aiTextBuffer = "";
    aiSegmentQueue = [];
    // Also kill any running segment TTS.
    killTts();
  };

  /** Process the next segment in the queue. Called after each TTS ends. */
  const processNextSegment = () => {
    if (closed || aiCancelled) return;
    if (aiSegmentQueue.length === 0) {
      aiTtsRunning = false;
      return;
    }
    aiTtsRunning = true;
    const segment = aiSegmentQueue.shift();
    speak(segment);
    // After speak() starts, the TTS process runs. When it exits
    // (tts_end), we need to process the next segment. We hook into
    // the child.on("exit") callback — but since speak() sets ttsProcess,
    // we can poll for completion. A simpler approach: use a setTimeout
    // loop to check if ttsProcess became null.
    const checkDone = () => {
      if (closed || aiCancelled) return;
      if (!ttsProcess) {
        // TTS for this segment finished — process next.
        processNextSegment();
      } else {
        setTimeout(checkDone, 50);
      }
    };
    setTimeout(checkDone, 100);
  };

  /** Start the NVIDIA Nemotron streaming pipeline for the user's text.
   *  Spawns a Python subprocess that streams tokens via stdout. We
   *  accumulate them + detect sentence boundaries + queue TTS. */
  const startAiPipeline = (userText) => {
    if (!userText || typeof userText !== "string") return;
    // Cancel any previous AI pipeline.
    killAi();
    aiCancelled = false;
    aiTextBuffer = "";
    aiSegmentQueue = [];
    aiTtsRunning = false;

    console.log(`[voice-ai] AI pipeline starting for: ${userText.slice(0, 80)}`);
    sendJson({ type: "ai_start", text: userText });

    // Spawn the Python NVIDIA streaming script.
    const child = spawn(PYTHON_BIN, [
      path.join(__dirname, "ai_stream.py"),
      userText,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PYTHONUNBUFFERED: "1",
        ...process.env,
        // NVIDIA_API_KEY must be set in the environment.
      },
    });
    aiProcess = child;

    let textBuffer = "";

    child.stdout.on("data", (chunk) => {
      if (closed || aiCancelled) return;
      const text = chunk.toString("utf8");
      console.log(`[voice-ai] AI stdout: ${text.length} bytes: ${text.slice(0, 80)}`);
      textBuffer += text;

      // Send each token/chunk to the client as "ai_text" for display.
      sendJson({ type: "ai_text", text });

      // Detect sentence boundaries: . ! ? ; \n or text > 200 chars.
      // Split the buffer at the last boundary + keep the remainder.
      const boundary = Math.max(
        textBuffer.lastIndexOf(". "),
        textBuffer.lastIndexOf("! "),
        textBuffer.lastIndexOf("? "),
        textBuffer.lastIndexOf(".\n"),
        textBuffer.lastIndexOf("!\n"),
        textBuffer.lastIndexOf("?\n"),
        textBuffer.lastIndexOf("; "),
        textBuffer.lastIndexOf("\n"),
      );

      if (boundary >= 0 && boundary < textBuffer.length - 1) {
        const segment = textBuffer.slice(0, boundary + 1).trim();
        const remainder = textBuffer.slice(boundary + 1);
        textBuffer = remainder;

        if (segment.length > 0) {
          console.log(`[voice-ai] AI segment ready: ${segment.slice(0, 60)}`);
          // Queue this segment for TTS.
          aiSegmentQueue.push(segment);
          if (!aiTtsRunning) {
            processNextSegment();
          }
        }
      } else if (textBuffer.length > 200) {
        // Force a segment if text is too long (no boundary found).
        const segment = textBuffer.trim();
        textBuffer = "";
        if (segment.length > 0) {
          aiSegmentQueue.push(segment);
          if (!aiTtsRunning) {
            processNextSegment();
          }
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      console.error("[voice-ai] AI stderr:", chunk.toString("utf8").slice(0, 200));
    });

    child.on("error", (err) => {
      console.error("[voice-ai] AI spawn error:", err.message);
      aiProcess = null;
      sendJson({ type: "ai_end", error: err.message });
    });

    child.on("exit", (code) => {
      aiProcess = null;
      // Flush any remaining text as a final segment.
      if (!closed && !aiCancelled && textBuffer.trim().length > 0) {
        const segment = textBuffer.trim();
        textBuffer = "";
        aiSegmentQueue.push(segment);
        if (!aiTtsRunning) {
          processNextSegment();
        }
      }
      sendJson({ type: "ai_end", code: code ?? 0 });
      console.log(`[voice-ai] AI pipeline ended (code ${code ?? 0})`);
    });
  };

  // --- Messages ---------------------------------------------------------
  ws.on("message", (data, isBinary) => {
    if (closed) return;

    if (isBinary) {
      // --- Barge-in: any new mic audio while TTS/AI is playing kills both.
      if (ttsPlaying || aiProcess) {
        killAi();
      }

      // --- Feed PCM16 to Vosk. `data` is a Buffer of Int16 LE samples.
      //  `acceptWaveform` returns true when Vosk has a final result
      //  ready (end-of-speech detected via the silence rules in
      //  model.conf — endpoint.rule2.min-trailing-silence=0.5, etc.).
      //  Note: the vosk npm package takes a Node Buffer — `data` from
      //  ws.on('message') is already a Buffer for binary frames.
      try {
        const final = recognizer.acceptWaveform(data);
        if (final) {
          // `finalResult()` is a METHOD on the vosk.Recognizer
          // (returns a parsed object — NOT a JSON string + NOT a
          // getter). Returns { text: "..." } for the small model.
          const result = recognizer.finalResult();
          const text = (result && typeof result.text === "string" ? result.text : "").trim();
          if (text) {
            console.log(`[voice-ai] STT final: ${text}`);
            sendJson({ type: "stt_final", text });
            // Start the NVIDIA streaming AI pipeline (instead of echo TTS).
            startAiPipeline(text);
          }
        } else {
          // `partialResult()` is also a METHOD — returns a parsed
          // { partial: "..." } object. Sent on every non-final chunk
          // so the user gets real-time feedback as they speak.
          const partial = recognizer.partialResult();
          const text = (partial && typeof partial.partial === "string" ? partial.partial : "").trim();
          if (text) {
            console.log(`[voice-ai] STT partial: ${text}`);
            sendJson({ type: "stt_partial", text });
          }
        }
      } catch (err) {
        console.error("[voice-ai] Vosk acceptWaveform error:", err.message);
      }
      return;
    }

    // --- JSON text frame. Only one client→server JSON message is
    //     defined: `{type:"speak", text:"..."}` to trigger TTS
    //     directly (without STT). Useful for testing the TTS path.
    try {
      const msg = JSON.parse(data.toString("utf8"));
      if (msg && msg.type === "speak" && typeof msg.text === "string") {
        speak(msg.text);
      } else if (msg && msg.type === "ai" && typeof msg.text === "string") {
        startAiPipeline(msg.text);
      } else {
        // Unknown JSON — ignore silently.
      }
    } catch {
      // Not valid JSON — ignore.
    }
  });

  // --- Cleanup ----------------------------------------------------------
  ws.on("close", () => {
    closed = true;
    console.log("[voice-ai] client disconnected");
    killAi();
    try { recognizer.free(); } catch { /* ignore */ }
  });
  ws.on("error", (err) => {
    console.error("[voice-ai] ws error:", err.message);
  });
});

// --- Graceful shutdown --------------------------------------------------
process.on("SIGINT", () => {
  console.log("\n[voice-ai] shutting down…");
  try { MODEL.free(); } catch { /* ignore */ }
  process.exit(0);
});
process.on("SIGTERM", () => {
  try { MODEL.free(); } catch { /* ignore */ }
  process.exit(0);
});
