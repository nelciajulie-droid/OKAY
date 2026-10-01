/**
 * ChatGPT JWT Vault + Auto-Refresh Daemon — Cloudflare Worker
 *
 * Handles NextAuth.js split-cookie format:
 *   __Secure-next-auth.session-token.0=<long-JWE-chunk>
 *   __Secure-next-auth.session-token.1=<short-tail-chunk>
 *
 * The refresh sends BOTH cookies to chatgpt.com/api/auth/session.
 */

const SESSION_URL = "https://chatgpt.com/api/auth/session";
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0";

// KV keys — single account (backward compatible)
const KV_JWT = "chatgpt_jwt";
const KV_SESSION_COOKIE_0 = "chatgpt_session_cookie_0";
const KV_SESSION_COOKIE_1 = "chatgpt_session_cookie_1";
const KV_JWT_EXP = "chatgpt_jwt_exp";
const KV_LAST_REFRESH = "chatgpt_last_refresh";

// KV keys — multi-account pool
// Each account is stored as: KV_ACCOUNTS = JSON array of { id, email, jwt, exp, cookies, status, lastRateLimit }
// The active account index is: KV_ACTIVE_ACCOUNT = "0" (or "1", "2", etc.)
const KV_ACCOUNTS = "chatgpt_accounts";
const KV_ACTIVE_ACCOUNT = "chatgpt_active_account";

// KV keys — Perplexity Realtime voice cookies
// `perplexity_cookies` stores the full Cookie header value from perplexity.ai
// (NextAuth session token + cf_clearance + pplx.* cookies, all in one string).
// `perplexity_account` stores the active account UUID (from the
// `__Host-pplx-last-active-account` cookie). `perplexity_updated` is a unix
// timestamp of the last successful refresh (set by the Chrome extension).
const KV_PERPLEXITY_COOKIES = "perplexity_cookies";
const KV_PERPLEXITY_ACCOUNT = "perplexity_account";
const KV_PERPLEXITY_UPDATED = "perplexity_updated";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") return await handleHealth(env);

    const expectedSecret = (env && env.PROXY_SECRET) || "";
    if (expectedSecret) {
      const providedSecret = request.headers.get("X-Vault-Secret") || "";
      const querySecret = url.searchParams.get("secret") || "";
      if (providedSecret !== expectedSecret && querySecret !== expectedSecret) {
        return json({ error: "Invalid or missing vault secret" }, 403);
      }
    }

    if (url.pathname === "/jwt") return await handleGetJwt(env);
    if (url.pathname === "/jwt-update" && request.method === "POST") return await handleJwtUpdate(request, env);
    if (url.pathname === "/cookies") return await handleGetCookies(env);
    if (url.pathname === "/seed" && request.method === "POST") return await handleSeed(request, env);
    if (url.pathname === "/refresh") return await handleRefreshViaBackend(request, env);
    if (url.pathname === "/refresh-local") return await handleRefresh(env);
    // === Multi-account endpoints ===
    if (url.pathname === "/accounts" && request.method === "GET") return await handleListAccounts(env);
    if (url.pathname === "/accounts/add" && request.method === "POST") return await handleAddAccount(request, env);
    if (url.pathname === "/accounts/remove" && request.method === "POST") return await handleRemoveAccount(request, env);
    if (url.pathname === "/accounts/rotate" && request.method === "POST") return await handleRotateAccount(request, env);
    if (url.pathname === "/accounts/mark-rate-limited" && request.method === "POST") return await handleMarkRateLimited(request, env);
    // === Perplexity Realtime voice cookie endpoints ===
    if (url.pathname === "/perplexity/cookies" && request.method === "GET") return await handleGetPerplexityCookies(env);
    if (url.pathname === "/perplexity/cookies" && request.method === "POST") return await handleSetPerplexityCookies(request, env);
    if (url.pathname === "/") return json({ ok: true, service: "chatgpt-jwt-vault", endpoints: ["/jwt", "/jwt-update", "/cookies", "/seed", "/refresh", "/refresh-local", "/health", "/accounts", "/accounts/add", "/accounts/remove", "/accounts/rotate", "/accounts/mark-rate-limited", "/perplexity/cookies"] });

    return json({ error: "Not found", endpoints: ["/jwt", "/seed", "/refresh", "/health", "/perplexity/cookies"] }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshIfNeeded(env));
  },
};

async function handleGetJwt(env) {
  // Try multi-account pool first
  const accountsRaw = await env.JWT_VAULT.get(KV_ACCOUNTS);
  if (accountsRaw) {
    try {
      const accounts = JSON.parse(accountsRaw);
      const activeIdx = parseInt((await env.JWT_VAULT.get(KV_ACTIVE_ACCOUNT)) || "0", 10);
      // Find the first active (non-rate-limited) account starting from activeIdx
      for (let i = 0; i < accounts.length; i++) {
        const idx = (activeIdx + i) % accounts.length;
        const acc = accounts[idx];
        if (acc.status !== "rate_limited" && acc.jwt) {
          // Set this as the active account
          if (idx !== activeIdx) {
            await env.JWT_VAULT.put(KV_ACTIVE_ACCOUNT, String(idx));
          }
          const exp = acc.exp || 0;
          return json({
            jwt: acc.jwt,
            exp,
            expiresInHours: exp ? (exp - Math.floor(Date.now() / 1000)) / 3600 : null,
            accountIndex: idx,
            accountEmail: acc.email || "(unknown)",
            totalAccounts: accounts.length,
          });
        }
      }
      // All accounts are rate-limited
      return json({ error: "All accounts are rate-limited. Wait for daily reset or add more accounts." }, 429);
    } catch {}
  }

  // Fallback: single account (backward compatible)
  const jwt = await env.JWT_VAULT.get(KV_JWT);
  if (!jwt) return json({ error: "No JWT in vault. POST /seed first." }, 404);
  const exp = parseInt((await env.JWT_VAULT.get(KV_JWT_EXP)) || "0", 10);
  return json({ jwt, exp, expiresInHours: exp ? (exp - Math.floor(Date.now() / 1000)) / 3600 : null });
}

// Update JUST the JWT (used by the Tampermonkey script — no session cookie needed)
async function handleJwtUpdate(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const { jwt } = body;
  if (!jwt) return json({ error: "Missing 'jwt' in body" }, 400);

  // Parse the JWT's exp claim
  const parts = jwt.split(".");
  if (parts.length !== 3) return json({ error: "Invalid JWT format" }, 400);
  let exp = 0;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    exp = payload.exp || 0;
  } catch { return json({ error: "Could not parse JWT payload" }, 400); }

  // Store the new JWT in KV (keep the existing session cookies)
  await env.JWT_VAULT.put(KV_JWT, jwt);
  await env.JWT_VAULT.put(KV_JWT_EXP, String(exp || 0));
  await env.JWT_VAULT.put(KV_LAST_REFRESH, String(Math.floor(Date.now() / 1000)));

  return json({
    ok: true,
    message: "JWT updated by Tampermonkey script",
    exp,
    expiresInHours: exp ? (exp - Math.floor(Date.now() / 1000)) / 3600 : null,
  });
}

// Returns the stored session cookie chunks (for the backend refresh endpoint)
async function handleGetCookies(env) {
  const cookie0 = await env.JWT_VAULT.get(KV_SESSION_COOKIE_0);
  const cookie1 = await env.JWT_VAULT.get(KV_SESSION_COOKIE_1);
  if (!cookie0 && !cookie1) return json({ error: "No session cookie in vault." }, 404);
  return json({ cookie0: cookie0 || "", cookie1: cookie1 || "" });
}

// Refresh via the ACE Studio backend (which has curl-impersonate + proxy)
async function handleRefreshViaBackend(request, env) {
  // The backend URL is passed as a query param or in the body
  const url = new URL(request.url);
  let backendUrl = url.searchParams.get("backend") || "";
  let backendSecret = url.searchParams.get("backendSecret") || "";
  if (request.method === "POST") {
    try {
      const body = await request.json();
      backendUrl = backendUrl || body.backend || "";
      backendSecret = backendSecret || body.backendSecret || "";
    } catch {}
  }
  if (!backendUrl) {
    return json({ error: "Missing 'backend' query param (the ACE Studio backend URL, e.g. https://ace-studio.onrender.com)" }, 400);
  }
  try {
    const res = await fetch(`${backendUrl.replace(/\/$/, "")}/api/jwt/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vaultSecret: env.PROXY_SECRET }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = await res.json();
    return json(data, res.status);
  } catch (err) {
    return json({ ok: false, error: `Backend refresh failed: ${err.message || err}` }, 502);
  }
}

async function handleSeed(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const { jwt, sessionCookie } = body;
  if (!jwt || !sessionCookie) return json({ error: "Missing 'jwt' or 'sessionCookie'" }, 400);

  // sessionCookie can be:
  //   - a string (single cookie, legacy)
  //   - an object { "0": "...", "1": "..." } (split cookie format)
  //   - a string "chunk0chunk1" (concatenated — we split at 4096 chars)
  let cookie0 = "", cookie1 = "";
  if (typeof sessionCookie === "object") {
    cookie0 = sessionCookie["0"] || sessionCookie.cookie0 || "";
    cookie1 = sessionCookie["1"] || sessionCookie.cookie1 || "";
  } else if (typeof sessionCookie === "string") {
    if (sessionCookie.length > 4096) {
      cookie0 = sessionCookie.slice(0, 4096);
      cookie1 = sessionCookie.slice(4096);
    } else {
      cookie0 = sessionCookie;
    }
  }

  // Parse JWT exp
  const parts = jwt.split(".");
  if (parts.length !== 3) return json({ error: "Invalid JWT format" }, 400);
  let exp = 0;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    exp = payload.exp || 0;
  } catch { return json({ error: "Could not parse JWT payload" }, 400); }

  await env.JWT_VAULT.put(KV_JWT, jwt);
  await env.JWT_VAULT.put(KV_SESSION_COOKIE_0, cookie0);
  await env.JWT_VAULT.put(KV_SESSION_COOKIE_1, cookie1);
  await env.JWT_VAULT.put(KV_JWT_EXP, String(exp));
  await env.JWT_VAULT.put(KV_LAST_REFRESH, String(Math.floor(Date.now() / 1000)));

  return json({
    ok: true,
    message: "Vault seeded. Daemon will refresh the JWT before it expires.",
    exp,
    expiresInHours: (exp - Math.floor(Date.now() / 1000)) / 3600,
    cookieFormat: cookie1 ? "split (.0 + .1)" : "single",
  });
}

async function handleHealth(env) {
  const jwt = await env.JWT_VAULT.get(KV_JWT);
  const exp = parseInt((await env.JWT_VAULT.get(KV_JWT_EXP)) || "0", 10);
  const lastRefresh = parseInt((await env.JWT_VAULT.get(KV_LAST_REFRESH)) || "0", 10);
  const cookie0 = await env.JWT_VAULT.get(KV_SESSION_COOKIE_0);
  const cookie1 = await env.JWT_VAULT.get(KV_SESSION_COOKIE_1);
  const perplexityCookies = await env.JWT_VAULT.get(KV_PERPLEXITY_COOKIES);
  const perplexityAccount = (await env.JWT_VAULT.get(KV_PERPLEXITY_ACCOUNT)) || null;
  const perplexityUpdated = parseInt((await env.JWT_VAULT.get(KV_PERPLEXITY_UPDATED)) || "0", 10);
  const now = Math.floor(Date.now() / 1000);
  return json({
    ok: true,
    hasJwt: Boolean(jwt),
    hasSessionCookie: Boolean(cookie0 || cookie1),
    cookieFormat: cookie1 ? "split (.0 + .1)" : cookie0 ? "single" : "none",
    cookie0Length: cookie0 ? cookie0.length : 0,
    cookie1Length: cookie1 ? cookie1.length : 0,
    exp: exp || null,
    expHuman: exp ? new Date(exp * 1000).toISOString() : null,
    expiresInHours: exp ? (exp - now) / 3600 : null,
    lastRefresh: lastRefresh || null,
    lastRefreshHuman: lastRefresh ? new Date(lastRefresh * 1000).toISOString() : null,
    // Perplexity Realtime voice cookies.
    hasPerplexityCookies: Boolean(perplexityCookies),
    perplexityCookieLength: perplexityCookies ? perplexityCookies.length : 0,
    perplexityAccount,
    perplexityUpdated: perplexityUpdated || null,
    perplexityUpdatedHuman: perplexityUpdated
      ? new Date(perplexityUpdated * 1000).toISOString()
      : null,
  });
}

async function handleRefresh(env) {
  const result = await refreshJwt(env);
  return json(result, result.ok ? 200 : 502);
}

async function refreshIfNeeded(env) {
  const exp = parseInt((await env.JWT_VAULT.get(KV_JWT_EXP)) || "0", 10);
  const now = Math.floor(Date.now() / 1000);
  const hoursLeft = exp ? (exp - now) / 3600 : -1;
  console.log(`[jwt-vault daemon] checking — ${hoursLeft.toFixed(1)}h left`);
  if (!exp || hoursLeft < 4) {
    console.log(`[jwt-vault daemon] refreshing (hoursLeft=${hoursLeft.toFixed(1)})...`);

    // 1. Try backend refresh (Vercel app with proxies) — the CORRECT path
    const backendUrl = (env.BACKEND_URL || "").trim();
    if (backendUrl) {
      console.log(`[jwt-vault daemon] calling backend: ${backendUrl}/api/jwt/refresh`);
      try {
        const res = await fetch(`${backendUrl.replace(/\/$/, "")}/api/jwt/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ vaultSecret: env.PROXY_SECRET }),
          signal: AbortSignal.timeout(120_000),
        });
        const data = await res.json();
        if (data.ok) {
          console.log(`[jwt-vault daemon] ✓ backend refresh success: ${data.message}`);
          return;
        } else {
          console.log(`[jwt-vault daemon] ✗ backend refresh failed: ${data.error || "unknown"}`);
        }
      } catch (err) {
        console.log(`[jwt-vault daemon] ✗ backend error: ${err.message || err}`);
      }
    } else {
      console.log(`[jwt-vault daemon] ⚠ no BACKEND_URL env var — skipping backend refresh`);
    }

    // 2. Fallback: try local refresh (will likely fail — Cloudflare IPs blocked by OpenAI)
    console.log(`[jwt-vault daemon] falling back to local refresh (may fail)...`);
    const result = await refreshJwt(env);
    console.log(`[jwt-vault daemon] local result:`, result);
  } else {
    console.log(`[jwt-vault daemon] no refresh needed (${hoursLeft.toFixed(1)}h > 4h)`);
  }
}

async function refreshJwt(env) {
  const cookie0 = await env.JWT_VAULT.get(KV_SESSION_COOKIE_0);
  const cookie1 = await env.JWT_VAULT.get(KV_SESSION_COOKIE_1);
  if (!cookie0 && !cookie1) {
    return { ok: false, error: "No session cookie in vault. POST /seed first." };
  }

  // Build the Cookie header. NextAuth.js split-cookie format:
  //   __Secure-next-auth.session-token.0=<chunk0>; __Secure-next-auth.session-token.1=<chunk1>
  let cookieHeader = "";
  if (cookie0) cookieHeader += `__Secure-next-auth.session-token.0=${cookie0}`;
  if (cookie0 && cookie1) cookieHeader += "; ";
  if (cookie1) cookieHeader += `__Secure-next-auth.session-token.1=${cookie1}`;
  // Fallback: if only cookie0 (single cookie format), send it as the base name
  if (cookie0 && !cookie1) cookieHeader = `__Secure-next-auth.session-token=${cookie0}`;

  try {
    const res = await fetch(SESSION_URL, {
      headers: {
        "User-Agent": DEFAULT_UA,
        Accept: "*/*",
        Cookie: cookieHeader,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: `Session endpoint returned ${res.status}`, detail: body.slice(0, 300) };
    }

    const data = await res.json();
    const newJwt = data.accessToken;

    if (!newJwt) {
      return {
        ok: false,
        error: "No accessToken in response. Session cookie may be expired.",
        detail: JSON.stringify(data).slice(0, 300),
      };
    }

    // Parse the new JWT's exp
    const parts = newJwt.split(".");
    let exp = 0;
    if (parts.length === 3) {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
      exp = payload.exp || 0;
    }

    await env.JWT_VAULT.put(KV_JWT, newJwt);
    await env.JWT_VAULT.put(KV_JWT_EXP, String(exp || 0));
    await env.JWT_VAULT.put(KV_LAST_REFRESH, String(Math.floor(Date.now() / 1000)));

    return {
      ok: true,
      message: "JWT refreshed",
      exp,
      expiresInHours: exp ? (exp - Math.floor(Date.now() / 1000)) / 3600 : null,
    };
  } catch (err) {
    return { ok: false, error: `Refresh failed: ${err.message || err}` };
  }
}

// ============================================================
// MULTI-ACCOUNT POOL MANAGEMENT
// ============================================================

// Helper: get the accounts array from KV
async function getAccounts(env) {
  const raw = await env.JWT_VAULT.get(KV_ACCOUNTS);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

// Helper: save the accounts array to KV
async function saveAccounts(env, accounts) {
  await env.JWT_VAULT.put(KV_ACCOUNTS, JSON.stringify(accounts));
}

// Helper: parse JWT exp
function parseJwtExp(jwt) {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return 0;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload.exp || 0;
  } catch { return 0; }
}

// LIST all accounts (without revealing JWTs)
async function handleListAccounts(env) {
  const accounts = await getAccounts(env);
  const activeIdx = parseInt((await env.JWT_VAULT.get(KV_ACTIVE_ACCOUNT)) || "0", 10);
  const now = Math.floor(Date.now() / 1000);
  return json({
    totalAccounts: accounts.length,
    activeIndex: activeIdx,
    accounts: accounts.map((acc, i) => ({
      index: i,
      email: acc.email || "(unknown)",
      status: acc.status || "active",
      hasJwt: Boolean(acc.jwt),
      jwtLength: acc.jwt ? acc.jwt.length : 0,
      exp: acc.exp || 0,
      expiresInHours: acc.exp ? (acc.exp - now) / 3600 : null,
      isActive: i === activeIdx,
      lastRateLimit: acc.lastRateLimit || null,
    })),
  });
}

// ADD a new account (JWT + optional session cookies + email)
async function handleAddAccount(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const { jwt, email, cookie0, cookie1 } = body;
  if (!jwt) return json({ error: "Missing 'jwt' in body" }, 400);

  const exp = parseJwtExp(jwt);
  const accounts = await getAccounts(env);

  // Check if this JWT already exists (by email or by JWT prefix)
  const jwtPrefix = jwt.slice(0, 50);
  const existing = accounts.findIndex((a) =>
    (email && a.email === email) || (a.jwt && a.jwt.slice(0, 50) === jwtPrefix)
  );

  const accountData = {
    id: existing >= 0 ? accounts[existing].id : crypto.randomUUID(),
    email: email || `(account-${accounts.length + 1})`,
    jwt,
    exp,
    cookie0: cookie0 || "",
    cookie1: cookie1 || "",
    status: "active",
    addedAt: Date.now(),
    lastRateLimit: null,
  };

  if (existing >= 0) {
    accounts[existing] = accountData;
  } else {
    accounts.push(accountData);
  }

  await saveAccounts(env, accounts);
  return json({
    ok: true,
    message: existing >= 0 ? "Account updated" : "Account added",
    totalAccounts: accounts.length,
    expiresInHours: exp ? (exp - Math.floor(Date.now() / 1000)) / 3600 : null,
  });
}

// REMOVE an account (by index or email)
async function handleRemoveAccount(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const { index, email } = body;
  const accounts = await getAccounts(env);

  let removedIdx = -1;
  if (typeof index === "number" && index >= 0 && index < accounts.length) {
    removedIdx = index;
  } else if (email) {
    removedIdx = accounts.findIndex((a) => a.email === email);
  }

  if (removedIdx < 0) return json({ error: "Account not found" }, 404);

  const removed = accounts.splice(removedIdx, 1)[0];
  await saveAccounts(env, accounts);

  // Update active index if needed
  const activeIdx = parseInt((await env.JWT_VAULT.get(KV_ACTIVE_ACCOUNT)) || "0", 10);
  if (activeIdx >= accounts.length) {
    await env.JWT_VAULT.put(KV_ACTIVE_ACCOUNT, "0");
  }

  return json({ ok: true, message: "Account removed", removedEmail: removed.email, remainingAccounts: accounts.length });
}

// ROTATE to the next account (manually or automatically after rate limit)
async function handleRotateAccount(request, env) {
  const accounts = await getAccounts(env);
  if (accounts.length === 0) return json({ error: "No accounts in pool" }, 404);

  const activeIdx = parseInt((await env.JWT_VAULT.get(KV_ACTIVE_ACCOUNT)) || "0", 10);
  // Skip the current account + find the next non-rate-limited one
  for (let i = 1; i <= accounts.length; i++) {
    const idx = (activeIdx + i) % accounts.length;
    if (accounts[idx].status !== "rate_limited" && accounts[idx].jwt) {
      await env.JWT_VAULT.put(KV_ACTIVE_ACCOUNT, String(idx));
      return json({
        ok: true,
        message: "Rotated to next account",
        newIndex: idx,
        newEmail: accounts[idx].email,
      });
    }
  }
  return json({ error: "All accounts are rate-limited" }, 429);
}

// MARK an account as rate-limited (called by the app when it detects rate limiting)
async function handleMarkRateLimited(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const { index, email } = body;
  const accounts = await getAccounts(env);
  if (accounts.length === 0) return json({ error: "No accounts" }, 404);

  let targetIdx = -1;
  if (typeof index === "number") targetIdx = index;
  else if (email) targetIdx = accounts.findIndex((a) => a.email === email);
  else targetIdx = parseInt((await env.JWT_VAULT.get(KV_ACTIVE_ACCOUNT)) || "0", 10);

  if (targetIdx < 0 || targetIdx >= accounts.length) return json({ error: "Invalid account" }, 400);

  accounts[targetIdx].status = "rate_limited";
  accounts[targetIdx].lastRateLimit = Date.now();
  await saveAccounts(env, accounts);

  // Auto-rotate to the next active account
  let rotatedTo = -1;
  for (let i = 1; i <= accounts.length; i++) {
    const idx = (targetIdx + i) % accounts.length;
    if (accounts[idx].status !== "rate_limited" && accounts[idx].jwt) {
      await env.JWT_VAULT.put(KV_ACTIVE_ACCOUNT, String(idx));
      rotatedTo = idx;
      break;
    }
  }

  return json({
    ok: true,
    message: "Account marked as rate-limited",
    rateLimitedIndex: targetIdx,
    rateLimitedEmail: accounts[targetIdx].email,
    rotatedTo: rotatedTo >= 0 ? rotatedTo : null,
    rotatedToEmail: rotatedTo >= 0 ? accounts[rotatedTo].email : null,
    allRateLimited: rotatedTo < 0,
  });
}

// ============================================================
// PERPLEXITY REALTIME VOICE COOKIES
// ============================================================
//
// The Chrome extension reads all cookies for `.perplexity.ai` (NextAuth
// session token + cf_clearance + pplx.* cookies), builds a single
// `name=value; name=value; ...` Cookie header string, and POSTs it here.
// The backend `/api/perplexity/connect` route GETs it before each SDP
// exchange with Perplexity's realtime session endpoint.
//
// The active account UUID (from `__Host-pplx-last-active-account`) is stored
// separately so the backend can send the required `x-pplx-account` header.

// GET /perplexity/cookies → { cookies, account, updatedAt }
async function handleGetPerplexityCookies(env) {
  const cookies = await env.JWT_VAULT.get(KV_PERPLEXITY_COOKIES);
  if (!cookies) return json({ error: "No Perplexity cookies in vault." }, 404);
  const account = (await env.JWT_VAULT.get(KV_PERPLEXITY_ACCOUNT)) || null;
  const updatedAt = parseInt((await env.JWT_VAULT.get(KV_PERPLEXITY_UPDATED)) || "0", 10);
  return json({
    cookies,
    account,
    updatedAt: updatedAt || null,
    updatedAtHuman: updatedAt ? new Date(updatedAt * 1000).toISOString() : null,
  });
}

// POST /perplexity/cookies { cookies, account? } → { ok }
//   `cookies` is the full Cookie header string from perplexity.ai.
//   `account` (optional) is the active account UUID.
async function handleSetPerplexityCookies(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const { cookies, account } = body;
  if (!cookies || typeof cookies !== "string") {
    return json({ error: "Missing 'cookies' (string) in body" }, 400);
  }
  await env.JWT_VAULT.put(KV_PERPLEXITY_COOKIES, cookies);
  if (typeof account === "string" && account.length > 0) {
    await env.JWT_VAULT.put(KV_PERPLEXITY_ACCOUNT, account);
  }
  await env.JWT_VAULT.put(KV_PERPLEXITY_UPDATED, String(Math.floor(Date.now() / 1000)));
  return json({
    ok: true,
    message: "Perplexity cookies stored.",
    cookieLength: cookies.length,
    hasAccount: Boolean(account),
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
