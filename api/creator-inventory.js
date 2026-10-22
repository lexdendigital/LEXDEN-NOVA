// /api/creator-inventory.js  (ACTIVE CREATOR ONLY — every query is scoped to the caller's uid)
//   GET                       -> items (availableToSell, status OK|LOW|OUT_OF_STOCK) + availability model per listing
//   GET ?history=1&itemId=    -> immutable movement history
//   GET ?channels=1           -> mapped external listings with honest sync health
//   POST {action:"adjust", itemId, type, quantity|countedOnHand|safetyStock, reason?, note?, channel?, idempotencyKey, resellableConfirmed?}
//   POST {action:"transfer", fromItemId, toItemId, quantity, idempotencyKey}
//   POST {action:"import_preview", csv}   POST {action:"import_commit", csv, importId, skipInvalid?}
//   POST {action:"map_listing", channel, externalId, sku?, gtin?, title?}
//   POST {action:"enable_sync", listingId, authoritative, acknowledgedPreview}   (409 unless a real adapter exists)
// Creators can NEVER run RESERVE / RELEASE / CONSUME: those are checkout-only (see CREATOR_ACTIONS).
const { getDb, requireActiveCreator, ok, fail, setCors, writeCreatorAuditLog } = require('./creator/shared');
const inv = require('./inventory/service');
const D = require('./inventory/domain');

const E = (status, code, message) => Object.assign(new Error(message), { status, code });

async function channelsView(db, creatorId, nowMs = Date.now()) {
  const snap = await db.collection('channelListings').where('creatorId', '==', creatorId).limit(500).get();
  return snap.docs.map((d) => {
    const l = d.data();
    return { ...l, health: D.syncHealth({ mode: l.syncMode, adapterAvailable: !!inv.ADAPTERS[l.channel], enabled: l.syncEnabled, lastSuccessAtMs: l.lastSuccessAtMs, lastError: l.lastError, nowMs }) };
  });
}

async function act(db, ctx, b) {
  const { uid, creatorId } = ctx;
  switch (b.action) {
    case 'adjust': {
      const out = await inv.adjust(db, { creatorId, itemId: String(b.itemId || ''), type: b.type, quantity: b.quantity, countedOnHand: b.countedOnHand, safetyStock: b.safetyStock, reason: b.reason, note: b.note, channel: b.channel || 'MANUAL', actor: uid, idempotencyKey: b.idempotencyKey, resellableConfirmed: b.resellableConfirmed === true });
      writeCreatorAuditLog({ actorUid: uid, actorRole: 'creator', action: `inventory.${b.type}`, targetType: 'inventoryItem', targetId: String(b.itemId), metadata: { quantity: b.quantity == null ? null : b.quantity, channel: b.channel || 'MANUAL' } }).catch(() => {});
      return out;
    }
    case 'transfer': return inv.transfer(db, { creatorId, fromItemId: String(b.fromItemId || ''), toItemId: String(b.toItemId || ''), quantity: b.quantity, actor: uid, idempotencyKey: b.idempotencyKey });
    case 'import_preview': return inv.previewImport(db, creatorId, String(b.csv || ''));
    case 'import_commit': return inv.commitImport(db, { creatorId, csvText: String(b.csv || ''), importId: b.importId, skipInvalid: b.skipInvalid === true, actor: uid });
    case 'map_listing': return inv.mapChannelListing(db, { creatorId, channel: b.channel, externalId: b.externalId, sku: b.sku || null, gtin: b.gtin || null, title: b.title || null });
    case 'enable_sync': return inv.enableChannelSync(db, { creatorId, listingId: String(b.listingId || ''), authoritative: b.authoritative, acknowledgedPreview: b.acknowledgedPreview === true });
    default: throw E(400, 'INVALID_ACTION', `Unknown action "${b.action}".`);
  }
}

function makeHandler(deps = {}) {
  return async function handler(req, res) {
    setCors(res);
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    try {
      const { decoded } = await requireActiveCreator(req);
      const db = deps.db || getDb();
      const ctx = { uid: decoded.uid, creatorId: decoded.uid };
      if (req.method === 'GET') {
        const q = req.query || {};
        if (q.history) return ok(res, { movements: await inv.history(db, ctx.creatorId, { itemId: q.itemId ? String(q.itemId) : undefined, limit: Number(q.limit) || 50 }) });
        if (q.channels) return ok(res, { listings: await channelsView(db, ctx.creatorId) });
        return ok(res, { items: await inv.listItems(db, ctx.creatorId), lowStockDefault: inv.LOW_STOCK_DEFAULT, csvHeaders: D.CSV_HEADERS });
      }
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' } });
      return ok(res, await act(db, ctx, req.body || {}));
    } catch (e) { return fail(res, e); }
  };
}
module.exports = makeHandler();
module.exports.makeHandler = makeHandler;
module.exports.act = act;
module.exports.channelsView = channelsView;
