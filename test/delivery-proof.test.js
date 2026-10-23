const test = require('node:test');
const assert = require('node:assert/strict');
const fake = require('./helpers/fake-db');
const P = require('../api/delivery/proof');
const ledger = require('../api/creator/ledger');
const api = require('../api/delivery-proof');

test.before(() => fake.install());
test.after(() => fake.restore());
const env = { DELIVERY_CODE_SECRET: 'x'.repeat(40), RIDER_VAULT_ENABLED: 'true' };
const DAY = 86400000;

async function world(status = 'SHIPPED') {
  const db = fake.makeDb({ catalog: { settings: { content: {} } }, fulfillments: { o1: { buyerUid: 'b1', creatorId: 'c1', productId: 'p1', status } } });
  await ledger.attributeCreatorEarning(db, { reference: 'o1', creatorId: 'c1', productId: 'p1', productTitle: 'x', offeringType: 'PHYSICAL_PRODUCT', amountMajor: 10000, currency: 'NGN' });
  return db;
}
const rider = async (db) => P.issueRiderTask(db, { orderId: 'o1', riderId: 'r1', env });

test('code alphabet: 6 chars, never O/0/I/1', () => {
  for (let i = 0; i < 2000; i++) { const c = P.generateCode(); assert.match(c, /^[A-HJ-NP-Z2-9]{6}$/); }
});
test('only the buyer, only while shipped; code never stored in clear', async () => {
  const db = await world();
  await assert.rejects(P.issueCode(db, { orderId: 'o1', buyerUid: 'other', env }), (e) => e.code === 'NOT_FOUND');
  const db2 = await world('PENDING');
  await assert.rejects(P.issueCode(db2, { orderId: 'o1', buyerUid: 'b1', env }), (e) => e.code === 'NOT_IN_TRANSIT');
  const { code } = await P.issueCode(db, { orderId: 'o1', buyerUid: 'b1', env });
  assert.equal(JSON.stringify(db._store).includes(code), false);
});
test('missing server secret fails closed', async () => {
  const db = await world();
  await assert.rejects(P.issueCode(db, { orderId: 'o1', buyerUid: 'b1', env: {} }), (e) => e.code === 'DELIVERY_CODE_NOT_CONFIGURED');
});
test('rider with valid task + right code: DELIVERED, BUYER_CODE evidence, earning clock starts; code single use', async () => {
  const db = await world();
  const { code } = await P.issueCode(db, { orderId: 'o1', buyerUid: 'b1', env });
  const t = await rider(db);
  const r = await P.verifyCode(db, { orderId: 'o1', code, enteredBy: { type: 'RIDER', taskId: t.taskId, taskToken: t.token }, env });
  assert.equal(r.ok, true); assert.equal(r.source, 'BUYER_CODE');
  assert.equal(db._store.fulfillments.o1.status, 'DELIVERED'); assert.equal(db._store.fulfillments.o1.deliveryEvidenceSource, 'BUYER_CODE');
  assert.ok(db._store.creatorSales.o1.deliveredAtMs);
  const again = await P.verifyCode(db, { orderId: 'o1', code, enteredBy: { type: 'RIDER', taskId: t.taskId, taskToken: t.token }, env });
  assert.equal(again.code, 'ALREADY_USED');
});
test('wrong codes are counted and lock after 5; no delivery recorded', async () => {
  const db = await world();
  const { code } = await P.issueCode(db, { orderId: 'o1', buyerUid: 'b1', env });
  const t = await rider(db); const who = { type: 'RIDER', taskId: t.taskId, taskToken: t.token };
  const wrong = code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA';
  let last; for (let i = 0; i < 5; i++) last = await P.verifyCode(db, { orderId: 'o1', code: wrong, enteredBy: who, env });
  assert.equal(last.code, 'LOCKED');
  assert.equal((await P.verifyCode(db, { orderId: 'o1', code, enteredBy: who, env })).code, 'LOCKED'); // even the right code is refused once locked
  assert.equal(db._store.fulfillments.o1.status, 'SHIPPED'); assert.equal(db._store.creatorSales.o1.deliveredAtMs, undefined);
  // buyer can re-issue, which resets the counter
  const n = await P.issueCode(db, { orderId: 'o1', buyerUid: 'b1', env });
  assert.equal((await P.verifyCode(db, { orderId: 'o1', code: n.code, enteredBy: who, env })).ok, true);
});
test('expired code is refused', async () => {
  const db = await world();
  const { code } = await P.issueCode(db, { orderId: 'o1', buyerUid: 'b1', env, nowMs: 1000, ttlMs: 600000 });
  const t = await P.issueRiderTask(db, { orderId: 'o1', riderId: 'r1', env, nowMs: 1000 });
  const r = await P.verifyCode(db, { orderId: 'o1', code, enteredBy: { type: 'RIDER', taskId: t.taskId, taskToken: t.token }, env, nowMs: 1000 + 600001 });
  assert.equal(r.code, 'EXPIRED');
});
test('rider vault: wrong token, other order, revoked, expired, flag off', async () => {
  const db = await world(); const { code } = await P.issueCode(db, { orderId: 'o1', buyerUid: 'b1', env });
  const t = await rider(db);
  const go = (over, e = env) => P.verifyCode(db, { orderId: 'o1', code, enteredBy: { type: 'RIDER', taskId: t.taskId, taskToken: t.token, ...over }, env: e });
  await assert.rejects(go({ taskToken: 'nope' }), (e) => e.code === 'TASK_NOT_VALID');
  await assert.rejects(go({ taskId: 'zzz' }), (e) => e.code === 'TASK_NOT_VALID');
  await assert.rejects(P.verifyCode(db, { orderId: 'o2', code, enteredBy: { type: 'RIDER', taskId: t.taskId, taskToken: t.token }, env }), (e) => e.code === 'TASK_NOT_VALID');
  await assert.rejects(go({}, { ...env, RIDER_VAULT_ENABLED: 'false' }), (e) => e.code === 'RIDER_VAULT_DISABLED');
  await P.revokeRiderTask(db, { taskId: t.taskId, by: 'a' });
  await assert.rejects(go({}), (e) => e.code === 'TASK_NOT_VALID');
  assert.equal(JSON.stringify(db._store.riderTasks).includes(t.token), false);
});
test('authorised recipient yields RECIPIENT_CODE, an unauthorised one is refused', async () => {
  const db = await world(); const { code } = await P.issueCode(db, { orderId: 'o1', buyerUid: 'b1', env });
  const t = await rider(db); const who = { type: 'RIDER', taskId: t.taskId, taskToken: t.token };
  assert.equal((await P.verifyCode(db, { orderId: 'o1', code, enteredBy: who, asRecipient: true, env })).code, 'RECIPIENT_NOT_AUTHORISED');
  await assert.rejects(P.authoriseRecipient(db, { orderId: 'o1', buyerUid: 'evil', name: 'Bob' }), (e) => e.code === 'NOT_FOUND');
  await P.authoriseRecipient(db, { orderId: 'o1', buyerUid: 'b1', name: 'Mrs Obi', phone: '08031234567' });
  const r = await P.verifyCode(db, { orderId: 'o1', code, enteredBy: who, asRecipient: true, env });
  assert.equal(r.source, 'RECIPIENT_CODE'); assert.equal(db._store.fulfillments.o1.deliveryEvidenceSource, 'RECIPIENT_CODE');
  assert.equal(JSON.stringify(db._store.deliveryCodes.o1.recipient).includes('08031234567'), false);
});
test('exception path: report a problem holds earnings, idempotent, buyer-only', async () => {
  const db = await world();
  await assert.rejects(P.reportProblem(db, { orderId: 'o1', reportedBy: 'evil', reason: 'not mine at all' }), (e) => e.code === 'NOT_FOUND');
  const a = await P.reportProblem(db, { orderId: 'o1', reportedBy: 'b1', reason: 'Rider never came' });
  const b = await P.reportProblem(db, { orderId: 'o1', reportedBy: 'b1', reason: 'Rider never came' });
  assert.equal(a.opened, true); assert.equal(b.opened, false);
  assert.equal(db._store.creatorSales.o1.exceptionOpen, true);
  const n = await ledger.releaseDueHolds(db, 10 * 365 * DAY, 50);
  assert.equal(db._store.creatorSales.o1.status, 'held');
});
test('endpoint: only buyer response contains a code; rider response never does; rate limit', async () => {
  const db = await world(); const mk = () => { const r = { code: 200, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; }, setHeader() {}, end() { return r; } }; return r; };
  const h = api.makeHandler({ db, env, auth: async () => ({ uid: 'b1' }), adminAuth: async () => ({ uid: 'admin' }) });
  const call = async (body, ip) => { const r = mk(); await h({ method: 'POST', body, headers: { 'x-forwarded-for': ip } }, r); return r; };
  const issued = await call({ action: 'issue_code', orderId: 'o1' }, '5.5.5.5');
  assert.match(issued.body.data.code, /^[A-HJ-NP-Z2-9]{6}$/);
  const task = await call({ action: 'issue_rider_task', orderId: 'o1', riderId: 'r1' }, '5.5.5.5');
  const bad = await call({ action: 'rider_verify', orderId: 'o1', taskId: task.body.data.taskId, taskToken: task.body.data.token, code: 'ZZZZZZ' }, '5.5.5.5');
  assert.equal(bad.body.data.verified, false); assert.equal(JSON.stringify(bad.body).includes(issued.body.data.code), false);
  assert.equal((await call({ action: 'rider_verify', orderId: 'o1', taskId: task.body.data.taskId, taskToken: task.body.data.token, code: issued.body.data.code }, '5.5.5.5')).body.data.verified, true);
  let last; for (let i = 0; i < 25; i++) last = await call({ action: 'nope', orderId: 'o1' }, '6.6.6.6');
  assert.equal(last.code, 429);
});
