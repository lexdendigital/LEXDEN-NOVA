// /api/creator-payout-account.js
//
// LEXDEN NOVA CREATOR — Stage F.
//
// GET  /api/creator-payout-account -> { payoutAccount } (own, or null)
// POST /api/creator-payout-account { bankCode, bankName, accountNumber }
//      -> verifies accountNumber+bankCode against Paystack server-side and
//         stores the result on creatorPrivate/{uid}. A client-supplied
//         accountName is ignored: only the name Paystack returns is stored.
//
// The bank LIST and live account-number check reuse the existing,
// affiliate-agnostic /api/affiliate-banks and /api/affiliate-resolve-account
// endpoints (plain Paystack pass-throughs); only the final SAVE is here.
const { requireActiveCreator, getDb, writeCreatorAuditLog, ok, fail, setCors } = require('./creator/shared');
const { resolvePaystackSecretKey } = require('./_paystackMode');

async function resolveAccountName(accountNumber, bankCode) {
  const secret = await resolvePaystackSecretKey();
  if (!secret) {
    const e = new Error('PAYSTACK_SECRET_KEY not set on the server.');
    e.status = 500; e.code = 'MISSING_ENV_VAR'; throw e;
  }
  const r = await fetch(
    `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
    { headers: { Authorization: `Bearer ${secret}` } }
  );
  const data = await r.json();
  if (!data.status) {
    const e = new Error(data.message || 'Could not verify that account number with Paystack.');
    e.status = 400; e.code = 'PAYSTACK_REJECTED'; throw e;
  }
  return data.data.account_name;
}

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
      const snap = await getDb().collection('creatorPrivate').doc(uid).get();
      return ok(res, { payoutAccount: (snap.exists && snap.data().payoutAccount) || null });
    } catch (e) {
      return fail(res, e);
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' } });
  }

  const { bankCode, bankName, accountNumber } = req.body || {};
  if (typeof bankCode !== 'string' || !bankCode.trim() || typeof accountNumber !== 'string' || !accountNumber.trim()) {
    return fail(res, { status: 422, code: 'MISSING_FIELDS', message: 'bankCode and accountNumber are required.' });
  }

  try {
    const accountName = await resolveAccountName(accountNumber.trim(), bankCode.trim());
    const payoutAccount = {
      bankCode: bankCode.trim(),
      bankName: typeof bankName === 'string' ? bankName.trim() : null,
      accountNumber: accountNumber.trim(),
      accountName,
      verifiedAt: new Date().toISOString(),
    };
    await getDb().collection('creatorPrivate').doc(uid).set({ payoutAccount }, { merge: true });
    await writeCreatorAuditLog({ actorUid: uid, actorRole: 'creator', action: 'payout_account.updated', targetType: 'creator', targetId: uid, metadata: { bankCode: payoutAccount.bankCode } });
    return ok(res, { payoutAccount });
  } catch (e) {
    return fail(res, e);
  }
};
