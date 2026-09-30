// mcp/lib/tokens.js
//
// Deliberately NOT JWTs. A JWT would let this server sign a token and
// never look at a database again until it expires — but that means a
// stolen or accidentally-shared token stays valid until its (probably
// long) expiry with no way to revoke it early. Since every MCP request
// here already needs a Firestore round trip anyway (the tool itself is
// about to read/write Firestore), storing tokens *hashed* in Firestore
// costs nothing extra and gives you real revocation: deleting a doc (or
// nova_revoke_mcp_access, once wired into a tool) kills the session
// immediately. Nothing here is ever stored in plaintext — only a
// SHA-256 hash — so a leaked Firestore export can't be used as a set of
// live bearer tokens.
//
// FIX (MCP fix batch, README sections 6/7/8/10):
//  - consumeAuthCode() now runs inside a Firestore transaction so two
//    concurrent /token requests presenting the same code cannot both
//    succeed (was: delete-then-validate, no atomicity).
//  - consumeRefreshToken() is likewise transactional (was: read, then
//    update, then check the STALE pre-update `revoked` value — which
//    made the "reused token" check a no-op under concurrency).
//  - clientId and resource are now carried end-to-end (authorize ->
//    code -> access token) and returned by verifyAccessToken(), instead
//    of being dropped after the code exchange.

const crypto = require('crypto');
const { getDb, FieldValue } = require('../../api/affiliate/shared');

const AUTH_CODE_TTL_MS = 2 * 60 * 1000; // 2 minutes — just long enough for the redirect round trip
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function oauthError(code, detail) {
  return Object.assign(new Error(code), { oauth: true, detail });
}

function pkceMatches(codeVerifier, codeChallenge, method) {
  if (method === 'plain') return codeVerifier === codeChallenge;
  // S256 (the only method Claude's connector setup actually offers/requires)
  const digest = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return digest === codeChallenge;
}

// ---------------- Authorization codes (short-lived, one-time use) ----------------

async function createAuthCode({ clientId, redirectUri, codeChallenge, codeChallengeMethod, email, uid, scope, resource }) {
  const db = getDb();
  const code = randomToken();
  await db.collection('mcpAuthCodes').doc(sha256(code)).set({
    clientId, redirectUri, codeChallenge, codeChallengeMethod: codeChallengeMethod || 'S256',
    resource: resource || null,
    email, uid, scope: scope || 'admin',
    used: false,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: Date.now() + AUTH_CODE_TTL_MS,
  });
  return code;
}

// FIX: transactional. Reads AND marks-used in one atomic Firestore
// transaction, so a code can only ever be successfully redeemed once
// even if two /token requests race — the old delete-then-validate
// version had no such guarantee (both requests could read the doc
// before either delete landed).
async function consumeAuthCode({ code, clientId, redirectUri, codeVerifier, resource }) {
  const db = getDb();
  const ref = db.collection('mcpAuthCodes').doc(sha256(code));
  const data = await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) throw oauthError('invalid_grant', 'Unknown or already-used authorization code.');
    const d = snap.data();
    if (d.used) throw oauthError('invalid_grant', 'This authorization code was already redeemed.');
    // Mark used inside the same transaction — only after this commits is
    // the code considered consumed, closing the race window entirely.
    t.update(ref, { used: true, usedAt: FieldValue.serverTimestamp() });
    return d;
  });
  if (Date.now() > data.expiresAt) throw oauthError('invalid_grant', 'Authorization code expired.');
  if (data.clientId !== clientId) throw oauthError('invalid_grant', 'client_id mismatch.');
  if (data.redirectUri !== redirectUri) throw oauthError('invalid_grant', 'redirect_uri mismatch.');
  if (!codeVerifier || !pkceMatches(codeVerifier, data.codeChallenge, data.codeChallengeMethod)) {
    throw oauthError('invalid_grant', 'PKCE verification failed.');
  }
  // FIX (README section 6): if the token request names a resource, it
  // must match the resource the authorization was actually granted for.
  // A code issued with no resource (older/lenient clients) still binds
  // to whatever resource is requested at redemption, for back-compat.
  if (resource && data.resource && resource !== data.resource) {
    throw oauthError('invalid_target', 'resource does not match the authorized resource.');
  }
  return { email: data.email, uid: data.uid, scope: data.scope, clientId: data.clientId, resource: data.resource || resource || null };
}

// ---------------- Access tokens (bearer, 1 hour) ----------------

async function issueAccessToken({ email, uid, scope, clientId, resource }) {
  const db = getDb();
  const token = randomToken();
  await db.collection('mcpAccessTokens').doc(sha256(token)).set({
    email, uid, scope: scope || 'admin', clientId: clientId || null, resource: resource || null,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
  });
  return { token, expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000) };
}

async function verifyAccessToken(token) {
  if (!token) return null;
  const db = getDb();
  const snap = await db.collection('mcpAccessTokens').doc(sha256(token)).get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (Date.now() > data.expiresAt) return null;
  return {
    email: data.email, uid: data.uid, scope: data.scope,
    // FIX (README section 7): the real OAuth client_id from /register,
    // carried through the whole flow — was previously dropped here and
    // hardcoded to 'lexden-nova-admin' in authMiddleware.js instead.
    clientId: data.clientId || null,
    resource: data.resource || null,
    // epoch SECONDS, not ms — this is the shape @modelcontextprotocol/server's
    // own verifyBearerToken()/AuthInfo expects (see mcp/lib/authMiddleware.js).
    expiresAt: Math.floor(data.expiresAt / 1000),
  };
}

// ---------------- Refresh tokens (90 days, rotated on every use) ----------------

async function issueRefreshToken({ email, uid, scope, clientId, resource }) {
  const db = getDb();
  const token = randomToken();
  await db.collection('mcpRefreshTokens').doc(sha256(token)).set({
    email, uid, scope: scope || 'admin', clientId: clientId || null, resource: resource || null, revoked: false,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
  });
  return token;
}

// FIX: transactional rotation — read + revoke happen atomically, so two
// concurrent refresh requests presenting the same token cannot both
// succeed. The previous version updated `revoked:true` and THEN checked
// the pre-update value from its initial read, which meant a genuinely
// concurrent second request could still read `revoked:false` and also
// succeed before the first update was visible to it.
async function consumeRefreshToken(token) {
  const db = getDb();
  const ref = db.collection('mcpRefreshTokens').doc(sha256(token));
  const data = await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) throw oauthError('invalid_grant', 'Unknown refresh token.');
    const d = snap.data();
    if (d.revoked) throw oauthError('invalid_grant', 'Refresh token already used or revoked.');
    if (Date.now() > d.expiresAt) throw oauthError('invalid_grant', 'Refresh token expired.');
    t.update(ref, { revoked: true, revokedAt: FieldValue.serverTimestamp() });
    return d;
  });
  return { email: data.email, uid: data.uid, scope: data.scope, clientId: data.clientId || null, resource: data.resource || null };
}

module.exports = {
  createAuthCode, consumeAuthCode,
  issueAccessToken, verifyAccessToken,
  issueRefreshToken, consumeRefreshToken,
};
