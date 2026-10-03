/**
 * ZAI Voice — text-to-speech (TTS) route.
 *
 * Generates an MP3 audio stream from text using the `msedge-tts` package
 * (Microsoft Edge's free Read Aloud service — no API key needed). Returns
 * the audio as a binary response (Content-Type: audio/mpeg) so the browser
 * can play it via `new Audio(blobUrl).play()`.
 *
 * Multilingual: the voice is auto-detected from the text via a simple
 * heuristic (CJK chars → zh-CN-XiaoxiaoNeural, Arabic → ar-SA-ZariyahNeural,
 * French accented Latin → fr-FR-DeniseNeural, default → en-US-AriaNeural).
 * The caller can override by passing `{ voice: "en-US-AriaNeural" }` (or
 * any other valid Edge TTS voice name like "ja-JP-NanamiNeural").
 *
 * Request body: `{ text: string, voice?: string }`.
 * Response: binary audio/mpeg on success.
 *          JSON `{ ok: false, error: string }` on failure (4xx/5xx).
 */

import { NextResponse } from "next/server";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_VOICE = "en-US-AriaNeural";

/**
 * Auto-detect the Edge TTS voice from the text content using a simple
 * Unicode-range heuristic. CJK ideographs / Hiragana / Katakana / Hangul
 * → zh-CN voice (XiaoxiaoNeural). Arabic block → ar-SA. French accented
 * Latin chars (é è ê ë à â ù û ô î ï ç œ) → fr-FR. Everything else → en-US.
 * The voice can be overridden by passing `voice` in the request body.
 */
function detectVoice(text: string): string {
  // CJK Unified Ideographs + Hiragana + Katakana + Hangul Syllables.
  if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text)) {
    return "zh-CN-XiaoxiaoNeural";
  }
  // Arabic block.
  if (/[\u0600-\u06ff]/.test(text)) {
    return "ar-SA-ZariyahNeural";
  }
  // French accented Latin chars (common diacritics used in French).
  if (/[éèêëàâùûôîïçœÉÈÊËÀÂÙÛÔÎÏÇŒ]/.test(text)) {
    return "fr-FR-DeniseNeural";
  }
  return DEFAULT_VOICE;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { text?: unknown; voice?: unknown };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      return NextResponse.json(
        { ok: false, error: "Missing 'text' field." },
        { status: 400 },
      );
    }
    const voice =
      typeof body.voice === "string" && body.voice.trim()
        ? body.voice.trim()
        : detectVoice(text);

    // MsEdgeTTS uses `isomorphic-ws` + `axios` under the hood — both work
    // in the Node.js runtime (we set `runtime = "nodejs"` above). The
    // `setMetadata` call opens a WebSocket to the Edge Read Aloud service
    // + negotiates the voice + output format.
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

    // `toStream` is synchronous — it returns a Node Readable that emits
    // Buffer chunks of the synthesised MP3 as they arrive from the Edge
    // service (real-time streaming). We collect them all into a single
    // Buffer so the browser can play the full clip from a blob URL.
    const { audioStream } = tts.toStream(text);

    const chunks: Buffer[] = [];
    for await (const chunk of audioStream) {
      // `chunk` is a Buffer from a Node Readable; wrap defensively so
      // Uint8Array-typed chunks are also handled (Buffer.from is a no-op
      // on an existing Buffer).
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);

    if (buffer.length === 0) {
      return NextResponse.json(
        { ok: false, error: "TTS produced no audio." },
        { status: 502 },
      );
    }

    // Return the binary mp3 — the browser plays it via
    // `new Audio(URL.createObjectURL(await res.blob())).play()`.
    return new Response(buffer, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(buffer.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: `ZAI TTS failed: ${message}` },
      { status: 500 },
    );
  }
}
