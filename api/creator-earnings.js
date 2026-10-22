// /api/creator-earnings.js  (ACTIVE CREATOR) GET
// One honest breakdown of the creator's money, computed on the server from the ledger:
//   pending   earned, but not yet released (awaiting delivery / hold / open exception)
//   available can be withdrawn now
//   reserved  already asked for in a withdrawal that is not finished (pending / approved / processing)
//   paid      withdrawals that were paid out
//   disputed  frozen while a dispute is open
//   reversed  refunded to buyers
// Plus the fee that applied to each recent sale (the stored snapshot, never recalculated).
const { getDb, requireActiveCreator, ok, fail, setCors } = require('./creator/shared');
const cfg = require('./core/config');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function summarise({ priv = {}, sales = [], withdrawals = [] }) {
  const sum = (arr, f) => r2(arr.reduce((s, x) => s + (Number(f(x)) || 0), 0));
  const held = sales.filter((s) => s.status === 'held');
  const reserved = withdrawals.filter((w) => ['pending', 'approved', 'processing'].includes(w.status));
  return {
    pending: sum(held, (s) => s.creatorEarning),
    available: r2(priv.balanceAvailable),
    reserved: sum(reserved, (w) => w.amountRequested),
    paid: sum(withdrawals.filter((w) => w.status === 'paid'), (w) => w.amountRequested),
    disputed: sum(sales.filter((s) => s.status === 'disputed'), (s) => s.creatorEarning),
    reversed: sum(sales.filter((s) => s.status === 'refunded'), (s) => s.creatorEarning),
    recoveryDue: r2(priv.recoveryDue),
    awaitingDelivery: held.filter((s) => s.releaseGate === 'DELIVERY' && !s.deliveredAtMs).length,
    onHold: sales.filter((s) => s.exceptionOpen === true).length,
  };
}

function makeHandler(deps = {}) {
  return async function handler(req, res) {
    setCors(res);
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET') return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' } });
    try {
      const { decoded } = await requireActiveCreator(req);
      const db = deps.db || getDb();
      const uid = decoded.uid;
      const [privS, salesS, wdS] = await Promise.all([
        db.collection('creatorPrivate').doc(uid).get(),
        db.collection('creatorSales').where('creatorId', '==', uid).limit(500).get(),
        db.collection('creatorWithdrawals').where('creatorId', '==', uid).limit(200).get(),
      ]);
      const sales = salesS.docs.map((d) => ({ id: d.id, ...d.data() }));
      const withdrawals = wdS.docs.map((d) => ({ id: d.id, ...d.data() }));
      const recent = sales.sort((a, b) => (b.saleAtMs || 0) - (a.saleAtMs || 0)).slice(0, 25).map((s) => ({
        orderId: s.orderId, productTitle: s.productTitle, status: s.status, saleAmount: s.saleAmount, feePct: s.platformFeePct, feeAmount: s.platformFeeAmount,
        creatorEarning: s.creatorEarning, onHold: s.exceptionOpen === true, releaseGate: s.releaseGate || null,
        whyPending: s.status === 'held' ? (s.exceptionOpen ? 'An issue with this order is being reviewed.' : s.releaseGate === 'DELIVERY' ? (s.deliveredAtMs ? 'Delivered. Waiting out the buyer-protection period.' : 'Waiting for confirmed delivery.') : 'Waiting out the earnings hold.') : null,
      }));
      return ok(res, { summary: summarise({ priv: privS.exists ? privS.data() : {}, sales, withdrawals }), recent, currency: 'NGN',
        policy: { commissionPct: cfg.CREATOR_COMMISSION_BPS / 100, feeBasis: 'Item price after any item discount, excluding delivery and tax.', disputeWindowDays: cfg.DISPUTE_POLICIES.PHYSICAL.windowDays } });
    } catch (e) { return fail(res, e); }
  };
}
module.exports = makeHandler();
module.exports.makeHandler = makeHandler;
module.exports.summarise = summarise;
