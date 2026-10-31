const test = require('node:test');
const assert = require('node:assert/strict');

const sharedPath = require.resolve('../api/affiliate/shared');
const runnerPath = require.resolve('../api/automation/runner');
const queueRoutePath = require.resolve('../api/process-email-queue');
const lifecycleRoutePath = require.resolve('../api/process-abandon-emails');

let runs = [];
require.cache[sharedPath] = {
  id: sharedPath, filename: sharedPath, loaded: true,
  exports: { getDb: () => ({ fake: true }) },
};
require.cache[runnerPath] = {
  id: runnerPath, filename: runnerPath, loaded: true,
  exports: {
    runJob: async (_db, name) => { runs.push(name); return { job: name, status: 'OK' }; },
  },
};
delete require.cache[queueRoutePath];
delete require.cache[lifecycleRoutePath];
const queueRoute = require('../api/process-email-queue');
const lifecycleRoute = require('../api/process-abandon-emails');

function response() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  const res = {
    code: 200,
    headers: {},
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    status(code) { this.code = code; return this; },
    json(body) { resolve({ status: this.code, body }); return this; },
  };
  return { res, promise };
}
async function call(route, { method = 'GET', secret, header, query = {} } = {}) {
  const { res, promise } = response();
  const headers = {};
  if (secret) headers.authorization = 'Bearer ' + secret;
  if (header) headers['x-cron-secret'] = header;
  await route({ method, headers, query, body: {} }, res);
  return promise;
}
async function exerciseRoute(route, jobName) {
  const old = process.env.CRON_SECRET;
  runs = [];
  delete process.env.CRON_SECRET;
  let r = await call(route);
  assert.equal(r.status, 503);
  assert.equal(runs.length, 0);

  const secret = 'cron-secret-'.padEnd(32, 'x');
  process.env.CRON_SECRET = secret;

  r = await call(route);
  assert.equal(r.status, 401);
  assert.equal(runs.length, 0);

  r = await call(route, { secret: 'wrong-secret-value' });
  assert.equal(r.status, 401);
  assert.equal(runs.length, 0);

  r = await call(route, { query: { secret } });
  assert.equal(r.status, 401);
  assert.equal(runs.length, 0);

  r = await call(route, { secret });
  assert.equal(r.status, 200);
  assert.deepEqual(runs, [jobName]);

  runs = [];
  r = await call(route, { header: secret, method: 'POST' });
  assert.equal(r.status, 200);
  assert.deepEqual(runs, [jobName]);

  runs = [];
  r = await call(route, { secret, method: 'DELETE' });
  assert.equal(r.status, 405);
  assert.equal(runs.length, 0);
  assert.doesNotMatch(JSON.stringify(r.body), new RegExp(secret));

  if (old === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = old;
}

test('process-email-queue route requires CRON_SECRET and invokes only the shared queue job', async () => {
  await exerciseRoute(queueRoute, 'emailQueue');
});

test('process-abandon-emails route requires CRON_SECRET and invokes only the shared lifecycle job', async () => {
  await exerciseRoute(lifecycleRoute, 'lifecycleEmails');
});
