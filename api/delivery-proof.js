// /api/delivery-proof.js
//   BUYER  (Firebase login): {action:"issue_code", orderId}  -> the ONLY response that ever contains a code
//                            {action:"authorise_recipient", orderId, name, phone?}
//                            {action:"report_problem", orderId, reason}
//   RIDER  (task token, flag RIDER_VAULT_ENABLED): {action:"rider_verify", orderId, taskId, taskToken, code}
//   RECIPIENT (task token): {action:"rider_verify", ..., asRecipient:true}  (buyer must have authorised one)
//   ADMIN: {action:"issue_rider_task", orderId, riderId}  {action:"revoke_rider_task", taskId}
// Wrong guesses are counted and rate-limited per IP; responses never reveal the code or buyer data.
const { getDb, requireAuth, requireAdminAuth, ok, fail, setCors, writeCreatorAuditLog } = require('./creator/shared');
const P = require('./delivery/proof');

const hits = new Map();
function limited(key, max = 20, windowMs = 60000, now = Date.now()) {
  const h = (hits.get(key) || []).filter((t) => now - t < windowMs); h.push(now); hits.set(key, h);
  return h.length > max;
}

function makeHandler(deps = {}) {
  return async function handler(req, res) {
    setCors(res);
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' } });
    try {
      const db = deps.db || getDb();
      const b = req.body || {};
      const orderId = String(b.orderId || '');
      const ip = (req.headers && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || 'unknown';
      if (limited(`${ip}`)) return res.status(429).json({ ok: false, error: { code: 'RATE_LIMITED', message: 'Too many attempts. Wait a minute and try again.' } });
      if (b.action !== 'revoke_rider_task' && (!orderId || orderId.includes('/'))) { const e = new Error('orderId is required.'); e.status = 422; e.code = 'MISSING_ORDER'; throw e; }
      switch (b.action) {
        case 'issue_code': { const u = await (deps.auth || requireAuth)(req); return ok(res, await P.issueCode(db, { orderId, buyerUid: u.uid, env: deps.env })); }
        case 'authorise_recipient': { const u = await (deps.auth || requireAuth)(req); return ok(res, await P.authoriseRecipient(db, { orderId, buyerUid: u.uid, name: b.name, phone: b.phone })); }
        case 'report_problem': { const u = await (deps.auth || requireAuth)(req); return ok(res, await P.reportProblem(db, { orderId, reportedBy: u.uid, role: 'BUYER', reason: b.reason })); }
        case 'rider_verify': {
          const r = await P.verifyCode(db, { orderId, code: b.code, asRecipient: b.asRecipient === true, enteredBy: { type: 'RIDER', taskId: String(b.taskId || ''), taskToken: String(b.taskToken || '') }, env: deps.env });
          // 200 with ok:false so a rider app can show the reason; the wrong-guess counter is already persisted.
          return res.status(200).json({ ok: true, data: r.ok ? { verified: true } : { verified: false, reason: r.code, attemptsLeft: r.attemptsLeft } });
        }
        case 'issue_rider_task': { const a = await (deps.adminAuth || requireAdminAuth)(req); const out = await P.issueRiderTask(db, { orderId, riderId: b.riderId, issuedBy: a.uid, env: deps.env }); writeCreatorAuditLog({ actorUid: a.uid, actorRole: 'admin', action: 'delivery.rider_task_issued', targetType: 'order', targetId: orderId, metadata: { riderId: b.riderId } }).catch(() => {}); return ok(res, out); }
        case 'revoke_rider_task': { const a = await (deps.adminAuth || requireAdminAuth)(req); return ok(res, await P.revokeRiderTask(db, { taskId: String(b.taskId || ''), by: a.uid })); }
        default: { const e = new Error('Unknown action.'); e.status = 400; e.code = 'INVALID_ACTION'; throw e; }
      }
    } catch (e) { return fail(res, e); }
  };
}
module.exports = makeHandler();
module.exports.makeHandler = makeHandler;
