// mcp/tools/cj.js
const { z } = require('zod');
const { callHandler } = require('../lib/callHandler');
const { getDb } = require('../../api/affiliate/shared');
const { upsertCatalogItem, listCatalogDoc } = require('../lib/settings');
const { hydrateMediaGallery } = require('../lib/media');
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
    title: 'Search CJ Dropshipping products (browse only)',
    description: 'Browses CJ\'s product catalog by keyword/category to help pick a pid to import — for finding products, not your own store catalog (use nova_list_products for that). IMPORTANT: this is CJ\'s list/search endpoint, which by design returns thin previews — sellPrice, variantNum and categoryId are commonly null here even on a successful search; that is normal and NOT a bug. Never treat these results as import-ready or report them to the human as "missing data" — once you\'ve picked a pid, call nova_cj_import_product (or nova_cj_get_product first if you just want to show full detail) to get the real, complete data.',
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
    title: 'Import a CJ product into the Nova catalog (one atomic step)',
    description: 'THE tool to use when the human asks to import/add a CJ product to the store. Unlike nova_cj_search_products (which only returns a thin preview — pid/name/image, with sellPrice/variantNum/categoryId usually null by design on CJ\'s side), this tool: (1) pulls full detail + ALL variants from CJ, (2) picks a sell price (your markup % over CJ\'s cost, or an explicit price you pass), (3) re-hosts every supplier image/video on Cloudinary so the listing survives even if CJ changes its CDN, and — only if CJ gave NO usable media at all — generates a clean product photo with AI and uploads that instead, so no imported product is ever left without a picture, (4) writes the complete product into catalog/products in the exact shape the storefront and admin panel expect (category, itemCode, price, physical.* shipping/stock/supplier fields, physical.cj.{productId,variantId,sku,syncEnabled}, specs, images) marked productType:"PHYSICAL". Always returns the full saved product so you can show the human exactly what was imported before they publish it — review it with them if anything looks off.',
    inputSchema: {
      pid: z.string().describe('CJ product id — from nova_cj_search_products or nova_cj_list_categories results.'),
      category: z.string().describe('Nova catalog category id to file this under, e.g. "gadgets". Call nova_list_categories first if unsure what exists.'),
      markupPercent: z.number().min(0).default(35).describe('% markup over CJ\'s unit cost used to set the sell price, when priceOverride is not given.'),
      priceOverride: z.number().optional().describe('Set an exact NGN sell price instead of computing one from markupPercent.'),
      status: z.enum(['Published', 'Draft']).default('Draft').describe('Defaults to Draft so a human reviews pricing/media before it goes live.'),
      allowAffiliateCommission: z.boolean().default(true),
      affiliateCommissionPercent: z.number().optional(),
      tags: z.array(z.string()).optional(),
      shippingCountries: z.array(z.string()).default(['Nigeria']),
      confirm: z.literal(true).describe('This writes to the live catalog — pass true once the human has agreed to import this specific pid.'),
    },
  }, async ({ pid, category, markupPercent, priceOverride, status, allowAffiliateCommission, affiliateCommissionPercent, tags, shippingCountries }) => {
    const detailR = await callHandler(cjProductHandler, { method: 'GET', query: { pid } });
    if (!detailR.body || detailR.body.ok === false) {
      return { content: [{ type: 'text', text: JSON.stringify({ imported: false, stage: 'detail_fetch', error: detailR.body?.error || 'CJ detail lookup failed.' }) }] };
    }
    const { product: d, variants = [] } = detailR.body;
    if (!d || !d.pid) {
      return { content: [{ type: 'text', text: JSON.stringify({ imported: false, stage: 'detail_fetch', error: 'CJ returned no product detail for this pid.' }) }] };
    }

    // CJ's own per-unit cost: cheapest variant's sellPrice (that field IS
    // populated at this, detail, stage — unlike at search/list stage).
    const variantPrices = variants.map((v) => v.sellPrice).filter((n) => typeof n === 'number' && n > 0);
    const unitCostUSD = variantPrices.length ? Math.min(...variantPrices) : null;
    const USD_TO_NGN = Number(process.env.USD_TO_NGN_RATE) || 1600; // keep in step with admin's Branding & Currency rate until that's wired to live FX
    const unitCostNGN = unitCostUSD != null ? Math.round(unitCostUSD * USD_TO_NGN) : null;
    const price = priceOverride != null
      ? priceOverride
      : (unitCostNGN != null ? Math.round(unitCostNGN * (1 + markupPercent / 100)) : null);

    if (price == null) {
      return { content: [{ type: 'text', text: JSON.stringify({ imported: false, stage: 'pricing', error: 'Could not determine a cost to price from (no variant had a sellPrice) and no priceOverride was given. Pass priceOverride explicitly.' }) }] };
    }

    const specs = {};
    if (d.sourceCountry) specs['Ships from'] = d.sourceCountry;
    if (variants.length > 1) specs['Options'] = variants.map((v) => v.variantKey).filter(Boolean).join(', ');
    if (d.categoryName) specs['Supplier category'] = d.categoryName;

    const media = await hydrateMediaGallery({
      supplierImages: d.images || [],
      supplierVideo: d.video,
      name: d.name,
      description: d.description,
      specs,
    });

    const id = `cj-${d.pid}`;
    const product = {
      id,
      name: d.name || `CJ product ${d.pid}`,
      category,
      itemCode: `LX-CJ-${String(d.pid).slice(-5).toUpperCase()}`,
      price,
      productType: 'PHYSICAL',
      affiliateLink: '#',
      status,
      tags: tags || [],
      allowAffiliateCommission,
      ...(affiliateCommissionPercent != null ? { affiliateCommissionPercent } : {}),
      description: d.description || '',
      images: media.images,
      specs,
      physical: {
        stockMode: 'Supplier stock',
        stockStatus: 'In stock', // best-effort at import time — run nova_cj_check_stock with syncProductId before publishing to confirm live CJ warehouse stock
        deliveryEstimate: '7-20 business days',
        shippingCountries,
        weight: d.weight != null ? `${d.weight}kg` : '',
        dimensions: '',
        returnPolicy: '',
        supplierId: 'cj',
        supplierSku: variants[0]?.sku || '',
        supplierCost: unitCostNGN,
        supplierCurrency: 'NGN',
        cj: {
          productId: d.pid,
          variantId: variants[0]?.vid || '',
          sku: variants[0]?.sku || '',
          syncEnabled: true,
        },
      },
    };

    const db = getDb();
    const existing = await listCatalogDoc(db, 'products');
    const alreadyImported = existing.some((p) => p.id === id);
    const saved = await upsertCatalogItem(db, 'products', product, { isNew: !alreadyImported });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          imported: true,
          refreshed: alreadyImported,
          product: saved,
          mediaFallbackUsed: media.usedFallback,
          variantCount: variants.length,
          note: media.usedFallback
            ? 'CJ supplied no usable media for this product — the cover image was AI-generated, not a real product photo. Review it before publishing.'
            : `${media.images.length} CJ image(s)/video re-hosted on Cloudinary.`,
        }, null, 2),
      }],
    };
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
