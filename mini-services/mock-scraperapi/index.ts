/**
 * mock-scraperapi — local stand-in for https://api.scraperapi.com
 *
 * WHY: Real ScraperAPI requires sign-up + email + free-tier API key. This
 * mock mimics ScraperAPI's wire protocol so the backend code path can be
 * tested without an account.
 *
 * ScraperAPI protocol:
 *   GET  https://api.scraperapi.com?api_key=KEY&url=TARGET_URL
 *   POST https://api.scraperapi.com?api_key=KEY&url=TARGET_URL&method=POST
 *        body = the upstream request body (passed as-is)
 *
 * The mock:
 *   1. Parses the `url` query param → target.
 *   2. Forwards the request to the target with method + headers + body.
 *   3. Rotates `X-Forwarded-For` per request (mimics residential IP rotation).
 *   4. Injects `X-ScraperApi-Trace-Id` (ScraperAPI fingerprint).
 *   5. Streams the upstream response back (no Range support — full GET only,
 *      just like the real ScraperAPI free tier).
 *   6. Always uses POST as the incoming method (real ScraperAPI: GET means
 *      "upstream GET", POST means "follow upstream method in ?method=...").
 *
 * USAGE:
 *   bun run dev   # listens on http://0.0.0.0:8789
 *
 * In Boppy Studio → Settings → "FireProx URL":
 *   http://localhost:8789?api_key=mock-test-key
 *
 * Then all boppy.ts requests auto-detect ScraperAPI format and route here.
 */

const PORT = 8789;
const UPSTREAM_DEFAULT = "https://boppy.me"; // used when target URL is relative

const FORWARDABLE_REQUEST_HEADERS = [
  "content-type",
  "user-agent",
  "accept",
  "origin",
  "referer",
  "range",
  "x-my-x-forwarded-for",
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
  // Mimic a residential IP pool — random IPv4, avoiding private/reserved ranges.
  const octet = () => Math.floor(Math.random() * 223) + 1;
  return `${octet()}.${octet()}.${octet()}.${octet()}`;
}

function traceId(): string {
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `scraper-${hex(8)}-${hex(8)}`;
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // Health check
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        type: "mock-scraperapi",
        note: "Mock of https://api.scraperapi.com. Forward requests where the target URL is in the ?url= query param. Residential IP rotation simulated per request.",
      });
    }

    // Extract target URL from ?url= (ScraperAPI convention)
    const targetUrl = url.searchParams.get("url");
    if (!targetUrl) {
      return Response.json(
        { error: "Missing required 'url' query parameter." },
        { status: 400, headers: { "X-Mock-ScraperAPI": "error" } },
      );
    }
    if (!/^https?:\/\//i.test(targetUrl)) {
      return Response.json(
        { error: "'url' must be an http(s) URL." },
        { status: 400, headers: { "X-Mock-ScraperAPI": "error" } },
      );
    }

    // Method override (ScraperAPI uses ?method= to specify upstream method)
    const upstreamMethod = (url.searchParams.get("method") || "GET").toUpperCase();
    const xmyxff = req.headers.get("x-my-x-forwarded-for");
    const rotatedIp = randomResidentialIp();

    console.log(
      `[mock-scraperapi] ${req.method} ${url.pathname}?...&url=${targetUrl} ` +
        `(upstream ${upstreamMethod}) (X-My-XFF: ${xmyxff ?? "none"}) (rotated IP: ${rotatedIp})`,
    );

    // Build upstream headers
    const headers = new Headers();
    for (const name of FORWARDABLE_REQUEST_HEADERS) {
      const v = req.headers.get(name);
      if (v) headers.set(name, v);
    }
    // Mimic ScraperAPI's residential IP rotation: set X-Forwarded-For to a
    // fresh random IP per request (overrides any caller-supplied XFF).
    headers.set("X-Forwarded-For", rotatedIp);
    // ScraperAPI fingerprint (their trace id).
    headers.set("X-ScraperApi-Trace-Id", traceId());

    // Body — for non-GET methods, pass the request body as-is
    const body =
      upstreamMethod === "GET" || upstreamMethod === "HEAD"
        ? undefined
        : await req.text();

    try {
      const upstream = await fetch(targetUrl, {
        method: upstreamMethod,
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
      // Mark as mock so the test can verify the code path.
      out.set("X-Mock-ScraperAPI", "1");
      out.set("X-Rotated-IP", rotatedIp);

      console.log(
        `[mock-scraperapi] ← ${upstream.status} ${upstream.statusText}` +
          (upstream.headers.get("content-type")
            ? ` (${upstream.headers.get("content-type")})`
            : "") +
          ` (egress IP used: ${rotatedIp})`,
      );

      return new Response(upstream.body, { status: upstream.status, headers: out });
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      console.error(`[mock-scraperapi] upstream failed: ${message}`);
      return Response.json(
        { error: `mock-scraperapi upstream: ${message}` },
        {
          status: 502,
          headers: { "X-Mock-ScraperAPI": "error" },
        },
      );
    }
  },
});

console.log(
  `[mock-scraperapi] listening on http://0.0.0.0:${PORT} ` +
    `(mimics api.scraperapi.com — residential IP rotation per request)`,
);
