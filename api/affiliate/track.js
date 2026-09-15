// /api/affiliate/track.js
//
// Backs the /go/:ref/:pid? route in server.js. Logs the click server-side
// (accurate — survives ad-blockers that strip client pixels), bumps the
// fast per-link counter affiliates see on My Store, bumps today's daily
// stat doc (feeds the dashboard graph), then 302s into the storefront
// with ?ref=&pid= so index.html's landing script can set the long-lived
// localStorage attribution keys.
//
// Exports a FACTORY (not a handler directly) because it needs storeUrl
// baked in — server.js calls affiliateTrackHandler(storeUrl) once at
// boot and passes the returned function to app.get().

const crypto = require('crypto');
const { getDb, FieldValue } = require('./shared');

function hash(s) {
  return crypto.createHash('sha256').update(String(s || '')).digest('hex').slice(0, 24);
}
function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

module.exports = function affiliateTrackHandlerFactory(storeUrl) {
  return async function affiliateTrackHandler(req, res) {
    const ref = req.params.ref;
    const pid = req.params.pid || null;

    if (!ref) {
      return res.redirect(302, storeUrl);
    }

    // Log the click — never let a logging failure block the redirect. A
    // customer must always land on the store even if Firestore is briefly
    // unavailable; a missed click log is a much smaller problem than a
    // dead link.
    try {
      const db = getDb();
      const affSnap = await db.collection('affiliates').doc(ref).get();
      if (affSnap.exists) {
        const linkKey = `${ref}_${pid || 'general'}`;
        const dailyKey = `${ref}_${todayKey()}`;
        await Promise.all([
          db.collection('affiliateClicks').add({
            ref, pid, ts: FieldValue.serverTimestamp(),
            uaHash: hash(req.headers['user-agent']),
            ipHash: hash((req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()),
          }),
          // Fast per-link counter — what My Store reads to show "X clicks,
          // Y sales" per link without ever scanning the raw click log.
          db.collection('affiliateLinkStats').doc(linkKey).set({
            ref, pid: pid || null, clicks: FieldValue.increment(1),
          }, { merge: true }),
          // Daily rollup — what the dashboard graph reads.
          db.collection('affiliateDailyStats').doc(dailyKey).set({
            ref, date: todayKey(), clicks: FieldValue.increment(1),
          }, { merge: true }),
        ]);
      }
      // If the affiliate id doesn't exist, still redirect normally — a
      // bad/old link shouldn't 404 on the customer, it should just not
      // end up attributing anyone (verify-paystack.js re-checks the
      // affiliate exists before paying commission anyway).
    } catch (e) {
      console.error('affiliate-track click log failed (non-fatal):', e.message);
    }

    const url = new URL(storeUrl);
    url.searchParams.set('ref', ref);
    if (pid) url.searchParams.set('pid', pid);
    return res.redirect(302, url.toString());
  };
};
