// mcp/creatorOauth.js
//
// LEXDEN NOVA CREATOR — Stage J: OAuth 2.1 (authorization-code + PKCE) for
// the Creator MCP, so creators can connect Claude, ChatGPT or Gemini to
// THEIR OWN creator account. It is a deliberately separate OAuth realm from
// mcp/oauth.js (the single-admin one):
//
//   admin realm    issuer  {base}            resource {base}/mcp           scope 'admin'
//   creator realm  issuer  {base}/creator    resource {base}/mcp/creator  scope 'creator'
//
// Why a separate issuer instead of one server that decides by a `scope` or
// `resource` request parameter: those are client-supplied. Here the SCOPE A
// TOKEN GETS IS DECIDED BY WHICH ENDPOINT MINTED IT — a client can't ask
// the creator realm for admin power, because the creator realm can only
// ever write 'creator'. (The admin gate additionally refuses non-admin
// scopes and non-admin emails; see mcp/lib/authMiddleware.js.)
//
// Identity: the creator signs in with the SAME Firebase Auth they use on the
// storefront (email/password or Google). This server never sees a password;
// it receives a short-lived Firebase ID token, verifies it with the Admin
// SDK, and then requires that the uid is an approved, not-suspended creator
// (creators/{uid}). The uid — never an email — becomes the token's identity.
//
// Consent: dynamic client registration is open (that's what lets Claude,
// ChatGPT and Gemini register themselves), which means anybody can register
// a client with their own redirect URI and send a creator a crafted link.
// So after sign-in the page shows WHICH app is asking and WHERE it will be
// sent, and requires an explicit "Allow" — it never auto-authorizes.

const crypto = require('crypto');
const oauth = require('./oauth');
const tokens = require('./lib/tokens');
const chatgpt = require('./lib/chatgptClient');
const { getAuthAdmin } = require('../api/affiliate/shared');
const { getCreatorDoc } = require('../api/creator/shared');
const { assertSellerNotBlocked } = require('../api/creator/state-machine');

const REALM_PATH = '/creator';
const RESOURCE_PATH = '/mcp/creator';
const SCOPES_SUPPORTED = ['creator', 'offline_access'];

// ---------------------------------------------------------------- pure helpers

// The creator realm can only ever mint 'creator' (+ offline_access for
// refresh). Anything else a client asks for — including 'admin' — is dropped.
function normalizeCreatorScope() {
  return 'creator offline_access';
}

function hasScope(scopeString, wanted) {
  return String(scopeString || '').split(/\s+/).filter(Boolean).includes(wanted);
}

// Registered redirect URIs must be https, or http on loopback (Gemini CLI and
// similar local tools use a localhost callback). Blocks javascript:, data:,
// custom schemes and plain-http remote hosts.
function isAcceptableRedirectUri(value) {
  try {
    const u = new URL(String(value));
    if (u.username || u.password || u.hash) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]');
  } catch {
    return false;
  }
}

// Used only for the human-readable consent screen — it is NOT the security
// boundary (the Firebase sign-in + explicit Allow are).
function describeRedirect(redirectUri) {
  let host = '';
  try { host = new URL(String(redirectUri)).hostname.toLowerCase(); } catch { /* leave empty */ }
  const is = (h, d) => h === d || h.endsWith('.' + d);
  if (is(host, 'claude.ai') || is(host, 'claude.com')) return { host, kind: 'known', label: 'Claude' };
  if (is(host, 'chatgpt.com') || is(host, 'openai.com')) return { host, kind: 'known', label: 'ChatGPT' };
  if (is(host, 'google.com') || is(host, 'googleusercontent.com')) return { host, kind: 'known', label: 'Google Gemini' };
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return { host, kind: 'local', label: 'an app running on your own computer (for example Gemini CLI)' };
  return { host, kind: 'unknown', label: 'an app you may not recognise' };
}

// Is this creator allowed to use the Creator MCP right now? Same rule the
// REST API applies (requireActiveCreator): must exist, and not be suspended
// or revoked.
function evaluateCreatorAccess(creator) {
  if (!creator) return { ok: false, message: 'This account is not an approved LEXDEN NOVA creator yet. Apply and get approved in the app first, then connect.' };
  try {
    assertSellerNotBlocked(creator.status);
  } catch (e) {
    return { ok: false, message: e.message || 'This creator account is not currently active.' };
  }
  return { ok: true };
}

// Runs on EVERY /mcp/creator request (see mcp/index.js), so suspending a
// creator cuts off their AI assistant immediately, not at token expiry.
async function creatorIdentityCheck(authInfo, deps = {}) {
  const getCreator = deps.getCreatorDoc || getCreatorDoc;
  const uid = authInfo && authInfo.extra && authInfo.extra.uid;
  if (!uid) return { ok: false, message: 'This token has no creator identity.' };
  return evaluateCreatorAccess(await getCreator(uid));
}

// Safe to embed in an inline <script type="application/json"> block.
function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function realmError(detail) {
  return Object.assign(new Error('invalid_grant'), { oauth: true, detail });
}

// ---------------------------------------------------------------- sign-in page

function creatorSignInHtml(ctx) {
  // ctx is attacker-influenced (client_name, redirect host come from DCR /
  // the query string). It is embedded as JSON and only ever written into the
  // page with textContent — never string-interpolated into HTML.
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>LEXDEN NOVA — Connect your AI assistant</title>
<style>
  body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1220;color:#eef2ff;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;}
  .card{background:#111a2e;border:1px solid #22304d;border-radius:16px;padding:28px;max-width:420px;width:92%;}
  h1{font-size:18px;margin:0 0 6px;} p{color:#93a3c4;font-size:13.5px;line-height:1.5;margin:0 0 16px;}
  input{width:100%;box-sizing:border-box;padding:11px 12px;margin-bottom:10px;border-radius:8px;border:1px solid #2a3a5c;background:#0d1526;color:#eef2ff;font-size:14px;}
  button{width:100%;padding:11px;border-radius:8px;border:none;font-weight:700;cursor:pointer;font-size:14px;margin-bottom:8px;}
  .primary{background:#d4af37;color:#111;} .secondary{background:#1b2742;color:#eef2ff;border:1px solid #2a3a5c;}
  button:disabled{opacity:.6;cursor:default;}
  .err{color:#ff8a8a;font-size:13px;margin-bottom:10px;min-height:16px;}
  .who{background:#0d1526;border:1px solid #2a3a5c;border-radius:10px;padding:12px;margin-bottom:14px;font-size:13.5px;}
  .warn{background:#3a1f1f;border:1px solid #7a3b3b;color:#ffb4b4;border-radius:10px;padding:10px 12px;font-size:13px;margin-bottom:14px;}
  ul{margin:0 0 14px 18px;padding:0;color:#c9d4ee;font-size:13px;line-height:1.55;} .no{color:#ffcf8a;}
  .hidden{display:none;} .sep{text-align:center;color:#5d6f94;font-size:12px;margin:2px 0 8px;}

  .password-visibility-wrap{position:relative;display:block;width:100%;margin-bottom:10px;}
  .password-visibility-wrap input{width:100%;box-sizing:border-box;margin-bottom:0;padding-right:48px;}
  button.password-visibility-toggle{
    position:absolute;top:50%;right:7px;transform:translateY(-50%);
    display:flex;align-items:center;justify-content:center;
    width:36px;height:36px;padding:0;margin:0;border:0;border-radius:7px;
    background:transparent;color:#93a3c4;cursor:pointer;
  }
  button.password-visibility-toggle:focus-visible{outline:2px solid #d4af37;outline-offset:2px;}
  button.password-visibility-toggle svg{display:block;width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;}
</style></head>
<body>
<div class="card">
  <div id="view-signin">
    <h1>Connect your AI assistant</h1>
    <p>Sign in with your LEXDEN NOVA creator account. You'll be asked to confirm before anything is connected.</p>
    <div class="err" id="err"></div>
    <input id="email" type="email" placeholder="Email" autocomplete="username">
    <div class="password-visibility-wrap">
      <input id="pass" type="password" placeholder="Password" autocomplete="current-password">
      <button type="button" class="password-visibility-toggle" id="toggle-pass" aria-label="Show password" aria-controls="pass" aria-pressed="false" title="Show password"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"></path><circle cx="12" cy="12" r="3"></circle></svg></button>
    </div>
    <button class="primary" id="btn-email">Sign in</button>
    <div class="sep">or</div>
    <button class="secondary" id="btn-google">Continue with Google</button>
  </div>
  <div id="view-consent" class="hidden">
    <h1>Allow this connection?</h1>
    <div class="who"><div>Signed in as <b id="who-email"></b></div><div style="margin-top:6px">Requested by: <b id="client-name"></b></div><div>You will be sent back to: <b id="redirect-host"></b></div></div>
    <div class="warn hidden" id="unknown-warn">We don't recognise this app. Only continue if YOU just started connecting an assistant. If someone sent you this link, choose Cancel.</div>
    <p style="margin-bottom:6px">This assistant will be able to, for <b>your creator account only</b>:</p>
    <ul>
      <li>View your listings, sales, earnings and orders</li>
      <li>Create and edit listing drafts, and submit them for LEXDEN NOVA review</li>
      <li>Mark your orders packed or shipped, and request a withdrawal</li>
    </ul>
    <p style="margin-bottom:6px">It can <b class="no">not</b>:</p>
    <ul>
      <li class="no">Publish anything without admin approval</li>
      <li class="no">Change your bank details or documents</li>
      <li class="no">See other creators, or any admin tools</li>
    </ul>
    <div class="err" id="err2"></div>
    <button class="primary" id="btn-allow">Allow</button>
    <button class="secondary" id="btn-cancel">Cancel</button>
  </div>
</div>
<script id="ctx" type="application/json">${jsonForScript(ctx)}</script>
<script type="module">
  import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
  import { getAuth, signInWithEmailAndPassword, signInWithPopup, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
  const ctx = JSON.parse(document.getElementById('ctx').textContent);
  const $ = (id) => document.getElementById(id);

  const passwordInput = $('pass');
  const passwordToggle = $('toggle-pass');
  const passwordEyeIcon = "<svg viewBox='0 0 24 24' aria-hidden='true' focusable='false'><path d='M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z'></path><circle cx='12' cy='12' r='3'></circle></svg>";
  const passwordEyeOffIcon = "<svg viewBox='0 0 24 24' aria-hidden='true' focusable='false'><path d='m3 3 18 18'></path><path d='M10.6 10.6a2 2 0 0 0 2.8 2.8'></path><path d='M9.9 5.2A10.5 10.5 0 0 1 12 5c6.4 0 10 7 10 7a16 16 0 0 1-3 4.1'></path><path d='M6.6 6.6C3.8 8.3 2 12 2 12s3.6 7 10 7c.9 0 1.8-.1 2.6-.4'></path></svg>";
  passwordToggle.addEventListener('click', () => {
    const reveal = passwordInput.type === 'password';
    passwordInput.type = reveal ? 'text' : 'password';
    passwordToggle.setAttribute('aria-pressed', String(reveal));
    passwordToggle.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
    passwordToggle.title = reveal ? 'Hide password' : 'Show password';
    passwordToggle.innerHTML = reveal ? passwordEyeOffIcon : passwordEyeIcon;
  });
  const app = initializeApp({
    apiKey: "AIzaSyBk4WD0D5m6386sb62KC-5KKMpUuOLC9fs",
    authDomain: "lexden-nova.firebaseapp.com",
    projectId: "lexden-nova",
    appId: "1:421157476875:web:c42a605fdb056c8282450e"
  });
  const auth = getAuth(app);
  let idToken = null;

  $('client-name').textContent = ctx.clientName;
  $('redirect-host').textContent = ctx.redirectHost + (ctx.redirectLabel ? ' (' + ctx.redirectLabel + ')' : '');
  if (ctx.redirectKind === 'unknown') $('unknown-warn').classList.remove('hidden');

  function showConsent(user, token) {
    idToken = token;
    $('who-email').textContent = user.email || user.uid;
    $('view-signin').classList.add('hidden');
    $('view-consent').classList.remove('hidden');
  }
  async function finishSignIn(promise) {
    $('err').textContent = '';
    const buttons = [$('btn-email'), $('btn-google')];
    buttons.forEach((b) => (b.disabled = true));
    try {
      const result = await promise();
      showConsent(result.user, await result.user.getIdToken());
    } catch (e) {
      $('err').textContent = e && e.code === 'auth/unauthorized-domain'
        ? 'Google sign-in is not enabled for this address yet. Use your email and password instead.'
        : (e && e.message) || 'Sign-in failed.';
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }
  $('btn-email').onclick = () => finishSignIn(() => signInWithEmailAndPassword(auth, $('email').value.trim(), $('pass').value));
  $('btn-google').onclick = () => finishSignIn(() => signInWithPopup(auth, new GoogleAuthProvider()));

  $('btn-cancel').onclick = () => {
    const u = new URL(ctx.redirectUri);
    u.searchParams.set('error', 'access_denied');
    if (ctx.params.state) u.searchParams.set('state', ctx.params.state);
    u.searchParams.set('iss', ctx.issuer);
    location.href = u.toString();
  };
  $('btn-allow').onclick = async () => {
    $('err2').textContent = '';
    $('btn-allow').disabled = true;
    try {
      const resp = await fetch('/creator/authorize/complete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, params: ctx.params })
      });
      const data = await resp.json();
      if (!resp.ok || !data.redirect) throw new Error(data.error_description || data.error || 'Could not authorize.');
      location.href = data.redirect;
    } catch (e) {
      $('err2').textContent = e.message || 'Could not authorize.';
      $('btn-allow').disabled = false;
    }
  };
</script>
</body></html>`;
}

// ---------------------------------------------------------------- routes

function registerRoutes(app, deps = {}) {
  const { baseUrl, allowedRedirectUris } = oauth;
  const issuerOf = (req) => `${baseUrl(req)}${REALM_PATH}`;
  const resourceOf = (req) => `${baseUrl(req)}${RESOURCE_PATH}`;

  // ---- Discovery ----
  app.get(`/.well-known/oauth-protected-resource${RESOURCE_PATH}`, (req, res) => {
    res.json({
      resource: resourceOf(req),
      authorization_servers: [issuerOf(req)],
      scopes_supported: SCOPES_SUPPORTED,
      bearer_methods_supported: ['header'],
    });
  });

  const asMetadata = (req) => {
    const i = issuerOf(req);
    return {
      issuer: i,
      authorization_endpoint: `${i}/authorize`,
      token_endpoint: `${i}/token`,
      registration_endpoint: `${i}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: SCOPES_SUPPORTED,
      authorization_response_iss_parameter_supported: true,
      service_documentation: `${baseUrl(req)}/health`,
    };
  };
  // RFC 8414 puts the well-known segment between host and issuer path; MCP
  // clients also fall back to the OpenID Connect discovery shapes.
  app.get(`/.well-known/oauth-authorization-server${REALM_PATH}`, (req, res) => res.json(asMetadata(req)));
  app.get(`/.well-known/openid-configuration${REALM_PATH}`, (req, res) => res.json(asMetadata(req)));
  app.get(`${REALM_PATH}/.well-known/openid-configuration`, (req, res) => res.json(asMetadata(req)));

  // ---- Dynamic Client Registration (RFC 7591), with a stricter redirect-URI rule ----
  app.post(`${REALM_PATH}/register`, async (req, res) => {
    const rid = oauth.reqId();
    const body = req.body || {};
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (!redirectUris.length || redirectUris.length > 5 || !redirectUris.every(isAcceptableRedirectUri)) {
      oauth.logStep(rid, 'creator register REJECTED bad redirect_uris');
      return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'Provide 1-5 redirect URIs; each must be https (or http on localhost).' });
    }
    const clientId = crypto.randomBytes(16).toString('hex');
    const clientName = String(body.client_name || 'MCP Client').slice(0, 80);
    try {
      await oauth.persistClientRegistration({ clientId, redirectUris, clientName, tokenEndpointAuthMethod: 'none' });
    } catch (e) {
      console.error('[mcp/creator-oauth] register: failed to persist client', e.message);
    }
    oauth.logStep(rid, 'creator register', { client: clientId });
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: clientName,
    });
  });

  async function redirectAllowed(clientId, redirectUri) {
    const registered = await oauth.getRegisteredClient(clientId).catch(() => null);
    const inRegistration = !!(registered && Array.isArray(registered.redirectUris) && registered.redirectUris.includes(redirectUri));
    const inAllowlist = allowedRedirectUris().includes(redirectUri) || chatgpt.staticRedirectOk(clientId, redirectUri);
    // A client that registered must use one of ITS registered URIs, even if
    // another is on the global allowlist.
    if (registered && Array.isArray(registered.redirectUris) && registered.redirectUris.length && !inRegistration) return { ok: false, registered };
    return { ok: !!redirectUri && (inRegistration || inAllowlist) && isAcceptableRedirectUri(redirectUri), registered };
  }

  // ---- /creator/authorize ----
  app.get(`${REALM_PATH}/authorize`, async (req, res) => {
    const rid = oauth.reqId();
    const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, resource } = req.query;
    const { ok, registered } = await redirectAllowed(client_id, redirect_uri);
    if (!ok) {
      oauth.logStep(rid, 'creator authorize REJECTED redirect_uri', { client: client_id });
      return res.status(400).send('This connector is not configured to send you back to that address.');
    }
    const noPkceOk = chatgpt.isStaticClientId(client_id) && !code_challenge;
    if (response_type !== 'code' || !client_id || (!code_challenge && !noPkceOk) || (code_challenge_method && code_challenge_method !== 'S256')) {
      oauth.logStep(rid, 'creator authorize REJECTED invalid_request', { client: client_id });
      const url = new URL(redirect_uri);
      url.searchParams.set('error', 'invalid_request');
      if (req.query.state) url.searchParams.set('state', req.query.state);
      url.searchParams.set('iss', issuerOf(req));
      return res.redirect(url.toString());
    }
    if (resource && resource !== resourceOf(req) && resource.replace(/\/+$/, '') !== resourceOf(req)) {
      oauth.logStep(rid, 'creator authorize REJECTED invalid_target', { client: client_id });
      return res.status(400).send('That connector asked for a different resource than the Creator connector.');
    }
    const info = describeRedirect(redirect_uri);
    oauth.logStep(rid, 'creator authorize', { client: client_id, redirectHost: info.host });
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
    });
    res.send(creatorSignInHtml({
      params: Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(v)])),
      clientName: String((registered && registered.clientName) || 'An AI assistant').slice(0, 80),
      redirectUri: String(redirect_uri),
      redirectHost: info.host,
      redirectKind: info.kind,
      redirectLabel: info.kind === 'unknown' ? '' : info.label,
      issuer: issuerOf(req),
    }));
  });

  // ---- /creator/authorize/complete ----
  app.post(`${REALM_PATH}/authorize/complete`, async (req, res) => {
    const rid = oauth.reqId();
    const { idToken, params } = req.body || {};
    const p = params || {};
    const { ok } = await redirectAllowed(p.client_id, p.redirect_uri);
    if (!ok) {
      oauth.logStep(rid, 'creator complete REJECTED redirect_uri', { client: p.client_id });
      return res.status(400).json({ error: 'invalid_request', error_description: 'Unrecognized redirect_uri.' });
    }
    if ((!p.code_challenge && !chatgpt.isStaticClientId(p.client_id)) || (p.code_challenge_method && p.code_challenge_method !== 'S256')) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'PKCE (S256) is required.' });
    }
    if (p.resource && p.resource !== resourceOf(req) && String(p.resource).replace(/\/+$/, '') !== resourceOf(req)) {
      return res.status(400).json({ error: 'invalid_target', error_description: 'resource does not match the Creator connector.' });
    }
    let decoded;
    try {
      decoded = await (deps.verifyIdToken || ((t) => getAuthAdmin().verifyIdToken(t, true)))(idToken);
    } catch {
      oauth.logStep(rid, 'creator complete 401 firebase_ok=false', { client: p.client_id });
      return res.status(401).json({ error: 'access_denied', error_description: 'Could not verify that sign-in — try again.' });
    }
    const access = evaluateCreatorAccess(await (deps.getCreatorDoc || getCreatorDoc)(decoded.uid));
    if (!access.ok) {
      oauth.logStep(rid, 'creator complete 403 creator=false', { client: p.client_id });
      return res.status(403).json({ error: 'access_denied', error_description: access.message });
    }
    const code = await tokens.createAuthCode({
      clientId: p.client_id,
      redirectUri: p.redirect_uri,
      codeChallenge: p.code_challenge || null,
      codeChallengeMethod: 'S256',
      resource: p.resource ? resourceOf(req) : null,
      email: decoded.email || null,
      uid: decoded.uid,
      scope: normalizeCreatorScope(p.scope),
    });
    oauth.logStep(rid, 'creator complete 200 auth_code_issued', { client: p.client_id });
    const url = new URL(p.redirect_uri);
    url.searchParams.set('code', code);
    if (p.state) url.searchParams.set('state', p.state);
    url.searchParams.set('iss', issuerOf(req));
    res.json({ redirect: url.toString() });
  });

  // ---- /creator/token ----
  app.post(`${REALM_PATH}/token`, async (req, res) => {
    const rid = oauth.reqId();
    const body = req.body || {};
    res.set('Cache-Control', 'no-store');
    try {
      const client = chatgpt.authenticateClient(body, req.headers);
      let session;
      if (body.grant_type === 'authorization_code') {
        session = await tokens.consumeAuthCode({
          code: body.code, clientId: body.client_id || client.clientId, redirectUri: body.redirect_uri,
          codeVerifier: body.code_verifier, resource: body.resource || null,
          clientAuthenticated: client.authenticated,
        });
      } else if (body.grant_type === 'refresh_token') {
        session = await tokens.consumeRefreshToken(body.refresh_token);
        if (chatgpt.isStaticClientId(session.clientId) && !client.authenticated) throw Object.assign(new Error('invalid_client'), { oauth: true, detail: 'Client secret required.' });
        // A suspended/revoked creator must not be able to keep refreshing.
        const still = evaluateCreatorAccess(await (deps.getCreatorDoc || getCreatorDoc)(session.uid));
        if (!still.ok) throw realmError(still.message);
      } else {
        oauth.logStep(rid, 'creator token REJECTED unsupported_grant_type');
        return res.status(400).json({ error: 'unsupported_grant_type' });
      }
      // A code or refresh token minted by ANY other realm (e.g. admin) is
      // not redeemable here.
      if (!hasScope(session.scope, 'creator') || hasScope(session.scope, 'admin')) {
        throw realmError('This grant was not issued for the Creator connector.');
      }
      const { email, uid, clientId, resource } = session;
      const scope = normalizeCreatorScope();
      const access = await tokens.issueAccessToken({ email, uid, scope, clientId, resource });
      const refresh_token = await tokens.issueRefreshToken({ email, uid, scope, clientId, resource });
      oauth.logStep(rid, 'creator token success', { client: clientId });
      return res.json({ access_token: access.token, token_type: 'Bearer', expires_in: access.expiresIn, refresh_token, scope });
    } catch (e) {
      if (e.oauth) {
        oauth.logStep(rid, `creator token REJECTED ${e.message}`, { client: body.client_id });
        return res.status(e.status || 400).json({ error: e.message, error_description: e.detail });
      }
      console.error(`[mcp/creator-oauth] rid=${rid} /token failed:`, e.message);
      return res.status(500).json({ error: 'server_error' });
    }
  });
}

module.exports = {
  registerRoutes, creatorIdentityCheck, evaluateCreatorAccess,
  normalizeCreatorScope, hasScope, isAcceptableRedirectUri, describeRedirect,
  jsonForScript, creatorSignInHtml, REALM_PATH, RESOURCE_PATH, SCOPES_SUPPORTED,
};
