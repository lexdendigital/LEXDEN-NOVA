// /api/creator-notifications.js
//
// LEXDEN NOVA CREATOR — Stage I. The creator's notification center
// (blueprint §75): order deadlines, paused listings, CJ orders needing action.
//
// GET  /api/creator-notifications[?unread=1]   newest first (max 100)
// POST /api/creator-notifications { action: "mark_read", ids?: [..] }   (no ids = all)
const { getDb, requireActiveCreator, FieldValue, ok, fail, setCors } = require('./creator/shared');

module.exports = async function handler(req, res) {
  setCors(res);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  let decoded;
  try { ({ decoded } = await requireActiveCreator(req)); } catch (e) { return fail(res, e); }
  const uid = decoded.uid;
  const db = getDb();
  try {
    if (req.method === 'GET') {
      // Single-field query + in-memory sort: no composite index needed.
      const snap = await db.collection('creatorNotifications').where('creatorId', '==', uid).limit(300).get();
      let list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (req.query && (req.query.unread === '1' || req.query.unread === 'true')) list = list.filter((n) => !n.read);
      list.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
      return ok(res, { unreadCount: list.filter((n) => !n.read).length, notifications: list.slice(0, 100).map(({ createdAt, ...n }) => n) });
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' } });
    const body = req.body || {};
    if (body.action !== 'mark_read') return fail(res, { status: 400, code: 'INVALID_ACTION', message: 'action must be "mark_read".' });
    let targets;
    if (Array.isArray(body.ids) && body.ids.length) {
      if (body.ids.length > 100 || body.ids.some((i) => typeof i !== 'string' || !i || i.includes('/'))) return fail(res, { status: 422, code: 'INVALID_IDS', message: 'ids must be up to 100 notification ids.' });
      targets = body.ids;
    } else {
      const snap = await db.collection('creatorNotifications').where('creatorId', '==', uid).limit(300).get();
      targets = snap.docs.filter((d) => !d.data().read).map((d) => d.id);
    }
    let marked = 0;
    for (const id of targets) {
      const ref = db.collection('creatorNotifications').doc(id);
      const s = await ref.get();
      if (!s.exists || s.data().creatorId !== uid) continue; // never touch someone else's
      if (!s.data().read) { await ref.set({ read: true, readAtMs: Date.now(), updatedAt: FieldValue.serverTimestamp() }, { merge: true }); marked += 1; }
    }
    return ok(res, { marked });
  } catch (e) {
    return fail(res, e);
  }
};
