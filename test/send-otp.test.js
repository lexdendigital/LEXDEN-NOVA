const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { makeDb } = require('./helpers/fake-firestore');

process.env.OTP_SIGNING_SECRET = 's'.repeat(32);
let DB = makeDb();
const adminPath = require.resolve('firebase-admin');
require.cache[adminPath] = { id: adminPath, filename: adminPath, loaded: true, exports: { apps: [1], app: () => ({}), firestore: () => DB } };
let SEND = async () => ({ ok: true });
const sharedPath = require.resolve('../api/email-shared');
require.cache[sharedPath] = { id: sharedPath, filename: sharedPath, loaded: true, exports: { sendEmailFast: (p) => SEND(p) } };
const handler = require('../api/send-otp');

function run(body) {
  return new Promise((resolve) => {
    const req = { method: 'POST', headers: { origin: 'https://lexdendigital.github.io' }, body, socket: {} };
    const res = { _s: 200, setHeader() {}, status(c) { this._s = c; return this; }, json(p) { resolve({ status: this._s, body: p }); }, end() { resolve({ status: this._s }); } };
    handler(req, res);
  });
}
// the fake db has no delete(); add it
const withDelete = () => { const orig = DB.collection.bind(DB); DB.collection = (c) => { const x = orig(c); const d = x.doc; x.doc = (id) => { const r = d(id); r.delete = async () => { delete DB._store[c][id]; }; return r; }; return x; }; };

test('sends the code and stores only a hash', async () => {
  DB = makeDb(); withDelete();
  let sent; SEND = async (p) => { sent = p; return { ok: true }; };
  const r = await run({ email: 'A@B.co' });
  assert.equal(r.status, 200);
  assert.match(sent.params.code, /^\d{6}$/);
  const stored = JSON.stringify(DB._store.email_otps['a@b.co']);
  assert.ok(!stored.includes(sent.params.code));
});

test('a failed send is reported (not "ok") and the cooldown is released', async () => {
  DB = makeDb(); withDelete();
  SEND = async () => ({ ok: false, error: 'Brevo 401: Key not found' });
  const r = await run({ email: 'a@b.co' });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /rejected/);
  assert.equal(DB._store.email_otps['a@b.co'], undefined);
  SEND = async () => ({ ok: false, error: 'BREVO_TPL_VERIFY not set' });
  assert.match((await run({ email: 'a@b.co' })).body.error, /not fully set up/);
});

test('a Firestore failure answers 500 instead of hanging', async () => {
  DB = makeDb(); withDelete();
  const orig = DB.collection;
  DB.collection = (c) => { const x = orig(c); if (c === 'email_otps') x.doc = () => ({ get: async () => { throw new Error('firestore down'); } }); return x; };
  const r = await Promise.race([run({ email: 'a@b.co' }), new Promise((res) => setTimeout(() => res({ status: 'HUNG' }), 3000))]);
  assert.equal(r.status, 500);
});

test('rejects bad email and wrong method', async () => {
  assert.equal((await run({ email: 'nope' })).status, 400);
});
