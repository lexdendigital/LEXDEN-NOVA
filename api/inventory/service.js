// api/inventory/service.js
//
// Firestore-backed inventory. Every state change is ONE transaction that reads first,
// applies the pure rules from ./domain.js, then writes the item + an IMMUTABLE movement
// (document id = idempotency key, written with create-semantics) so a retry, a replayed
// webhook or a double-tap on a slow phone can never apply a change twice.
//
// Collections:
//   inventoryItems/{creator__product__variant__location}   canonical stock pool
//   inventoryMovements/{key}                               immutable history (never updated/deleted)
//   inventoryReservations/{product__checkoutId}            checkout holds (ACTIVE|CONSUMED|RELEASED|EXPIRED)
//   inventoryLocations/{id}                                where stock physically is
//   channelListings/{id}                                   external listing -> canonical pool mapping
//
// Only creator-held SELLER_STOCK physical goods use this ledger. CJ supplier availability,
// pickup-station stock, slots, capacity and digital entitlements are separate sources.
const { FieldValue } = require('../creator/shared');
const D = require('./domain');
const cfg = require('../core/config');

const { InventoryError, MOVEMENT_TYPES: T } = D;
const KEY_RE = /^[A-Za-z0-9_\-:.]{8,80}$/;
const err = (status, code, message) => Object.assign(new Error(message), { status, code });

const items = (db) => db.collection('inventoryItems');
const moves = (db) => db.collection('inventoryMovements');
const resvs = (db) => db.collection('inventoryReservations');
const safeId = (s) => String(s).replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 120);

function movementDoc(item, itemIdValue, applied, ctx) {
  return {
    itemId: itemIdValue, creatorId: item.creatorId, productId: item.productId, variantKey: item.variantKey, locationId: item.locationId,
    type: applied.movement.type, quantity: applied.movement.quantity, reason: applied.movement.reason || ctx.reason || null,
    note: ctx.note ? String(ctx.note).slice(0, 300) : null,
    before: applied.movement.before, after: applied.movement.after,
    channel: ctx.channel || 'NOVA', actor: ctx.actor || null, relatedRef: ctx.relatedRef || null, atMs: ctx.nowMs,
    createdAt: FieldValue.serverTimestamp(),
  };
}

/** Reads (and, if absent, stages creation of) a stock pool. MUST be called before any tx write. */
async function readOrInitItem(tx, db, spec, product) {
  const id = D.itemId(spec);
  const ref = items(db).doc(id);
  const snap = await tx.get(ref);
  if (snap.exists) return { id, ref, item: snap.data(), created: false };
  // First sight of a legacy listing: seed from the stock the seller typed on the product.
  // No number typed => 0 (out of stock) until the seller sets stock: never assume "unlimited".
  const snapshot = (product && product.publishedSnapshot) || {};
  const opening = typeof snapshot.stock === 'number' && Number.isInteger(snapshot.stock) && snapshot.stock >= 0 ? snapshot.stock : 0;
  const base = D.newItem({ ...spec, sku: snapshot.sku ? String(snapshot.sku).slice(0, 64) : null, gtin: snapshot.gtin ? String(snapshot.gtin).slice(0, 64) : null, onHand: opening });
  return { id, ref, item: { ...base, productTitle: snapshot.title ? String(snapshot.title).slice(0, 140) : null, createdAtMs: Date.now() }, created: true, opening };
}

function stageInit(tx, db, rec, nowMs) {
  if (!rec.created) return;
  tx.set(rec.ref, rec.item);
  tx.create(moves(db).doc(`init_${rec.id}`), {
    itemId: rec.id, creatorId: rec.item.creatorId, productId: rec.item.productId, variantKey: rec.item.variantKey, locationId: rec.item.locationId,
    type: T.INITIAL_IMPORT, quantity: rec.opening, reason: 'LEGACY_STOCK_FIELD', note: 'Opening quantity taken from the stock typed on the listing.',
    before: { onHand: 0, reserved: 0, unavailable: 0, safetyStock: 0, availableToSell: 0 },
    after: { onHand: rec.item.onHand, reserved: 0, unavailable: 0, safetyStock: 0, availableToSell: D.availableToSell(rec.item) },
    channel: 'NOVA', actor: 'system', atMs: nowMs,
  });
}

const usesUnitStock = (product) => {
  const s = (product && product.publishedSnapshot) || {};
  return s.offeringType === 'PHYSICAL_PRODUCT' && (s.fulfillmentMode || 'SELLER_STOCK') === 'SELLER_STOCK';
};

// ------------------------------------------------------------------ reservations
async function releaseReservation(db, { reservationId, reason = 'RELEASED', nowMs = Date.now() }) {
  const rRef = resvs(db).doc(reservationId);
  return db.runTransaction(async (tx) => {
    const rSnap = await tx.get(rRef);
    if (!rSnap.exists) return { ok: false, reason: 'NOT_FOUND' };
    const r = rSnap.data();
    if (r.state === 'RELEASED' || r.state === 'EXPIRED') return { ok: true, already: true };
    if (r.state === 'CONSUMED') return { ok: false, reason: 'ALREADY_CONSUMED' };
    const iSnap = await tx.get(items(db).doc(r.itemId));
    const applied = D.applyMovement(iSnap.data(), { type: T.RELEASE, quantity: r.quantity });
    tx.set(items(db).doc(r.itemId), applied.item);
    tx.create(moves(db).doc(`${safeId(reservationId)}_RELEASE`), movementDoc(applied.item, r.itemId, applied, { nowMs, channel: 'NOVA', actor: 'system', relatedRef: r.orderRef || reservationId, reason }));
    tx.set(rRef, { state: reason === 'EXPIRED' ? 'EXPIRED' : 'RELEASED', releasedAtMs: nowMs, releaseReason: reason }, { merge: true });
    return { ok: true, released: r.quantity };
  });
}

/** Releases every expired ACTIVE hold on a pool (lazy sweep + the scheduled job). */
async function sweepExpired(db, { itemId, nowMs = Date.now(), limit = 200 } = {}) {
  let q = resvs(db).where('state', '==', 'ACTIVE');
  if (itemId) q = q.where('itemId', '==', itemId);
  const snap = await q.limit(1000).get();
  let released = 0;
  for (const d of snap.docs.filter((x) => x.data().expiresAtMs <= nowMs).slice(0, limit)) {
    const r = await releaseReservation(db, { reservationId: d.id, reason: 'EXPIRED', nowMs });
    if (r.ok && !r.already) released += 1;
  }
  return { checked: snap.docs.length, released };
}

/**
 * Pre-payment hold. Atomic: two buyers racing for the last unit cannot both get it.
 * Returns { ok, tracked:false } for listings that do not use unit stock (nothing to hold).
 */
async function reserveForCheckout(db, { productId, variantKey = 'default', locationId = 'main', quantity = 1, checkoutId, buyerUid = null, ttlMs = cfg.RESERVATION_TTL_MS, nowMs = Date.now() }) {
  if (!KEY_RE.test(String(checkoutId || ''))) throw err(422, 'BAD_CHECKOUT_ID', 'A checkout id (8-80 letters, digits, - or _) is required.');
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) throw err(422, 'BAD_QUANTITY', 'Quantity must be a whole number from 1 to 20.');
  const resId = `${safeId(productId)}__${safeId(checkoutId)}`;
  const pre = await db.collection('products').doc(productId).get();
  if (pre.exists && usesUnitStock(pre.data())) await sweepExpired(db, { itemId: D.itemId({ creatorId: pre.data().creatorId, productId, variantKey, locationId }), nowMs });
  return db.runTransaction(async (tx) => {
    const rRef = resvs(db).doc(resId);
    const rSnap = await tx.get(rRef);
    const pSnap = await tx.get(db.collection('products').doc(productId));
    if (!pSnap.exists) throw err(404, 'NOT_FOUND', 'This item is not available.');
    const product = { id: pSnap.id, ...pSnap.data() };
    if (product.status !== 'PUBLISHED' || !product.publishedSnapshot) throw err(409, 'NOT_FOR_SALE', 'This item is not available.');
    const cSnap = await tx.get(db.collection('creators').doc(product.creatorId));
    if (!cSnap.exists || cSnap.data().status !== 'ACTIVE') throw err(409, 'SELLER_UNAVAILABLE', 'This seller is not taking orders right now.');
    if (!usesUnitStock(product)) return { ok: true, tracked: false, reservation: null };
    if (rSnap.exists) {
      const r = rSnap.data();
      if (r.state === 'ACTIVE' && r.expiresAtMs > nowMs) return { ok: true, tracked: true, reused: true, reservation: { id: resId, expiresAtMs: r.expiresAtMs, quantity: r.quantity } };
      throw err(409, 'RESERVATION_CLOSED', 'This checkout expired. Please start again.');
    }
    const spec = { creatorId: product.creatorId, productId, variantKey, locationId };
    const rec = await readOrInitItem(tx, db, spec, product);
    let applied;
    try { applied = D.applyMovement(rec.item, { type: T.RESERVE, quantity }); }
    catch (e) { if (e instanceof InventoryError) throw err(409, e.code, e.message); throw e; }
    stageInit(tx, db, rec, nowMs);
    tx.set(rec.ref, applied.item);
    tx.create(moves(db).doc(`${resId}_RESERVE`), movementDoc(applied.item, rec.id, applied, { nowMs, channel: 'CHECKOUT', actor: buyerUid || 'guest', relatedRef: resId }));
    tx.create(rRef, { id: resId, itemId: rec.id, creatorId: product.creatorId, productId, variantKey, locationId, quantity, state: 'ACTIVE', buyerUid, createdAtMs: nowMs, expiresAtMs: nowMs + ttlMs, orderRef: null });
    return { ok: true, tracked: true, reservation: { id: resId, expiresAtMs: nowMs + ttlMs, quantity } };
  });
}

/**
 * A VERIFIED payment consumes the hold exactly once (idempotent on orderRef). It never throws
 * for a stock shortage: it returns { ok:false, code } so the caller can open an exception for a
 * paid order that cannot be honoured, instead of silently clamping stock at zero.
 */
async function consumeForOrder(db, { orderRef, productId, reservationId = null, variantKey = 'default', locationId = 'main', quantity = 1, nowMs = Date.now() }) {
  const consumeKey = `${safeId(orderRef)}_CONSUME`;
  return db.runTransaction(async (tx) => {
    const done = await tx.get(moves(db).doc(consumeKey));
    if (done.exists) return { ok: true, already: true };
    const pSnap = await tx.get(db.collection('products').doc(productId));
    if (!pSnap.exists) return { ok: false, code: 'PRODUCT_MISSING' };
    const product = { id: pSnap.id, ...pSnap.data() };
    if (!usesUnitStock(product)) return { ok: true, tracked: false };
    let r = null; let rRef = null;
    if (reservationId) {
      rRef = resvs(db).doc(reservationId);
      const rSnap = await tx.get(rRef);
      r = rSnap.exists ? rSnap.data() : null;
      if (r && r.productId !== productId) return { ok: false, code: 'RESERVATION_MISMATCH' };
      if (r && r.state === 'CONSUMED' && r.orderRef && r.orderRef !== orderRef) return { ok: false, code: 'RESERVATION_ALREADY_USED' };
    }
    const spec = { creatorId: product.creatorId, productId, variantKey: r ? r.variantKey : variantKey, locationId: r ? r.locationId : locationId };
    const rec = await readOrInitItem(tx, db, spec, product);
    const qty = r ? r.quantity : quantity;
    let item = rec.item; const writes = [];
    try {
      if (r && r.state === 'ACTIVE') {
        const a = D.applyMovement(item, { type: T.CONSUME, quantity: qty }); item = a.item; writes.push([consumeKey, a]);
      } else {
        // No live hold (none given, expired, or released before the late payment arrived):
        // honour the paid order only if stock still exists, atomically reserve+consume.
        const a1 = D.applyMovement(item, { type: T.RESERVE, quantity: qty }); item = a1.item;
        const a2 = D.applyMovement(item, { type: T.CONSUME, quantity: qty }); item = a2.item;
        writes.push([`${safeId(orderRef)}_RESERVE`, a1], [consumeKey, a2]);
      }
    } catch (e) {
      if (e instanceof InventoryError) return { ok: false, code: 'STOCK_UNAVAILABLE_AFTER_PAYMENT', message: e.message };
      throw e;
    }
    stageInit(tx, db, rec, nowMs);
    tx.set(rec.ref, item);
    for (const [k, a] of writes) tx.create(moves(db).doc(k), movementDoc(item, rec.id, a, { nowMs, channel: 'CHECKOUT', actor: 'system', relatedRef: orderRef }));
    if (rRef && r) tx.set(rRef, { state: 'CONSUMED', orderRef, consumedAtMs: nowMs, ...(r.state !== 'ACTIVE' ? { lateConsume: true } : {}) }, { merge: true });
    return { ok: true, consumed: qty, late: !!(r && r.state !== 'ACTIVE') };
  });
}

// ------------------------------------------------------------------ quick actions
const CREATOR_ACTIONS = Object.freeze([T.RESTOCK, T.EXTERNAL_SALE, T.COUNT_CORRECTION, T.MARK_UNAVAILABLE, T.RESTORE_AVAILABLE, T.RETURN_TO_STOCK, T.SAFETY_STOCK_CHANGE]);
const CHANNELS = Object.freeze(['NOVA', 'MANUAL', 'CSV_IMPORT', 'SHOPIFY', 'MARKET_STALL', 'INSTAGRAM', 'WHATSAPP', 'OTHER']);

async function adjust(db, { creatorId, itemId, type, quantity = null, countedOnHand, safetyStock, reason = null, note = null, channel = 'MANUAL', actor, idempotencyKey, relatedRef = null, resellableConfirmed = false, nowMs = Date.now() }) {
  if (!CREATOR_ACTIONS.includes(type)) throw err(422, 'ACTION_NOT_ALLOWED', 'That stock action is not available here.');
  if (!KEY_RE.test(String(idempotencyKey || ''))) throw err(422, 'IDEMPOTENCY_KEY_REQUIRED', 'Every stock change needs a unique key so a retry cannot apply it twice.');
  if (!CHANNELS.includes(channel)) throw err(422, 'BAD_CHANNEL', `channel must be one of ${CHANNELS.join(', ')}.`);
  const mKey = `adj_${safeId(itemId)}_${safeId(idempotencyKey)}`.slice(0, 200);
  const out = await db.runTransaction(async (tx) => {
    const seen = await tx.get(moves(db).doc(mKey));
    const iRef = items(db).doc(itemId);
    const iSnap = await tx.get(iRef);
    // Tenant isolation: another creator's pool is indistinguishable from a missing one.
    if (!iSnap.exists || iSnap.data().creatorId !== creatorId) throw err(404, 'NOT_FOUND', 'Stock item not found.');
    if (seen.exists) return { already: true, item: iSnap.data() };
    let applied;
    try { applied = D.applyMovement(iSnap.data(), { type, quantity, countedOnHand, safetyStock, reason, resellableConfirmed }); }
    catch (e) { if (e instanceof InventoryError) throw err(e.status || 409, e.code, e.message); throw e; }
    tx.set(iRef, applied.item);
    tx.create(moves(db).doc(mKey), movementDoc(applied.item, itemId, applied, { nowMs, channel, actor, relatedRef, note, reason }));
    return { already: false, item: applied.item };
  });
  await refreshStockSummary(db, out.item.productId).catch(() => {});
  return { ...out, availableToSell: D.availableToSell(out.item) };
}

async function transfer(db, { creatorId, fromItemId, toItemId, quantity, actor, idempotencyKey, note = null, nowMs = Date.now() }) {
  if (!KEY_RE.test(String(idempotencyKey || ''))) throw err(422, 'IDEMPOTENCY_KEY_REQUIRED', 'A unique key is required.');
  if (fromItemId === toItemId) throw err(422, 'SAME_LOCATION', 'Choose two different locations.');
  const kOut = `xfer_${safeId(idempotencyKey)}_OUT`; const kIn = `xfer_${safeId(idempotencyKey)}_IN`;
  const out = await db.runTransaction(async (tx) => {
    const seen = await tx.get(moves(db).doc(kOut));
    const a = await tx.get(items(db).doc(fromItemId)); const b = await tx.get(items(db).doc(toItemId));
    const ok = (s) => s.exists && s.data().creatorId === creatorId;
    if (!ok(a) || !ok(b)) throw err(404, 'NOT_FOUND', 'Stock item not found.');
    if (seen.exists) return { already: true };
    const A = a.data(); const B = b.data();
    if (A.productId !== B.productId || A.variantKey !== B.variantKey) throw err(422, 'DIFFERENT_PRODUCT', 'You can only move stock of the same product and variant between locations.');
    let o; let i;
    try { o = D.applyMovement(A, { type: T.TRANSFER_OUT, quantity }); i = D.applyMovement(B, { type: T.TRANSFER_IN, quantity }); }
    catch (e) { if (e instanceof InventoryError) throw err(e.status || 409, e.code, e.message); throw e; }
    tx.set(items(db).doc(fromItemId), o.item); tx.set(items(db).doc(toItemId), i.item);
    tx.create(moves(db).doc(kOut), movementDoc(A, fromItemId, o, { nowMs, channel: 'MANUAL', actor, relatedRef: toItemId, note }));
    tx.create(moves(db).doc(kIn), movementDoc(B, toItemId, i, { nowMs, channel: 'MANUAL', actor, relatedRef: fromItemId, note }));
    return { already: false, productId: A.productId };
  });
  if (out.productId) await refreshStockSummary(db, out.productId).catch(() => {});
  return out;
}

// ------------------------------------------------------------------ reading
async function ensureItemsForCreator(db, creatorId, nowMs = Date.now()) {
  const ps = await db.collection('products').where('creatorId', '==', creatorId).limit(500).get();
  for (const d of ps.docs) {
    const product = { id: d.id, ...d.data() };
    if (product.status !== 'PUBLISHED' || !usesUnitStock(product)) continue;
    await db.runTransaction(async (tx) => {
      const rec = await readOrInitItem(tx, db, { creatorId, productId: product.id }, product);
      stageInit(tx, db, rec, nowMs);
    });
  }
}

const LOW_STOCK_DEFAULT = 3;
function describe(item, id) {
  const avail = D.availableToSell(item);
  const low = Number.isInteger(item.lowStockAt) ? item.lowStockAt : LOW_STOCK_DEFAULT;
  return { id, ...item, availableToSell: avail, status: avail === 0 ? 'OUT_OF_STOCK' : (avail <= low ? 'LOW' : 'OK') };
}

async function listItems(db, creatorId) {
  await ensureItemsForCreator(db, creatorId);
  const snap = await items(db).where('creatorId', '==', creatorId).limit(500).get();
  return snap.docs.map((d) => describe(d.data(), d.id)).sort((a, b) => a.productId.localeCompare(b.productId));
}

async function history(db, creatorId, { itemId, limit = 50 } = {}) {
  let q = moves(db).where('creatorId', '==', creatorId);
  if (itemId) q = q.where('itemId', '==', itemId);
  const snap = await q.limit(500).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.atMs || 0) - (a.atMs || 0)).slice(0, Math.min(limit, 200));
}

/** Derived display number for storefront cards. Recomputable at any time; never the authority. */
async function refreshStockSummary(db, productId) {
  const snap = await items(db).where('productId', '==', productId).limit(200).get();
  const total = snap.docs.reduce((s, d) => s + D.availableToSell(d.data()), 0);
  await db.collection('products').doc(productId).set({ stockSummary: { availableToSell: total, tracked: true, updatedAtMs: Date.now() } }, { merge: true });
  return total;
}

// ------------------------------------------------------------------ CSV import
async function previewImport(db, creatorId, csvText) {
  const list = await listItems(db, creatorId);
  return D.validateImport(csvText, list);
}

/**
 * Applies the VALID rows of a previously previewed CSV. Safe to re-run with the same importId:
 * each row has its own idempotency key. If any row is invalid nothing is applied unless the
 * seller explicitly chose to skip the bad rows. Returns a per-row report either way.
 */
async function commitImport(db, { creatorId, csvText, importId, skipInvalid = false, actor, nowMs = Date.now() }) {
  if (!KEY_RE.test(String(importId || ''))) throw err(422, 'IMPORT_ID_REQUIRED', 'An import id is required.');
  const v = await previewImport(db, creatorId, csvText);
  if (!v.ok) return { applied: 0, refused: true, fileProblems: v.fileProblems, rows: [] };
  if (v.invalidCount > 0 && !skipInvalid) return { applied: 0, refused: true, reason: 'INVALID_ROWS', rows: v.rows };
  const report = [];
  let applied = 0;
  for (const row of v.rows) {
    if (!row.valid) { report.push({ line: row.line, sku: row.sku, result: 'SKIPPED_INVALID', errors: row.errors }); continue; }
    try {
      const r = await adjust(db, {
        creatorId, itemId: row.itemId, type: row.mode === 'SET' ? T.COUNT_CORRECTION : T.RESTOCK,
        ...(row.mode === 'SET' ? { countedOnHand: row.quantity } : { quantity: row.quantity }),
        channel: 'CSV_IMPORT', actor, idempotencyKey: `imp_${safeId(importId)}_${row.line}`, relatedRef: importId, reason: 'CSV_IMPORT', nowMs,
      });
      report.push({ line: row.line, sku: row.sku, result: r.already ? 'ALREADY_APPLIED' : 'APPLIED' });
      if (!r.already) applied += 1;
    } catch (e) {
      report.push({ line: row.line, sku: row.sku, result: 'FAILED', error: e.message });
    }
  }
  return { applied, refused: false, rows: report, failed: report.filter((r) => r.result === 'FAILED').length };
}

// ------------------------------------------------------------------ channel listings
// Connected sync exists only for channels that register an adapter here (Shopify: inventory/channel-sync.js)
// AND only while INVENTORY_CHANNEL_SYNC_ENABLED=true. Mapping and manual/batch recording always work.
const ADAPTERS = Object.create(null);

async function mapChannelListing(db, { creatorId, channel, externalId, sku = null, gtin = null, confirmedItemId = null, title = null, nowMs = Date.now() }) {
  if (!channel || !externalId) throw err(422, 'MISSING_FIELDS', 'channel and externalId are required.');
  const list = await listItems(db, creatorId);
  const m = D.matchListing({ sku, gtin, confirmedItemId }, list);
  const id = safeId(`${creatorId}__${channel}__${externalId}`);
  const doc = {
    id, creatorId, channel: String(channel).slice(0, 40), externalId: String(externalId).slice(0, 120), title: title ? String(title).slice(0, 140) : null, sku, gtin,
    itemId: m.itemId, mappingStatus: m.status, matchedBy: m.matchedBy || null, candidates: m.candidates || null, reason: m.reason || null,
    syncMode: D.SYNC_MODES.MANUAL_OR_BATCH, syncEnabled: false, lastSuccessAtMs: null, lastError: null, updatedAtMs: nowMs,
  };
  await db.collection('channelListings').doc(id).set(doc, { merge: true });
  return doc;
}

async function enableChannelSync(db, { creatorId, listingId, authoritative, acknowledgedPreview }) {
  const ref = db.collection('channelListings').doc(listingId);
  const s = await ref.get();
  if (!s.exists || s.data().creatorId !== creatorId) throw err(404, 'NOT_FOUND', 'Listing not found.');
  const l = s.data();
  const adapter = ADAPTERS[l.channel];
  if (!cfg.flags().connectedChannelSync || !adapter) throw err(409, 'CONNECTED_SYNC_UNAVAILABLE', 'Automatic sync is not available for this channel. Record external sales or import them instead.');
  if (l.mappingStatus !== 'MAPPED') throw err(409, 'MAPPING_NOT_CONFIRMED', 'Confirm the product mapping before turning sync on.');
  if (!acknowledgedPreview || !['NOVA', 'CHANNEL'].includes(authoritative)) throw err(422, 'CONSENT_REQUIRED', 'Review the conflict preview and choose which system is authoritative before enabling sync.');
  const extra = typeof adapter.onEnable === 'function' ? adapter.onEnable(l) : {}; // may refuse (409) or reset sync state
  await ref.set({ syncEnabled: true, syncMode: D.SYNC_MODES.CONNECTED, authoritative, ...extra }, { merge: true });
  return { enabled: true };
}

module.exports = {
  KEY_RE, CREATOR_ACTIONS, CHANNELS, ADAPTERS, LOW_STOCK_DEFAULT,
  reserveForCheckout, consumeForOrder, releaseReservation, sweepExpired,
  adjust, transfer, listItems, history, refreshStockSummary, ensureItemsForCreator, describe,
  previewImport, commitImport, mapChannelListing, enableChannelSync, usesUnitStock,
};
