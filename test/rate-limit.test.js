'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter } = require('../api/rate-limit');

function fakeResponse() {
  return {
    headers: {}, statusCode: 200, body: null,
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('rate limiter permits the configured allowance and then returns 429 with Retry-After', () => {
  const limit = createRateLimiter({ name: 'test', windowMs: 60000, max: 2 });
  const req = { method: 'POST', ip: '203.0.113.10' };
  let continued = 0;
  let res = fakeResponse();
  limit(req, res, () => continued++);
  res = fakeResponse();
  limit(req, res, () => continued++);
  assert.equal(continued, 2);
  res = fakeResponse();
  limit(req, res, () => continued++);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.code, 'RATE_LIMITED');
  assert.ok(Number(res.headers['Retry-After']) > 0);
  assert.equal(continued, 2);
});

test('preflight OPTIONS requests do not consume a rate-limit slot', () => {
  const limit = createRateLimiter({ name: 'preflight', windowMs: 60000, max: 1 });
  let continued = 0;
  for (let i = 0; i < 5; i++) limit({ method: 'OPTIONS', ip: '203.0.113.11' }, fakeResponse(), () => continued++);
  limit({ method: 'POST', ip: '203.0.113.11' }, fakeResponse(), () => continued++);
  assert.equal(continued, 6);
});
