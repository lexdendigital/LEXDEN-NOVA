// api/creator/entitlements.js
//
// LEXDEN NOVA CREATOR — Stage D: digital delivery (entitlements + signed
// URLs). The "order paid -> entitlement issued -> signed URL" pipeline
// from the blueprint's §11, which both Stage A's creator-documents.js and
// Stage C's creator-product-assets.js explicitly deferred to this stage.
//
// Same documented deviation as Stage C: the blueprint specs Cloudflare R2
// for delivery; R2 isn't provisioned anywhere in this app. Delivery uses
// Firebase Storage V4 signed URLs off the same private bucket
// creator-product-assets.js already writes paid files into — one storage
// provider for the whole asset lifecycle (upload in Stage C, download
// here), not two.
//
// Three pieces, same split the rest of this codebase uses (pure decision
// logic vs. the thin I/O wrapper around it), so the decisions themselves
// are unit-testable without a Firestore emulator:
//   1. grantEntitlement()        — write side, called from
//      verify-paystack.js the moment a creator-product order is written.
//   2. findActiveEntitlement() /
//      getEntitlement()          — read side, used by
//      creator-product-download.js and creator-entitlements.js.
//   3. canDownloadAsset() /
//      resolveCreatorProductPrice() — pure, no I/O. See
//      test/entitlements.test.js.
const { getDb: sharedGetDb, FieldValue } = require('./shared');

// Deterministic so a retried verify-paystack.js call (it already
// short-circuits on orders/{reference} existing, and additionally retries
// the grant itself on that short-circuit path — see verify-paystack.js)
// can never double-grant, and never silently resurrects a revoked
// entitlement by overwriting it with a second "grant" write.
function entitlementId(orderId, productId) {
  return `${orderId}_${productId}`;
}

// Pure allow/deny decision for "may this entitlement be used to download
// right now." Takes a plain entitlement object (or null) — never touches
// Firestore itself — so this exact decision is unit-testable with
// hand-built fixtures instead of an emulator.
function canDownloadAsset(entitlement) {
  if (!entitlement) return { allowed: false, reason: 'NO_ENTITLEMENT' };
  if (entitlement.status === 'revoked') return { allowed: false, reason: 'REVOKED' };
  if (entitlement.status !== 'active') return { allowed: false, reason: 'NOT_ACTIVE' };
  return { allowed: true, reason: null };
}

// Pure. Mirrors verify-paystack.js's getExpectedAmount() contract
// EXACTLY on purpose: null means "can't validate" and the caller must
// treat that as "do not fulfill," never as "free" or "trust the client."
// `product` is a products/{id} doc (id + data merged); `currency` is the
// currency actually paid, from Paystack's own verified response.
function resolveCreatorProductPrice(product, currency) {
  if (!product || product.status !== 'PUBLISHED') return null;
  const snap = product.publishedSnapshot;
  if (!snap) return null;
  if (snap.isFree === true) {
    return { price: 0, currency: currency || snap.currency || null, title: snap.title || null };
  }
  if (typeof snap.price !== 'number' || !(snap.price > 0)) return null;
  // A currency mismatch between what the product was published in and
  // what was actually paid can't be safely reconciled here (this file has
  // no exchange-rate source of truth — that lives in catalog/settings,
  // which is the legacy-catalog path's job, not a creator product's) — so
  // treat it the same as "can't validate," not as an approximate match.
  if (snap.currency && currency && snap.currency !== currency) return null;
  return { price: snap.price, currency: snap.currency || currency || null, title: snap.title || null };
}

// Idempotent grant. Safe to call more than once for the same
// (orderId, productId) pair — a second call is a no-op that returns
// created:false rather than re-writing (and potentially un-revoking) an
// existing entitlement.
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

// A buyer can be identified by uid (signed in at purchase time) or email
// (verify-paystack.js allows guest checkout — uid may be null). Checks
// both because the same person might be signed out, or on a different
// device, when they come back later to actually download.
async function findActiveEntitlement(db, { uid, email, productId }) {
  const lookups = [];
  if (uid) {
    lookups.push(
      db.collection('entitlements')
        .where('productId', '==', productId)
        .where('buyerUid', '==', uid)
        .where('status', '==', 'active')
        .limit(1)
        .get()
    );
  }
  if (email) {
    lookups.push(
      db.collection('entitlements')
        .where('productId', '==', productId)
        .where('buyerEmail', '==', email)
        .where('status', '==', 'active')
        .limit(1)
        .get()
    );
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
