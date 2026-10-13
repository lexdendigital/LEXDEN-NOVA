// api/creator/fulfillment.js
//
// LEXDEN NOVA CREATOR — Stage E: Firestore-touching half of fulfillment.
// One doc per order; doc ID = the Paystack reference (1:1 with
// orders/{reference}).
const crypto = require('crypto');
const { getDb: sharedGetDb, FieldValue, getFirebaseBucket } = require('./shared');
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
  await ref.set({
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

async function applyFulfillmentPatch(db, orderId, to, extraFields) {
  const patch = { status: to, updatedAt: FieldValue.serverTimestamp(), ...(extraFields || {}) };
  const tsField = STATE_TIMESTAMP_FIELD[to];
  if (tsField) patch[tsField] = FieldValue.serverTimestamp();
  await db.collection('fulfillments').doc(orderId).set(patch, { merge: true });
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
  await getFirebaseBucket().file(storagePath).save(buffer, { contentType: mimeType, resumable: false });
  return storagePath;
}

module.exports = { createFulfillment, getFulfillment, applyFulfillmentPatch, saveProofPhoto, getDb: sharedGetDb };
