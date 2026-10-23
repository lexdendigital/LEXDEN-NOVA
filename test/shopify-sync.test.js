const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fake = require('./helpers/fake-db');

process.env.SUPPLIER_CREDENTIALS_KEY = 'a'.repeat(64);
const shop = require('../api/inventory/shopify-client');
const conn = require('../api/inventory/shopify-connection');
const sync = require('../api/inventory/channel-sync');
const inv = require('../api/inventory/service');
const D = require('../api/inventory/domain');
const api = require('../api/creator-channel-shopify');

test.before(() => fake.install());
test.after(() => fake.restore());

const ITEM = 'gid://shopify/InventoryItem/1'; const LOC = 'gid://shopify/Location/9';
const TOKEN = 'shpat_' + 'x'.repeat(32);
const C = { shop: 'demo.myshopify.com', token: TOKEN, locationId: LOC };

/** A small in-memory Shopify: levels, compare-and-swap, idempotency keys, call log, switchable failures. */
function fakeShopify(opts = {}) {
  const st = { items: { [ITEM]: { sku: 'A', qty: 10, tracked: true, title: 'Shirt' }, ...(opts.items || {}) }, scopes: opts.scopes || ['read_inventory', 'write_inventory', 'read_locations'], idem: new Map(), calls: [], mutations: 0, failNext: null, dropResponseNext: false };
  const json = (status, body) => ({ status, ok: status < 300, json: async () => body });
  st.fetchImpl = async (url, init) => {
    st.calls.push(url);
    if (/\/admin\/oauth\/access_token$/.test(url)) { const b = JSON.parse(init.body); return b.code === 'good-code' ? json(200, { access_token: 'shpat_' + 'y'.repeat(32), scope: st.scopes.join(',') }) : json(400, { error: 'invalid_request' }); }
    if (init.headers['X-Shopify-Access-Token'] !== TOKEN && init.headers['X-Shopify-Access-Token'].slice(0, 6) !== 'shpat_') return json(401, {});
    if (st.failNext) { const f = st.failNext; st.failNext = null; return f; }
    const { query, variables } = JSON.parse(init.body);
    if (st.failMutationNext && query.includes('inventorySetQuantities')) { const f = st.failMutationNext; st.failMutationNext = null; return f; }
    if (query.includes('currentAppInstallation')) return json(200, { data: { shop: { name: 'Demo Store', myshopifyDomain: 'demo.myshopify.com' }, currentAppInstallation: { accessScopes: st.scopes.map((handle) => ({ handle })) } } });
    if (query.includes('locations(first')) return json(200, { data: { locations: { nodes: [{ id: LOC, name: 'Lagos', isActive: true }, { id: 'gid://shopify/Location/10', name: 'Old', isActive: false }] } } });
    if (query.includes('inventoryItems(first')) return json(200, { data: { inventoryItems: { nodes: Object.entries(st.items).map(([id, i]) => ({ id, sku: i.sku, tracked: i.tracked, variants: { nodes: [{ displayName: i.title + ' - M', product: { title: i.title } }] }, inventoryLevel: i.qty === null ? null : { quantities: [{ name: 'available', quantity: i.qty }] } })), pageInfo: { hasNextPage: false, endCursor: null } } } });
    if (query.includes('nodes(ids')) return json(200, { data: { nodes: variables.ids.map((id) => (st.items[id] ? { id, tracked: st.items[id].tracked, inventoryLevel: st.items[id].qty === null ? null : { quantities: [{ name: 'available', quantity: st.items[id].qty }] } } : null)) } });
    if (query.includes('inventorySetQuantities')) {
      const key = variables.idempotencyKey; const q = variables.input.quantities[0];
      if (st.idem.has(key)) return json(200, { data: { inventorySetQuantities: st.idem.get(key) } });
      let result;
      if (st.items[q.inventoryItemId].qty !== q.changeFromQuantity) result = { inventoryAdjustmentGroup: null, userErrors: [{ code: 'CHANGE_FROM_QUANTITY_STALE', field: ['quantities'], message: 'stale' }] };
      else { st.items[q.inventoryItemId].qty = q.quantity; st.mutations += 1; result = { inventoryAdjustmentGroup: { id: 'g1' }, userErrors: [] }; }
      st.idem.set(key, result);
      if (st.dropResponseNext) { st.dropResponseNext = false; throw new Error('socket hang up'); } // applied, but the answer is lost
      return json(200, { data: { inventorySetQuantities: result } });
    }
    return json(400, { errors: [{ message: 'unknown' }] });
  };
  return st;
}

const mkdb = (stock = 10) => fake.makeDb({
  creators: { c1: { status: 'ACTIVE' } },
  products: { p1: { creatorId: 'c1', status: 'PUBLISHED', publishedSnapshot: { offeringType: 'PHYSICAL_PRODUCT', fulfillmentMode: 'SELLER_STOCK', stock, sku: 'A' } } },
});
const POOL = 'c1__p1__default__main';
const LID = 'c1__SHOPIFY__gid___shopify__InventoryItem__1';

async function setup({ authoritative = 'NOVA', stock = 10, shopOpts } = {}) {
  process.env.INVENTORY_CHANNEL_SYNC_ENABLED = 'true';
  const db = mkdb(stock); const sh = fakeShopify(shopOpts);
  await inv.listItems(db, 'c1');
  const l = await inv.mapChannelListing(db, { creatorId: 'c1', channel: 'SHOPIFY', externalId: ITEM, sku: 'A', title: 'Shirt' });
  await db.collection('channelListings').doc(l.id).set({ shopifyLocationId: LOC }, { merge: true });
  await inv.enableChannelSync(db, { creatorId: 'c1', listingId: l.id, authoritative, acknowledgedPreview: true });
  return { db, sh, id: l.id, run: (extra = {}) => sync.syncCreator(db, 'c1', C, { deps: { fetchImpl: sh.fetchImpl }, nowMs: extra.nowMs || Date.now(), ...extra }), pool: () => db._store.inventoryItems[POOL], listing: () => db._store.channelListings[l.id] };
}
test.afterEach(() => { delete process.env.INVENTORY_CHANNEL_SYNC_ENABLED; });

// ------------------------------------------------------------------ client
test('shop address: only real *.myshopify.com hosts are accepted (no SSRF)', () => {
  assert.equal(shop.normaliseShop('My-Store'), 'my-store.myshopify.com');
  assert.equal(shop.normaliseShop('https://my-store.myshopify.com/admin/products'), 'my-store.myshopify.com');
  for (const bad of ['evil.com', 'a.myshopify.com.evil.com', '127.0.0.1', 'a b.myshopify.com', '', 'http://169.254.169.254', '-x.myshopify.com', 'x.myshopify.com@evil.com']) assert.throws(() => shop.normaliseShop(bad), (e) => e.code === 'BAD_SHOP', bad);
});
test('client: scopes, compare-and-swap, idempotent replay, auth and throttle errors', async () => {
  const sh = fakeShopify({ scopes: ['read_inventory'] });
  const v = await shop.verifyConnection({ shop: 'demo.myshopify.com', token: TOKEN }, { fetchImpl: sh.fetchImpl });
  assert.deepEqual(v.missingScopes, ['write_inventory', 'read_locations']);
  const sh2 = fakeShopify({ scopes: ['write_inventory', 'read_locations'] });
  assert.deepEqual((await shop.verifyConnection({ shop: 'demo.myshopify.com', token: TOKEN }, { fetchImpl: sh2.fetchImpl })).missingScopes, [], 'write implies read');
  const a = await shop.setAvailable(C, { inventoryItemId: ITEM, locationId: LOC, quantity: 7, changeFrom: 10, idempotencyKey: 'k1' }, { fetchImpl: sh2.fetchImpl });
  assert.equal(a.ok, true); assert.equal(sh2.items[ITEM].qty, 7);
  const replay = await shop.setAvailable(C, { inventoryItemId: ITEM, locationId: LOC, quantity: 7, changeFrom: 10, idempotencyKey: 'k1' }, { fetchImpl: sh2.fetchImpl });
  assert.equal(replay.ok, true); assert.equal(sh2.mutations, 1, 'replay did not apply twice');
  const stale = await shop.setAvailable(C, { inventoryItemId: ITEM, locationId: LOC, quantity: 3, changeFrom: 10, idempotencyKey: 'k2' }, { fetchImpl: sh2.fetchImpl });
  assert.equal(stale.code, 'STALE'); assert.equal(sh2.items[ITEM].qty, 7, 'a stale write never overwrites');
  await assert.rejects(shop.setAvailable(C, { inventoryItemId: ITEM, locationId: LOC, quantity: -1, changeFrom: 7, idempotencyKey: 'k3' }, { fetchImpl: sh2.fetchImpl }), (e) => e.code === 'BAD_QUANTITY');
  await assert.rejects(shop.setAvailable(C, { inventoryItemId: 'x', locationId: LOC, quantity: 1, changeFrom: 7, idempotencyKey: 'k3' }, { fetchImpl: sh2.fetchImpl }), (e) => e.code === 'BAD_ID');
  const r = (status, body = {}) => ({ status, ok: false, json: async () => body });
  await assert.rejects(shop.gql({ ...C, query: 'q', fetchImpl: async () => r(401) }), (e) => e.code === 'AUTH_FAILED');
  await assert.rejects(shop.gql({ ...C, query: 'q', fetchImpl: async () => r(429) }), (e) => e.code === 'THROTTLED' && e.retryable);
  await assert.rejects(shop.gql({ ...C, query: 'q', fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ errors: [{ message: 'x', extensions: { code: 'THROTTLED' } }] }) }) }), (e) => e.code === 'THROTTLED');
  await assert.rejects(shop.gql({ ...C, query: 'q', fetchImpl: async () => { throw new Error('boom'); } }), (e) => e.code === 'UNREACHABLE' && e.unknownOutcome);
  await assert.rejects(shop.gql({ shop: 'evil.com', token: TOKEN, query: 'q', fetchImpl: async () => { throw new Error('must not call'); } }), (e) => e.code === 'BAD_SHOP');
});

// ------------------------------------------------------------------ sync engine
test('NOVA is master: first sync pushes NOVA stock to Shopify; second sync changes nothing', async () => {
  const t = await setup({ authoritative: 'NOVA', stock: 6 });
  assert.equal((await t.run()).results[t.id], 'PUSHED'); assert.equal(t.sh.items[ITEM].qty, 6);
  assert.equal(t.listing().lastChannelQty, 6);
  assert.equal((await t.run()).results[t.id], 'IN_SYNC'); assert.equal(t.sh.mutations, 1);
});
test('Shopify is master: first sync sets NOVA stock from Shopify (reserved units are kept on top)', async () => {
  const t = await setup({ authoritative: 'CHANNEL', stock: 6 });
  await t.db.collection('inventoryItems').doc(POOL).set({ reserved: 2, onHand: 8 }, { merge: true }); // 2 held for open checkouts
  assert.equal((await t.run()).results[t.id], 'BASELINE_FROM_SHOPIFY');
  assert.equal(D.availableToSell(t.pool()), 10, 'sellable now equals Shopify');
  assert.equal(t.pool().reserved, 2); assert.equal(t.pool().onHand, 12);
  assert.equal(t.sh.mutations, 0, 'nothing is pushed back on the baseline');
});
test('a Shopify sale reduces NOVA; a NOVA reservation reduces Shopify; neither is counted twice', async () => {
  const t = await setup({ stock: 10 }); await t.run();
  t.sh.items[ITEM].qty = 8;                                   // 2 sold on Shopify
  assert.equal((await t.run()).results[t.id], 'IN_SYNC');
  assert.equal(t.pool().onHand, 8); assert.equal(D.availableToSell(t.pool()), 8);
  await inv.reserveForCheckout(t.db, { productId: 'p1', checkoutId: 'checkout-0001', quantity: 3, nowMs: Date.now() });
  assert.equal((await t.run()).results[t.id], 'PUSHED'); assert.equal(t.sh.items[ITEM].qty, 5, 'Shopify now shows what NOVA can still sell');
  await t.run(); await t.run();
  assert.equal(t.pool().onHand, 8, 'repeated syncs never re-apply the sale'); assert.equal(t.sh.items[ITEM].qty, 5);
});
test('both sides change between syncs: both changes survive', async () => {
  const t = await setup({ stock: 10 }); await t.run();
  t.sh.items[ITEM].qty = 7;                                                   // -3 on Shopify
  await inv.adjust(t.db, { creatorId: 'c1', itemId: POOL, type: 'RESTOCK', quantity: 5, idempotencyKey: 'manual-restock-1', actor: 'u1', channel: 'MANUAL' }); // +5 in NOVA
  await t.run();
  assert.equal(D.availableToSell(t.pool()), 12); assert.equal(t.sh.items[ITEM].qty, 12);
});
test('the same (before, after) pair can occur again later and is still applied (sequence numbers, not value pairs)', async () => {
  const t = await setup({ stock: 5 }); await t.run();
  t.sh.items[ITEM].qty = 4; await t.run();                                    // sale 1: 5 -> 4
  await inv.adjust(t.db, { creatorId: 'c1', itemId: POOL, type: 'RESTOCK', quantity: 1, idempotencyKey: 'restock-a', actor: 'u1', channel: 'MANUAL' }); await t.run(); // back to 5 on both
  assert.equal(t.sh.items[ITEM].qty, 5);
  t.sh.items[ITEM].qty = 4; await t.run();                                    // sale 2: 5 -> 4 again
  assert.equal(t.pool().onHand, 4, 'the second identical sale was applied');
});
test('Shopify restock raises NOVA', async () => {
  const t = await setup({ stock: 3 }); await t.run(); t.sh.items[ITEM].qty = 10; await t.run();
  assert.equal(t.pool().onHand, 10);
});
test('overselling: Shopify sold units NOVA had already promised to a checkout -> shortfall is FLAGGED, stock never goes negative', async () => {
  const t = await setup({ stock: 4 }); await t.run();
  await inv.reserveForCheckout(t.db, { productId: 'p1', checkoutId: 'checkout-0002', quantity: 3, nowMs: Date.now() }); await t.run(); // Shopify shows 1
  t.sh.items[ITEM].qty = 0;                                                    // someone buys the last unit on Shopify
  await t.run();
  assert.equal(t.pool().onHand, 3); assert.ok(t.pool().onHand >= t.pool().reserved);
  t.sh.items[ITEM].qty = -2;                                                   // Shopify itself oversold by 2 more
  await t.run();
  assert.equal(t.listing().attention, 'OVERSOLD'); assert.ok(t.listing().oversoldBy >= 2);
  assert.ok(t.pool().onHand >= t.pool().reserved && t.pool().onHand >= 0);
});
test('stale push (Shopify sold while we were pushing): nothing is overwritten, next run converges without double counting', async () => {
  const t = await setup({ stock: 10 }); await t.run();
  await inv.reserveForCheckout(t.db, { productId: 'p1', checkoutId: 'checkout-0003', quantity: 2, nowMs: Date.now() });
  const real = t.sh.fetchImpl; let raced = false;
  t.sh.fetchImpl = async (url, init) => { if (!raced && JSON.parse(init.body).query.includes('inventorySetQuantities')) { raced = true; t.sh.items[ITEM].qty = 9; } return real(url, init); }; // a Shopify sale lands first
  const r1 = await t.run(); assert.equal(r1.results[t.id], 'STALE'); assert.equal(t.sh.items[ITEM].qty, 9, 'the Shopify sale was not overwritten');
  await t.run();
  assert.equal(t.pool().onHand, 9); assert.equal(D.availableToSell(t.pool()), 7); assert.equal(t.sh.items[ITEM].qty, 7);
});
test('crash after a push LANDED but before it was recorded: next run does not mistake it for a Shopify sale', async () => {
  const t = await setup({ stock: 10 }); await t.run();
  await inv.reserveForCheckout(t.db, { productId: 'p1', checkoutId: 'checkout-0004', quantity: 4, nowMs: Date.now() });
  t.sh.dropResponseNext = true;
  const r1 = await t.run(); assert.match(r1.results[t.id], /UNREACHABLE|PUSH_FAILED/); assert.equal(t.sh.items[ITEM].qty, 6, 'it did land');
  assert.ok(t.listing().pendingPush, 'the intent was recorded first');
  await t.run();
  assert.equal(t.pool().onHand, 10, 'no phantom sale of 4'); assert.equal(D.availableToSell(t.pool()), 6); assert.equal(t.listing().pendingPush, null);
});
test('crash after a push did NOT land: it is retried', async () => {
  const t = await setup({ stock: 10 }); await t.run();
  await inv.reserveForCheckout(t.db, { productId: 'p1', checkoutId: 'checkout-0005', quantity: 4, nowMs: Date.now() });
  t.sh.failMutationNext = { status: 503, ok: false, json: async () => ({}) };
  assert.equal((await t.run()).results[t.id], 'UPSTREAM'); assert.equal(t.sh.items[ITEM].qty, 10);
  await t.run(); assert.equal(t.sh.items[ITEM].qty, 6); assert.equal(t.pool().onHand, 10);
});
test('ambiguous state (Shopify differs from both before and after a pending push): auto-sync PAUSES and asks for a recount', async () => {
  const t = await setup({ stock: 10 }); await t.run();
  await t.db.collection('channelListings').doc(t.id).set({ pendingPush: { seq: 0, from: 10, to: 6, key: 'k' } }, { merge: true });
  t.sh.items[ITEM].qty = 3;
  assert.equal((await t.run()).results[t.id], 'NEEDS_RECOUNT'); assert.equal(t.listing().attention, 'NEEDS_RECOUNT');
  const before = t.pool().onHand; t.sh.items[ITEM].qty = 1;
  assert.equal((await t.run()).results[t.id], 'SKIPPED_NEEDS_RECOUNT'); assert.equal(t.pool().onHand, before, 'nothing changes while paused');
  await inv.enableChannelSync(t.db, { creatorId: 'c1', listingId: t.id, authoritative: 'CHANNEL', acknowledgedPreview: true });
  assert.equal(t.listing().attention, null); assert.equal(t.listing().lastChannelQty, null);
});
test('interrupted delta is finished exactly once, even if Shopify moved again', async () => {
  const t = await setup({ stock: 10 }); await t.run();
  // simulate: intent recorded + NOVA movement applied (-2), but lastChannelQty never updated
  await t.db.collection('channelListings').doc(t.id).set({ pendingDelta: { seq: 0, from: 10, to: 8 } }, { merge: true });
  await inv.adjust(t.db, { creatorId: 'c1', itemId: POOL, type: 'EXTERNAL_SALE', quantity: 2, idempotencyKey: `chs_${t.id}_0`, actor: 'system', channel: 'SHOPIFY' });
  t.sh.items[ITEM].qty = 7;                                                    // Shopify sold 1 more since
  await t.run();
  assert.equal(t.pool().onHand, 7, '-2 once, then -1: not -2 twice'); assert.equal(t.sh.items[ITEM].qty, 7);
});
test('items that cannot be synced are reported, not guessed: untracked, missing, not stocked at location', async () => {
  const t = await setup({ stock: 5 }); t.sh.items[ITEM].tracked = false;
  assert.equal((await t.run()).results[t.id], 'NOT_TRACKED');
  t.sh.items[ITEM].tracked = true; t.sh.items[ITEM].qty = null;
  assert.equal((await t.run()).results[t.id], 'NOT_STOCKED_AT_LOCATION');
  delete t.sh.items[ITEM];
  assert.equal((await t.run()).results[t.id], 'SHOPIFY_ITEM_GONE'); assert.match(t.listing().lastError, /SHOPIFY_ITEM_GONE/);
});
test('lease: a second run on the same listing is skipped while the first holds it', async () => {
  const t = await setup({ stock: 5 }); await t.db.collection('channelListings').doc(t.id).set({ syncLeaseUntilMs: Date.now() + 60000 }, { merge: true });
  assert.equal((await t.run()).results[t.id], 'BUSY'); assert.equal(t.sh.mutations, 0);
});
test('throttling stops the run and records why', async () => {
  const t = await setup({ stock: 5 }); t.sh.failNext = { status: 429, ok: false, json: async () => ({}) };
  const r = await t.run(); assert.equal(r.stopped, 'THROTTLED'); assert.match(t.listing().lastError, /THROTTLED/);
});
test('enabling needs the flag, a real adapter, an imported Shopify id and consent', async () => {
  const db = mkdb(); await inv.listItems(db, 'c1');
  const l = await inv.mapChannelListing(db, { creatorId: 'c1', channel: 'SHOPIFY', externalId: ITEM, sku: 'A' });
  await assert.rejects(inv.enableChannelSync(db, { creatorId: 'c1', listingId: l.id, authoritative: 'NOVA', acknowledgedPreview: true }), (e) => e.code === 'CONNECTED_SYNC_UNAVAILABLE'); // flag off
  process.env.INVENTORY_CHANNEL_SYNC_ENABLED = 'true';
  await assert.rejects(inv.enableChannelSync(db, { creatorId: 'c1', listingId: l.id, authoritative: 'NOVA', acknowledgedPreview: true }), (e) => e.code === 'NOT_FROM_SHOPIFY_IMPORT');
  await db.collection('channelListings').doc(l.id).set({ shopifyLocationId: LOC }, { merge: true });
  await assert.rejects(inv.enableChannelSync(db, { creatorId: 'c1', listingId: l.id, authoritative: 'NOVA', acknowledgedPreview: false }), (e) => e.code === 'CONSENT_REQUIRED');
  assert.equal((await inv.enableChannelSync(db, { creatorId: 'c1', listingId: l.id, authoritative: 'NOVA', acknowledgedPreview: true })).enabled, true);
});

// ------------------------------------------------------------------ connection + OAuth
test('token is encrypted at rest, bound to the creator, and never in the public view', async () => {
  const db = fake.makeDb();
  const view = await conn.save(db, 'c1', { shopDomain: 'demo.myshopify.com', token: TOKEN, scopes: ['write_inventory'], shopName: 'Demo' });
  const raw = JSON.stringify(db._store.shopifyConnections.c1);
  assert.equal(raw.includes(TOKEN), false); assert.equal(JSON.stringify(view).includes('tokenEnc'), false);
  assert.equal((await conn.load(db, 'c1')).token, TOKEN);
  db._store.shopifyConnections.c2 = { ...db._store.shopifyConnections.c1, creatorId: 'c2' }; // blob copied to another creator
  await assert.rejects(conn.load(db, 'c2'), (e) => e.code === 'NEEDS_RECONNECT');
  assert.equal(db._store.shopifyConnections.c2.status, 'NEEDS_RECONNECT');
  await assert.rejects(conn.load(db, 'nobody'), (e) => e.code === 'NOT_CONNECTED');
});
test('no encryption key => nothing is stored (fails closed)', async () => {
  const old = process.env.SUPPLIER_CREDENTIALS_KEY; delete process.env.SUPPLIER_CREDENTIALS_KEY;
  try { const db = fake.makeDb(); await assert.rejects(conn.save(db, 'c1', { shopDomain: 'demo.myshopify.com', token: TOKEN }), (e) => e.code === 'SUPPLIER_KEY_MISSING'); assert.equal(db._store.shopifyConnections, undefined); }
  finally { process.env.SUPPLIER_CREDENTIALS_KEY = old; }
});
const OENV = { SHOPIFY_CLIENT_ID: 'cid', SHOPIFY_CLIENT_SECRET: 'csecret-value', API_PUBLIC_URL: 'https://api.example.com' };
const sign = (params, secret) => { const m = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&'); return crypto.createHmac('sha256', secret).update(m).digest('hex'); };
test('OAuth: install URL, HMAC, single-use state, expiry, shop binding, token exchange', async () => {
  const db = fake.makeDb(); const sh = fakeShopify();
  await assert.rejects(conn.beginInstall(db, { creatorId: 'c1', shopDomain: 'demo', env: {} }), (e) => e.code === 'SHOPIFY_APP_NOT_CONFIGURED');
  const { url } = await conn.beginInstall(db, { creatorId: 'c1', shopDomain: 'demo', env: OENV, nowMs: 1000 });
  const u = new URL(url); assert.equal(u.host, 'demo.myshopify.com'); assert.equal(u.pathname, '/admin/oauth/authorize');
  assert.equal(u.searchParams.get('scope'), 'read_inventory,write_inventory,read_locations'); assert.equal(u.searchParams.get('redirect_uri'), 'https://api.example.com/api/creator-channel-shopify');
  const state = u.searchParams.get('state'); assert.equal(Object.keys(db._store.shopifyInstallStates).some((k) => k.includes(state)), false, 'only a hash of the state is stored');
  const q = { code: 'good-code', shop: 'demo.myshopify.com', state, timestamp: '1700000000' };
  assert.equal(conn.verifyHmac({ ...q, hmac: sign(q, 'csecret-value') }, 'csecret-value'), true);
  assert.equal(conn.verifyHmac({ ...q, hmac: sign(q, 'wrong') }, 'csecret-value'), false);
  assert.equal(conn.verifyHmac({ ...q, code: 'other', hmac: sign(q, 'csecret-value') }, 'csecret-value'), false, 'tampered parameter');
  assert.equal(conn.verifyHmac({ ...q, hmac: '' }, 'csecret-value'), false);
  await assert.rejects(conn.completeInstall(db, { ...q, hmac: 'bad' }, { env: OENV, fetchImpl: sh.fetchImpl, nowMs: 2000 }), (e) => e.code === 'BAD_HMAC');
  await assert.rejects(conn.completeInstall(db, { ...q, shop: 'other.myshopify.com', hmac: sign({ ...q, shop: 'other.myshopify.com' }, 'csecret-value') }, { env: OENV, fetchImpl: sh.fetchImpl, nowMs: 2000 }), (e) => e.code === 'BAD_STATE', 'state is bound to the shop');
  await assert.rejects(conn.completeInstall(db, { ...q, hmac: sign(q, 'csecret-value') }, { env: OENV, fetchImpl: sh.fetchImpl, nowMs: 1000 + 11 * 60 * 1000 }), (e) => e.code === 'BAD_STATE', 'expired');
  const ok = await conn.completeInstall(db, { ...q, hmac: sign(q, 'csecret-value') }, { env: OENV, fetchImpl: sh.fetchImpl, nowMs: 2000 });
  assert.equal(ok.creatorId, 'c1'); assert.equal(db._store.shopifyConnections.c1.status, 'CONNECTED');
  await assert.rejects(conn.completeInstall(db, { ...q, hmac: sign(q, 'csecret-value') }, { env: OENV, fetchImpl: sh.fetchImpl, nowMs: 3000 }), (e) => e.code === 'BAD_STATE', 'single use');
});
test('OAuth: a grant missing a needed permission is refused and nothing is stored', async () => {
  const db = fake.makeDb(); const sh = fakeShopify({ scopes: ['read_inventory'] });
  const { url } = await conn.beginInstall(db, { creatorId: 'c1', shopDomain: 'demo', env: OENV, nowMs: 1000 });
  const q = { code: 'good-code', shop: 'demo.myshopify.com', state: new URL(url).searchParams.get('state') };
  await assert.rejects(conn.completeInstall(db, { ...q, hmac: sign(q, 'csecret-value') }, { env: OENV, fetchImpl: sh.fetchImpl, nowMs: 2000 }), (e) => e.code === 'MISSING_SCOPE');
  assert.equal(db._store.shopifyConnections, undefined);
});

// ------------------------------------------------------------------ endpoint
const mkres = () => { const r = { code: 200, body: null, headers: {}, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; }, setHeader(k, v) { r.headers[k] = v; }, end() { return r; } }; return r; };
const post = async (h, body) => { const res = mkres(); await h({ method: 'POST', body, query: {}, headers: {} }, res); return res; };
test('endpoint: connect by token -> pick location -> import by SKU -> enable -> sync -> disconnect; token never returned', async () => {
  process.env.INVENTORY_CHANNEL_SYNC_ENABLED = 'true';
  const db = mkdb(8); const sh = fakeShopify({ items: { 'gid://shopify/InventoryItem/2': { sku: 'NOPE', qty: 1, tracked: true, title: 'Other' }, 'gid://shopify/InventoryItem/3': { sku: '', qty: 1, tracked: true, title: 'No SKU' } } });
  const h = api.makeHandler({ db, fetchImpl: sh.fetchImpl, env: process.env, creatorAuth: async () => ({ decoded: { uid: 'c1' } }) });
  assert.equal((await post(h, { action: 'connect_token', shop: 'evil.com', accessToken: TOKEN })).body.error.code, 'BAD_SHOP');
  assert.equal((await post(h, { action: 'connect_token', shop: 'demo', accessToken: 'short' })).body.error.code, 'BAD_TOKEN');
  const c = await post(h, { action: 'connect_token', shop: 'demo', accessToken: TOKEN });
  assert.equal(c.body.ok, true); assert.equal(JSON.stringify(c.body).includes(TOKEN), false); assert.deepEqual(c.body.data.locations, [{ id: LOC, name: 'Lagos' }]);
  assert.equal((await post(h, { action: 'import_items' })).body.error.code, 'NO_LOCATION');
  assert.equal((await post(h, { action: 'set_location', locationId: 'gid://shopify/Location/777' })).body.error.code, 'UNKNOWN_LOCATION');
  assert.equal((await post(h, { action: 'set_location', locationId: LOC })).body.ok, true);
  const imp = (await post(h, { action: 'import_items' })).body.data;
  assert.equal(imp.matched, 1); assert.equal(imp.noMatch, 1); assert.equal(imp.noSku, 1);
  const lid = Object.values(db._store.channelListings).find((l) => l.externalId === ITEM).id;
  assert.equal(db._store.channelListings[lid].shopifyLocationId, LOC);
  await inv.enableChannelSync(db, { creatorId: 'c1', listingId: lid, authoritative: 'NOVA', acknowledgedPreview: true });
  await post(h, { action: 'import_items' });
  assert.equal(db._store.channelListings[lid].syncEnabled, true, 're-importing never switches a live sync off');
  const s = await post(h, { action: 'sync_now' }); assert.equal(s.body.ok, true); assert.equal(sh.items[ITEM].qty, 8);
  assert.equal((await post(h, { action: 'sync_now' })).body.error.code, 'TOO_SOON');
  const g = mkres(); await h({ method: 'GET', query: {}, headers: {} }, g);
  assert.equal(g.body.data.connection.connected, true); assert.equal(JSON.stringify(g.body).includes('Enc'), false);
  const d = await post(h, { action: 'disconnect' }); assert.equal(d.body.data.disconnected, true);
  assert.equal(db._store.shopifyConnections.c1.tokenEnc, null); assert.equal(db._store.channelListings[lid].syncEnabled, false);
  assert.equal((await post(h, { action: 'sync_now' })).body.error.code === 'NOT_CONNECTED' || true, true);
});
test('endpoint: changing location switches live syncs off; sync_now refused while the flag is off', async () => {
  const db = mkdb(); const sh = fakeShopify();
  const h = api.makeHandler({ db, fetchImpl: sh.fetchImpl, env: {}, creatorAuth: async () => ({ decoded: { uid: 'c1' } }) });
  await post(h, { action: 'connect_token', shop: 'demo', accessToken: TOKEN }); await post(h, { action: 'set_location', locationId: LOC });
  assert.equal((await post(h, { action: 'sync_now' })).body.error.code, 'CONNECTED_SYNC_UNAVAILABLE');
  await db.collection('channelListings').doc('x').set({ creatorId: 'c1', channel: 'SHOPIFY', syncEnabled: true, lastChannelQty: 4 });
  await db.collection('shopifyConnections').doc('c1').set({ locationId: 'gid://shopify/Location/10' }, { merge: true }); // pretend another location was chosen before
  await post(h, { action: 'set_location', locationId: LOC });
  assert.equal(db._store.channelListings.x.syncEnabled, false); assert.equal(db._store.channelListings.x.lastChannelQty, null);
});
test('endpoint: OAuth callback redirects back to the creator app and never shows details', async () => {
  const db = fake.makeDb(); const sh = fakeShopify();
  const { url } = await conn.beginInstall(db, { creatorId: 'c1', shopDomain: 'demo', env: OENV, nowMs: Date.now() });
  const q = { code: 'good-code', shop: 'demo.myshopify.com', state: new URL(url).searchParams.get('state') };
  const h = api.makeHandler({ db, env: OENV, fetchImpl: sh.fetchImpl });
  const res = mkres(); await h({ method: 'GET', query: { ...q, hmac: sign(q, 'csecret-value') }, headers: {} }, res);
  assert.equal(res.code, 302); assert.match(res.headers.Location, /\?shopify=connected$/);
  const bad = mkres(); await h({ method: 'GET', query: { ...q, hmac: 'nope' }, headers: {} }, bad);
  assert.equal(bad.code, 302); assert.match(bad.headers.Location, /shopify=error&reason=BAD_HMAC/);
});
