// api/creator/sla.js
//
// LEXDEN NOVA CREATOR — Stage H: seller SLA rules for physical orders
// (blueprint §19). PURE: no I/O. Everything that decides "is this seller late
// on this order?" lives here and is unit tested (test/sla.test.js).
//
// Targets (the blueprint calls them "example configuration, not a fixed legal
// promise", so they are constants in ONE place, easy to change):
//   acknowledge a paid order .......... 24 h   (any progress counts: packing
//                                              an order also acknowledges it)
//   add shipping + tracking ........... 48 h   (longer when the listing
//                                              declares a processing time)
//   delivery after shipping ........... 14 days (a flag for support only)
//   buyer dispute window after delivery 72 h   (used by Stage I auto-release)
//
// An overdue order is a WARNING and a trust signal. This file never cancels,
// refunds or restricts anything by itself; enforcement is Stage I's job and
// is gated by a human-readable recommendation computed here.
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const SLA_DEFAULTS = Object.freeze({
  ackHours: 24,
  shipHours: 48,
  deliveryDays: 14,
  disputeWindowHours: 72,
  dueSoonFraction: 0.25, // "due soon" once <=25% of a window remains
  maxProcessingDays: 30,
});

// Firestore Timestamp | Date | number | {seconds} -> ms (or null)
function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  const secs = v.seconds ?? v._seconds;
  if (typeof secs === 'number') return secs * 1000 + Math.floor((v.nanoseconds ?? v._nanoseconds ?? 0) / 1e6);
  return null;
}

function cleanProcessingDays(n) {
  return Number.isInteger(n) && n >= 1 && n <= SLA_DEFAULTS.maxProcessingDays ? n : null;
}

/** The SLA a given listing promises. A declared processing time stretches the ship window. */
function slaPolicyFor({ fulfillmentMode = 'SELLER_STOCK', processingDays = null } = {}) {
  const days = cleanProcessingDays(processingDays);
  const shipHours = Math.max(SLA_DEFAULTS.shipHours, days ? days * 24 : 0);
  return {
    mode: fulfillmentMode,
    ackHours: SLA_DEFAULTS.ackHours,
    shipHours,
    deliveryDays: SLA_DEFAULTS.deliveryDays,
    disputeWindowHours: SLA_DEFAULTS.disputeWindowHours,
  };
}

function computeDeadlines(createdAtMs, policy) {
  return { ackDueAtMs: createdAtMs + policy.ackHours * HOUR, shipDueAtMs: createdAtMs + policy.shipHours * HOUR };
}

function windowState(dueAtMs, startMs, nowMs, fraction) {
  if (nowMs > dueAtMs) return 'BREACHED';
  return dueAtMs - nowMs <= (dueAtMs - startMs) * fraction ? 'DUE_SOON' : 'ON_TRACK';
}

/**
 * Evaluates one fulfillment.
 * Returns { ack, ship, delivery, overall, breaches[], dueAtMs }
 *   per-milestone: MET | MET_LATE | ON_TRACK | DUE_SOON | BREACHED | NA
 *   overall:       COMPLETE | ON_TRACK | AT_RISK | BREACHED | CLOSED
 */
function evaluateSla(f, nowMs, fraction = SLA_DEFAULTS.dueSoonFraction) {
  const status = f && f.status;
  if (!f) return { ack: 'NA', ship: 'NA', delivery: 'NA', overall: 'CLOSED', breaches: [], dueAtMs: null };
  if (status === 'CANCELLED' || status === 'RETURNED') {
    return { ack: 'NA', ship: 'NA', delivery: 'NA', overall: 'CLOSED', breaches: [], dueAtMs: null };
  }
  const created = f.createdAtMs ?? toMs(f.createdAt);
  if (created == null) return { ack: 'NA', ship: 'NA', delivery: 'NA', overall: 'CLOSED', breaches: [], dueAtMs: null };

  const policy = f.slaPolicy || slaPolicyFor({ fulfillmentMode: f.fulfillmentMode });
  const ackDue = f.ackDueAtMs ?? created + policy.ackHours * HOUR;
  const shipDue = f.shipDueAtMs ?? created + policy.shipHours * HOUR;

  // Packing/shipping implies the seller has seen the order.
  const ackedAt = f.acknowledgedAtMs ?? toMs(f.acknowledgedAt) ?? toMs(f.packedAt) ?? toMs(f.shippedAt);
  const shippedAt = f.shippedAtMs ?? toMs(f.shippedAt);
  const deliveredAt = toMs(f.deliveredAt);
  const shippedOrBeyond = status === 'SHIPPED' || status === 'DELIVERED';

  const breaches = [];
  let ack;
  if (ackedAt != null) { ack = ackedAt <= ackDue ? 'MET' : 'MET_LATE'; if (ack === 'MET_LATE') breaches.push('ACK_LATE'); }
  else { ack = windowState(ackDue, created, nowMs, fraction); if (ack === 'BREACHED') breaches.push('ACK_OVERDUE'); }

  let ship;
  if (shippedOrBeyond) {
    const at = shippedAt != null ? shippedAt : nowMs;
    ship = at <= shipDue ? 'MET' : 'MET_LATE';
    if (ship === 'MET_LATE') breaches.push('SHIP_LATE');
  } else {
    ship = windowState(shipDue, created, nowMs, fraction);
    if (ship === 'BREACHED') breaches.push('SHIP_OVERDUE');
  }

  let delivery = 'NA';
  let deliveryDue = null;
  if (status === 'SHIPPED' && shippedAt != null) {
    deliveryDue = shippedAt + policy.deliveryDays * DAY;
    delivery = nowMs > deliveryDue ? 'BREACHED' : 'ON_TRACK';
    if (delivery === 'BREACHED') breaches.push('DELIVERY_OVERDUE');
  } else if (status === 'DELIVERED') {
    delivery = 'MET';
  }

  let overall;
  if (status === 'DELIVERED') overall = breaches.length ? 'BREACHED' : 'COMPLETE';
  else if (breaches.length) overall = 'BREACHED';
  else if (ack === 'DUE_SOON' || ship === 'DUE_SOON') overall = 'AT_RISK';
  else overall = 'ON_TRACK';

  // Next thing that is due (for sorting a queue "most urgent first").
  let dueAtMs = null;
  if (status === 'SHIPPED') dueAtMs = deliveryDue;
  else if (ackedAt == null) dueAtMs = Math.min(ackDue, shipDue);
  else dueAtMs = shipDue;
  return { ack, ship, delivery, overall, breaches, dueAtMs };
}

/**
 * Trust summary across one creator's recent fulfillments (blueprint §19:
 * "repeated SLA failures should reduce seller trust and can automatically
 * restrict new orders"). Returns a RECOMMENDATION only.
 */
function summarizeCreatorSla(fulfillments, nowMs) {
  const counted = { total: 0, breached: 0, atRisk: 0, ackBreaches: 0, shipBreaches: 0, deliveryOverdue: 0, complete: 0 };
  for (const f of fulfillments || []) {
    const e = evaluateSla(f, nowMs);
    if (e.overall === 'CLOSED') continue;
    counted.total += 1;
    if (e.overall === 'BREACHED') counted.breached += 1;
    if (e.overall === 'AT_RISK') counted.atRisk += 1;
    if (e.overall === 'COMPLETE') counted.complete += 1;
    if (e.breaches.some((b) => b.startsWith('ACK'))) counted.ackBreaches += 1;
    if (e.breaches.some((b) => b.startsWith('SHIP'))) counted.shipBreaches += 1;
    if (e.breaches.includes('DELIVERY_OVERDUE')) counted.deliveryOverdue += 1;
  }
  const rate = counted.total ? Math.round((counted.breached / counted.total) * 1000) / 10 : 0;
  // Needs a real sample AND repeated failures so one unlucky order never flags a seller.
  const restrictionRecommended = counted.total >= 5 && counted.breached >= 3 && rate >= 30;
  const watch = !restrictionRecommended && counted.breached >= 2;
  return { ...counted, breachRatePct: rate, restrictionRecommended, watch };
}

module.exports = { SLA_DEFAULTS, HOUR, DAY, toMs, cleanProcessingDays, slaPolicyFor, computeDeadlines, evaluateSla, summarizeCreatorSla };
