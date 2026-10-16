// mcp/lib/chatgptClient.js
//
// ChatGPT support for BOTH OAuth realms (admin + creator).
//
// ChatGPT reaches us in two ways:
//   A) As an MCP connector that registers itself (dynamic client registration).
//      That already works: it registers its own callback and uses PKCE.
//   B) As a Custom GPT "Action" (or a plugin built from our OpenAPI file).
//      ChatGPT does NOT register itself there. You type a Client ID and Client
//      Secret into the GPT editor, and ChatGPT sends the user back to
//      https://chatgpt.com/aip/g-<GPT id>/oauth/callback. Before this file the
//      server only knew Claude's callback addresses, so it refused with
//      "not configured to send you back to that address".
//
// This module defines ONE pre-agreed "static" ChatGPT client:
//   client_id     CHATGPT_CLIENT_ID (default "lexden-chatgpt")
//   client_secret CHATGPT_CLIENT_SECRET (env; if unset the static client is OFF)
//
// Safety model:
//   * A callback is accepted for the static client only if it is a real ChatGPT
//     callback shape (https, host chatgpt.com / chat.openai.com / platform.openai.com,
//     exact known path shapes, no query or fragment).
//   * Without PKCE (older GPT Actions do not send it) the code can only be
//     redeemed by presenting the client secret. An attacker's GPT never has it,
//     so a stolen code is useless to them.
//   * With PKCE, PKCE is still verified exactly as before.
//   * Optional pin: CHATGPT_ALLOWED_GPT_IDS="g-abc,g-def" restricts /aip/ callbacks
//     to your own GPT(s).
const crypto = require('crypto');

const HOSTS = new Set(['chatgpt.com', 'chat.openai.com', 'platform.openai.com']);
const PATHS = [
  /^\/aip\/(g-[A-Za-z0-9_-]{4,100})\/oauth\/callback\/?$/,
  /^\/connector_platform_oauth_redirect\/?$/,
  /^\/connector\/oauth\/[A-Za-z0-9_-]{4,100}\/?$/,
  /^\/apps-manage\/oauth\/?$/,
];

function staticClientId() {
  return (process.env.CHATGPT_CLIENT_ID || 'lexden-chatgpt').trim();
}
function staticClientSecret() {
  return (process.env.CHATGPT_CLIENT_SECRET || '').trim();
}
function staticClientEnabled() {
  return staticClientSecret().length >= 24;
}
function isStaticClientId(clientId) {
  return !!clientId && staticClientEnabled() && String(clientId) === staticClientId();
}

function isChatgptRedirect(value, env = process.env) {
  let u;
  try { u = new URL(String(value)); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.port) return false;
  if (!HOSTS.has(u.hostname.toLowerCase())) return false;
  const hit = PATHS.map((re) => re.exec(u.pathname)).find(Boolean);
  if (!hit) return false;
  const pinned = String(env.CHATGPT_ALLOWED_GPT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (pinned.length && hit[1]) return pinned.includes(hit[1]);
  if (pinned.length && !hit[1] && u.pathname.startsWith('/aip/')) return false;
  return true;
}

// May the static client use this redirect?
function staticRedirectOk(clientId, redirectUri) {
  return isStaticClientId(clientId) && isChatgptRedirect(redirectUri);
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function fromBasic(headers) {
  const h = headers && (headers.authorization || headers.Authorization);
  if (!h || !/^basic /i.test(h)) return {};
  try {
    const raw = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8');
    const i = raw.indexOf(':');
    if (i < 0) return {};
    return { id: decodeURIComponent(raw.slice(0, i)), secret: decodeURIComponent(raw.slice(i + 1)) };
  } catch { return {}; }
}

// Returns { isStatic, authenticated }. Throws an oauth-shaped error when a
// request names the static client but presents a wrong or missing secret.
function authenticateClient(body = {}, headers = {}) {
  const basic = fromBasic(headers);
  const clientId = body.client_id || basic.id || '';
  if (!isStaticClientId(clientId)) return { isStatic: false, authenticated: false, clientId };
  const secret = body.client_secret || basic.secret || '';
  if (!secret || !safeEqual(secret, staticClientSecret())) {
    throw Object.assign(new Error('invalid_client'), { oauth: true, status: 401, detail: 'Wrong or missing client secret.' });
  }
  return { isStatic: true, authenticated: true, clientId };
}

module.exports = {
  isChatgptRedirect, staticRedirectOk, isStaticClientId, staticClientId, staticClientEnabled,
  authenticateClient,
};
