const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDb } = require('./helpers/fake-firestore');
const { makeFakeCj } = require('./helpers/fake-cj');

process.env.SUPPLIER_CREDENTIALS_KEY = 'c4'.repeat(32);
delete process.env.BREVO_TPL_CREATOR_SLA;
const jobs = require('../api/automation/jobs');
const { runJob, runJobs } = require('../api/automation/runner');
const alerts = require('../api/automation/alerts');
const service = require('../api/supplier/service');

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const H = 3600000;
const pubOk = async () => ['93.184.216.34'];
const resp = (status, headers = {}) => async () => ({ status, headers });

const linkProduct = (over = {}) => ({ creatorId: 'u1', status: 'PUBLISHED', publishedSnapshot: { title: 'Ebook', externalUrl: 'https://files.example/book.pdf', offeringType: 'DIGITAL_PRODUCT' }, ...over });

// ------------------------------------------------------------------ alerts
test('alerts: raising the same key twice keeps ONE open alert and bumps its counter', async () => {
  const db = makeDb();
  const a = await alerts.raiseAlert(db, { key: 'k/1', type: 'T', title: 'x', nowMs: NOW });
  const b = await alerts.raiseAlert(db, { key: 'k/1', type: 'T', title: 'x', nowMs: NOW + 1 });
  assert.equal(a.created, true); assert.equal(b.created, false);
  assert.equal(Object.keys(db._store.adminAlerts).length, 1);
  assert.equal(Object.values(db._store.adminAlerts)[0].count, 2);
  assert.equal(await alerts.resolveAlertByKey(db, 'k/1', 'ok', NOW), true);
  assert.equal(await alerts.resolveAlertByKey(db, 'k/1', 'ok', NOW), false);
  const c = await alerts.raiseAlert(db, { key: 'k/1', type: 'T', title: 'x', nowMs: NOW + 5 });
  assert.equal(c.created, true);
  assert.equal(Object.values(db._store.adminAlerts)[0].reopenedFromResolved, true);
  await assert.rejects(alerts.resolveAlert(db, 'nope'), (e) => e.status === 404);
  await assert.rejects(alerts.raiseAlert(db, { key: '', type: 'T', title: 'x' }));
});

test('alerts: notifyCreator is once per creator+key', async () => {
  const db = makeDb();
  assert.equal(await alerts.notifyCreator(db, { creatorId: 'u1', key: 'a', title: 't', body: 'b', nowMs: NOW }), true);
  assert.equal(await alerts.notifyCreator(db, { creatorId: 'u1', key: 'a', title: 't', body: 'b', nowMs: NOW }), false);
  assert.equal(await alerts.notifyCreator(db, { creatorId: 'u2', key: 'a', title: 't', body: 'b', nowMs: NOW }), true);
  assert.equal(await alerts.notifyCreator(db, { creatorId: '', key: 'a', title: 't' }), false);
});

// ------------------------------------------------------------------- links
test('links: healthy link is recorded, no pause', async () => {
  const db = makeDb({ products: { p1: linkProduct() } });
  const out = await jobs.linkHealthJob(db, { nowMs: NOW, deps: { resolve: pubOk, requestOnce: resp(200) } });
  assert.equal(out.healthy, 1);
  assert.equal(db._store.products.p1.status, 'PUBLISHED');
  assert.equal(db._store.products.p1.linkHealth.state, 'HEALTHY');
});

test('links: a broken link warns twice, then pauses on the 3rd check with alert, notification and audit', async () => {
  const db = makeDb({ products: { p1: linkProduct() } });
  const deps = { resolve: pubOk, requestOnce: resp(404) };
  for (let i = 1; i <= 2; i++) {
    const o = await jobs.linkHealthJob(db, { nowMs: NOW + i * 7 * H, deps });
    assert.equal(o.warnings, 1); assert.equal(o.paused, 0);
    assert.equal(db._store.products.p1.status, 'PUBLISHED');
  }
  const o = await jobs.linkHealthJob(db, { nowMs: NOW + 21 * H, deps });
  assert.equal(o.paused, 1);
  assert.equal(db._store.products.p1.status, 'PAUSED');
  assert.equal(db._store.products.p1.pausedByLink, true);
  assert.equal(Object.values(db._store.adminAlerts).filter((a) => a.type === 'LINK_DEGRADED' && a.status === 'open').length, 1);
  assert.ok(Object.values(db._store.creatorNotifications).some((n) => n.type === 'PRODUCT_PAUSED'));
  assert.ok(Object.values(db._store.productAuditLog).some((x) => x.actorRole === 'system' && x.action === 'product.auto_paused_link'));
});

test('links: a private/internal address is paused immediately and no request is made', async () => {
  const db = makeDb({ products: { p1: linkProduct({ publishedSnapshot: { title: 'x', externalUrl: 'http://169.254.169.254/latest', offeringType: 'DIGITAL_PRODUCT' } }) } });
  const out = await jobs.linkHealthJob(db, { nowMs: NOW, deps: { resolve: pubOk, requestOnce: async () => { throw new Error('must not request'); } } });
  assert.equal(out.paused, 1);
  assert.equal(db._store.products.p1.pausedByLink, true);
});

test('links: recently checked links are skipped (no request made)', async () => {
  const db = makeDb({ products: { p1: linkProduct({ status: 'PUBLISHED', linkHealth: { checkedAtMs: NOW - 1 * H, consecutiveBroken: 0 } }) } });
  const o = await jobs.linkHealthJob(db, { nowMs: NOW, deps: { resolve: pubOk, requestOnce: async () => { throw new Error('too soon'); } } });
  assert.equal(o.checked, 0);
});

test('links: one throwing product does not stop the sweep', async () => {
  const db = makeDb({ products: { p1: linkProduct(), p2: linkProduct() } });
  let n = 0;
  const out = await jobs.linkHealthJob(db, { nowMs: NOW, deps: { resolve: async () => { if (++n === 1) throw new Error('dns boom'); return ['93.184.216.34']; }, requestOnce: resp(200) } });
  assert.equal(out.checked + out.errors, 2);
});

// ---------------------------------------------------------------- supplier
test('supplierHealth: runs over CJ listings without crashing when a mapping is missing', async () => {
  const cj = makeFakeCj();
  const db = makeDb();
  await service.connectCj(db, { uid: 'u1', creator: { status: 'ACTIVE' }, email: 'jane@example.com', apiKey: 'good-api-key' }, cj.deps);
  db._store.products = { p1: { creatorId: 'u1', status: 'PUBLISHED', latestVersionId: 'v1', currentVersionId: 'v1', publishedSnapshot: { title: 'Lamp', fulfillmentMode: 'CJ_DROPSHIP', offeringType: 'PHYSICAL_PRODUCT' } } };
  // no mapping saved -> should not crash the job
  const out = await jobs.supplierHealthJob(db, { nowMs: NOW, deps: cj.deps });
  assert.equal(out.eligible, 1);
  assert.equal(out.errors + out.checked + out.cached + out.paused >= 0, true);
});

// ---------------------------------------------------------------- cj orders
test('cjOrders: orders needing attention raise ONE alert and ONE notification across repeated runs', async () => {
  const db = makeDb({ supplierOrders: { o1: { creatorId: 'u1', status: 'STOCK_ISSUE', error: { message: 'Out of stock' } } } });
  await jobs.cjOrderJob(db, { nowMs: NOW, deps: {} });
  await jobs.cjOrderJob(db, { nowMs: NOW + 1000, deps: {} });
  assert.equal(Object.keys(db._store.adminAlerts).length, 1);
  assert.equal(Object.keys(db._store.creatorNotifications).length, 1);
  assert.equal(Object.values(db._store.adminAlerts)[0].severity, 'critical');
});

test('cjOrders: live orders without a CJ id and RETRY_LATER with attempts exhausted are left alone', async () => {
  const db = makeDb({ supplierOrders: { a: { creatorId: 'u1', status: 'ORDERED' }, b: { creatorId: 'u1', status: 'RETRY_LATER', attempts: 9, updatedAtMs: 0 } } });
  const out = await jobs.cjOrderJob(db, { nowMs: NOW, deps: {} });
  assert.equal(out.synced, 0); assert.equal(out.retried, 0); assert.equal(out.errors, 0);
});

// --------------------------------------------------------------------- SLA
const lateFulfillment = (id, creatorId, extra = {}) => ({
  [id]: { creatorId, status: 'PENDING', productTitle: 'Lamp', createdAtMs: NOW - 10 * 86400000, ackDueAtMs: NOW - 9 * 86400000, shipDueAtMs: NOW - 8 * 86400000, slaPolicy: { ackHours: 24, shipHours: 48 }, ...extra },
});
function slaSeed() {
  const f = {};
  for (let i = 0; i < 6; i++) Object.assign(f, lateFulfillment(`f${i}`, 'u1'));
  return {
    fulfillments: f,
    products: { p1: { creatorId: 'u1', status: 'PUBLISHED', publishedSnapshot: { offeringType: 'PHYSICAL_PRODUCT', title: 'Lamp' } }, p2: { creatorId: 'u1', status: 'PUBLISHED', publishedSnapshot: { offeringType: 'DIGITAL_PRODUCT', title: 'Ebook' } } },
  };
}

test('sla: late orders notify once, flag the seller, but DO NOT pause anything while auto-restrict is OFF (default)', async () => {
  const db = makeDb(slaSeed());
  const o1 = await jobs.slaJob(db, { nowMs: NOW, deps: {} });
  const o2 = await jobs.slaJob(db, { nowMs: NOW + 1000, deps: {} });
  assert.equal(o1.breached, 6); assert.ok(o1.notified > 0); assert.equal(o2.notified, 0);
  assert.equal(o1.autoPausedListings, 0);
  assert.equal(db._store.products.p1.status, 'PUBLISHED');
  const a = Object.values(db._store.adminAlerts).find((x) => x.type === 'SLA_TRUST');
  assert.equal(a.severity, 'critical'); assert.equal(a.count >= 2, true);
});

test('sla: with auto-restrict ON only the physical listings pause (digital untouched), reversible flag set, money untouched', async () => {
  const seed = slaSeed();
  seed.automationSettings = { config: { autoRestrictSla: true } };
  seed.creatorPrivate = { u1: { balanceAvailable: 50, totalEarned: 50 } };
  const db = makeDb(seed);
  const out = await jobs.slaJob(db, { nowMs: NOW, deps: {} });
  assert.equal(out.autoPausedListings, 1);
  assert.equal(db._store.products.p1.status, 'PAUSED'); assert.equal(db._store.products.p1.pausedBySla, true);
  assert.equal(db._store.products.p2.status, 'PUBLISHED');
  assert.deepEqual(db._store.creatorPrivate.u1, { balanceAvailable: 50, totalEarned: 50 });
  assert.equal(db._store.creators, undefined); // never suspends an account
});

test('sla: on-time orders raise nothing; an email is sent only for NEW notifications when an email dep exists', async () => {
  const db = makeDb({ fulfillments: { f1: { creatorId: 'u1', status: 'PENDING', createdAtMs: NOW, ackDueAtMs: NOW + 20 * H, shipDueAtMs: NOW + 40 * H } } });
  const out = await jobs.slaJob(db, { nowMs: NOW, deps: {} });
  assert.equal(out.atRisk + out.breached, 0);
  const sent = [];
  const db2 = makeDb(slaSeed());
  const deps = { sendEmail: async (p) => sent.push(p), emailFor: async () => 'a@b.co' };
  await jobs.slaJob(db2, { nowMs: NOW, deps });
  const first = sent.length;
  await jobs.slaJob(db2, { nowMs: NOW + 5, deps });
  assert.ok(first > 0); assert.equal(sent.length, first);
});

// ---------------------------------------------------------- reconciliation
test('reconcile: flags a paid order missing its ledger entry; clean data raises nothing; stuck withdrawal is flagged', async () => {
  const old = new Date(NOW - 2 * H);
  const db = makeDb({
    orders: { o1: { creatorProductId: 'p1', status: 'paid', amount: 100, creatorSellerId: 'u1', creatorOfferingType: 'DIGITAL_PRODUCT', timestamp: old.getTime() } },
    creatorPrivate: { u1: { balanceAvailable: 0, totalEarned: 0 } },
    creatorWithdrawals: { w1: { creatorId: 'u1', status: 'processing', amountRequested: 0, processingStartedAt: NOW - 3 * H } },
  });
  const out = await jobs.reconciliationJob(db, { nowMs: NOW, deps: {} });
  assert.equal(out.orderIssues >= 1, true);
  assert.equal(out.stuckWithdrawals, 1);
  const clean = makeDb({ creatorPrivate: { u1: { balanceAvailable: 0, totalEarned: 0 } } });
  const o2 = await jobs.reconciliationJob(clean, { nowMs: NOW, deps: {} });
  assert.equal(o2.orderIssues + o2.ledgerIssues + o2.stuckWithdrawals, 0);
});

test('reconcile: a balance that does not match sales minus withdrawals is flagged, and the job never edits it', async () => {
  const db = makeDb({
    creatorPrivate: { u1: { balanceAvailable: 999, totalEarned: 100 } },
    creatorSales: { s1: { creatorId: 'u1', creatorEarning: 100 } },
  });
  const out = await jobs.reconciliationJob(db, { nowMs: NOW, deps: {} });
  assert.equal(out.ledgerIssues, 1);
  assert.equal(db._store.creatorPrivate.u1.balanceAvailable, 999);
});

// ------------------------------------------------------------------ runner
test('runner: records a run, enforces min interval, lock, force and isolates failures', async () => {
  const db = makeDb();
  const r1 = await runJob(db, 'sla', { now: () => NOW });
  assert.equal(r1.status, 'OK');
  assert.equal(Object.keys(db._store.automationRuns).length, 1);
  const r2 = await runJob(db, 'sla', { now: () => NOW + 1000 });
  assert.deepEqual([r2.status, r2.reason], ['SKIPPED', 'TOO_SOON']);
  const r3 = await runJob(db, 'sla', { now: () => NOW + 1000, force: true });
  assert.equal(r3.status, 'OK');
  // lock held by a live run
  db._store.automationLocks.sla.lockedUntilMs = NOW + 60000;
  const r4 = await runJob(db, 'sla', { now: () => NOW + 2000, force: true });
  assert.deepEqual([r4.status, r4.reason], ['SKIPPED', 'LOCKED']);
  // expired lease is taken over
  db._store.automationLocks.sla.lockedUntilMs = NOW - 1;
  assert.equal((await runJob(db, 'sla', { now: () => NOW + 3000, force: true })).status, 'OK');
  assert.equal((await runJob(db, 'nope')).status, 'UNKNOWN_JOB');
});

test('runner: a failing job is recorded as ERROR, releases its lock, and the others still run', async () => {
  const db = makeDb();
  const results = await runJobs(db, ['emailQueue', 'sla'], { now: () => NOW, deps: { emailQueueHandler: async () => { throw new Error('smtp down'); } } });
  assert.equal(results[0].status, 'ERROR'); assert.match(results[0].error, /smtp down/);
  assert.equal(results[1].status, 'OK');
  assert.equal(db._store.automationLocks.emailQueue.lockedUntilMs, 0);
});

test('runner: two simultaneous triggers run the job only once', async () => {
  const db = makeDb();
  const [a, b] = await Promise.all([runJob(db, 'sla', { now: () => NOW }), runJob(db, 'sla', { now: () => NOW })]);
  assert.deepEqual([a.status, b.status].sort(), ['OK', 'SKIPPED']);
});
