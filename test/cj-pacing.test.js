'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { paceCall } = require('../api/cj-shared');

// A free CJ account allows 1 request/second. Calls fired together must queue
// up about 1.1s apart instead of all leaving at once (which got every call
// after the first rejected with "rate limit reached").
test('paceCall spaces simultaneous CJ calls at least ~1s apart', async () => {
  const stamps = [];
  await Promise.all([1, 2, 3].map(() => paceCall().then(() => stamps.push(Date.now()))));
  assert.equal(stamps.length, 3);
  assert.ok(stamps[1] - stamps[0] >= 1000, `gap 1 was ${stamps[1] - stamps[0]}ms`);
  assert.ok(stamps[2] - stamps[1] >= 1000, `gap 2 was ${stamps[2] - stamps[1]}ms`);
});
