// api/creator/fulfillment-state-machine.js
//
// LEXDEN NOVA CREATOR — Stage E: physical fulfillment, proof of delivery.
// Pure, dependency-free, unit tested (test/fulfillment-state-machine.test.js).
//
// Scope: a creator (or admin) records what they did (packed, shipped with
// tracking) and a buyer (or admin) confirms receipt. Stage G adds one more
// actor: for a CJ_DROPSHIP listing the platform mirrors the creator's own CJ
// order into PACKED/SHIPPED (api/supplier/orders.js). No courier API (Stage
// H) exists yet.
const FULFILLMENT_STATES = Object.freeze({
  PENDING: 'PENDING',
  PACKED: 'PACKED',
  SHIPPED: 'SHIPPED',
  DELIVERED: 'DELIVERED',
  RETURNED: 'RETURNED',
  CANCELLED: 'CANCELLED',
});

const FULFILLMENT_TRANSITIONS = Object.freeze({
  [FULFILLMENT_STATES.PENDING]: [FULFILLMENT_STATES.PACKED, FULFILLMENT_STATES.CANCELLED],
  [FULFILLMENT_STATES.PACKED]: [FULFILLMENT_STATES.SHIPPED, FULFILLMENT_STATES.CANCELLED],
  [FULFILLMENT_STATES.SHIPPED]: [FULFILLMENT_STATES.DELIVERED, FULFILLMENT_STATES.RETURNED],
  [FULFILLMENT_STATES.DELIVERED]: [],
  [FULFILLMENT_STATES.RETURNED]: [],
  [FULFILLMENT_STATES.CANCELLED]: [],
});

// Who may move a fulfillment INTO each state. Admin may always act.
const TRANSITION_ACTORS = Object.freeze({
  // 'system' = the Stage G CJ sync acting on the creator's own CJ order. It may
  // pack/ship (tracking is still mandatory) but never deliver/return/cancel.
  [FULFILLMENT_STATES.PACKED]: ['creator', 'admin', 'system'],
  [FULFILLMENT_STATES.SHIPPED]: ['creator', 'admin', 'system'],
  [FULFILLMENT_STATES.DELIVERED]: ['buyer', 'admin'],
  [FULFILLMENT_STATES.RETURNED]: ['admin'],
  [FULFILLMENT_STATES.CANCELLED]: ['creator', 'admin'],
});

class TransitionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TransitionError';
    this.code = code || 'INVALID_TRANSITION';
    this.status = 409;
  }
}

function canTransition(from, to) {
  const allowed = FULFILLMENT_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

function assertFulfillmentTransition(from, to) {
  if (from == null) {
    if (to !== FULFILLMENT_STATES.PENDING) throw new TransitionError(`A new fulfillment must start at ${FULFILLMENT_STATES.PENDING}, not ${to}.`, 'INVALID_INITIAL_STATE');
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(FULFILLMENT_TRANSITIONS, from)) throw new TransitionError(`Unknown fulfillment state "${from}".`, 'UNKNOWN_STATE');
  if (!canTransition(from, to)) throw new TransitionError(`Cannot move a fulfillment from ${from} to ${to}.`, 'INVALID_TRANSITION');
}

function assertActorMayTransition(actorRole, to) {
  if (actorRole === 'admin') return;
  const allowed = TRANSITION_ACTORS[to];
  if (!Array.isArray(allowed) || !allowed.includes(actorRole)) {
    const e = new Error(`A ${actorRole} may not mark a fulfillment as ${to}.`);
    e.code = 'ACTOR_NOT_ALLOWED';
    e.status = 403;
    throw e;
  }
}

// A SHIPPED record with no tracking number is a claim, not proof.
function assertShippedRequiresTracking({ carrier, trackingNumber } = {}) {
  const errors = [];
  if (typeof carrier !== 'string' || !carrier.trim()) errors.push({ field: 'carrier', message: 'A carrier name is required to mark this shipped.' });
  if (typeof trackingNumber !== 'string' || !trackingNumber.trim()) errors.push({ field: 'trackingNumber', message: 'A tracking number is required to mark this shipped.' });
  if (errors.length) {
    const e = new Error('Tracking details are required to mark a fulfillment as shipped.');
    e.code = 'TRACKING_REQUIRED';
    e.status = 422;
    e.errors = errors;
    throw e;
  }
}

function assertReasonRequired(to, reason) {
  if ((to === FULFILLMENT_STATES.CANCELLED || to === FULFILLMENT_STATES.RETURNED) && (typeof reason !== 'string' || !reason.trim())) {
    const e = new Error(`A reason is required to mark a fulfillment as ${to}.`);
    e.code = 'REASON_REQUIRED';
    e.status = 422;
    throw e;
  }
}

module.exports = {
  FULFILLMENT_STATES, FULFILLMENT_TRANSITIONS, TRANSITION_ACTORS,
  TransitionError,
  assertFulfillmentTransition, assertActorMayTransition,
  assertShippedRequiresTracking, assertReasonRequired,
};
