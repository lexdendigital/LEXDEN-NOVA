// api/supplier/cj-client.js
//
// LEXDEN NOVA CREATOR — Stage G: a CJ Dropshipping API client that acts for
// ONE creator, using THAT creator's own CJ account.
//
// WHY A NEW CLIENT instead of extending api/cj-shared.js: cj-shared.js is the
// admin integration — one global CJ account from CJ_EMAIL / CJ_API_KEY, one
// token cached at cjAuth/token. Retrofitting per-creator credentials into it
// would put every proven admin CJ route at risk. This file reuses the same
// CJ API and the same error-shaping rules but takes everything it touches
// (credentials, token storage, fetch, clock, pacing) as injected functions,
// so (a) nothing global can leak between creators and (b) it is fully
// unit-testable without the network or Firestore.
//
// MONEY RULE (blueprint §21): calls made through this client spend the
// CREATOR'S CJ balance, never NOVA's. NOVA does not fund supplier orders.
const { buildCjQuery } = require('../cj-query');

const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';
const AUTH_MIN_GAP_MS = 1100; // CJ documents ~1 auth request per second

// connectionId -> last auth call time. Per connection, so one creator's auth
// burst never delays another's. Best-effort (single process), same caveat as
// cj-shared.js; CJ's own 429 is the real backstop.
const lastAuthAt = new Map();
async function defaultPace(connectionId, now = Date.now) {
  const wait = (lastAuthAt.get(connectionId) || 0) + AUTH_MIN_GAP_MS - now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastAuthAt.set(connectionId, now());
}

async function fetchWithTimeout(fetchImpl, url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isExpiringSoon(expiryDateStr, bufferMs, nowMs) {
  if (!expiryDateStr) return true;
  const t = Date.parse(expiryDateStr);
  if (Number.isNaN(t)) return true;
  return t - nowMs < bufferMs;
}

function authError(message, code, raw) {
  const e = new Error(message);
  e.code = code;
  if (raw !== undefined) e.raw = raw;
  return e;
}

// Mint a token from an email + API key. Used both when connecting (to prove
// the credentials work BEFORE anything is stored) and when a stored token
// has expired. Never includes the credentials in a thrown message.
async function requestNewToken({ email, apiKey }, { fetchImpl = fetch, pace } = {}) {
  if (!email || !apiKey) throw authError('CJ email and API key are required.', 'NOT_CONFIGURED');
  if (pace) await pace();
  let r, json;
  try {
    r = await fetchWithTimeout(fetchImpl, `${CJ_BASE}/authentication/getAccessToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: apiKey }),
    }, 9000);
    json = await r.json().catch(() => null);
  } catch (e) {
    throw authError(e.name === 'AbortError' ? 'CJ did not respond in time.' : 'Could not reach CJ.', e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR');
  }
  if (r.status === 429) throw authError('CJ rate limit reached — try again shortly.', 'RATE_LIMITED');
  if (!r.ok || !json || json.result === false || !json.data || !json.data.accessToken) {
    throw authError((json && json.message) || `CJ rejected the credentials (HTTP ${r.status}).`, 'AUTH_FAILED');
  }
  return json.data; // { accessToken, accessTokenExpiryDate, refreshToken, refreshTokenExpiryDate, openId, ... }
}

async function requestRefreshedToken(refreshToken, { fetchImpl = fetch, pace } = {}) {
  if (pace) await pace();
  let r, json;
  try {
    r = await fetchWithTimeout(fetchImpl, `${CJ_BASE}/authentication/refreshAccessToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    }, 9000);
    json = await r.json().catch(() => null);
  } catch (e) {
    throw authError('Could not reach CJ.', e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR');
  }
  if (!r.ok || !json || json.result === false || !json.data || !json.data.accessToken) {
    throw authError((json && json.message) || `CJ refresh failed (HTTP ${r.status}).`, 'REFRESH_FAILED');
  }
  return json.data;
}

/**
 * @param opts.connectionId  string — used only for pacing
 * @param opts.loadCredentials () => Promise<{email, apiKey}>   decrypts on demand
 * @param opts.loadTokens      () => Promise<tokenRecord|null>
 * @param opts.saveTokens      (tokenRecord) => Promise<void>
 * @param opts.fetchImpl, opts.now, opts.pace   injectable for tests
 */
function createCjClient({ connectionId, loadCredentials, loadTokens, saveTokens, fetchImpl = fetch, now = Date.now, pace }) {
  const paceFn = pace || (() => defaultPace(connectionId, now));

  async function getValidToken({ forceRefresh = false } = {}) {
    const cur = await loadTokens();
    const nowMs = now();
    if (!forceRefresh && cur && cur.accessToken && !isExpiringSoon(cur.accessTokenExpiryDate, 6 * 60 * 60 * 1000, nowMs)) {
      return cur.accessToken;
    }
    if (cur && cur.refreshToken && !isExpiringSoon(cur.refreshTokenExpiryDate, 24 * 60 * 60 * 1000, nowMs)) {
      try {
        const fresh = await requestRefreshedToken(cur.refreshToken, { fetchImpl, pace: paceFn });
        await saveTokens(fresh);
        return fresh.accessToken;
      } catch { /* fall back to full re-auth below */ }
    }
    const creds = await loadCredentials();
    const fresh = await requestNewToken(creds, { fetchImpl, pace: paceFn });
    await saveTokens(fresh);
    return fresh.accessToken;
  }

  // Same contract as cjFetch() in cj-shared.js:
  //   { ok:true, data, requestId } | { ok:false, code, message, requestId? }
  async function call(path, { method = 'GET', query, body, timeoutMs = 12000, _retried = false } = {}) {
    let token;
    try {
      token = await getValidToken();
    } catch (e) {
      return { ok: false, code: e.code || 'AUTH_ERROR', message: e.message };
    }

    let url = `${CJ_BASE}${path}`;
    if (query && Object.keys(query).length) {
      const qs = buildCjQuery(query);
      if (qs) url += `?${qs}`;
    }

    let res, json;
    try {
      res = await fetchWithTimeout(fetchImpl, url, {
        method,
        headers: { 'Content-Type': 'application/json', 'CJ-Access-Token': token },
        body: method === 'GET' ? undefined : JSON.stringify(body || {}),
      }, timeoutMs);
      json = await res.json().catch(() => null);
    } catch (e) {
      return { ok: false, code: e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR', message: e.name === 'AbortError' ? 'CJ did not respond in time.' : 'Could not reach CJ.' };
    }

    if (res.status === 429) return { ok: false, code: 'RATE_LIMITED', message: 'CJ API rate limit reached — try again shortly.' };

    const tokenLooksInvalid = json && (
      json.code === 1004001 || json.code === 1004002 ||
      (/token/i.test(json.message || '') && json.result === false)
    );
    if ((res.status === 401 || tokenLooksInvalid) && !_retried) {
      try { await getValidToken({ forceRefresh: true }); } catch { /* surfaces as the error below */ }
      return call(path, { method, query, body, timeoutMs, _retried: true });
    }

    if (!res.ok || !json || json.result === false) {
      return {
        ok: false,
        code: (json && json.code) || res.status,
        message: (json && json.message) || `CJ API error (HTTP ${res.status})`,
        requestId: json && json.requestId,
      };
    }
    return { ok: true, data: json.data, requestId: json.requestId };
  }

  return { call, getValidToken };
}

// Proves a pair of credentials works WITHOUT storing anything: mint a token,
// then make one cheap, side-effect-free call with it. Returns the token
// record so the caller can persist it (encrypted) instead of re-authing.
async function verifyCredentials({ email, apiKey }, { fetchImpl = fetch, pace } = {}) {
  let tokens;
  try {
    tokens = await requestNewToken({ email, apiKey }, { fetchImpl, pace });
  } catch (e) {
    return { ok: false, code: e.code || 'AUTH_FAILED', message: e.message };
  }
  const client = createCjClient({
    connectionId: 'verify',
    loadCredentials: async () => ({ email, apiKey }),
    loadTokens: async () => tokens,
    saveTokens: async (t) => { tokens = t; },
    fetchImpl, pace: pace || (async () => {}),
  });
  const probe = await client.call('/product/getCategory');
  if (!probe.ok) return { ok: false, code: probe.code, message: probe.message };
  return { ok: true, tokens };
}

module.exports = { createCjClient, verifyCredentials, requestNewToken, requestRefreshedToken, CJ_BASE };
