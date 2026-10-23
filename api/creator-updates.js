// /api/creator-updates.js — short text updates from a creator to their followers/buyers
//   GET ?creatorId=            PUBLIC  -> latest visible updates for one creator (active creators only)
//   GET ?mine=1                CREATOR -> own updates incl. hidden ones
//   POST {action:"post", text, productId?}     ACTIVE CREATOR  (max 3 per rolling 24h, 3-500 chars, no links)
//   POST {action:"delete", id}                 ACTIVE CREATOR  (own update)
//   POST {action:"hide", id, reason}           ADMIN (moderation; reversible with {action:"unhide"})
const { getDb, requireActiveCreator, requireAdminAuth, getCreatorDoc, ok, fail, setCors, writeCreatorAuditLog } = require('./creator/shared');

const E = (status, code, message) => Object.assign(new Error(message), { status, code });
const MAX_PER_DAY = 3;
const DAY = 24 * 3600 * 1000;

function validateText(t) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  if (s.length < 3 || s.length > 500) throw E(422, 'BAD_TEXT', 'An update must be 3 to 500 characters.');
  if (/(https?:\/\/|www\.|\.com\b|\.ng\b)/i.test(s)) throw E(422, 'NO_LINKS', 'Updates cannot contain links. Mention the product instead.');
  return s;
}
const view = (u) => ({ id: u.id, creatorId: u.creatorId, text: u.text, productId: u.productId || null, createdAtMs: u.createdAtMs });

async function post(db, creatorId, b, nowMs) {
  const text = validateText(b.text);
  const recent = await db.collection('creatorUpdates').where('creatorId', '==', creatorId).limit(50).get();
  if (recent.docs.filter((d) => nowMs - (d.data().createdAtMs || 0) < DAY).length >= MAX_PER_DAY) throw E(429, 'DAILY_LIMIT', `You can post ${MAX_PER_DAY} updates per day.`);
  let productId = null;
  if (b.productId) {
    productId = String(b.productId);
    const p = await db.collection('products').doc(productId).get().catch(() => null);
    if (!p || !p.exists || p.data().creatorId !== creatorId) throw E(422, 'NOT_YOUR_PRODUCT', 'That product is not yours.');
  }
  const ref = db.collection('creatorUpdates').doc();
  const rec = { id: ref.id, creatorId, text, productId, state: 'VISIBLE', createdAtMs: nowMs };
  await ref.set(rec);
  return rec;
}

function makeHandler(deps = {}) {
  return async function handler(req, res) {
    setCors(res);
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    try {
      const db = deps.db || getDb();
      const nowMs = (deps.now || Date.now)();
      const q = req.query || {};
      if (req.method === 'GET' && !q.mine) {
        const cid = String(q.creatorId || ''); if (!cid || cid.includes('/')) throw E(422, 'MISSING_CREATOR', 'creatorId is required.');
        const c = await (deps.getCreator || getCreatorDoc)(cid);
        if (!c || c.status !== 'ACTIVE') return ok(res, { updates: [] });
        const snap = await db.collection('creatorUpdates').where('creatorId', '==', cid).limit(100).get();
        const list = snap.docs.map((d) => d.data()).filter((u) => u.state === 'VISIBLE').sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, 20);
        return ok(res, { updates: list.map(view) });
      }
      if (req.method === 'GET') {
        const { decoded } = await (deps.creatorAuth || requireActiveCreator)(req);
        const snap = await db.collection('creatorUpdates').where('creatorId', '==', decoded.uid).limit(100).get();
        return ok(res, { updates: snap.docs.map((d) => d.data()).sort((a, b) => b.createdAtMs - a.createdAtMs) });
      }
      if (req.method !== 'POST') throw E(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST.');
      const b = req.body || {};
      if (b.action === 'post' || b.action === 'delete') {
        const { decoded } = await (deps.creatorAuth || requireActiveCreator)(req);
        if (b.action === 'post') return ok(res, { update: view(await post(db, decoded.uid, b, nowMs)) });
        const ref = db.collection('creatorUpdates').doc(String(b.id || 'x'));
        const s = await ref.get();
        if (!s.exists || s.data().creatorId !== decoded.uid) throw E(404, 'NOT_FOUND', 'Update not found.');
        await ref.set({ state: 'DELETED', deletedAtMs: nowMs }, { merge: true });
        return ok(res, { deleted: true });
      }
      if (b.action === 'hide' || b.action === 'unhide') {
        const admin = await (deps.adminAuth || requireAdminAuth)(req);
        const ref = db.collection('creatorUpdates').doc(String(b.id || 'x'));
        const s = await ref.get(); if (!s.exists) throw E(404, 'NOT_FOUND', 'Update not found.');
        if (b.action === 'hide' && String(b.reason || '').trim().length < 5) throw E(422, 'REASON_REQUIRED', 'Say why it is being hidden.');
        if (s.data().state === 'DELETED') throw E(409, 'DELETED', 'The creator deleted this update.');
        await ref.set({ state: b.action === 'hide' ? 'HIDDEN' : 'VISIBLE', moderatedBy: admin.uid, moderationReason: b.reason ? String(b.reason).slice(0, 300) : null }, { merge: true });
        writeCreatorAuditLog({ actorUid: admin.uid, actorRole: 'admin', action: `creatorUpdate.${b.action}`, targetType: 'creatorUpdate', targetId: s.id, reason: b.reason || null }).catch(() => {});
        return ok(res, { state: b.action === 'hide' ? 'HIDDEN' : 'VISIBLE' });
      }
      throw E(400, 'INVALID_ACTION', 'Unknown action.');
    } catch (e) { return fail(res, e); }
  };
}
module.exports = makeHandler();
module.exports.makeHandler = makeHandler;
