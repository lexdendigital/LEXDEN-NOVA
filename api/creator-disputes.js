// /api/creator-disputes.js
//
// LEXDEN NOVA CREATOR — Stage K: buyer disputes.
//
//   GET  /api/creator-disputes?role=buyer|creator     the caller's disputes (newest first)
//   POST /api/creator-disputes {action:"open",    orderId, reason, details}   buyer opens one
//   POST /api/creator-disputes {action:"message", disputeId, text}            buyer or creator replies
//
// RULES
//  * Only the buyer of a PAID creator order can open a dispute (proved through the
//    buyer's entitlement or the physical fulfilment, both stamped with buyerUid),
//    once per order. PHYSICAL orders: the 14-day window runs from CONFIRMED DELIVERY
//    (never from the purchase date); before delivery is confirmed no countdown has
//    started, so a buyer can still report non-delivery. DIGITAL/SERVICE orders use
//    their own policy (api/core/config.js DISPUTE_POLICIES), snapshotted on the sale
//    and on the dispute. The window is an operational baseline: it never removes
//    statutory or payment-network rights.
//  * Opening a dispute and FREEZING the creator's earning happen in ONE transaction
//    (api/creator/ledger.js planFreeze): if the earning cannot be frozen the dispute is
//    NOT opened half-way. If the money was already withdrawn the earning is not
//    double-deducted; a recovery exception is raised for an admin instead.
//    The admin then decides in /api/creator-admin-risk; nothing is
//    decided or paid automatically, and AI is never involved.
//  * The creator never sees the buyer's email.
const { getDb, requireAuth, FieldValue, ok, fail, setCors, writeCreatorAuditLog } = require('./creator/shared');
const { planFreeze } = require('./creator/ledger');
const cfg = require('./core/config');
const refunds = require('./core/refunds');
const { getEntitlement } = require('./creator/entitlements');

const DISPUTE_WINDOW_DAYS = cfg.DISPUTE_POLICIES.PHYSICAL.windowDays; // kept for callers that display it
const DAY_MS = 24 * 60 * 60 * 1000;
const REASONS = ['NOT_AS_DESCRIBED', 'NOT_RECEIVED', 'FILE_PROBLEM', 'OTHER'];
const MAX_MESSAGES = 50;

const err = (status, code, message) => Object.assign(new Error(message), { status, code });
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
const toMs = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : (typeof v === 'number' ? v : (v && v._seconds ? v._seconds * 1000 : null)));

/** Safe view of a dispute for the buyer or creator (never the buyer's email). */
function publicView(d) {
  const { buyerEmail, buyerUid, openedAt, ...rest } = d;
  return rest;
}

async function notifyCreator(db, creatorId, key, title, message) {
  try {
    await db.collection('creatorNotifications').doc(`${creatorId}_${key}`.replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 150)).set({
      creatorId, type: 'DISPUTE', severity: 'warning', title, message, read: false, createdAtMs: Date.now(), updatedAtMs: Date.now(),
    }, { merge: true });
  } catch (e) { console.warn('dispute notification skipped:', e.message); }
}

async function openDispute(db, uid, email, body) {
  const orderId = clean(body.orderId, 200);
  if (!orderId || orderId.includes('/')) throw err(422, 'MISSING_ORDER', 'orderId is required.');
  const reason = clean(body.reason, 40);
  if (!REASONS.includes(reason)) throw err(422, 'INVALID_REASON', `reason must be one of: ${REASONS.join(', ')}.`);
  const details = clean(body.details, 2000);
  if (details.length < 10) throw err(422, 'DETAILS_TOO_SHORT', 'Please tell us what went wrong (at least 10 characters).');

  const saleSnap = await db.collection('creatorSales').doc(orderId).get();
  if (!saleSnap.exists) throw err(404, 'NO_PAID_ORDER', 'No paid creator order was found for this reference (free items cannot be disputed).');
  const sale = saleSnap.data();
  if (sale.status === 'refunded') throw err(409, 'ALREADY_REFUNDED', 'This order has already been refunded.');

  // Prove the caller is the buyer.
  let mine = false;
  const ent = sale.productId ? await getEntitlement(db, orderId, sale.productId) : null;
  if (ent && ent.buyerUid && ent.buyerUid === uid) mine = true;
  if (!mine) {
    const ful = await db.collection('fulfillments').doc(orderId).get();
    if (ful.exists && ful.data().buyerUid && ful.data().buyerUid === uid) mine = true;
  }
  if (!mine) throw err(403, 'NOT_YOUR_ORDER', 'This order does not belong to your account.');

  // ---- Window: anchored on the policy snapshot taken at sale time ----
  const policy = sale.disputePolicy || cfg.disputePolicySnapshot(sale.offeringType);
  const windowMs = policy.windowDays * DAY_MS;
  let anchorMs = null;
  if (policy.anchor === 'CONFIRMED_DELIVERY') {
    const f = await db.collection('fulfillments').doc(orderId).get();
    const ful = f.exists ? f.data() : null;
    // Only AUTHORITATIVE confirmed delivery starts the countdown. No reliable event => no countdown.
    anchorMs = ful && ful.deliveredAtMs && cfg.isAuthoritativeEvidence(ful.deliveryEvidenceSource)
      ? ful.deliveredAtMs
      : (sale.deliveredAtMs && cfg.isAuthoritativeEvidence(sale.deliveryEvidenceSource) ? sale.deliveredAtMs : null);
  } else {
    anchorMs = typeof sale.createdAtMs === 'number' ? sale.createdAtMs : toMs(sale.createdAt);
  }
  if (anchorMs && Date.now() - anchorMs > windowMs) {
    throw err(400, 'WINDOW_CLOSED', policy.anchor === 'CONFIRMED_DELIVERY'
      ? `The ${policy.windowDays}-day window after confirmed delivery has passed. If you believe you have a legal right to a remedy, contact support.`
      : `The ${policy.windowDays}-day window after purchase has passed. If you believe you have a legal right to a remedy, contact support.`);
  }

  // ---- ONE transaction: open the dispute AND freeze the earning together ----
  const ref = db.collection('creatorDisputes').doc(orderId);
  const saleRef = db.collection('creatorSales').doc(orderId);
  const now = Date.now();
  const outcome = await db.runTransaction(async (tx) => {
    const saleNow = await tx.get(saleRef);
    const disputeNow = await tx.get(ref);
    if (disputeNow.exists) throw err(409, 'DISPUTE_EXISTS', 'A dispute is already open for this order.');
    const s = saleNow.exists ? saleNow.data() : null;
    if (!s || s.status === 'refunded') throw err(409, 'ALREADY_REFUNDED', 'This order has already been refunded.');
    const privRef = db.collection('creatorPrivate').doc(s.creatorId);
    const priv = (await tx.get(privRef)).data() || {};
    const plan = planFreeze(s, priv, { disputeId: orderId, nowMs: now });
    if (!plan.ok) throw err(409, 'CANNOT_OPEN_DISPUTE', 'This order cannot be disputed in its current state. Contact support.');
    tx.create(ref, {
      orderId, creatorId: s.creatorId, buyerUid: uid, buyerEmail: email || null,
      productId: s.productId || null, productTitle: s.productTitle || null,
      amount: s.saleAmount, currency: s.currency || null,
      reason, details, status: 'OPEN',
      policy, deliveryConfirmedAtMs: policy.anchor === 'CONFIRMED_DELIVERY' ? anchorMs : null,
      messages: [{ by: 'buyer', text: details, atMs: now }],
      openedAtMs: now, openedAt: FieldValue.serverTimestamp(),
    });
    if (plan.saleUpdate) tx.set(saleRef, plan.saleUpdate, { merge: true });
    if (plan.privUpdate) tx.set(privRef, plan.privUpdate, { merge: true });
    if (plan.exception) tx.set(db.collection('ledgerExceptions').doc(`dispute_${orderId}`), { ...plan.exception, status: 'OPEN', createdAtMs: now }, { merge: true });
    return { fundsAlreadyWithdrawn: !!(plan.saleUpdate && plan.saleUpdate.fundsAlreadyWithdrawn), creatorId: s.creatorId, productTitle: s.productTitle };
  });
  await notifyCreator(db, outcome.creatorId, `dispute_${orderId}`, 'A buyer opened a dispute', `${outcome.productTitle || 'An order'}: ${reason.replace(/_/g, ' ').toLowerCase()}. Please reply in Creator → Store → Disputes. The earning for this order is on hold until it is resolved.`);
  writeCreatorAuditLog({ actorUid: uid, actorRole: 'buyer', action: 'dispute.opened', targetType: 'dispute', targetId: orderId, metadata: { reason, fundsAlreadyWithdrawn: outcome.fundsAlreadyWithdrawn, policyVersion: policy.version } }).catch(() => {});
  return { disputeId: orderId, status: 'OPEN', earningFrozen: true, windowStartedAt: anchorMs, needsAdminRecovery: outcome.fundsAlreadyWithdrawn };
}

async function addMessage(db, uid, body) {
  const id = clean(body.disputeId, 200);
  const text = clean(body.text, 2000);
  if (!id || id.includes('/')) throw err(422, 'MISSING_DISPUTE', 'disputeId is required.');
  if (text.length < 2) throw err(422, 'EMPTY_MESSAGE', 'Write a message first.');
  const ref = db.collection('creatorDisputes').doc(id);
  const out = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw err(404, 'NOT_FOUND', 'Dispute not found.');
    const d = snap.data();
    const by = d.buyerUid === uid ? 'buyer' : (d.creatorId === uid ? 'creator' : null);
    if (!by) throw err(403, 'FORBIDDEN', 'This dispute is not yours.');
    if (d.status !== 'OPEN') throw err(409, 'DISPUTE_CLOSED', 'This dispute has been resolved.');
    const messages = Array.isArray(d.messages) ? d.messages.slice(-(MAX_MESSAGES - 1)) : [];
    messages.push({ by, text, atMs: Date.now() });
    tx.set(ref, { messages, lastMessageAtMs: Date.now(), ...(by === 'creator' ? { creatorResponded: true } : {}) }, { merge: true });
    return { by, creatorId: d.creatorId, title: d.productTitle };
  });
  if (out.by === 'buyer') await notifyCreator(db, out.creatorId, `dispute_msg_${id}`, 'The buyer replied to a dispute', `${out.title || 'Order'}: open Creator → Store → Disputes to respond.`);
  return { ok: true };
}

module.exports = async function handler(req, res) {
  setCors(res);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  let decoded;
  try { decoded = await requireAuth(req); } catch (e) { return fail(res, e); }
  const db = getDb();
  try {
    if (req.method === 'GET') {
      const role = req.query && req.query.role === 'creator' ? 'creator' : 'buyer';
      const snap = await db.collection('creatorDisputes').where(role === 'creator' ? 'creatorId' : 'buyerUid', '==', decoded.uid).limit(200).get();
      const list = snap.docs.map((x) => publicView({ id: x.id, ...x.data() })).sort((a, b) => (b.openedAtMs || 0) - (a.openedAtMs || 0));
      // The refund line comes from the refund record itself, so "completed" is only ever
      // shown after provider confirmation (api/core/refunds.js userFacingStatus).
      for (const d of list) {
        if (!d.refundId) continue;
        const r = await db.collection('refunds').doc(d.refundId).get();
        if (r.exists) d.refundStatus = refunds.userFacingStatus(r.data());
      }
      return ok(res, { disputes: list });
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' } });
    const body = req.body || {};
    if (body.action === 'open') return ok(res, await openDispute(db, decoded.uid, decoded.email, body));
    if (body.action === 'message') return ok(res, await addMessage(db, decoded.uid, body));
    return fail(res, err(400, 'INVALID_ACTION', 'action must be "open" or "message".'));
  } catch (e) {
    return fail(res, e);
  }
};
module.exports.REASONS = REASONS;
module.exports.openDispute = openDispute;
module.exports.addMessage = addMessage;
module.exports.DISPUTE_WINDOW_DAYS = DISPUTE_WINDOW_DAYS;
module.exports.publicView = publicView;
