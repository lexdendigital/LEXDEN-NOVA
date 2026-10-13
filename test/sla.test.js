const test = require('node:test');
const assert = require('node:assert/strict');
const sla = require('../api/creator/sla');
const { makeDb } = require('./helpers/fake-firestore');
const { createFulfillment } = require('../api/creator/fulfillment');

const H = sla.HOUR;
const T0 = 1_800_000_000_000;
const mk = (over = {}) => ({ status: 'PENDING', createdAtMs: T0, ...over });

test('policy: defaults, and a longer processing time stretches only the ship window', () => {
  const p = sla.slaPolicyFor({});
  assert.equal(p.ackHours, 24); assert.equal(p.shipHours, 48);
  assert.equal(sla.slaPolicyFor({ processingDays: 1 }).shipHours, 48);
  assert.equal(sla.slaPolicyFor({ processingDays: 7 }).shipHours, 168);
  assert.equal(sla.slaPolicyFor({ processingDays: 999 }).shipHours, 48);
  assert.equal(sla.slaPolicyFor({ processingDays: 2.5 }).shipHours, 48);
  const d = sla.computeDeadlines(T0, p);
  assert.equal(d.ackDueAtMs, T0 + 24 * H); assert.equal(d.shipDueAtMs, T0 + 48 * H);
});

test('toMs understands Firestore Timestamps, Dates, numbers, plain {seconds}', () => {
  assert.equal(sla.toMs({ toMillis: () => 5 }), 5);
  assert.equal(sla.toMs(new Date(7)), 7);
  assert.equal(sla.toMs({ seconds: 2, nanoseconds: 5e6 }), 2005);
  assert.equal(sla.toMs({ _seconds: 3 }), 3000);
  assert.equal(sla.toMs(null), null); assert.equal(sla.toMs('x'), null);
});

test('fresh order is on track; 6h before the ack deadline it is at risk; after it, breached', () => {
  assert.equal(sla.evaluateSla(mk(), T0 + 1 * H).overall, 'ON_TRACK');
  assert.equal(sla.evaluateSla(mk(), T0 + 20 * H).overall, 'AT_RISK');
  const late = sla.evaluateSla(mk(), T0 + 25 * H);
  assert.equal(late.overall, 'BREACHED'); assert.deepEqual(late.breaches, ['ACK_OVERDUE']);
});

test('acknowledging in time clears the ack milestone; ship deadline then governs', () => {
  const f = mk({ acknowledgedAtMs: T0 + 2 * H });
  assert.equal(sla.evaluateSla(f, T0 + 30 * H).ack, 'MET');
  assert.equal(sla.evaluateSla(f, T0 + 30 * H).overall, 'ON_TRACK');
  assert.equal(sla.evaluateSla(f, T0 + 40 * H).overall, 'AT_RISK');
  const b = sla.evaluateSla(f, T0 + 49 * H);
  assert.deepEqual(b.breaches, ['SHIP_OVERDUE']);
});

test('packing implies acknowledgement (Firestore Timestamp shape)', () => {
  const f = mk({ status: 'PACKED', packedAt: { toMillis: () => T0 + 3 * H } });
  const e = sla.evaluateSla(f, T0 + 10 * H);
  assert.equal(e.ack, 'MET'); assert.equal(e.overall, 'ON_TRACK');
});

test('late acknowledgement/shipment is remembered as a breach even after the fact', () => {
  const f = mk({ status: 'SHIPPED', acknowledgedAtMs: T0 + 30 * H, shippedAt: { toMillis: () => T0 + 60 * H } });
  const e = sla.evaluateSla(f, T0 + 61 * H);
  assert.deepEqual(e.breaches.sort(), ['ACK_LATE', 'SHIP_LATE']);
  assert.equal(e.overall, 'BREACHED');
});

test('shipped on time: complete once delivered, delivery overdue flagged after 14 days', () => {
  const shippedAt = T0 + 20 * H;
  const f = mk({ status: 'SHIPPED', acknowledgedAtMs: T0 + H, shippedAt: { toMillis: () => shippedAt } });
  assert.equal(sla.evaluateSla(f, T0 + 5 * sla.DAY).overall, 'ON_TRACK');
  assert.deepEqual(sla.evaluateSla(f, shippedAt + 15 * sla.DAY).breaches, ['DELIVERY_OVERDUE']);
  const d = mk({ status: 'DELIVERED', acknowledgedAtMs: T0 + H, shippedAt: { toMillis: () => shippedAt }, deliveredAt: { toMillis: () => shippedAt + 3 * sla.DAY } });
  assert.equal(sla.evaluateSla(d, shippedAt + 10 * sla.DAY).overall, 'COMPLETE');
});

test('cancelled/returned/unknown orders are closed (no SLA applies)', () => {
  for (const status of ['CANCELLED', 'RETURNED']) assert.equal(sla.evaluateSla(mk({ status }), T0 + 999 * H).overall, 'CLOSED');
  assert.equal(sla.evaluateSla(null, T0).overall, 'CLOSED');
  assert.equal(sla.evaluateSla({ status: 'PENDING' }, T0).overall, 'CLOSED');
});

test('stored deadlines win over recomputation (listing processing time at order time)', () => {
  const f = mk({ ackDueAtMs: T0 + 100 * H, shipDueAtMs: T0 + 200 * H });
  assert.equal(sla.evaluateSla(f, T0 + 90 * H).overall, 'AT_RISK');
  assert.equal(sla.evaluateSla(f, T0 + 50 * H).overall, 'ON_TRACK');
});

test('creator summary: needs a real sample and repeated failures before recommending restriction', () => {
  const now = T0 + 100 * H;
  const bad = () => mk({ createdAtMs: T0 });                       // 100h old, unacked => breached
  const good = () => mk({ status: 'SHIPPED', acknowledgedAtMs: T0 + H, shippedAt: { toMillis: () => T0 + 5 * H } });
  const one = sla.summarizeCreatorSla([bad()], now);
  assert.equal(one.restrictionRecommended, false); assert.equal(one.watch, false);
  const watch = sla.summarizeCreatorSla([bad(), bad(), good(), good(), good(), good()], now);
  assert.equal(watch.watch, true); assert.equal(watch.restrictionRecommended, false);
  const restrict = sla.summarizeCreatorSla([bad(), bad(), bad(), good(), good()], now);
  assert.equal(restrict.restrictionRecommended, true); assert.equal(restrict.breached, 3); assert.equal(restrict.breachRatePct, 60);
  const fewOrders = sla.summarizeCreatorSla([bad(), bad(), bad()], now);
  assert.equal(fewOrders.restrictionRecommended, false);
  const cancelledIgnored = sla.summarizeCreatorSla([mk({ status: 'CANCELLED' }), good()], now);
  assert.equal(cancelledIgnored.total, 1);
});

test('createFulfillment starts the seller clock with the listing\'s policy', async () => {
  const db = makeDb();
  await createFulfillment(db, { orderId: 'o1', productId: 'p', creatorId: 'u', delivery: {}, fulfillmentMode: 'MANUAL_SUPPLIER', processingDays: 5, nowMs: T0 });
  const f = db._store.fulfillments.o1;
  assert.equal(f.fulfillmentMode, 'MANUAL_SUPPLIER');
  assert.equal(f.shipDueAtMs, T0 + 120 * H); assert.equal(f.ackDueAtMs, T0 + 24 * H);
  assert.equal(f.acknowledgedAtMs, null);
  // idempotent: a retried payment does not reset the clock
  await createFulfillment(db, { orderId: 'o1', productId: 'p', creatorId: 'u', nowMs: T0 + 50 * H });
  assert.equal(db._store.fulfillments.o1.createdAtMs, T0);
  // legacy callers (no mode) still work
  await createFulfillment(db, { orderId: 'o2', productId: 'p', creatorId: 'u', nowMs: T0 });
  assert.equal(db._store.fulfillments.o2.fulfillmentMode, 'SELLER_STOCK');
});
