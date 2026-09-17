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

const { requireBearerAuth, OAuthError, OAuthErrorCode } = require('@modelcontextprotocol/server');
const tokens = require('./tokens');

function verifier() {
  return {
    async verifyAccessToken(token) {
      const info = await tokens.verifyAccessToken(token);
      if (!info) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid or expired access token.');
      return { token, clientId: 'lexden-nova-admin', scopes: [info.scope], expiresAt: info.expiresAt, extra: { email: info.email, uid: info.uid } };
    },
  };
}

// baseUrlFn: (req) => string — passed in rather than imported from
// mcp/oauth.js to avoid a require cycle (oauth.js doesn't need this file).
function bearerAuthMiddleware(baseUrlFn) {
  return async function (req, res, next) {
    const resourceMetadataUrl = `${baseUrlFn(req)}/.well-known/oauth-protected-resource`;
    const fakeRequest = { headers: { get: (name) => req.get(name) } };
    const result = await requireBearerAuth({ verifier: verifier(), resourceMetadataUrl })(fakeRequest);
    if (result instanceof Response) {
      res.status(result.status);
      for (const [k, v] of result.headers.entries()) res.setHeader(k, v);
      const body = await result.json().catch(() => ({}));
      return res.json(body);
    }
    // @modelcontextprotocol/node's toNodeHandler specifically looks for
    // `req.auth` and forwards it as `authInfo` into the server factory —
    // this exact property name is required, not a style choice.
    req.auth = result; // { token, clientId, scopes, expiresAt, extra: { email, uid } }
    next();
  };
}

module.exports = { bearerAuthMiddleware };
