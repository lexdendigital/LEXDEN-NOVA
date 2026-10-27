// mcp/tools/cj.js
const { z } = require('zod');
const { callHandler } = require('../lib/callHandler');
const { getDb } = require('../../api/affiliate/shared');
const { listCatalogDoc, upsertCatalogItem } = require('../lib/settings');
const { uniqueUrls, buildProductSpecs, stockStatusFrom, deriveSuggestedPricing } = require('../lib/productImport');
const { rehostAll } = require('../lib/mediaRehost');
const cjShared = require('../../api/cj-shared');

const cjProductsHandler = require('../../api/cj-products');
const cjProductHandler = require('../../api/cj-product');
const cjStockHandler = require('../../api/cj-stock');
const cjOrdersHandler = require('../../api/cj-orders');
const cjOrderHandler = require('../../api/cj-order');
const cjShippingHandler = require('../../api/cj-shipping');
const cjTrackingHandler = require('../../api/cj-tracking');

function nextProductShareId(products){
  const used=new Set();
  for(const p of products||[]){
    if(!p) continue;
    const primary=String(p.id||'');
    const alias=String(p.shareId||'');
    if(/^p\d{1,4}$/.test(primary)) used.add(primary);
    if(/^p\d{1,4}$/.test(alias)) used.add(alias);
  }
  let n=1; while(used.has('p'+n)) n++;
  return 'p'+n;
}

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
      countryCode: z.string().optional().describe('Optional 2-letter code. Leave empty to search all of CJ; setting it (e.g. NG) only returns items stocked for that country and hides most results.'),
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
    title: 'Import CJ product as a complete admin draft',
    description: 'Fetches the full CJ product detail and all returned variants, preserving the original CJ payload and mapping every known CJ field into NOVA fields/specs. Fields absent from CJ remain blank. Uses the CJ suggested price as regular price and a 40% discount when a suggested price exists; if CJ provides no suggested price, prices stay blank. Never publishes automatically. Duplicate CJ product IDs are rejected.',
    inputSchema: {
      pid: z.string().min(1),
      categoryId: z.string().optional(),
      categoryName: z.string().optional(),
      seller: z.string().optional(),
    },
  }, async ({ pid }) => {
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

    const localCategories = await listCatalogDoc(db, 'categories');
    // Only map the supplier category when CJ's category label exactly matches
    // a NOVA category. Never infer a category from the product name.
    const sourceCategoryName = String(source.categoryName || '').trim();
    const normalizedCategoryName = sourceCategoryName.toLowerCase();
    const localCategory = normalizedCategoryName
      ? localCategories.find(c =>
          String(c.id || '').trim().toLowerCase() === normalizedCategoryName ||
          String(c.name || '').trim().toLowerCase() === normalizedCategoryName)
      : null;

    const variants = Array.isArray(response.variants) ? response.variants.filter(Boolean) : [];
    const variantIds = variants.map(v => v.vid).filter(Boolean).slice(0, 20);
    let stockResult = { body: { ok: false, error: 'No variant identifiers were returned.' } };
    if (variantIds.length) {
      try {
        stockResult = await callHandler(cjStockHandler, { method: 'GET', query: { vid: variantIds.join(',') } });
      } catch (error) {
        stockResult = { body: { ok: false, error: error.message || 'Stock lookup failed.' } };
      }
    }
    const stockMap = stockResult.body && stockResult.body.stock || {};
    const stockLookupOk = !!(stockResult.body && stockResult.body.ok);
    const firstVariant = variants[0] || {};
    const supplierImages = uniqueUrls([
      ...(Array.isArray(source.images) ? source.images : []),
      ...variants.map(v => v.image),
    ]);
    const images = supplierImages.length ? await rehostAll(supplierImages) : [];
    const id = `cj-${productId.replace(/[^a-z0-9_-]/gi, '').slice(-48)}`;
    const specs = buildProductSpecs(source);
    const pricing = deriveSuggestedPricing(source.suggestedSellPrice, variants);
    const optionId = 'cj-variant';
    const optionName = Array.isArray(source.productOptions)
      ? source.productOptions.filter(Boolean).join(', ')
      : (source.productOptions == null ? '' : String(source.productOptions));
    const rootVariants = variants.map((variant, index) => {
      const variantPrice = deriveSuggestedPricing(variant.suggestedSellPrice, []);
      const variantId = String(variant.vid || index);
      const title = String(variant.name || variant.variantKey || variant.sku || '');
      return {
        id: `cj-${variantId}`,
        title,
        optionValues: { [optionId]: `cj-${variantId}` },
        price: variantPrice.price,
        salePrice: variantPrice.salePrice,
        stock: stockMap[variant.vid] && stockMap[variant.vid].total != null ? stockMap[variant.vid].total : null,
        sku: variant.sku || '',
        image: variant.image || '',
        cjVariantId: variant.vid || '',
        active: true,
        sourceData: variant.sourceData || variant,
      };
    });
    const dimensionsSource = [firstVariant.length, firstVariant.width, firstVariant.height].some(v => v != null && v !== '')
      ? firstVariant
      : (source.dimensions || {});
    const dimensionParts = [
      ['L', dimensionsSource.length],
      ['W', dimensionsSource.width],
      ['H', dimensionsSource.height],
    ].filter(([, value]) => value != null && value !== '')
      .map(([label, value]) => `${label} ${(Number(value) / 10).toString()} cm`);
    const dimensions = dimensionParts.join(' × ');
    const sourceWeight = firstVariant.weight != null ? firstVariant.weight : source.weight;
    const weight = sourceWeight != null && sourceWeight !== ''
      ? `${(Number(sourceWeight) / 1000).toFixed(3)} kg`
      : '';

    const importedAt = new Date().toISOString();
    const draft = {
      id,
      shareId: nextProductShareId(current),
      name: name.slice(0, 200),
      description: String(source.description || ''),
      categoryId: localCategory ? localCategory.id : '',
      category: localCategory ? localCategory.id : '',
      categoryName: sourceCategoryName,
      itemCode: '',
      productType: 'PHYSICAL',
      format: '',
      level: '',
      price: pricing.price,
      salePrice: pricing.salePrice,
      discount: pricing.discount,
      seller: '',
      affiliateLink: '',
      affiliateEnabled: false,
      affiliateCommissionPct: null,
      tags: [],
      status: 'draft',
      image: images[0] || '',
      gallery: images.map(url => ({ url, type: 'image', alt: '' })),
      images,
      specs,
      options: variants.length ? [{
        id: optionId,
        name: optionName,
        values: variants.map((variant, index) => ({
          id: `cj-${String(variant.vid || index)}`,
          label: String(variant.name || variant.variantKey || variant.sku || ''),
        })),
      }] : [],
      variants: rootVariants,
      rating: null,
      reviewCount: null,
      featured: false,
      trending: false,
      pricingReviewRequired: true,
      physical: {
        stockMode: 'SUPPLIER_STOCK',
        stockStatus: stockStatusFrom(stockMap, variantIds.length, stockLookupOk),
        deliveryEstimate: source.deliveryCycle == null ? '' : String(source.deliveryCycle),
        shippingCountries: [],
        weight,
        dimensions,
        returnPolicy: '',
        supplier: source.supplierName || 'CJ Dropshipping',
        supplierId: source.supplierId || '',
        supplierSku: firstVariant.sku || source.sku || '',
        supplierCost: firstVariant.sellPrice ?? source.sellPrice ?? null,
        supplierCurrency: firstVariant.sellPriceCurrency || source.supplierCurrency || '',
        routing: null,
        cj: {
          productId,
          variantId: firstVariant.vid || '',
          sku: firstVariant.sku || source.sku || '',
          syncEnabled: true,
          lastSyncedAt: stockLookupOk ? importedAt : null,
          lastImportedAt: importedAt,
          stockCheckError: stockLookupOk ? '' : ((stockResult.body && stockResult.body.error) || 'Stock could not be verified.'),
          videoIds: Array.isArray(source.videoIds) ? source.videoIds : [],
          sourceData: source.sourceData || source,
          variants: variants.map(v => ({
            id: v.vid || '',
            sku: v.sku || '',
            name: v.name || '',
            optionKey: v.variantKey || '',
            barcode: v.barcode || '',
            standard: v.standard || '',
            unit: v.unit || '',
            image: v.image || '',
            sellPrice: v.sellPrice ?? null,
            sellPriceCurrency: v.sellPriceCurrency || source.supplierCurrency || '',
            suggestedSellPrice: v.suggestedSellPrice ?? null,
            weight: v.weight ?? null,
            length: v.length ?? null,
            width: v.width ?? null,
            height: v.height ?? null,
            stock: stockMap[v.vid] || null,
            supplierInventories: v.inventories || [],
            sourceData: v.sourceData || v,
          })),
        },
      },
      importSource: {
        supplier: 'CJ Dropshipping',
        productId,
        importedAt,
        sourceCategoryId: source.categoryId || '',
        sourceData: source.sourceData || source,
      },
    };
    const saved = await upsertCatalogItem(db, 'products', draft, { isNew: true });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          product: saved,
          imageCount: images.length,
          mediaReviewRequired: images.length === 0,
          publishStatus: 'draft',
          fieldsLeftBlankWhenAbsent: true,
          pricing: { regular: pricing.price, sale: pricing.salePrice, discountPercent: pricing.discount },
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
