/**
 * treblo-relay — tiny forwarding relay for Treblo Studio.
 *
 * WHY: treblo.com sits behind Cloudflare, which challenges datacenter IPs
 * (403 HTML). A Cloudflare Worker does NOT help (cf_clearance is bound to the
 * IP that solved the challenge, and Worker egress is still challenged). The
 * reliable free path is to forward requests through a machine on a *trusted*
 * IP — typically your home connection, the same one your browser session
 * (and its cf_clearance cookie) comes from.
 *
 * RUN IT AT HOME:
 *   bun install          (no dependencies needed)
 *   RELAY_SECRET=choose-a-secret bun run dev
 *   → listens on http://0.0.0.0:8787
 * Expose it with your preferred tunnel (Tailscale, WireGuard, SSH reverse
 * tunnel, Cloudflare Tunnel...) and put its public URL + secret in
 * Treblo Studio → Settings → Relay.
 *
 * PROTOCOL (called only by your Treblo Studio backend):
 *   GET  /health → { ok: true }
 *   POST /fetch  { url, method, headers, bodyBase64?, range? } + header
 *                x-relay-secret
 *              → forwards to `url` and returns the upstream response
 *                (status + selected headers + streamed body).
 *                Relay-side failures: status 5xx + header x-relay-error: 1
 *                + JSON { error }.
 */

const PORT = 8787;
const SECRET = process.env.RELAY_SECRET ?? "";

// Headers we accept from the caller and forward to the upstream.
const FORWARDABLE_REQUEST_HEADERS = [
  "range",
  "authorization",
  "cookie",
  "accept",
  "user-agent",
  "origin",
  "referer",
  "content-type",
];

// Upstream response headers we pass back to the caller.
const FORWARDABLE_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
  "cache-control",
];

function relayError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json", "x-relay-error": "1" },
  });
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, secret: Boolean(SECRET) });
    }

    if (req.method !== "POST" || url.pathname !== "/fetch") {
      return new Response("Not found", { status: 404 });
    }

    if (SECRET && req.headers.get("x-relay-secret") !== SECRET) {
      return relayError(401, "Invalid relay secret.");
    }

    let payload: Record<string, unknown>;
    try {
      payload = (await req.json()) as Record<string, unknown>;
    } catch {
      return relayError(400, "Invalid JSON body.");
    }

    const target = typeof payload.url === "string" ? payload.url : "";
    if (!/^https?:\/\//i.test(target)) {
      return relayError(400, "`url` must be an http(s) URL.");
    }
    if (target.startsWith(new URL(req.url).origin)) {
      return relayError(400, "Refusing to forward to the relay itself.");
    }

    const method = typeof payload.method === "string" ? payload.method.toUpperCase() : "GET";
    const incoming =
      payload.headers && typeof payload.headers === "object"
        ? (payload.headers as Record<string, unknown>)
        : {};

    const headers: Record<string, string> = {};
    for (const name of FORWARDABLE_REQUEST_HEADERS) {
      const value = incoming[name] ?? incoming[name.toLowerCase()];
      if (typeof value === "string") headers[name] = value;
    }
    if (typeof payload.range === "string" && payload.range) {
      headers.Range = payload.range;
    }

    let body: Uint8Array | undefined;
    if (typeof payload.bodyBase64 === "string" && payload.bodyBase64.length > 0) {
      body = new Uint8Array(Buffer.from(payload.bodyBase64, "base64"));
    } else if (typeof payload.body === "string" && payload.body.length > 0) {
      body = new TextEncoder().encode(payload.body);
    }
    if (method === "GET" || method === "HEAD") body = undefined;

    try {
      const upstream = await fetch(target, {
        method,
        headers,
        body,
        redirect: "follow",
        signal: AbortSignal.timeout(120_000),
      });

      const out = new Headers();
      for (const name of FORWARDABLE_RESPONSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value) out.set(name, value);
      }
      out.set("x-relay-upstream", upstream.url || target);

      return new Response(upstream.body, { status: upstream.status, headers: out });
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      return relayError(502, `Upstream fetch failed: ${message}`);
    }
  },
});

console.log(`[treblo-relay] listening on http://0.0.0.0:${PORT} (secret: ${SECRET ? "on" : "off"})`);
