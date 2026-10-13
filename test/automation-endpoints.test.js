const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDb } = require('./helpers/fake-firestore');
const { callHandler } = require('../mcp/lib/callHandler');

// Patch the shared module BEFORE the handlers load (they destructure at require time).
const shared = require('../api/creator/shared');
let DB = makeDb(); let WHO = { uid: 'u1', email: 'c@x.co' }; let ADMIN = { uid: 'admin1', email: 'a@x.co' }; let ADMIN_OK = true; let CREATOR_OK = true;
shared.getDb = () => DB;
shared.requireActiveCreator = async () => { if (!CREATOR_OK) throw Object.assign(new Error('no'), { status: 403, code: 'NOT_A_CREATOR' }); return { decoded: WHO, creator: { status: 'ACTIVE' } }; };
shared.requireAdminAuth = async () => { if (!ADMIN_OK) throw Object.assign(new Error('Not authorized.'), { status: 403 }); return ADMIN; };

const cron = require('../api/creator-cron');
const notifications = require('../api/creator-notifications');
const admin = require('../api/creator-admin-automation');

const call = (h, o) => callHandler(h, o);
const withAuth = (secret) => ({ extras: { headers: secret === undefined ? {} : { authorization: `Bearer ${secret}` } } });
// callHandler builds headers: {} then spreads extras over it, so extras.headers wins.

test('cron: fails CLOSED when CRON_SECRET is missing or short', async () => {
  delete process.env.CRON_SECRET;
  assert.equal((await call(cron, withAuth('anything'))).status, 503);
  process.env.CRON_SECRET = 'short';
  assert.equal((await call(cron, withAuth('short'))).status, 503);
});

test('cron: wrong / missing secret is 401 and runs nothing; right secret runs jobs', async () => {
  process.env.CRON_SECRET = 'x'.repeat(24);
  DB = makeDb();
  assert.equal((await call(cron, withAuth('nope'))).status, 401);
  assert.equal((await call(cron, withAuth(undefined))).status, 401);
  assert.equal(DB._store.automationRuns, undefined);
  const ok = await call(cron, { ...withAuth('x'.repeat(24)), query: { jobs: 'sla' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.results[0].job, 'sla');
  assert.equal(Object.keys(DB._store.automationRuns).length, 1);
  // also accepted via x-cron-secret header; second call is rate-limited by min interval
  const again = await call(cron, { extras: { headers: { 'x-cron-secret': 'x'.repeat(24) } }, query: { jobs: 'sla' } });
  assert.equal(again.body.data.results[0].status, 'SKIPPED');
});

test('cron: unknown job names are rejected; secret never appears in responses', async () => {
  process.env.CRON_SECRET = 'y'.repeat(24);
  DB = makeDb();
  const r = await call(cron, { ...withAuth('y'.repeat(24)), query: { jobs: 'sla,hack' } });
  assert.equal(r.status, 400);
  assert.ok(!JSON.stringify(r.body).includes('y'.repeat(24)));
  const bad = await call(cron, { method: 'DELETE', ...withAuth('y'.repeat(24)) });
  assert.equal(bad.status, 405);
});

test('notifications: a creator sees only their own, newest first, and can mark read only their own', async () => {
  DB = makeDb({ creatorNotifications: {
    n1: { creatorId: 'u1', title: 'old', read: false, createdAtMs: 1 },
    n2: { creatorId: 'u1', title: 'new', read: false, createdAtMs: 2 },
    n3: { creatorId: 'u2', title: 'other', read: false, createdAtMs: 3 },
  } });
  WHO = { uid: 'u1' };
  const list = await call(notifications, {});
  assert.deepEqual(list.body.data.notifications.map((n) => n.id), ['n2', 'n1']);
  assert.equal(list.body.data.unreadCount, 2);
  const steal = await call(notifications, { method: 'POST', body: { action: 'mark_read', ids: ['n3'] } });
  assert.equal(steal.body.data.marked, 0);
  assert.equal(DB._store.creatorNotifications.n3.read, false);
  const one = await call(notifications, { method: 'POST', body: { action: 'mark_read', ids: ['n1'] } });
  assert.equal(one.body.data.marked, 1);
  const all = await call(notifications, { method: 'POST', body: { action: 'mark_read' } });
  assert.equal(all.body.data.marked, 1);
  assert.equal(DB._store.creatorNotifications.n3.read, false);
  assert.equal((await call(notifications, { query: { unread: '1' } })).body.data.notifications.length, 0);
  assert.equal((await call(notifications, { method: 'POST', body: { action: 'x' } })).status, 400);
  assert.equal((await call(notifications, { method: 'POST', body: { action: 'mark_read', ids: ['a/b'] } })).status, 422);
  CREATOR_OK = false;
  assert.equal((await call(notifications, {})).status, 403);
  CREATOR_OK = true;
});

test('admin automation: non-admins are refused', async () => {
  ADMIN_OK = false;
  assert.equal((await call(admin, { query: { view: 'alerts' } })).status, 403);
  assert.equal((await call(admin, { method: 'POST', body: { action: 'set_auto_restrict', enabled: true } })).status, 403);
  ADMIN_OK = true;
});

test('admin automation: auto-restrict defaults OFF, switches only with a boolean, and is audited', async () => {
  DB = makeDb();
  assert.equal((await call(admin, { query: { view: 'settings' } })).body.data.autoRestrictSla, false);
  assert.equal((await call(admin, { method: 'POST', body: { action: 'set_auto_restrict', enabled: 'yes' } })).status, 422);
  const on = await call(admin, { method: 'POST', body: { action: 'set_auto_restrict', enabled: true } });
  assert.equal(on.body.data.autoRestrictSla, true);
  assert.equal(DB._store.automationSettings.config.autoRestrictSla, true);
  assert.equal((await call(admin, { query: { view: 'settings' } })).body.data.autoRestrictSla, true);
  assert.ok(Object.values(DB._store.creatorAuditLog).some((a) => a.action === 'automation.auto_restrict_on' && a.actorUid === 'admin1'));
});

test('admin automation: alerts list/resolve, run_job (force) and validation', async () => {
  DB = makeDb({ adminAlerts: { a1: { key: 'k', status: 'open', lastSeenAtMs: 5, title: 't' }, a2: { key: 'j', status: 'resolved', lastSeenAtMs: 9, title: 'u' } } });
  const open = await call(admin, { query: { view: 'alerts', status: 'open' } });
  assert.deepEqual(open.body.data.alerts.map((a) => a.id), ['a1']);
  const r = await call(admin, { method: 'POST', body: { action: 'resolve_alert', alertId: 'a1', note: 'done' } });
  assert.equal(r.body.data.status, 'resolved');
  assert.equal(DB._store.adminAlerts.a1.resolvedBy, 'admin1');
  assert.equal((await call(admin, { method: 'POST', body: { action: 'resolve_alert', alertId: 'zzz' } })).status, 404);
  assert.equal((await call(admin, { method: 'POST', body: { action: 'resolve_alert', alertId: 'a/b' } })).status, 422);
  const run = await call(admin, { method: 'POST', body: { action: 'run_job', job: 'sla' } });
  assert.equal(run.body.data.status, 'OK');
  const run2 = await call(admin, { method: 'POST', body: { action: 'run_job', job: 'sla' } });
  assert.equal(run2.body.data.status, 'OK'); // force skips min-interval
  assert.equal((await call(admin, { method: 'POST', body: { action: 'run_job', job: 'nope' } })).status, 422);
  assert.equal((await call(admin, { query: { view: 'runs' } })).body.data.runs.length, 2);
  assert.equal((await call(admin, { method: 'POST', body: { action: 'wat' } })).status, 400);
});

test('lift_pause: needs a reason + target; only lifts what automation paused; never a creator\'s own pause', async () => {
  DB = makeDb({ products: {
    pa: { creatorId: 'u1', status: 'PAUSED', pausedBySla: true, pauseReason: 'x' },
    pb: { creatorId: 'u1', status: 'PAUSED' },                 // creator paused it themselves
    pc: { creatorId: 'u2', status: 'PAUSED', pausedBySla: true },
  } });
  assert.equal((await call(admin, { method: 'POST', body: { action: 'lift_pause', scope: 'sla', creatorId: 'u1' } })).status, 422);
  assert.equal((await call(admin, { method: 'POST', body: { action: 'lift_pause', scope: 'sla', reason: 'ok' } })).status, 422);
  assert.equal((await call(admin, { method: 'POST', body: { action: 'lift_pause', scope: 'bogus', creatorId: 'u1', reason: 'ok' } })).status, 422);
  const r = await call(admin, { method: 'POST', body: { action: 'lift_pause', scope: 'sla', creatorId: 'u1', reason: 'Reviewed, seller recovered' } });
  assert.equal(r.body.data.lifted, 1);
  assert.equal(DB._store.products.pa.status, 'PUBLISHED'); assert.equal(DB._store.products.pa.pausedBySla, false);
  assert.equal(DB._store.products.pb.status, 'PAUSED');
  assert.equal(DB._store.products.pc.status, 'PAUSED');
  assert.ok(Object.values(DB._store.productAuditLog).some((a) => a.action === 'product.lift_auto_pause_sla' && a.actorRole === 'admin'));
});

test('lift_pause (link): re-checks the link first and refuses while it is still broken', async () => {
  DB = makeDb({ products: { pl: { creatorId: 'u1', status: 'PAUSED', pausedByLink: true, publishedSnapshot: { externalUrl: 'http://127.0.0.1/x' } } } });
  const r = await call(admin, { method: 'POST', body: { action: 'lift_pause', scope: 'link', productId: 'pl', reason: 'try' } });
  assert.equal(r.body.data.lifted, 0);
  assert.equal(r.body.data.blocked.length, 1);
  assert.equal(DB._store.products.pl.status, 'PAUSED');
});
