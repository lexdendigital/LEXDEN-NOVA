// /api/cj-stock.js
//
// LEXDEN NOVA × CJ — live CJ inventory for one or more variant IDs, with
// an OPTIONAL write-back into catalog/products (README §5.4 "Update
// Firestore stock values"). Read-only unless `sync=1` is passed.
//
// CONTRACT
// GET /api/cj-stock?vid=A,B,C
//   -> { ok:true, stock:{ A:{ total, inStock }, B:{...}, C:{...} } }
// GET /api/cj-stock?vid=A,B,C&sync=1&productId=nova_product_001
//   -> same, PLUS writes physical.stockStatus / physical.cj.lastSyncedAt
//      for the matching product doc in catalog/products.list

const { setCors, cjFetch, writeSyncLog, getProductsDoc, saveProductsDoc } = require('./cj-shared');

// CJ returns one or more warehouse/area rows per variant — never assume a
// single number is the whole picture (README §5.4). "In stock" = any
// warehouse with usable quantity above zero; total = sum across warehouses.
function summarizeStockRows(rows) {
  const list = Array.isArray(rows) ? rows : (rows ? [rows] : []);
  let total = 0;
  const byWarehouse = [];
  for (const row of list) {
    const qty = Number(row.storageNum ?? row.stockNum ?? row.num ?? row.availableQty ?? 0) || 0;
    total += qty;
    byWarehouse.push({
      area: row.countryCode || row.areaEn || row.storageName || 'Unknown',
      qty,
    });
  }
  return { total, inStock: total > 0, byWarehouse };
}

module.exports = async (req, res) => {
  setCors(req, res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const vids = String(req.query.vid || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 20);
  if (!vids.length) return res.status(200).json({ ok: false, error: 'Provide at least one vid.' });

  const started = Date.now();
  const stock = {};
  const errors = {};

  try {
    // CJ's stock endpoint is per-variant — fan out, but keep it modest
    // (max 20 above) so an import screen can't accidentally hammer CJ.
    await Promise.all(vids.map(async vid => {
      const r = await cjFetch('/product/stock/queryByVid', { query: { vid } });
      if (r.ok) stock[vid] = summarizeStockRows(r.data);
      else errors[vid] = r.message;
    }));

    const tookMs = Date.now() - started;
    await writeSyncLog({
      event: 'stock.query', success: Object.keys(errors).length === 0, tookMs,
      message: `${Object.keys(stock).length}/${vids.length} variants resolved`,
    });

    // ---- optional Firestore write-back ----
    if (String(req.query.sync || '') === '1' && req.query.productId) {
      const productId = String(req.query.productId);
      const doc = await getProductsDoc();
      const list = Array.isArray(doc.list) ? doc.list : [];
      const idx = list.findIndex(p => p && String(p.id) === productId);
      if (idx !== -1) {
        const p = { ...list[idx] };
        const phys = { ...(p.physical || {}) };
        const anyInStock = Object.values(stock).some(s => s.inStock);
        phys.stockStatus = anyInStock ? 'in_stock' : 'out_of_stock';
        phys.cj = { ...(phys.cj || {}), lastSyncedAt: new Date().toISOString() };
        p.physical = phys;
        list[idx] = p;
        await saveProductsDoc(list);
      }
    }

    return res.status(200).json({ ok: true, stock, errors: Object.keys(errors).length ? errors : undefined });
  } catch (e) {
    await writeSyncLog({ event: 'stock.query', success: false, message: e.message, tookMs: Date.now() - started });
    return res.status(200).json({ ok: false, error: 'Stock lookup failed.' });
  }
};
