import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * GET /api/settings — relay status (never returns the raw secret) + the
 * optional custom API endpoint + the optional FireProx endpoint.
 * boppy.me needs no credentials.
 */
export async function GET() {
  const settings = await db.appSettings.findUnique({ where: { id: "singleton" } });

  const relayUrl = settings?.relayUrl?.trim() || process.env.TREBLO_RELAY_URL?.trim() || "";
  const hasRelaySecret = Boolean(
    settings?.relaySecret?.trim() || process.env.TREBLO_RELAY_SECRET?.trim(),
  );

  return NextResponse.json({
    relayUrl: relayUrl || null,
    hasRelaySecret,
    apiBaseUrl: settings?.apiBaseUrl?.trim() || null,
    fireproxUrl: settings?.fireproxUrl?.trim() || process.env.BOPPY_FIREPROX_URL?.trim() || null,
  });
}

/**
 * PUT /api/settings — update the relay / API endpoint / FireProx config.
 * Body: { relayUrl?, relaySecret?, apiBaseUrl?, fireproxUrl? }
 *   - undefined  → keep existing value
 *   - null       → clear value
 *   - string     → set value
 */
export async function PUT(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const data: {
    relayUrl?: string | null;
    relaySecret?: string | null;
    apiBaseUrl?: string | null;
    fireproxUrl?: string | null;
  } = {};

  if ("relayUrl" in body) {
    data.relayUrl = typeof body.relayUrl === "string" ? body.relayUrl.trim() || null : null;
  }
  if ("relaySecret" in body) {
    data.relaySecret =
      typeof body.relaySecret === "string" ? body.relaySecret.trim() || null : null;
  }
  if ("apiBaseUrl" in body) {
    const raw = typeof body.apiBaseUrl === "string" ? body.apiBaseUrl.trim() : "";
    if (raw && !/^https?:\/\//i.test(raw)) {
      return NextResponse.json(
        { error: "API endpoint must start with http:// or https://." },
        { status: 400 },
      );
    }
    data.apiBaseUrl = raw || null;
  }
  if ("fireproxUrl" in body) {
    const raw = typeof body.fireproxUrl === "string" ? body.fireproxUrl.trim() : "";
    if (raw && !/^https?:\/\//i.test(raw)) {
      return NextResponse.json(
        { error: "FireProx URL must start with http:// or https://." },
        { status: 400 },
      );
    }
    data.fireproxUrl = raw || null;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "No settings fields provided." }, { status: 400 });
  }

  await db.appSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", ...data },
    update: data,
  });

  return NextResponse.json({ ok: true });
}
