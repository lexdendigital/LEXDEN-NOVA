// /api/creator-admin-sla.js
//
// LEXDEN NOVA CREATOR — Stage H. Admin-only seller-SLA oversight (blueprint §19).
//
// GET /api/creator-admin-sla?view=queue      open physical orders that are
//        AT_RISK or BREACHED, most urgent first (optional &creatorId=)
// GET /api/creator-admin-sla?view=creators   per-creator SLA summary with a
//        restriction RECOMMENDATION (watch / restrictionRecommended). This
//        endpoint never restricts anybody; enforcement is a human decision
//        today and an explicit, audited automation in Stage I.
const { requireAdminAuth, getDb, ok, fail, setCors } = require('./creator/shared');
const { evaluateSla, summarizeCreatorSla } = require('./creator/sla');

const OPEN = ['PENDING', 'PACKED', 'SHIPPED'];
const RECENT_DAYS = 60;

async function loadOpenAndRecent(db, nowMs, creatorId) {
  const rows = [];
  for (const status of OPEN.concat(['DELIVERED'])) {
    let q = db.collection('fulfillments').where('status', '==', status);
    if (creatorId) q = q.where('creatorId', '==', creatorId);
    const snap = await q.limit(500).get();
    for (const d of snap.docs) rows.push({ id: d.id, ...d.data() });
  }
  // Delivered orders only count toward the trust summary for a recent window.
  return rows.filter((r) => r.status !== 'DELIVERED' || nowMs - (r.createdAtMs || 0) <= RECENT_DAYS * 86400000);
}

module.exports = async function handler(req, res) {
  setCors(res);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' } });
  try {
    await requireAdminAuth(req);
  } catch (e) {
    return fail(res, e);
  }
  try {
    const db = getDb();
    const nowMs = Date.now();
    const view = (req.query && req.query.view) || 'queue';
    const creatorId = req.query && typeof req.query.creatorId === 'string' ? req.query.creatorId : null;
    const rows = await loadOpenAndRecent(db, nowMs, creatorId);

    if (view === 'queue') {
      const queue = rows
        .filter((r) => r.status !== 'DELIVERED')
        .map((r) => ({ ...r, sla: evaluateSla(r, nowMs) }))
        .filter((r) => r.sla.overall === 'AT_RISK' || r.sla.overall === 'BREACHED')
        .sort((a, b) => (a.sla.dueAtMs || 0) - (b.sla.dueAtMs || 0))
        .slice(0, 200);
      return ok(res, { queue });
    }
    if (view === 'creators') {
      const byCreator = new Map();
      for (const r of rows) {
        if (!r.creatorId) continue;
        if (!byCreator.has(r.creatorId)) byCreator.set(r.creatorId, []);
        byCreator.get(r.creatorId).push(r);
      }
      const creators = [...byCreator.entries()]
        .map(([id, list]) => ({ creatorId: id, ...summarizeCreatorSla(list, nowMs) }))
        .sort((a, b) => b.breached - a.breached);
      return ok(res, { creators });
    }
    return fail(res, { status: 400, code: 'INVALID_VIEW', message: `Unknown view "${view}".` });
  } catch (e) {
    return fail(res, e);
  }
};
