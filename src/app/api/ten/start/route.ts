/**
 * TEN Agent — start the AI voice assistant graph.
 *
 * Proxies to `https://agent.theten.ai/api/agents/start`. We do this
 * server-side (instead of from the browser) because:
 *   1. **CORS** — the browser cannot make cross-origin POST requests to
 *      `agent.theten.ai` from our origin (localhost:3000 or the Vercel
 *      domain). The fetch fails with a generic "Failed to fetch"
 *      network error. Moving the call to a same-origin Next.js route
 *      eliminates the CORS issue (server-to-server requests are not
 *      subject to CORS).
 *   2. **Consistency** — matches the pattern already used by the
 *      sibling `/api/ten/token` route (which proxies
 *      `agent.theten.ai/api/token/generate`).
 *
 * Body (forwarded to agent.theten.ai with a fresh `request_id`):
 *   `{ channel_name: string, user_uid: number, graph_name?: string,
 *      language?: string, voice_type?: string, greeting?: string,
 *      prompt?: string, v2v_language?: string }`
 *
 * The `greeting` + `prompt` fields configure the AI persona's first
 * spoken line + system instructions — they correspond to the
 * "Greeting" + "Prompt" fields in the theten.ai Settings panel. We
 * send them as TOP-LEVEL fields. Empty / missing fields = use the
 * graph defaults (the theten.ai labels say "leave it blank if you
 * want to use default one").
 *
 * The `v2v_language` field (ISO 639-1 code, e.g. "fr", "es", "de") is
 * forwarded to theten.ai as `properties.v2v.language` — this BYPASSES
 * the top-level `language` whitelist (which only accepts en-US, zh-CN,
 * ja-JP, ko-KR). The graph definition shows the `v2v` node (using
 * `openai_mllm_python` — gpt-realtime + Whisper-1 STT) has a `language`
 * property. Whisper-1 supports 90+ languages. Tested directly:
 * fr/es/de/it/pt → 200 success on `va_openai_v2v`. Only works on
 * `va_openai_v2v` (the client auto-switches to that graph when
 * v2v_language is non-empty). When v2v_language is empty/absent, the
 * route does NOT send a `properties` object (the top-level `language`
 * is used directly — must be one of the 4 whitelisted values).
 *
 * NOTE: theten.ai rejects a FLAT `properties.language` string with
 * `code:"10000", msg:"params invalid"` — the `properties` object MUST
 * be a dict of dicts (node_name → property_dict). We build it
 * carefully: `properties: { v2v: { language: "<ISO 639-1>" } }`.
 *
 * Response: the raw JSON returned by agent.theten.ai (passed through
 * unchanged) on success, or `{ ok: false, error }` on failure.
 *
 * This route is fire-and-forget from the client's perspective — the
 * caller (`connectTen` in page.tsx) treats any failure as non-fatal
 * (some TEN graphs auto-start on channel join).
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TEN_START_URL = "https://agent.theten.ai/api/agents/start";

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // empty body is NOT acceptable here — we need at least channel_name + user_uid
    return NextResponse.json(
      { ok: false, error: "Missing JSON body. Expected { channel_name, user_uid }." },
      { status: 400 },
    );
  }

  const channelName = body.channel_name as string | undefined;
  const userUid = body.user_uid as number | undefined;

  if (!channelName || typeof userUid !== "number") {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Missing required fields. Expected { channel_name: string, user_uid: number }.",
      },
      { status: 400 },
    );
  }

  // Build the payload. Core fields always present; optional greeting /
  // prompt forwarded only when the client sent a non-empty value (so
  // we don't pollute the body with empty strings + override graph
  // defaults — the theten.ai labels say "leave it blank to use the
  // default"). We send them as TOP-LEVEL `greeting` / `prompt` ONLY.
  // IMPORTANT: theten.ai REJECTS a nested `properties` object with
  // `code:"10000", msg:"params invalid"` (tested directly against
  // agent.theten.ai/api/agents/start). So we do NOT add a `properties`
  // field — only the top-level `greeting` + `prompt` are accepted.
  //
  // `language`: theten.ai REQUIRES a non-empty BCP-47 language tag —
  // tested directly against agent.theten.ai/api/agents/start:
  //   - "en-US" / "zh-CN" / "ja-JP" / "ko-KR" → 200 success
  //   - "" (empty string)                   → 500
  //   - field OMITTED                        → 500
  //   - "auto" / "multilingual"             → 500
  //   - "fr-FR" / "es-ES" / "de-DE" / etc.   → 500 (unsupported)
  // So there is NO auto-detect multilingual mode via the public API —
  // the STT filter is mandatory and must be one of the 4 supported
  // languages. For French (or any unsupported language), users should
  // use the ZAI provider instead (it uses the Web Speech API which
  // respects navigator.language → a French browser transcribes French).
  // We default to "en-US" if the field is missing/empty (backwards
  // compat with the previous hardcoded behavior). The UI dropdown only
  // offers the 4 supported languages, so the client always sends a
  // valid value.
  const payload: Record<string, unknown> = {
    request_id: crypto.randomUUID(),
    channel_name: channelName,
    user_uid: userUid,
    graph_name: (body.graph_name as string) || "va_azure_v2v",
    language: (body.language as string) || "en-US",
    voice_type: (body.voice_type as string) || "male",
  };

  // Top-level greeting + prompt (only if non-empty). We IGNORE any
  // `properties` object the client sent directly (theten.ai rejects a
  // client-supplied `properties` object with `code:"10000", msg:"params
  // invalid"` for flat keys — but ACCEPTS a nested `properties.v2v`
  // object — see the v2v_language override below).
  const greeting = typeof body.greeting === "string" ? body.greeting.trim() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (greeting) payload.greeting = greeting;
  if (prompt) payload.prompt = prompt;

  // `v2v_language` — the ISO 639-1 code (e.g. "fr", "es", "de") for the
  // `properties.v2v.language` override. This BYPASSES the top-level
  // `language` whitelist (which only accepts en-US, zh-CN, ja-JP, ko-KR).
  // The graph definition (github.com/TEN-framework/ten-framework,
  // `voice-assistant-realtime/tenapp/property.json`) shows the `v2v`
  // node (using `openai_mllm_python` — gpt-realtime + Whisper-1 STT)
  // has a `language` property. Whisper-1 supports 90+ languages. The
  // theten.ai server validates the `properties` STRUCTURE (node_name →
  // property_dict) but NOT the values — so any ISO 639-1 code is
  // accepted (tested directly: fr/es/de/it/pt → 200 success on
  // `va_openai_v2v`). Only works on `va_openai_v2v` (the client
  // auto-switches to that graph when v2v_language is non-empty).
  // IMPORTANT: theten.ai rejects a FLAT `properties.language` string
  // with `code:"10000", msg:"params invalid"` — the properties object
  // MUST be a dict of dicts (node_name → property_dict). We build it
  // carefully: `properties: { v2v: { language: "<ISO 639-1>" } }`.
  const v2vLanguage = typeof body.v2v_language === "string" ? body.v2v_language.trim() : "";
  if (v2vLanguage) {
    payload.properties = { v2v: { language: v2vLanguage } };
  }

  try {
    const res = await fetch(TEN_START_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });

    // Pass the upstream response through unchanged so the client can
    // inspect the exact code/msg if it wants. Wrap in `ok` for parity
    // with the sibling /api/ten/token route's envelope.
    let upstream: Record<string, unknown> = {};
    try {
      upstream = (await res.json()) as Record<string, unknown>;
    } catch {
      upstream = { raw: await res.text().catch(() => "") };
    }

    return NextResponse.json({
      ok: res.ok,
      status: res.status,
      upstream,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: `Failed to reach TEN Agent start endpoint: ${(err as Error).message}`,
      },
      { status: 502 },
    );
  }
}

/** GET — quick health check. */
export async function GET() {
  return NextResponse.json({ ok: true, service: "TEN Agent start proxy" });
}
