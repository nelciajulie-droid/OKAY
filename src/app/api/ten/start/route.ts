/**
 * TEN Agent — start the AI voice assistant graph.
 *
 * Proxies to `https://agent.theten.ai/api/agents/start` server-side
 * (the browser cannot POST cross-origin to agent.theten.ai — CORS).
 *
 * ══════════════════════════════════════════════════════════════════
 * HOW theten.ai ACTUALLY WORKS (verified against the TEN framework
 * source, github.com/TEN-framework/ten-framework, `ai_agents/` —
 * `examples/demo/frontend/src/app/api/agents/start/route.ts` +
 * `graph.ts` + `server/internal/http_server.go`):
 *
 *  1. `agent.theten.ai/api/agents/start` is NOT the Go agent server —
 *     it is the demo **Next.js route**. It destructures top-level
 *     `language`, `voice_type`, `prompt`, `greeting`, `properties`
 *     from our body and REBUILDS a `properties` object via
 *     `getGraphProperties(graph_name, language, voice_type, …)`,
 *     then merges OUR `properties` on top (shallow spread) and
 *     forwards everything to the internal Go server `/start`.
 *
 *  2. The Go server's `StartReq` only reads `request_id`,
 *     `channel_name`, `graph_name`, `user_uid`, `bot_uid`, `token`,
 *     `worker_http_server_port`, `properties`, `timeout`. Top-level
 *     `language` / `voice_type` / `prompt` / `greeting` are NEVER
 *     seen by the Go server — the ONLY way to configure the graph is
 *     `properties: map[node_name]map[property_name]value`, merged
 *     into the graph's property.json before launch.
 *
 *  3. The Next.js route REQUIRES a valid top-level `language` (one
 *     of en-US / zh-CN / ja-JP / ko-KR) — anything else makes
 *     `voiceNameMap[language].openai` throw a TypeError → HTTP 500.
 *     (This is why top-level "fr-FR" failed before — NOT a server
 *     whitelist.) We always send a valid 4-value top-level language.
 *
 *  4. Graph node names (from `examples/demo/tenapp/property.json`):
 *       - `v2v` — openai_mllm_python (va_openai_v2v) or
 *         azure_mllm_python (va_azure_v2v). Properties: `language`,
 *         `voice` (OpenAI voice name) / `voice_name` (Azure neural
 *         voice), `prompt` (→ Realtime API `instructions`).
 *       - `main_control` — main_realtime_python. Property:
 *         `greeting` (first spoken line).
 *
 *  5. ⚠️ theten.ai rejects request bodies **> 4,096 bytes** with
 *     HTTP 403 + EMPTY body (binary-searched: 4,070 B → 200,
 *     4,170 B → 403). The prompt is therefore sent ONCE, inside
 *     `properties.v2v.prompt` — top-level `prompt` / `greeting` are
 *     NOT forwarded (they would duplicate the bytes for nothing).
 *
 *  6. Language formats per graph (from the addons' source):
 *       - va_openai_v2v → `v2v.language` = ISO 639-1 ("en", "fr",
 *         "zh"…) — passed to `input_audio_transcription.language`
 *         of the OpenAI Realtime session (gpt-4o-transcribe /
 *         Whisper — 90+ languages). BCP-47 like "en-US" is INVALID
 *         there, so we always strip the region.
 *       - va_azure_v2v → `v2v.language` = BCP-47 ("en-US",
 *         "fr-FR"…). NOTE: azure_mllm_python defines the field but
 *         never reads it (Azure auto-detects speech language); what
 *         matters is `voice_name` + the prompt (response language).
 *
 * ══════════════════════════════════════════════════════════════════
 *
 * Request body (from our client):
 *   `{ channel_name, user_uid, graph_name, language, voice_type,
 *      greeting?, prompt? }`
 *   - `language` — the TEN_LANGUAGES dropdown value: a BCP-47 tag
 *     (en-US, zh-CN, ja-JP, ko-KR) or an ISO 639-1 code (fr, es…).
 *   - `voice_type` — "male" | "female".
 *
 * Response: `{ ok, status, upstream }` — `upstream` is the raw JSON
 * from theten.ai on success; on failure `upstream` is `{raw:""}`
 * (403 = body too large / rate-limit) or an error code/message.
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TEN_START_URL = "https://agent.theten.ai/api/agents/start";

/** theten.ai hard body limit — requests larger than this get 403. */
const TEN_BODY_LIMIT = 4096;

/** Top-level languages the demo Next.js route accepts (voiceNameMap
 * keys). Anything else → TypeError → HTTP 500. Non-native dropdown
 * languages are sent as "en-US" at the top level (the graph-level
 * `v2v.language` override is what actually selects the language). */
const TOP_LEVEL_LANGUAGES = new Set(["en-US", "zh-CN", "ja-JP", "ko-KR"]);

/** OpenAI Realtime voices — the official demo maps male → "ash",
 * female → "shimmer" (graph.ts `voiceNameMap[lang].openai`). Both are
 * language-neutral (gpt-realtime speaks 90+ languages with any voice). */
const OPENAI_VOICE = { male: "ash", female: "shimmer" } as const;

/** Azure Multilingual neural voices per dropdown language. The
 * Multilingual voices (Andrew / Ava / Remy / Vivienne / Yunyi /
 * Xiaoxiao…) each speak ~29 locales — French, English, Italian,
 * Spanish, German, Portuguese, Russian, Arabic, Hindi… — so they
 * cover all our non-native languages even though their own locale
 * prefix is different. Male / female per the official demo mapping. */
const AZURE_VOICES: Record<string, { male: string; female: string }> = {
  "en-US": { male: "en-US-AndrewMultilingualNeural", female: "en-US-AvaMultilingualNeural" },
  "zh-CN": { male: "zh-CN-YunyiMultilingualNeural", female: "zh-CN-XiaoxiaoMultilingualNeural" },
  "ja-JP": { male: "ja-JP-KeitaNeural", female: "ja-JP-NanamiNeural" },
  "ko-KR": { male: "ko-KR-InJoonNeural", female: "ko-KR-JiMinNeural" },
  // French — dedicated fr-FR Multilingual voices (male Remy / female Vivienne)
  fr: { male: "fr-FR-RemyMultilingualNeural", female: "fr-FR-VivienneMultilingualNeural" },
};

/** Fallback Azure voice for languages without a dedicated entry —
 * the en-US Multilingual pair speaks ~29 locales (es, de, it, pt,
 * nl, ru, ar, hi, tr, pl, id…), making it the safest default. */
const AZURE_VOICE_FALLBACK = {
  male: "en-US-AndrewMultilingualNeural",
  female: "en-US-AvaMultilingualNeural",
};

/** BCP-47 mapping for the Azure graph's (informational) `language`
 * field — azure_mllm_python never reads it (auto-detection), but we
 * keep it well-formed for forward compatibility. */
const AZURE_BCP47: Record<string, string> = {
  en: "en-US", zh: "zh-CN", ja: "ja-JP", ko: "ko-KR", fr: "fr-FR",
  es: "es-ES", de: "de-DE", it: "it-IT", pt: "pt-BR", nl: "nl-NL",
  ru: "ru-RU", ar: "ar-SA", hi: "hi-IN", tr: "tr-TR", pl: "pl-PL",
  sv: "sv-SE", id: "id-ID", vi: "vi-VN", th: "th-TH", mg: "fr-FR",
};

/** Convert a TEN_LANGUAGES dropdown value to ISO 639-1 for the
 * OpenAI graph's `v2v.language` (input_audio_transcription.language
 * requires ISO 639-1 — "en-US" would be rejected by the Realtime
 * session.update). "en-US" → "en", "fr" → "fr", "mg" → "mg". */
function toIso6391(value: string): string {
  return value.split("-")[0].toLowerCase();
}

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
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

  // ── Client config ────────────────────────────────────────────────
  const graphName = (body.graph_name as string) || "va_openai_v2v";
  // The TEN_LANGUAGES dropdown value — either a native BCP-47 tag
  // (en-US…) or an ISO 639-1 code (fr, es…).
  const langValue = (body.language as string) || "en-US";
  const voiceType = (body.voice_type as string) === "female" ? "female" : "male";
  const greeting = typeof body.greeting === "string" ? body.greeting.trim() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

  // Top-level language MUST be one of the 4 voiceNameMap keys or the
  // demo Next.js route throws (HTTP 500). For non-native languages we
  // send "en-US" here — the graph-level v2v.language override below
  // is what actually selects French etc.
  const topLevelLanguage = TOP_LEVEL_LANGUAGES.has(langValue) ? langValue : "en-US";

  // ── Build `properties` — the ONLY config theten.ai applies ──────
  const properties: Record<string, Record<string, unknown>> = {};

  if (graphName === "va_azure_v2v") {
    // Azure OpenAI voice assistant — azure_mllm_python:
    //   voice_name = the Azure neural voice (drives TTS language),
    //   language   = BCP-47 (informational — the addon never reads
    //                it; Azure auto-detects the spoken language),
    //   prompt     = Realtime instructions (drives response language).
    const voices = AZURE_VOICES[langValue] ?? AZURE_VOICE_FALLBACK;
    const v2vProps: Record<string, unknown> = {
      voice_name: voices[voiceType],
      language: AZURE_BCP47[toIso6391(langValue)] ?? topLevelLanguage,
    };
    if (prompt) v2vProps.prompt = prompt;
    properties.v2v = v2vProps;
  } else {
    // va_openai_v2v (and _mini) — openai_mllm_python:
    //   language = ISO 639-1 → input_audio_transcription.language
    //              (gpt-4o-transcribe / Whisper — 90+ languages),
    //   voice    = OpenAI Realtime voice name (ash / shimmer —
    //              language-neutral),
    //   prompt   = Realtime instructions (drives response language).
    const v2vProps: Record<string, unknown> = {
      language: toIso6391(langValue),
      voice: voiceType === "female" ? OPENAI_VOICE.female : OPENAI_VOICE.male,
    };
    if (prompt) v2vProps.prompt = prompt;
    properties.v2v = v2vProps;
  }

  // main_control (main_realtime_python) — the first spoken line.
  if (greeting) properties.main_control = { greeting };

  // ── Assemble the payload ─────────────────────────────────────────
  // Top-level `language` + `voice_type` are REQUIRED (the demo route
  // indexes voiceNameMap[language][voiceType] before merging our
  // properties). Top-level `prompt` / `greeting` are deliberately
  // NOT sent — they'd double the body size for zero effect.
  const payload: Record<string, unknown> = {
    request_id: crypto.randomUUID(),
    channel_name: channelName,
    user_uid: userUid,
    graph_name: graphName,
    language: topLevelLanguage,
    voice_type: voiceType,
    properties,
  };

  // ── 4,096-byte body guard ────────────────────────────────────────
  // theten.ai returns 403 + empty body above this size. Fail fast
  // with an actionable message instead of a silent agent-start miss.
  const bodyBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (bodyBytes > TEN_BODY_LIMIT) {
    return NextResponse.json(
      {
        ok: false,
        error:
          `Prompt too long — the full request body is ${bodyBytes.toLocaleString()} bytes ` +
          `but theten.ai rejects anything over ${TEN_BODY_LIMIT.toLocaleString()} bytes ` +
          `(HTTP 403, empty body). Shorten the Prompt in the TEN settings panel ` +
          `(~${Math.max(0, TEN_BODY_LIMIT - (bodyBytes - Buffer.byteLength(JSON.stringify(prompt), "utf8")) - 100).toLocaleString()} bytes max) and reconnect.`,
      },
      { status: 413 },
    );
  }

  try {
    const res = await fetch(TEN_START_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });

    // Pass the upstream response through unchanged so the client can
    // inspect the exact code/msg. `ok` mirrors the upstream HTTP
    // status — the client checks BOTH `ok === false` (403/5xx) and
    // the failure codes in `upstream.code`.
    let upstream: Record<string, unknown> = {};
    try {
      upstream = (await res.json()) as Record<string, unknown>;
    } catch {
      upstream = { raw: await res.text().catch(() => "") };
    }

    return NextResponse.json({
      ok: res.ok,
      status: res.status,
      bodyBytes,
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
