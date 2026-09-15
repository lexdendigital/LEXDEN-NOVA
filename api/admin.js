// /api/affiliate/admin.js
//
// Admin-only actions for the affiliate program, called directly from the
// new "Affiliate Program" tab in your existing admin portal (index.html).
// Settings (commission %, fee %, links) are NOT handled here anymore —
// they save straight from index.html into catalog/settings the same way
// every other admin setting in the app does. This file is only for
// things that must go through the backend: approvals and money.
//
// POST { action, ...payload } with Authorization: Bearer <admin ID token>
//
// Actions:
//   approve-affiliate          { affiliateId }
//   suspend-affiliate          { affiliateId }
//   approve-withdrawal         { withdrawalId }   -> status 'approved'
//   mark-withdrawal-paid       { withdrawalId }   -> status 'paid' (you sent it manually)
//   reject-withdrawal          { withdrawalId, note? } -> status 'rejected', refunds balance
//   pay-withdrawal-via-paystack{ withdrawalId }   -> automated payout via Paystack Transfers

const { getDb, FieldValue, requireAdminAuth, setCors } = require('./shared');

const PAYSTACK_BASE = 'https://api.paystack.co';

async function paystackFetch(path, options) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) throw Object.assign(new Error('PAYSTACK_SECRET_KEY not set on the server.'), { status: 500 });
  const r = await fetch(PAYSTACK_BASE + path, {
    ...options,
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', ...(options && options.headers) },
  });
  const data = await r.json();
  if (!data.status) throw Object.assign(new Error(data.message || 'Paystack request failed.'), { status: 502 });
  return data;
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed — use POST.' });
  }

  try {
    await requireAdminAuth(req);
  } catch (e) {
    return res.status(e.status || 401).json({ ok: false, error: e.message });
  }

  const db = getDb();
  const { action } = req.body || {};

  try {
    switch (action) {
      case 'approve-affiliate': {
        const { affiliateId } = req.body;
        if (!affiliateId) return res.status(400).json({ ok: false, error: 'Missing affiliateId.' });
        await db.collection('affiliates').doc(affiliateId).update({ status: 'active', approvedAt: FieldValue.serverTimestamp() });
        return res.status(200).json({ ok: true });
      }

      case 'suspend-affiliate': {
        const { affiliateId } = req.body;
        if (!affiliateId) return res.status(400).json({ ok: false, error: 'Missing affiliateId.' });
        await db.collection('affiliates').doc(affiliateId).update({ status: 'suspended' });
        return res.status(200).json({ ok: true });
      }

      case 'approve-withdrawal': {
        const { withdrawalId } = req.body;
        if (!withdrawalId) return res.status(400).json({ ok: false, error: 'Missing withdrawalId.' });
        await db.collection('affiliateWithdrawals').doc(withdrawalId)
          .update({ status: 'approved', decidedAt: FieldValue.serverTimestamp() });
        return res.status(200).json({ ok: true });
      }

      case 'mark-withdrawal-paid': {
        const { withdrawalId } = req.body;
        if (!withdrawalId) return res.status(400).json({ ok: false, error: 'Missing withdrawalId.' });
        const wdRef = db.collection('affiliateWithdrawals').doc(withdrawalId);
        await db.runTransaction(async (tx) => {
          const wdSnap = await tx.get(wdRef);
          if (!wdSnap.exists) throw Object.assign(new Error('Withdrawal not found.'), { status: 404 });
          const wd = wdSnap.data();
          tx.update(wdRef, { status: 'paid', decidedAt: FieldValue.serverTimestamp() });
          tx.update(db.collection('affiliates').doc(wd.affiliateId), {
            totalWithdrawn: FieldValue.increment(wd.amountRequested),
          });
        });
        return res.status(200).json({ ok: true });
      }

      case 'reject-withdrawal': {
        const { withdrawalId, note } = req.body;
        if (!withdrawalId) return res.status(400).json({ ok: false, error: 'Missing withdrawalId.' });
        const wdRef = db.collection('affiliateWithdrawals').doc(withdrawalId);
        await db.runTransaction(async (tx) => {
          const wdSnap = await tx.get(wdRef);
          if (!wdSnap.exists) throw Object.assign(new Error('Withdrawal not found.'), { status: 404 });
          const wd = wdSnap.data();
          if (wd.status !== 'pending') throw Object.assign(new Error('Only pending withdrawals can be rejected.'), { status: 400 });
          tx.update(wdRef, { status: 'rejected', note: note || null, decidedAt: FieldValue.serverTimestamp() });
          // Refund the reserved amount back to their available balance.
          tx.update(db.collection('affiliates').doc(wd.affiliateId), {
            balanceAvailable: FieldValue.increment(wd.amountRequested),
          });
        });
        return res.status(200).json({ ok: true });
      }

      // ---- AUTOMATED PAYOUT (the "reliable code walkaround" for when
      // you can't afford a separate automation tool) — this is just two
      // Paystack API calls using the PAYSTACK_SECRET_KEY you already
      // have. Zero extra cost beyond Paystack's own per-transfer fee,
      // which you'd pay no matter how the money moves. It ONLY works
      // once Paystack Transfers is enabled for your business (Paystack
      // dashboard → Settings → Preferences → enable Transfers — needs
      // your business verification to go through first). Until then this
      // action fails cleanly and "Mark Paid" (manual) still works fine.
      case 'pay-withdrawal-via-paystack': {
        const { withdrawalId } = req.body;
        if (!withdrawalId) return res.status(400).json({ ok: false, error: 'Missing withdrawalId.' });
        const wdRef = db.collection('affiliateWithdrawals').doc(withdrawalId);
        const wdSnap = await wdRef.get();
        if (!wdSnap.exists) return res.status(404).json({ ok: false, error: 'Withdrawal not found.' });
        const wd = wdSnap.data();
        if (wd.status !== 'approved') {
          return res.status(400).json({ ok: false, error: 'Approve the withdrawal first.' });
        }
        const acct = wd.payoutAccount;
        if (!acct || !acct.bankCode || !acct.accountNumber || !acct.accountName) {
          return res.status(400).json({ ok: false, error: 'This affiliate has no bank code on file — ask them to re-verify their bank in onboarding, or use Mark Paid instead.' });
        }

        // Step 1: create (or reuse) a transfer recipient.
        const recipient = await paystackFetch('/transferrecipient', {
          method: 'POST',
          body: JSON.stringify({
            type: 'nuban', currency: 'NGN',
            name: acct.accountName, account_number: acct.accountNumber, bank_code: acct.bankCode,
          }),
        });
        const recipientCode = recipient.data.recipient_code;

        // Step 2: initiate the transfer (amount in kobo).
        const transfer = await paystackFetch('/transfer', {
          method: 'POST',
          body: JSON.stringify({
            source: 'balance',
            amount: Math.round(wd.amountPayable * 100),
            recipient: recipientCode,
            reason: `LEXDEN NOVA affiliate payout — withdrawal ${withdrawalId}`,
          }),
        });

        await db.runTransaction(async (tx) => {
          tx.update(wdRef, {
            status: 'paid', decidedAt: FieldValue.serverTimestamp(),
            paystackRecipientCode: recipientCode,
            paystackTransferCode: transfer.data.transfer_code || null,
            paystackTransferStatus: transfer.data.status || null,
          });
          tx.update(db.collection('affiliates').doc(wd.affiliateId), {
            totalWithdrawn: FieldValue.increment(wd.amountRequested),
          });
        });
        return res.status(200).json({ ok: true, transferStatus: transfer.data.status });
      }

      default:
        return res.status(400).json({ ok: false, error: `Unknown action "${action}".` });
    }
  } catch (e) {
    console.error('affiliate-admin action failed:', e.message);
    return res.status(e.status || 500).json({ ok: false, error: e.message || 'Action failed.' });
  }
};
