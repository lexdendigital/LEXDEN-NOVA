const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDb } = require('./helpers/fake-firestore');
const { processEmailQueue, LEASE_MS } = require('../api/email-queue-worker');
const { authorizeCronRequest } = require('../api/cron-auth');
const { runJob } = require('../api/automation/runner');

const NOW = 1800000000000;

function resCapture() {
  const out = { statusCode: 200, body: null, headers: {} };
  out.res = {
    setHeader(k, v) { out.headers[k.toLowerCase()] = v; },
    status(code) { out.statusCode = code; return this; },
    json(body) { out.body = body; return this; },
  };
  return out;
}
function cronReq({ method = 'GET', bearer, header, query } = {}) {
  const headers = {};
  if (bearer) headers.authorization = 'Bearer ' + bearer;
  if (header) headers['x-cron-secret'] = header;
  return { method, headers, query: query || {} };
}

test('cron auth: missing server secret fails closed with 503', () => {
  const before = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  const r = resCapture();
  assert.equal(authorizeCronRequest(cronReq(), r.res), false);
  assert.equal(r.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(r.body), /undefined|secret-value/);
  if (before !== undefined) process.env.CRON_SECRET = before;
});

test('cron auth: wrong/missing/query-string secrets are rejected; Bearer and x-cron-secret work', () => {
  const old = process.env.CRON_SECRET;
  const secret = 's'.repeat(32);
  process.env.CRON_SECRET = secret;

  let r = resCapture();
  assert.equal(authorizeCronRequest(cronReq(), r.res), false);
  assert.equal(r.statusCode, 401);

  r = resCapture();
  assert.equal(authorizeCronRequest(cronReq({ bearer: 'wrong' }), r.res), false);
  assert.equal(r.statusCode, 401);

  r = resCapture();
  assert.equal(authorizeCronRequest(cronReq({ query: { secret } }), r.res), false);
  assert.equal(r.statusCode, 401);

  r = resCapture();
  assert.equal(authorizeCronRequest(cronReq({ bearer: secret }), r.res), true);

  r = resCapture();
  assert.equal(authorizeCronRequest(cronReq({ header: secret }), r.res), true);

  r = resCapture();
  assert.equal(authorizeCronRequest(cronReq({ method: 'DELETE', bearer: secret }), r.res), false);
  assert.equal(r.statusCode, 405);

  if (old === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = old;
});

test('queue: successful worker sends once and marks sent only after provider success', async () => {
  const db = makeDb({ emailQueue: { q1: { status: 'pending', attempts: 1, nextAttemptAt: NOW - 1, payload: { templateKey: 'order', to: { email: 'a@example.com' } } } } });
  let sends = 0;
  const r = await processEmailQueue(db, { now: () => NOW, sendEmailFast: async () => { sends++; return { ok: true, messageId: 'm1' }; } });
  assert.equal(sends, 1);
  assert.equal(r.sent, 1);
  assert.equal(db._store.emailQueue.q1.status, 'sent');
});

test('queue: provider failure preserves retry and does not mark sent', async () => {
  const db = makeDb({ emailQueue: { q1: { status: 'pending', attempts: 1, nextAttemptAt: NOW - 1, payload: { templateKey: 'order', to: { email: 'a@example.com' } } } } });
  const r = await processEmailQueue(db, { now: () => NOW, sendEmailFast: async () => ({ ok: false, error: 'Brevo down' }) });
  assert.equal(r.retrying, 1);
  assert.equal(db._store.emailQueue.q1.status, 'pending');
  assert.equal(db._store.emailQueue.q1.attempts, 2);
  assert.ok(db._store.emailQueue.q1.nextAttemptAt > NOW);
});

test('queue: concurrent drains cannot send the same item concurrently', async () => {
  const db = makeDb({ emailQueue: { q1: { status: 'pending', attempts: 1, nextAttemptAt: NOW - 1, payload: { templateKey: 'order', to: { email: 'a@example.com' } } } } });
  let sends = 0;
  const send = async () => { sends++; await new Promise((r) => setTimeout(r, 5)); return { ok: true }; };
  await Promise.all([
    processEmailQueue(db, { now: () => NOW, sendEmailFast: send }),
    processEmailQueue(db, { now: () => NOW, sendEmailFast: send }),
  ]);
  assert.equal(sends, 1);
  assert.equal(db._store.emailQueue.q1.status, 'sent');
});

test('queue: expired worker lease is recoverable', async () => {
  const db = makeDb({ emailQueue: { q1: {
    status: 'processing', attempts: 2, nextAttemptAt: NOW - 10000,
    leaseUntil: NOW - 1, leaseToken: 'dead-worker',
    payload: { templateKey: 'order', to: { email: 'a@example.com' } },
  } } });
  const r = await processEmailQueue(db, { now: () => NOW, sendEmailFast: async () => ({ ok: true }) });
  assert.equal(r.sent, 1);
  assert.equal(db._store.emailQueue.q1.status, 'sent');
});

test('queue: fresh lease is not stolen', async () => {
  const db = makeDb({ emailQueue: { q1: {
    status: 'processing', attempts: 2, nextAttemptAt: NOW - 10000,
    leaseUntil: NOW + LEASE_MS, leaseToken: 'live-worker',
    payload: { templateKey: 'order', to: { email: 'a@example.com' } },
  } } });
  let sends = 0;
  const r = await processEmailQueue(db, { now: () => NOW, sendEmailFast: async () => { sends++; return { ok: true }; } });
  assert.equal(r.checked, 0);
  assert.equal(sends, 0);
});

test('queue: lifecycle suppression is checked immediately before send', async () => {
  const db = makeDb({
    emailQueue: { q1: {
      status: 'pending', attempts: 1, nextAttemptAt: NOW - 1,
      lifecycleEventId: 'e1', lifecycleStage: 0,
      payload: { templateKey: 'checkout_recovery_1', to: { email: 'buyer@example.com' } },
    } },
    productViewEvents: { e1: { source: 'lifecycle-event-api' } },
  });
  let sends = 0;
  const r = await processEmailQueue(db, {
    now: () => NOW,
    sendEmailFast: async () => { sends++; return { ok: true }; },
    deps: { lifecycleWorker: { suppressionReasonForEvent: async () => 'order_completed' } },
  });
  assert.equal(sends, 0);
  assert.equal(r.cancelled, 1);
  assert.equal(db._store.emailQueue.q1.status, 'cancelled');
  assert.equal(db._store.emailQueue.q1.cancellationReason, 'order_completed');
});

test('queue: unrelated transactional mail is not lifecycle-suppressed', async () => {
  const db = makeDb({ emailQueue: { q1: { status: 'pending', attempts: 1, nextAttemptAt: NOW - 1, payload: { templateKey: 'security', to: { email: 'a@example.com' } } } } });
  let sends = 0;
  await processEmailQueue(db, {
    now: () => NOW,
    sendEmailFast: async () => { sends++; return { ok: true }; },
    deps: { lifecycleWorker: { suppressionReasonForEvent: async () => { throw new Error('must not run'); } } },
  });
  assert.equal(sends, 1);
  assert.equal(db._store.emailQueue.q1.status, 'sent');
});

test('automation: lifecycle job shares runner lock so simultaneous triggers run once', async () => {
  const db = makeDb();
  let runs = 0;
  const processor = async () => { runs++; await new Promise((r) => setTimeout(r, 5)); return { ok: true }; };
  const [a, b] = await Promise.all([
    runJob(db, 'lifecycleEmails', { now: () => NOW, deps: { lifecycleEmailProcessor: processor } }),
    runJob(db, 'lifecycleEmails', { now: () => NOW, deps: { lifecycleEmailProcessor: processor } }),
  ]);
  assert.equal(runs, 1);
  assert.deepEqual([a.status, b.status].sort(), ['OK', 'SKIPPED']);
});
