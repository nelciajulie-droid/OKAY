/**
 * ACE Studio Vault Refresher — background service worker (Manifest V3).
 *
 * Three jobs, all run on install, on startup, and every 2 hours (via
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
 *   3. refreshGoogleCookies() — Google (Gemini Live) cookies.
 *      Reads all cookies for .google.com via chrome.cookies.getAll, builds a
 *      single `name=value; name=value; ...` Cookie header string, and POSTs
 *      it to the vault Worker at /google/cookies. The backend
 *      /api/gemini/connect route GETs them before each bidi call, extracts
 *      the SAPISID value, and computes a fresh SAPISIDHASH. (The route
 *      doesn't need us to compute SAPISIDHASH — the SAPISID cookie value
 *      alone is enough; the backend rehashes with a fresh timestamp per
 *      request.)
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
// Perplexity SDP relay — poll vault for pending SDP offers, do the fetch
// to perplexity.ai from the user's real browser IP, store the answer.
// ---------------------------------------------------------------------------

const SDP_POLL_INTERVAL_MS = 2000; // poll every 2s
const SDP_POLL_ALARM = "pplx-sdp-poll";

/** Poll the vault for a pending SDP offer. If found, do the fetch to
 *  perplexity.ai + store the SDP answer in the vault. */
async function pollPerplexitySdpOffer(vault) {
  const offerUrl = `${vault.url.replace(/\/+$/, "")}/perplexity/sdp-offer`;
  try {
    const res = await fetch(offerUrl, {
      headers: { "X-Vault-Secret": vault.secret },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.sdp) return; // no pending offer
    console.log("[vault-refresher] found pending Perplexity SDP offer, exchanging…");

    // Get the Perplexity cookies + account from the vault.
    const cookiesRes = await fetch(`${vault.url.replace(/\/+$/, "")}/perplexity/cookies`, {
      headers: { "X-Vault-Secret": vault.secret },
    });
    if (!cookiesRes.ok) {
      await pushPerplexitySdpAnswer(null, "Failed to fetch Perplexity cookies from vault", vault);
      return;
    }
    const cookieData = await cookiesRes.json();
    const cookies = cookieData.cookies;
    const account = cookieData.account;

    // Do the SDP exchange from the extension (real browser IP — no proxy).
    const sessionUrl = "https://www.perplexity.ai/rest/realtime/v2/session?version=2.18&source=default";
    const body = JSON.stringify({
      source: "default",
      timezone: "Africa/Nairobi",
      voice: "default",
      sdp: data.sdp,
      offer_sdp: data.sdp,
      type: "offer",
    });
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      Origin: "https://www.perplexity.ai",
      Referer: "https://www.perplexity.ai/",
      Cookie: cookies,
      "x-app-apiclient": "default",
      "x-app-apiversion": "2.18",
      "x-perplexity-request-endpoint": sessionUrl,
      "x-perplexity-request-reason": "realtime-sdp-exchange",
    };
    if (account) headers["x-pplx-account"] = account;

    try {
      const pplxRes = await fetch(sessionUrl, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(30000),
      });
      const pplxText = await pplxRes.text();
      if (pplxRes.ok) {
        // Extract the SDP answer from the response.
        const answer = extractSdpAnswer(pplxText);
        if (answer) {
          console.log("[vault-refresher] Perplexity SDP answer received, storing in vault…");
          await pushPerplexitySdpAnswer(answer, null, vault);
        } else {
          await pushPerplexitySdpAnswer(null, `Could not extract SDP answer: ${pplxText.slice(0, 200)}`, vault);
        }
      } else {
        await pushPerplexitySdpAnswer(null, `Perplexity returned ${pplxRes.status}: ${pplxText.slice(0, 200)}`, vault);
      }
    } catch (err) {
      await pushPerplexitySdpAnswer(null, `Perplexity fetch failed: ${err.message}`, vault);
    }
  } catch (e) {
    // Vault polling failed — non-fatal, try again next tick.
  }
}

/** Extract the SDP answer from a Perplexity response body. */
function extractSdpAnswer(body) {
  if (body.startsWith("v=0")) return body;
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed === "string") return parsed.startsWith("v=0") ? parsed : null;
    if (parsed && typeof parsed === "object") {
      const obj = parsed;
      for (const key of ["answer_sdp", "sdp", "answerSdp", "answer", "data", "result"]) {
        const v = obj[key];
        if (typeof v === "string" && v.startsWith("v=0")) return v;
        if (v && typeof v === "object") {
          const inner = v;
          for (const innerKey of ["answer_sdp", "sdp", "answerSdp", "answer"]) {
            const iv = inner[innerKey];
            if (typeof iv === "string" && iv.startsWith("v=0")) return iv;
          }
        }
      }
    }
  } catch { return null; }
  return null;
}

/** POST the SDP answer (or error) to the vault. */
async function pushPerplexitySdpAnswer(sdp, error, vault) {
  const url = `${vault.url.replace(/\/+$/, "")}/perplexity/sdp-answer`;
  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vault-Secret": vault.secret,
    },
    body: JSON.stringify(sdp ? { sdp } : { error }),
  });
}

// ---------------------------------------------------------------------------
// Google (Gemini Live) cookies refresh
// ---------------------------------------------------------------------------

/**
 * Get all cookies for .google.com and build a Cookie header string.
 *
 * Google sets session cookies on `.google.com` (SID, __Secure-1PSID,
 * __Secure-3PSID, SAPISID, __Secure-1PAPISID, __Secure-3PAPISID, HSID,
 * SSID, APISID, NID, SIDCC, __Secure-1PSIDCC, __Secure-3PSIDCC,
 * __Secure-1PSIDTS, __Secure-3PSIDTS, AEC, SEARCH_SAMESITE, __Secure-STRP,
 * etc.). The `SAPISID` value (or one of its __Secure- variants) is what
 * the backend needs to compute the SAPISIDHASH auth header. We just send
 * the whole cookie string here — the backend extracts SAPISID itself
 * (avoids duplicating the extraction logic between extension + backend
 * and keeps the SAPISID value out of the storage.local logs).
 */
async function getGoogleCookieData() {
  // `domain: ".google.com"` returns cookies scoped to the apex + all
  // subdomains. The bare `google.com` is included as a redundancy —
  // chrome.cookies de-dupes by (name, domain, path).
  // We ALSO query `clients6.google.com` to capture the
  // `S=alkali-makersuite=<sid>` cookie that Google sets during a bidi
  // session — this is the SID needed by the receive long-poll.
  // NOTE: chrome.cookies.getAll with a specific subdomain can throw if
  // the user hasn't visited that domain — we wrap each in its own try/catch
  // so one failure doesn't block the others.
  const queries = [
    { domain: ".google.com" },
    { domain: "google.com" },
    { domain: ".clients6.google.com" },
    { domain: "clients6.google.com" },
  ];
  const all = await Promise.all(
    queries.map((q) =>
      chrome.cookies.getAll(q).catch(() => [])
    ),
  );
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
  if (cookies.length === 0) return { cookies: "", hasSapisid: false, bidiSid: null };
  cookies.sort((a, b) => a.name.localeCompare(b.name));
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  // The backend needs SAPISID (or one of its __Secure- variants). We
  // check it here so we can surface a useful error if the user is
  // logged out of google.com.
  const hasSapisid = cookies.some(
    (c) =>
      c.name === "SAPISID" ||
      c.name === "__Secure-1PAPISID" ||
      c.name === "__Secure-3PAPISID",
  );
  // Extract the bidi SID from the S=alkali-makersuite=<sid> cookie.
  // Google sets this cookie on clients6.google.com during a bidi session.
  // The <sid> (after the "alkali-makersuite=" prefix) is the SID that goes
  // in the receive/send URL query params.
  let bidiSid = null;
  for (const c of cookies) {
    if (c.name === "S" && c.value.startsWith("alkali-makersuite=")) {
      bidiSid = c.value.slice("alkali-makersuite=".length);
      break;
    }
  }
  return { cookies: cookieHeader, hasSapisid, bidiSid };
}

/** POST the Google cookies (+ bidi SID) to the vault Worker. */
async function pushGoogleCookiesToVault(cookies, bidiSid, vault) {
  const url = `${vault.url.replace(/\/+$/, "")}/google/cookies`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vault-Secret": vault.secret,
    },
    body: JSON.stringify({ cookies, bidiSid }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`vault /google/cookies returned ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/** Full Google cookies refresh — read cookies → push to vault. */
async function refreshGoogleCookies(vault) {
  const { cookies, hasSapisid, bidiSid } = await getGoogleCookieData();
  if (!cookies) {
    return { ok: false, error: "No google.com cookies found — is the user logged in?" };
  }
  if (!hasSapisid) {
    return {
      ok: false,
      error: "No SAPISID cookie found — the user may not be signed in to aistudio.google.com.",
    };
  }
  const result = await pushGoogleCookiesToVault(cookies, bidiSid, vault);
  return { ok: true, cookieLength: cookies.length, bidiSid: bidiSid ? bidiSid.slice(0, 20) + "…" : null, result };
}

// ---------------------------------------------------------------------------
// Orchestrator — runs both refreshes, logs the result.
// ---------------------------------------------------------------------------

async function refreshAll(reason) {
  const vault = await getVaultConfig();
  console.log(`[vault-refresher] running (${reason})…`);

  // Run all three in parallel — they touch different sites.
  const [jwtResult, pplxResult, googleResult] = await Promise.allSettled([
    refreshJwt(vault),
    refreshPerplexityCookies(vault),
    refreshGoogleCookies(vault),
  ]);

  const jwt = jwtResult.status === "fulfilled" ? jwtResult.value : { ok: false, error: jwtResult.reason?.message };
  const pplx = pplxResult.status === "fulfilled" ? pplxResult.value : { ok: false, error: pplxResult.reason?.message };
  const google = googleResult.status === "fulfilled" ? googleResult.value : { ok: false, error: googleResult.reason?.message };

  console.log(`[vault-refresher] ChatGPT JWT:`, jwt);
  console.log(`[vault-refresher] Perplexity cookies:`, pplx);
  console.log(`[vault-refresher] Google cookies:`, google);

  // Surface a badge on the toolbar icon. We never show "ERR" (red) because
  // partial failures (user not logged in to ChatGPT/Perplexity) are normal
  // and shouldn't alarm the user. Always show "OK" or "OK*".
  const successCount = [jwt.ok, pplx.ok, google.ok].filter(Boolean).length;
  const badgeText = successCount === 3 ? "OK" : "OK*";
  const badgeColor = successCount === 3 ? "#16a34a" : "#ca8a04";
  try {
    await chrome.action.setBadgeText({ text: badgeText });
    await chrome.action.setBadgeBackgroundColor({ color: badgeColor });
  } catch (e) {
    console.warn("[vault-refresher] badge update failed:", e);
  }

  return { jwt, pplx, google };
}

// ---------------------------------------------------------------------------
// Lifecycle hooks — install, startup, alarm, action click.
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  console.log("[vault-refresher] installed — scheduling 2-hour alarm + SDP poll + immediate refresh");
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MIN });
  // SDP poll alarm — fires every 2s (minimum alarm granularity is 1 minute
  // in MV3, but we use 1 minute + a setInterval fallback for faster polling).
  chrome.alarms.create(SDP_POLL_ALARM, { periodInMinutes: 1 });
  refreshAll("install").catch((e) => console.error("[vault-refresher] install refresh failed:", e));
});

chrome.runtime.onStartup.addListener(() => {
  console.log("[vault-refresher] browser startup — refreshing + ensuring alarm + SDP poll");
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MIN });
  chrome.alarms.create(SDP_POLL_ALARM, { periodInMinutes: 1 });
  refreshAll("startup").catch((e) => console.error("[vault-refresher] startup refresh failed:", e));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    refreshAll("alarm").catch((e) => console.error("[vault-refresher] alarm refresh failed:", e));
  } else if (alarm.name === SDP_POLL_ALARM) {
    // Poll for pending SDP offers.
    getVaultConfig().then((vault) => {
      pollPerplexitySdpOffer(vault).catch((e) => console.warn("[vault-refresher] SDP poll failed:", e));
    });
  }
});

chrome.action.onClicked.addListener(() => {
  refreshAll("action-click").catch((e) => console.error("[vault-refresher] click refresh failed:", e));
});

// Also use a setInterval for faster SDP polling (every 2s).
// The chrome.alarms minimum is 1 minute, but SDP exchanges need to be fast.
// The setInterval is cleared when the service worker goes inactive (MV3 kills it).
let sdpPollTimer = null;
function startSdpPolling() {
  if (sdpPollTimer) return;
  sdpPollTimer = setInterval(async () => {
    try {
      const vault = await getVaultConfig();
      await pollPerplexitySdpOffer(vault);
    } catch (e) {
      // Non-fatal.
    }
  }, SDP_POLL_INTERVAL_MS);
}
startSdpPolling();
