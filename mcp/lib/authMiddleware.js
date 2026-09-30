// mcp/lib/authMiddleware.js
//
// @modelcontextprotocol/server ships its own requireBearerAuth() with
// correct OAuth error codes (invalid_token vs insufficient_scope) and a
// spec-correct WWW-Authenticate header — reusing it instead of
// hand-rolling that means Claude's error handling for an expired/missing
// token behaves exactly as it does against any other MCP server, not a
// slightly-different bespoke shape. This file is just the small bridge
// from Express's (req, res, next) world to the Web-standard
// Request/Response shape that helper expects.
//
// FIX (MCP fix batch, README §7/§16):
//  - Was passing a hand-rolled `{ headers: { get } }` stub instead of a
//    real Request object. requireBearerAuth() is written against the
//    Fetch API Request type; a stub that only implements `.get()` works
//    ONLY as long as the SDK never touches `.method`, `.url`, `.has()`,
//    or iterates headers — which is a real but silent compatibility
//    risk (Section 16 of the fix README calls this out explicitly). Now
//    builds an actual global `Request` with a real `Headers` object, so
//    every Fetch-API surface the SDK might use behaves correctly.
//  - clientId in the returned AuthInfo now comes from the verified
//    token record (set at /token time — see mcp/lib/tokens.js) instead
//    of being hardcoded to 'lexden-nova-admin'. The admin's identity
//    (email/uid, in `extra`) and the OAuth client's identity (clientId)
//    are different concepts and shouldn't be conflated.

const { requireBearerAuth, OAuthError, OAuthErrorCode } = require('@modelcontextprotocol/server');
const tokens = require('./tokens');

function verifier() {
  return {
    async verifyAccessToken(token) {
      const info = await tokens.verifyAccessToken(token);
      if (!info) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid or expired access token.');
      return {
        token,
        clientId: info.clientId || 'unknown', // FIX (§7): real client_id, not hardcoded
        scopes: [info.scope],
        expiresAt: info.expiresAt,
        extra: { email: info.email, uid: info.uid, resource: info.resource || null },
      };
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

// baseUrlFn: (req) => string — passed in rather than imported from
// mcp/oauth.js to avoid a require cycle (oauth.js doesn't need this file).
function bearerAuthMiddleware(baseUrlFn) {
  return async function (req, res, next) {
    const resourceMetadataUrl = `${baseUrlFn(req)}/.well-known/oauth-protected-resource`;
    // FIX (§16): a real Request, not a `{headers:{get}}` stand-in — this
    // is what requireBearerAuth() is actually typed/written against.
    const fetchRequest = new Request(`${baseUrlFn(req)}${req.originalUrl || req.url || '/mcp'}`, {
      method: req.method,
      headers: toFetchHeaders(req.headers),
    });
    const result = await requireBearerAuth({ verifier: verifier(), resourceMetadataUrl })(fetchRequest);
    if (result instanceof Response) {
      res.status(result.status);
      for (const [k, v] of result.headers.entries()) res.setHeader(k, v);
      const body = await result.json().catch(() => ({}));
      return res.json(body);
    }
    // @modelcontextprotocol/node's toNodeHandler specifically looks for
    // `req.auth` and forwards it as `authInfo` into the server factory —
    // this exact property name is required, not a style choice.
    req.auth = result; // { token, clientId, scopes, expiresAt, extra: { email, uid, resource } }
    next();
  };
}

module.exports = { bearerAuthMiddleware };
