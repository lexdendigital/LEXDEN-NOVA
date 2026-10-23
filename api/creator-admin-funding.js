// /api/creator-admin-funding.js  (ADMIN ONLY)
//   GET                                  -> { mode, orders: orders held waiting for supplier funding }
//   POST {action:"confirm_funded", orderId, reference, note}  -> attests NOVA funded it, then places the CJ order
// Needs CJ_FUNDING_MODE=NOVA_FUNDED. The attestation is the admin's word: it is NOT checked with CJ.
const { getDb, requireAdminAuth, ok, fail, setCors, writeCreatorAuditLog } = require('./creator/shared');
const funding = require('./supplier/funding');
const cfg = require('./core/config');
const X = require('./creator/checkout');

function makeHandler(deps = {}) {
  return async function handler(req, res) {
    setCors(res);
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    try {
      const admin = await (deps.adminAuth || requireAdminAuth)(req);
      const db = deps.db || getDb();
      const env = deps.env || process.env;
      if (req.method === 'GET') {
        const all = await X.listExceptions(db, { state: 'OPEN' });
        return ok(res, { mode: cfg.flags(env).cjFundingMode, orders: all.filter((e) => e.code === X.EXCEPTION_CODES.SUPPLIER_FUNDING_UNAVAILABLE) });
      }
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' } });
      const b = req.body || {};
      if (b.action !== 'confirm_funded') { const e = new Error('Unknown action.'); e.status = 400; e.code = 'INVALID_ACTION'; throw e; }
      const orderId = String(b.orderId || '');
      if (!orderId || orderId.includes('/')) { const e = new Error('orderId is required.'); e.status = 422; e.code = 'MISSING_ORDER'; throw e; }
      const out = await funding.confirmNovaFunding(db, { orderId, adminUid: admin.uid, reference: b.reference, note: b.note, env });
      let placed = null;
      if (!out.already) placed = await (deps.createOrder || require('./supplier/orders').createCjOrderForFulfillment)(db, orderId, { env });
      writeCreatorAuditLog({ actorUid: admin.uid, actorRole: 'admin', action: 'supplier.nova_funding_confirmed', targetType: 'order', targetId: orderId, reason: b.note || null, metadata: { reference: String(b.reference || '').slice(0, 80) } }).catch(() => {});
      return ok(res, { ...out, placed });
    } catch (e) { return fail(res, e); }
  };
}
module.exports = makeHandler();
module.exports.makeHandler = makeHandler;
