# Voice AI — Vosk STT + Edge TTS

Real-time voice AI system using **local Vosk** for speech-to-text and
**Microsoft Edge TTS** for text-to-speech. No Web Speech API, no
SpeechRecognition, no speechSynthesis — pure local STT + streaming
TTS over WebSocket.

## Architecture

```
┌───────────┐       Int16 PCM16 @ 16kHz       ┌────────────────┐
│  Browser  │ ───────────────────────────────►│  voice-ai      │
│  client   │                                 │  server.js     │
│ (mic)     │ ◄────── MP3 audio (binary) ──── │  (port 3005)   │
│           │ ◄── JSON: stt_partial/final ── │                │
│           │ ◄── JSON: tts_start/tts_end ─── │                │
└───────────┘                                 └────────┬───────┘
                                                       │
                                              ┌────────▼────────┐
                                              │  Vosk Recognizer │
                                              │  (16kHz, local)  │
                                              └─────────────────┘
                                                       │
                                              ┌────────▼────────┐
                                              │  python3 tts.py  │
                                              │  (Edge TTS)      │
                                              └─────────────────┘
```

## Components

### `server/server.js` — Node WebSocket server (port 3005)

- Loads the Vosk model once at boot from `./model/vosk-model-small/`.
- One `Recognizer` per WebSocket connection.
- Binary frames (Int16 PCM16) → `recognizer.acceptWaveform()` →
  emits `stt_partial` (interim) / `stt_final` (silence detected).
- On `stt_final` → spawns `python3 tts.py "<text>"` → streams MP3
  chunks back as binary frames → sends `{type:"tts_end"}`.
- **Barge-in**: any new mic audio while TTS is playing kills the TTS
  process + emits `{type:"tts_end"}`.
- Client→server JSON `{type:"speak", text:"..."}` triggers TTS
  directly (bypasses STT) — useful for testing TTS.

### `server/tts.py` — Edge TTS streamer

- Uses `edge_tts.Communicate(text, "fr-FR-DeniseNeural")`.
- Writes MP3 chunks to stdout as they arrive from Microsoft Edge's
  free TTS service.

### `client/audio-worklet.js` — AudioWorkletProcessor

- Captures mic at the AudioContext rate (typically 48 kHz).
- Linear-interpolation downsample to 16 kHz.
- Float32 → Int16 PCM conversion.
- Posts Int16 chunks (256-sample batches) to the main thread.

### `client/app.js` + `client/index.html` — Standalone demo client

- WebSocket → `ws://localhost:3005`.
- Mic → AudioWorklet → binary frames.
- TTS chunks accumulated into a Blob → `new Audio(blobUrl).play()`.
- Speak-form to trigger TTS directly (no STT) for testing.

## Setup

### 1. Install Python dependencies

```bash
pip install edge-tts --break-system-packages
```

### 2. Download the Vosk model

The French small model is expected at:

```
voice-ai/server/model/vosk-model-small/
```

Download from https://alphacephei.com/vosk/models — pick the French
small model (~40 MB), unzip, and place it so the path above
contains `am/`, `graph/`, `ivector/`, `conf/`.

### 3. Start the server

```bash
cd voice-ai/server
node server.js
# → [voice-ai] WebSocket server listening on ws://localhost:3005
```

### 4. Serve the client

The standalone client is just two static files. Serve them with any
static HTTP server:

```bash
cd voice-ai/client
python3 -m http.server 8080
# → open http://localhost:8080/
```

Or copy `audio-worklet.js`, `app.js`, and `index.html` into any
static folder (they use relative paths so they work together).

## Integrate into the main app

This voice-ai server is also integrated as the **Vosk** provider in
`src/app/page.tsx`. The browser connects via the Caddy gateway
with `?XTransformPort=3005`:

```
wss://<page-host>/?XTransformPort=3005
```

The browser sends raw PCM16 binary frames (via a ScriptProcessorNode
+ downsample logic), receives `stt_partial` / `stt_final` / `tts_start`
/ `tts_end` JSON control messages, and plays back the TTS MP3
chunks via an accumulated Blob + `new Audio(url)`.

## What this is NOT

- ❌ No Web Speech API / `webkitSpeechRecognition` / `speechSynthesis`.
- ❌ No cloud STT (Vosk runs locally in the Node server process).
- ❌ No cloud TTS (Edge TTS is a free Microsoft service — the same
  one used by the Edge browser's Read Aloud feature).
- ❌ No MediaSource Extensions for streaming MP3 playback (V1
  accumulates + plays — Edge TTS generates fast enough for
  near-real-time).

## Ports

| Service           | Port |
|-------------------|------|
| Next.js dev server | 3000 |
| Voice AI server    | 3005 |
| Caddy gateway      | 81   |

## License

MIT — this is a demo. Vosk is Apache-2.0; edge-tts is GPL-3.0.
