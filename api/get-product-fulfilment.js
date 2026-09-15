// /api/get-product-fulfilment.js
//
// LEXDEN NOVA — tiny read-only lookup used by the Make.com automation
// (Scenario 1's physical-order route) to find which supplier fulfils a
// given product, without re-verifying payment or touching any secret.
//
// WHY THIS EXISTS
// Make needs to know, for a PHYSICAL order that just got paid, which
// supplier to route it to (product.physical.supplierId/routing). The
// only place that data lives is Firestore's catalog/products doc — the
// same one verify-paystack.js already reads for price-checking. Rather
// than have Make fetch that whole document and filter it product-by-
// product (which burns one Make "operation" per product in the catalog,
// on every single order — expensive on a capped plan), this returns
// just the one matching product's fulfilment-relevant fields as plain
// JSON. No auth required to call this: it returns nothing sensitive
// (supplierCost/supplierCurrency ARE included, since Make's fulfilment
// routing needs them for the minMargin/maxCost checks — this endpoint
// is for the automation pipeline, not the public storefront, so it
// intentionally exposes what screenProductDetail() on the site itself
// deliberately never does).
//
// CONTRACT
// Request:  GET /api/get-product-fulfilment?id=<productId>
// Response: 200 { ok:true, found:true, productType, physical:{...} }
//           200 { ok:true, found:false }              — no such product
//           200 { ok:false, error:'...' }              — bad/missing id
//
// No environment variables required beyond what _shared.js already uses.

const { getCatalogDoc } = require('./_shared');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  const id = String((req.query && req.query.id) || '').trim();
  if (!id) {
    res.status(200).json({ ok: false, error: 'missing id' });
    return;
  }

  try {
    const catalog = await getCatalogDoc('products');
    const list = catalog && Array.isArray(catalog.list) ? catalog.list : [];
    const product = list.find(p => p && String(p.id) === id);

    if (!product) {
      res.status(200).json({ ok: true, found: false });
      return;
    }

    res.status(200).json({
      ok: true,
      found: true,
      productType: product.productType || null,
      productName: product.name || null,
      physical: product.physical || null,
    });
  } catch (e) {
    console.error('get-product-fulfilment failed for', id, e);
    res.status(200).json({ ok: false, error: 'lookup failed' });
  }
};
