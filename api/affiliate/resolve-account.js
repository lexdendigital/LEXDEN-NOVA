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
    return res.status(400).json({ ok: false, code: 'BAD_INPUT', error: 'account_number and bank_code are required.' });
  }

  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    return res.status(500).json({ ok: false, code: 'MISSING_ENV_VAR', error: 'PAYSTACK_SECRET_KEY not set on the server.' });
  }
  const isTestKey = secret.startsWith('sk_test_');

  try {
    const r = await fetch(
      `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(account_number)}&bank_code=${encodeURIComponent(bank_code)}`,
      { headers: { Authorization: `Bearer ${secret}` } }
    );
    const data = await r.json();
    if (!data.status) {
      // FIX: Paystack's own message text for the test-mode quota literally
      // contains "limit" (e.g. "You have reached your test API request
      // limit for today") — detect it and give the admin the real fix
      // instead of a bare "could not verify" that looks like a typo issue.
      const testLimited = isTestKey && /limit/i.test(data.message || '');
      return res.status(400).json({
        ok: false,
        code: testLimited ? 'PAYSTACK_TEST_MODE' : 'PAYSTACK_REJECTED',
        error: testLimited
          ? 'Paystack test-mode daily verification limit reached. This server is using a TEST secret key — switch PAYSTACK_SECRET_KEY on Render to your LIVE key to lift this limit.'
          : (data.message || 'Could not verify that account number.'),
      });
    }
    return res.status(200).json({ ok: true, accountName: data.data.account_name, testMode: isTestKey });
  } catch (e) {
    console.error('affiliate-resolve-account failed:', e.message);
    return res.status(502).json({ ok: false, code: 'PAYSTACK_UNREACHABLE', error: e.message || 'Could not reach Paystack to verify the account — try again shortly.' });
  }
};
