/**
 * Qwen Voice (qwen3.8-omni-flash-realtime) — SDP exchange route.
 *
 * Qwen Voice is the 5th realtime provider. Architecture (reverse-engineered
 * from the Qwen Omni SDK + the live chat.qwen.ai web client in Task 64):
 *   - Transport: WebRTC via Aliyun Bailian RTC (the SDP exchange goes
 *     through chat.qwen.ai, which proxies to Aliyun Bailian).
 *   - Protocol: OpenAI Realtime API events over a DataChannel named
 *     "oai-events" (same as ChatGPT — session.created, input_audio_buffer.*,
 *     response.output_audio_transcript.delta, etc.).
 *   - Auth: the browser POSTs the SDP offer here; this route forwards it
 *     to `POST https://chat.qwen.ai/api/v2/users/user/audio_chat_token`
 *     with `Authorization: Bearer <QWEN_ACCESS_TOKEN>` + the Qwen web
 *     client's headers (source=web, version=0.3.12, etc.). Qwen replies
 *     with `{ data: { sdp_token: "<answer SDP>" } }`, which we relay back
 *     to the browser as `{ sdp_token }` (the frontend accepts either
 *     `sdp` or `sdp_token`).
 *
 * No curl-impersonate / proxy needed — Qwen uses standard TLS + accepts
 * the bearer token directly. The access_token is a JWT (id + exp + iat)
 * that expires ~24h after issuance; the user must refresh it via the
 * Qwen login flow (or pass a fresh `refresh_token` and we'll exchange
 * it for a new access_token — not implemented yet, see follow-up note).
 *
 * Resolution order for the access_token:
 *   1. `process.env.QWEN_ACCESS_TOKEN` (set as a Vercel env var).
 *   2. (Future) vault Worker `GET /qwen/token` — same KV store as the
 *      other providers; lets the user set the token without a re-deploy.
 *
 * Returns: `{ sdp_token: string }` on success (the answer SDP).
 *          `{ error: string }` (4xx/5xx) on failure.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Qwen web client constants (captured from the live chat.qwen.ai site).
const QWEN_API_BASE = "https://chat.qwen.ai";
const QWEN_AUDIO_CHAT_TOKEN_PATH = "/api/v2/users/user/audio_chat_token";
const QWEN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/154.0.0.0 Safari/537.36";
const QWEN_VERSION = "0.3.12";

/** RFC4122-ish UUID using Web crypto (for the X-Request-Id header). */
function randomUuid(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0"));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h
    .slice(8, 10)
    .join("")}-${h.slice(10, 16).join("")}`;
}

/** Decode a JWT payload (base64url) → object. Returns null on failure. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    // base64url → base64 (replace -_ with +/, add padding).
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    // Use Buffer (Node.js) — atob may not be available in all runtimes.
    const json = Buffer.from(b64, "base64").toString("utf-8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Resolve the Qwen access_token — DB first (set via PUT /api/qwen/token),
 *  then env var fallback. The DB path lets the user set a fresh token
 *  without restarting the server (the token expires every ~15 min). */
async function resolveAccessToken(): Promise<string | null> {
  // 1. Try the DB (AppSettings.qwenAccessToken — set via PUT /api/qwen/token).
  try {
    const settings = await db.appSettings.findUnique({ where: { id: "singleton" } });
    const dbToken = (settings?.qwenAccessToken ?? "").trim();
    if (dbToken) return dbToken;
  } catch (err) {
    console.warn("[qwen] DB read failed, falling back to env:", (err as Error).message);
  }
  // 2. Fall back to the env var.
  const envToken = (process.env.QWEN_ACCESS_TOKEN ?? "").trim();
  if (envToken) return envToken;
  // 3. Future: vault Worker fallback (same pattern as Inworld/Perplexity).
  return null;
}

export async function POST(req: Request) {
  // 1. Parse the browser's SDP offer.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const sdp =
    typeof (body as Record<string, unknown>)?.sdp === "string"
      ? ((body as Record<string, unknown>).sdp as string).trim()
      : "";
  if (!sdp.startsWith("v=0")) {
    return NextResponse.json(
      { error: "Missing or invalid 'sdp' (must start with 'v=0')." },
      { status: 400 },
    );
  }

  // 2. Resolve the Qwen access_token (DB first, then env var).
  const accessToken = await resolveAccessToken();
  if (!accessToken) {
    return NextResponse.json(
      {
        error:
          "QWEN_ACCESS_TOKEN is not set. Set it as a Vercel env var " +
          "(or pass it via the vault Worker once that path is implemented). " +
          "The token is the JWT from chat.qwen.ai's `Authorization: Bearer` " +
          "header (decoded payload contains id + exp + iat).",
      },
      { status: 500 },
    );
  }

  // 3. Build the request body — matches the Qwen web client's payload:
  //    `{ sdp, client_info: { os_group, terminal_type: "web" } }`.
  //    The Qwen web client also sends `voice`, `chat_type`, `model` etc.
  //    in some flows, but the audio_chat_token endpoint accepts a minimal
  //    `{ sdp, client_info }` and applies sensible defaults
  //    (model: qwen3.8-omni-flash-realtime, voice: Tina, server_vad).
  const requestBody = JSON.stringify({
    sdp,
    client_info: {
      os_group: "pc",
      terminal_type: "web",
    },
  });

  // 4. Build the headers — matches the Qwen web client's headers
  //    (Authorization, source, version, X-Request-Id, browser headers).
  const requestId = randomUuid();
  const headers: Record<string, string> = {
    "User-Agent": QWEN_UA,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    Origin: QWEN_API_BASE,
    Referer: `${QWEN_API_BASE}/`,
    source: "web",
    version: QWEN_VERSION,
    "X-Request-Id": requestId,
    "bx-v": "2.5.37",
    "sec-ch-ua": '"Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
  };

  // 5. POST to chat.qwen.ai/api/v2/users/user/audio_chat_token.
  const upstreamUrl = `${QWEN_API_BASE}${QWEN_AUDIO_CHAT_TOKEN_PATH}`;
  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method: "POST",
      headers,
      body: requestBody,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to reach Qwen backend: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  // 6. Read the response — Qwen returns `{ data: { sdp_token: "..." } }`
  //    on success, or `{ code/msg/data }` on error.
  const responseText = await upstreamRes.text();
  if (!upstreamRes.ok) {
    return NextResponse.json(
      {
        error: `Qwen backend returned ${upstreamRes.status}: ${responseText.slice(0, 400)}`,
      },
      { status: upstreamRes.status },
    );
  }

  // Parse the JSON envelope.
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return NextResponse.json(
      { error: "Qwen response was not valid JSON.", raw: responseText.slice(0, 400) },
      { status: 502 },
    );
  }

  // Extract the Aliyun RTC credentials from the response.
  // The `/users/user/audio_chat_token` endpoint returns Aliyun Bailian
  // RTC channel credentials (NOT an SDP answer — `sdp_token` is always
  // null). The browser uses the Aliyun RTC SDK to join the channel with
  // these credentials:
  //   - token: the Aliyun RTC channel auth token
  //   - channel: the channel name (e.g. "rtc-channel-xxx")
  //   - app_id: the Aliyun Bailian app ID
  //   - gslb: the Aliyun RTC gateway URL (e.g. "https://gw.rtn.aliyuncs.com")
  //   - user_id_client / user_id_voicechat: the user IDs for the RTC session
  //   - sdp_token: always null (the Aliyun RTC SDK handles the WebRTC
  //     handshake internally, not via standard SDP exchange)
  //   - chat_id: the Qwen chat session ID (for the chat history)
  //   - times_left: remaining voice chat uses
  //   - audio_timeout: max session duration in seconds (600 = 10 min)
  const obj = parsed as Record<string, unknown>;
  const dataObj = (obj.data ?? obj) as Record<string, unknown> | undefined;
  if (!dataObj || !dataObj.token) {
    return NextResponse.json(
      {
        error: "Qwen response did not contain Aliyun RTC credentials (no 'token' field).",
        raw: responseText.slice(0, 600),
      },
      { status: 502 },
    );
  }

  // Return the full Aliyun RTC credentials to the browser. The browser
  // will use the Qwen Omni SDK (or Aliyun RTC SDK directly) to join the
  // channel with these credentials.
  return NextResponse.json({
    ok: true,
    // Aliyun RTC credentials (the browser uses these to join the channel).
    rtc_token: dataObj.token as string,
    rtc_channel: (dataObj.channel as string) ?? "",
    rtc_app_id: (dataObj.app_id as string) ?? "",
    rtc_gslb: (dataObj.gslb as string) ?? "",
    rtc_user_id_client: (dataObj.user_id_client as string) ?? "",
    rtc_user_id_voicechat: (dataObj.user_id_voicechat as string) ?? "",
    // Session metadata.
    chat_id: (dataObj.chat_id as string) ?? "",
    times_left: dataObj.times_left ?? null,
    audio_timeout: dataObj.audio_timeout ?? null,
    // sdp_token (always null for Qwen — kept for API compatibility).
    sdp_token: (dataObj.sdp_token as string | null) ?? null,
    sdp: (dataObj.sdp_token as string | null) ?? null,
    type: "answer",
  });
}

/** GET — quick health-check endpoint (returns the token status without
 *  exposing the token itself). Useful for the frontend to show whether
 *  Qwen is configured before the user clicks Connect. Also decodes the
 *  JWT exp to tell the user when the token expires. */
export async function GET() {
  const accessToken = await resolveAccessToken();
  // Decode the JWT exp (if it's a valid JWT) to show the expiry time.
  let exp: number | null = null;
  let expired = false;
  if (accessToken) {
    const decoded = decodeJwtPayload(accessToken);
    if (decoded && typeof decoded.exp === "number") {
      exp = decoded.exp;
      expired = Date.now() / 1000 > decoded.exp;
    }
  }
  return NextResponse.json({
    ok: !!accessToken && !expired,
    configured: !!accessToken,
    source: accessToken ? (await db.appSettings.findUnique({ where: { id: "singleton" } }))?.qwenAccessToken ? "db" : "env" : null,
    tokenMasked: accessToken ? `${accessToken.slice(0, 12)}…${accessToken.slice(-4)}` : null,
    exp,
    expired,
  });
}

/** PUT — store a fresh Qwen access_token in the DB (AppSettings).
 *  The token is a JWT that expires ~15 min after issuance. The user
 *  can set a fresh token by calling:
 *
 *    curl -X PUT http://localhost:3000/api/qwen/token \
 *      -H "Content-Type: application/json" \
 *      -d '{"token":"eyJhbGci..."}'
 *
 *  No restart needed — the next POST /api/qwen/token (SDP exchange)
 *  will pick up the new token from the DB.
 *
 *  Body: `{ token: string }` — the JWT from chat.qwen.ai's
 *  `Authorization: Bearer <token>` header.
 *
 *  Returns: `{ ok: true, tokenMasked: string, exp: number, expired: boolean }`. */
export async function PUT(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const token =
    typeof (body as Record<string, unknown>)?.token === "string"
      ? ((body as Record<string, unknown>).token as string).trim()
      : "";
  if (!token || token.length < 50) {
    return NextResponse.json(
      { error: "Missing or invalid 'token' (must be a non-empty JWT string)." },
      { status: 400 },
    );
  }

  // Decode the JWT exp to validate + show the expiry.
  let exp: number | null = null;
  let expired = false;
  const decoded = decodeJwtPayload(token);
  if (decoded) {
    if (decoded.type !== "access_token") {
      return NextResponse.json(
        { error: `Token type is "${decoded.type ?? "?"}", expected "access_token". Did you paste the refresh_token by mistake?` },
        { status: 400 },
      );
    }
    if (typeof decoded.exp === "number") {
      exp = decoded.exp;
      expired = Date.now() / 1000 > decoded.exp;
    }
  }
  // If decodeJwtPayload returned null, the token is not a valid JWT — accept
  // anyway (the Qwen backend will reject it if invalid).

  // Upsert the token in the AppSettings singleton.
  try {
    await db.appSettings.upsert({
      where: { id: "singleton" },
      update: { qwenAccessToken: token },
      create: { id: "singleton", qwenAccessToken: token },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to store token in DB: ${(err as Error).message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: !expired,
    tokenMasked: `${token.slice(0, 12)}…${token.slice(-4)}`,
    exp,
    expired,
    warning: expired
      ? "Token is already expired. Get a fresh one from chat.qwen.ai → DevTools → Network → Authorization: Bearer."
      : exp
      ? `Token expires at ${new Date(exp * 1000).toISOString()} (in ${Math.round((exp - Date.now() / 1000) / 60)} min).`
      : undefined,
  });
}

/** DELETE — clear the stored Qwen access_token from the DB. */
export async function DELETE() {
  try {
    await db.appSettings.update({
      where: { id: "singleton" },
      data: { qwenAccessToken: null },
    });
  } catch {
    // If the singleton doesn't exist yet, there's nothing to clear.
  }
  return NextResponse.json({ ok: true, cleared: true });
}
