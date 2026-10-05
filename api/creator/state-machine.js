// api/creator/state-machine.js
//
// LEXDEN NOVA CREATOR — Stage A: the application + seller state machine.
//
// Deliberately pure (no Firestore, no req/res) so it can be unit-tested
// without any live infrastructure — see test/creator-state-machine.test.js.
// Every state-changing API handler imports `assertTransition` from here
// rather than writing its own if/else chain, so there is exactly ONE place
// in the whole codebase that knows which transitions are legal. This is
// the architectural promise from the blueprint's §5 (and the Implementation
// README's §0): "Never represent this important lifecycle with a single
// frontend Boolean such as isCreator=true."

// ---- Application lifecycle (creatorApplications/{uid}.status) ----
const APPLICATION_STATES = Object.freeze({
  APPLICATION_DRAFT: 'APPLICATION_DRAFT',
  SUBMITTED: 'SUBMITTED',
  IN_REVIEW: 'IN_REVIEW',
  CHANGES_REQUESTED: 'CHANGES_REQUESTED',
  REJECTED: 'REJECTED',
  APPROVED: 'APPROVED',
});

// ---- Seller lifecycle (creators/{uid}.status), begins once APPROVED ----
const SELLER_STATES = Object.freeze({
  ACTIVE: 'ACTIVE',
  RESTRICTED: 'RESTRICTED',
  SUSPENDED: 'SUSPENDED',
  REVOKED: 'REVOKED',
});

// from -> [allowed next states]. NOT_APPLIED isn't a stored state at all —
// it's simply "no creatorApplications/{uid} document exists yet", so it
// never appears on the right-hand side of a transition.
const APPLICATION_TRANSITIONS = Object.freeze({
  [APPLICATION_STATES.APPLICATION_DRAFT]: [APPLICATION_STATES.SUBMITTED],
  [APPLICATION_STATES.SUBMITTED]: [APPLICATION_STATES.IN_REVIEW],
  [APPLICATION_STATES.IN_REVIEW]: [
    APPLICATION_STATES.CHANGES_REQUESTED,
    APPLICATION_STATES.REJECTED,
    APPLICATION_STATES.APPROVED,
  ],
  [APPLICATION_STATES.CHANGES_REQUESTED]: [APPLICATION_STATES.SUBMITTED],
  // Terminal for this application attempt — a fresh application is a new
  // document history entry, not a resurrection of a rejected one.
  [APPLICATION_STATES.REJECTED]: [],
  // Terminal — APPROVED hands off to the seller lifecycle below.
  [APPLICATION_STATES.APPROVED]: [],
});

const SELLER_TRANSITIONS = Object.freeze({
  [SELLER_STATES.ACTIVE]: [SELLER_STATES.RESTRICTED, SELLER_STATES.SUSPENDED, SELLER_STATES.REVOKED],
  [SELLER_STATES.RESTRICTED]: [SELLER_STATES.ACTIVE, SELLER_STATES.SUSPENDED, SELLER_STATES.REVOKED],
  [SELLER_STATES.SUSPENDED]: [SELLER_STATES.ACTIVE, SELLER_STATES.RESTRICTED, SELLER_STATES.REVOKED],
  // Terminal by design — reinstating a revoked seller is a new approval,
  // not a transition out of REVOKED (keeps the audit trail honest).
  [SELLER_STATES.REVOKED]: [],
});

class TransitionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TransitionError';
    this.code = code || 'INVALID_TRANSITION';
    this.status = 409;
  }
}

function canTransition(table, from, to) {
  const allowed = table[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/** Throws TransitionError if `from -> to` isn't a legal application-state
 * move; otherwise returns silently. `from` may be null/undefined to mean
 * NOT_APPLIED (no document yet) — the only state a brand-new application
 * may be created into is APPLICATION_DRAFT. */
function assertApplicationTransition(from, to) {
  if (from == null) {
    if (to !== APPLICATION_STATES.APPLICATION_DRAFT) {
      throw new TransitionError(`A new application must start at ${APPLICATION_STATES.APPLICATION_DRAFT}, not ${to}.`, 'INVALID_INITIAL_STATE');
    }
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(APPLICATION_TRANSITIONS, from)) {
    throw new TransitionError(`Unknown application state "${from}".`, 'UNKNOWN_STATE');
  }
  if (!canTransition(APPLICATION_TRANSITIONS, from, to)) {
    throw new TransitionError(`Cannot move a creator application from ${from} to ${to}.`, 'INVALID_TRANSITION');
  }
}

function assertSellerTransition(from, to) {
  if (!Object.prototype.hasOwnProperty.call(SELLER_TRANSITIONS, from)) {
    throw new TransitionError(`Unknown seller state "${from}".`, 'UNKNOWN_STATE');
  }
  if (!canTransition(SELLER_TRANSITIONS, from, to)) {
    throw new TransitionError(`Cannot move a seller from ${from} to ${to}.`, 'INVALID_TRANSITION');
  }
}

// A creator may act (create/edit products, accept orders, etc.) only in
// this seller state. RESTRICTED intentionally still allows read/limited
// actions elsewhere in the app later (Stage C+) — this helper is
// specifically the "may originate new commerce" gate.
function isSellerActionable(status) {
  return status === SELLER_STATES.ACTIVE;
}

// Duplicate-application guard (Implementation README §44 "Creator" test
// list: "duplicate application prevention"). An applicant may not open a
// second application while a non-terminal one exists, and may not re-apply
// at all once APPROVED (they already are a creator — see creator-me
// instead). REJECTED is the one terminal state that legitimately allows a
// fresh attempt, matching §5's intent that rejection isn't necessarily
// permanent.
function assertNoDuplicateApplication(existingStatus) {
  if (existingStatus == null) return; // NOT_APPLIED — fine to start one
  if (existingStatus === APPLICATION_STATES.REJECTED) return;
  const e = new Error('An application already exists for this account.');
  e.code = 'APPLICATION_ALREADY_EXISTS';
  e.status = 409;
  throw e;
}

// "Suspended creator blocked" guard (same §44 list).
function assertSellerNotBlocked(status) {
  if (status === SELLER_STATES.SUSPENDED || status === SELLER_STATES.REVOKED) {
    const e = new Error('This creator account is ' + status.toLowerCase() + ' and cannot perform this action.');
    e.code = 'CREATOR_' + status; // CREATOR_SUSPENDED / CREATOR_REVOKED
    e.status = 403;
    throw e;
  }
}

module.exports = {
  APPLICATION_STATES,
  SELLER_STATES,
  APPLICATION_TRANSITIONS,
  SELLER_TRANSITIONS,
  TransitionError,
  assertApplicationTransition,
  assertSellerTransition,
  isSellerActionable,
  assertNoDuplicateApplication,
  assertSellerNotBlocked,
};
