import { NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const res = await fetch("https://internal-api.z.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer Z.ai",
      },
      body: JSON.stringify({
        model: "glm-4-flash",
        messages: [{ role: "user", content: "Hi" }],
      }),
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    return NextResponse.json({
      ok: true,
      status: res.status,
      body: text.slice(0, 500),
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      cause: err instanceof Error ? (err as Error & { cause?: Error }).cause?.message : null,
    });
  }
}
