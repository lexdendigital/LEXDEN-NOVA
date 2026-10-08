// /api/creator-product-download.js
//
// LEXDEN NOVA CREATOR — Stage D.
//
// GET /api/creator-product-download?productId=X
// Auth required (any signed-in buyer — does NOT require requireActiveCreator;
// a buyer need not be a creator themselves). Checks the caller has an
// active entitlement for productId, then mints short-lived signed URLs
// for every asset that entitlement covers. This is the "get it back OUT
// to a paying buyer" half that creator-product-assets.js's own
// file-level comment explicitly deferred to Stage D.
//
// Response: { ok:true, data: { links: [{ assetId, fileName, mimeType,
//            url, expiresAt }] } }
const { requireAuth, getDb, getFirebaseBucket, writeProductAuditLog, ok, fail, setCors } = require('./creator/shared');
const { findActiveEntitlement, canDownloadAsset } = require('./creator/entitlements');

// Long enough for a real download of an 8MB file (Stage C's own MAX_BYTES
// cap) even on a slow connection; short enough that a link pasted
// somewhere public stops working well within the same day.
const SIGNED_URL_TTL_MS = 10 * 60 * 1000;

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' } });
  }

  let decoded;
  try {
    decoded = await requireAuth(req);
  } catch (e) {
    return fail(res, e);
  }

  const productId = req.query && req.query.productId;
  if (typeof productId !== 'string' || !productId) {
    return fail(res, { status: 422, code: 'MISSING_PRODUCT_ID', message: 'productId is required.' });
  }

  try {
    const db = getDb();
    const entitlement = await findActiveEntitlement(db, { uid: decoded.uid, email: decoded.email, productId });
    const decision = canDownloadAsset(entitlement);
    if (!decision.allowed) {
      // NO_ENTITLEMENT and REVOKED are both "you may not have this" —
      // deliberately the same 403 either way so this endpoint can never
      // be used to probe whether a given productId was ever purchased by
      // anyone, revoked or not.
      return fail(res, { status: 403, code: decision.reason || 'NOT_ENTITLED', message: 'You do not have access to download this product. If you believe this is wrong, contact support with your order reference.' });
    }

    const assetIds = Array.isArray(entitlement.assetIds) ? entitlement.assetIds : [];
    if (!assetIds.length) {
      return fail(res, { status: 404, code: 'NO_ASSETS', message: 'This product has no downloadable file on record. Contact support with your order reference.' });
    }

    const bucket = getFirebaseBucket();
    const expiresAtMs = Date.now() + SIGNED_URL_TTL_MS;
    const links = [];
    for (const assetId of assetIds) {
      const assetSnap = await db.collection('productAssets').doc(assetId).get();
      if (!assetSnap.exists) continue; // asset metadata missing/removed — skip, don't fail the whole request over one bad id
      const asset = assetSnap.data();
      const [url] = await bucket.file(asset.storagePath).getSignedUrl({ action: 'read', expires: expiresAtMs });
      links.push({
        assetId,
        fileName: asset.fileName || null,
        mimeType: asset.mimeType || null,
        url,
        expiresAt: new Date(expiresAtMs).toISOString(),
      });
    }

    if (!links.length) {
      return fail(res, { status: 404, code: 'NO_ASSETS', message: 'This product has no downloadable file on record. Contact support with your order reference.' });
    }

    await writeProductAuditLog({
      actorUid: decoded.uid, actorRole: 'buyer', action: 'download.issued',
      productId, metadata: { assetIds: links.map(l => l.assetId), entitlementId: entitlement.id },
    });

    return ok(res, { links });
  } catch (e) {
    return fail(res, e);
  }
};
