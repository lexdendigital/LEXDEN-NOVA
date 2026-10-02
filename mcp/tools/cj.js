// mcp/tools/cj.js
const { z } = require('zod');
const { callHandler } = require('../lib/callHandler');
const { getDb } = require('../../api/affiliate/shared');
const { listCatalogDoc, upsertCatalogItem } = require('../lib/settings');
const { uniqueUrls, buildProductSpecs, stockStatusFrom } = require('../lib/productImport');
const cjShared = require('../../api/cj-shared');

const cjProductsHandler = require('../../api/cj-products');
const cjProductHandler = require('../../api/cj-product');
const cjStockHandler = require('../../api/cj-stock');
const cjOrdersHandler = require('../../api/cj-orders');
const cjOrderHandler = require('../../api/cj-order');
const cjShippingHandler = require('../../api/cj-shipping');
const cjTrackingHandler = require('../../api/cj-tracking');

function register(server) {
  server.registerTool('nova_cj_connection_status', {
    title: 'Check CJ Dropshipping connection',
    description: 'Confirms whether this server can currently obtain a valid CJ Dropshipping API token (i.e. the CJ integration is configured and working). Never returns the token itself.',
    inputSchema: {},
  }, async () => {
    try {
      await cjShared.getValidToken();
      return { content: [{ type: 'text', text: JSON.stringify({ connected: true }) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: JSON.stringify({ connected: false, error: e.message }) }] };
    }
  });

  server.registerTool('nova_cj_search_products', {
    title: 'Search CJ Dropshipping products',
    description: 'Searches CJ\'s product catalog by keyword/category — for finding products to import, not your own store catalog (use nova_list_products for that).',
    inputSchema: {
      keyword: z.string().optional(), categoryId: z.string().optional(),
      page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(50).default(20),
      countryCode: z.string().default('NG'),
    },
  }, async (args) => {
    const r = await callHandler(cjProductsHandler, { method: 'GET', query: { mode: 'search', ...args } });
    return { content: [{ type: 'text', text: JSON.stringify(r.body, null, 2) }] };
  });

  server.registerTool('nova_cj_list_categories', {
    title: 'List CJ categories',
    description: 'Lists CJ Dropshipping\'s product categories (for use as categoryId in nova_cj_search_products).',
    inputSchema: {},
  }, async () => {
    const r = await callHandler(cjProductsHandler, { method: 'GET', query: { mode: 'categories' } });
    return { content: [{ type: 'text', text: JSON.stringify(r.body, null, 2) }] };
  });

  server.registerTool('nova_cj_get_product', {
    title: 'Get CJ product detail',
    description: 'Full detail + variants for one CJ product (by pid), or a single variant (by vid).',
    inputSchema: { pid: z.string().optional(), vid: z.string().optional() },
  }, async ({ pid, vid }) => {
    const r = await callHandler(cjProductHandler, { method: 'GET', query: { pid, vid } });
    return { content: [{ type: 'text', text: JSON.stringify(r.body, null, 2) }] };
  });

  server.registerTool('nova_cj_import_product', {
    title: 'Import CJ product as an admin draft',
    description: 'Fetches full CJ product details and variants, then creates an unpublished PHYSICAL product draft in Lexden Nova catalog/products. Includes every source field available to the integration: name, description, supplier price/currency, category/source details, variant identifiers and options, stock snapshot, image gallery and CJ sync metadata. Requires categoryId from nova_list_categories when available. Never publishes automatically; review NGN selling price, shipping, media rights and every admin field before publishing. Duplicate CJ product IDs are rejected. If no usable image is returned, search the web for the exact product/model and only attach a verified match with nova_update_product; never invent an image URL. If no exact match is available, report that instead of using a lookalike.',
    inputSchema: {
      pid: z.string().min(1),
      categoryId: z.string().optional(),
      categoryName: z.string().optional(),
      seller: z.string().default('Lexden Digital'),
    },
  }, async ({ pid, categoryId, categoryName, seller }) => {
    const result = await callHandler(cjProductHandler, { method: 'GET', query: { pid } });
    const response = result.body;
    if (!response || !response.ok || !response.product) {
      throw Object.assign(new Error((response && response.error) || 'CJ product detail lookup failed.'), { status: 502 });
    }
    const source = response.product;
    const productId = String(source.pid || pid).trim();
    const name = String(source.name || '').trim();
    if (!name) throw Object.assign(new Error('CJ returned no product name; draft was not created.'), { status: 422 });

    const db = getDb();
    const current = await listCatalogDoc(db, 'products');
    const duplicate = current.find(p => String(p.physical?.cj?.productId || '') === productId);
    if (duplicate) throw Object.assign(new Error(`CJ product already imported as ${duplicate.id}.`), { status: 409 });

    const variants = Array.isArray(response.variants) ? response.variants.filter(Boolean) : [];
    const variantIds = variants.map(v => v.vid).filter(Boolean).slice(0, 20);
    let stockResult = { body: { ok: false, error: 'No variant identifiers were returned.' } };
    if (variantIds.length) {
      try { stockResult = await callHandler(cjStockHandler, { method: 'GET', query: { vid: variantIds.join(',') } }); }
      catch (error) { stockResult = { body: { ok: false, error: error.message || 'Stock lookup failed.' } }; }
    }
    const stockMap = stockResult.body && stockResult.body.stock || {};
    const firstVariant = variants[0] || {};
    const images = uniqueUrls([...(Array.isArray(source.images) ? source.images : []), ...variants.map(v => v.image)]);
    const id = `cj-${productId.replace(/[^a-z0-9_-]/gi, '').slice(-48)}`;
    const specs = buildProductSpecs(source);
    const draft = {
      id,
      name: name.slice(0, 200),
      description: String(source.description || ''),
      categoryId: categoryId || '',
      categoryName: categoryName || source.categoryName || '',
      itemCode: `CJ-${productId.slice(-8).toUpperCase()}`,
      productType: 'PHYSICAL',
      format: 'Physical item',
      level: '',
      price: null,
      salePrice: null,
      discount: 0,
      seller: seller || 'Lexden Digital',
      affiliateLink: '',
      affiliateEnabled: false,
      affiliateCommissionPct: null,
      tags: ['cj-import', 'physical'],
      status: 'draft',
      gallery: images.map((url, index) => ({ url, type: 'image', alt: `${name} product image ${index + 1}` })),
      images,
      specs,
      physical: {
        stockMode: 'supplier',
        stockStatus: stockStatusFrom(stockMap, variantIds.length, !!(stockResult.body && stockResult.body.ok)),
        deliveryEstimate: source.deliveryCycle ? `${source.deliveryCycle} days (supplier estimate; confirm destination)` : '',
        shippingCountries: [],
        weight: firstVariant.weight != null ? `${(Number(firstVariant.weight) / 1000).toFixed(3)} kg` : (source.weight == null ? '' : `${(Number(source.weight) / 1000).toFixed(3)} kg`),
        dimensions: firstVariant.length || firstVariant.width || firstVariant.height
          ? `${[firstVariant.length, firstVariant.width, firstVariant.height].map(value => value == null ? '?' : (Number(value) / 10)).join(' × ')} cm`
          : '',
        returnPolicy: '',
        supplier: 'CJ Dropshipping',
        supplierSku: firstVariant.sku || source.sku || '',
        supplierCost: firstVariant.sellPrice ?? source.sellPrice ?? null,
        supplierCurrency: 'USD',
        cj: {
          productId,
          variantId: firstVariant.vid || '',
          sku: firstVariant.sku || source.sku || '',
          syncEnabled: true,
          variants: variants.map(v => ({ id: v.vid || '', sku: v.sku || '', name: v.name || '', optionKey: v.variantKey || '', barcode: v.barcode || '', standard: v.standard || '', unit: v.unit || '', image: v.image || '', sellPrice: v.sellPrice ?? null, suggestedSellPrice: v.suggestedSellPrice ?? null, weight: v.weight ?? null, length: v.length ?? null, width: v.width ?? null, height: v.height ?? null, stock: stockMap[v.vid] || null, supplierInventories: v.inventories || [] })),
          stockCheckError: stockResult.body && stockResult.body.ok ? null : (stockResult.body && stockResult.body.error) || 'Stock could not be verified; refresh inventory before publishing.',
          videoIds: Array.isArray(source.videoIds) ? source.videoIds : [],
          lastImportedAt: new Date().toISOString(),
        },
      },
      importSource: { supplier: 'CJ Dropshipping', productId, importedAt: new Date().toISOString(), sourceCategoryId: source.categoryId || '' },
    };
    const saved = await upsertCatalogItem(db, 'products', draft, { isNew: true });
    return { content: [{ type: 'text', text: JSON.stringify({ product: saved, imageCount: images.length, mediaReviewRequired: images.length === 0, publishStatus: 'draft' }, null, 2) }] };
  });

  server.registerTool('nova_cj_check_stock', {
    title: 'Check CJ stock levels',
    description: 'Live CJ warehouse stock for up to 20 variant ids. Pass syncProductId to also write the resulting in_stock/out_of_stock status onto that product in catalog/products.',
    inputSchema: { vids: z.array(z.string()).min(1).max(20), syncProductId: z.string().optional() },
  }, async ({ vids, syncProductId }) => {
    const query = { vid: vids.join(',') };
    if (syncProductId) { query.sync = '1'; query.productId = syncProductId; }
    const r = await callHandler(cjStockHandler, { method: 'GET', query });
    return { content: [{ type: 'text', text: JSON.stringify(r.body, null, 2) }] };
  });

  server.registerTool('nova_cj_calculate_shipping', {
    title: 'Calculate CJ shipping',
    description: 'Freight/shipping options and prices from CJ for a set of variants+quantities to a destination country.',
    inputSchema: {
      products: z.array(z.object({ vid: z.string(), quantity: z.number().int().min(1) })).min(1).max(20),
      endCountryCode: z.string().default('NG'), startCountryCode: z.string().default('CN'),
    },
  }, async (args) => {
    const r = await callHandler(cjShippingHandler, { method: 'POST', body: args });
    return { content: [{ type: 'text', text: JSON.stringify(r.body, null, 2) }] };
  });

  server.registerTool('nova_cj_track_shipment', {
    title: 'Track a CJ shipment',
    description: 'Carrier, status, and tracking events for one tracking number.',
    inputSchema: { trackNumber: z.string() },
  }, async ({ trackNumber }) => {
    const r = await callHandler(cjTrackingHandler, { method: 'GET', query: { trackNumber } });
    return { content: [{ type: 'text', text: JSON.stringify(r.body, null, 2) }] };
  });

  server.registerTool('nova_cj_get_order', {
    title: 'Get CJ order status',
    description: 'Looks up a CJ fulfilment order by CJ order id, or by your own Paystack reference (pass sync:true to also pull CJ\'s latest status back onto the orders/{reference} doc).',
    inputSchema: { cjOrderId: z.string().optional(), reference: z.string().optional(), sync: z.boolean().default(false) },
  }, async ({ cjOrderId, reference, sync }) => {
    const query = {};
    if (cjOrderId) query.cjOrderId = cjOrderId;
    if (reference) { query.reference = reference; if (sync) query.sync = '1'; }
    const r = await callHandler(cjOrdersHandler, { method: 'GET', query });
    return { content: [{ type: 'text', text: JSON.stringify(r.body, null, 2) }] };
  });

  server.registerTool('nova_cj_create_fulfilment_order', {
    title: 'Create CJ fulfilment order',
    description: 'Places the actual CJ order that ships a physical product to a customer, for an order that this server has already independently verified as paid. Idempotent (safe to call again for the same reference — it will report alreadyCreated instead of double-ordering), but this is real supplier/inventory action, so requires confirm: true.',
    inputSchema: { reference: z.string().describe('The Paystack reference / orders/{id} doc id.'), confirm: z.literal(true) },
  }, async ({ reference }) => {
    const r = await callHandler(cjOrderHandler, { method: 'POST', body: { reference } });
    return { content: [{ type: 'text', text: JSON.stringify(r.body, null, 2) }] };
  });

  server.registerTool('nova_cj_sync_logs', {
    title: 'CJ sync logs',
    description: 'Recent CJ API activity log (`cjSyncLogs` collection) — every product/stock/order/tracking call made to CJ, success or failure, with timing. Useful for troubleshooting a CJ integration issue.',
    inputSchema: { limit: z.number().int().min(1).max(200).default(50) },
  }, async ({ limit }) => {
    const db = getDb();
    const snap = await db.collection('cjSyncLogs').orderBy('at', 'desc').limit(limit).get();
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
  });
}

module.exports = { register };
