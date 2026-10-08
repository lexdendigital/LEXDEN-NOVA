// /api/creator-products.js
//
// LEXDEN NOVA CREATOR — Stage C.
//
// GET  /api/creator-products                 -> list own products (summary)
// GET  /api/creator-products?productId=X      -> one product + all its versions
// POST /api/creator-products { action, ... }
//   create_draft      { offeringType, ...fields }
//   update_draft       { productId, ...fields }   (only while latest version is DRAFT)
//   submit              { productId }               (validates, version -> PENDING_REVIEW)
//   create_new_version  { productId, ...fields }     (editing an already-PUBLISHED product)
//   pause / resume / archive  { productId }          (self-service, own PUBLISHED product only)
//
// Every action goes through requireActiveCreator (Stage A) — a suspended
// or revoked creator cannot create or edit products, full stop.
const {
  getDb, FieldValue, requireActiveCreator, getProductDoc, getVersionDoc,
  writeProductAuditLog, ok, fail, setCors,
} = require('./creator/shared');
const {
  PRODUCT_STATES, VERSION_STATES,
  assertProductTransition, assertVersionTransition,
  isVersionEditable, assertNoConcurrentVersion, assertProductNotBlocked,
} = require('./creator/product-state-machine');
const { validateProductDraft, validateProductForSubmit } = require('./creator/product-validation');

// Fields a creator may set on a version. Deliberately explicit allowlist
// (same reasoning as PUBLIC_FIELD_KEYS in creator-application.js) — a
// client can never smuggle in reviewedBy/status/versionNumber/etc. by just
// adding them to the request body.
const VERSION_FIELD_KEYS = [
  'title', 'description', 'category', 'images', 'price', 'currency', 'isFree', 'refundPolicy',
  // type-specific
  'stock', 'weightGrams', 'shippingOrigin',
  'fileAssetId', 'externalUrl', 'systemRequirements', 'pageCount', 'compatibility',
  'modules', 'level',
  'turnaround', 'deliverables',
  'billingInterval',
];
function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}
function publicSnapshotFromVersion(version) {
  // What would eventually be denormalized onto products/{id}.publishedSnapshot
  // for public storefront read — see CREATOR-STAGE-C-README.md. Excludes
  // nothing sensitive (there's nothing sensitive in a product version —
  // unlike creatorPrivate, there's no separate "private half" here).
  return pick(version.fields || {}, VERSION_FIELD_KEYS.concat(['offeringType']));
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  let decoded, creator;
  try {
    ({ decoded, creator } = await requireActiveCreator(req));
  } catch (e) {
    return fail(res, e);
  }
  const uid = decoded.uid;

  if (req.method === 'GET') {
    try {
      const productId = req.query && req.query.productId;
      if (productId) {
        const product = await getProductDoc(productId);
        if (!product || product.creatorId !== uid) return fail(res, { status: 404, code: 'NOT_FOUND', message: 'No product found.' });
        const versionsSnap = await getDb().collection('productVersions').where('productId', '==', productId).orderBy('versionNumber', 'asc').get();
        return ok(res, { product, versions: versionsSnap.docs.map(d => ({ id: d.id, ...d.data() })) });
      }
      const snap = await getDb().collection('products').where('creatorId', '==', uid).orderBy('updatedAt', 'desc').get();
      return ok(res, { products: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
    } catch (e) {
      return fail(res, e);
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' } });
  }

  const body = req.body || {};
  const action = body.action;

  try {
    if (action === 'create_draft') {
      const { ok: valid, errors } = validateProductDraft(body);
      if (!valid) return fail(res, { status: 422, code: 'VALIDATION_FAILED', message: 'Pick a valid offering type.', errors });

      const productRef = getDb().collection('products').doc();
      const versionRef = getDb().collection('productVersions').doc();
      assertProductTransition(null, PRODUCT_STATES.DRAFT);
      assertVersionTransition(null, VERSION_STATES.DRAFT);

      const batch = getDb().batch();
      batch.set(productRef, {
        creatorId: uid,
        offeringType: body.offeringType,
        status: PRODUCT_STATES.DRAFT,
        latestVersionId: versionRef.id,
        currentVersionId: null,
        publishedSnapshot: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      batch.set(versionRef, {
        productId: productRef.id,
        creatorId: uid,
        versionNumber: 1,
        status: VERSION_STATES.DRAFT,
        fields: { ...pick(body, VERSION_FIELD_KEYS), offeringType: body.offeringType },
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      await batch.commit();

      await writeProductAuditLog({ actorUid: uid, actorRole: 'creator', action: 'product.draft_created', productId: productRef.id, versionId: versionRef.id });
      return ok(res, { productId: productRef.id, versionId: versionRef.id, status: PRODUCT_STATES.DRAFT }, 201);
    }

    if (action === 'update_draft') {
      const { productId } = body;
      const product = await getProductDoc(productId);
      if (!product || product.creatorId !== uid) return fail(res, { status: 404, code: 'NOT_FOUND', message: 'No product found.' });
      assertProductNotBlocked(product.status);
      const version = await getVersionDoc(product.latestVersionId);
      if (!version || !isVersionEditable(version.status)) {
        return fail(res, { status: 409, code: 'NOT_EDITABLE', message: `Cannot edit — the latest version is ${version ? version.status : 'missing'}.` });
      }
      await getDb().collection('productVersions').doc(version.id).set({
        fields: { ...version.fields, ...pick(body, VERSION_FIELD_KEYS) },
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      await getDb().collection('products').doc(productId).set({ updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return ok(res, { status: product.status });
    }

    if (action === 'submit') {
      const { productId } = body;
      const product = await getProductDoc(productId);
      if (!product || product.creatorId !== uid) return fail(res, { status: 404, code: 'NOT_FOUND', message: 'No product found.' });
      assertProductNotBlocked(product.status);
      const version = await getVersionDoc(product.latestVersionId);
      if (!version) return fail(res, { status: 409, code: 'NO_DRAFT', message: 'Nothing to submit.' });

      const { ok: valid, errors } = validateProductForSubmit(version.fields);
      if (!valid) return fail(res, { status: 422, code: 'VALIDATION_FAILED', message: 'This listing is missing required information.', errors });

      assertVersionTransition(version.status, VERSION_STATES.PENDING_REVIEW);
      assertProductTransition(product.status, PRODUCT_STATES.SUBMITTED);

      const batch = getDb().batch();
      batch.set(getDb().collection('productVersions').doc(version.id), { status: VERSION_STATES.PENDING_REVIEW, submittedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      batch.set(getDb().collection('products').doc(productId), { status: PRODUCT_STATES.SUBMITTED, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      await batch.commit();

      await writeProductAuditLog({ actorUid: uid, actorRole: 'creator', action: 'product.submitted', productId, versionId: version.id });
      return ok(res, { status: PRODUCT_STATES.SUBMITTED });
    }

    if (action === 'create_new_version') {
      const { productId } = body;
      const product = await getProductDoc(productId);
      if (!product || product.creatorId !== uid) return fail(res, { status: 404, code: 'NOT_FOUND', message: 'No product found.' });
      assertProductNotBlocked(product.status);
      const latest = await getVersionDoc(product.latestVersionId);
      assertNoConcurrentVersion(latest ? latest.status : null);

      const versionRef = getDb().collection('productVersions').doc();
      assertVersionTransition(null, VERSION_STATES.DRAFT);
      await versionRef.set({
        productId,
        creatorId: uid,
        versionNumber: (latest ? latest.versionNumber : 0) + 1,
        status: VERSION_STATES.DRAFT,
        // Seed from the last known fields (published snapshot if we have
        // one, else the latest version) so an edit starts from "what's
        // live now," not a blank form.
        fields: { ...((product.publishedSnapshot) || (latest && latest.fields) || {}), ...pick(body, VERSION_FIELD_KEYS) },
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      await getDb().collection('products').doc(productId).set({ latestVersionId: versionRef.id, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

      await writeProductAuditLog({ actorUid: uid, actorRole: 'creator', action: 'product.new_version_started', productId, versionId: versionRef.id });
      return ok(res, { versionId: versionRef.id, status: VERSION_STATES.DRAFT }, 201);
    }

    if (action === 'pause' || action === 'resume' || action === 'archive') {
      const { productId } = body;
      const product = await getProductDoc(productId);
      if (!product || product.creatorId !== uid) return fail(res, { status: 404, code: 'NOT_FOUND', message: 'No product found.' });
      const to = action === 'pause' ? PRODUCT_STATES.PAUSED : action === 'resume' ? PRODUCT_STATES.PUBLISHED : PRODUCT_STATES.ARCHIVED;
      assertProductTransition(product.status, to);
      await getDb().collection('products').doc(productId).set({ status: to, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      await writeProductAuditLog({ actorUid: uid, actorRole: 'creator', action: `product.${action}`, productId });
      return ok(res, { status: to });
    }

    return fail(res, { status: 400, code: 'INVALID_ACTION', message: `Unknown action "${action}".` });
  } catch (e) {
    return fail(res, e);
  }
};
