const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { makeDb } = require('./helpers/fake-firestore');

process.env.OTP_SIGNING_SECRET = 'v'.repeat(32);
let DB = makeDb();
const adminPath = require.resolve('firebase-admin');
require.cache[adminPath] = { id: adminPath, filename: adminPath, loaded: true, exports: { apps: [1], app: () => ({}), firestore: () => DB } };
const handler = require('../api/verify-otp');

function key(email) {
  return crypto.createHash('sha256').update('otp-email|' + email).digest('hex');
}
function hashCode(code, email) {
  return crypto.createHmac('sha256', process.env.OTP_SIGNING_SECRET).update(email + '|' + code).digest('hex');
}
function run(body) {
  return new Promise((resolve) => {
    const req = { method: 'POST', headers: { origin: 'https://lexdendigital.github.io' }, body };
    const res = { _s: 200, setHeader() {}, status(c) { this._s = c; return this; }, json(p) { resolve({ status: this._s, body: p }); }, end() { resolve({ status: this._s }); } };
    handler(req, res);
  });
}

test('verify OTP succeeds for new hashed records, deletes one-time code and returns signed verification token', async () => {
  const email = 'buyer@example.com', code = '123456';
  DB = makeDb({ email_otps: { [key(email)]: { codeHash: hashCode(code, email), createdAt: Date.now(), expiresAt: Date.now() + 600000, attempts: 0 } } });
  const r = await run({ email, code });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.ok(r.body.verifiedToken);
  assert.equal(DB._store.email_otps[key(email)], undefined);
});

test('verify OTP preserves in-flight legacy pre-v3.0.2 records during deployment transition', async () => {
  const email = 'legacy@example.com', code = '654321';
  DB = makeDb({ email_otps: { [email]: { codeHash: hashCode(code, email), createdAt: Date.now(), expiresAt: Date.now() + 600000, attempts: 0 } } });
  const r = await run({ email, code });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(DB._store.email_otps[email], undefined);
});

test('wrong OTP increments bounded failed attempts and does not reveal account existence', async () => {
  const email = 'buyer@example.com';
  DB = makeDb({ email_otps: { [key(email)]: { codeHash: hashCode('123456', email), createdAt: Date.now(), expiresAt: Date.now() + 600000, attempts: 0 } } });
  const r = await run({ email, code: '000000' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /incorrect/i);
  assert.equal(DB._store.email_otps[key(email)].attempts, 1);
});

test('expired OTP is deleted and rejected', async () => {
  const email = 'buyer@example.com';
  DB = makeDb({ email_otps: { [key(email)]: { codeHash: hashCode('123456', email), createdAt: Date.now() - 700000, expiresAt: Date.now() - 1, attempts: 0 } } });
  const r = await run({ email, code: '123456' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /expired/i);
  assert.equal(DB._store.email_otps[key(email)], undefined);
});
