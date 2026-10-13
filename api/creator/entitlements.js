// api/creator/entitlements.js
//
// LEXDEN NOVA CREATOR — Stage D: digital delivery (entitlements + signed
// URLs). The "order paid -> entitlement issued -> signed URL" pipeline
// from the blueprint's §11, which Stage A's creator-documents.js and
// Stage C's creator-product-assets.js explicitly deferred to this stage.
//
// Same documented deviation as Stage C: the blueprint specs Cloudflare R2
// for delivery; R2 isn't provisioned anywhere in this app. Delivery uses
// Firebase Storage V4 signed URLs off the same private bucket
// creator-product-assets.js already writes paid files into.
//
// Split the way the rest of this codebase splits things: pure decision
// logic (unit-tested, no I/O) vs. thin Firestore wrappers.
const { getDb: sharedGetDb, FieldValue } = require('./shared');

// Deterministic so a retried verify-paystack.js call can never
// double-grant, and never resurrects a revoked entitlement.
function entitlementId(orderId, productId) {
  return `${orderId}_${productId}`;
}

function canDownloadAsset(entitlement) {
  if (!entitlement) return { allowed: false, reason: 'NO_ENTITLEMENT' };
  if (entitlement.status === 'revoked') return { allowed: false, reason: 'REVOKED' };
  if (entitlement.status !== 'active') return { allowed: false, reason: 'NOT_ACTIVE' };
  return { allowed: true, reason: null };
}

// Pure. null means "can't validate" and the caller must treat that as
// "do not fulfill", never as "free" or "trust the client".
function resolveCreatorProductPrice(product, currency) {
  if (!product || product.status !== 'PUBLISHED') return null;
  const snap = product.publishedSnapshot;
  if (!snap) return null;
  if (snap.isFree === true) {
    return { price: 0, currency: currency || snap.currency || null, title: snap.title || null };
  }
  if (typeof snap.price !== 'number' || !(snap.price > 0)) return null;
  // No exchange-rate source of truth here, so a currency mismatch is
  // "can't validate", not an approximate match.
  if (snap.currency && currency && snap.currency !== currency) return null;
  return { price: snap.price, currency: snap.currency || currency || null, title: snap.title || null };
}

async function grantEntitlement(db, { orderId, productId, versionId, buyerUid, buyerEmail, assetIds, price, currency, productTitle }) {
  const id = entitlementId(orderId, productId);
  const ref = db.collection('entitlements').doc(id);
  const existing = await ref.get();
  if (existing.exists) return { id, created: false };
  await ref.set({
    orderId,
    productId,
    versionId: versionId || null,
    buyerUid: buyerUid || null,
    buyerEmail: buyerEmail || null,
    assetIds: Array.isArray(assetIds) ? assetIds : [],
    price: typeof price === 'number' ? price : null,
    currency: currency || null,
    productTitle: productTitle || null,
    status: 'active',
    grantedAt: FieldValue.serverTimestamp(),
  });
  return { id, created: true };
}

async function getEntitlement(db, orderId, productId) {
  const snap = await db.collection('entitlements').doc(entitlementId(orderId, productId)).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

// Guest checkout means uid can be null, so match on uid OR email.
async function findActiveEntitlement(db, { uid, email, productId }) {
  const lookups = [];
  if (uid) {
    lookups.push(db.collection('entitlements')
      .where('productId', '==', productId).where('buyerUid', '==', uid).where('status', '==', 'active').limit(1).get());
  }
  if (email) {
    lookups.push(db.collection('entitlements')
      .where('productId', '==', productId).where('buyerEmail', '==', email).where('status', '==', 'active').limit(1).get());
  }
  if (!lookups.length) return null;
  const results = await Promise.all(lookups);
  for (const snap of results) {
    if (!snap.empty) {
      const d = snap.docs[0];
      return { id: d.id, ...d.data() };
    }
  }
  return null;
}

module.exports = {
  entitlementId, canDownloadAsset, resolveCreatorProductPrice,
  grantEntitlement, getEntitlement, findActiveEntitlement,
  getDb: sharedGetDb,
};
