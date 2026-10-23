// api/delivery/stations.js
//
// Pickup stations: a parcel is held at a staffed business instead of a doorstep. Everything here is
// OFF unless PICKUP_STATIONS_ENABLED=true (core/config flags). Rules, not marketing:
//   * Residential addresses are NEVER eligible and are never shown publicly.
//   * A station is only PUBLIC when an admin has APPROVED it after ticking every review check.
//   * Parcel hand-over to the buyer still needs the delivery code (api/delivery/proof.js).
//   * A station's stock/holding is separate from creator inventory.
const cfg = require('../core/config');

const STATES = Object.freeze({ DRAFT: 'DRAFT', SUBMITTED: 'SUBMITTED', UNDER_REVIEW: 'UNDER_REVIEW', NEEDS_CHANGES: 'NEEDS_CHANGES', APPROVED: 'APPROVED', REJECTED: 'REJECTED', SUSPENDED: 'SUSPENDED' });
const TRANSITIONS = Object.freeze({
  DRAFT: ['SUBMITTED'], SUBMITTED: ['UNDER_REVIEW'], UNDER_REVIEW: ['APPROVED', 'REJECTED', 'NEEDS_CHANGES'],
  NEEDS_CHANGES: ['SUBMITTED'], APPROVED: ['SUSPENDED'], SUSPENDED: ['APPROVED', 'REJECTED'], REJECTED: [],
});
const ELIGIBLE_TYPES = Object.freeze(['PHARMACY', 'SUPERMARKET', 'RETAIL_SHOP', 'LOGISTICS_AGENT', 'MALL_KIOSK', 'POST_OFFICE_AGENT', 'OTHER_BUSINESS']);
const REVIEW_CHECKS = Object.freeze(['identityVerified', 'businessPremisesVerified', 'openingHoursConfirmed', 'secureStorageConfirmed', 'termsAccepted']);
const err = (status, code, message) => Object.assign(new Error(message), { status, code });

const enabled = (env = process.env) => cfg.flags(env).pickupStationsEnabled;

/** Pure: why a submission is (not) eligible. */
function checkEligibility(s) {
  const problems = [];
  if (!s || typeof s !== 'object') return { eligible: false, problems: ['Missing station details.'] };
  if (s.isResidential === true) problems.push('Homes and residential addresses cannot be pickup stations.');
  if (!ELIGIBLE_TYPES.includes(s.businessType)) problems.push(`businessType must be one of ${ELIGIBLE_TYPES.join(', ')}.`);
  for (const f of ['name', 'address', 'city', 'state', 'openingHours', 'contactPhone', 'managerName']) if (!String(s[f] || '').trim()) problems.push(`${f} is required.`);
  return { eligible: problems.length === 0, problems };
}

function canTransition(from, to) { return (TRANSITIONS[from] || []).includes(to); }

/** Pure: next record after a review decision. APPROVED needs EVERY check true and a reviewer. */
function review(station, { to, checks = {}, reviewer, note = null, nowMs = Date.now() }) {
  if (!canTransition(station.state, to)) throw err(409, 'INVALID_TRANSITION', `Cannot move a station from ${station.state} to ${to}.`);
  if (!reviewer) throw err(422, 'REVIEWER_REQUIRED', 'A reviewer is required.');
  if (['REJECTED', 'NEEDS_CHANGES', 'SUSPENDED'].includes(to) && String(note || '').trim().length < 5) throw err(422, 'NOTE_REQUIRED', 'Explain the decision so the station can respond.');
  if (to === 'APPROVED') {
    const elig = checkEligibility(station);
    if (!elig.eligible) throw err(422, 'NOT_ELIGIBLE', elig.problems.join(' '));
    const missing = REVIEW_CHECKS.filter((c) => checks[c] !== true);
    if (missing.length) throw err(422, 'CHECKS_INCOMPLETE', `Complete every review check first: ${missing.join(', ')}.`);
  }
  return { ...station, state: to, reviewChecks: to === 'APPROVED' ? checks : (station.reviewChecks || null), reviewedBy: reviewer, reviewedAtMs: nowMs, reviewNote: note ? String(note).slice(0, 500) : null };
}

/** What the public may see. Nothing unless the feature is on AND the station is approved. */
function publicView(station, env = process.env) {
  if (!enabled(env) || !station || station.state !== 'APPROVED' || station.isResidential === true) return null;
  return { id: station.id, name: station.name, address: station.address, city: station.city, state: station.state_ || station.stateRegion || null, openingHours: station.openingHours, businessType: station.businessType };
}

async function submit(db, { ownerUid, details, env = process.env, nowMs = Date.now() }) {
  if (!enabled(env)) throw err(503, 'PICKUP_STATIONS_DISABLED', 'Pickup stations are not enabled yet.');
  const e = checkEligibility(details);
  if (!e.eligible) throw err(422, 'NOT_ELIGIBLE', e.problems.join(' '));
  const ref = db.collection('pickupStations').doc();
  const rec = { id: ref.id, ownerUid, ...details, stateRegion: details.state, state: STATES.SUBMITTED, createdAtMs: nowMs };
  await ref.set(rec);
  return rec;
}

module.exports = { STATES, TRANSITIONS, ELIGIBLE_TYPES, REVIEW_CHECKS, enabled, checkEligibility, canTransition, review, publicView, submit };
