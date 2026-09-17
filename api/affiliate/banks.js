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
    return res.status(500).json({ ok: false, error: 'PAYSTACK_SECRET_KEY not set on the server.' });
  }

  try {
    const raw = await fetchAllPaystackBanks(secret);
    cachedBanks = raw
      .map(b => ({ name: b.name, code: b.code }))
      .sort((a, b) => a.name.localeCompare(b.name));
    cachedAt = Date.now();
    return res.status(200).json({ ok: true, banks: cachedBanks, cached: false });
  } catch (e) {
    console.error('affiliate-banks failed:', e.message);
    return res.status(502).json({ ok: false, error: 'Could not reach Paystack for the bank list — try again shortly.' });
  }
};
