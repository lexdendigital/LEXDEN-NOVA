const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { makeDb } = require('./helpers/fake-firestore');

process.env.OTP_SIGNING_SECRET = 's'.repeat(32);
let DB = makeDb();
const adminPath = require.resolve('firebase-admin');
require.cache[adminPath] = { id: adminPath, filename: adminPath, loaded: true, exports: { apps: [1], app: () => ({}), firestore: () => DB } };
let SEND = async () => ({ ok: true });
const sharedPath = require.resolve('../api/email-shared');
require.cache[sharedPath] = { id: sharedPath, filename: sharedPath, loaded: true, exports: { sendEmailFast: (p) => SEND(p) } };
const handler = require('../api/send-otp');

function otpKey(email) {
  return crypto.createHash('sha256').update('otp-email|' + String(email).toLowerCase()).digest('hex');
}
function run(body, { ip = '203.0.113.9', method = 'POST' } = {}) {
  return new Promise((resolve) => {
    const req = { method, ip, headers: { origin: 'https://lexdendigital.github.io' }, body, socket: { remoteAddress: '10.0.0.1' } };
    const res = { _s: 200, setHeader() {}, status(c) { this._s = c; return this; }, json(p) { resolve({ status: this._s, body: p }); }, end() { resolve({ status: this._s }); } };
    handler(req, res);
  });
}

test('sends the code and stores only an HMAC under a hashed email document ID', async () => {
  DB = makeDb();
  let sent;
  SEND = async (p) => { sent = p; return { ok: true }; };
  const r = await run({ email: 'A@B.co' });
  assert.equal(r.status, 200);
  assert.match(sent.params.code, /^\d{6}$/);
  const key = otpKey('a@b.co');
  const stored = JSON.stringify(DB._store.email_otps[key]);
  assert.ok(stored);
  assert.ok(!stored.includes(sent.params.code));
  assert.equal(DB._store.email_otps['a@b.co'], undefined);
});

test('failed provider send is reported and releases only the email cooldown reservation', async () => {
  DB = makeDb();
  SEND = async () => ({ ok: false, error: 'Brevo 401: Key not found' });
  const r = await run({ email: 'a@b.co' });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /rejected/);
  assert.equal(DB._store.email_otps[otpKey('a@b.co')], undefined);

  SEND = async () => ({ ok: false, error: 'BREVO_TPL_VERIFY not set' });
  const second = await run({ email: 'a@b.co' }, { ip: '203.0.113.10' });
  assert.equal(second.status, 502);
  assert.match(second.body.error, /not fully set up/);
});

test('rate-limit transaction failure fails closed and sends no OTP', async () => {
  DB = makeDb();
  let sends = 0;
  SEND = async () => { sends++; return { ok: true }; };
  DB.runTransaction = async () => { throw new Error('firestore down'); };
  const r = await Promise.race([run({ email: 'a@b.co' }), new Promise((res) => setTimeout(() => res({ status: 'HUNG' }), 3000))]);
  assert.equal(r.status, 503);
  assert.equal(sends, 0);
});

test('concurrent requests cannot bypass the 60-second email cooldown', async () => {
  DB = makeDb();
  let sends = 0;
  SEND = async () => { sends++; return { ok: true }; };
  const [a, b] = await Promise.all([
    run({ email: 'same@example.com' }),
    run({ email: 'same@example.com' }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 429]);
  assert.equal(sends, 1);
});

test('per-IP hourly cap remains eight and is atomically enforced', async () => {
  DB = makeDb();
  let sends = 0;
  SEND = async () => { sends++; return { ok: true }; };
  const statuses = [];
  for (let i = 0; i < 9; i++) {
    statuses.push((await run({ email: 'user' + i + '@example.com' }, { ip: '198.51.100.44' })).status);
  }
  assert.deepEqual(statuses.slice(0, 8), Array(8).fill(200));
  assert.equal(statuses[8], 429);
  assert.equal(sends, 8);
});

test('rejects bad email and wrong method', async () => {
  DB = makeDb();
  assert.equal((await run({ email: 'nope' })).status, 400);
  assert.equal((await run({ email: 'a@example.com' }, { method: 'GET' })).status, 405);
});
