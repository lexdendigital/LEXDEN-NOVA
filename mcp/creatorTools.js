// mcp/creatorTools.js
//
// LEXDEN NOVA CREATOR — Stage J. The tools a creator's AI assistant gets.
//
// SECURITY MODEL (read before editing):
//   * The creator's uid is captured in a CLOSURE when the server is built
//     from the verified token (mcp/index.js → buildCreatorServer). No tool
//     accepts uid / creatorId / email as input, so a prompt-injected
//     instruction cannot point a tool at somebody else's data.
//   * Writes go through the REAL api/creator-*.js handlers (callHandler),
//     carrying the TRUSTED_CREATOR symbol. Every validation rule, state
//     machine and ownership check therefore stays in one place.
//   * Reads are scoped with `where('creatorId','==',uid)`.
//   * Consequential actions need `confirm: true` (a z.literal), so the model
//     must state intent explicitly and the host app can show a prompt.
//   * DELIBERATELY NOT EXPOSED: changing the payout bank account, KYC /
//     document upload, file upload, anything admin or buyer-side. A
//     prompt-injected assistant must never be able to redirect money.
//   * All listing submissions still need admin approval.

const { z } = require('zod');

const OFFERING_TYPES = [
  'PHYSICAL_PRODUCT', 'DIGITAL_DOWNLOAD', 'EBOOK', 'TEMPLATE', 'SOFTWARE', 'COURSE',
  'EXTERNAL_ACCESS', 'SERVICE', 'LIVE_PROGRAM', 'SUBSCRIPTION', 'BUNDLE',
];

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const WRITE_IDEMPOTENT = { ...WRITE, idempotentHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const confirmField = z.literal(true).describe('Must be exactly true. Only set after the creator has explicitly agreed to this action in the conversation.');

const versionFields = {
  title: z.string().max(140).optional(),
  description: z.string().max(5000).optional(),
  category: z.string().max(100).optional(),
  images: z.array(z.string().url()).max(12).optional().describe('Public https image URLs.'),
  price: z.number().min(0).optional().describe('Price in major units (e.g. 5000 = ₦5,000).'),
  currency: z.string().max(8).optional().describe('e.g. NGN'),
  isFree: z.boolean().optional(),
  refundPolicy: z.string().max(2000).optional(),
  stock: z.number().int().min(0).optional().describe('PHYSICAL_PRODUCT only.'),
  weightGrams: z.number().min(0).optional().describe('PHYSICAL_PRODUCT only.'),
  supplierName: z.string().max(100).optional().describe('MANUAL_SUPPLIER only: who you order this product from.'),
  processingDays: z.number().int().min(1).max(30).optional().describe('PHYSICAL_PRODUCT: days you need to dispatch an order (required for MANUAL_SUPPLIER). Longer than 2 days lengthens your shipping deadline.'),
  fulfillmentMode: z.enum(['SELLER_STOCK', 'CJ_DROPSHIP', 'MANUAL_SUPPLIER']).optional().describe('PHYSICAL_PRODUCT only. SELLER_STOCK (default): you ship from your own stock. MANUAL_SUPPLIER: you order from your own supplier by hand and ship it yourself — needs supplierName and processingDays. CJ_DROPSHIP: orders are placed in YOUR connected CJ Dropshipping account; needs a tested CJ mapping before submission, and stock/weight/origin are not required. Changing this on a published listing is a high-risk edit.'),
  shippingOrigin: z.string().max(200).optional().describe('PHYSICAL_PRODUCT only.'),
  fileAssetId: z.string().max(200).optional().describe('ID of a file the creator uploaded in the web app. Files cannot be uploaded through the assistant.'),
  externalUrl: z.string().url().optional().describe('External delivery/access link.'),
  systemRequirements: z.string().max(2000).optional().describe('SOFTWARE only.'),
  pageCount: z.number().int().min(1).optional().describe('EBOOK only.'),
  compatibility: z.string().max(500).optional().describe('TEMPLATE only, e.g. Figma, Notion.'),
  modules: z.array(z.object({ title: z.string().max(200), description: z.string().max(1000).optional() })).max(100).optional().describe('COURSE only.'),
  level: z.string().max(50).optional().describe('COURSE only.'),
  turnaround: z.string().max(200).optional().describe('SERVICE only.'),
  deliverables: z.string().max(2000).optional().describe('SERVICE only.'),
  billingInterval: z.string().max(50).optional().describe('SUBSCRIPTION only, e.g. monthly.'),
};
const VERSION_KEYS = Object.keys(versionFields);

function pickDefined(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function asText(data, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], ...(isError ? { isError: true } : {}) };
}

// Turn a handler envelope ({status, body}) into a tool result.
function fromEnvelope({ status, body }) {
  if (body && body.ok) return asText(body.data);
  const err = (body && body.error) || { code: 'ERROR', message: `Request failed (${status}).` };
  return asText({ error: err.code, message: err.message, ...(err.errors ? { problems: err.errors } : {}) }, true);
}

function maskAccount(num) {
  const s = String(num || '');
  return s.length > 4 ? `${'*'.repeat(s.length - 4)}${s.slice(-4)}` : s ? '****' : null;
}

// Firestore Timestamps → ISO strings so results are plain JSON.
function plain(value) {
  if (value == null) return value;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(value)) o[k] = plain(v);
    return o;
  }
  return value;
}

function defaultDeps() {
  const { callHandler } = require('./lib/callHandler');
  const { getDb, TRUSTED_CREATOR } = require('../api/creator/shared');
  return {
    callHandler, getDb, TRUSTED_CREATOR,
    handlers: {
      products: require('../api/creator-products'),
      fulfillments: require('../api/creator-fulfillments'),
      withdraw: require('../api/creator-withdraw'),
      supplierConnection: require('../api/creator-supplier-connection'),
      supplierProducts: require('../api/creator-supplier-products'),
      supplierOrders: require('../api/creator-supplier-orders'),
      notifications: require('../api/creator-notifications'),
      ai: require('../api/creator-ai'),
      profile: require('../api/creator-profile'),
      disputes: require('../api/creator-disputes'),
    },
  };
}

/**
 * @param server  McpServer
 * @param ctx     { uid, email, deps? } — uid comes ONLY from the verified token.
 */
function register(server, { uid, email = null, deps } = {}) {
  if (typeof uid !== 'string' || !uid) throw new Error('creatorTools.register requires a verified uid.');
  const d = deps || defaultDeps();
  const extras = { [d.TRUSTED_CREATOR]: { uid, email } };
  const call = (handler, opts) => d.callHandler(handler, { ...opts, extras }).then(fromEnvelope);
  const db = () => d.getDb();

  // ------------------------------------------------------------------ reads
  server.registerTool('creator_get_overview', {
    title: 'Get my creator overview',
    description: 'Your creator profile status and money summary: available balance, total earned, total withdrawn, and the product and order counts. Start here.',
    inputSchema: {},
    annotations: READ,
  }, async () => {
    const [creatorSnap, privSnap, prodSnap, pendingSnap] = await Promise.all([
      db().collection('creators').doc(uid).get(),
      db().collection('creatorPrivate').doc(uid).get(),
      db().collection('products').where('creatorId', '==', uid).get(),
      db().collection('fulfillments').where('creatorId', '==', uid).where('status', '==', 'PENDING').get(),
    ]);
    const c = creatorSnap.exists ? creatorSnap.data() : {};
    const p = privSnap.exists ? privSnap.data() : {};
    const byStatus = {};
    prodSnap.docs.forEach((x) => { const s = x.data().status || 'UNKNOWN'; byStatus[s] = (byStatus[s] || 0) + 1; });
    return asText(plain({
      creator: { displayName: c.displayName || c.storeName || null, status: c.status || null },
      money: {
        balanceAvailable: p.balanceAvailable || 0,
        balancePending: p.balancePending || 0,
        totalEarned: p.totalEarned || 0,
        totalWithdrawn: p.totalWithdrawn || 0,
        hasPayoutAccount: !!(p.payoutAccount && p.payoutAccount.accountNumber),
        lastWithdrawalAt: p.lastWithdrawalAt || null,
      },
      products: { total: prodSnap.size, byStatus },
      ordersAwaitingPacking: pendingSnap.size,
    }));
  });

  server.registerTool('creator_list_products', {
    title: 'List my products',
    description: 'All your listings with their status (DRAFT, IN_REVIEW, PUBLISHED, PAUSED, ARCHIVED, ...), newest first.',
    inputSchema: {},
    annotations: READ,
  }, () => call(d.handlers.products, { method: 'GET' }).then((r) => {
    if (r.isError) return r;
    const data = JSON.parse(r.content[0].text);
    return asText(plain({
      products: (data.products || []).map((x) => ({
        productId: x.id, offeringType: x.offeringType, status: x.status,
        title: (x.publishedSnapshot && x.publishedSnapshot.title) || null,
        updatedAt: x.updatedAt || null,
      })),
    }));
  }));

  server.registerTool('creator_get_product', {
    title: 'Get one product with its versions',
    description: 'One of your listings plus every version (fields, status, any reviewer feedback).',
    inputSchema: { productId: z.string().min(1).max(128) },
    annotations: READ,
  }, async ({ productId }) => {
    const r = await call(d.handlers.products, { method: 'GET', query: { productId } });
    return r.isError ? r : asText(plain(JSON.parse(r.content[0].text)));
  });

  server.registerTool('creator_list_sales', {
    title: 'List my sales and earnings',
    description: 'Your recent sales: amount, platform fee, and what you earned per sale. Newest first.',
    inputSchema: { limit: z.number().int().min(1).max(100).optional().describe('Default 25.') },
    annotations: READ,
  }, async ({ limit }) => {
    const snap = await db().collection('creatorSales').where('creatorId', '==', uid).orderBy('createdAt', 'desc').limit(limit || 25).get();
    return asText(plain({ sales: snap.docs.map((x) => ({ id: x.id, ...x.data() })) }));
  });

  server.registerTool('creator_list_orders', {
    title: 'List my physical-product orders',
    description: 'Orders you must ship (fulfillments) with the buyer\'s delivery details. status: PENDING (to pack), PACKED, SHIPPED, DELIVERED, RETURNED, CANCELLED.',
    inputSchema: { status: z.enum(['PENDING', 'PACKED', 'SHIPPED', 'DELIVERED', 'RETURNED', 'CANCELLED']).optional() },
    annotations: READ,
  }, async ({ status }) => {
    const r = await call(d.handlers.fulfillments, { method: 'GET', query: status ? { status } : {} });
    return r.isError ? r : asText(plain(JSON.parse(r.content[0].text)));
  });

  server.registerTool('creator_get_payout_account', {
    title: 'Show my payout account (masked)',
    description: 'Which bank account withdrawals are paid to. The account number is masked. It can only be changed in the LEXDEN NOVA web app, never through the assistant.',
    inputSchema: {},
    annotations: READ,
  }, async () => {
    const snap = await db().collection('creatorPrivate').doc(uid).get();
    const a = (snap.exists && snap.data().payoutAccount) || null;
    return asText(a ? { bankName: a.bankName || null, accountName: a.accountName || null, accountNumber: maskAccount(a.accountNumber) } : { payoutAccount: null, note: 'No payout account yet. Add one in the web app.' });
  });

  server.registerTool('creator_list_withdrawals', {
    title: 'List my withdrawals',
    description: 'Your withdrawal requests and their status.',
    inputSchema: {},
    annotations: READ,
  }, async () => {
    const r = await call(d.handlers.withdraw, { method: 'GET' });
    return r.isError ? r : asText(plain(JSON.parse(r.content[0].text)));
  });

  server.registerTool('creator_get_listing_requirements', {
    title: 'What a listing needs before review',
    description: 'The fields that must be filled before a listing of this type can be submitted for review.',
    inputSchema: { offeringType: z.enum(OFFERING_TYPES) },
    annotations: READ,
  }, async ({ offeringType }) => {
    const { validateProductForSubmit } = require('../api/creator/product-validation');
    const { errors } = validateProductForSubmit({ offeringType });
    return asText({ offeringType, required: errors.filter((e) => e.field !== 'offeringType').map((e) => ({ field: e.field, why: e.message })) });
  });

  // ----------------------------------------------------------------- writes
  server.registerTool('creator_create_product_draft', {
    title: 'Create a draft listing',
    description: 'Creates a DRAFT listing. Nothing is public until you submit it and an admin approves it. Fill in as many fields as you know; use creator_get_listing_requirements to see what is needed.',
    inputSchema: { offeringType: z.enum(OFFERING_TYPES), ...versionFields },
    annotations: WRITE,
  }, (args) => call(d.handlers.products, {
    method: 'POST', body: { action: 'create_draft', offeringType: args.offeringType, ...pickDefined(args, VERSION_KEYS) },
  }));

  server.registerTool('creator_update_product_draft', {
    title: 'Edit a draft listing',
    description: 'Updates fields on the editable (draft) version of one of your listings. Only the fields you pass change.',
    inputSchema: { productId: z.string().min(1).max(128), ...versionFields },
    annotations: WRITE_IDEMPOTENT,
  }, (args) => call(d.handlers.products, {
    method: 'POST', body: { action: 'update_draft', productId: args.productId, ...pickDefined(args, VERSION_KEYS) },
  }));

  server.registerTool('creator_submit_product_for_review', {
    title: 'Submit a listing for admin review',
    description: 'Sends the draft to LEXDEN NOVA admins for approval. It fails with a list of missing fields if the draft is incomplete.',
    inputSchema: { productId: z.string().min(1).max(128), confirm: confirmField },
    annotations: WRITE,
  }, ({ productId }) => call(d.handlers.products, { method: 'POST', body: { action: 'submit', productId } }));

  server.registerTool('creator_create_new_version', {
    title: 'Start a new version of a published listing',
    description: 'Copies a published listing into a new editable draft version. The live version stays unchanged until the new one is approved.',
    inputSchema: { productId: z.string().min(1).max(128) },
    annotations: WRITE,
  }, ({ productId }) => call(d.handlers.products, { method: 'POST', body: { action: 'create_new_version', productId } }));

  server.registerTool('creator_set_product_state', {
    title: 'Pause, resume or archive a listing',
    description: 'pause hides it from sale, resume puts a paused listing back on sale, archive retires it.',
    inputSchema: { productId: z.string().min(1).max(128), action: z.enum(['pause', 'resume', 'archive']), confirm: confirmField },
    annotations: DESTRUCTIVE,
  }, ({ productId, action }) => call(d.handlers.products, { method: 'POST', body: { action, productId } }));

  server.registerTool('creator_list_notifications', {
    title: 'My notifications',
    description: 'Your notification center: orders due soon or overdue, listings that were paused (and why), CJ orders that need your action. Newest first.',
    inputSchema: { unreadOnly: z.boolean().optional() },
    annotations: READ,
  }, async ({ unreadOnly }) => {
    const r = await call(d.handlers.notifications, { method: 'GET', query: unreadOnly ? { unread: '1' } : {} });
    return r.isError ? r : asText(plain(JSON.parse(r.content[0].text)));
  });

  server.registerTool('creator_get_profile', {
    title: 'My public profile and selling rules',
    description: 'Your public profile (display name, username, tagline, bio) and the rules you sell under: platform fee %, payout minimum and fee, how long new sales are held before they can be withdrawn, and the buyer dispute window. Your public seller page is at #seller/<username> on the store.',
    inputSchema: {},
    annotations: READ,
  }, async () => {
    const r = await call(d.handlers.profile, { method: 'GET' });
    return r.isError ? r : asText(plain(JSON.parse(r.content[0].text)));
  });

  server.registerTool('creator_update_profile', {
    title: 'Update my public profile',
    description: 'Sets your public username (3–24 letters, numbers or underscore; unique), tagline and bio. These are shown publicly on your seller page. Your display name and verification cannot be changed here.',
    inputSchema: {
      username: z.string().max(25).optional(),
      tagline: z.string().max(100).optional(),
      bio: z.string().max(500).optional(),
      confirm: confirmField,
    },
    annotations: WRITE_IDEMPOTENT,
  }, ({ username, tagline, bio }) => call(d.handlers.profile, { method: 'POST', body: { action: 'update', ...(username !== undefined ? { username } : {}), ...(tagline !== undefined ? { tagline } : {}), ...(bio !== undefined ? { bio } : {}) } }));

  server.registerTool('creator_list_disputes', {
    title: 'My buyer disputes',
    description: 'Disputes buyers opened on your orders, with the conversation so far (the buyer\'s email is never shown). While a dispute is OPEN, the earning for that order is frozen. Only the admin can decide it.',
    inputSchema: { status: z.enum(['OPEN', 'RESOLVED_REFUND', 'RESOLVED_REJECTED']).optional() },
    annotations: READ,
  }, async ({ status }) => {
    const snap = await db().collection('creatorDisputes').where('creatorId', '==', uid).get();
    const rows = snap.docs.map((x) => { const { buyerEmail, buyerUid, openedAt, ...rest } = x.data(); return { id: x.id, ...rest }; })
      .filter((x) => !status || x.status === status).sort((a, b) => (b.openedAtMs || 0) - (a.openedAtMs || 0));
    return asText(plain({ disputes: rows }));
  });

  server.registerTool('creator_reply_to_dispute', {
    title: 'Reply to a buyer dispute',
    description: 'Adds your reply to an OPEN dispute on your own order. It cannot decide, refund or close anything.',
    inputSchema: { disputeId: z.string().min(1).max(200), text: z.string().min(2).max(2000), confirm: confirmField },
    annotations: WRITE,
  }, async ({ disputeId, text }) => {
    try {
      return asText(await require('../api/creator-disputes').addMessage(db(), uid, { disputeId, text }));
    } catch (e) { return asText({ error: e.code || 'ERROR', message: e.message }, true); }
  });

  server.registerTool('creator_mark_notifications_read', {
    title: 'Mark notifications as read',
    description: 'Marks the given notification ids as read, or all of them when no ids are given.',
    inputSchema: { ids: z.array(z.string().min(1).max(200)).max(100).optional() },
    annotations: WRITE_IDEMPOTENT,
  }, ({ ids }) => call(d.handlers.notifications, { method: 'POST', body: { action: 'mark_read', ...(ids && ids.length ? { ids } : {}) } }));

  server.registerTool('creator_acknowledge_order', {
    title: 'Acknowledge a new paid order',
    description: 'Tell LEXDEN NOVA you have seen a paid physical order. You should acknowledge within 24 hours; marking it packed also counts. Orders from creator_list_orders show an sla field (ON_TRACK / AT_RISK / BREACHED).',
    inputSchema: { orderId: z.string().min(1).max(128) },
    annotations: WRITE_IDEMPOTENT,
  }, ({ orderId }) => call(d.handlers.fulfillments, { method: 'POST', body: { orderId, action: 'acknowledge' } }));

  server.registerTool('creator_mark_order_packed', {
    title: 'Mark an order as packed',
    description: 'Moves a PENDING physical order to PACKED.',
    inputSchema: { orderId: z.string().min(1).max(128) },
    annotations: WRITE_IDEMPOTENT,
  }, ({ orderId }) => call(d.handlers.fulfillments, { method: 'POST', body: { orderId, action: 'mark_packed' } }));

  server.registerTool('creator_mark_order_shipped', {
    title: 'Mark an order as shipped',
    description: 'Moves a PACKED order to SHIPPED. A carrier and tracking number are required; a tracking link is built automatically for DHL, FedEx, UPS, USPS and common China-origin carriers, and any link you supply must be http(s).',
    inputSchema: {
      orderId: z.string().min(1).max(128),
      carrier: z.string().min(1).max(100),
      trackingNumber: z.string().min(1).max(100),
      trackingUrl: z.string().url().optional(),
    },
    annotations: WRITE,
  }, ({ orderId, carrier, trackingNumber, trackingUrl }) => call(d.handlers.fulfillments, {
    method: 'POST', body: { orderId, action: 'mark_shipped', carrier, trackingNumber, ...(trackingUrl ? { trackingUrl } : {}) },
  }));

  server.registerTool('creator_cancel_order', {
    title: 'Cancel an order',
    description: 'Cancels a physical order you cannot fulfil. A reason is required.',
    inputSchema: { orderId: z.string().min(1).max(128), reason: z.string().min(3).max(500), confirm: confirmField },
    annotations: DESTRUCTIVE,
  }, ({ orderId, reason }) => call(d.handlers.fulfillments, { method: 'POST', body: { orderId, action: 'cancel', reason } }));

  server.registerTool('creator_request_withdrawal', {
    title: 'Request a withdrawal',
    description: 'Requests a payout of the given amount (NGN) to your saved payout account. The platform minimum, fee and 7-day cooldown apply.',
    inputSchema: { amount: z.number().positive().describe('Amount in naira.'), confirm: confirmField },
    annotations: DESTRUCTIVE,
  }, ({ amount }) => call(d.handlers.withdraw, { method: 'POST', body: { amount } }));

  // -------------------------------------------------- dropshipping (Stage G)
  // DELIBERATELY NO connect / disconnect / auto-pay / credential tool: the CJ
  // API key must never pass through an AI transcript, and a prompt-injected
  // assistant must not be able to swap or redirect a supplier account. The
  // creator does that in the web app; the assistant can only read status.
  // -------------------------------------------------- AI home (Stage J)
  // Both tools are read-only/deterministic: numbers are computed on the server
  // from the creator's own records. No free-form AI call is exposed here (the
  // assistant calling this tool IS the AI).
  server.registerTool('creator_get_weekly_report', {
    title: 'My weekly report',
    description: 'Your shop at a glance, computed from your own records: earnings this week vs last week, top products, orders needing action (shipping deadlines at risk or overdue), listings that need improving, unread notifications.',
    inputSchema: {},
    annotations: READ,
  }, async () => {
    const r = await call(d.handlers.ai, { method: 'GET' });
    return r.isError ? r : asText(plain(JSON.parse(r.content[0].text)));
  });

  server.registerTool('creator_get_product_checklist', {
    title: 'Listing quality checklist',
    description: 'A deterministic checklist for one of your listings (title length, description, images, price, category, refund policy, processing time) with a score and the things to fix. Read-only: edit the listing with the update tools.',
    inputSchema: { productId: z.string().min(1).max(128) },
    annotations: READ,
  }, async ({ productId }) => {
    const r = await call(d.handlers.ai, { method: 'POST', body: { action: 'checklist', productId } });
    return r.isError ? r : asText(plain(JSON.parse(r.content[0].text)));
  });

  server.registerTool('creator_get_supplier_status', {
    title: 'Show my CJ Dropshipping connection',
    description: 'Whether your own CJ Dropshipping account is connected (masked email, health, auto-pay on/off). Connecting or disconnecting can only be done in the LEXDEN NOVA web app, never through the assistant.',
    inputSchema: {},
    annotations: READ,
  }, () => call(d.handlers.supplierConnection, { method: 'GET' }));

  server.registerTool('creator_list_dropship_mappings', {
    title: 'List my CJ mappings',
    description: 'The CJ variant mapping and last test result (valid/invalid, stock, shipping, cost drift) of your dropship listings. Optionally for one productId.',
    inputSchema: { productId: z.string().min(1).max(128).optional() },
    annotations: READ,
  }, async ({ productId }) => {
    const r = await call(d.handlers.supplierProducts, { method: 'GET', query: productId ? { productId } : {} });
    return r.isError ? r : asText(plain(JSON.parse(r.content[0].text)));
  });

  server.registerTool('creator_test_dropship_mapping', {
    title: 'Map a listing to a CJ variant and test it',
    description: 'Saves the CJ mapping on the listing\'s editable draft version and tests it against YOUR CJ account (variant exists, in stock, ships to every destination country). It must pass before the listing can be submitted or approved.',
    inputSchema: {
      productId: z.string().min(1).max(128),
      cjVariantId: z.string().min(1).max(100).describe('The CJ variant id (vid).'),
      cjProductId: z.string().max(100).optional(),
      sku: z.string().max(100).optional(),
      declaredCostUsd: z.number().min(0).optional().describe('The CJ unit cost you expect, in USD; used to detect cost drift.'),
      logisticName: z.string().max(100).optional().describe('Preferred CJ shipping method; otherwise the cheapest available is chosen.'),
      destinationCountries: z.array(z.string().length(2)).max(5).optional().describe('ISO-2 codes, default ["NG"].'),
      stockThreshold: z.number().int().min(1).optional(),
    },
    annotations: WRITE_IDEMPOTENT,
  }, (args) => call(d.handlers.supplierProducts, { method: 'POST', body: { action: 'test_mapping', ...args } }));

  server.registerTool('creator_check_supplier_health', {
    title: 'Re-check a published dropship listing',
    description: 'Re-checks a published dropship listing against your CJ account. If the supplier side is broken (account revoked, variant gone, out of stock, no shipping) the listing is automatically paused. Limited to one check per minute.',
    inputSchema: { productId: z.string().min(1).max(128) },
    annotations: WRITE_IDEMPOTENT,
  }, ({ productId }) => call(d.handlers.supplierProducts, { method: 'POST', body: { action: 'check_health', productId } }));

  server.registerTool('creator_list_supplier_orders', {
    title: 'List my CJ orders',
    description: 'The CJ side of your paid dropship orders: CJ order id, status, and any problem that needs your attention (e.g. needs payment inside CJ, out of stock, missing delivery detail).',
    inputSchema: {},
    annotations: READ,
  }, async () => {
    const r = await call(d.handlers.supplierOrders, { method: 'GET' });
    return r.isError ? r : asText(plain(JSON.parse(r.content[0].text)));
  });

  server.registerTool('creator_sync_dropship_order', {
    title: 'Retry or refresh a CJ order',
    description: 'action "create" retries placing the CJ order (safe: never creates a second order). action "sync" pulls CJ\'s latest status and tracking and updates the buyer\'s order (PACKED/SHIPPED).',
    inputSchema: { orderId: z.string().min(1).max(128), action: z.enum(['create', 'sync']) },
    annotations: WRITE_IDEMPOTENT,
  }, ({ orderId, action }) => call(d.handlers.supplierOrders, { method: 'POST', body: { orderId, action } }));
}

const TOOL_NAMES = [
  'creator_get_overview', 'creator_list_products', 'creator_get_product', 'creator_list_sales',
  'creator_list_orders', 'creator_get_payout_account', 'creator_list_withdrawals',
  'creator_get_listing_requirements', 'creator_create_product_draft', 'creator_update_product_draft',
  'creator_submit_product_for_review', 'creator_create_new_version', 'creator_set_product_state',
  'creator_list_notifications', 'creator_mark_notifications_read',
  'creator_acknowledge_order', 'creator_mark_order_packed', 'creator_mark_order_shipped', 'creator_cancel_order', 'creator_request_withdrawal',
  'creator_get_supplier_status', 'creator_list_dropship_mappings', 'creator_test_dropship_mapping',
  'creator_check_supplier_health', 'creator_list_supplier_orders', 'creator_sync_dropship_order',
  'creator_get_weekly_report', 'creator_get_product_checklist',
  'creator_get_profile', 'creator_update_profile', 'creator_list_disputes', 'creator_reply_to_dispute',
];

module.exports = { register, TOOL_NAMES, OFFERING_TYPES, maskAccount, fromEnvelope, plain, VERSION_KEYS };
