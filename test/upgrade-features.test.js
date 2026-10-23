const test = require('node:test');
const assert = require('node:assert/strict');
const fake = require('./helpers/fake-db');
const funding = require('../api/supplier/funding');
const fundingApi = require('../api/creator-admin-funding');
const stationsApi = require('../api/pickup-stations');
const updatesApi = require('../api/creator-updates');
const X = require('../api/creator/checkout');

test.before(() => fake.install());
test.after(() => fake.restore());

const mkres = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; }, setHeader() {}, end() { return r; } }; return r; };
const call = async (h, method, body, query = {}) => { const res = mkres(); await h({ method, body, query, headers: {} }, res); return res; };
const NF = { CJ_FUNDING_MODE: 'NOVA_FUNDED' };

// ---------- NOVA-funded CJ ----------
test('NOVA_FUNDED: held until an admin attests; never silently allowed', () => {
  assert.equal(funding.evaluateFunding(NF, {}).allowed, false);
  assert.equal(funding.evaluateFunding(NF, {}).code, 'NOVA_FUNDING_PENDING');
  assert.equal(funding.evaluateFunding(NF, { novaFunding: { confirmed: true, confirmedBy: 'a1' } }).allowed, true);
  // an attestation does not unlock other modes
  assert.equal(funding.evaluateFunding({}, { novaFunding: { confirmed: true } }).allowed, false);
  assert.equal(funding.evaluateFunding({ CJ_FUNDING_MODE: 'CREATOR_ACCOUNT' }, {}).allowed, true);
});
test('confirm_funded: needs the mode, a reference, is idempotent, resolves only the funding exception and places the order once', async () => {
  const db = fake.makeDb({ fulfillments: { o1: { creatorId: 'c1', exceptionOpen: true } }, creatorSales: { o1: { exceptionOpen: true } } });
  await X.openException(db, { orderId: 'o1', code: X.EXCEPTION_CODES.SUPPLIER_FUNDING_UNAVAILABLE, creatorId: 'c1', productId: 'p1', details: {} });
  await X.openException(db, { orderId: 'o1', code: X.EXCEPTION_CODES.DELIVERY_PROOF_PROBLEM, creatorId: 'c1', productId: 'p1', details: {} });
  const placed = []; const adminAuth = async () => ({ uid: 'admin1' });
  const mk = (env) => fundingApi.makeHandler({ db, env, adminAuth, createOrder: async (_d, id) => { placed.push(id); return { ok: true }; } });
  assert.equal((await call(mk({}), 'POST', { action: 'confirm_funded', orderId: 'o1', reference: 'CJ-123' })).body.error.code, 'NOT_NOVA_FUNDED_MODE');
  assert.equal((await call(mk(NF), 'POST', { action: 'confirm_funded', orderId: 'o1', reference: 'x' })).body.error.code, 'REFERENCE_REQUIRED');
  assert.equal(placed.length, 0);
  const a = await call(mk(NF), 'POST', { action: 'confirm_funded', orderId: 'o1', reference: 'CJ-123' });
  assert.equal(a.body.ok, true); assert.equal(placed.length, 1);
  assert.equal(db._store.fulfillments.o1.novaFunding.verifiedWithCj, false);
  const b = await call(mk(NF), 'POST', { action: 'confirm_funded', orderId: 'o1', reference: 'CJ-123' });
  assert.equal(b.body.data.already, true); assert.equal(placed.length, 1);
  const open = Object.values(db._store.orderExceptions).filter((e) => e.state === 'OPEN');
  assert.equal(open.length, 1); assert.equal(open[0].code, X.EXCEPTION_CODES.DELIVERY_PROOF_PROBLEM);
  assert.equal(db._store.fulfillments.o1.exceptionOpen, true, 'hold stays while another exception is open');
});

// ---------- pickup stations ----------
const ST = { PICKUP_STATIONS_ENABLED: 'true' };
const good = { name: 'Ade Pharmacy', address: '12 Market Rd', city: 'Ikeja', state: 'Lagos', openingHours: '9-6', contactPhone: '0800', managerName: 'Ade', businessType: 'PHARMACY' };
test('stations: off by default; submit -> review -> only approved shows publicly, with no phone/owner', async () => {
  const db = fake.makeDb(); const auth = async () => ({ uid: 'owner1' }); const adminAuth = async () => ({ uid: 'adm' });
  const off = stationsApi.makeHandler({ db, env: {}, auth, adminAuth });
  assert.deepEqual((await call(off, 'GET')).body.data, { enabled: false, stations: [] });
  assert.equal((await call(off, 'POST', { action: 'submit', details: good })).code, 503);
  const h = stationsApi.makeHandler({ db, env: ST, auth, adminAuth });
  assert.equal((await call(h, 'POST', { action: 'submit', details: { ...good, isResidential: true } })).code, 422);
  const s = (await call(h, 'POST', { action: 'submit', details: good })).body.data;
  assert.equal((await call(h, 'GET')).body.data.stations.length, 0);
  // approve without all checks is refused
  assert.equal((await call(h, 'POST', { action: 'review', id: s.id, to: 'APPROVED', checks: { identityVerified: true } })).body.error.code, 'CHECKS_INCOMPLETE');
  const checks = { identityVerified: true, businessPremisesVerified: true, openingHoursConfirmed: true, secureStorageConfirmed: true, termsAccepted: true };
  const r = await call(h, 'POST', { action: 'review', id: s.id, to: 'APPROVED', checks });
  assert.equal(r.body.data.station.state, 'APPROVED');
  const pub = (await call(h, 'GET')).body.data.stations;
  assert.equal(pub.length, 1); assert.equal(pub[0].contactPhone, undefined); assert.equal(pub[0].ownerUid, undefined);
  assert.equal((await call(h, 'POST', { action: 'review', id: s.id, to: 'SUSPENDED', note: 'x' })).body.error.code, 'NOTE_REQUIRED');
  await call(h, 'POST', { action: 'review', id: s.id, to: 'SUSPENDED', note: 'Complaints received' });
  assert.equal((await call(h, 'GET')).body.data.stations.length, 0);
  assert.equal((await call(h, 'GET', null, { mine: '1' })).body.data.stations[0].state, 'SUSPENDED');
});

// ---------- creator updates ----------
test('updates: validation, ownership, daily limit, moderation, public sees only visible from active creators', async () => {
  const db = fake.makeDb({ products: { p1: { creatorId: 'c1' }, p2: { creatorId: 'c2' } } });
  let now = 1_000_000;
  const creatorAuth = async () => ({ decoded: { uid: 'c1' }, creator: { status: 'ACTIVE' } });
  const adminAuth = async () => ({ uid: 'adm' });
  const getCreator = async (id) => ({ status: id === 'c1' ? 'ACTIVE' : 'SUSPENDED' });
  const h = updatesApi.makeHandler({ db, creatorAuth, adminAuth, getCreator, now: () => now });
  assert.equal((await call(h, 'POST', { action: 'post', text: 'hi' })).body.error.code, 'BAD_TEXT');
  assert.equal((await call(h, 'POST', { action: 'post', text: 'Buy now at http://x.co' })).body.error.code, 'NO_LINKS');
  assert.equal((await call(h, 'POST', { action: 'post', text: 'New stock arrives soon', productId: 'p2' })).body.error.code, 'NOT_YOUR_PRODUCT');
  const u1 = (await call(h, 'POST', { action: 'post', text: 'New stock arrives soon', productId: 'p1' })).body.data.update;
  await call(h, 'POST', { action: 'post', text: 'Second update here' }); await call(h, 'POST', { action: 'post', text: 'Third update here' });
  assert.equal((await call(h, 'POST', { action: 'post', text: 'Fourth update here' })).body.error.code, 'DAILY_LIMIT');
  now += 25 * 3600 * 1000;
  assert.equal((await call(h, 'POST', { action: 'post', text: 'Fourth update here' })).body.ok, true);
  assert.equal((await call(h, 'GET', null, { creatorId: 'c1' })).body.data.updates.length, 4);
  assert.equal((await call(h, 'POST', { action: 'hide', id: u1.id, reason: 'no' })).body.error.code, 'REASON_REQUIRED');
  await call(h, 'POST', { action: 'hide', id: u1.id, reason: 'Misleading claim' });
  assert.equal((await call(h, 'GET', null, { creatorId: 'c1' })).body.data.updates.length, 3);
  assert.equal((await call(h, 'GET', null, { mine: '1' })).body.data.updates.length, 4, 'creator still sees hidden ones');
  assert.equal((await call(h, 'GET', null, { creatorId: 'c2' })).body.data.updates.length, 0, 'inactive creator shows nothing');
  const other = updatesApi.makeHandler({ db, creatorAuth: async () => ({ decoded: { uid: 'c9' } }), now: () => now });
  assert.equal((await call(other, 'POST', { action: 'delete', id: u1.id })).code, 404);
  await call(h, 'POST', { action: 'delete', id: u1.id });
  assert.equal((await call(h, 'POST', { action: 'unhide', id: u1.id })).body.error.code, 'DELETED');
});
