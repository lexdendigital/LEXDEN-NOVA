// /api/creator-admin-refunds.js  (ADMIN ONLY)
//
//   GET  ?state=REQUESTED|APPROVED|AWAITING_MANUAL_STEP|PROVIDER_INITIATED|PROCESSING|COMPLETED|FAILED|REQUIRES_REVIEW|...
//   GET  ?id=<refundId>
//   POST {action:"approve",       id}                       approve and route (Paystack API if enabled, else tracked manual step)
//   POST {action:"record_manual", id, providerReference, note}   admin attests the dashboard refund
//   POST {action:"apply_status",  id, providerStatus}        apply an authoritative status (also what the webhook does)
//   POST {action:"review",        id, note}                  send to REQUIRES_REVIEW
//   POST {action:"review_deduction", id, note}               record the manual/legal review of a deduction
//   POST {action:"cancel",        id, note}
//
// The lifecycle, deduction rules and "completed only after provider confirmation" live in
// api/core/refunds.js. Every action is audit-logged with the acting admin.
const { getDb, requireAdminAuth, ok, fail, setCors, writeCreatorAuditLog } = require('./creator/shared');
const R = require('./core/refunds');

const err = (status, code, message) => Object.assign(new Error(message), { status, code });

async function syncDispute(db, refund) {
  if (!refund || !refund.disputeId) return;
  const patch = { refundState: refund.state };
  if (refund.state === R.STATES.COMPLETED && refund.providerConfirmedAtMs) { patch.buyerRefundPaid = true; patch.refundCompletedAtMs = refund.providerConfirmedAtMs; }
  await db.collection('creatorDisputes').doc(refund.disputeId).set(patch, { merge: true }).catch(() => {});
}

async function act(db, admin, b, deps = {}) {
  const id = String(b.id || '');
  if (!id || id.includes('/')) throw err(422, 'MISSING_ID', 'id is required.');
  let out;
  switch (b.action) {
    case 'approve': out = await R.approveAndRoute(db, id, { by: admin.uid, deps }); break;
    case 'record_manual': out = await R.recordManualStep(db, id, { by: admin.uid, providerReference: b.providerReference, note: b.note }); break;
    case 'apply_status': out = await R.applyProviderStatus(db, id, b.providerStatus, { by: admin.uid }); break;
    case 'review': out = await R.transition(db, id, R.STATES.REQUIRES_REVIEW, { by: admin.uid, note: b.note }); break;
    case 'cancel': out = await R.transition(db, id, R.STATES.CANCELLED, { by: admin.uid, note: b.note }); break;
    case 'review_deduction': {
      const ref = db.collection('refunds').doc(id);
      const cur = (await ref.get()).data();
      if (!cur || !cur.deduction) throw err(404, 'NO_DEDUCTION', 'This refund has no deduction to review.');
      if (String(b.note || '').trim().length < 10) throw err(422, 'NOTE_REQUIRED', 'Write the review reasoning (at least 10 characters).');
      await ref.set({ deduction: { ...cur.deduction, reviewedBy: admin.uid, reviewedAtMs: Date.now(), reviewNote: String(b.note).slice(0, 500) } }, { merge: true });
      out = { refund: (await ref.get()).data() };
      break;
    }
    default: throw err(400, 'INVALID_ACTION', `Unknown action "${b.action}".`);
  }
  const refund = out.refund || (await db.collection('refunds').doc(id).get()).data();
  await syncDispute(db, refund);
  writeCreatorAuditLog({ actorUid: admin.uid, actorRole: 'admin', action: `refund.${b.action}`, targetType: 'refund', targetId: id, reason: b.note || null, metadata: { state: refund && refund.state } }).catch(() => {});
  return { ...out, refund, userFacing: R.userFacingStatus(refund) };
}

function makeHandler(deps = {}) {
  return async function handler(req, res) {
    setCors(res);
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    let admin;
    try { admin = await requireAdminAuth(req); } catch (e) { return fail(res, e); }
    const db = getDb();
    try {
      if (req.method === 'GET') {
        const q = req.query || {};
        if (q.id) { const s = await db.collection('refunds').doc(String(q.id)).get(); if (!s.exists) throw err(404, 'NOT_FOUND', 'Refund not found.'); return ok(res, { refund: s.data(), userFacing: R.userFacingStatus(s.data()) }); }
        let query = db.collection('refunds');
        if (q.state) query = query.where('state', '==', String(q.state));
        const snap = await query.limit(200).get();
        return ok(res, { refunds: snap.docs.map((x) => x.data()).sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0)) });
      }
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' } });
      return ok(res, await act(db, admin, req.body || {}, deps));
    } catch (e) { return fail(res, e); }
  };
}

module.exports = makeHandler();
module.exports.makeHandler = makeHandler;
module.exports.act = act;
