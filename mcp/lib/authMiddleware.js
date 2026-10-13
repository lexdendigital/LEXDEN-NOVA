// mcp/lib/authMiddleware.js
//
// @modelcontextprotocol/server ships its own requireBearerAuth() with
// correct OAuth error codes (invalid_token vs insufficient_scope) and a
// spec-correct WWW-Authenticate header — reusing it instead of
// hand-rolling that means Claude's error handling for an expired/missing
// token behaves exactly as it does against any other MCP server. This
// file is the bridge from Express's (req, res, next) world to the
// Web-standard Request/Response shape that helper expects.
//
// FIX (MCP fix batch, README §7/§16): builds a real global `Request`
// (not a `{headers:{get}}` stub) and carries the verified token record's
// real client_id through to AuthInfo.
//
// CREATOR MCP HARDENING (Stage J): there are now TWO kinds of bearer
// token — `admin` and `creator` — and they must never be interchangeable.
// Before Stage J every token was an admin token, so this gate never needed
// to look at scope; once creators can sign in, a gate that doesn't would
// let a creator's token reach admin tools (including source-code editing).
// So every gate is now built for exactly one realm and enforces, in order:
//   1. a valid, unexpired token                       (verifier)
//   2. the realm's REQUIRED SCOPE on that token       (requiredScopes)
//   3. the realm's IDENTITY check, re-run on EVERY request
//      (admin: must still be the admin email; creator: must still be an
//      active, un-suspended creator) — so suspending a creator or
//      changing the admin address takes effect immediately instead of
//      waiting for the access token to expire.
//   4. (creator realm) the token's audience/resource, if the client sent
//      one, must be this realm's own MCP URL.

const { requireBearerAuth, OAuthError, OAuthErrorCode } = require('@modelcontextprotocol/server');
const tokens = require('./tokens');

// The token store keeps `scope` as one space-separated string
// ("admin offline_access"). AuthInfo.scopes must be an ARRAY of single
// scopes or requiredScopes can never match — splitting it here is what
// keeps existing admin tokens working once scope enforcement is on.
function splitScope(scope) {
  return String(scope || '').split(/\s+/).filter(Boolean);
}

function toAuthInfo(token, info) {
  return {
    token,
    clientId: info.clientId || 'unknown',
    scopes: splitScope(info.scope),
    expiresAt: info.expiresAt,
    extra: { email: info.email, uid: info.uid, resource: info.resource || null },
  };
}

function verifier(verifyToken) {
  return {
    async verifyAccessToken(token) {
      const info = await verifyToken(token);
      if (!info) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid or expired access token.');
      return toAuthInfo(token, info);
    },
  };
}

// Builds a real, spec-shaped Fetch API Headers object from Express's
// req.headers (which can have array values for repeated headers).
function toFetchHeaders(reqHeaders) {
  const h = new Headers();
  for (const [key, value] of Object.entries(reqHeaders || {})) {
    if (value == null) continue;
    h.set(key, Array.isArray(value) ? value.join(', ') : String(value));
  }
  return h;
}

function sameResource(a, b) {
  const norm = (u) => String(u || '').trim().replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

// baseUrlFn: (req) => string — passed in rather than imported from
// mcp/oauth.js to avoid a require cycle.
//
// options:
//   requiredScope   scope string the token must carry (e.g. 'admin')
//   metadataPath    path of this realm's protected-resource metadata
//   checkIdentity   async (authInfo) => { ok:boolean, message?:string }
//   resourcePath    if set, a token whose `resource` is set must equal
//                   baseUrl + resourcePath (creator realm only)
//   verifyToken     injectable for tests; defaults to the Firestore store
function bearerAuthMiddleware(baseUrlFn, options = {}) {
  const {
    requiredScope = 'admin',
    metadataPath = '/.well-known/oauth-protected-resource',
    checkIdentity = null,
    resourcePath = null,
    verifyToken = tokens.verifyAccessToken,
  } = options;

  return async function (req, res, next) {
    const base = baseUrlFn(req);
    const resourceMetadataUrl = `${base}${metadataPath}`;
    const fetchRequest = new Request(`${base}${req.originalUrl || req.url || '/mcp'}`, {
      method: req.method,
      headers: toFetchHeaders(req.headers),
    });
    const result = await requireBearerAuth({
      verifier: verifier(verifyToken),
      requiredScopes: [requiredScope],
      resourceMetadataUrl,
    })(fetchRequest);
    if (result instanceof Response) {
      res.status(result.status);
      for (const [k, v] of result.headers.entries()) res.setHeader(k, v);
      const body = await result.json().catch(() => ({}));
      return res.json(body);
    }

    if (resourcePath && result.extra && result.extra.resource && !sameResource(result.extra.resource, `${base}${resourcePath}`)) {
      res.setHeader('WWW-Authenticate', `Bearer error="invalid_token", error_description="Token audience does not match this server.", resource_metadata="${resourceMetadataUrl}"`);
      return res.status(401).json({ error: 'invalid_token', error_description: 'This token was issued for a different resource.' });
    }

    if (checkIdentity) {
      let verdict;
      try {
        verdict = await checkIdentity(result);
      } catch (e) {
        console.error('[mcp/auth] identity check failed:', e.message);
        return res.status(503).json({ error: 'temporarily_unavailable', error_description: 'Could not verify your account right now. Try again shortly.' });
      }
      if (!verdict || !verdict.ok) {
        return res.status(403).json({ error: 'access_denied', error_description: (verdict && verdict.message) || 'This account is not allowed to use this connector.' });
      }
    }

    // @modelcontextprotocol/node's toNodeHandler specifically looks for
    // `req.auth` and forwards it as `authInfo` into the server factory —
    // this exact property name is required, not a style choice.
    req.auth = result;
    next();
  };
}

module.exports = { bearerAuthMiddleware, splitScope, toAuthInfo, sameResource };
