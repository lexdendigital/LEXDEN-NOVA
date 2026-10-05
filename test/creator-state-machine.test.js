const test = require('node:test');
const assert = require('node:assert/strict');
const {
  APPLICATION_STATES, SELLER_STATES,
  assertApplicationTransition, assertSellerTransition,
  assertNoDuplicateApplication, assertSellerNotBlocked,
  isSellerActionable,
} = require('../api/creator/state-machine');

// ---- Application lifecycle ----

test('a new application may only start at APPLICATION_DRAFT', () => {
  assert.doesNotThrow(() => assertApplicationTransition(null, APPLICATION_STATES.APPLICATION_DRAFT));
  assert.throws(() => assertApplicationTransition(null, APPLICATION_STATES.SUBMITTED), /must start at/);
  assert.throws(() => assertApplicationTransition(null, APPLICATION_STATES.APPROVED), /must start at/);
});

test('the full happy path is legal end to end', () => {
  assert.doesNotThrow(() => assertApplicationTransition(APPLICATION_STATES.APPLICATION_DRAFT, APPLICATION_STATES.SUBMITTED));
  assert.doesNotThrow(() => assertApplicationTransition(APPLICATION_STATES.SUBMITTED, APPLICATION_STATES.IN_REVIEW));
  assert.doesNotThrow(() => assertApplicationTransition(APPLICATION_STATES.IN_REVIEW, APPLICATION_STATES.APPROVED));
});

test('changes-requested loops back to submitted, not forward', () => {
  assert.doesNotThrow(() => assertApplicationTransition(APPLICATION_STATES.IN_REVIEW, APPLICATION_STATES.CHANGES_REQUESTED));
  assert.doesNotThrow(() => assertApplicationTransition(APPLICATION_STATES.CHANGES_REQUESTED, APPLICATION_STATES.SUBMITTED));
  assert.throws(() => assertApplicationTransition(APPLICATION_STATES.CHANGES_REQUESTED, APPLICATION_STATES.APPROVED), /Cannot move/);
});

test('cannot skip straight from draft to approved', () => {
  assert.throws(() => assertApplicationTransition(APPLICATION_STATES.APPLICATION_DRAFT, APPLICATION_STATES.APPROVED), /Cannot move/);
});

test('cannot re-review a decided application (REJECTED/APPROVED are terminal)', () => {
  assert.throws(() => assertApplicationTransition(APPLICATION_STATES.REJECTED, APPLICATION_STATES.IN_REVIEW), /Cannot move/);
  assert.throws(() => assertApplicationTransition(APPLICATION_STATES.APPROVED, APPLICATION_STATES.IN_REVIEW), /Cannot move/);
});

test('cannot submit directly into review, skipping SUBMITTED', () => {
  assert.throws(() => assertApplicationTransition(APPLICATION_STATES.APPLICATION_DRAFT, APPLICATION_STATES.IN_REVIEW), /Cannot move/);
});

test('an unknown source state is rejected rather than silently allowed', () => {
  assert.throws(() => assertApplicationTransition('MADE_UP_STATE', APPLICATION_STATES.SUBMITTED), /Unknown application state/);
});

// ---- Duplicate-application guard ----

test('no existing application (NOT_APPLIED) allows starting one', () => {
  assert.doesNotThrow(() => assertNoDuplicateApplication(null));
  assert.doesNotThrow(() => assertNoDuplicateApplication(undefined));
});

test('a REJECTED application allows a fresh attempt', () => {
  assert.doesNotThrow(() => assertNoDuplicateApplication(APPLICATION_STATES.REJECTED));
});

test('every other existing status blocks a second application', () => {
  for (const s of [APPLICATION_STATES.APPLICATION_DRAFT, APPLICATION_STATES.SUBMITTED, APPLICATION_STATES.IN_REVIEW, APPLICATION_STATES.CHANGES_REQUESTED, APPLICATION_STATES.APPROVED]) {
    assert.throws(() => assertNoDuplicateApplication(s), /already exists/, `expected ${s} to block a duplicate`);
  }
});

// ---- Seller lifecycle ----

test('active seller can be suspended, restricted, or revoked', () => {
  assert.doesNotThrow(() => assertSellerTransition(SELLER_STATES.ACTIVE, SELLER_STATES.SUSPENDED));
  assert.doesNotThrow(() => assertSellerTransition(SELLER_STATES.ACTIVE, SELLER_STATES.RESTRICTED));
  assert.doesNotThrow(() => assertSellerTransition(SELLER_STATES.ACTIVE, SELLER_STATES.REVOKED));
});

test('suspended/restricted sellers can be reactivated, but revoked cannot', () => {
  assert.doesNotThrow(() => assertSellerTransition(SELLER_STATES.SUSPENDED, SELLER_STATES.ACTIVE));
  assert.doesNotThrow(() => assertSellerTransition(SELLER_STATES.RESTRICTED, SELLER_STATES.ACTIVE));
  assert.throws(() => assertSellerTransition(SELLER_STATES.REVOKED, SELLER_STATES.ACTIVE), /Cannot move/);
});

test('"suspended creator blocked" — the actual action-gate guard', () => {
  assert.throws(() => assertSellerNotBlocked(SELLER_STATES.SUSPENDED), /CREATOR_SUSPENDED|suspended/);
  assert.throws(() => assertSellerNotBlocked(SELLER_STATES.REVOKED), /CREATOR_REVOKED|revoked/);
  assert.doesNotThrow(() => assertSellerNotBlocked(SELLER_STATES.ACTIVE));
  assert.doesNotThrow(() => assertSellerNotBlocked(SELLER_STATES.RESTRICTED)); // restricted ≠ blocked outright
});

test('isSellerActionable is true only for ACTIVE', () => {
  assert.equal(isSellerActionable(SELLER_STATES.ACTIVE), true);
  assert.equal(isSellerActionable(SELLER_STATES.RESTRICTED), false);
  assert.equal(isSellerActionable(SELLER_STATES.SUSPENDED), false);
  assert.equal(isSellerActionable(SELLER_STATES.REVOKED), false);
});
