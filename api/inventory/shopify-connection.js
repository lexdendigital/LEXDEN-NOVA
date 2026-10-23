// api/inventory/shopify-connection.js
//
// A creator's Shopify connection: where it is stored, how the token is protected, and the OAuth install helpers.
//   * Token: encrypted with AES-256-GCM (api/supplier/credentials.js, key SUPPLIER_CREDENTIALS_KEY), bound to
//     the creator id. It is never returned by any route, never logged, never sent to the browser or to AI/MCP.
//   * OAuth (needs SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET from a Shopify app created by LEXDEN):
//     state is a random single-use value with a 10-minute life, bound to the creator and the shop;
//     the callback's HMAC is checked with the app secret before anything else happens.
//   * Without app credentials, a creator who already has an Admin API token from an existing custom app can paste it.
const crypto = require('crypto');
const creds = require('../supplier/credentials');
const shop = require('./shopify-client');

const SCOPES = 'read_inventory,write_inventory,read_locations';
const STATE_TTL_MS = 10 * 60 * 1000;
const err = (status, code, message) => Object.assign(new Error(message), { status, code });
const aad = (creatorId) => `shopify:${creatorId}`;
const conns = (db) => db.collection('shopifyConnections');
const states = (db) => db.collection('shopifyInstallStates');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function oauthConfig(env = process.env) {
  const clientId = String(env.SHOPIFY_CLIENT_ID || '').trim(); const clientSecret = String(env.SHOPIFY_CLIENT_SECRET || '').trim();
  const apiBase = String(env.API_PUBLIC_URL || 'https://lexden-nova.onrender.com').replace(/\/+$/, '');
  return { configured: !!(clientId && clientSecret), clientId, clientSecret, redirectUri: `${apiBase}/api/creator-channel-shopify`, scopes: SCOPES };
}

function encryptToken(token, creatorId) {
  try { return creds.encryptSecret(String(token), aad(creatorId)); }
  catch (e) {
    if (e.code === 'SUPPLIER_KEY_MISSING' || e.code === 'SUPPLIER_KEY_INVALID') throw err(503, e.code, 'Store connections are not available yet: the server has no encryption key set (SUPPLIER_CREDENTIALS_KEY).');
    throw e;
  }
}

/** Stores (or replaces) the connection. The plaintext token exists only in this call's arguments. */
async function save(db, creatorId, { shopDomain, token, scopes = [], shopName = null, expiresAtMs = null, refreshToken = null, nowMs = Date.now() }) {
  const doc = {
    creatorId, shop: shop.normaliseShop(shopDomain), shopName: shopName ? String(shopName).slice(0, 100) : null,
    tokenEnc: encryptToken(token, creatorId), refreshEnc: refreshToken ? encryptToken(refreshToken, creatorId) : null,
    expiresAtMs, scopes: scopes.slice(0, 20), status: 'CONNECTED', connectedAtMs: nowMs, lastError: null,
  };
  // locationId is chosen separately; replacing the store clears the old one so ids can never cross stores.
  const prev = (await conns(db).doc(creatorId).get()).data();
  if (prev && prev.shop === doc.shop && prev.locationId) { doc.locationId = prev.locationId; doc.locationName = prev.locationName || null; }
  else { doc.locationId = null; doc.locationName = null; }
  await conns(db).doc(creatorId).set(doc);
  return publicView(doc);
}

function publicView(c) {
  if (!c || c.status !== 'CONNECTED') return { connected: false, status: c ? c.status : 'NOT_CONNECTED', lastError: c && c.lastError || null };
  return { connected: true, status: c.status, shop: c.shop, shopName: c.shopName || null, locationId: c.locationId || null, locationName: c.locationName || null, scopes: c.scopes || [], connectedAtMs: c.connectedAtMs || null, lastError: c.lastError || null };
}

async function getRaw(db, creatorId) { const s = await conns(db).doc(creatorId).get(); return s.exists ? s.data() : null; }

/** Decrypts for ONE outgoing call. Returns {shop, token, locationId} or throws a coded 409 telling the creator to reconnect. */
async function load(db, creatorId, { nowMs = Date.now(), env = process.env, fetchImpl = fetch } = {}) {
  const c = await getRaw(db, creatorId);
  if (!c || c.status !== 'CONNECTED') throw err(409, 'NOT_CONNECTED', 'Connect your Shopify store first.');
  let token;
  try { token = creds.decryptSecret(c.tokenEnc, aad(creatorId)); }
  catch (e) { await markNeedsReconnect(db, creatorId, 'The saved Shopify connection could not be read.'); throw err(409, 'NEEDS_RECONNECT', 'Reconnect your Shopify store.'); }
  if (c.expiresAtMs && c.expiresAtMs - nowMs < 60 * 1000) {
    // Expiring tokens (if Shopify issued one): refresh once. UNVERIFIED against a live app; on any doubt, ask to reconnect.
    const r = await refresh(db, creatorId, c, { env, fetchImpl, nowMs });
    token = r.token;
  }
  return { shop: c.shop, token, locationId: c.locationId || null };
}

async function markNeedsReconnect(db, creatorId, message) {
  await conns(db).doc(creatorId).set({ status: 'NEEDS_RECONNECT', lastError: String(message).slice(0, 200) }, { merge: true });
}
async function recordError(db, creatorId, message) { await conns(db).doc(creatorId).set({ lastError: String(message).slice(0, 200) }, { merge: true }).catch(() => {}); }

async function refresh(db, creatorId, c, { env, fetchImpl, nowMs }) {
  const o = oauthConfig(env);
  if (!c.refreshEnc || !o.configured) { await markNeedsReconnect(db, creatorId, 'The Shopify connection expired.'); throw err(409, 'NEEDS_RECONNECT', 'Your Shopify connection expired. Reconnect your store.'); }
  try {
    const refreshToken = creds.decryptSecret(c.refreshEnc, aad(creatorId));
    const body = await tokenRequest(c.shop, { client_id: o.clientId, client_secret: o.clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken }, fetchImpl);
    const expiresAtMs = body.expires_in ? nowMs + Number(body.expires_in) * 1000 : null;
    await conns(db).doc(creatorId).set({ tokenEnc: encryptToken(body.access_token, creatorId), expiresAtMs, ...(body.refresh_token ? { refreshEnc: encryptToken(body.refresh_token, creatorId) } : {}), lastError: null }, { merge: true });
    return { token: body.access_token };
  } catch (e) {
    await markNeedsReconnect(db, creatorId, 'The Shopify connection expired.');
    throw err(409, 'NEEDS_RECONNECT', 'Your Shopify connection expired. Reconnect your store.');
  }
}

async function tokenRequest(shopDomain, payload, fetchImpl = fetch) {
  const host = shop.normaliseShop(shopDomain);
  let res; let body;
  try {
    res = await fetchImpl(`https://${host}/admin/oauth/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload) });
    body = await res.json().catch(() => null);
  } catch (e) { throw err(503, 'UNREACHABLE', 'Could not reach Shopify.'); }
  if (!res.ok || !body || typeof body.access_token !== 'string' || !body.access_token) throw err(502, 'TOKEN_EXCHANGE_FAILED', 'Shopify did not accept the connection. Start again.');
  return body;
}

// ------------------------------------------------------------------ OAuth install
async function beginInstall(db, { creatorId, shopDomain, env = process.env, nowMs = Date.now() }) {
  const o = oauthConfig(env);
  if (!o.configured) throw err(503, 'SHOPIFY_APP_NOT_CONFIGURED', 'One-tap Shopify connection is not set up yet. You can paste an Admin API token instead.');
  const host = shop.normaliseShop(shopDomain);
  const state = crypto.randomBytes(24).toString('base64url');
  await states(db).doc(sha(state)).set({ creatorId, shop: host, createdAtMs: nowMs, expiresAtMs: nowMs + STATE_TTL_MS, used: false });
  const q = new URLSearchParams({ client_id: o.clientId, scope: o.scopes, redirect_uri: o.redirectUri, state });
  return { url: `https://${host}/admin/oauth/authorize?${q.toString()}` };
}

/** Shopify's documented check: HMAC-SHA256 (hex) of the sorted query string without `hmac`, keyed with the app secret. */
function verifyHmac(query, secret) {
  const given = String((query && query.hmac) || '');
  if (!given || !secret) return false;
  const esc = (v) => String(v).replace(/%/g, '%25').replace(/&/g, '%26').replace(/=/g, '%3D');
  const message = Object.keys(query).filter((k) => k !== 'hmac' && k !== 'signature').sort().map((k) => `${esc(k)}=${esc(Array.isArray(query[k]) ? query[k].join(',') : query[k])}`).join('&');
  const mine = crypto.createHmac('sha256', secret).update(message).digest('hex');
  const a = Buffer.from(mine, 'utf8'); const b = Buffer.from(given, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** OAuth callback. Throws a coded error for ANY doubt; on success the encrypted token is stored. */
async function completeInstall(db, query, { env = process.env, fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const o = oauthConfig(env);
  if (!o.configured) throw err(503, 'SHOPIFY_APP_NOT_CONFIGURED', 'Shopify connection is not set up.');
  if (!verifyHmac(query, o.clientSecret)) throw err(400, 'BAD_HMAC', 'That Shopify link could not be verified. Start again from NOVA.');
  const host = shop.normaliseShop(query.shop);
  const code = String(query.code || ''); const state = String(query.state || '');
  if (!code || !state) throw err(400, 'BAD_CALLBACK', 'The Shopify link was incomplete. Start again from NOVA.');
  const ref = states(db).doc(sha(state));
  const claimed = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) return null;
    const d = s.data();
    if (d.used || d.expiresAtMs < nowMs || d.shop !== host) return null;
    tx.set(ref, { used: true, usedAtMs: nowMs }, { merge: true });
    return d;
  });
  if (!claimed) throw err(400, 'BAD_STATE', 'This connection attempt expired or was already used. Start again from NOVA.');
  const body = await tokenRequest(host, { client_id: o.clientId, client_secret: o.clientSecret, code }, fetchImpl);
  const scopes = String(body.scope || '').split(',').map((x) => x.trim()).filter(Boolean);
  const check = await shop.verifyConnection({ shop: host, token: body.access_token }, { fetchImpl });
  if (check.missingScopes.length) throw err(409, 'MISSING_SCOPE', `Shopify did not grant: ${check.missingScopes.join(', ')}. Start again and accept all permissions.`);
  await save(db, claimed.creatorId, { shopDomain: host, token: body.access_token, scopes: check.scopes, shopName: check.shopName, expiresAtMs: body.expires_in ? nowMs + Number(body.expires_in) * 1000 : null, refreshToken: body.refresh_token || null, nowMs });
  return { creatorId: claimed.creatorId, shop: host };
}

module.exports = { SCOPES, oauthConfig, save, load, getRaw, publicView, recordError, markNeedsReconnect, beginInstall, completeInstall, verifyHmac, tokenRequest };
