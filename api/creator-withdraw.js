// /api/creator-withdraw.js
//
// LEXDEN NOVA CREATOR — Stage F.
//
// GET  /api/creator-withdraw        -> own withdrawal history
// POST /api/creator-withdraw { amount } -> request a payout
//
// A close mirror of api/affiliate/withdraw.js: transaction-based, never
// trusts a client balance, reserves funds immediately so overlapping
// requests can't double-spend, same 7-day (Sundays excluded) cooldown.
// Operates on creatorPrivate/{uid} and requires an active creator.
const { requireActiveCreator, getDb, FieldValue, ok, fail, setCors } = require('./creator/shared');
const { addNonSundayDays } = require('./affiliate/shared');
const M = require('./core/money');

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  let decoded;
  try {
    ({ decoded } = await requireActiveCreator(req));
  } catch (e) {
    return fail(res, e);
  }
  const uid = decoded.uid;

  if (req.method === 'GET') {
    try {
      const snap = await getDb().collection('creatorWithdrawals').where('creatorId', '==', uid).orderBy('requestedAt', 'desc').limit(50).get();
      return ok(res, { withdrawals: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
    } catch (e) {
      return fail(res, e);
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' } });
  }

  const amount = Number(req.body && req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) return fail(res, { status: 422, code: 'INVALID_AMOUNT', message: 'A valid amount is required.' });

  const db = getDb();
  const privRef = db.collection('creatorPrivate').doc(uid);

  try {
    const result = await db.runTransaction(async (tx) => {
      const privSnap = await tx.get(privRef);
      const priv = (privSnap.exists && privSnap.data()) || {};

      if (!priv.payoutAccount || !priv.payoutAccount.bankCode || !priv.payoutAccount.accountNumber) {
        throw Object.assign(new Error('Add a payout bank account before requesting a withdrawal.'), { status: 400, code: 'NO_PAYOUT_ACCOUNT' });
      }

      if (priv.lastWithdrawalAt) {
        const lastAt = priv.lastWithdrawalAt.toDate ? priv.lastWithdrawalAt.toDate() : new Date(priv.lastWithdrawalAt);
        const nextEligible = addNonSundayDays(lastAt, 7);
        if (new Date() < nextEligible) {
          throw Object.assign(new Error(`You can request your next withdrawal on ${nextEligible.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.`), { status: 400, code: 'COOLDOWN' });
        }
      }

      const settingsSnap = await tx.get(db.collection('catalog').doc('settings'));
      const content = (settingsSnap.exists && settingsSnap.data().content) || {};
      const minWithdrawal = content.creatorMinWithdrawalNGN || 5000;
      const feePct = content.creatorWithdrawalFeePct != null ? content.creatorWithdrawalFeePct : 2.5;

      const balanceAvailable = priv.balanceAvailable || 0;
      if (amount < minWithdrawal) throw Object.assign(new Error(`Minimum withdrawal is ₦${minWithdrawal.toLocaleString()}.`), { status: 400, code: 'BELOW_MINIMUM' });
      if (amount > balanceAvailable) throw Object.assign(new Error('Amount exceeds your available balance.'), { status: 400, code: 'INSUFFICIENT_BALANCE' });

      // The creator withdrawal fee is its OWN setting (creatorWithdrawalFeePct). It is NOT the
      // 5% affiliate withdrawal fee and the 10% creator COMMISSION is charged on sales, not here.
      let calc;
      try { calc = M.computeWithdrawal({ grossMinor: M.toMinor(amount), feeBps: Math.round(Number(feePct) * 100), feeType: 'CREATOR_WITHDRAWAL' }); }
      catch (e) { throw Object.assign(new Error(e.message), { status: 400, code: 'INVALID_AMOUNT' }); }
      const feeAmount = M.toMajor(calc.feeMinor);
      const amountPayable = M.toMajor(calc.netPayableMinor);

      const wdRef = db.collection('creatorWithdrawals').doc();
      tx.set(wdRef, {
        creatorId: uid,
        amountRequested: amount,
        feeAmount,
        amountPayable,
        feePct: calc.feeBps / 100,
        feeSnapshot: { ...calc },
        currency: 'NGN',
        status: 'pending',
        payoutAccount: priv.payoutAccount,
        requestedAt: FieldValue.serverTimestamp(),
        decidedAt: null,
        note: null,
      });
      tx.set(privRef, {
        balanceAvailable: FieldValue.increment(-amount),
        lastWithdrawalAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return { id: wdRef.id, amountPayable, feeAmount };
    });

    return ok(res, result);
  } catch (e) {
    return fail(res, e);
  }
};
