import { NextResponse } from "next/server";
import { BoppyError, composeLyrics } from "@/lib/boppy";

/**
 * POST /api/lyrics — proxy for boppy.me's AI lyrics composer
 * (POST /api/llm/compose). Body: { prompt, language?, boost? }
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

  try {
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
