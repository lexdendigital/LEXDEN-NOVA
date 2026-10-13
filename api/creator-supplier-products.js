// /api/creator-supplier-products.js
//
// LEXDEN NOVA CREATOR — Stage G. The CJ mapping of a creator's dropship
// listing, and its supplier-health check.
//
// GET  /api/creator-supplier-products                -> own mappings
// GET  /api/creator-supplier-products?productId=X     -> mappings of one product
// POST /api/creator-supplier-products { action, productId, ... }
//   test_mapping  { productId, cjVariantId, cjProductId?, sku?, declaredCostUsd?,
//                   logisticName?, destinationCountries?, stockThreshold? }
//        Saves the mapping on the product's editable DRAFT version and tests
//        it against the creator's own CJ account (variant exists, stock,
//        shipping to every destination). Required before submit/approval.
//   check_health  { productId }
//        Re-checks a PUBLISHED dropship listing; a broken supplier side
//        PAUSES it (blueprint §86). Rate limited to one check a minute.
const { getDb, requireActiveCreator, ok, fail, setCors } = require('./creator/shared');
const supplier = require('./supplier/service');
const store = require('./supplier/store');

module.exports = async function handler(req, res) {
  setCors(res);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  let decoded;
  try {
    ({ decoded } = await requireActiveCreator(req));
  } catch (e) {
    return fail(res, e);
  }
  const uid = decoded.uid;
  const db = getDb();

  if (req.method === 'GET') {
    try {
      let mappings = await store.listMappingsForCreator(db, uid);
      const productId = req.query && req.query.productId;
      if (productId) mappings = mappings.filter((m) => m.productId === productId);
      return ok(res, { mappings });
    } catch (e) {
      return fail(res, e);
    }
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' } });
  }

  const body = req.body || {};
  if (typeof body.productId !== 'string' || !body.productId) {
    return fail(res, { status: 422, code: 'MISSING_PRODUCT_ID', message: 'productId is required.' });
  }
  try {
    if (body.action === 'test_mapping') {
      const { action, productId, ...input } = body;
      return ok(res, await supplier.testMapping(db, { uid, productId, input }));
    }
    if (body.action === 'check_health') {
      const product = await store.getProduct(db, body.productId);
      if (!product || product.creatorId !== uid) return fail(res, { status: 404, code: 'NOT_FOUND', message: 'No product found.' });
      return ok(res, await supplier.checkMappingHealth(db, { productId: body.productId, minGapMs: 60 * 1000 }));
    }
    return fail(res, { status: 400, code: 'INVALID_ACTION', message: `Unknown action "${body.action}".` });
  } catch (e) {
    return fail(res, e);
  }
};
