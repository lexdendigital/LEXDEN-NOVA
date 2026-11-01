'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isDueForReviewRequest, REVIEW_REQUEST_WAIT_MS, toMs } = require('../api/affiliate/review-requests');
const { PAID_STATUSES } = require('../api/affiliate/mark-verified-reviews');

test('review request waits the full 7 days after a paid order, and never fires for an unpaid one', () => {
  const now = Date.now();
  const paidSixDaysAgo = { status: 'paid', email: 'a@b.com', productId: 'p1', timestamp: { toMillis: () => now - 6 * 24 * 60 * 60 * 1000 } };
  const paidEightDaysAgo = { status: 'paid', email: 'a@b.com', productId: 'p1', timestamp: { toMillis: () => now - 8 * 24 * 60 * 60 * 1000 } };
  const unpaid = { status: 'pending', email: 'a@b.com', productId: 'p1', timestamp: { toMillis: () => now - 8 * 24 * 60 * 60 * 1000 } };
  const noEmail = { status: 'paid', productId: 'p1', timestamp: { toMillis: () => now - 8 * 24 * 60 * 60 * 1000 } };
  assert.equal(isDueForReviewRequest(paidSixDaysAgo, now), false);
  assert.equal(isDueForReviewRequest(paidEightDaysAgo, now), true);
  assert.equal(isDueForReviewRequest(unpaid, now), false);
  assert.equal(isDueForReviewRequest(noEmail, now), false);
  assert.equal(REVIEW_REQUEST_WAIT_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(toMs(null), 0);
  assert.equal(toMs(new Date(now)), now);
});

test('a review is only verified against an order that is actually paid', () => {
  assert.ok(PAID_STATUSES.has('paid'));
  assert.ok(PAID_STATUSES.has('success'));
  assert.equal(PAID_STATUSES.has('pending'), false);
  assert.equal(PAID_STATUSES.has('failed'), false);
});

test('Firestore Rules never let a shopper set verifiedPurchase on their own review', () => {
  const rules = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
  const match = rules.match(/match \/reviews\/\{reviewId\} \{[\s\S]*?\n    \}/);
  assert.ok(match, 'reviews match block should exist');
  assert.match(match[0], /!\('verifiedPurchase' in request\.resource\.data\)/);
  assert.match(match[0], /allow update: if isAdmin\(\);/);
});

test('both sweeps are registered and guarded by CRON_SECRET like the existing abandon-email sweep', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /'mark-verified-reviews': '\.\/api\/affiliate\/mark-verified-reviews'/);
  assert.match(server, /'review-requests': '\.\/api\/affiliate\/review-requests'/);
  assert.match(server, /GUARDED_SWEEPS = new Set\(\['process-abandon-emails', 'mark-verified-reviews', 'review-requests'\]\)/);
  assert.match(server, /sweep\('\/api\/mark-verified-reviews'\);/);
  assert.match(server, /sweep\('\/api\/review-requests'\);/);
});

test('a product page review shows a Verified Purchase badge only when the sweep set the flag', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'js', 'shopper.js'), 'utf8');
  assert.match(html, /r\.verifiedPurchase\?`<span class="chip"[^`]*Verified Purchase<\/span>`:''/);
});

test('review_request has a Brevo template slot alongside the other transactional emails', () => {
  const health = fs.readFileSync(path.join(__dirname, '..', 'api', 'email-health.js'), 'utf8');
  assert.match(health, /'review_request'/);
});
