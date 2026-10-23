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
async function createFulfillment(db, { orderId, productId, versionId, creatorId, buyerUid, buyerEmail, delivery, productTitle, fulfillmentMode, processingDays, nowMs, exceptionOpen }) {
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
      ...(exceptionOpen ? { exceptionOpen: true } : {}),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    if (e && (e.code === 6 || /ALREADY_EXISTS/i.test(String(e.message)))) return { id: orderId, created: false };
    throw e;
  }
  // Stock is NOT touched here any more: the inventory service consumes the checkout
  // reservation exactly once (api/creator/checkout.js settleStock), keyed on the order.
  return { id: orderId, created: true };
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

// Which evidence source a DELIVERED transition represents. Sources stay DISTINCT
// (carrier / buyer / code / admin / creator) so a creator's own claim is never
// mistaken for buyer or carrier proof, and only authoritative ones start the
// creator-earning release clock (api/core/config.js AUTHORITATIVE_EVIDENCE).
const CONFIRMED_BY_TO_SOURCE = Object.freeze({ buyer: 'BUYER_CONFIRMED', admin: 'ADMIN_VERIFIED', creator: 'CREATOR_REPORTED', system: 'CARRIER', carrier: 'CARRIER' });

async function applyFulfillmentPatch(db, orderId, to, extraFields) {
  const patch = { status: to, updatedAt: FieldValue.serverTimestamp(), ...(extraFields || {}) };
  const tsField = STATE_TIMESTAMP_FIELD[to];
  if (tsField) patch[tsField] = FieldValue.serverTimestamp();
  let evidence = null;
  if (to === FULFILLMENT_STATES.DELIVERED) {
    const atMs = Date.now();
    const source = (extraFields && extraFields.deliveryEvidenceSource) || CONFIRMED_BY_TO_SOURCE[extraFields && extraFields.deliveryConfirmedBy] || 'CREATOR_REPORTED'; // unknown => NOT authoritative
    evidence = { source, atMs };
    patch.deliveredAtMs = atMs;
    patch.deliveryEvidenceSource = source;
  }
  await db.collection('fulfillments').doc(orderId).set(patch, { merge: true });
  if (evidence) await syncLedgerDelivery(db, orderId, evidence);
  await notifyBuyerOfStatus(db, orderId, to, extraFields);
}

// Starts the earning release clock on the matching sale. If the ledger write fails the
// fulfilment is flagged (ledgerSyncPending) and the `holds` job retries from the
// fulfilment record, so a delivered order can never silently stay locked or be released early.
async function syncLedgerDelivery(db, orderId, evidence) {
  try {
    await require('./ledger').markDelivered(db, orderId, evidence);
  } catch (e) {
    console.error('ledger delivery sync failed (will be retried by the holds job):', e && e.message);
    await db.collection('fulfillments').doc(orderId).set({ ledgerSyncPending: true }, { merge: true }).catch(() => {});
  }
}

/**
 * Records delivery evidence WITHOUT changing the fulfilment status (e.g. the
 * carrier/CJ says "delivered" while the buyer has not pressed "I received it").
 * Authoritative evidence starts the earning release clock; the evidence trail keeps
 * every source separately with its provider reference.
 */
async function recordDeliveryEvidence(db, orderId, { source, atMs = Date.now(), reference = null }) {
  const ref = db.collection('fulfillments').doc(orderId);
  const snap = await ref.get();
  if (!snap.exists) return { recorded: false, reason: 'NOT_FOUND' };
  const f = snap.data();
  const trail = Array.isArray(f.evidenceTrail) ? f.evidenceTrail.slice(-19) : [];
  if (trail.some((e) => e.source === source && e.reference === reference && reference)) return { recorded: false, reason: 'DUPLICATE' };
  trail.push({ source, atMs, reference });
  await ref.set({ evidenceTrail: trail }, { merge: true });
  await syncLedgerDelivery(db, orderId, { source, atMs });
  return { recorded: true };
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

module.exports = { createFulfillment, getFulfillment, applyFulfillmentPatch, recordDeliveryEvidence, syncLedgerDelivery, saveProofPhoto, getDb: sharedGetDb };
