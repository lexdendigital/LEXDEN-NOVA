const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PRODUCT_STATES, VERSION_STATES,
  assertProductTransition, assertVersionTransition,
  isVersionEditable, assertNoConcurrentVersion, assertProductNotBlocked,
  classifyEditRisk,
} = require('../api/creator/product-state-machine');

// ---- Product lifecycle ----

test('a new product may only start at DRAFT', () => {
  assert.doesNotThrow(() => assertProductTransition(null, PRODUCT_STATES.DRAFT));
  assert.throws(() => assertProductTransition(null, PRODUCT_STATES.SUBMITTED), /must start at/);
});

test('the full happy path to PUBLISHED is legal end to end', () => {
  assert.doesNotThrow(() => assertProductTransition(PRODUCT_STATES.DRAFT, PRODUCT_STATES.SUBMITTED));
  assert.doesNotThrow(() => assertProductTransition(PRODUCT_STATES.SUBMITTED, PRODUCT_STATES.IN_REVIEW));
  assert.doesNotThrow(() => assertProductTransition(PRODUCT_STATES.IN_REVIEW, PRODUCT_STATES.APPROVED));
  assert.doesNotThrow(() => assertProductTransition(PRODUCT_STATES.APPROVED, PRODUCT_STATES.PUBLISHED));
});

test('cannot skip straight from DRAFT to APPROVED', () => {
  assert.throws(() => assertProductTransition(PRODUCT_STATES.DRAFT, PRODUCT_STATES.APPROVED), /Cannot move/);
});

test('REJECTED and ARCHIVED are terminal for the product', () => {
  assert.throws(() => assertProductTransition(PRODUCT_STATES.REJECTED, PRODUCT_STATES.SUBMITTED), /Cannot move/);
  assert.throws(() => assertProductTransition(PRODUCT_STATES.ARCHIVED, PRODUCT_STATES.PUBLISHED), /Cannot move/);
});

test('PUBLISHED can be paused, suspended, or archived, and paused/suspended can return to PUBLISHED', () => {
  assert.doesNotThrow(() => assertProductTransition(PRODUCT_STATES.PUBLISHED, PRODUCT_STATES.PAUSED));
  assert.doesNotThrow(() => assertProductTransition(PRODUCT_STATES.PUBLISHED, PRODUCT_STATES.SUSPENDED));
  assert.doesNotThrow(() => assertProductTransition(PRODUCT_STATES.PUBLISHED, PRODUCT_STATES.ARCHIVED));
  assert.doesNotThrow(() => assertProductTransition(PRODUCT_STATES.PAUSED, PRODUCT_STATES.PUBLISHED));
  assert.doesNotThrow(() => assertProductTransition(PRODUCT_STATES.SUSPENDED, PRODUCT_STATES.PUBLISHED));
});

test('changes-requested loops back to submitted, not forward to review', () => {
  assert.doesNotThrow(() => assertProductTransition(PRODUCT_STATES.IN_REVIEW, PRODUCT_STATES.CHANGES_REQUESTED));
  assert.doesNotThrow(() => assertProductTransition(PRODUCT_STATES.CHANGES_REQUESTED, PRODUCT_STATES.SUBMITTED));
  assert.throws(() => assertProductTransition(PRODUCT_STATES.CHANGES_REQUESTED, PRODUCT_STATES.IN_REVIEW), /Cannot move/);
});

// ---- Version lifecycle ----

test('a new version may only start at DRAFT', () => {
  assert.doesNotThrow(() => assertVersionTransition(null, VERSION_STATES.DRAFT));
  assert.throws(() => assertVersionTransition(null, VERSION_STATES.PUBLISHED), /must start at/);
});

test('version happy path: DRAFT -> PENDING_REVIEW -> APPROVED -> PUBLISHED', () => {
  assert.doesNotThrow(() => assertVersionTransition(VERSION_STATES.DRAFT, VERSION_STATES.PENDING_REVIEW));
  assert.doesNotThrow(() => assertVersionTransition(VERSION_STATES.PENDING_REVIEW, VERSION_STATES.APPROVED));
  assert.doesNotThrow(() => assertVersionTransition(VERSION_STATES.APPROVED, VERSION_STATES.PUBLISHED));
});

test('a published version becomes SUPERSEDED, never reopened', () => {
  assert.doesNotThrow(() => assertVersionTransition(VERSION_STATES.PUBLISHED, VERSION_STATES.SUPERSEDED));
  assert.throws(() => assertVersionTransition(VERSION_STATES.SUPERSEDED, VERSION_STATES.PUBLISHED), /Cannot move/);
});

test('REJECTED version is terminal — a new edit is a new version, not a reopen', () => {
  assert.throws(() => assertVersionTransition(VERSION_STATES.REJECTED, VERSION_STATES.DRAFT), /Cannot move/);
  assert.throws(() => assertVersionTransition(VERSION_STATES.REJECTED, VERSION_STATES.PENDING_REVIEW), /Cannot move/);
});

test('isVersionEditable is true only for DRAFT', () => {
  assert.equal(isVersionEditable(VERSION_STATES.DRAFT), true);
  assert.equal(isVersionEditable(VERSION_STATES.PENDING_REVIEW), false);
  assert.equal(isVersionEditable(VERSION_STATES.PUBLISHED), false);
});

test('a concurrent edit is blocked while a version is PENDING_REVIEW or APPROVED', () => {
  assert.throws(() => assertNoConcurrentVersion(VERSION_STATES.PENDING_REVIEW), /already awaiting review/);
  assert.throws(() => assertNoConcurrentVersion(VERSION_STATES.APPROVED), /already awaiting review/);
  assert.doesNotThrow(() => assertNoConcurrentVersion(VERSION_STATES.PUBLISHED));
  assert.doesNotThrow(() => assertNoConcurrentVersion(VERSION_STATES.REJECTED));
  assert.doesNotThrow(() => assertNoConcurrentVersion(null));
});

test('a SUSPENDED or ARCHIVED product blocks further edits', () => {
  assert.throws(() => assertProductNotBlocked(PRODUCT_STATES.SUSPENDED), /PRODUCT_SUSPENDED|suspended/);
  assert.throws(() => assertProductNotBlocked(PRODUCT_STATES.ARCHIVED), /PRODUCT_ARCHIVED|archived/);
  assert.doesNotThrow(() => assertProductNotBlocked(PRODUCT_STATES.PUBLISHED));
  assert.doesNotThrow(() => assertProductNotBlocked(PRODUCT_STATES.DRAFT));
});

// ---- Edit-risk classification ----

test('an offeringType change is always high risk', () => {
  assert.equal(classifyEditRisk({ offeringType: 'EBOOK', price: 10 }, { offeringType: 'COURSE', price: 10 }), 'high');
});

test('swapping the deliverable file is high risk', () => {
  assert.equal(classifyEditRisk({ fileAssetId: 'a1' }, { fileAssetId: 'a2' }), 'high');
});

test('a >20% price change is high risk; a small change is not', () => {
  assert.equal(classifyEditRisk({ price: 100 }, { price: 130 }), 'high');
  assert.equal(classifyEditRisk({ price: 100 }, { price: 105 }), 'low');
});

test('a refund policy change is high risk', () => {
  assert.equal(classifyEditRisk({ refundPolicy: 'no refunds' }, { refundPolicy: 'full refund within 7 days' }), 'high');
});

test('description, primary image, or category change is medium risk', () => {
  assert.equal(classifyEditRisk({ description: 'old' }, { description: 'new' }), 'medium');
  assert.equal(classifyEditRisk({ images: ['a.jpg'] }, { images: ['b.jpg'] }), 'medium');
  assert.equal(classifyEditRisk({ category: 'apps' }, { category: 'software' }), 'medium');
});

test('a tags-only or no-op change is low risk', () => {
  assert.equal(classifyEditRisk({ title: 'Same', price: 100 }, { title: 'Same', price: 100 }), 'low');
});
