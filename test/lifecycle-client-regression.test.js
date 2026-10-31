const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const shopper = fs.readFileSync(path.join(__dirname, '..', 'js', 'shopper.js'), 'utf8');
const state = fs.readFileSync(path.join(__dirname, '..', 'js', 'state.js'), 'utf8');

test('client lifecycle code has no direct productViewEvents Firestore write', () => {
  assert.doesNotMatch(shopper, /collection\(fbDb,\s*["']productViewEvents["']\)/);
  assert.match(shopper, /\/api\/lifecycle-event/);
  assert.match(shopper, /getIdToken\(\)/);
});

test('checkout recovery logging stays non-blocking and does not delay Paystack setup', () => {
  const marker = "window.logLifecycleEvent && window.logLifecycleEvent('checkout_started'";
  const i = state.indexOf(marker);
  assert.ok(i >= 0);
  const beforePaystack = state.indexOf('PaystackPop.setup', i);
  assert.ok(beforePaystack > i);
  const fragment = state.slice(i, beforePaystack);
  assert.doesNotMatch(fragment, /await\s+window\.logLifecycleEvent/);
  assert.doesNotMatch(fragment, /amount\s*:/);
  assert.doesNotMatch(fragment, /checkoutUrl|productUrl/);
});

test('signup recovery is recorded only after successful OTP send and first success only', () => {
  const start = shopper.indexOf('async function sendSignupOtp()');
  const end = shopper.indexOf('async function verifySignupOtp()', start);
  const fn = shopper.slice(start, end);
  const failureGate = fn.indexOf('if(!result.ok)');
  const lifecycle = fn.indexOf("logLifecycleEvent('signup_started'");
  assert.ok(failureGate >= 0 && lifecycle > failureGate);
  assert.match(fn, /const firstSuccessfulOtpSend = !signupWizard\.otpSent/);
  assert.match(fn, /if\(firstSuccessfulOtpSend\)/);
});

test('product-view recovery requires current non-anonymous verified Firebase user on the client', () => {
  const start = shopper.indexOf('function logAffiliateProductView');
  const end = shopper.indexOf('// RELATED PRODUCTS', start);
  const fn = shopper.slice(start, end);
  assert.match(fn, /user\.isAnonymous/);
  assert.match(fn, /user\.emailVerified/);
  assert.match(fn, /logLifecycleEvent\('product_view'/);
});
