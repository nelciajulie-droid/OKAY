/**
 * mock-oxylabs — local stand-in for the Oxylabs residential proxy gateway
 * (pr.oxylabs.io:7777).
 *
 * WHY: Real Oxylabs requires signup + credit card + 7-day trial. This mock
 * mimics Oxylabs' HTTP proxy wire protocol so the backend code path can be
 * tested end-to-end. Real Oxylabs uses real residential IPs (millions);
 * the mock uses the sandbox's IP but applies the same X-Forwarded-For
 * rotation that Oxylabs does.
 *
 * Oxylabs protocol (standard HTTP proxy with Basic auth):
 *   GET  http://pr.oxylabs.io:7777/<target>
 *        Authorization: Basic base64(customer-USER:PASS)
 *        → forwards to <target>, returns upstream response
 *
 * The mock:
 *   1. Validates Basic auth header (any user:pass accepted in mock mode).
 *   2. Reads the absolute target URL from the request line (HTTP proxy style)
 *      or from the Host header (transparent mode).
 *   3. Forwards the request with method + headers + body.
 *   4. Rotates `X-Forwarded-For` per request (simulates residential IP rotation).
 *   5. Streams the upstream response back with Range/206 support.
 *
 * USAGE:
 *   bun run dev   # listens on http://0.0.0.0:8791
 *
 * In Boppy Studio → Settings → "FireProx URL":
 *   http://customer-mockuser:mockpass@127.0.0.1:8791
 *
 * Then all boppy.ts requests auto-detect the plain proxy format and route
 * via undici ProxyAgent → mock-oxylabs → boppy.me.
 */

const PORT = 8791;
const UPSTREAM = "https://boppy.me";

const FORWARDABLE_REQUEST_HEADERS = [
  "content-type",
  "user-agent",
  "accept",
  "origin",
  "referer",
  "range",
  "x-my-x-forwarded-for",
  "authorization",
];

const FORWARDABLE_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
  "cache-control",
];

function randomResidentialIp(): string {
  // Mimic a residential IP — random IPv4 (NOT reserved ranges).
  const octet = () => Math.floor(Math.random() * 223) + 1;
  return `${octet()}.${octet()}.${octet()}.${octet()}`;
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    // For HTTP proxy mode, the request URL is absolute (e.g.
    // "https://boppy.me/api/generate"). For direct mode, it's relative
    // (e.g. "/api/generate") and the Host header tells us where to go.
    const rawUrl = req.url;
    let targetUrl: string;
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        // Absolute URL — HTTP proxy mode (this is what undici ProxyAgent sends).
        targetUrl = `${UPSTREAM}${parsed.pathname}${parsed.search}`;
      } else {
        targetUrl = `${UPSTREAM}${parsed.pathname}${parsed.search}`;
      }
    } catch {
      return new Response("Bad request URL", { status: 400 });
    }

    // Validate Basic auth (mock accepts any user:pass).
    const authHeader = req.headers.get("authorization");
    const hasValidAuth = !authHeader || authHeader.startsWith("Basic ");
    if (!hasValidAuth) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "Proxy-Authenticate": 'Basic realm="mock-oxylabs"' },
      });
    }

    const rotatedIp = randomResidentialIp();
    const xmyxff = req.headers.get("x-my-x-forwarded-for");

    console.log(
      `[mock-oxylabs] ${req.method} → ${targetUrl} ` +
        `(auth: ${authHeader ? "yes" : "no"}) ` +
        `(X-My-XFF: ${xmyxff ?? "none"}) (rotated IP: ${rotatedIp})`,
    );

    // Build upstream headers — only forward the allowlist.
    const headers = new Headers();
    for (const name of FORWARDABLE_REQUEST_HEADERS) {
      const v = req.headers.get(name);
      if (v && name !== "authorization") headers.set(name, v);
    }
    // Simulate Oxylabs' residential IP rotation: set X-Forwarded-For to a
    // fresh random IP per request.
    headers.set("X-Forwarded-For", rotatedIp);

    // Body for non-GET methods
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
      out.set("X-Mock-Oxylabs", "1");
      out.set("X-Rotated-IP", rotatedIp);

      console.log(
        `[mock-oxylabs] ← ${upstream.status} ${upstream.statusText}` +
          (upstream.headers.get("content-type")
            ? ` (${upstream.headers.get("content-type")})`
            : "") +
          ` (egress IP used: ${rotatedIp})`,
      );

      return new Response(upstream.body, { status: upstream.status, headers: out });
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      console.error(`[mock-oxylabs] upstream failed: ${message}`);
      return Response.json(
        { error: `mock-oxylabs upstream: ${message}` },
        {
          status: 502,
          headers: { "X-Mock-Oxylabs": "error" },
        },
      );
    }
  },
});

console.log(
  `[mock-oxylabs] listening on http://0.0.0.0:${PORT} → ${UPSTREAM} ` +
    `(mimics pr.oxylabs.io:7777 — residential IP rotation per request)`,
);
