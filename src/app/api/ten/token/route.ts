/**
 * TEN Agent — token generation route.
 *
 * Proxies to https://agent.theten.ai/api/token/generate (which proxies to
 * astra-agents-api.agora.io/token/generate). Returns the Agora RTC appId +
 * token needed to join the voice channel.
 *
 * Body: `{ channel?: string, uid?: number }`
 * Response: `{ ok: true, appId, token, channel, uid }` on success.
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TEN_TOKEN_URL = "https://agent.theten.ai/api/token/generate";

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // empty body is OK — we'll generate defaults
  }

  const channel = (body.channel as string) || `ten-${Date.now()}`;
  const uid = (body.uid as number) || Math.floor(Math.random() * 1000000);

  try {
    const res = await fetch(TEN_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: crypto.randomUUID(),
        uid,
        channel_name: channel,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const data = (await res.json()) as {
      code?: string;
      data?: { appId?: string; token?: string; channel_name?: string; uid?: number };
      msg?: string;
    };

    if (String(data.code) !== "0" || !data.data?.token) {
      return NextResponse.json(
        { ok: false, error: data.msg ?? "TEN token generation failed." },
        { status: 502 },
      );
    }

    return NextResponse.json({
      ok: true,
      appId: data.data.appId,
      token: data.data.token,
      channel: data.data.channel_name ?? channel,
      uid: data.data.uid ?? uid,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `Failed to reach TEN Agent: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}

/** GET — quick health check. */
export async function GET() {
  return NextResponse.json({ ok: true, service: "TEN Agent (theten.ai)" });
}

