const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDb } = require('./helpers/fake-firestore');
const { createLifecycleHandler, EVENT_DELAYS } = require('../api/lifecycle-event');
const { runLifecycleEmails } = require('../api/lifecycle-worker');

const NOW = Date.parse('2026-10-31T08:00:00Z');
const DEFAULT_LIMITS = { uidHourly: 12, ipHourly: 60, recipientDaily: 3, duplicateDaily: 1 };

function catalogSeed() {
  return {
    catalog: {
      products: {
        list: [
          { id: 'p1', name: 'Tablet One', status: 'published', variants: [{ id: 'v1', name: '128 GB' }] },
          { id: 'p2', name: 'Tablet Two', status: 'published' },
        ],
      },
    },
  };
}
function auth(decodedOrError) {
  return {
    verifyIdToken: async () => {
      if (decodedOrError instanceof Error) throw decodedOrError;
      return decodedOrError;
    },
  };
}
function response() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  const res = {
    code: 200,
    setHeader() {},
    status(code) { this.code = code; return this; },
    json(body) { resolve({ status: this.code, body }); return this; },
  };
  return { res, promise };
}
async function call(handler, { body = {}, token = 'token', ip = '203.0.113.7', method = 'POST' } = {}) {
  const { res, promise } = response();
  const req = {
    method,
    body,
    ip,
    socket: { remoteAddress: '10.0.0.1' },
    headers: token ? { authorization: 'Bearer ' + token } : {},
  };
  await handler(req, res);
  return promise;
}
function handlerFor(db, decoded, opts = {}) {
  return createLifecycleHandler({
    getDb: () => db,
    getAuth: () => auth(decoded),
    now: () => opts.nowMs == null ? NOW : opts.nowMs,
    limits: opts.limits || DEFAULT_LIMITS,
  });
}
function event(overrides = {}) {
  return {
    schemaVersion: 1,
    source: 'lifecycle-event-api',
    uid: 'u1',
    email: 'buyer@example.com',
    recipientVerification: 'unverified',
    eventType: 'checkout_started',
    productId: 'p1',
    productName: 'Tablet One',
    productUrl: 'https://lexdendigital.github.io/LEXDEN-NOVA/index.html#product/p1',
    checkoutUrl: 'https://lexdendigital.github.io/LEXDEN-NOVA/index.html#product/p1',
    signupUrl: null,
    name: 'Buyer',
    variant: null,
    createdAt: new Date(NOW - 3 * 60 * 60 * 1000),
    nextAttemptAt: new Date(NOW - 1000),
    lifecycleState: 'pending',
    stage: 0,
    attempts: 0,
    lastProcessedAt: null,
    lastQueueMessageId: null,
    suppressionReason: null,
    ...overrides,
  };
}

test('intake: missing authorization token is rejected', async () => {
  const db = makeDb(catalogSeed());
  const r = await call(handlerFor(db, { uid: 'u1' }), { token: null, body: { eventType: 'checkout_started', email: 'a@example.com' } });
  assert.equal(r.status, 401);
  assert.equal(Object.keys(db._store.productViewEvents || {}).length, 0);
});

test('intake: invalid/expired Firebase token is rejected', async () => {
  const db = makeDb(catalogSeed());
  const e = Object.assign(new Error('Firebase ID token has expired'), { code: 'auth/id-token-expired' });
  const r = await call(createLifecycleHandler({ getDb: () => db, getAuth: () => auth(e), now: () => NOW, limits: DEFAULT_LIMITS }), {
    body: { eventType: 'checkout_started', email: 'a@example.com' },
  });
  assert.equal(r.status, 401);
});

test('intake: anonymous guest checkout is accepted and recipient stays unverified', async () => {
  const db = makeDb(catalogSeed());
  const decoded = { uid: 'anon1', firebase: { sign_in_provider: 'anonymous' }, email_verified: false };
  const r = await call(handlerFor(db, decoded), { body: { uid: 'forged', eventType: 'checkout_started', email: 'Guest@Example.com', productId: 'p1', variant: 'v1' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.recipientVerification, 'unverified');
  const saved = Object.values(db._store.productViewEvents)[0];
  assert.equal(saved.uid, 'anon1');
  assert.equal(saved.email, 'guest@example.com');
  assert.equal(saved.variant, '128 GB');
  assert.equal(saved.amount, undefined);
});

test('intake: matching verified token email is marked verified', async () => {
  const db = makeDb(catalogSeed());
  const decoded = { uid: 'u1', email: 'Buyer@Example.com', email_verified: true, firebase: { sign_in_provider: 'password' } };
  const r = await call(handlerFor(db, decoded), { body: { eventType: 'checkout_started', email: 'buyer@example.com', productId: 'p1' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.recipientVerification, 'verified');
});

test('intake: product view rejects anonymous users and derives verified token email', async () => {
  let db = makeDb(catalogSeed());
  let r = await call(handlerFor(db, { uid: 'anon1', firebase: { sign_in_provider: 'anonymous' } }), { body: { eventType: 'product_view', email: 'attacker@example.com', productId: 'p1' } });
  assert.equal(r.status, 403);

  db = makeDb(catalogSeed());
  const decoded = { uid: 'u2', email: 'owner@example.com', email_verified: true, firebase: { sign_in_provider: 'password' } };
  r = await call(handlerFor(db, decoded), { body: { eventType: 'product_view', email: 'attacker@example.com', productId: 'p1' } });
  assert.equal(r.status, 201);
  const saved = Object.values(db._store.productViewEvents)[0];
  assert.equal(saved.email, 'owner@example.com');
  assert.equal(saved.recipientVerification, 'verified');
});

test('intake: invalid email/type/product are rejected and client URLs/amount are ignored', async () => {
  const decoded = { uid: 'u1', firebase: { sign_in_provider: 'anonymous' } };
  let db = makeDb(catalogSeed());
  assert.equal((await call(handlerFor(db, decoded), { body: { eventType: 'checkout_started', email: 'bad' } })).status, 400);
  assert.equal((await call(handlerFor(db, decoded), { body: { eventType: 'made_up', email: 'a@example.com' } })).status, 400);
  assert.equal((await call(handlerFor(db, decoded), { body: { eventType: 'checkout_started', email: 'a@example.com', productId: '../oops' } })).status, 400);

  db = makeDb(catalogSeed());
  const r = await call(handlerFor(db, decoded), { body: {
    eventType: 'checkout_started', email: 'a@example.com', productId: 'p1',
    uid: 'victim', productUrl: 'https://evil.example/phish', checkoutUrl: 'https://evil.example/pay',
    amount: 'NGN 999999999', stage: 99, emailed: true,
  } });
  assert.equal(r.status, 201);
  const saved = Object.values(db._store.productViewEvents)[0];
  assert.equal(saved.uid, 'u1');
  assert.equal(saved.stage, 0);
  assert.equal(saved.emailed, undefined);
  assert.equal(saved.amount, undefined);
  assert.match(saved.productUrl, /lexdendigital\.github\.io/);
  assert.doesNotMatch(saved.productUrl, /evil/);
});

test('intake: name/control characters are normalized and bounded', async () => {
  const db = makeDb(catalogSeed());
  const decoded = { uid: 'u1', firebase: { sign_in_provider: 'anonymous' } };
  const r = await call(handlerFor(db, decoded), { body: { eventType: 'signup_started', email: 'a@example.com', name: '\u0000' + 'x'.repeat(180) } });
  assert.equal(r.status, 201);
  assert.equal(Object.values(db._store.productViewEvents)[0].name.length, 100);
});

test('intake: atomic UID limit cannot be bypassed by concurrent requests', async () => {
  const db = makeDb(catalogSeed());
  const decoded = { uid: 'u1', firebase: { sign_in_provider: 'anonymous' } };
  const h = handlerFor(db, decoded, { limits: { uidHourly: 1, ipHourly: 60, recipientDaily: 3, duplicateDaily: 1 } });
  const [a, b] = await Promise.all([
    call(h, { body: { eventType: 'signup_started', email: 'a@example.com' } }),
    call(h, { body: { eventType: 'signup_started', email: 'b@example.com' } }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [201, 429]);
  assert.equal(Object.keys(db._store.productViewEvents || {}).length, 1);
});

test('intake: exact retry is deterministic and creates only one event', async () => {
  const db = makeDb(catalogSeed());
  const decoded = { uid: 'u1', firebase: { sign_in_provider: 'anonymous' } };
  const h = handlerFor(db, decoded);
  const body = { eventType: 'checkout_started', email: 'a@example.com', productId: 'p1' };
  const first = await call(h, { body });
  const second = await call(h, { body });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.deduplicated, true);
  assert.equal(Object.keys(db._store.productViewEvents).length, 1);
});

test('intake: rate-limit storage failure fails closed', async () => {
  const db = makeDb(catalogSeed());
  db.runTransaction = async () => { throw new Error('firestore unavailable'); };
  const decoded = { uid: 'u1', firebase: { sign_in_provider: 'anonymous' } };
  const r = await call(handlerFor(db, decoded), { body: { eventType: 'signup_started', email: 'a@example.com' } });
  assert.equal(r.status, 503);
  assert.equal(Object.keys(db._store.productViewEvents || {}).length, 0);
});

test('worker: preserves product-view, checkout and signup due timings', async () => {
  assert.equal(EVENT_DELAYS.product_view, 60 * 60 * 1000);
  assert.equal(EVENT_DELAYS.checkout_started, 2 * 60 * 60 * 1000);
  assert.equal(EVENT_DELAYS.signup_started, 6 * 60 * 60 * 1000);

  const db = makeDb({
    productViewEvents: {
      pv: event({ eventType: 'product_view', recipientVerification: 'verified', nextAttemptAt: new Date(NOW - 1), productId: 'p1' }),
      co: event({ eventType: 'checkout_started', nextAttemptAt: new Date(NOW - 1), productId: 'p1' }),
      su: event({ eventType: 'signup_started', productId: null, productName: null, productUrl: null, checkoutUrl: null, signupUrl: 'https://lexdendigital.github.io/LEXDEN-NOVA/index.html#signup', nextAttemptAt: new Date(NOW - 1) }),
      future: event({ email: 'future@example.com', nextAttemptAt: new Date(NOW + 5000) }),
    },
  });
  const r = await runLifecycleEmails(db, { nowMs: NOW, deps: { accountExists: async () => false } });
  assert.equal(r.checked, 3);
  assert.equal(r.queued, 3);
  assert.equal(Object.keys(db._store.emailQueue).length, 3);
  assert.equal(db._store.productViewEvents.co.stage, 1);
  assert.equal(db._store.productViewEvents.co.nextAttemptAt, NOW + 22 * 60 * 60 * 1000);
  assert.equal(db._store.productViewEvents.future.stage, 0);
});

test('worker: completed purchase and existing account suppress stale recovery', async () => {
  const db = makeDb({
    productViewEvents: {
      co: event({ email: 'paid@example.com' }),
      su: event({ eventType: 'signup_started', email: 'exists@example.com', productId: null, productName: null, productUrl: null, checkoutUrl: null, signupUrl: 'https://lexdendigital.github.io/LEXDEN-NOVA/index.html#signup' }),
    },
    orders: { o1: { email: 'paid@example.com', productId: 'p1', status: 'paid' } },
  });
  const r = await runLifecycleEmails(db, { nowMs: NOW, deps: { accountExists: async (email) => email === 'exists@example.com' } });
  assert.equal(r.suppressed, 2);
  assert.equal(Object.keys(db._store.emailQueue || {}).length, 0);
  assert.equal(db._store.productViewEvents.co.suppressionReason, 'order_completed');
  assert.equal(db._store.productViewEvents.su.suppressionReason, 'account_created');
});

test('worker: legacy/untrusted events are not queried or sent; unknown trusted types are suppressed', async () => {
  const db = makeDb({
    productViewEvents: {
      legacy: { email: 'legacy@example.com', emailed: false, ts: new Date(NOW - 10 * 60 * 60 * 1000) },
      bad: event({ eventType: 'bogus' }),
    },
  });
  const r = await runLifecycleEmails(db, { nowMs: NOW, deps: { accountExists: async () => false } });
  assert.equal(r.checked, 1);
  assert.equal(r.queued, 0);
  assert.equal(r.ignored, 1);
  assert.equal(db._store.productViewEvents.legacy.emailed, false);
  assert.equal(db._store.productViewEvents.bad.suppressionReason, 'invalid_server_schema');
});

test('worker: repeated sweeps create one deterministic queue item per stage', async () => {
  const db = makeDb({ productViewEvents: { co: event() } });
  const a = await runLifecycleEmails(db, { nowMs: NOW, deps: { accountExists: async () => false } });
  const b = await runLifecycleEmails(db, { nowMs: NOW, deps: { accountExists: async () => false } });
  assert.equal(a.queued, 1);
  assert.equal(b.checked, 0);
  assert.equal(Object.keys(db._store.emailQueue).length, 1);
});
