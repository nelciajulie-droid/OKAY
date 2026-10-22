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
 *      language?: string, voice_type?: string }`
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

  // Defaults match the original browser-side request body in connectTen.
  const payload = {
    request_id: crypto.randomUUID(),
    channel_name: channelName,
    user_uid: userUid,
    graph_name: (body.graph_name as string) || "va_azure_v2v",
    language: (body.language as string) || "en-US",
    voice_type: (body.voice_type as string) || "male",
  };

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
