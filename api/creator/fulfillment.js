// api/creator/fulfillment.js
//
// LEXDEN NOVA CREATOR — Stage E: Firestore-touching half of fulfillment.
// One doc per order; doc ID = the Paystack reference (1:1 with
// orders/{reference}).
const crypto = require('crypto');
const { getDb: sharedGetDb, FieldValue } = require('./shared');
const { FULFILLMENT_STATES, assertFulfillmentTransition } = require('./fulfillment-state-machine');
const { slaPolicyFor, computeDeadlines } = require('./sla');

// Idempotent: a retried verify-paystack.js call never clobbers whatever
// state a creator/admin has since moved the record to.
async function createFulfillment(db, { orderId, productId, versionId, creatorId, buyerUid, buyerEmail, delivery, productTitle, fulfillmentMode, processingDays, nowMs }) {
  const ref = db.collection('fulfillments').doc(orderId);
  const existing = await ref.get();
  if (existing.exists) return { id: orderId, created: false };
  assertFulfillmentTransition(null, FULFILLMENT_STATES.PENDING);
  // Stage H: the seller's clock starts now (blueprint §19).
  const createdAtMs = nowMs || Date.now();
  const mode = fulfillmentMode || 'SELLER_STOCK';
  const slaPolicy = slaPolicyFor({ fulfillmentMode: mode, processingDays });
  const deadlines = computeDeadlines(createdAtMs, slaPolicy);
  try {
    // create() (not set()): two racing verify calls can never both "create" it.
    await ref.create({
      orderId, productId, versionId: versionId || null, creatorId: creatorId || null,
      buyerUid: buyerUid || null, buyerEmail: buyerEmail || null,
      productTitle: productTitle || null,
      delivery: delivery || null,
      status: FULFILLMENT_STATES.PENDING,
      carrier: null, trackingNumber: null, trackingUrl: null,
      proofPhotoStoragePath: null, deliveryConfirmedBy: null,
      cancelReason: null, returnReason: null,
      fulfillmentMode: mode, slaPolicy, createdAtMs, ...deadlines, acknowledgedAtMs: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    if (e && (e.code === 6 || /ALREADY_EXISTS/i.test(String(e.message)))) return { id: orderId, created: false };
    throw e;
  }
  // Own-stock listings: one unit leaves stock per paid order, exactly once
  // (only the call that actually created the fulfillment reaches this line).
  if (mode === 'SELLER_STOCK' && productId) await decrementStock(db, productId);
  return { id: orderId, created: true };
}

// Never throws and never goes below zero: a stock hiccup must not undo a paid order.
async function decrementStock(db, productId) {
  try {
    const ref = db.collection('products').doc(productId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const snapshot = (snap.data() || {}).publishedSnapshot;
      if (!snapshot || typeof snapshot.stock !== 'number') return;
      tx.set(ref, { publishedSnapshot: { ...snapshot, stock: Math.max(0, snapshot.stock - 1) } }, { merge: true });
    });
  } catch (e) {
    console.error('stock decrement failed:', e && e.message);
  }
}

async function getFulfillment(db, orderId) {
  const snap = await db.collection('fulfillments').doc(orderId).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

const STATE_TIMESTAMP_FIELD = Object.freeze({
  [FULFILLMENT_STATES.PACKED]: 'packedAt',
  [FULFILLMENT_STATES.SHIPPED]: 'shippedAt',
  [FULFILLMENT_STATES.DELIVERED]: 'deliveredAt',
  [FULFILLMENT_STATES.RETURNED]: 'returnedAt',
  [FULFILLMENT_STATES.CANCELLED]: 'cancelledAt',
});

async function applyFulfillmentPatch(db, orderId, to, extraFields) {
  const patch = { status: to, updatedAt: FieldValue.serverTimestamp(), ...(extraFields || {}) };
  const tsField = STATE_TIMESTAMP_FIELD[to];
  if (tsField) patch[tsField] = FieldValue.serverTimestamp();
  await db.collection('fulfillments').doc(orderId).set(patch, { merge: true });
  await notifyBuyerOfStatus(db, orderId, to, extraFields);
}

// Buyer email for SHIPPED / DELIVERED / CANCELLED (template key
// "order_update" -> BREVO_TPL_ORDER_UPDATE). Strictly best-effort and
// background: never delays or fails the status change. Skipped silently when
// Brevo isn't configured (so unit tests and fresh installs are unaffected).
const STATUS_COPY = {
  SHIPPED: 'Good news: the seller has shipped your order.',
  DELIVERED: 'Your order is marked as delivered. Thank you for shopping with LEXDEN NOVA!',
  CANCELLED: 'Your order was cancelled. If you were charged, contact us and we will help.',
};
async function notifyBuyerOfStatus(db, orderId, to, extra) {
  try {
    if (!STATUS_COPY[to] || !process.env.BREVO_API_KEY) return;
    const snap = await db.collection('fulfillments').doc(orderId).get();
    const f = snap.exists ? snap.data() : null;
    if (!f || !f.buyerEmail) return;
    const e = extra || {};
    require('../email-shared').queueEmailBackground({
      templateKey: 'order_update',
      to: { email: f.buyerEmail },
      params: {
        order_id: orderId,
        product_name: f.productTitle || 'your order',
        new_status: to,
        status_message: STATUS_COPY[to],
        carrier: e.carrier || f.carrier || '',
        tracking_number: e.trackingNumber || f.trackingNumber || '',
        tracking_url: e.trackingUrl || f.trackingUrl || '',
        updated_at: new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' }) + ' WAT',
      },
    });
  } catch (err) {
    console.warn('buyer status email skipped:', err.message);
  }
}

const PROOF_MIME_TO_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const PROOF_MAX_BYTES = 8 * 1024 * 1024;

function proofError(message, code, status) {
  const e = new Error(message);
  e.code = code; e.status = status;
  return e;
}

// Optional doorstep/handoff photo attached when a buyer confirms delivery.
async function saveProofPhoto(orderId, fileBase64, mimeType) {
  const ext = PROOF_MIME_TO_EXT[mimeType];
  if (!ext) throw proofError(`Proof photo mimeType must be one of: ${Object.keys(PROOF_MIME_TO_EXT).join(', ')}.`, 'INVALID_MIME_TYPE', 422);
  const buffer = Buffer.from(fileBase64, 'base64');
  if (!buffer.length) throw proofError('The decoded proof photo is empty.', 'EMPTY_FILE', 422);
  if (buffer.length > PROOF_MAX_BYTES) throw proofError(`Proof photos must be ${PROOF_MAX_BYTES / (1024 * 1024)}MB or smaller.`, 'FILE_TOO_LARGE', 413);
  const storagePath = `fulfillment-proof/${orderId}/${crypto.randomUUID()}.${ext}`;
  await require('../file-storage').savePrivate(storagePath, buffer, mimeType);
  return storagePath;
}

module.exports = { createFulfillment, getFulfillment, applyFulfillmentPatch, saveProofPhoto, getDb: sharedGetDb };
