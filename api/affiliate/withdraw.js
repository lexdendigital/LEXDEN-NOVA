// /api/affiliate/withdraw.js
//
// POST { amount } with `Authorization: Bearer <Firebase ID token>`.
// Validates against the affiliate's real balanceAvailable (never trusts a
// client-supplied balance), enforces the 7-day-between-requests cooldown
// (Sundays don't count toward the 7), reserves the funds immediately (so
// an affiliate can't submit two overlapping requests for more than they
// actually have), and creates an affiliateWithdrawals doc for the admin
// panel to approve/reject/pay.

const { getDb, FieldValue, requireAffiliateAuth, setCors, addNonSundayDays } = require('./shared');
const cfg = require('../core/config');
const M = require('../core/money');
const { queueEmailBackground } = require('../email-shared');

// FEE: the approved AFFILIATE withdrawal fee (5% of the requested GROSS amount). It is
// computed server-side in integer kobo, shown to the affiliate BEFORE they submit
// (GET ?amount=), and its rate + calculation are stored on the withdrawal so a later rate
// change never rewrites history. It is never applied to creator withdrawals.
function previewFor(amountMajor, content, providerCostMinor = 0) {
  const grossMinor = M.toMinor(amountMajor);
  const calc = M.computeAffiliateWithdrawal({ grossMinor, bps: cfg.resolveAffiliateWithdrawalFeeBps(content), providerCostMinor });
  return { grossAmount: M.toMajor(calc.grossMinor), feeAmount: M.toMajor(calc.feeMinor), providerCost: M.toMajor(calc.providerCostMinor), netPayable: M.toMajor(calc.netPayableMinor), feePct: calc.feeBps / 100, calc };
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed — use POST (request) or GET ?amount= (fee preview).' });
  }

  let decoded;
  try {
    decoded = await requireAffiliateAuth(req);
  } catch (e) {
    return res.status(e.status || 401).json({ ok: false, error: e.message });
  }

  // GET ?amount=10000 -> the exact breakdown that a POST of the same amount would record.
  if (req.method === 'GET') {
    try {
      const amt = Number(req.query && req.query.amount);
      if (!amt || amt <= 0) return res.status(400).json({ ok: false, error: 'Invalid amount.' });
      const snap = await getDb().collection('catalog').doc('settings').get();
      const content = (snap.exists && snap.data().content) || {};
      const p = previewFor(amt, content);
      return res.status(200).json({ ok: true, preview: { grossAmount: p.grossAmount, feePct: p.feePct, feeAmount: p.feeAmount, providerCost: p.providerCost, netPayable: p.netPayable, currency: 'NGN' } });
    } catch (e) {
      return res.status(e.status || 400).json({ ok: false, error: e.message || 'Could not calculate the fee.' });
    }
  }

  const amount = Number(req.body && req.body.amount);
  if (!amount || amount <= 0) {
    return res.status(400).json({ ok: false, error: 'Invalid amount.' });
  }

  const db = getDb();
  const affRef = db.collection('affiliates').doc(decoded.uid);

  try {
    const result = await db.runTransaction(async (tx) => {
      const affSnap = await tx.get(affRef);
      if (!affSnap.exists || affSnap.data().status !== 'active') {
        throw Object.assign(new Error('Affiliate account not found or not active.'), { status: 403 });
      }
      const aff = affSnap.data();

      // 7-day-between-requests cooldown, Sundays excluded from the count.
      if (aff.lastWithdrawalAt) {
        const lastAt = aff.lastWithdrawalAt.toDate ? aff.lastWithdrawalAt.toDate() : new Date(aff.lastWithdrawalAt);
        const nextEligible = addNonSundayDays(lastAt, 7);
        if (new Date() < nextEligible) {
          throw Object.assign(new Error(
            `You can request your next withdrawal on ${nextEligible.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.`
          ), { status: 400 });
        }
      }

      // Settings live in catalog/settings' `content` field — the SAME
      // doc/field every other admin-editable setting in the app uses.
      const settingsSnap = await tx.get(db.collection('catalog').doc('settings'));
      const content = (settingsSnap.exists && settingsSnap.data().content) || {};
      const minWithdrawal = content.affiliateMinWithdrawalNGN || 5000;

      const balanceAvailable = aff.balanceAvailable || 0;
      if (amount < minWithdrawal) {
        throw Object.assign(new Error(`Minimum withdrawal is ₦${minWithdrawal.toLocaleString()}.`), { status: 400 });
      }
      if (amount > balanceAvailable) {
        throw Object.assign(new Error('Amount exceeds your available balance.'), { status: 400 });
      }

      let p;
      try { p = previewFor(amount, content); } catch (e) { throw Object.assign(new Error(e.message), { status: 400 }); }
      const feeAmount = p.feeAmount;
      const amountPayable = p.netPayable;

      const wdRef = db.collection('affiliateWithdrawals').doc();
      tx.set(wdRef, {
        affiliateId: decoded.uid,
        amountRequested: amount,
        feeAmount,
        amountPayable,
        feePct: p.feePct,
        feeSnapshot: { ...p.calc },
        currency: 'NGN',
        status: 'pending',
        payoutAccount: aff.payoutAccount || null,
        requestedAt: FieldValue.serverTimestamp(),
        decidedAt: null,
        note: null,
      });
      // Reserve the funds now so a second request can't double-spend the
      // same balance while this one is awaiting admin approval, and stamp
      // the cooldown clock.
      tx.update(affRef, {
        balanceAvailable: FieldValue.increment(-amount),
        lastWithdrawalAt: FieldValue.serverTimestamp(),
      });
      return { id: wdRef.id, amountRequested: amount, amountPayable, feeAmount, feePct: p.feePct };
    });

    queueEmailBackground({
      templateKey: 'affiliate_withdrawal_update',
      to: { email: decoded.email },
      params: {
        status: 'pending',
        amount_requested: '₦' + Number(result.amountRequested || 0).toLocaleString('en-NG'),
        amount_payable: '₦' + Number(result.amountPayable || 0).toLocaleString('en-NG'),
        affiliate_url: 'https://lexdendigital.github.io/LEXDEN-NOVA/affiliate/'
      }
    });
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    console.error('affiliate-withdraw failed:', e.message);
    return res.status(e.status || 500).json({ ok: false, error: e.message || 'Withdrawal request failed.' });
  }
};
