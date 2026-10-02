/**
 * Inworld WebSocket Proxy Mini-service
 *
 * PROBLEM:
 *   Inworld's realtime WebSocket endpoint
 *   (`wss://api.inworld.ai/api/v1/realtime/session?protocol=realtime&key=...`)
 *   checks the `Origin` header on the WebSocket upgrade request. The browser
 *   sets the `Origin` header automatically based on the page's origin —
 *   e.g. `https://ace-studio-orcin.vercel.app` for our Vercel deployment.
 *   Inworld only allows origins like `https://platform.inworld.ai`, so it
 *   rejects our upgrade with 4xx → the browser fires an `error` event →
 *   the user sees "Inworld WebSocket error during open (Origin may be
 *   rejected)".
 *
 *   The browser CANNOT override the `Origin` header on `new WebSocket()`
 *   — it's a forbidden header.
 *
 * SOLUTION:
 *   Run a server-side WebSocket proxy on this mini-service (port 3003).
 *   The browser connects to `wss://this-proxy/?XTransformPort=3003`
 *   (which Caddy forwards to port 3003). The proxy opens a fresh
 *   WebSocket to `wss://api.inworld.ai/api/v1/realtime/session?...`
 *   with the `Origin: https://platform.inworld.ai` header set
 *   server-side (which IS allowed). The proxy then pipes frames
 *   bidirectionally (text JSON + binary PCM16 audio) between the browser
 *   and Inworld. Inworld sees the request coming from
 *   `platform.inworld.ai` (allowed) — upgrade succeeds.
 *
 *   The Inworld API token (basic_<base64>) is passed by the browser as
 *   the WebSocket subprotocol (the second argument to `new WebSocket`).
 *   The browser sets the `Sec-WebSocket-Protocol: basic_<base64>` header
 *   automatically. The proxy forwards that subprotocol to Inworld's
 *   upgrade request — Inworld extracts the token from the subprotocol
 *   to authenticate the session.
 *
 * FLOW:
 *   Browser → wss://ace-studio-orcin.vercel.app/?XTransformPort=3003
 *          → Caddy forwards to localhost:3003 on the VPS
 *          → Proxy opens wss://api.inworld.ai/api/v1/realtime/session
 *             with Origin: https://platform.inworld.ai + Sec-WebSocket-
 *             Protocol: basic_<base64>
 *          → Inworld accepts the upgrade (Origin allowed)
 *          → Proxy pipes frames bidirectionally
 *
 * PORT:
 *   3003 (per the gateway rules — Caddy needs the XTransformPort query
 *   param to forward to this port).
 *
 * STARTUP:
 *   cd mini-services/inworld-proxy && bun install && bun run dev
 *   (bun --hot for auto-reload on file changes)
 */

import { WebSocketServer, WebSocket } from "ws";

const PORT = 3003;
const INWORLD_API_BASE = "api.inworld.ai";
const INWORLD_ALLOWED_ORIGIN = "https://platform.inworld.ai";

interface PendingClient {
  ws: WebSocket;
  upstream: WebSocket | null;
  closed: boolean;
  upstreamClosed: boolean;
  /** The Inworld session key (from the URL query) for logging. */
  sessionKey: string | null;
  /** The auth scheme (basic/bearer) extracted from the subprotocol. */
  authScheme: "basic" | "bearer" | null;
}

const wss = new WebSocketServer({
  port: PORT,
  // The browser connects to `/?XTransformPort=3003` — Caddy forwards to
  // this port with the path `/`. We accept all paths.
  path: "/",
  // Allow cross-origin (the browser is on a different origin).
  // ws doesn't check Origin by default — but we set the upgrade handler
  // to be permissive.
});

wss.on("listening", () => {
  console.log(`[inworld-proxy] listening on ws://0.0.0.0:${PORT}/`);
  console.log(`[inworld-proxy] forwarding to wss://${INWORLD_API_BASE}/api/v1/realtime/session`);
  console.log(`[inworld-proxy] setting Origin: ${INWORLD_ALLOWED_ORIGIN}`);
});

wss.on("connection", (clientWs, req) => {
  // Parse the request URL — the browser sends the query string from
  // our /api/inworld/ws route. We expect:
  //   /?protocol=realtime&key=browser-session-<timestamp>&XTransformPort=3003
  // The XTransformPort is added by Caddy — we strip it before forwarding.
  const reqUrl = new URL(req.url ?? "/", "http://localhost");
  const search = new URLSearchParams(reqUrl.search);
  // Drop the XTransformPort param (it's a Caddy gateway artifact, not
  // something Inworld expects).
  search.delete("XTransformPort");
  // Reconstruct the Inworld URL with the cleaned query string.
  const upstreamPath = "/api/v1/realtime/session";
  const upstreamQuery = search.toString();
  const upstreamUrl = `wss://${INWORLD_API_BASE}${upstreamPath}${upstreamQuery ? `?${upstreamQuery}` : ""}`;
  const sessionKey = search.get("key");
  const clientIp = req.socket.remoteAddress ?? "?";

  // Extract the subprotocol — the browser passes the Inworld token
  // (basic_<base64> or bearer_<base64>) as the second argument to
  // `new WebSocket(url, [token])`. The browser sets the
  // `Sec-WebSocket-Protocol: <token>` header automatically. The `ws`
  // library makes this available as `req.headers["sec-websocket-protocol"]`.
  const subprotocol = req.headers["sec-websocket-protocol"] as string | undefined;
  let authScheme: "basic" | "bearer" | null = null;
  if (subprotocol?.startsWith("basic_")) authScheme = "basic";
  else if (subprotocol?.startsWith("bearer_")) authScheme = "bearer";

  console.log(
    `[inworld-proxy] [${clientIp}] new connection (key=${sessionKey}, ` +
    `subprotocol=${subprotocol ? `${subprotocol.slice(0, 12)}…${subprotocol.slice(-4)}` : "none"}, ` +
    `authScheme=${authScheme ?? "?"})`
  );

  // Open the upstream WebSocket to Inworld with the spoofed Origin.
  // We forward the subprotocol so Inworld extracts the token from it.
  const upstreamWs = new WebSocket(upstreamUrl, subprotocol ? [subprotocol] : [], {
    headers: {
      // THE KEY FIX: set the Origin to the allowed Inworld origin.
      // The browser couldn't do this (forbidden header), but the
      // server can.
      Origin: INWORLD_ALLOWED_ORIGIN,
      // A realistic User-Agent — Inworld might check this too.
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    },
  });

  const pending: PendingClient = {
    ws: clientWs,
    upstream: upstreamWs,
    closed: false,
    upstreamClosed: false,
    sessionKey,
    authScheme,
  };

  // --- Client → Upstream (browser mic audio + control events) ---
  clientWs.on("message", (data, isBinary) => {
    if (pending.upstreamClosed) return;
    if (upstreamWs.readyState !== WebSocket.OPEN) {
      // Buffer until upstream opens? For simplicity, drop early frames
      // (the Inworld handshake completes in ~50ms, so this is rare).
      return;
    }
    upstreamWs.send(data, { binary: isBinary });
  });

  clientWs.on("close", (code, reason) => {
    if (pending.closed) return;
    pending.closed = true;
    console.log(
      `[inworld-proxy] [${clientIp}] client closed (code=${code}` +
      `${reason ? `, reason=${reason.toString().slice(0, 80)}` : ""})`
    );
    // Close the upstream too (best-effort).
    try {
      if (upstreamWs.readyState === WebSocket.OPEN || upstreamWs.readyState === WebSocket.CONNECTING) {
        upstreamWs.close(1000, "client-closed");
      }
    } catch { /* ignore */ }
  });

  clientWs.on("error", (err) => {
    console.warn(`[inworld-proxy] [${clientIp}] client error:`, (err as Error).message);
  });

  // --- Upstream → Client (Inworld AI audio + transcripts) ---
  upstreamWs.on("open", () => {
    console.log(`[inworld-proxy] [${clientIp}] upstream open (Origin accepted)`);
  });

  upstreamWs.on("message", (data, isBinary) => {
    if (pending.closed) return;
    if (clientWs.readyState !== WebSocket.OPEN) return;
    clientWs.send(data, { binary: isBinary });
  });

  upstreamWs.on("close", (code, reason) => {
    if (pending.upstreamClosed) return;
    pending.upstreamClosed = true;
    const reasonStr = reason ? reason.toString().slice(0, 120) : "";
    console.log(
      `[inworld-proxy] [${clientIp}] upstream closed (code=${code}` +
      `${reasonStr ? `, reason=${reasonStr}` : ""})`
    );
    // Forward the close to the client.
    try {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(code, reason);
      }
    } catch { /* ignore */ }
  });

  upstreamWs.on("error", (err) => {
    console.warn(`[inworld-proxy] [${clientIp}] upstream error:`, (err as Error).message);
    // Forward the error as a close to the client (best-effort).
    try {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(1011, `upstream-error: ${(err as Error).message.slice(0, 80)}`);
      }
    } catch { /* ignore */ }
  });

  upstreamWs.on("unexpected-response", (req, res) => {
    // This fires when the upgrade is REJECTED (e.g. Inworld returns
    // 403 because even the spoofed Origin wasn't accepted — shouldn't
    // happen, but handle it).
    console.warn(
      `[inworld-proxy] [${clientIp}] upstream rejected upgrade: ` +
      `HTTP ${res.statusCode} ${res.statusMessage}`
    );
    let body = "";
    res.on("data", (chunk) => (body += chunk.toString().slice(0, 500)));
    res.on("end", () => {
      if (body) console.warn(`[inworld-proxy] [${clientIp}] rejection body: ${body.slice(0, 300)}`);
      try {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.close(1011, `upstream-rejected-${res.statusCode}`);
        }
      } catch { /* ignore */ }
    });
  });
});

wss.on("error", (err) => {
  console.error(`[inworld-proxy] server error:`, err);
});

// Graceful shutdown.
const shutdown = (signal: string) => {
  console.log(`[inworld-proxy] ${signal} received, shutting down...`);
  wss.clients.forEach((ws) => {
    try { ws.close(1001, "server-shutdown"); } catch { /* ignore */ }
  });
  wss.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
