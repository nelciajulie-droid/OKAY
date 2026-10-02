/**
 * Inworld AI Realtime voice — token exchange route.
 *
 * Inworld (platform.inworld.ai) is the SIMPLEST of the 4 Realtime voice
 * providers in this app: the browser opens a WebSocket DIRECTLY to
 * `wss://api.inworld.ai/api/v1/realtime/session?protocol=realtime&key=…`
 * with the Inworld API token passed as the WebSocket subprotocol. There is
 * NO backend audio proxy — PCM mic capture + AI playback happen entirely
 * in the browser, just like a regular WebSocket chat client.
 *
 * The only thing this route does is hand the Inworld token to the browser.
 * The token is a static base64 string of the form `basic_<base64>` (the
 * decoded payload is `API_KEY:SECRET`). It does NOT expire like a JWT, so
 * we can safely cache it for the lifetime of the page.
 *
 * Resolution order:
 *   1. `process.env.INWORLD_TOKEN` (set on Vercel as a project env var).
 *   2. The vault Worker's `GET /inworld/token` endpoint (so a non-Vercel
 *      deployment, or a deployment that hasn't had the env var set yet,
 *      can still pull the token from the same KV store the other 3
 *      providers use).
 *
 * Returns: `{ ok: true, token: string }` on success.
 *          `{ ok: false, error: string }` (500) when neither source has
 *          a token.
 */

import { NextResponse } from "next/server";

// Force-dynamic: the token can change between deploys, and we don't want
// the route to be statically rendered at build time.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface VaultInworldResponse {
  token?: string;
  updatedAt?: number | null;
  updatedAtHuman?: string | null;
  error?: string;
}

/** Pull the Inworld token from the vault Worker. The vault URL + secret
 * reuse the same env vars (`CHATGPT_VAULT_URL` + `CHATGPT_VAULT_SECRET`)
 * as the other realtime routes — there's no separate Inworld-vault. */
async function fetchInworldTokenFromVault(): Promise<string | null> {
  const vaultUrl = (process.env.CHATGPT_VAULT_URL ?? "").trim();
  const vaultSecret = (process.env.CHATGPT_VAULT_SECRET ?? "").trim();
  if (!vaultUrl) return null;
  const url = `${vaultUrl.replace(/\/+$/, "")}/inworld/token`;
  try {
    const res = await fetch(url, {
      headers: { "X-Vault-Secret": vaultSecret },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as VaultInworldResponse;
    if (!data.token || typeof data.token !== "string") return null;
    return data.token;
  } catch {
    // Vault unreachable / not configured — fall through to the
    // INWORLD_TOKEN env-var path.
    return null;
  }
}

export async function GET() {
  // 1. Try the env var first (the Vercel-prod path — single round-trip,
  //    no vault hop).
  const envToken = (process.env.INWORLD_TOKEN ?? "").trim();
  if (envToken) {
    return NextResponse.json({
      ok: true,
      token: envToken,
      source: "env",
    });
  }

  // 2. Fall back to the vault (the same KV store the other 3 providers
  //    use; lets the user set the token once via the vault API without
  //    re-deploying).
  const vaultToken = await fetchInworldTokenFromVault();
  if (vaultToken) {
    return NextResponse.json({
      ok: true,
      token: vaultToken,
      source: "vault",
    });
  }

  // 3. Nothing configured. Tell the user how to fix it.
  return NextResponse.json(
    {
      ok: false,
      error:
        "INWORLD_TOKEN is not set. Set it as a Vercel env var, or POST it " +
        "to the vault Worker at /inworld/token (and set CHATGPT_VAULT_URL " +
        "+ CHATGPT_VAULT_SECRET on this deployment).",
    },
    { status: 500 },
  );
}
