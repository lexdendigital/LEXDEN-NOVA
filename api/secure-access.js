// /api/secure-access.js
//
// One-time access links for products whose real delivery URL (e.g. a Google
// Classroom invite) must not be shared around.
//
//   POST /api/secure-access  {reference}         (signed-in buyer)
//       -> verifies a paid order for this buyer + a secureDelivery product,
//          returns { ok:true, data:{ url } }  (a personal one-time page link)
//   GET  /api/secure-access?t=TOKEN
//       -> small confirmation page (a GET never consumes the link, so chat
//          apps / link previews can't burn it)
//   POST /api/secure-access  {t:TOKEN}  (from that page)
//       -> atomically marks the link used, then returns the real URL once.
//
// The real URL lives ONLY in the server env var SECURE_LINK_TARGETS, a JSON
// object {"<productId>":"https://classroom.google.com/..."}. It is never
// stored in the public catalog. Only a SHA-256 hash of each token is stored,
// in the server-only collection `accessGrants` (doc id = order reference).
//
// Limits: a buyer who opens the link sees the real URL, so this stops casual
// forwarding of a link, not a determined buyer. Rotate the Classroom invite
// if it ever leaks.
const crypto = require('crypto');
const { requireAuth, getDb, FieldValue, setCors } = require('./creator/shared');

const COLLECTION = 'accessGrants';
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function targets() {
  try { return JSON.parse(process.env.SECURE_LINK_TARGETS || '{}') || {}; } catch (_) { return {}; }
}
function targetFor(productId) {
  const u = targets()[productId];
  return typeof u === 'string' && /^https:\/\//i.test(u) ? u : null;
}
function baseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  return `${proto}://${req.headers.host}`;
}
function page(res, status, title, body) {
  res.status(status).set({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex',
  }).send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font-family:system-ui,sans-serif;background:#0f1115;color:#eee;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:20px}.c{max-width:420px;background:#181b22;border-radius:14px;padding:26px;text-align:center}button{background:#2f7df6;color:#fff;border:0;border-radius:10px;padding:12px 20px;font-size:16px;cursor:pointer;width:100%}p{color:#b8bdc8;line-height:1.5}</style></head><body><div class="c">${body}</div></body></html>`);
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  const db = getDb();

  try {
    // ---- GET: confirmation page only; never consumes ----
    if (req.method === 'GET') {
      const t = typeof req.query.t === 'string' ? req.query.t : '';
      if (!/^[A-Za-z0-9_-]{20,100}$/.test(t)) return page(res, 400, 'Invalid link', '<h2>Invalid link</h2><p>This access link is not valid.</p>');
      return page(res, 200, 'Open your course',
        `<h2>Your course access</h2><p>This personal link works <b>once</b>. Tap the button to open Google Classroom. Do not share it.</p>
<button id="b">Open Google Classroom</button><p id="m"></p>
<script>document.getElementById('b').onclick=async function(){this.disabled=true;var m=document.getElementById('m');try{var r=await fetch('/api/secure-access',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:${JSON.stringify(t)}})});var j=await r.json();if(j.ok&&j.data&&j.data.url){location.href=j.data.url}else{m.textContent=(j.error&&j.error.message)||'This link cannot be used.';}}catch(e){m.textContent='Network problem. Check your connection and try again.';this.disabled=false}}</script>`);
    }

    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' } });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

    // ---- POST consume ----
    if (typeof body.t === 'string') {
      if (!/^[A-Za-z0-9_-]{20,100}$/.test(body.t)) return res.status(400).json({ ok: false, error: { code: 'INVALID', message: 'This access link is not valid.' } });
      const h = hash(body.t);
      const q = await db.collection(COLLECTION).where('tokenHash', '==', h).limit(1).get();
      if (q.empty) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'This access link is not valid.' } });
      const ref = q.docs[0].ref;
      const result = await db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        const d = s.data();
        if (!s.exists || d.tokenHash !== h) return { err: 'NOT_FOUND' };
        if (d.usedAt) return { err: 'USED' };
        const url = targetFor(d.productId);
        if (!url) return { err: 'NOT_CONFIGURED' };
        tx.update(ref, { usedAt: FieldValue.serverTimestamp(), usedIp: String(req.headers['x-forwarded-for'] || '').split(',')[0].slice(0, 64) });
        return { url };
      });
      if (result.err === 'USED') return res.status(410).json({ ok: false, error: { code: 'USED', message: 'This link has already been used. Contact LEXDEN NOVA support with your order reference and the email you used to pay.' } });
      if (result.err === 'NOT_CONFIGURED') return res.status(503).json({ ok: false, error: { code: 'NOT_CONFIGURED', message: 'Access is not available yet. Contact LEXDEN NOVA support with your order reference.' } });
      if (result.err) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'This access link is not valid.' } });
      return res.json({ ok: true, data: { url: result.url } });
    }

    // ---- POST claim (signed-in buyer) ----
    const decoded = await requireAuth(req);
    const reference = typeof body.reference === 'string' ? body.reference : '';
    if (!/^[A-Za-z0-9._-]{6,80}$/.test(reference)) return res.status(422).json({ ok: false, error: { code: 'MISSING_REFERENCE', message: 'Order reference is required.' } });

    const orderSnap = await db.collection('orders').doc(reference).get();
    const order = orderSnap.exists ? orderSnap.data() : null;
    // One generic answer for every refusal so this can't probe other people's orders.
    const denied = () => res.status(403).json({ ok: false, error: { code: 'NOT_ENTITLED', message: 'We could not confirm access for this order. Contact support with your order reference.' } });
    if (!order || order.status !== 'paid' || order.uid !== decoded.uid) return denied();

    const prodSnap = await db.collection('catalog').doc('products').get();
    const list = prodSnap.exists ? (prodSnap.data().list || []) : [];
    const product = Array.isArray(list) ? list.find((p) => p && p.id === order.productId) : null;
    if (!product || !product.secureDelivery || !targetFor(order.productId)) return denied();

    const grantRef = db.collection(COLLECTION).doc(reference);
    const token = crypto.randomBytes(32).toString('base64url');
    const outcome = await db.runTransaction(async (tx) => {
      const g = await tx.get(grantRef);
      if (g.exists && g.data().usedAt) return { used: true };
      // Unused: (re)issue a fresh token so a lost link can be recovered while the old one dies.
      tx.set(grantRef, {
        orderRef: reference, uid: decoded.uid, productId: order.productId,
        tokenHash: hash(token), usedAt: null,
        issuedAt: FieldValue.serverTimestamp(), issueCount: ((g.exists && g.data().issueCount) || 0) + 1,
      });
      return { used: false };
    });
    if (outcome.used) return res.status(410).json({ ok: false, error: { code: 'USED', message: 'Your access link has already been used. Contact LEXDEN NOVA support with your order reference and the email you used to pay.' } });
    return res.json({ ok: true, data: { url: `${baseUrl(req)}/api/secure-access?t=${token}` } });
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ ok: false, error: { code: e.code || 'ERROR', message: e.message || 'Something went wrong.' } });
    console.error('secure-access error:', e);
    return res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } });
  }
};
