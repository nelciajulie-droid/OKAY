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

  // Build the payload. Per the theten.ai server source (github.com/
  // TEN-framework/ten-framework, `ai_agents/server/internal/http_server.go`
  // `StartReq` struct + the `startPropMap` in `config.go`), the server
  // ONLY accepts these top-level fields:
  //   request_id, channel_name, graph_name, user_uid, bot_uid, token,
  //   worker_http_server_port, properties, timeout, tenapp_dir
  // The top-level `language`, `voice_type`, `greeting`, `prompt` we sent
  // before are ALL IGNORED (the server's Go struct has no matching JSON
  // tags, and `startPropMap` only maps ChannelName/RemoteStreamId/
  // BotStreamId/Token/WorkerHttpServerPort to node properties).
  //
  // The ONLY way to configure the graph is via `properties` — a
  // `map[node_name]map[property_name]value`. The server iterates the
  // graph's nodes + for each node matching `node_name`, it MERGES the
  // provided property dict into the node's existing `property` map.
  //
  // Graph node names + property keys (verified from the open-source
  // `voice-assistant-realtime/tenapp/property.json` + tested against
  // theten.ai's `va_openai_v2v` graph):
  //   - node `v2v` (addon openai_mllm_python / azure_mllm_python):
  //       language (ISO 639-1 like "fr", or BCP-47 "en-US"),
  //       voice (the OpenAI voice name, e.g. "alloy"),
  //       prompt (the system instructions — yes, `v2v.prompt` IS a
  //         real field in OpenAIRealtimeConfig + AzureRealtimeConfig,
  //         sent to the Realtime API session.update instructions),
  //       temperature, model, max_tokens, vad_type, vad_eagerness, ...
  //   - node `main_control` (addon main_python): greeting (the first
  //       spoken line). NO prompt field on main_control.
  //
  // So we send:
  //   properties.v2v.language = the STT language (ISO 639-1 for non-native
  //     languages like "fr", or BCP-47 "en-US" for native).
  //   properties.v2v.prompt = the system instructions (Nelth-IA persona).
  //   properties.main_control.greeting = the first spoken line.
  //
  // We ALSO still send the top-level `language` + `voice_type` for
  // backwards compatibility (in case the server's deployment has a
  // custom build that reads them — the open-source build ignores them,
  // but theten.ai's deployment may differ). The `properties` override
  // takes precedence in the graph (the server MERGES it into the node's
  // default property dict, replacing existing values).
  //
  // For native languages (en-US, zh-CN, ja-JP, ko-KR), we still send
  // `properties.v2v.language` with the BCP-47 value — the graph's
  // default is "en"/"en-US", so for zh-CN/ja-JP/ko-KR we MUST override
  // or the STT will default to English. (Previously the top-level
  // `language` was the ONLY signal — which the server ignored — so
  // zh-CN/ja-JP/ko-KR likely also didn't work before this fix!)
  const graphName = (body.graph_name as string) || "va_azure_v2v";
  const topLanguage = (body.language as string) || "en-US";
  const voiceType = (body.voice_type as string) || "male";
  const v2vLanguage = typeof body.v2v_language === "string" ? body.v2v_language.trim() : "";
  // The v2v.language: use the v2v override if provided (non-native
  // languages like "fr"), else fall back to the top-level language (for
  // native languages like "en-US" / "zh-CN" / "ja-JP" / "ko-KR"). This
  // ensures zh-CN/ja-JP/ko-KR also override the graph's "en" default.
  const v2vLangFinal = v2vLanguage || topLanguage;
  const greeting = typeof body.greeting === "string" ? body.greeting.trim() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

  const payload: Record<string, unknown> = {
    request_id: crypto.randomUUID(),
    channel_name: channelName,
    user_uid: userUid,
    graph_name: graphName,
    // Backwards-compat top-level fields (server ignores them in the
    // open-source build, but theten.ai's deployment may differ).
    language: topLanguage,
    voice_type: voiceType,
  };

  // Build the `properties` override. Node names: `v2v` (the
  // openai_mllm_python / azure_mllm_python node) + `main_control` (the
  // main_python node with the greeting). Per the server source, the
  // `properties` object must be `map[node_name]map[property_name]value`
  // — flat keys are rejected with `code:"10000", msg:"params invalid"`.
  const properties: Record<string, Record<string, unknown>> = {};
  // v2v node: language + prompt + voice. The `voice` field on
  // openai_mllm_python is the OpenAI voice NAME (e.g. "alloy", "ash",
  // "ballad", "coral", "echo", "nova", "sage", "shimmer", "verse") —
  // NOT "male"/"female". theten.ai's graph default voice is "alloy".
  // We don't currently expose voice selection in the TEN UI dropdown
  // (only "male"/"female"), so we leave the voice to the graph default.
  // (The openai_mllm voice is already a specific male/female voice —
  // "male"/"female" aren't valid OpenAI voice names.)
  const v2vProps: Record<string, unknown> = {};
  if (v2vLangFinal) v2vProps.language = v2vLangFinal;
  if (prompt) v2vProps.prompt = prompt;
  if (Object.keys(v2vProps).length > 0) properties.v2v = v2vProps;
  // main_control node: greeting (the first spoken line).
  if (greeting) properties.main_control = { greeting };
  if (Object.keys(properties).length > 0) payload.properties = properties;

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
