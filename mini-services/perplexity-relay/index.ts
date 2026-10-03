/**
 * Perplexity Relay Proxy — forwards SDP exchange requests to perplexity.ai.
 *
 * This runs on the USER'S machine (exposed via Cloudflare Tunnel).
 * The backend (Vercel/sandbox) POSTs the SDP offer here, this relay
 * forwards it to perplexity.ai from the user's real IP (no Cloudflare
 * block, no rate limit), and returns the SDP answer.
 *
 * Usage:
 *   cd mini-services/perplexity-relay
 *   bun install
 *   bun run dev
 *   # Then expose via Cloudflare Tunnel:
 *   cloudflared tunnel --url http://localhost:3004
 *
 * The tunnel URL (e.g. https://xxx.trycloudflare.com) is set as the
 * PERPLEXITY_RELAY_URL env var on the backend, and the backend uses
 * it as a proxy for the SDP exchange.
 *
 * Endpoint:
 *   POST /session  { sdp, cookies, account? }
 *     → { ok: true, sdp: "<answer>" } or { ok: false, error: "..." }
 */

import { serve } from "bun";

const PERPLEXITY_SESSION_URL =
  "https://www.perplexity.ai/rest/realtime/v2/session?version=2.18&source=default";

const PORT = 3004;

console.log(`[perplexity-relay] listening on http://0.0.0.0:${PORT}/`);
console.log(`[perplexity-relay] forwarding to ${PERPLEXITY_SESSION_URL}`);
console.log(`[perplexity-relay] expose via: cloudflared tunnel --url http://localhost:${PORT}`);

serve({
  port: PORT,
  async fetch(req) {
    // CORS — allow any origin (the backend or the browser).
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (req.method !== "POST") {
      return new Response("Perplexity Relay — POST to /session with { sdp, cookies, account }", {
        headers: corsHeaders,
      });
    }

    const url = new URL(req.url);
    if (url.pathname !== "/session") {
      return new Response("Not found. POST to /session.", {
        status: 404,
        headers: corsHeaders,
      });
    }

    // Parse the request body.
    let body;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "Invalid JSON body." }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const { sdp, cookies, account } = body;
    if (!sdp || typeof sdp !== "string") {
      return new Response(JSON.stringify({ ok: false, error: "Missing 'sdp' (string)." }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
    if (!cookies || typeof cookies !== "string") {
      return new Response(JSON.stringify({ ok: false, error: "Missing 'cookies' (string)." }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    console.log(`[perplexity-relay] received SDP offer (${sdp.length} chars), exchanging…`);

    // Build the request to perplexity.ai.
    const pplxBody = JSON.stringify({
      source: "default",
      timezone: "Africa/Nairobi",
      voice: "default",
      sdp,
      offer_sdp: sdp,
      type: "offer",
    });

    const pplxHeaders = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/131.0.0.0 Safari/537.36",
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      Origin: "https://www.perplexity.ai",
      Referer: "https://www.perplexity.ai/",
      Cookie: cookies,
      "x-app-apiclient": "default",
      "x-app-apiversion": "2.18",
      "x-perplexity-request-endpoint": PERPLEXITY_SESSION_URL,
      "x-perplexity-request-reason": "realtime-sdp-exchange",
    };
    if (account) pplxHeaders["x-pplx-account"] = account;

    try {
      const pplxRes = await fetch(PERPLEXITY_SESSION_URL, {
        method: "POST",
        headers: pplxHeaders,
        body: pplxBody,
      });
      const pplxText = await pplxRes.text();
      console.log(`[perplexity-relay] perplexity.ai responded: ${pplxRes.status} (${pplxText.length} chars)`);

      if (!pplxRes.ok) {
        return new Response(
          JSON.stringify({ ok: false, error: `Perplexity returned ${pplxRes.status}`, raw: pplxText.slice(0, 500) }),
          { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } },
        );
      }

      // Extract the SDP answer.
      const answer = extractSdpAnswer(pplxText);
      if (answer) {
        console.log(`[perplexity-relay] SDP answer extracted (${answer.length} chars)`);
        return new Response(JSON.stringify({ ok: true, sdp: answer }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(
        JSON.stringify({ ok: false, error: "Could not extract SDP answer", raw: pplxText.slice(0, 500) }),
        { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ ok: false, error: `Fetch failed: ${(err as Error).message}` }),
        { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }
  },
});

/** Extract the SDP answer from a Perplexity response body. */
function extractSdpAnswer(body) {
  if (body.startsWith("v=0")) return body;
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed === "string") return parsed.startsWith("v=0") ? parsed : null;
    if (parsed && typeof parsed === "object") {
      for (const key of ["answer_sdp", "sdp", "answerSdp", "answer", "data", "result"]) {
        const v = parsed[key];
        if (typeof v === "string" && v.startsWith("v=0")) return v;
        if (v && typeof v === "object") {
          for (const innerKey of ["answer_sdp", "sdp", "answerSdp", "answer"]) {
            const iv = v[innerKey];
            if (typeof iv === "string" && iv.startsWith("v=0")) return iv;
          }
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}
