const test = require('node:test');
const assert = require('node:assert/strict');
const { splitByFeePct, DEFAULT_PLATFORM_FEE_PCT, attributeCreatorEarning } = require('../api/creator/ledger');
const { csvEscape } = require('../api/creator-admin-finance');

test('splitByFeePct splits 15% of 1000 into 150 fee / 850 net (generic helper, rate passed in)', () => {
  assert.deepEqual(splitByFeePct(1000, 15), { feeAmount: 150, netAmount: 850 });
});

test('splitByFeePct handles a fractional result without drift', () => {
  const { feeAmount, netAmount } = splitByFeePct(19.99, 15);
  assert.equal(feeAmount, 3);
  assert.equal(Math.round((feeAmount + netAmount) * 100) / 100, 19.99 + (3 - feeAmount));
  assert.equal(netAmount, 16.99);
});

test('splitByFeePct at 0% gives no fee and at 100% gives no net', () => {
  assert.deepEqual(splitByFeePct(500, 0), { feeAmount: 0, netAmount: 500 });
  assert.deepEqual(splitByFeePct(500, 100), { feeAmount: 500, netAmount: 0 });
});

test('the default platform fee is the approved 10%', () => {
  assert.equal(DEFAULT_PLATFORM_FEE_PCT, 10);
});

// A tiny in-memory Firestore double — enough to prove the ledger credit is
// idempotent and transactional, which is the property money depends on.
function fakeDb(settingsContent) {
  const store = new Map();
  const doc = (col, id) => ({ col, id, key: `${col}/${id}` });
  const snapOf = (d) => ({ exists: store.has(d.key), data: () => store.get(d.key) });
  const apply = (d, data, opts) => {
    const next = {};
    const prev = (opts && opts.merge && store.get(d.key)) || {};
    Object.assign(next, prev);
    for (const [k, v] of Object.entries(data)) {
      if (v && v.__inc !== undefined) next[k] = (next[k] || 0) + v.__inc;
      else next[k] = v;
    }
    store.set(d.key, next);
  };
  const db = {
    store,
    collection: (col) => ({
      doc: (id) => ({
        ...doc(col, id),
        get: async () => (col === 'catalog' && id === 'settings'
          ? { exists: true, data: () => ({ content: settingsContent || {} }) }
          : snapOf(doc(col, id))),
      }),
    }),
    runTransaction: async (fn) => fn({
      get: async (ref) => snapOf(ref),
      set: (ref, data, opts) => apply(ref, data, opts),
    }),
  };
  return db;
}

// attributeCreatorEarning uses FieldValue.increment from firebase-admin;
// translate its sentinel into our fake's __inc marker for the assertion.
const { FieldValue } = require('firebase-admin/firestore');
const origIncrement = FieldValue.increment;
test.before(() => { FieldValue.increment = (n) => ({ __inc: n }); });
test.after(() => { FieldValue.increment = origIncrement; });

const sale = { reference: 'ref_1', creatorId: 'c1', productId: 'p1', productTitle: 'T', offeringType: 'EBOOK', amountMajor: 1000, currency: 'NGN' };

test('crediting a sale writes a ledger row and credits 90% to the creator (10% commission)', async () => {
  const db = fakeDb();
  const r = await attributeCreatorEarning(db, sale);
  assert.equal(r.credited, true);
  assert.equal(db.store.get('creatorSales/ref_1').creatorEarning, 900);
  assert.equal(db.store.get('creatorPrivate/c1').balanceAvailable, 900);
  assert.equal(db.store.get('creatorPrivate/c1').totalEarned, 900);
});

test('crediting the same reference twice NEVER double-credits', async () => {
  const db = fakeDb();
  await attributeCreatorEarning(db, sale);
  const second = await attributeCreatorEarning(db, sale);
  assert.equal(second.credited, false);
  assert.equal(db.store.get('creatorPrivate/c1').balanceAvailable, 900);
});

test('a stale legacy creatorPlatformFeePct is IGNORED; only creatorCommissionBps overrides the default', async () => {
  const stale = fakeDb({ creatorPlatformFeePct: 15 });
  await attributeCreatorEarning(stale, sale);
  assert.equal(stale.store.get('creatorSales/ref_1').creatorEarning, 900);
  const explicit = fakeDb({ creatorCommissionBps: 500 });
  await attributeCreatorEarning(explicit, sale);
  assert.equal(explicit.store.get('creatorSales/ref_1').creatorEarning, 950);
  assert.equal(explicit.store.get('creatorSales/ref_1').feeSnapshot.commissionBps, 500);
});

test('free sales and non-creator sales credit nothing', async () => {
  const db = fakeDb();
  assert.equal((await attributeCreatorEarning(db, { ...sale, amountMajor: 0 })).credited, false);
  assert.equal((await attributeCreatorEarning(db, { ...sale, creatorId: null })).credited, false);
  assert.equal(db.store.size, 0);
});

test('csvEscape quotes commas/newlines and neutralises formula injection', () => {
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(csvEscape('@cmd'), "'@cmd");
  assert.equal(csvEscape(null), '');
  assert.equal(csvEscape(42), '42');
});
