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

function pkceMatches(codeVerifier, codeChallenge, method) {
  if (method === 'plain') return codeVerifier === codeChallenge;
  // S256 (the only method Claude's connector setup actually offers/requires)
  const digest = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return digest === codeChallenge;
}

// ---------------- Authorization codes (short-lived, one-time use) ----------------

async function createAuthCode({ clientId, redirectUri, codeChallenge, codeChallengeMethod, email, uid, scope }) {
  const db = getDb();
  const code = randomToken();
  await db.collection('mcpAuthCodes').doc(sha256(code)).set({
    clientId, redirectUri, codeChallenge, codeChallengeMethod: codeChallengeMethod || 'S256',
    email, uid, scope: scope || 'admin',
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: Date.now() + AUTH_CODE_TTL_MS,
  });
  return code;
}

async function consumeAuthCode({ code, clientId, redirectUri, codeVerifier }) {
  const db = getDb();
  const ref = db.collection('mcpAuthCodes').doc(sha256(code));
  const snap = await ref.get();
  if (!snap.exists) throw Object.assign(new Error('invalid_grant'), { oauth: true });
  const data = snap.data();
  await ref.delete(); // one-time use, whether or not the checks below pass
  if (Date.now() > data.expiresAt) throw Object.assign(new Error('invalid_grant'), { oauth: true, detail: 'Authorization code expired.' });
  if (data.clientId !== clientId) throw Object.assign(new Error('invalid_grant'), { oauth: true, detail: 'client_id mismatch.' });
  if (data.redirectUri !== redirectUri) throw Object.assign(new Error('invalid_grant'), { oauth: true, detail: 'redirect_uri mismatch.' });
  if (!codeVerifier || !pkceMatches(codeVerifier, data.codeChallenge, data.codeChallengeMethod)) {
    throw Object.assign(new Error('invalid_grant'), { oauth: true, detail: 'PKCE verification failed.' });
  }
  return { email: data.email, uid: data.uid, scope: data.scope };
}

// ---------------- Access tokens (bearer, 1 hour) ----------------

async function issueAccessToken({ email, uid, scope }) {
  const db = getDb();
  const token = randomToken();
  await db.collection('mcpAccessTokens').doc(sha256(token)).set({
    email, uid, scope: scope || 'admin',
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
    // epoch SECONDS, not ms — this is the shape @modelcontextprotocol/server's
    // own verifyBearerToken()/AuthInfo expects (see mcp/lib/authMiddleware.js).
    expiresAt: Math.floor(data.expiresAt / 1000),
  };
}

// ---------------- Refresh tokens (90 days, rotated on every use) ----------------

async function issueRefreshToken({ email, uid, scope }) {
  const db = getDb();
  const token = randomToken();
  await db.collection('mcpRefreshTokens').doc(sha256(token)).set({
    email, uid, scope: scope || 'admin', revoked: false,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
  });
  return token;
}

async function consumeRefreshToken(token) {
  const db = getDb();
  const ref = db.collection('mcpRefreshTokens').doc(sha256(token));
  const snap = await ref.get();
  if (!snap.exists) throw Object.assign(new Error('invalid_grant'), { oauth: true });
  const data = snap.data();
  await ref.update({ revoked: true }); // rotation: this refresh token is single-use
  if (data.revoked) throw Object.assign(new Error('invalid_grant'), { oauth: true, detail: 'Refresh token already used or revoked.' });
  if (Date.now() > data.expiresAt) throw Object.assign(new Error('invalid_grant'), { oauth: true, detail: 'Refresh token expired.' });
  return { email: data.email, uid: data.uid, scope: data.scope };
}

module.exports = {
  createAuthCode, consumeAuthCode,
  issueAccessToken, verifyAccessToken,
  issueRefreshToken, consumeRefreshToken,
};
