// /api/cj-webhook.js
//
// LEXDEN NOVA × CJ — inbound webhook receiver (README §25-28).
// CJ requires: HTTPS, POST, application/json, HTTP 200, response within
// 3 seconds. This verifies the signature FIRST (reject fast on failure),
// then does the minimum synchronous work needed to answer within budget,
// deferring anything slower to a background task via waitUntil — exactly
// the same "respond fast, guarantee completion" pattern email-shared.js
// uses for email.
//
// bodyParser is disabled below because HMAC verification needs the exact
// raw bytes CJ signed — Vercel's default JSON body parser would already
// have re-serialized the body by the time req.body existed, which can
// silently break signature verification on subtle whitespace/key-order
// differences.
//
// Configure this URL in CJ as: https://YOUR-PROJECT.vercel.app/api/cj-webhook

module.exports.config = { api: { bodyParser: false } };

const { verifyCjWebhookSignature, writeSyncLog, db, FieldValue, getProductsDoc, saveProductsDoc } = require('./cj-shared');

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function handleOrderEvent(event) {
  const cjOrderId = event.orderId || event.data?.orderId;
  if (!cjOrderId) return;
  const snap = await db().collection('orders').where('cj.orderId', '==', cjOrderId).limit(1).get();
  if (snap.empty) return;
  const doc = snap.docs[0];
  const cur = doc.data().cj || {};
  await doc.ref.set({
    cj: {
      ...cur,
      status: event.status || event.data?.status || cur.status,
      trackingNumber: event.trackNumber || event.data?.trackNumber || cur.trackingNumber,
      carrier: event.logisticName || event.data?.logisticName || cur.carrier,
      updatedAt: new Date().toISOString(),
    },
  }, { merge: true });
}

async function handleStockEvent(event) {
  const vid = event.vid || event.data?.vid;
  if (!vid) return;
  const doc = await getProductsDoc();
  const list = Array.isArray(doc.list) ? doc.list : [];
  let changed = false;
  const updated = list.map(p => {
    if (p && p.physical && p.physical.cj && p.physical.cj.variantId === vid) {
      changed = true;
      const inStock = event.inStock !== undefined ? !!event.inStock : (Number(event.num ?? event.data?.num ?? 1) > 0);
      return { ...p, physical: { ...p.physical, stockStatus: inStock ? 'in_stock' : 'out_of_stock', cj: { ...p.physical.cj, lastSyncedAt: new Date().toISOString() } } };
    }
    return p;
  });
  if (changed) await saveProductsDoc(updated);
}

async function processEvent(event) {
  const type = String(event.type || event.event || event.messageType || '').toUpperCase();
  try {
    if (type.includes('ORDER') || type.includes('LOGISTIC') || type.includes('SHIP')) {
      await handleOrderEvent(event);
    } else if (type.includes('STOCK') || type.includes('INVENTORY')) {
      await handleStockEvent(event);
    }
    // PRODUCT events are intentionally NOT auto-applied to published NOVA
    // content (README §73 — never let a CJ update silently overwrite
    // Admin-curated name/description/images). They're logged for the
    // admin to review and manually [Sync Now] if desired.
    await writeSyncLog({ event: `webhook.${type || 'unknown'}`, objectId: event.orderId || event.vid || event.pid || null, success: true, message: 'Processed', detail: event });
  } catch (e) {
    await writeSyncLog({ event: `webhook.${type || 'unknown'}`, success: false, message: e.message, detail: event });
  }
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  let raw;
  try {
    raw = await readRawBody(req);
  } catch {
    res.status(200).json({ ok: false }); // still 200 — CJ isn't retried usefully by a 4xx here; log server-side instead
    return;
  }

  const signature = req.headers['cj-signature'] || req.headers['x-cj-signature'] || req.headers['signature'];
  const valid = verifyCjWebhookSignature(raw, signature);
  if (!valid) {
    await writeSyncLog({ event: 'webhook.rejected', success: false, message: 'Invalid or missing signature' });
    res.status(200).json({ ok: false, error: 'invalid_signature' }); // 200 so CJ doesn't hammer retries on a config problem; visible in Sync Logs instead
    return;
  }

  let event;
  try { event = JSON.parse(raw); } catch { event = {}; }

  // ---- Respond within CJ's 3-second budget immediately, then finish the
  // actual Firestore work in the background. ----
  res.status(200).json({ ok: true, received: true });

  try {
    const { waitUntil } = require('@vercel/functions');
    waitUntil(processEvent(event));
  } catch {
    // No waitUntil available — best effort, may be cut short on some
    // runtimes, but the response above has already gone out on time.
    processEvent(event).catch(() => {});
  }
};
