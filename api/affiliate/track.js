// /api/affiliate/track.js
//
// Backs the /go/:ref/:pid? route in server.js.
// 1) Redirect FIRST (so a slow Firestore or a cold start never delays the shopper).
// 2) Log the click AFTER the redirect has been sent, in the background.
// The redirect carries the product THREE ways (?pid=, ?product=, #product/<id>) so that
// in-app browsers that strip the #hash still land on the product.
//
// Exports a FACTORY because it needs storeUrl baked in — server.js calls
// affiliateTrackHandler(storeUrl) once at boot.

const crypto = require('crypto');
const { getDb, FieldValue } = require('./shared');

// Firebase uids and product ids are letters, digits, "-" and "_" only.
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
// Link-preview fetchers and scripts are not shoppers; do not count them as clicks.
const BOT_RE = /bot|crawler|spider|preview|facebookexternalhit|whatsapp\/|slurp|headless|curl|wget|python-requests|axios|go-http-client/i;
const CLICK_BUCKET_MS = 30 * 60 * 1000; // same visitor + same link within 30 min = one click

function hash(s) {
  return crypto.createHash('sha256').update(String(s || '')).digest('hex').slice(0, 24);
}
function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function logClick(req, ref, pid) {
  const ua = String(req.headers['user-agent'] || '');
  if (!ua || BOT_RE.test(ua)) return; // bots and previews are not clicks
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const db = getDb();
  const affSnap = await db.collection('affiliates').doc(ref).get();
  if (!affSnap.exists) return; // unknown affiliate: still redirected, just not counted

  // Deterministic id => the same visitor hitting the same link again inside the
  // 30-minute bucket hits ALREADY_EXISTS and is not counted twice.
  const bucket = Math.floor(Date.now() / CLICK_BUCKET_MS);
  const clickId = hash([ref, pid || '', ip, ua, bucket].join('|'));
  try {
    await db.collection('affiliateClicks').doc(clickId).create({
      ref, pid, ts: FieldValue.serverTimestamp(), uaHash: hash(ua), ipHash: hash(ip),
    });
  } catch (e) {
    if (e && (e.code === 6 || /ALREADY_EXISTS/i.test(String(e.message)))) return; // duplicate click
    throw e;
  }
  const linkKey = `${ref}_${pid || 'general'}`;
  const dailyKey = `${ref}_${todayKey()}`;
  await Promise.all([
    db.collection('affiliateLinkStats').doc(linkKey).set({
      ref, pid: pid || null, clicks: FieldValue.increment(1),
    }, { merge: true }),
    db.collection('affiliateDailyStats').doc(dailyKey).set({
      ref, date: todayKey(), clicks: FieldValue.increment(1),
    }, { merge: true }),
  ]);
}

module.exports = function affiliateTrackHandlerFactory(storeUrl) {
  return function affiliateTrackHandler(req, res) {
    const ref = String(req.params.ref || '');
    const pidRaw = req.params.pid ? String(req.params.pid) : '';
    if (!ID_RE.test(ref)) return res.redirect(302, storeUrl); // junk link: just open the store
    const pid = ID_RE.test(pidRaw) ? pidRaw : null;

    const url = new URL(storeUrl);
    url.searchParams.set('ref', ref);
    if (pid) {
      url.searchParams.set('pid', pid);
      url.searchParams.set('product', pid); // boot.js turns ?product= into #product/<id>
      url.hash = 'product/' + encodeURIComponent(pid);
    }
    res.set('Cache-Control', 'no-store');
    res.redirect(302, url.toString());

    // Background logging — never allowed to affect the response that was already sent.
    logClick(req, ref, pid).catch((e) => console.error('affiliate-track click log failed (non-fatal):', e.message));
  };
};
