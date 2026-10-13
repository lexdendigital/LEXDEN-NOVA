const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FULFILLMENT_STATES,
  assertFulfillmentTransition, assertActorMayTransition,
  assertShippedRequiresTracking, assertReasonRequired,
} = require('../api/creator/fulfillment-state-machine');

const S = FULFILLMENT_STATES;

test('a new fulfillment may only start at PENDING', () => {
  assert.doesNotThrow(() => assertFulfillmentTransition(null, S.PENDING));
  assert.throws(() => assertFulfillmentTransition(null, S.PACKED), { code: 'INVALID_INITIAL_STATE' });
});

test('the full happy path is legal: PENDING -> PACKED -> SHIPPED -> DELIVERED', () => {
  assert.doesNotThrow(() => assertFulfillmentTransition(S.PENDING, S.PACKED));
  assert.doesNotThrow(() => assertFulfillmentTransition(S.PACKED, S.SHIPPED));
  assert.doesNotThrow(() => assertFulfillmentTransition(S.SHIPPED, S.DELIVERED));
});

test('SHIPPED may also go to RETURNED', () => {
  assert.doesNotThrow(() => assertFulfillmentTransition(S.SHIPPED, S.RETURNED));
});

test('PENDING and PACKED may be cancelled, SHIPPED may not', () => {
  assert.doesNotThrow(() => assertFulfillmentTransition(S.PENDING, S.CANCELLED));
  assert.doesNotThrow(() => assertFulfillmentTransition(S.PACKED, S.CANCELLED));
  assert.throws(() => assertFulfillmentTransition(S.SHIPPED, S.CANCELLED), { code: 'INVALID_TRANSITION' });
});

test('DELIVERED, RETURNED, CANCELLED are terminal', () => {
  for (const terminal of [S.DELIVERED, S.RETURNED, S.CANCELLED]) {
    for (const target of Object.values(S)) {
      if (target === terminal) continue;
      assert.throws(() => assertFulfillmentTransition(terminal, target), { code: 'INVALID_TRANSITION' }, `${terminal} -> ${target}`);
    }
  }
});

test('states cannot be skipped', () => {
  assert.throws(() => assertFulfillmentTransition(S.PENDING, S.SHIPPED), { code: 'INVALID_TRANSITION' });
  assert.throws(() => assertFulfillmentTransition(S.PENDING, S.DELIVERED), { code: 'INVALID_TRANSITION' });
});

test('an unknown source state is rejected', () => {
  assert.throws(() => assertFulfillmentTransition('NOPE', S.PACKED), { code: 'UNKNOWN_STATE' });
});

test('a creator may mark packed, shipped, cancelled but not delivered or returned', () => {
  for (const to of [S.PACKED, S.SHIPPED, S.CANCELLED]) assert.doesNotThrow(() => assertActorMayTransition('creator', to));
  for (const to of [S.DELIVERED, S.RETURNED]) assert.throws(() => assertActorMayTransition('creator', to), { code: 'ACTOR_NOT_ALLOWED' });
});

test('a buyer may only mark delivered', () => {
  assert.doesNotThrow(() => assertActorMayTransition('buyer', S.DELIVERED));
  for (const to of [S.PACKED, S.SHIPPED, S.RETURNED, S.CANCELLED]) assert.throws(() => assertActorMayTransition('buyer', to), { code: 'ACTOR_NOT_ALLOWED' });
});

test('only an admin may mark returned; admin may do everything', () => {
  assert.throws(() => assertActorMayTransition('creator', S.RETURNED), { code: 'ACTOR_NOT_ALLOWED' });
  for (const to of [S.PACKED, S.SHIPPED, S.DELIVERED, S.RETURNED, S.CANCELLED]) assert.doesNotThrow(() => assertActorMayTransition('admin', to));
});

test('an unknown actor role is denied', () => {
  assert.throws(() => assertActorMayTransition('stranger', S.PACKED), { code: 'ACTOR_NOT_ALLOWED' });
});

test('shipping requires both carrier and tracking number', () => {
  assert.doesNotThrow(() => assertShippedRequiresTracking({ carrier: 'DHL', trackingNumber: 'ABC123' }));
  assert.throws(() => assertShippedRequiresTracking({ carrier: '', trackingNumber: 'ABC123' }), { code: 'TRACKING_REQUIRED' });
  assert.throws(() => assertShippedRequiresTracking({ carrier: 'DHL', trackingNumber: '   ' }), { code: 'TRACKING_REQUIRED' });
  assert.throws(() => assertShippedRequiresTracking({}), { code: 'TRACKING_REQUIRED' });
  assert.throws(() => assertShippedRequiresTracking(), { code: 'TRACKING_REQUIRED' });
});

test('tracking validation reports both missing fields at once', () => {
  assert.throws(() => assertShippedRequiresTracking({}), (e) => e.errors.length === 2);
});

test('a reason is required for CANCELLED and RETURNED only', () => {
  assert.throws(() => assertReasonRequired(S.CANCELLED, ''), { code: 'REASON_REQUIRED' });
  assert.throws(() => assertReasonRequired(S.RETURNED, undefined), { code: 'REASON_REQUIRED' });
  assert.doesNotThrow(() => assertReasonRequired(S.CANCELLED, 'Buyer requested cancellation'));
  for (const to of [S.PACKED, S.SHIPPED, S.DELIVERED]) assert.doesNotThrow(() => assertReasonRequired(to, undefined));
});

test('Stage G: the system actor may mark PACKED/SHIPPED only', () => {
  for (const to of [S.PACKED, S.SHIPPED]) assert.doesNotThrow(() => assertActorMayTransition('system', to));
  for (const to of [S.DELIVERED, S.CANCELLED, S.RETURNED]) assert.throws(() => assertActorMayTransition('system', to), { code: 'ACTOR_NOT_ALLOWED' });
});
