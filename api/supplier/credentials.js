// api/supplier/credentials.js
//
// LEXDEN NOVA CREATOR — Stage G: encryption for a creator's supplier
// (CJ Dropshipping) credentials and cached tokens.
//
// WHY THIS EXISTS (blueprint §20): "Do not allow arbitrary creator-supplied
// supplier credentials to be handled directly in frontend JavaScript." A
// creator's CJ email + API key are a password to a money-bearing account, so
// they are only ever (a) received over HTTPS by the server, (b) encrypted
// here with AES-256-GCM before they touch Firestore, and (c) decrypted in
// memory for the duration of one CJ call. They are never returned by any API
// route, never written to a log, and never exposed through the Creator MCP.
//
// KEY: SUPPLIER_CREDENTIALS_KEY (Render env var) — 32 random bytes, given as
// 64 hex characters or as base64. FAILS CLOSED: with no/invalid key nothing is
// stored and nothing is decrypted — there is no plaintext fallback.
//
// AAD: every ciphertext is bound to the connection id it was written for
// (additional authenticated data), so a blob copied from one creator's
// document into another's fails authentication instead of decrypting.
//
// FORMAT: "v1.<iv>.<tag>.<ciphertext>", each part base64url. The "v1" prefix
// leaves room to rotate the algorithm or key later without guessing.
const crypto = require('crypto');

const VERSION = 'v1';

function credError(message, code, status) {
  const e = new Error(message);
  e.code = code;
  e.status = status || 503;
  return e;
}

// Returns the 32-byte key or throws a coded error. `raw` is injectable for
// tests; production reads the env var.
function loadKey(raw) {
  const value = raw === undefined ? process.env.SUPPLIER_CREDENTIALS_KEY : raw;
  if (!value || !String(value).trim()) {
    throw credError('Supplier connections are not available yet: SUPPLIER_CREDENTIALS_KEY is not set on the server.', 'SUPPLIER_KEY_MISSING', 503);
  }
  const s = String(value).trim();
  // 64 hex chars is ALSO valid base64, so hex must be tested first.
  const buf = /^[0-9a-fA-F]{64}$/.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
  if (buf.length !== 32) {
    throw credError('SUPPLIER_CREDENTIALS_KEY must be exactly 32 bytes (64 hex characters, or base64 of 32 bytes).', 'SUPPLIER_KEY_INVALID', 503);
  }
  return buf;
}

function b64u(buf) { return buf.toString('base64url'); }
function fromB64u(s) { return Buffer.from(s, 'base64url'); }

function encryptSecret(plain, aad, rawKey) {
  if (typeof plain !== 'string' || plain === '') throw credError('Nothing to encrypt.', 'EMPTY_SECRET', 422);
  if (typeof aad !== 'string' || !aad) throw credError('A connection id is required to encrypt a secret.', 'MISSING_AAD', 500);
  const key = loadKey(rawKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, b64u(iv), b64u(cipher.getAuthTag()), b64u(ct)].join('.');
}

function decryptSecret(blob, aad, rawKey) {
  if (typeof blob !== 'string') throw credError('No stored secret.', 'NO_SECRET', 409);
  const parts = blob.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw credError('Stored secret is in an unknown format.', 'BAD_SECRET_FORMAT', 500);
  const key = loadKey(rawKey);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, fromB64u(parts[1]));
    decipher.setAAD(Buffer.from(String(aad), 'utf8'));
    decipher.setAuthTag(fromB64u(parts[2]));
    return Buffer.concat([decipher.update(fromB64u(parts[3])), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key, wrong connection, or tampered data — indistinguishable on
    // purpose, and the message never includes any part of the blob.
    throw credError('Could not decrypt the stored supplier credentials. Reconnect the supplier account.', 'DECRYPT_FAILED', 409);
  }
}

// "jane.doe@example.com" -> "j*******@example.com" — enough for a creator to
// recognise which CJ account is connected, never enough to reconstruct it.
function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at < 1) return s ? '****' : null;
  return `${s[0]}${'*'.repeat(Math.max(3, at - 1))}${s.slice(at)}`;
}

module.exports = { loadKey, encryptSecret, decryptSecret, maskEmail, VERSION };
