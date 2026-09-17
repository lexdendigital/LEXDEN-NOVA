// mcp/tools/cj.js
const { z } = require('zod');
const { callHandler } = require('../lib/callHandler');
const { getDb } = require('../../api/affiliate/shared');
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
