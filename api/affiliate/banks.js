// /api/affiliate/banks.js
//
// GET — returns Nigeria's bank list from Paystack (name + code), so the
// onboarding form can offer a dropdown instead of free-text bank names.
// This is what makes automated Paystack Transfers possible later: Paystack
// needs a numeric bank_code, not "GTBank" as typed text. Cached in memory
// for the life of the process — this list changes essentially never.

// FIX: this only ever fetched ONE page. Paystack's bank list defaults to
// perPage=50 and Nigeria alone has 100+ entries once you count microfinance
// banks and fintechs (Kuda, Opay, PalmPay, Moniepoint, etc.) — anything past
// the first 50 (alphabetically) was silently missing from the dropdown.
// Paginating through every page fixes that completely.
async function fetchAllPaystackBanks(secret) {
  const all = [];
  let page = 1;
  while (true) {
    const r = await fetch(`https://api.paystack.co/bank?currency=NGN&country=nigeria&perPage=100&page=${page}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const data = await r.json();
    if (!data.status) throw new Error(data.message || 'Paystack rejected the bank list request.');
    all.push(...data.data);
    const pageCount = (data.meta && data.meta.pageCount) || 1;
    if (page >= pageCount) break;
    page++;
  }
  return all;
}

const { setCors } = require('./shared');

// Built-in fallback so the dropdown is never empty or capped when Paystack
// is rate-limited / unreachable (Paystack codes for NGN banks & fintechs).
const FALLBACK_BANKS = [
  ['Access Bank','044'],['Citibank Nigeria','023'],['Ecobank Nigeria','050'],['Fidelity Bank','070'],
  ['First Bank of Nigeria','011'],['First City Monument Bank','214'],['Globus Bank','00103'],
  ['Guaranty Trust Bank','058'],['Heritage Bank','030'],['Jaiz Bank','301'],['Keystone Bank','082'],
  ['Kuda Microfinance Bank','50211'],['Lotus Bank','303'],['Moniepoint MFB','50515'],['OPay','999992'],
  ['PalmPay','999991'],['Parallex Bank','104'],['Polaris Bank','076'],['Premium Trust Bank','105'],
  ['Providus Bank','101'],['Stanbic IBTC Bank','221'],['Standard Chartered Bank','068'],
  ['Sterling Bank','232'],['SunTrust Bank','100'],['TAJ Bank','302'],['Titan Trust Bank','000025'],
  ['Union Bank of Nigeria','032'],['United Bank for Africa','033'],['Unity Bank','215'],
  ['VFD Microfinance Bank','566'],['Wema Bank','035'],['Zenith Bank','057'],
].map(([name, code]) => ({ name, code }));

let cachedBanks = null;
let cachedAt = 0;
const CACHE_MS = 24 * 60 * 60 * 1000; // 24h

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (cachedBanks && (Date.now() - cachedAt) < CACHE_MS) {
    return res.status(200).json({ ok: true, banks: cachedBanks, cached: true });
  }

  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    return res.status(500).json({ ok: false, code: 'MISSING_ENV_VAR', error: 'PAYSTACK_SECRET_KEY not set on the server.' });
  }
  // FIX: PAYSTACK_SECRET_KEY starting with sk_test_ silently caps how
  // much this endpoint can do (Paystack rate-limits test-mode bank/resolve
  // calls) — surface that plainly with an error code instead of letting
  // it masquerade as a generic connection failure once the quota hits.
  const isTestKey = secret.startsWith('sk_test_');

  try {
    const raw = await fetchAllPaystackBanks(secret);
    cachedBanks = raw
      .map(b => ({ name: b.name, code: b.code }))
      .sort((a, b) => a.name.localeCompare(b.name));
    cachedAt = Date.now();
    return res.status(200).json({ ok: true, banks: cachedBanks, cached: false, testMode: isTestKey });
  } catch (e) {
    console.error('affiliate-banks failed:', e.message);
    const testLimited = isTestKey && /limit/i.test(e.message || '');
    // Never leave the applicant with an empty/failed dropdown.
    if (cachedBanks) return res.status(200).json({ ok: true, banks: cachedBanks, cached: true, stale: true });
    return res.status(200).json({ ok: true, banks: FALLBACK_BANKS, fallback: true, warning: e.message });
    // eslint-disable-next-line no-unreachable
    return res.status(502).json({
      ok: false,
      code: testLimited ? 'PAYSTACK_TEST_MODE' : 'PAYSTACK_UNREACHABLE',
      error: testLimited
        ? 'Paystack test-mode daily limit reached. Switch PAYSTACK_SECRET_KEY on Render to your LIVE secret key to remove this limit.'
        : (e.message || 'Could not reach Paystack for the bank list — try again shortly.'),
    });
  }
};
