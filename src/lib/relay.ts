/**
 * Optional relay forwarding (server-side only).
 *
 * Cloudflare challenges datacenter IPs on some origins. When a relay is
 * configured (Settings or env TREBLO_RELAY_URL / TREBLO_RELAY_SECRET), every
 * upstream request is forwarded through it (see mini-services/treblo-relay —
 * a tiny Bun service meant to run on a trusted IP, e.g. a home connection).
 *
 * Wire protocol (unchanged): POST {relay}/fetch with header x-relay-secret
 * and body { url, method, headers, bodyBase64?, range? } → upstream response
 * (status + selected headers + body). Relay-side failures: x-relay-error: 1.
 */

import { db } from "@/lib/db";

export interface RelayConfig {
  url: string;
  secret: string | null;
}

async function readConfigValue(key: "relayUrl" | "relaySecret"): Promise<string> {
  try {
    const settings = await db.appSettings.findUnique({ where: { id: "singleton" } });
    const fromDb = settings?.[key]?.trim();
    if (fromDb) return fromDb;
  } catch {
    // DB unavailable — fall through to env.
  }
  return (key === "relayUrl"
    ? process.env.TREBLO_RELAY_URL
    : process.env.TREBLO_RELAY_SECRET
  )?.trim() ?? "";
}

/** Effective relay config: DB settings take precedence over env vars. */
export async function getRelay(): Promise<RelayConfig | null> {
  const [url, secret] = await Promise.all([
    readConfigValue("relayUrl"),
    readConfigValue("relaySecret"),
  ]);
  if (!url) return null;
  return { url, secret: secret || null };
}

/**
 * Send a request through the configured relay (POST {relay}/fetch).
 * The relay returns the upstream response as-is (status + selected headers +
 * body). Relay-side failures come back with `x-relay-error: 1` and are
 * converted into thrown Errors here.
 */
export async function viaRelay(
  relay: RelayConfig,
  targetUrl: string,
  options: { method: string; headers: Record<string, string>; body?: string; range?: string | null },
): Promise<Response> {
  const payload: Record<string, unknown> = {
    url: targetUrl,
    method: options.method,
    headers: options.headers,
  };
  if (options.body) payload.bodyBase64 = Buffer.from(options.body, "utf8").toString("base64");
  if (options.range) payload.range = options.range;

  const res = await fetch(`${relay.url.replace(/\/+$/, "")}/fetch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(relay.secret ? { "x-relay-secret": relay.secret } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  });

  if (res.headers.get("x-relay-error")) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(`Relay error: ${data?.error ?? `relay responded ${res.status}`}`);
  }
  return res;
}
