'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter, isAllowedOrigin, cronAuthorized, securityHeaders } = require('../server-security');

function run(limiter, path, ip, method) {
  const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let passed = false;
  limiter({ path, ip, method: method || 'POST' }, res, () => { passed = true; });
  return { passed, res };
}

test('rate limiter blocks the Nth+1 call per IP on listed paths only', () => {
  let t = 0;
  const limiter = createRateLimiter({ '/api/send-otp': { max: 2, windowMs: 1000 } }, () => t);
  assert.ok(run(limiter, '/api/send-otp', '1.1.1.1').passed);
  assert.ok(run(limiter, '/api/send-otp', '1.1.1.1').passed);
  const blocked = run(limiter, '/api/send-otp', '1.1.1.1');
  assert.equal(blocked.passed, false);
  assert.equal(blocked.res.statusCode, 429);
  assert.ok(blocked.res.headers['Retry-After']);
  assert.ok(run(limiter, '/api/send-otp', '2.2.2.2').passed);
  assert.ok(run(limiter, '/api/verify-paystack', '1.1.1.1').passed);
  assert.ok(run(limiter, '/api/send-otp', '1.1.1.1', 'OPTIONS').passed);
  t = 1500;
  assert.ok(run(limiter, '/api/send-otp', '1.1.1.1').passed);
});

test('payments and webhooks are never rate limited by default', () => {
  const { DEFAULT_LIMITS } = require('../server-security');
  for (const p of ['/api/verify-paystack', '/api/paystack-webhook', '/api/cj-webhook']) assert.equal(DEFAULT_LIMITS[p], undefined);
});

test('CORS: own origin, onrender and localhost allowed; other github.io sites are not', () => {
  const list = ['https://lexdendigital.github.io'];
  assert.ok(isAllowedOrigin('https://lexdendigital.github.io', list));
  assert.ok(isAllowedOrigin(undefined, list));
  assert.ok(isAllowedOrigin('https://lexden-nova.onrender.com', list));
  assert.ok(isAllowedOrigin('http://localhost:3000', list));
  assert.equal(isAllowedOrigin('https://attacker.github.io', list), false);
  assert.equal(isAllowedOrigin('not a url', list), false);
});

test('cron secret: bearer or header, 16+ chars, constant-time compare', () => {
  const secret = 'a'.repeat(20);
  assert.ok(cronAuthorized({ headers: { authorization: 'Bearer ' + secret } }, secret));
  assert.ok(cronAuthorized({ headers: { 'x-cron-secret': secret } }, secret));
  assert.equal(cronAuthorized({ headers: { 'x-cron-secret': 'wrong' } }, secret), false);
  assert.equal(cronAuthorized({ headers: {} }, secret), false);
  assert.equal(cronAuthorized({ headers: { 'x-cron-secret': 'short' } }, 'short'), false);
});

test('security headers are set', () => {
  const set = {}; securityHeaders({}, { setHeader: (k, v) => { set[k] = v; }, removeHeader() {} }, () => {});
  assert.equal(set['X-Content-Type-Options'], 'nosniff');
  assert.equal(set['X-Frame-Options'], 'DENY');
});
