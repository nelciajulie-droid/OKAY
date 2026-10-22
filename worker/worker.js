/**
 * Boppy FireProx Worker — Cloudflare Worker proxy for boppy.me
 *
 * ⚠️ HONEST LIMITATIONS (read before deploying):
 *
 * Cloudflare Workers share a pool of egress IPs across all free-tier users.
 * They do NOT rotate the source IP per request — that feature is specific to
 * AWS API Gateway (which is what real FireProx uses). boppy.me rate-limits by
 * TCP source IP, not by the X-Forwarded-For header, so this Worker:
 *
 *   ✅ Hides your real IP from boppy.me       (privacy)
 *   ✅ Adds spoofed X-Forwarded-For per request (FireProx-compatible interface)
 *   ✅ Streams Range/206 audio through        (mp3 playback works)
 *   ✅ Free tier: 100,000 requests/day
 *   ❌ Does NOT rotate the source IP           (Cloudflare pool is shared)
 *   ❌ Does NOT solve boppy's rate limit       (TCP IP is what boppy limits)
 *
 * For real per-request IP rotation, deploy real FireProx on AWS:
 *   see /home/z/my-project/fireprox/DEPLOY-BOPPY.md
 * Or self-host ACE-Step (no rate limit at all):
 *   see Settings → "API endpoint (advanced)"
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS WORKER DOES (wire-compatible with mock-fireprox):
 *
 *   1. URL rewrite — https://your-worker.workers.dev/api/generate →
 *      https://boppy.me/api/generate (path + query preserved).
 *   2. X-My-X-Forwarded-For → X-Forwarded-For — copies the caller's
 *      X-My-X-Forwarded-For into the upstream X-Forwarded-For header
 *      (FireProx's convention; our boppy.ts sets this to a random IPv4).
 *   3. Streams response — Range/206 + audio/mpeg pass through unchanged.
 *   4. /health endpoint — simple JSON ping for diagnostics.
 *
 * DEPLOY (3 commands on your machine, no AWS needed):
 *
 *   npm install -g wrangler         # one-time install
 *   wrangler login                  # one-time auth (browser opens)
 *   wrangler deploy                 # deploy this file → get a *.workers.dev URL
 *
 * Then in Boppy Studio → Settings → "FireProx URL (advanced)":
 *   paste https://boppy-fireprox.<your-subdomain>.workers.dev
 *   → Save. All API calls + audio streaming then route through this Worker.
 */

const UPSTREAM = "https://boppy.me";

// Request headers we forward to the upstream. Mirrors AWS API Gateway's
// behaviour: passes through most client headers, adds its own.
const FORWARDABLE_REQUEST_HEADERS = [
  "content-type",
  "user-agent",
  "accept",
  "origin",
  "referer",
  "range",
  "x-my-x-forwarded-for",
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

// Fake X-Amzn-Trace-Id to mimic AWS API Gateway's fingerprint — useful for
// testing the code path even though a real Worker can't add it upstream
// (boppy would only see Cloudflare's headers, not AWS's). Kept for parity
// with mock-fireprox so the same boppy.ts code path is exercised.
function fakeTraceId() {
  const hex = (n) =>
    Array.from({ length: n }, () =>
      Math.floor(Math.random() * 16).toString(16),
    ).join("");
  return `Root=1-${hex(8)}${hex(8)}`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Simple health check — useful for monitoring.
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        type: "cloudflare-worker-fireprox",
        upstream: UPSTREAM,
        note: "Worker proxy — does NOT rotate source IP (Cloudflare shared egress pool). For real rotation use FireProx AWS.",
      });
    }

    const targetUrl = `${UPSTREAM}${url.pathname}${url.search}`;
    const xmyxff = request.headers.get("x-my-x-forwarded-for");

    // Compact one-line access log (visible in wrangler tail).
    console.log(
      `[worker] ${request.method} ${url.pathname}${url.search ? "?" + url.search : ""} ` +
        `→ ${UPSTREAM}${url.pathname}${url.search ? url.search : ""} ` +
        `(X-My-XFF: ${xmyxff ?? "none"})`,
    );

    // Build upstream headers — only forward the safe allowlist.
    const headers = new Headers();
    for (const name of FORWARDABLE_REQUEST_HEADERS) {
      const v = request.headers.get(name);
      if (v) headers.set(name, v);
    }
    // FireProx trick: copy X-My-X-Forwarded-For into X-Forwarded-For on the
    // upstream request so boppy sees a fresh client IP per call. (Note: boppy
    // rate-limits by TCP source IP, not XFF, so this is a fingerprint hint,
    // not an actual rotation.)
    if (xmyxff) {
      headers.set("X-Forwarded-For", xmyxff);
    }
    // Add a fake AWS trace id for fingerprint parity with real FireProx.
    headers.set("X-Amzn-Trace-Id", fakeTraceId());

    // Stream the request body (only for non-GET/HEAD methods).
    // `duplex: "half"` is required by the WHATWG Fetch spec when streaming
    // a request body — Cloudflare Workers + Node 18+ both enforce this.
    const init = {
      method: request.method,
      headers,
      redirect: "follow",
      duplex: "half",
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
    }

    try {
      const upstream = await fetch(targetUrl, init);

      // Pass through the allowed response headers only.
      const out = new Headers();
      for (const name of FORWARDABLE_RESPONSE_HEADERS) {
        const v = upstream.headers.get(name);
        if (v) out.set(name, v);
      }
      // Mark as Worker-routed so the caller can verify the code path.
      out.set("X-Worker-FireProx", "1");

      console.log(
        `[worker] ← ${upstream.status} ${upstream.statusText}` +
          (upstream.headers.get("content-type")
            ? ` (${upstream.headers.get("content-type")})`
            : ""),
      );

      // Stream the upstream body straight back to the caller — Range/206
      // and audio/mpeg work transparently because we don't buffer.
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: out,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      console.error(`[worker] upstream failed: ${message}`);
      return Response.json(
        { error: `worker-fireprox upstream: ${message}` },
        {
          status: 502,
          headers: { "X-Worker-FireProx": "error" },
        },
      );
    }
  },
};
