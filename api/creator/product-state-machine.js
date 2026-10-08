// api/creator/product-state-machine.js
//
// LEXDEN NOVA CREATOR — Stage C: product + version lifecycle.
// Same discipline as api/creator/state-machine.js (Stage A): pure,
// dependency-free, one function per legal-transition question, unit
// tested in test/product-state-machine.test.js.
//
// Two separate state machines, matching the blueprint's §10 exactly:
//   PRODUCT  — the long-lived "listing" (DRAFT → ... → PUBLISHED → ...)
//   VERSION  — one specific draft/edit of that listing's content
// A product can have many versions over its life; only one is ever
// "current" (denormalized onto the product doc as `publishedSnapshot` —
// see CREATOR-STAGE-C-README.md for why that's public-readable while
// productVersions/{id} itself stays owner/admin-only).
//
// Deviation from the blueprint, documented: its product-state list
// includes a separate AUTOMATED_CHECK state between SUBMITTED and
// ADMIN_REVIEW. There's no automated-check engine built yet (that's
// real scope — plagiarism/malware/policy-keyword scanning), so Stage C
// folds that into IN_REVIEW rather than adding a state nothing ever
// transitions into. Same treatment as Stage A's SUBMITTED/IN_REVIEW
// split for creator applications.
const PRODUCT_STATES = Object.freeze({
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
  IN_REVIEW: 'IN_REVIEW',
  CHANGES_REQUESTED: 'CHANGES_REQUESTED',
  REJECTED: 'REJECTED',
  APPROVED: 'APPROVED',
  PUBLISHED: 'PUBLISHED',
  PAUSED: 'PAUSED',
  SUSPENDED: 'SUSPENDED',
  ARCHIVED: 'ARCHIVED',
});

const VERSION_STATES = Object.freeze({
  DRAFT: 'DRAFT',
  PENDING_REVIEW: 'PENDING_REVIEW',
  APPROVED: 'APPROVED',
  PUBLISHED: 'PUBLISHED',
  SUPERSEDED: 'SUPERSEDED',
  REJECTED: 'REJECTED',
});

const PRODUCT_TRANSITIONS = Object.freeze({
  [PRODUCT_STATES.DRAFT]: [PRODUCT_STATES.SUBMITTED],
  [PRODUCT_STATES.SUBMITTED]: [PRODUCT_STATES.IN_REVIEW],
  [PRODUCT_STATES.IN_REVIEW]: [PRODUCT_STATES.CHANGES_REQUESTED, PRODUCT_STATES.REJECTED, PRODUCT_STATES.APPROVED],
  [PRODUCT_STATES.CHANGES_REQUESTED]: [PRODUCT_STATES.SUBMITTED],
  [PRODUCT_STATES.REJECTED]: [], // terminal for this product; a fresh DRAFT is a new product, like Stage A's REJECTED application
  // APPROVED auto-advances to PUBLISHED the moment the version publishes
  // (see api/creator-admin-products.js) — it's not a state a product sits
  // in on its own, but it's still a real, momentary, audited step.
  [PRODUCT_STATES.APPROVED]: [PRODUCT_STATES.PUBLISHED],
  [PRODUCT_STATES.PUBLISHED]: [PRODUCT_STATES.PAUSED, PRODUCT_STATES.SUSPENDED, PRODUCT_STATES.ARCHIVED],
  [PRODUCT_STATES.PAUSED]: [PRODUCT_STATES.PUBLISHED, PRODUCT_STATES.ARCHIVED],
  [PRODUCT_STATES.SUSPENDED]: [PRODUCT_STATES.PUBLISHED, PRODUCT_STATES.ARCHIVED],
  [PRODUCT_STATES.ARCHIVED]: [], // terminal
});

const VERSION_TRANSITIONS = Object.freeze({
  [VERSION_STATES.DRAFT]: [VERSION_STATES.PENDING_REVIEW],
  [VERSION_STATES.PENDING_REVIEW]: [VERSION_STATES.APPROVED, VERSION_STATES.REJECTED],
  [VERSION_STATES.APPROVED]: [VERSION_STATES.PUBLISHED],
  [VERSION_STATES.PUBLISHED]: [VERSION_STATES.SUPERSEDED],
  [VERSION_STATES.SUPERSEDED]: [], // terminal — history, never resurrected
  [VERSION_STATES.REJECTED]: [], // terminal for that attempt — the creator's next edit is a new version, not a reopening of this one
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

function assertProductTransition(from, to) {
  if (from == null) {
    if (to !== PRODUCT_STATES.DRAFT) throw new TransitionError(`A new product must start at ${PRODUCT_STATES.DRAFT}, not ${to}.`, 'INVALID_INITIAL_STATE');
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(PRODUCT_TRANSITIONS, from)) throw new TransitionError(`Unknown product state "${from}".`, 'UNKNOWN_STATE');
  if (!canTransition(PRODUCT_TRANSITIONS, from, to)) throw new TransitionError(`Cannot move a product from ${from} to ${to}.`, 'INVALID_TRANSITION');
}

function assertVersionTransition(from, to) {
  if (from == null) {
    if (to !== VERSION_STATES.DRAFT) throw new TransitionError(`A new version must start at ${VERSION_STATES.DRAFT}, not ${to}.`, 'INVALID_INITIAL_STATE');
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(VERSION_TRANSITIONS, from)) throw new TransitionError(`Unknown version state "${from}".`, 'UNKNOWN_STATE');
  if (!canTransition(VERSION_TRANSITIONS, from, to)) throw new TransitionError(`Cannot move a version from ${from} to ${to}.`, 'INVALID_TRANSITION');
}

// A creator may edit THIS version's content only while it's still DRAFT.
// Once PENDING_REVIEW, the admin is looking at exactly what was
// submitted — silently changing it out from under review is the same
// hole Stage A's application editing guard closes.
function isVersionEditable(status) {
  return status === VERSION_STATES.DRAFT;
}

// A brand-new DRAFT version may only be created against a product that
// has no version currently mid-review — editing an APPROVED/PUBLISHED
// product starts a new version, but you can't start a second concurrent
// edit while one is already PENDING_REVIEW/APPROVED-awaiting-publish.
function assertNoConcurrentVersion(latestVersionStatus) {
  if (latestVersionStatus === VERSION_STATES.PENDING_REVIEW || latestVersionStatus === VERSION_STATES.APPROVED) {
    const e = new Error('A newer version of this product is already awaiting review — wait for that decision before starting another edit.');
    e.code = 'VERSION_ALREADY_IN_FLIGHT';
    e.status = 409;
    throw e;
  }
}

// Blocks product actions for a product whose OWN state is terminal/blocked
// (mirrors Stage A's assertSellerNotBlocked, one level down).
function assertProductNotBlocked(status) {
  if (status === PRODUCT_STATES.SUSPENDED || status === PRODUCT_STATES.ARCHIVED) {
    const e = new Error(`This product is ${status.toLowerCase()} and cannot be edited.`);
    e.code = 'PRODUCT_' + status;
    e.status = 403;
    throw e;
  }
}

// ---- Edit-risk classification (blueprint §10) ----
// Pure diff between the previous PUBLISHED version's fields and a new
// draft's fields. Returns 'high' | 'medium' | 'low'. Deliberately
// conservative: ties go to the higher risk tier, and an offeringType
// change is always high regardless of anything else, since it can
// invalidate every other field's meaning at once.
const PRICE_MAJOR_CHANGE_RATIO = 0.2; // a >20% price move is "major"

function classifyEditRisk(prevFields, nextFields) {
  const prev = prevFields || {};
  const next = nextFields || {};

  if (prev.offeringType && next.offeringType && prev.offeringType !== next.offeringType) return 'high';
  if ((prev.fileAssetId || null) !== (next.fileAssetId || null)) return 'high'; // paid file swapped
  if ((prev.externalUrl || null) !== (next.externalUrl || null) && (prev.externalUrl || next.externalUrl)) return 'high';
  if ((prev.supplierId || null) !== (next.supplierId || null) && (prev.supplierId || next.supplierId)) return 'high';
  if ((prev.refundPolicy || null) !== (next.refundPolicy || null)) return 'high';
  if (typeof prev.price === 'number' && typeof next.price === 'number' && prev.price > 0) {
    const change = Math.abs(next.price - prev.price) / prev.price;
    if (change > PRICE_MAJOR_CHANGE_RATIO) return 'high';
  }

  let medium = false;
  if ((prev.description || '') !== (next.description || '')) medium = true;
  if ((prev.images && prev.images[0]) !== (next.images && next.images[0])) medium = true; // primary image
  if ((prev.category || null) !== (next.category || null)) medium = true;
  if (medium) return 'medium';

  return 'low';
}

module.exports = {
  PRODUCT_STATES, VERSION_STATES,
  PRODUCT_TRANSITIONS, VERSION_TRANSITIONS,
  TransitionError,
  assertProductTransition, assertVersionTransition,
  isVersionEditable, assertNoConcurrentVersion, assertProductNotBlocked,
  classifyEditRisk,
};
