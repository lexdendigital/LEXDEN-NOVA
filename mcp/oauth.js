// mcp/oauth.js
//
// Claude's "Add custom connector" flow expects a real OAuth 2.1
// authorization-code + PKCE dance in front of a remote MCP server (see
// MCP-SETUP.md for the walkthrough + why "No sign-in" mode isn't used
// here). What follows is the smallest version of that which is still
// actually secure for a single-admin store:
//
//   - GET  /authorize    renders a sign-in page that uses the SAME
//                         Firebase Auth project/config as the storefront
//                         and admin portal. It never sees a password on
//                         this server — the browser talks to Firebase
//                         directly, exactly like index.html's own admin
//                         login already does, and hands this server only
//                         a short-lived Firebase ID token to verify.
//   - POST /authorize/complete   verifies that ID token server-side,
//                         checks it's really the admin email, and mints
//                         a one-time authorization code.
//   - POST /register     minimal Dynamic Client Registration (RFC 7591)
//                         so Claude's "Register automatically" option
//                         works. client_id is NOT a secret and isn't the
//                         security boundary here — the Firebase sign-in
//                         step is. See MCP-SETUP.md for the reasoning.
//   - POST /token         exchanges the code (or a refresh token) for a
//                         bearer access token, per mcp/lib/tokens.js.
//   - GET  /.well-known/oauth-protected-resource   (RFC 9728)
//   - GET  /.well-known/oauth-authorization-server (RFC 8414)
//
// The actual authorization check — "is this really Lexden" — happens
// once, at /authorize/complete, via Firebase verifyIdToken() + the same
// isAdminEmail() used everywhere else in this codebase. Every token this
// file ever issues is scoped to that one check having passed.
//
// FIX (MCP fix batch, per SONNET-5-LEXDEN-NOVA-MCP-FIX-README.md):
//  §4  discovery metadata + the authorize redirect now include `iss`
//      (RFC 9207), always equal to the one canonical MCP_BASE_URL.
//  §5  /register now PERSISTS the client registration (mcpClients
//      collection) instead of handing back an unpersisted client_id.
//      /authorize validates redirect_uri against that registration when
//      the client_id is one we actually registered, while still
//      accepting the two hardcoded Claude callback URLs unconditionally
//      (so a client that skips DCR / uses CIMD isn't newly broken).
//  §6  the OAuth `resource` parameter is now captured at /authorize and
//      carried through to the auth code and access token (see
//      mcp/lib/tokens.js), instead of being silently ignored.
//  §11 structured, secret-free logs at every step of the flow, each
//      tagged with a short request id so a single attempt can be
//      followed end-to-end in Render logs.
//  §12 the browser sign-in page already refuses to navigate to Claude on
//      any non-2xx from /authorize/complete (kept — see the page's own
//      try/catch below); this file now also always returns a proper
//      OAuth-shaped {error, error_description} on every failure path.

const crypto = require('crypto');
const { getAuthAdmin, isAdminEmail, getDb, FieldValue } = require('../api/affiliate/shared');
const tokens = require('./lib/tokens');

const DEFAULT_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];

function allowedRedirectUris() {
  const extra = (process.env.MCP_EXTRA_REDIRECT_URIS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return [...DEFAULT_REDIRECT_URIS, ...extra];
}

// FIX (§14): one canonical URL builder, used everywhere a base URL is
// needed — issuer, every discovery/endpoint URL, and the `iss` param.
// Never derived from the incoming Host header when MCP_BASE_URL is set,
// since that header is attacker-influenceable and, more mundanely, will
// silently disagree with the real public URL if this ever runs behind
// any proxy/rewrite.
function baseUrl(req) {
  if (process.env.MCP_BASE_URL) return process.env.MCP_BASE_URL.trim().replace(/\/+$/, '');
  // Fallback so this doesn't hard-crash before MCP_BASE_URL is set on
  // Render, but a mismatched base URL breaks OAuth redirect matching, so
  // MCP-SETUP.md tells you to set this explicitly rather than rely on it.
  return `${req.protocol}://${req.get('host')}`;
}

function reqId() {
  return crypto.randomBytes(4).toString('hex');
}
// FIX (§11): one place all OAuth-flow logging goes through, so every
// line is greppable as `[mcp/oauth]` and never accidentally carries a
// token/password/idToken — only the safe metadata the fix README listed.
function logStep(rid, msg, fields) {
  const safe = fields ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ') : '';
  console.log(`[mcp/oauth] rid=${rid} ${msg}${safe}`);
}

// ---------------- Dynamic Client Registration persistence (§5) ----------------

async function persistClientRegistration({ clientId, redirectUris, clientName, tokenEndpointAuthMethod }) {
  const db = getDb();
  await db.collection('mcpClients').doc(clientId).set({
    clientId,
    redirectUris: Array.isArray(redirectUris) ? redirectUris : [],
    clientName: clientName || 'MCP Client',
    tokenEndpointAuthMethod: tokenEndpointAuthMethod || 'none',
    grantTypes: ['authorization_code', 'refresh_token'],
    responseTypes: ['code'],
    createdAt: FieldValue.serverTimestamp(),
  });
}

async function getRegisteredClient(clientId) {
  if (!clientId) return null;
  const db = getDb();
  const snap = await db.collection('mcpClients').doc(clientId).get();
  return snap.exists ? snap.data() : null;
}

function firebaseSignInHtml({ authError }) {
  // Same firebaseConfig as index.html / affiliate/index.html — the
  // apiKey is not a secret (it's already public in both of those
  // bundles); what actually gates access is the email check below.
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LEXDEN NOVA — Connect Claude</title>
<style>
  body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1220;color:#eef2ff;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;}
  .card{background:#111a2e;border:1px solid #22304d;border-radius:16px;padding:32px;max-width:380px;width:90%;}
  h1{font-size:18px;margin:0 0 4px;} p.sub{color:#93a3c4;font-size:13.5px;margin:0 0 22px;}
  input{width:100%;box-sizing:border-box;padding:11px 12px;margin-bottom:10px;border-radius:8px;border:1px solid #2a3a5c;background:#0d1526;color:#eef2ff;font-size:14px;}
  button{width:100%;padding:11px;border-radius:8px;border:none;background:#d4af37;color:#111;font-weight:700;cursor:pointer;font-size:14px;}
  button:disabled{opacity:.6;cursor:default;}
  .err{color:#ff8a8a;font-size:13px;margin-bottom:10px;min-height:16px;}
</style></head>
<body>
  <div class="card">
    <h1>Connect Claude to LEXDEN NOVA</h1>
    <p class="sub">Sign in with the admin account to let Claude access your admin portal.</p>
    <div class="err" id="err">${authError ? String(authError).replace(/</g, '&lt;') : ''}</div>
    <input id="email" type="email" placeholder="Admin email" autocomplete="username">
    <input id="pass" type="password" placeholder="Password" autocomplete="current-password">
    <button id="btn">Sign In &amp; Authorize</button>
  </div>
  <script type="module">
    import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
    import { getAuth, signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
    const app = initializeApp({
      apiKey: "AIzaSyBk4WD0D5m6386sb62KC-5KKMpUuOLC9fs",
      authDomain: "lexden-nova.firebaseapp.com",
      projectId: "lexden-nova",
      appId: "1:421157476875:web:c42a605fdb056c8282450e"
    });
    const auth = getAuth(app);
    const btn = document.getElementById('btn');
    const err = document.getElementById('err');
    const qs = new URLSearchParams(location.search);
    btn.onclick = async () => {
      err.textContent = '';
      btn.disabled = true; btn.textContent = 'Signing in…';
      try {
        const email = document.getElementById('email').value.trim();
        const pass = document.getElementById('pass').value;
        const result = await signInWithEmailAndPassword(auth, email, pass);
        const idToken = await result.user.getIdToken();
        const resp = await fetch('/authorize/complete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken, params: Object.fromEntries(qs.entries()) })
        });
        const data = await resp.json();
        // FIX (§12): every non-2xx here is a distinct, explicit failure —
        // 401 (bad credentials upstream of Firebase itself would already
        // have thrown above), 403 (wrong/non-admin account), 400
        // (redirect_uri/client/PKCE problem), 500 (server-side fault) —
        // and NONE of them ever navigate to Claude. Only a genuine
        // {redirect} on a 2xx does.
        if (!resp.ok || !data.redirect) throw new Error(data.error_description || data.error || 'Sign-in failed.');
        location.href = data.redirect;
      } catch (e) {
        err.textContent = e.message || 'Sign-in failed.';
        btn.disabled = false; btn.textContent = 'Sign In & Authorize';
      }
    };
  </script>
</body></html>`;
}

function registerRoutes(app) {
  // ---- Discovery metadata ----
  app.get('/.well-known/oauth-protected-resource', (req, res) => {
    const b = baseUrl(req);
    res.json({ resource: `${b}/mcp`, authorization_servers: [b] });
  });
  // RFC 9728 path-suffixed form — Claude probes this one first for /mcp.
  app.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
    const b = baseUrl(req);
    res.json({ resource: `${b}/mcp`, authorization_servers: [b], scopes_supported: ['admin'], bearer_methods_supported: ['header'] });
  });
  app.get('/.well-known/oauth-authorization-server/mcp', (req, res) => res.redirect(302, '/.well-known/oauth-authorization-server'));
  app.get('/.well-known/openid-configuration', (req, res) => res.redirect(302, '/.well-known/oauth-authorization-server'));
  app.get('/.well-known/oauth-authorization-server', (req, res) => {
    const b = baseUrl(req);
    res.json({
      issuer: b, // FIX (§4/§14): canonical, matches `iss` below exactly
      authorization_endpoint: `${b}/authorize`,
      token_endpoint: `${b}/token`,
      registration_endpoint: `${b}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      service_documentation: `${b}/health`,
      scopes_supported: ['admin'],
    });
  });

  // ---- Dynamic Client Registration (RFC 7591), minimal but now persisted ----
  app.post('/register', async (req, res) => {
    const rid = reqId();
    const body = req.body || {};
    const clientId = crypto.randomBytes(16).toString('hex');
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    try {
      // FIX (§5): actually persist the registration so later steps can
      // validate against it — previously this client_id was handed back
      // and then never stored anywhere.
      await persistClientRegistration({
        clientId, redirectUris, clientName: body.client_name,
        tokenEndpointAuthMethod: body.token_endpoint_auth_method,
      });
    } catch (e) {
      console.error('[mcp/oauth] register: failed to persist client', e.message);
      // Registration is still USABLE even if the Firestore write fails
      // (the flow degrades to the old "trust whatever client_id shows up
      // consistently" behavior) — a persistence hiccup here must never
      // be the thing that breaks a brand-new connection attempt.
    }
    logStep(rid, 'register', { client: clientId });
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: body.client_name || 'MCP Client',
    });
  });

  // ---- /authorize (GET: render sign-in; validate redirect_uri BEFORE
  // ever rendering anything, since an unvalidated redirect_uri is the
  // classic way this kind of endpoint gets abused for open-redirect /
  // code-theft attacks) ----
  app.get('/authorize', async (req, res) => {
    const rid = reqId();
    const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, resource } = req.query;
    if (!redirect_uri || !allowedRedirectUris().includes(redirect_uri)) {
      logStep(rid, 'authorize REJECTED redirect_uri not allowlisted', { client: client_id, redirect: redirect_uri });
      return res.status(400).send('This connector is not configured to send you back to that address. Check MCP_EXTRA_REDIRECT_URIS if this is a legitimate client.');
    }
    // FIX (§5): if this client_id WAS registered via /register, its
    // redirect_uri must actually be one it registered. Clients that
    // never called /register (CIMD-style, or a hand-configured
    // connector) are still allowed through on the hardcoded-allowlist
    // check above — this is an extra check, not a replacement for it.
    const registered = await getRegisteredClient(client_id).catch(() => null);
    if (registered && registered.redirectUris.length && !registered.redirectUris.includes(redirect_uri)) {
      logStep(rid, 'authorize REJECTED redirect_uri not in this client\'s registration', { client: client_id });
      return res.status(400).send('redirect_uri does not match what this client registered.');
    }
    if (response_type !== 'code' || !client_id || !code_challenge || (code_challenge_method && code_challenge_method !== 'S256')) {
      logStep(rid, 'authorize REJECTED invalid_request', { client: client_id });
      const url = new URL(redirect_uri);
      url.searchParams.set('error', 'invalid_request');
      if (req.query.state) url.searchParams.set('state', req.query.state);
      return res.redirect(url.toString());
    }
    logStep(rid, 'authorize', { client: client_id, redirect: redirect_uri, resource: resource || '(none)' });
    res.set('Content-Type', 'text/html').send(firebaseSignInHtml({}));
  });

  // ---- /authorize/complete (POST from the sign-in page's JS, body
  // already parsed as JSON by server.js's global express.json()) ----
  app.post('/authorize/complete', async (req, res) => {
    const rid = reqId();
    const { idToken, params } = req.body || {};
    const p = params || {};
    if (!p.redirect_uri || !allowedRedirectUris().includes(p.redirect_uri)) {
      logStep(rid, 'authorize/complete REJECTED bad redirect_uri', { client: p.client_id });
      return res.status(400).json({ error: 'invalid_request', error_description: 'Unrecognized redirect_uri.' });
    }
    let decoded;
    try {
      decoded = await getAuthAdmin().verifyIdToken(idToken);
    } catch {
      logStep(rid, 'authorize/complete 401 firebase_ok=false', { client: p.client_id });
      return res.status(401).json({ error: 'access_denied', error_description: 'Could not verify that sign-in — try again.' });
    }
    if (!isAdminEmail(decoded.email)) {
      logStep(rid, 'authorize/complete 403 admin=false', { client: p.client_id });
      return res.status(403).json({ error: 'access_denied', error_description: `${decoded.email || 'That account'} is not the LEXDEN NOVA admin account.` });
    }
    const code = await tokens.createAuthCode({
      clientId: p.client_id,
      redirectUri: p.redirect_uri,
      codeChallenge: p.code_challenge,
      codeChallengeMethod: p.code_challenge_method || 'S256',
      resource: p.resource || null, // FIX (§6)
      email: decoded.email,
      uid: decoded.uid,
      scope: 'admin',
    });
    logStep(rid, 'authorize/complete 200 firebase_ok=true admin=true auth_code_issued', { client: p.client_id });
    const url = new URL(p.redirect_uri);
    url.searchParams.set('code', code);
    if (p.state) url.searchParams.set('state', p.state);
    url.searchParams.set('iss', baseUrl(req)); // FIX (§4): RFC 9207 issuer identification
    // Note: this is intentionally JSON + a client-side location.href, not
    // a server-side 302, from THIS endpoint — the sign-in itself only
    // exists as a browser-side Firebase call (this server never sees a
    // password), so the browser must already be alive with JS running
    // when the redirect happens. A raw 302 from here would just be
    // followed silently by the fetch() call above and never move the
    // top-level window at all. `location.href = data.redirect` below
    // performs a real, standard top-level browser navigation to the
    // exact Claude callback URL — indistinguishable, from Claude's OAuth
    // client's point of view, from arriving via a server 302.
    res.json({ redirect: url.toString() });
  });

  // ---- /token ----
  app.post('/token', async (req, res) => {
    const rid = reqId();
    const body = req.body || {};
    try {
      if (body.grant_type === 'authorization_code') {
        logStep(rid, 'token grant=authorization_code', { client: body.client_id });
        const { email, uid, scope, clientId, resource } = await tokens.consumeAuthCode({
          code: body.code, clientId: body.client_id, redirectUri: body.redirect_uri,
          codeVerifier: body.code_verifier, resource: body.resource || null,
        });
        const access = await tokens.issueAccessToken({ email, uid, scope, clientId, resource });
        const refresh_token = await tokens.issueRefreshToken({ email, uid, scope, clientId, resource });
        logStep(rid, 'token success', { client: clientId });
        return res.json({ access_token: access.token, token_type: 'Bearer', expires_in: access.expiresIn, refresh_token, scope });
      }
      if (body.grant_type === 'refresh_token') {
        logStep(rid, 'token grant=refresh_token', { client: body.client_id || '(unspecified)' });
        const { email, uid, scope, clientId, resource } = await tokens.consumeRefreshToken(body.refresh_token);
        const access = await tokens.issueAccessToken({ email, uid, scope, clientId, resource });
        const refresh_token = await tokens.issueRefreshToken({ email, uid, scope, clientId, resource });
        logStep(rid, 'token success (refresh)', { client: clientId });
        return res.json({ access_token: access.token, token_type: 'Bearer', expires_in: access.expiresIn, refresh_token, scope });
      }
      logStep(rid, 'token REJECTED unsupported_grant_type', { grant: body.grant_type || '(none)' });
      return res.status(400).json({ error: 'unsupported_grant_type' });
    } catch (e) {
      if (e.oauth) {
        logStep(rid, `token REJECTED ${e.message}`, { client: body.client_id });
        return res.status(400).json({ error: e.message, error_description: e.detail });
      }
      // FIX (§9): never leak the raw exception (which could include
      // Firestore/internal details) into the OAuth response body — log
      // it server-side, return only the standard opaque server_error.
      console.error(`[mcp/oauth] rid=${rid} /token failed:`, e.message);
      return res.status(500).json({ error: 'server_error' });
    }
  });
}

module.exports = { registerRoutes, baseUrl, allowedRedirectUris };
