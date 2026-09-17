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

const crypto = require('crypto');
const { getAuthAdmin, isAdminEmail } = require('../api/affiliate/shared');
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

function baseUrl(req) {
  if (process.env.MCP_BASE_URL) return process.env.MCP_BASE_URL.replace(/\/$/, '');
  // Fallback so this doesn't hard-crash before MCP_BASE_URL is set on
  // Render, but a mismatched base URL breaks OAuth redirect matching, so
  // MCP-SETUP.md tells you to set this explicitly rather than rely on it.
  return `${req.protocol}://${req.get('host')}`;
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
        if (!resp.ok) throw new Error(data.error_description || data.error || 'Sign-in failed.');
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
    res.json({ resource: `${baseUrl(req)}/mcp`, authorization_servers: [baseUrl(req)] });
  });
  app.get('/.well-known/oauth-authorization-server', (req, res) => {
    const b = baseUrl(req);
    res.json({
      issuer: b,
      authorization_endpoint: `${b}/authorize`,
      token_endpoint: `${b}/token`,
      registration_endpoint: `${b}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['admin'],
    });
  });

  // ---- Dynamic Client Registration (RFC 7591), minimal ----
  app.post('/register', (req, res) => {
    const body = req.body || {};
    const clientId = crypto.randomBytes(16).toString('hex');
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris : [],
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
  app.get('/authorize', (req, res) => {
    const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method } = req.query;
    if (!redirect_uri || !allowedRedirectUris().includes(redirect_uri)) {
      return res.status(400).send('This connector is not configured to send you back to that address. Check MCP_EXTRA_REDIRECT_URIS if this is a legitimate client.');
    }
    if (response_type !== 'code' || !client_id || !code_challenge || (code_challenge_method && code_challenge_method !== 'S256')) {
      const url = new URL(redirect_uri);
      url.searchParams.set('error', 'invalid_request');
      if (req.query.state) url.searchParams.set('state', req.query.state);
      return res.redirect(url.toString());
    }
    res.set('Content-Type', 'text/html').send(firebaseSignInHtml({}));
  });

  // ---- /authorize/complete (POST from the sign-in page's JS, body
  // already parsed as JSON by server.js's global express.json()) ----
  app.post('/authorize/complete', async (req, res) => {
    const { idToken, params } = req.body || {};
    const p = params || {};
    if (!p.redirect_uri || !allowedRedirectUris().includes(p.redirect_uri)) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'Unrecognized redirect_uri.' });
    }
    let decoded;
    try {
      decoded = await getAuthAdmin().verifyIdToken(idToken);
    } catch {
      return res.status(401).json({ error: 'access_denied', error_description: 'Could not verify that sign-in — try again.' });
    }
    if (!isAdminEmail(decoded.email)) {
      return res.status(403).json({ error: 'access_denied', error_description: `${decoded.email || 'That account'} is not the LEXDEN NOVA admin account.` });
    }
    const code = await tokens.createAuthCode({
      clientId: p.client_id,
      redirectUri: p.redirect_uri,
      codeChallenge: p.code_challenge,
      codeChallengeMethod: p.code_challenge_method || 'S256',
      email: decoded.email,
      uid: decoded.uid,
      scope: 'admin',
    });
    const url = new URL(p.redirect_uri);
    url.searchParams.set('code', code);
    if (p.state) url.searchParams.set('state', p.state);
    res.json({ redirect: url.toString() });
  });

  // ---- /token ----
  app.post('/token', async (req, res) => {
    const body = req.body || {};
    try {
      if (body.grant_type === 'authorization_code') {
        const { email, uid, scope } = await tokens.consumeAuthCode({
          code: body.code, clientId: body.client_id, redirectUri: body.redirect_uri, codeVerifier: body.code_verifier,
        });
        const access = await tokens.issueAccessToken({ email, uid, scope });
        const refresh_token = await tokens.issueRefreshToken({ email, uid, scope });
        return res.json({ access_token: access.token, token_type: 'Bearer', expires_in: access.expiresIn, refresh_token, scope });
      }
      if (body.grant_type === 'refresh_token') {
        const { email, uid, scope } = await tokens.consumeRefreshToken(body.refresh_token);
        const access = await tokens.issueAccessToken({ email, uid, scope });
        const refresh_token = await tokens.issueRefreshToken({ email, uid, scope });
        return res.json({ access_token: access.token, token_type: 'Bearer', expires_in: access.expiresIn, refresh_token, scope });
      }
      return res.status(400).json({ error: 'unsupported_grant_type' });
    } catch (e) {
      if (e.oauth) return res.status(400).json({ error: e.message, error_description: e.detail });
      console.error('mcp /token failed:', e);
      return res.status(500).json({ error: 'server_error' });
    }
  });
}

module.exports = { registerRoutes, baseUrl, allowedRedirectUris };
