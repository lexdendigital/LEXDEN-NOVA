// /api/affiliate-release   (POST or GET)
//
// Frees commissions whose 8-day hold has ended (pending -> available).
//   * An affiliate's own dashboard calls it with their Firebase token  -> releases only theirs.
//   * The scheduler calls it with the CRON_SECRET                       -> releases everyone's.
// Releasing is idempotent and only ever does what the calendar already says, so an
// unauthenticated sweep is allowed ONLY when CRON_SECRET is not configured (same open-until-
// configured behaviour as the other sweep endpoints in server.js).

const { getDb, requireAffiliateAuth, setCors } = require('./shared');
const { releaseDue } = require('./commissions');
const { cronAuthorized } = require('../../server-security');

module.exports = async function affiliateReleaseHandler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Use POST.' });

  try {
    const secret = process.env.CRON_SECRET;
    const secretOk = !!secret && secret.length >= 16;
    let affiliateId = null;

    if (secretOk && cronAuthorized(req, secret)) {
      affiliateId = null; // scheduler: everyone
    } else if (String(req.headers.authorization || '').startsWith('Bearer ')) {
      const decoded = await requireAffiliateAuth(req); // throws 401/503 with a clear message
      affiliateId = decoded.uid;
    } else if (secretOk) {
      return res.status(401).json({ ok: false, error: 'Unauthorized.' });
    }
    const out = await releaseDue(getDb(), { affiliateId });
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    console.error('affiliate-release failed:', e.message);
    return res.status(e.status || 500).json({ ok: false, error: e.message || 'Release failed.' });
  }
};
