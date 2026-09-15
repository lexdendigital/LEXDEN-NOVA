// /api/affiliate/resolve-account.js
//
// GET ?account_number=&bank_code= — verifies the account and returns the
// real account holder name via Paystack, so an affiliate can't typo their
// own payout details (and so you're not paying out to a name that
// doesn't match what they typed). Requires Paystack's account-resolve
// feature to be enabled for your business (usually on by default for NGN).

const { setCors } = require('./shared');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { account_number, bank_code } = req.query || {};
  if (!account_number || !bank_code) {
    return res.status(400).json({ ok: false, error: 'account_number and bank_code are required.' });
  }

  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    return res.status(500).json({ ok: false, error: 'PAYSTACK_SECRET_KEY not set on the server.' });
  }

  try {
    const r = await fetch(
      `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(account_number)}&bank_code=${encodeURIComponent(bank_code)}`,
      { headers: { Authorization: `Bearer ${secret}` } }
    );
    const data = await r.json();
    if (!data.status) {
      return res.status(400).json({ ok: false, error: data.message || 'Could not verify that account number.' });
    }
    return res.status(200).json({ ok: true, accountName: data.data.account_name });
  } catch (e) {
    console.error('affiliate-resolve-account failed:', e.message);
    return res.status(502).json({ ok: false, error: 'Could not reach Paystack to verify the account — try again shortly.' });
  }
};
