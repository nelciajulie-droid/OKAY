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

/** Resolve the Qwen access_token from the env (future: vault fallback). */
function resolveAccessToken(): string | null {
  const envToken = (process.env.QWEN_ACCESS_TOKEN ?? "").trim();
  if (envToken) return envToken;
  // Future: vault Worker fallback (same pattern as Inworld/Perplexity).
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

  // 2. Resolve the Qwen access_token.
  const accessToken = resolveAccessToken();
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

  // Extract the sdp_token — try a few field paths for robustness.
  const obj = parsed as Record<string, unknown>;
  const dataObj = (obj.data ?? obj) as Record<string, unknown> | undefined;
  const sdpToken =
    (typeof dataObj?.sdp_token === "string" ? (dataObj.sdp_token as string) : "") ||
    (typeof dataObj?.sdp === "string" ? (dataObj.sdp as string) : "") ||
    (typeof obj.sdp_token === "string" ? (obj.sdp_token as string) : "");

  if (!sdpToken || sdpToken.length < 20) {
    return NextResponse.json(
      {
        error: "Qwen response did not contain a valid sdp_token.",
        raw: responseText.slice(0, 400),
      },
      { status: 502 },
    );
  }

  // 7. Return the answer SDP to the browser. The frontend accepts either
  //    `sdp` or `sdp_token` — return both for maximum compatibility.
  return NextResponse.json({ sdp_token: sdpToken, sdp: sdpToken, type: "answer" });
}

/** GET — quick health-check endpoint (returns the token status without
 *  exposing the token itself). Useful for the frontend to show whether
 *  Qwen is configured before the user clicks Connect. */
export async function GET() {
  const accessToken = resolveAccessToken();
  return NextResponse.json({
    ok: !!accessToken,
    configured: !!accessToken,
    source: "env",
    tokenMasked: accessToken ? `${accessToken.slice(0, 12)}…${accessToken.slice(-4)}` : null,
  });
}
