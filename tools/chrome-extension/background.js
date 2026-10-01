/**
 * ACE Studio Vault Refresher — background service worker (Manifest V3).
 *
 * Two jobs, both run on install, on startup, and every 2 hours (via
 * chrome.alarms) and on action click:
 *
 *   1. refreshJwt() — ChatGPT Realtime JWT.
 *      Reads the __Secure-next-auth.session-token cookies for chatgpt.com,
 *      hits https://chatgpt.com/api/auth/session, extracts the accessToken
 *      JWT, and POSTs it to the vault Worker at /jwt-update. (The extension
 *      runs in a real Chrome browser with real Cloudflare cookies, so the
 *      session endpoint just works — no proxy / curl-impersonate needed.)
 *
 *   2. refreshPerplexityCookies() — Perplexity Realtime voice cookies.
 *      Reads all cookies for .perplexity.ai via chrome.cookies.getAll,
 *      builds a single `name=value; name=value; ...` Cookie header string,
 *      extracts the active account UUID from __Host-pplx-last-active-account,
 *      and POSTs both to the vault Worker at /perplexity/cookies. The backend
 *      /api/perplexity/connect route GETs them before each SDP exchange.
 *
 * The vault URL + secret are configurable via chrome.storage.local
 * (VAULT_URL / VAULT_SECRET keys); defaults are baked in below.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_VAULT_URL = "https://chatgpt-jwt-vault.nelciajulie.workers.dev";
const DEFAULT_VAULT_SECRET = "vault-1790821129-8408ba08218ff55d";

// 2 hours in minutes (chrome.alarms minimum granularity is 1 minute).
const ALARM_NAME = "vault-refresh";
const ALARM_PERIOD_MIN = 120;

// ---------------------------------------------------------------------------
// Vault config — read from chrome.storage.local if the user has overridden,
// otherwise fall back to the baked-in defaults above.
// ---------------------------------------------------------------------------

async function getVaultConfig() {
  const stored = await chrome.storage.local.get(["VAULT_URL", "VAULT_SECRET"]);
  return {
    url: (stored.VAULT_URL || DEFAULT_VAULT_URL).trim(),
    secret: (stored.VAULT_SECRET || DEFAULT_VAULT_SECRET).trim(),
  };
}

// ---------------------------------------------------------------------------
// ChatGPT JWT refresh
// ---------------------------------------------------------------------------

/** Get the full cookie header string for chatgpt.com (NextAuth split cookies). */
async function getChatgptCookieHeader() {
  // chrome.cookies.getAll with domain returns both `chatgpt.com` and
  // `.chatgpt.com` cookies, including the __Secure-next-auth.session-token.0
  // and .1 chunks used by NextAuth.js.
  const cookies = await chrome.cookies.getAll({ domain: "chatgpt.com" });
  if (!cookies || cookies.length === 0) return "";
  // Sort so the .0 chunk comes before the .1 chunk (purely cosmetic; the
  // server doesn't care about order, but it makes debugging easier).
  cookies.sort((a, b) => a.name.localeCompare(b.name));
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/**
 * Hit chatgpt.com/api/auth/session with the user's cookies and extract the
 * accessToken JWT from the response.
 */
async function fetchChatgptJwt(cookieHeader) {
  const res = await fetch("https://chatgpt.com/api/auth/session", {
    method: "GET",
    headers: {
      Cookie: cookieHeader,
      Accept: "*/*",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/131.0.0.0 Safari/537.36",
    },
    credentials: "omit",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`session endpoint returned ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.accessToken) {
    throw new Error(
      "No accessToken in session response — the user may not be logged in to chatgpt.com.",
    );
  }
  return data.accessToken;
}

/** POST a fresh JWT to the vault Worker (/jwt-update). */
async function pushJwtToVault(jwt, vault) {
  const url = `${vault.url.replace(/\/+$/, "")}/jwt-update`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vault-Secret": vault.secret,
    },
    body: JSON.stringify({ jwt }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`vault /jwt-update returned ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/** Full ChatGPT JWT refresh — read cookies → fetch JWT → push to vault. */
async function refreshJwt(vault) {
  const cookieHeader = await getChatgptCookieHeader();
  if (!cookieHeader) {
    return { ok: false, error: "No chatgpt.com cookies found — is the user logged in?" };
  }
  const jwt = await fetchChatgptJwt(cookieHeader);
  const result = await pushJwtToVault(jwt, vault);
  return { ok: true, jwt: jwt.slice(0, 24) + "…", result };
}

// ---------------------------------------------------------------------------
// Perplexity cookies refresh
// ---------------------------------------------------------------------------

/** Get all cookies for .perplexity.ai and build a Cookie header string. */
async function getPerplexityCookieData() {
  // `domain: ".perplexity.ai"` returns cookies scoped to the apex + subdomains
  // (cf_clearance, __Secure-next-auth.session-token, pplx.* etc.). We also
  // fetch the bare `perplexity.ai` to be safe — chrome.cookies de-dupes by
  // (name, domain, path) so duplicates are harmless.
  const all = await Promise.all([
    chrome.cookies.getAll({ domain: ".perplexity.ai" }),
    chrome.cookies.getAll({ domain: "perplexity.ai" }),
    chrome.cookies.getAll({ domain: "www.perplexity.ai" }),
  ]);
  const seen = new Set();
  const cookies = [];
  for (const list of all) {
    for (const c of list) {
      const key = `${c.name}|${c.domain}|${c.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cookies.push(c);
    }
  }
  if (cookies.length === 0) return { cookies: "", account: null };
  cookies.sort((a, b) => a.name.localeCompare(b.name));
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  // The active account UUID lives in __Host-pplx-last-active-account.
  const accountCookie = cookies.find(
    (c) => c.name === "__Host-pplx-last-active-account",
  );
  return { cookies: cookieHeader, account: accountCookie ? accountCookie.value : null };
}

/** POST the Perplexity cookies (and account UUID) to the vault Worker. */
async function pushPerplexityCookiesToVault(cookies, account, vault) {
  const url = `${vault.url.replace(/\/+$/, "")}/perplexity/cookies`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vault-Secret": vault.secret,
    },
    body: JSON.stringify({ cookies, account }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`vault /perplexity/cookies returned ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/** Full Perplexity cookies refresh — read cookies → push to vault. */
async function refreshPerplexityCookies(vault) {
  const { cookies, account } = await getPerplexityCookieData();
  if (!cookies) {
    return { ok: false, error: "No perplexity.ai cookies found — is the user logged in?" };
  }
  const result = await pushPerplexityCookiesToVault(cookies, account, vault);
  return { ok: true, account, cookieLength: cookies.length, result };
}

// ---------------------------------------------------------------------------
// Orchestrator — runs both refreshes, logs the result.
// ---------------------------------------------------------------------------

async function refreshAll(reason) {
  const vault = await getVaultConfig();
  console.log(`[vault-refresher] running (${reason})…`);

  // Run both in parallel — they touch different sites.
  const [jwtResult, pplxResult] = await Promise.allSettled([
    refreshJwt(vault),
    refreshPerplexityCookies(vault),
  ]);

  const jwt = jwtResult.status === "fulfilled" ? jwtResult.value : { ok: false, error: jwtResult.reason?.message };
  const pplx = pplxResult.status === "fulfilled" ? pplxResult.value : { ok: false, error: pplxResult.reason?.message };

  console.log(`[vault-refresher] ChatGPT JWT:`, jwt);
  console.log(`[vault-refresher] Perplexity cookies:`, pplx);

  // Surface a badge on the toolbar icon so the user can see the status.
  const bothOk = jwt.ok && pplx.ok;
  await chrome.action.setBadgeText({ text: bothOk ? "OK" : "ERR" });
  await chrome.action.setBadgeBackgroundColor({
    color: bothOk ? "#16a34a" : "#dc2626",
  });

  return { jwt, pplx };
}

// ---------------------------------------------------------------------------
// Lifecycle hooks — install, startup, alarm, action click.
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  console.log("[vault-refresher] installed — scheduling 2-hour alarm + immediate refresh");
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MIN });
  refreshAll("install").catch((e) => console.error("[vault-refresher] install refresh failed:", e));
});

chrome.runtime.onStartup.addListener(() => {
  console.log("[vault-refresher] browser startup — refreshing + ensuring alarm");
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MIN });
  refreshAll("startup").catch((e) => console.error("[vault-refresher] startup refresh failed:", e));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  refreshAll("alarm").catch((e) => console.error("[vault-refresher] alarm refresh failed:", e));
});

chrome.action.onClicked.addListener(() => {
  refreshAll("action-click").catch((e) => console.error("[vault-refresher] click refresh failed:", e));
});
