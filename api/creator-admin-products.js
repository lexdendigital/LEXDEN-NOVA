// /api/creator-admin-products.js
//
// LEXDEN NOVA CREATOR — Stage C. Admin-only.
//
// GET  /api/creator-admin-products?status=SUBMITTED  -> review queue
// POST /api/creator-admin-products
//   Version-stage decisions:  { productId, action: 'start_review' | 'request_changes' | 'reject' | 'approve', reason? }
//     'approve' auto-publishes in the same call (version -> APPROVED ->
//     PUBLISHED, product -> APPROVED -> PUBLISHED, previous published
//     version -> SUPERSEDED, products/{id}.publishedSnapshot updated) —
//     matches the blueprint §10 diagram where approval leads straight to
//     publish, same auto-advance Stage A uses for creator approval.
//   Product-stage admin actions: { productId, action: 'suspend' | 'reinstate' | 'archive', reason? }
const {
  getDb, FieldValue, requireAdminAuth, getProductDoc, getVersionDoc,
  writeProductAuditLog, ok, fail, setCors,
} = require('./creator/shared');
const {
  PRODUCT_STATES, VERSION_STATES,
  assertProductTransition, assertVersionTransition,
} = require('./creator/product-state-machine');

const VERSION_ACTIONS = {
  start_review: { from: [VERSION_STATES.PENDING_REVIEW], productTo: PRODUCT_STATES.IN_REVIEW, reasonRequired: false },
  request_changes: { productTo: PRODUCT_STATES.CHANGES_REQUESTED, reasonRequired: true },
  reject: { versionTo: VERSION_STATES.REJECTED, productTo: PRODUCT_STATES.REJECTED, reasonRequired: true },
  approve: { versionTo: VERSION_STATES.APPROVED, productTo: PRODUCT_STATES.APPROVED, reasonRequired: false },
};
const PRODUCT_ACTIONS = {
  suspend: { to: PRODUCT_STATES.SUSPENDED, reasonRequired: true, reasonField: 'suspendReason' },
  reinstate: { to: PRODUCT_STATES.PUBLISHED, reasonRequired: false, reasonField: null },
  archive: { to: PRODUCT_STATES.ARCHIVED, reasonRequired: false, reasonField: 'archiveReason' },
};

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  let admin;
  try {
    admin = await requireAdminAuth(req);
  } catch (e) {
    return fail(res, e);
  }

  if (req.method === 'GET') {
    try {
      const status = req.query && req.query.status;
      let query = getDb().collection('products');
      if (status) query = query.where('status', '==', status);
      const snap = await query.orderBy('updatedAt', 'desc').limit(100).get();
      const items = await Promise.all(snap.docs.map(async d => {
        const product = { id: d.id, ...d.data() };
        const version = product.latestVersionId ? await getVersionDoc(product.latestVersionId) : null;
        return { ...product, latestVersion: version };
      }));
      return ok(res, { products: items });
    } catch (e) {
      return fail(res, e);
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' } });
  }

  const { productId, action, reason } = req.body || {};
  if (typeof productId !== 'string' || !productId) return fail(res, { status: 422, code: 'MISSING_PRODUCT_ID', message: 'productId is required.' });

  try {
    if (Object.prototype.hasOwnProperty.call(VERSION_ACTIONS, action)) {
      const spec = VERSION_ACTIONS[action];
      if (spec.reasonRequired && (typeof reason !== 'string' || !reason.trim())) {
        return fail(res, { status: 422, code: 'REASON_REQUIRED', message: `A reason is required for "${action}".` });
      }
      const product = await getProductDoc(productId);
      if (!product) return fail(res, { status: 404, code: 'NOT_FOUND', message: 'No product found.' });
      const version = await getVersionDoc(product.latestVersionId);
      if (!version) return fail(res, { status: 409, code: 'NO_VERSION', message: 'This product has no version to review.' });

      assertProductTransition(product.status, spec.productTo);
      if (spec.versionTo) assertVersionTransition(version.status, spec.versionTo);

      const batch = getDb().batch();
      const versionPatch = { updatedAt: FieldValue.serverTimestamp() };
      if (spec.versionTo) versionPatch.status = spec.versionTo;
      if (action === 'request_changes') versionPatch.changeRequestReason = reason.trim();
      if (action === 'reject') versionPatch.rejectionReason = reason.trim();
      batch.set(getDb().collection('productVersions').doc(version.id), versionPatch, { merge: true });

      const productPatch = { status: spec.productTo, updatedAt: FieldValue.serverTimestamp(), reviewedBy: admin.uid };
      if (action === 'request_changes') productPatch.changeRequestReason = reason.trim();
      if (action === 'reject') productPatch.rejectionReason = reason.trim();
      batch.set(getDb().collection('products').doc(productId), productPatch, { merge: true });
      await batch.commit();
      await writeProductAuditLog({ actorUid: admin.uid, actorRole: 'admin', action: `product.${action}`, productId, versionId: version.id, reason: reason || null });

      // Auto-publish, in a second batch (Firestore batches are all-writes,
      // no reads in between — the SUPERSEDED lookup below needs the
      // product doc's CURRENT currentVersionId, which the first batch
      // may have just changed semantics around, so this stays a separate,
      // clearly sequenced step rather than guessing at ordering within
      // one batch).
      if (action === 'approve') {
        assertVersionTransition(VERSION_STATES.APPROVED, VERSION_STATES.PUBLISHED);
        assertProductTransition(PRODUCT_STATES.APPROVED, PRODUCT_STATES.PUBLISHED);
        const publishBatch = getDb().batch();
        publishBatch.set(getDb().collection('productVersions').doc(version.id), { status: VERSION_STATES.PUBLISHED, publishedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        if (product.currentVersionId && product.currentVersionId !== version.id) {
          assertVersionTransition(VERSION_STATES.PUBLISHED, VERSION_STATES.SUPERSEDED);
          publishBatch.set(getDb().collection('productVersions').doc(product.currentVersionId), { status: VERSION_STATES.SUPERSEDED, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        }
        publishBatch.set(getDb().collection('products').doc(productId), {
          status: PRODUCT_STATES.PUBLISHED,
          currentVersionId: version.id,
          publishedSnapshot: version.fields,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        await publishBatch.commit();
        await writeProductAuditLog({ actorUid: admin.uid, actorRole: 'admin', action: 'product.published', productId, versionId: version.id });
      }

      return ok(res, { status: action === 'approve' ? PRODUCT_STATES.PUBLISHED : spec.productTo });
    }

    if (Object.prototype.hasOwnProperty.call(PRODUCT_ACTIONS, action)) {
      const spec = PRODUCT_ACTIONS[action];
      if (spec.reasonRequired && (typeof reason !== 'string' || !reason.trim())) {
        return fail(res, { status: 422, code: 'REASON_REQUIRED', message: `A reason is required for "${action}".` });
      }
      const product = await getProductDoc(productId);
      if (!product) return fail(res, { status: 404, code: 'NOT_FOUND', message: 'No product found.' });
      assertProductTransition(product.status, spec.to);
      const patch = { status: spec.to, updatedAt: FieldValue.serverTimestamp() };
      if (spec.reasonField && reason) patch[spec.reasonField] = reason.trim();
      await getDb().collection('products').doc(productId).set(patch, { merge: true });
      await writeProductAuditLog({ actorUid: admin.uid, actorRole: 'admin', action: `product.${action}`, productId, reason: reason || null });
      return ok(res, { status: spec.to });
    }

    return fail(res, { status: 400, code: 'INVALID_ACTION', message: `Unknown action "${action}".` });
  } catch (e) {
    return fail(res, e);
  }
};
