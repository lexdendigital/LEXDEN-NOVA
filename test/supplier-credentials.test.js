const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../api/supplier/credentials');

const KEY_HEX = 'a1'.repeat(32);
const KEY_B64 = Buffer.alloc(32, 7).toString('base64');

test('round-trips with a hex key and a base64 key', () => {
  for (const k of [KEY_HEX, KEY_B64]) {
    const blob = c.encryptSecret('my-cj-api-key', 'u1_cj', k);
    assert.match(blob, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    assert.equal(c.decryptSecret(blob, 'u1_cj', k), 'my-cj-api-key');
  }
});

test('ciphertext never contains the plaintext and is non-deterministic', () => {
  const a = c.encryptSecret('super-secret-value', 'u1_cj', KEY_HEX);
  const b = c.encryptSecret('super-secret-value', 'u1_cj', KEY_HEX);
  assert.notEqual(a, b);
  assert.ok(!a.includes('super-secret-value'));
});

test('a blob copied to another connection id fails (AAD binding)', () => {
  const blob = c.encryptSecret('k', 'u1_cj', KEY_HEX);
  assert.throws(() => c.decryptSecret(blob, 'u2_cj', KEY_HEX), (e) => e.code === 'DECRYPT_FAILED');
});

test('tampering and wrong key fail with DECRYPT_FAILED and leak nothing', () => {
  const blob = c.encryptSecret('hunter2hunter2', 'u1_cj', KEY_HEX);
  const parts = blob.split('.');
  parts[3] = Buffer.from('xxxxxxxxxxxxxx').toString('base64url');
  assert.throws(() => c.decryptSecret(parts.join('.'), 'u1_cj', KEY_HEX), (e) => e.code === 'DECRYPT_FAILED' && !e.message.includes('hunter2'));
  assert.throws(() => c.decryptSecret(blob, 'u1_cj', 'b2'.repeat(32)), (e) => e.code === 'DECRYPT_FAILED');
});

test('fails closed: missing or malformed key, no plaintext fallback', () => {
  assert.throws(() => c.encryptSecret('k', 'u1_cj', ''), (e) => e.code === 'SUPPLIER_KEY_MISSING' && e.status === 503);
  assert.throws(() => c.encryptSecret('k', 'u1_cj', 'tooshort'), (e) => e.code === 'SUPPLIER_KEY_INVALID');
  assert.throws(() => c.decryptSecret('v1.a.b.c', 'u1_cj', ''), (e) => e.code === 'SUPPLIER_KEY_MISSING');
  const saved = process.env.SUPPLIER_CREDENTIALS_KEY;
  delete process.env.SUPPLIER_CREDENTIALS_KEY;
  try { assert.throws(() => c.encryptSecret('k', 'u1_cj'), (e) => e.code === 'SUPPLIER_KEY_MISSING'); }
  finally { if (saved !== undefined) process.env.SUPPLIER_CREDENTIALS_KEY = saved; }
});

test('rejects empty secrets, missing aad, unknown formats', () => {
  assert.throws(() => c.encryptSecret('', 'x', KEY_HEX), (e) => e.code === 'EMPTY_SECRET');
  assert.throws(() => c.encryptSecret('k', '', KEY_HEX), (e) => e.code === 'MISSING_AAD');
  assert.throws(() => c.decryptSecret('v9.a.b.c', 'x', KEY_HEX), (e) => e.code === 'BAD_SECRET_FORMAT');
  assert.throws(() => c.decryptSecret(null, 'x', KEY_HEX), (e) => e.code === 'NO_SECRET');
});

test('maskEmail hides the local part', () => {
  assert.equal(c.maskEmail('jane.doe@example.com'), 'j*******@example.com');
  assert.ok(!c.maskEmail('ab@x.com').includes('b@'));
  assert.equal(c.maskEmail(''), null);
});
