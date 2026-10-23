// api/inventory/channel-sync.js
//
// Two-way stock sync between a creator's NOVA stock and ONE Shopify location.
//
// The number that is compared: Shopify "available"  <->  NOVA availableToSell
//   (availableToSell = onHand - reserved - unavailable - safetyStock; see inventory/domain.js)
//
// The method is DELTA reconciliation, not "last writer wins", so a sale on EITHER side is never lost:
//   L = the Shopify quantity NOVA last accounted for (listing.lastChannelQty)
//   S = Shopify "available" right now
//   S - L is what happened on Shopify since the last sync (sales < 0, restocks > 0). It is applied to NOVA
//   as an EXTERNAL_SALE / RESTOCK movement. NOVA's own changes (sales, reservations, restocks) are then
//   pushed to Shopify with a compare-and-swap, so a Shopify sale a moment ago is never overwritten.
//
// Crash safety (each step is recorded BEFORE it is done, and every write is idempotent):
//   pendingDelta  -> finished first on the next run (same idempotency key = applied at most once)
//   pendingPush   -> next run compares Shopify with {from,to}: equal to "to" = it landed, equal to "from" = it
//                    did not, anything else = unknown, so auto-sync STOPS for that listing (NEEDS_RECOUNT).
// A per-listing lease stops two runs (cron + "Sync now") from working on the same listing at once.
// Nothing here ever invents stock: if Shopify sold more than NOVA could cover, the shortfall is flagged OVERSOLD.
const crypto = require('crypto');
const D = require('./domain');
const inv = require('./service');
const shop = require('./shopify-client');

const { MOVEMENT_TYPES: T } = D;
const LEASE_MS = 60 * 1000;
const items = (db) => db.collection('inventoryItems');
const listings = (db) => db.collection('channelListings');
const safe = (s) => String(s).replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 120);
const shortHash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 24);

async function patch(db, id, fields) { await listings(db).doc(id).set(fields, { merge: true }); }

async function claim(db, id, nowMs) {
  return db.runTransaction(async (tx) => {
    const ref = listings(db).doc(id); const s = await tx.get(ref);
    if (!s.exists) return null;
    const l = s.data();
    if (l.syncLeaseUntilMs && l.syncLeaseUntilMs > nowMs) return null;
    tx.set(ref, { syncLeaseUntilMs: nowMs + LEASE_MS }, { merge: true });
    return { ...l, syncLeaseUntilMs: nowMs + LEASE_MS };
  });
}
const release = (db, id) => patch(db, id, { syncLeaseUntilMs: 0 }).catch(() => {});

async function readItem(db, itemId) { const s = await items(db).doc(itemId).get(); return s.exists ? s.data() : null; }

/** Applies a Shopify-side change to NOVA. Returns the number of units NOVA could NOT cover (oversold). */
async function applyDeltaToNova(db, { creatorId, itemId, delta, key, listingId, nowMs }) {
  const base = { creatorId, itemId, channel: 'SHOPIFY', actor: 'system:shopify-sync', idempotencyKey: key, relatedRef: listingId, nowMs };
  if (delta > 0) { await inv.adjust(db, { ...base, type: T.RESTOCK, quantity: delta, reason: 'SHOPIFY_RESTOCK' }); return 0; }
  let want = -delta; let shortfall = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const it = await readItem(db, itemId);
    const free = Math.max(0, it.onHand - it.reserved - it.unavailable);
    const take = Math.min(want, free);
    shortfall = want - take;
    if (take === 0) return shortfall;
    try { await inv.adjust(db, { ...base, type: T.EXTERNAL_SALE, quantity: take, reason: 'SHOPIFY_SALE' }); return shortfall; }
    catch (e) { if (e.code !== 'INSUFFICIENT_UNRESERVED_STOCK' || attempt === 2) throw e; }
  }
  return shortfall;
}

function pushKey(listing, seq, from, to) { return `nova-${shortHash(`${listing.id}|${seq}|${from}|${to}`)}`; }

/**
 * One listing, one pass. `lvl` is Shopify's current level for the item. Returns a short result code.
 * Never throws for an expected problem; unknown-outcome network errors leave the recorded intent in place.
 */
async function reconcile(db, listing, lvl, conn, ctx) {
  const { nowMs, deps } = ctx; const id = listing.id;
  const fail = async (code, message, extra = {}) => { await patch(db, id, { lastError: `${code}: ${message}`.slice(0, 220), lastAttemptAtMs: nowMs, ...extra }); return code; };
  if (listing.attention === 'NEEDS_RECOUNT') return 'SKIPPED_NEEDS_RECOUNT';
  if (!listing.itemId) return fail('NOT_MAPPED', 'This listing is not matched to a NOVA product yet.');
  if (lvl.missing) return fail('SHOPIFY_ITEM_GONE', 'This item no longer exists in Shopify.');
  if (!lvl.tracked) return fail('NOT_TRACKED', 'Inventory tracking is off for this item in Shopify.');
  if (lvl.available === null) return fail('NOT_STOCKED_AT_LOCATION', 'This item is not stocked at the chosen Shopify location.');
  const S = lvl.available;
  let item = await readItem(db, listing.itemId);
  if (!item || item.creatorId !== listing.creatorId) return fail('NOVA_ITEM_MISSING', 'The matched NOVA stock item was not found.');
  let L = Number.isInteger(listing.lastChannelQty) ? listing.lastChannelQty : null;
  let syncSeq = listing.syncSeq || 0; let pushSeq = listing.pushSeq || 0; let oversold = listing.oversoldBy || 0;
  const common = { creatorId: listing.creatorId, itemId: listing.itemId, listingId: id, nowMs };

  // 1) Finish an interrupted delta first (same key => applied at most once), THEN look at Shopify again.
  if (listing.pendingDelta) {
    const pd = listing.pendingDelta;
    const short = await applyDeltaToNova(db, { ...common, delta: pd.to - pd.from, key: `chs_${safe(id)}_${pd.seq}` });
    L = pd.to; syncSeq = pd.seq + 1;
    oversold += short;
    await patch(db, id, { lastChannelQty: L, syncSeq, pendingDelta: null, ...(short ? { attention: 'OVERSOLD', oversoldBy: oversold } : {}) });
    item = await readItem(db, listing.itemId);
  }
  // 2) Resolve an interrupted push by looking at what Shopify holds now.
  if (listing.pendingPush) {
    const pp = listing.pendingPush;
    if (S === pp.to) { L = S; pushSeq = pp.seq + 1; await patch(db, id, { lastChannelQty: S, pushSeq, pendingPush: null, lastSuccessAtMs: nowMs, lastError: null }); }
    else if (S === pp.from) { await patch(db, id, { pendingPush: null }); }
    else { await patch(db, id, { attention: 'NEEDS_RECOUNT', lastError: 'The last update to Shopify may or may not have landed and stock changed since. Auto-sync is paused: confirm the count and turn sync on again.', pendingPush: null }); return 'NEEDS_RECOUNT'; }
  }

  let avail = D.availableToSell(item);
  // 3) First run after enabling: establish the baseline by the creator's chosen master system.
  if (L === null) {
    if (listing.authoritative === 'CHANNEL') {
      const target = S + item.reserved + item.unavailable + (item.safetyStock || 0);
      try {
        await inv.adjust(db, { ...common, creatorId: listing.creatorId, itemId: listing.itemId, type: T.COUNT_CORRECTION, countedOnHand: target, channel: 'SHOPIFY', actor: 'system:shopify-sync', idempotencyKey: `chb_${safe(id)}_${listing.baselineSeq || 0}`, relatedRef: id, reason: 'SHOPIFY_BASELINE' });
      } catch (e) { return fail(e.code || 'BASELINE_FAILED', e.message); }
      L = S; await patch(db, id, { lastChannelQty: S, lastSuccessAtMs: nowMs, lastError: null });
      return 'BASELINE_FROM_SHOPIFY';
    }
    // NOVA is the master: Shopify is brought to NOVA's number below. Shopify's number is the reference for the swap.
    L = S;
  } else if (S !== L) {
    // 4) Shopify changed since last time: record intent, apply to NOVA, then mark it accounted for.
    const seq = syncSeq;
    await patch(db, id, { pendingDelta: { seq, from: L, to: S } });
    const short = await applyDeltaToNova(db, { ...common, delta: S - L, key: `chs_${safe(id)}_${seq}` });
    L = S; syncSeq = seq + 1; oversold += short;
    await patch(db, id, { lastChannelQty: S, syncSeq, pendingDelta: null, ...(short ? { attention: 'OVERSOLD', oversoldBy: oversold } : {}) });
    item = await readItem(db, listing.itemId); avail = D.availableToSell(item);
  }

  // 5) Push NOVA's number to Shopify (compare-and-swap on what Shopify held).
  if (S === avail) { await patch(db, id, { lastChannelQty: S, lastSuccessAtMs: nowMs, lastError: null, lastAttemptAtMs: nowMs }); return 'IN_SYNC'; }
  const key = pushKey(listing, pushSeq, S, avail);
  await patch(db, id, { pendingPush: { seq: pushSeq, from: S, to: avail, key } });
  let r;
  try { r = await shop.setAvailable(conn, { inventoryItemId: listing.externalId, locationId: listing.shopifyLocationId, quantity: avail, changeFrom: S, idempotencyKey: key, reference: id }, deps); }
  catch (e) { return fail(e.code || 'PUSH_FAILED', e.message); } // outcome unknown: pendingPush stays and is resolved next run
  if (r.ok) { await patch(db, id, { lastChannelQty: avail, pushSeq: pushSeq + 1, pendingPush: null, lastSuccessAtMs: nowMs, lastError: null, lastAttemptAtMs: nowMs }); return 'PUSHED'; }
  await patch(db, id, { pendingPush: null });
  return fail(r.code, r.message);
}

/** Syncs every enabled Shopify listing of one creator. `conn` = {shop, token, locationId} (token already decrypted). */
async function syncCreator(db, creatorId, conn, { nowMs = Date.now(), deps = {}, onlyListingId = null } = {}) {
  const snap = await listings(db).where('creatorId', '==', creatorId).limit(500).get();
  let rows = snap.docs.map((d) => d.data()).filter((l) => l.channel === 'SHOPIFY' && l.syncEnabled === true);
  if (onlyListingId) rows = rows.filter((l) => l.id === onlyListingId);
  const out = { checked: 0, results: {}, stopped: null };
  if (!rows.length) return out;
  const ids = [...new Set(rows.map((l) => l.externalId))];
  let levels;
  try { levels = await shop.readLevels(conn, { ids, locationId: conn.locationId }, deps); }
  catch (e) { out.stopped = e.code || 'READ_FAILED'; await Promise.all(rows.map((l) => patch(db, l.id, { lastError: `${e.code || 'READ_FAILED'}: ${e.message}`.slice(0, 220), lastAttemptAtMs: nowMs }))); return out; }
  for (const row of rows) {
    const mine = await claim(db, row.id, nowMs);
    if (!mine) { out.results[row.id] = 'BUSY'; continue; }
    try {
      const lvl = levels.get(row.externalId) || { available: null, tracked: false, missing: true };
      const code = await reconcile(db, { ...mine, shopifyLocationId: mine.shopifyLocationId || conn.locationId }, lvl, conn, { nowMs, deps });
      out.results[row.id] = code; out.checked += 1;
      if (code === 'THROTTLED') { out.stopped = 'THROTTLED'; break; }
      const it = await readItem(db, mine.itemId); if (it) await inv.refreshStockSummary(db, it.productId).catch(() => {});
    } catch (e) { out.results[row.id] = `ERROR_${e.code || 'UNKNOWN'}`; await patch(db, row.id, { lastError: `${e.code || 'ERROR'}: ${e.message}`.slice(0, 220), lastAttemptAtMs: nowMs }); }
    finally { await release(db, row.id); }
  }
  return out;
}

// Registers Shopify with the inventory service so enableChannelSync() can switch it on (still behind the flag).
inv.ADAPTERS.SHOPIFY = {
  channel: 'SHOPIFY',
  /** Extra fields to write when a creator turns sync on: a clean baseline, no leftover intent. */
  onEnable(listing, { nowMs = Date.now() } = {}) {
    if (!shop.isGid(listing.externalId) || !shop.isGid(listing.shopifyLocationId)) { const e = new Error('Import this item from Shopify first so its Shopify ids and location are known.'); e.status = 409; e.code = 'NOT_FROM_SHOPIFY_IMPORT'; throw e; }
    return { lastChannelQty: null, pendingDelta: null, pendingPush: null, attention: null, oversoldBy: 0, baselineSeq: (listing.baselineSeq || 0) + 1, lastError: null, syncLeaseUntilMs: 0 };
  },
};

module.exports = { syncCreator, reconcile, applyDeltaToNova, pushKey, LEASE_MS };
