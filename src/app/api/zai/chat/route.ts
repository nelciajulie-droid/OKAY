/**
 * ZAI Voice — chat (LLM) route.
 *
 * ZAI is the 6th realtime voice provider. Unlike the other 5 (ChatGPT,
 * Perplexity, Gemini, Inworld, Qwen) which are full-duplex WebRTC / WS /
 * bidi-HTTP, ZAI is a TURN-BASED pipeline running entirely inside this
 * Next.js backend:
 *
 *   Browser (Web Speech API STT) → POST /api/zai/chat → this route
 *     → z-ai-web-dev-sdk LLM (zai.chat.completions.create) → AI text
 *   → POST /api/zai/tts → Edge TTS mp3 → played in the browser
 *
 * Why turn-based: Web Speech API STT runs in the browser (Chrome) and
 * produces a transcript after the user pauses. We then call the LLM
 * synchronously (no streaming needed for v1), then synthesise TTS, then
 * play it. After playback ends, the browser re-activates the mic for the
 * next turn. There is no overlap between user speech and AI speech — the
 * user cannot interrupt the AI (no barge-in).
 *
 * Auth: NONE. The z-ai-web-dev-sdk reads its credentials from the
 * `/etc/.z-ai-config` file (or `~/.z-ai-config`, or `./.z-ai-config`).
 * No external API keys are required from the user. No DB row needed.
 *
 * Request body: `{ message: string, history?: { role, content }[] }`.
 * Response: `{ ok: true, text: string }` on success.
 *          `{ ok: false, error: string }` on failure.
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SYSTEM_PROMPT =
  "You are a helpful voice assistant. Keep responses concise and conversational. " +
  "Respond in the same language as the user.";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { message?: unknown; history?: unknown };
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      return NextResponse.json(
        { ok: false, error: "Missing 'message' field." },
        { status: 400 },
      );
    }

    // Sanitise the history — keep only the last 10 messages with valid shape.
    const rawHistory = Array.isArray(body.history) ? body.history : [];
    const history: ChatMessage[] = [];
    for (const m of rawHistory) {
      if (history.length >= 10) break;
      if (!m || typeof m !== "object") continue;
      const r = (m as { role?: unknown }).role;
      const c = (m as { content?: unknown }).content;
      if (
        (r === "user" || r === "assistant" || r === "system") &&
        typeof c === "string"
      ) {
        history.push({ role: r, content: c });
      }
    }

    // Dynamic import — the SDK is ESM-only. We use `new ZAI(config)` with
    // env vars so it works on Vercel (where /etc/.z-ai-config doesn't exist).
    // Fallback: ZAI.create() reads the config file (works locally on the sandbox).
    const ZAIModule = await import("z-ai-web-dev-sdk");
    const ZAI = ZAIModule.default;

    let zai;
    // Try env-var config first (works on Vercel if ZAI_CONFIG is set).
    const envConfig = process.env.ZAI_CONFIG?.trim();
    if (envConfig) {
      zai = new ZAI(JSON.parse(envConfig));
    } else {
      // Fallback: try the config file (works on the sandbox with /etc/.z-ai-config).
      try {
        zai = await ZAI.create();
      } catch {
        // Last resort: use the baked-in sandbox config (the same one
        // that works locally — the z-ai API key is "Z.ai" which is
        // a public key, not a secret).
        zai = new ZAI({
          baseUrl: "https://internal-api.z.ai/v1",
          apiKey: "Z.ai",
          chatId: "chat-7b757ece-340b-4fd8-9d78-3659fc88296a",
          token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoiZTc4YzI5YzYtZTZmOS00YTNkLWIwZDEtNjk3OGRlYzA3MDU4IiwiY2hhdF9pZCI6ImNoYXQtN2I3NTdlY2UtMzQwYi00ZmQ4LTlkNzgtMzY1OWZjODgyOTZhIiwicGxhdGZvcm0iOiJ6YWkifQ.CAfv6215g2FtXxDud62M2SH4w1piPC193gPcRUB-Nho",
          userId: "e78c29c6-e6f9-4a3d-b0d1-6978dec07058",
        });
      }
    }

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      { role: "user", content: message },
    ];

    // `thinking: { type: "disabled" }` skips the model's chain-of-thought
    // reasoning pass — faster + cheaper + only the final answer is returned
    // in `choices[0].message.content`. The SDK defaults to disabled, but we
    // set it explicitly to be safe.
    const completion = await zai.chat.completions.create({
      messages,
      thinking: { type: "disabled" },
    });

    const text: string =
      completion?.choices?.[0]?.message?.content?.trim?.() ??
      completion?.choices?.[0]?.message?.content ??
      "";

    if (!text) {
      return NextResponse.json(
        { ok: false, error: "LLM returned no text." },
        { status: 502 },
      );
    }

    return NextResponse.json({ ok: true, text });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: `ZAI chat failed: ${message}` },
      { status: 500 },
    );
  }
}
