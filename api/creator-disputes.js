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
//    once per order, within DISPUTE_WINDOW_DAYS of the sale.
//  * Opening a dispute FREEZES the creator's earning for that order (it stops being
//    withdrawable). The admin then decides in /api/creator-admin-risk; nothing is
//    decided or paid automatically, and AI is never involved.
//  * The creator never sees the buyer's email.
const { getDb, requireAuth, FieldValue, ok, fail, setCors, writeCreatorAuditLog } = require('./creator/shared');
const { freezeSale } = require('./creator/ledger');
const { getEntitlement } = require('./creator/entitlements');

const DISPUTE_WINDOW_DAYS = 14;
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

  const soldAt = typeof sale.createdAtMs === 'number' ? sale.createdAtMs : toMs(sale.createdAt);
  if (soldAt && Date.now() - soldAt > DISPUTE_WINDOW_DAYS * DAY_MS) throw err(400, 'WINDOW_CLOSED', `Disputes must be opened within ${DISPUTE_WINDOW_DAYS} days of the purchase.`);

  const ref = db.collection('creatorDisputes').doc(orderId);
  const now = Date.now();
  try {
    await ref.create({
      orderId, creatorId: sale.creatorId, buyerUid: uid, buyerEmail: email || null,
      productId: sale.productId || null, productTitle: sale.productTitle || null,
      amount: sale.saleAmount, currency: sale.currency || null,
      reason, details, status: 'OPEN',
      messages: [{ by: 'buyer', text: details, atMs: now }],
      openedAtMs: now, openedAt: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    if (e && (e.code === 6 || /ALREADY_EXISTS/i.test(String(e.message)))) throw err(409, 'DISPUTE_EXISTS', 'A dispute is already open for this order.');
    throw e;
  }
  const frozen = await freezeSale(db, orderId, orderId);
  await notifyCreator(db, sale.creatorId, `dispute_${orderId}`, 'A buyer opened a dispute', `${sale.productTitle || 'An order'}: ${reason.replace(/_/g, ' ').toLowerCase()}. Please reply in Creator → More → Disputes. The earning for this order is on hold until it is resolved.`);
  writeCreatorAuditLog({ actorUid: uid, actorRole: 'buyer', action: 'dispute.opened', targetType: 'dispute', targetId: orderId, metadata: { reason, frozen: !!frozen.frozen } }).catch(() => {});
  return { disputeId: orderId, status: 'OPEN', earningFrozen: !!frozen.frozen };
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
  if (out.by === 'buyer') await notifyCreator(db, out.creatorId, `dispute_msg_${id}`, 'The buyer replied to a dispute', `${out.title || 'Order'}: open Creator → More → Disputes to respond.`);
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
module.exports.addMessage = addMessage;
module.exports.DISPUTE_WINDOW_DAYS = DISPUTE_WINDOW_DAYS;
module.exports.publicView = publicView;
