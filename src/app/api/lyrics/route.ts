import { NextResponse } from "next/server";
import { BoppyError, composeLyrics, getProvider } from "@/lib/boppy";

/**
 * POST /api/lyrics — proxy for the AI lyrics composer.
 * Routes to:
 *   • boppy.me (POST /api/llm/compose) when provider="boppy" (default)
 *   • acemusic.ai (POST /engine/api/engine/create_random_sample) when provider="ace"
 *
 * Body: { prompt, language?, boost? }
 * → 200 { title, lyrics, caption, promptId } | 4xx/502 { error, retryAfter? }
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;

  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return NextResponse.json({ error: "A prompt is required." }, { status: 400 });
  }

  const language = typeof body?.language === "string" && body.language.trim() ? body.language.trim() : undefined;
  const boost = typeof body?.boost === "boolean" ? body.boost : undefined;

  const provider = await getProvider();

  try {
    if (provider === "ace") {
      // ACE provider: acemusic.ai doesn't have a separate "compose" endpoint —
      // the prompt goes directly to the generation step. We return a simple
      // derived title (first line of prompt) + caption (prompt) so the UI's
      // "Generate with AI" button fills the form fields the same way it does
      // for boppy. The actual generation happens in POST /api/generate.
      const title = prompt.length > 60 ? prompt.slice(0, 60).trim() + "…" : prompt;
      return NextResponse.json({
        title,
        lyrics: null,
        caption: prompt,
        promptId: null,
      });
    }
    // boppy.me (default)
    const result = await composeLyrics({ prompt, language, boost });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof BoppyError) {
      const payload: Record<string, unknown> = { error: err.message };
      if (err.code) payload.code = err.code;
      if (err.retryAfter !== undefined) payload.retryAfter = err.retryAfter;
      if (err.kind) payload.kind = err.kind;
      return NextResponse.json(payload, {
        status: err.status === 429 ? 429 : 502,
      });
    }
    const message = err instanceof Error ? err.message : "Lyrics composition failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

