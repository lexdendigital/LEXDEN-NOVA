// /api/creator-admin-exceptions.js  (ADMIN ONLY)
//   GET  ?state=OPEN|RESOLVED   -> paid orders that could not be honoured (amount mismatch, seller inactive, stock gone)
//   POST {action:"resolve", id, resolution: REFUNDED|FULFILLED_ANYWAY|CANCELLED, note}
// Resolving never moves money: refunds go through /api/creator-admin-refunds. Audit-logged.
const { getDb, requireAdminAuth, ok, fail, setCors, writeCreatorAuditLog } = require('./creator/shared');
const X = require('./creator/checkout');

function makeHandler(deps = {}) {
  return async function handler(req, res) {
    setCors(res);
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    try {
      const admin = await requireAdminAuth(req);
      const db = deps.db || getDb();
      if (req.method === 'GET') return ok(res, { exceptions: await X.listExceptions(db, { state: (req.query && req.query.state) === 'RESOLVED' ? 'RESOLVED' : 'OPEN' }) });
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' } });
      const b = req.body || {};
      if (b.action !== 'resolve') { const e = new Error('Unknown action.'); e.status = 400; e.code = 'INVALID_ACTION'; throw e; }
      const out = await X.resolveException(db, { id: String(b.id || ''), resolution: b.resolution, actor: admin.uid, note: b.note });
      writeCreatorAuditLog({ actorUid: admin.uid, actorRole: 'admin', action: 'orderException.resolve', targetType: 'orderException', targetId: String(b.id), reason: b.note || null, metadata: { resolution: b.resolution } }).catch(() => {});
      return ok(res, out);
    } catch (e) { return fail(res, e); }
  };
}
module.exports = makeHandler();
module.exports.makeHandler = makeHandler;
