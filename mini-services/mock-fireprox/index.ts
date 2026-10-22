/**
 * mock-fireprox — local stand-in for an AWS API Gateway created by FireProx.
 *
 * WHY: Real FireProx requires AWS credentials and creates billable
 * resources. This mock mimics the wire behaviour of AWS API Gateway when
 * used as a FireProx endpoint:
 *
 *   1. URL rewrite — `http://localhost:8788/api/generate` is forwarded to
 *      `https://boppy.me/api/generate` (path + query preserved).
 *   2. X-My-X-Forwarded-For → X-Forwarded-For — FireProx's AWS config copies
 *      the caller's `X-My-X-Forwarded-For` value into the upstream
 *      `X-Forwarded-For` header (this is the IP-rotation trick). The mock
 *      does the same so the backend code path is identical to a real
 *      FireProx.
 *   3. AWS fingerprint — adds `X-Amzn-Trace-Id` to the upstream request
 *      (AWS API Gateway always injects one) so we can verify the backend
 *      doesn't choke on it.
 *   4. Streamed response — Range/206 + audio/mpeg pass through unchanged.
 *
 * USAGE:
 *   bun run dev                         # listens on http://0.0.0.0:8788
 *   bun run dev -- UPSTREAM=https://...  # (not supported; edit constant)
 *
 * Then in Boppy Studio → Settings → "FireProx URL" enter:
 *   http://localhost:8788
 *
 * Every API call (compose/generate/poll) and every audio stream will then
 * go through this mock, which forwards to https://boppy.me over IPv4.
 *
 * NOTE: This is a TEST aid, not a production proxy. Don't expose it.
 */

const PORT = 8788;
const UPSTREAM = "https://boppy.me";

// Request headers we forward to the upstream. Mirrors AWS API Gateway's
// behaviour: it passes through most client headers and adds its own.
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

function traceId(): string {
  // Real AWS shape: "Root=1-<hex>-<hex>". Good enough for fingerprint parity.
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `Root=1-${hex(8)}${hex(8)}`;
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const targetUrl = `${UPSTREAM}${url.pathname}${url.search}`;

    const xmyxff = req.headers.get("x-my-x-forwarded-for");

    // Compact one-line access log so we can verify rotation in the test.
    console.log(
      `[mock-fireprox] ${req.method} ${url.pathname}${url.search ? "?" + url.search : ""} ` +
        `→ ${UPSTREAM}${url.pathname}${url.search ? url.search : ""} ` +
        `(X-My-XFF: ${xmyxff ?? "none"})`,
    );

    const headers = new Headers();
    for (const name of FORWARDABLE_REQUEST_HEADERS) {
      const v = req.headers.get(name);
      if (v) headers.set(name, v);
    }
    // FireProx trick: copy X-My-X-Forwarded-For into X-Forwarded-For on the
    // upstream request so the target sees a fresh client IP per call.
    if (xmyxff) {
      headers.set("X-Forwarded-For", xmyxff);
    }
    // AWS API Gateway always injects X-Amzn-Trace-Id — mimic it.
    headers.set("X-Amzn-Trace-Id", traceId());

    const body =
      req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();

    try {
      const upstream = await fetch(targetUrl, {
        method: req.method,
        headers,
        body,
        redirect: "follow",
        signal: AbortSignal.timeout(120_000),
      });

      const out = new Headers();
      for (const name of FORWARDABLE_RESPONSE_HEADERS) {
        const v = upstream.headers.get(name);
        if (v) out.set(name, v);
      }
      // Mark as mock so the test can assert the code path is being used.
      out.set("X-Mock-FireProx", "1");

      console.log(
        `[mock-fireprox] ← ${upstream.status} ${upstream.statusText}` +
          (upstream.headers.get("content-type")
            ? ` (${upstream.headers.get("content-type")})`
            : ""),
      );

      return new Response(upstream.body, { status: upstream.status, headers: out });
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      console.error(`[mock-fireprox] upstream failed: ${message}`);
      return new Response(JSON.stringify({ error: `mock-fireprox upstream: ${message}` }), {
        status: 502,
        headers: {
          "content-type": "application/json",
          "X-Mock-FireProx": "error",
        },
      });
    }
  },
});

console.log(
  `[mock-fireprox] listening on http://0.0.0.0:${PORT} → ${UPSTREAM} ` +
    `(mimics AWS API Gateway created by FireProx)`,
);
