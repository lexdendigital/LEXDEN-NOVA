// /api/creator-channel-shopify.js — connect ONE Shopify store to a creator's NOVA stock
//
//   GET  ?code&hmac&shop&state&...     OAuth callback from Shopify (no login header; protected by HMAC + single-use state)
//   GET                                 ACTIVE CREATOR -> { oauthAvailable, connection (no token), syncAvailable }
//   POST {action:"begin_install", shop}             -> { url }  (send the creator to Shopify's approval screen)
//   POST {action:"connect_token", shop, accessToken}-> paste an Admin API token from an existing custom app
//   POST {action:"locations"}                       -> the store's locations
//   POST {action:"set_location", locationId}
//   POST {action:"import_items", after?}            -> one page of Shopify items, matched to NOVA stock by SKU
//   POST {action:"sync_now", listingId?}            -> sync now (needs INVENTORY_CHANNEL_SYNC_ENABLED=true)
//   POST {action:"disconnect"}
// The access token is encrypted at rest and is never returned. Every action is audit-logged.
const { getDb, requireActiveCreator, ok, fail, setCors, writeCreatorAuditLog } = require('./creator/shared');
const cfg = require('./core/config');
const inv = require('./inventory/service');
const sync = require('./inventory/channel-sync'); // also registers the Shopify adapter
const shop = require('./inventory/shopify-client');
const C = require('./inventory/shopify-connection');

const E = (status, code, message) => Object.assign(new Error(message), { status, code });
const APP_URL = () => String(process.env.CREATOR_APP_URL || 'https://lexdendigital.github.io/LEXDEN-NOVA/creator/');
const toShopifyError = (e) => (e instanceof shop.ShopifyError ? E(e.status === 429 ? 429 : (e.status || 502), e.code, e.message) : e);

async function disableListings(db, creatorId) {
  const snap = await db.collection('channelListings').where('creatorId', '==', creatorId).limit(500).get();
  for (const d of snap.docs) if (d.data().channel === 'SHOPIFY' && d.data().syncEnabled) await d.ref.set({ syncEnabled: false, syncMode: 'MANUAL_OR_BATCH', lastChannelQty: null, pendingDelta: null, pendingPush: null }, { merge: true });
}

async function act(db, ctx, b, deps = {}) {
  const { creatorId } = ctx; const env = deps.env || process.env;
  const fetchImpl = deps.fetchImpl; const nowMs = (deps.now || Date.now)();
  switch (b.action) {
    case 'begin_install': return C.beginInstall(db, { creatorId, shopDomain: b.shop, env, nowMs });
    case 'connect_token': {
      const host = shop.normaliseShop(b.shop);
      const token = String(b.accessToken || '').trim();
      if (token.length < 20 || token.length > 200 || /\s/.test(token)) throw E(422, 'BAD_TOKEN', 'That does not look like a Shopify Admin API access token.');
      let check;
      try { check = await shop.verifyConnection({ shop: host, token }, { fetchImpl }); } catch (e) { throw toShopifyError(e); }
      if (check.missingScopes.length) throw E(422, 'MISSING_SCOPE', `The token is missing these permissions: ${check.missingScopes.join(', ')}.`);
      const view = await C.save(db, creatorId, { shopDomain: host, token, scopes: check.scopes, shopName: check.shopName, nowMs });
      let locations = []; try { locations = await shop.listLocations({ shop: host, token }, { fetchImpl }); } catch (e) { /* the creator can retry */ }
      return { connection: view, locations };
    }
    case 'locations': {
      const conn = await C.load(db, creatorId, { nowMs, env, fetchImpl });
      try { return { locations: await shop.listLocations(conn, { fetchImpl }) }; } catch (e) { throw toShopifyError(e); }
    }
    case 'set_location': {
      const conn = await C.load(db, creatorId, { nowMs, env, fetchImpl });
      let locs; try { locs = await shop.listLocations(conn, { fetchImpl }); } catch (e) { throw toShopifyError(e); }
      const loc = locs.find((l) => l.id === b.locationId);
      if (!loc) throw E(422, 'UNKNOWN_LOCATION', 'Pick one of your store locations.');
      const raw = await C.getRaw(db, creatorId);
      if (raw.locationId && raw.locationId !== loc.id) await disableListings(db, creatorId); // stock numbers of another location mean nothing here
      await db.collection('shopifyConnections').doc(creatorId).set({ locationId: loc.id, locationName: loc.name }, { merge: true });
      return { locationId: loc.id, locationName: loc.name };
    }
    case 'import_items': {
      const conn = await C.load(db, creatorId, { nowMs, env, fetchImpl });
      if (!conn.locationId) throw E(409, 'NO_LOCATION', 'Choose a Shopify location first.');
      let page; try { page = await shop.listInventoryItems(conn, { locationId: conn.locationId, after: b.after ? String(b.after) : null }, { fetchImpl }); } catch (e) { throw toShopifyError(e); }
      const report = { matched: 0, needsReview: 0, noMatch: 0, noSku: 0, untracked: 0, alreadySyncing: 0 };
      for (const it of page.items) {
        if (!it.tracked) { report.untracked += 1; continue; }
        if (!it.sku) { report.noSku += 1; continue; }
        const id = `${creatorId}__SHOPIFY__${it.id}`.replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 120);
        const cur = await db.collection('channelListings').doc(id).get();
        if (cur.exists && cur.data().syncEnabled) { report.alreadySyncing += 1; await cur.ref.set({ title: it.title || null }, { merge: true }); continue; } // never reset a live sync
        const l = await inv.mapChannelListing(db, { creatorId, channel: 'SHOPIFY', externalId: it.id, sku: it.sku, title: it.title });
        await db.collection('channelListings').doc(l.id).set({ shopifyLocationId: conn.locationId, shopifyAvailable: it.available, importedAtMs: nowMs }, { merge: true });
        if (l.mappingStatus === 'MAPPED') report.matched += 1; else if (l.mappingStatus === 'UNMAPPED') report.noMatch += 1; else report.needsReview += 1;
      }
      return { ...report, next: page.next, scanned: page.items.length };
    }
    case 'sync_now': {
      if (!cfg.flags(env).connectedChannelSync) throw E(409, 'CONNECTED_SYNC_UNAVAILABLE', 'Automatic Shopify sync is not switched on yet.');
      const raw = await C.getRaw(db, creatorId);
      if (raw && raw.lastManualSyncAtMs && nowMs - raw.lastManualSyncAtMs < 30 * 1000) throw E(429, 'TOO_SOON', 'Wait a few seconds before syncing again.');
      const conn = await C.load(db, creatorId, { nowMs, env, fetchImpl });
      if (!conn.locationId) throw E(409, 'NO_LOCATION', 'Choose a Shopify location first.');
      await db.collection('shopifyConnections').doc(creatorId).set({ lastManualSyncAtMs: nowMs }, { merge: true });
      return sync.syncCreator(db, creatorId, conn, { nowMs, deps: { fetchImpl }, onlyListingId: b.listingId ? String(b.listingId) : null });
    }
    case 'disconnect': {
      await disableListings(db, creatorId);
      await db.collection('shopifyConnections').doc(creatorId).set({ status: 'DISCONNECTED', tokenEnc: null, refreshEnc: null, locationId: null, locationName: null, disconnectedAtMs: nowMs }, { merge: true });
      return { disconnected: true, note: 'To fully remove access, also uninstall the app in your Shopify admin (Settings > Apps).' };
    }
    default: throw E(400, 'INVALID_ACTION', `Unknown action "${b.action}".`);
  }
}

function makeHandler(deps = {}) {
  return async function handler(req, res) {
    setCors(res);
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    const q = req.query || {};
    try {
      const db = deps.db || getDb();
      // OAuth callback: not a signed-in call. HMAC + single-use state are the proof.
      if (req.method === 'GET' && q.hmac && q.state) {
        let dest;
        try { const r = await C.completeInstall(db, q, { env: deps.env, fetchImpl: deps.fetchImpl, nowMs: (deps.now || Date.now)() }); dest = `${APP_URL()}?shopify=connected`; writeCreatorAuditLog({ actorUid: r.creatorId, actorRole: 'creator', action: 'shopify.connected', targetType: 'shop', targetId: r.shop }).catch(() => {}); }
        catch (e) { dest = `${APP_URL()}?shopify=error&reason=${encodeURIComponent(e.code || 'ERROR')}`; }
        res.setHeader('Location', dest); res.setHeader('Referrer-Policy', 'no-referrer');
        return res.status(302).end();
      }
      const { decoded } = await (deps.creatorAuth || requireActiveCreator)(req);
      const ctx = { uid: decoded.uid, creatorId: decoded.uid };
      if (req.method === 'GET') {
        const raw = await C.getRaw(db, ctx.creatorId);
        return ok(res, { oauthAvailable: C.oauthConfig(deps.env).configured, syncAvailable: cfg.flags(deps.env || process.env).connectedChannelSync, connection: C.publicView(raw), lastSyncAtMs: raw && raw.lastSyncAtMs || null });
      }
      if (req.method !== 'POST') throw E(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST.');
      const b = req.body || {};
      const out = await act(db, ctx, b, deps);
      if (['connect_token', 'set_location', 'disconnect', 'sync_now'].includes(b.action)) writeCreatorAuditLog({ actorUid: ctx.uid, actorRole: 'creator', action: `shopify.${b.action}`, targetType: 'shopifyConnection', targetId: ctx.creatorId }).catch(() => {});
      return ok(res, out);
    } catch (e) { return fail(res, e instanceof shop.ShopifyError ? toShopifyError(e) : e); }
  };
}
module.exports = makeHandler();
module.exports.makeHandler = makeHandler;
module.exports.act = act;
