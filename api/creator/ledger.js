// api/creator/ledger.js
//
// LEXDEN NOVA CREATOR — Stage F: money/ledger (the earning side).
// Modeled on the app's proven affiliate-commission pattern
// (verify-paystack.js attributeAffiliateCommission + affiliate/admin.js):
// earnings are "available" immediately; admin approval at WITHDRAWAL time
// is the fraud/refund checkpoint, not a separate hold timer.
//
// Stage K adds an OPTIONAL hold (escrow): when the admin sets
// catalog/settings.content.creatorHoldDays > 0, a new sale is 'held' (counted in
// balancePending) until releaseAtMs, then moved to balanceAvailable by the
// `holds` job. Default 0 = exactly the old behaviour. A dispute freezes a sale
// ('disputed'); an admin decision either releases it or refunds it (reverses the
// creator's earning). Nothing here ever sends money out: refunds to the buyer
// are paid by the admin outside the app.
//
// Balance/earnings fields live on creatorPrivate/{uid}, NEVER on
// creators/{uid}: that doc is the public storefront profile
// (`allow read: if true` in firestore.rules), so a balance there would
// publish every creator's earnings.
const { getDb: sharedGetDb, FieldValue } = require('./shared');

// Pure. Same rounding as attributeAffiliateCommission's commission math.
function splitByFeePct(amount, pct) {
  const feeAmount = Math.round(amount * pct) / 100;
  const netAmount = Math.round((amount - feeAmount) * 100) / 100;
  return { feeAmount, netAmount };
}

const DEFAULT_PLATFORM_FEE_PCT = 15;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_HOLD_DAYS = 60;

async function getHoldDays(db) {
  const snap = await db.collection('catalog').doc('settings').get();
  const c = (snap.exists && snap.data().content) || {};
  const n = Number(c.creatorHoldDays);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_HOLD_DAYS) : 0;
}

// Idempotent on `reference`: the sale doc is created in a transaction
// that only credits the balance if the doc did not already exist, so a
// retried verify-paystack.js call can never double-credit a creator.
// Fire-and-forget from verify-paystack.js; failures are logged loudly.
async function attributeCreatorEarning(db, { reference, creatorId, productId, productTitle, offeringType, amountMajor, currency }) {
  if (!creatorId) return { credited: false, reason: 'NO_CREATOR' };
  if (!amountMajor || amountMajor <= 0) return { credited: false, reason: 'FREE' };

  const settingsSnap = await db.collection('catalog').doc('settings').get();
  const content = (settingsSnap.exists && settingsSnap.data().content) || {};
  const feePct = typeof content.creatorPlatformFeePct === 'number' ? content.creatorPlatformFeePct : DEFAULT_PLATFORM_FEE_PCT;
  const { feeAmount, netAmount: creatorEarning } = splitByFeePct(amountMajor, feePct);
  const holdDays = typeof content.creatorHoldDays === 'number' && content.creatorHoldDays > 0 ? Math.min(Math.floor(content.creatorHoldDays), MAX_HOLD_DAYS) : 0;
  const nowMs = Date.now();
  if (creatorEarning <= 0) return { credited: false, reason: 'ZERO_EARNING' };

  const saleRef = db.collection('creatorSales').doc(reference);
  const privRef = db.collection('creatorPrivate').doc(creatorId);
  const credited = await db.runTransaction(async (tx) => {
    const existing = await tx.get(saleRef);
    if (existing.exists) return false;
    tx.set(saleRef, {
      creatorId,
      productId: productId || null,
      productTitle: productTitle || null,
      offeringType: offeringType || null,
      orderId: reference,
      saleAmount: amountMajor,
      currency: currency || null,
      platformFeePct: feePct,
      platformFeeAmount: feeAmount,
      creatorEarning,
      status: holdDays ? 'held' : 'available',
      ...(holdDays ? { releaseAtMs: nowMs + holdDays * DAY_MS, holdDays } : {}),
      createdAtMs: nowMs,
      createdAt: FieldValue.serverTimestamp(),
    });
    // set+merge so a missing creatorPrivate doc is initialised, not a NOT_FOUND.
    tx.set(privRef, holdDays ? {
      balancePending: FieldValue.increment(creatorEarning),
      totalEarned: FieldValue.increment(creatorEarning),
    } : {
      balanceAvailable: FieldValue.increment(creatorEarning),
      totalEarned: FieldValue.increment(creatorEarning),
    }, { merge: true });
    return true;
  });
  return { credited, creatorEarning };
}

const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round(n * 100) / 100;

// Moves ONE held sale to available. Idempotent (re-checks status inside the transaction).
async function releaseSale(db, saleId) {
  const saleRef = db.collection('creatorSales').doc(saleId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(saleRef);
    if (!snap.exists || snap.data().status !== 'held') return false;
    const sale = snap.data();
    tx.set(saleRef, { status: 'available', releasedAtMs: Date.now() }, { merge: true });
    tx.set(db.collection('creatorPrivate').doc(sale.creatorId), {
      balancePending: FieldValue.increment(-num(sale.creatorEarning)),
      balanceAvailable: FieldValue.increment(num(sale.creatorEarning)),
    }, { merge: true });
    return true;
  });
}

async function releaseDueHolds(db, nowMs, limit = 200) {
  const snap = await db.collection('creatorSales').where('status', '==', 'held').limit(1000).get();
  const due = snap.docs.filter((d) => num(d.data().releaseAtMs) <= nowMs).slice(0, limit);
  let released = 0;
  for (const d of due) { if (await releaseSale(db, d.id)) released += 1; }
  return { held: snap.docs.length, released };
}

// A dispute freezes the creator's earning for that order (pending, not withdrawable).
async function freezeSale(db, saleId, disputeId) {
  const saleRef = db.collection('creatorSales').doc(saleId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(saleRef);
    if (!snap.exists) return { frozen: false, reason: 'NO_SALE' };
    const sale = snap.data();
    if (sale.status === 'disputed') return { frozen: true, already: true };
    if (sale.status !== 'available' && sale.status !== 'held') return { frozen: false, reason: 'NOT_FREEZABLE' };
    tx.set(saleRef, { status: 'disputed', frozenFrom: sale.status, disputeId: disputeId || null, frozenAtMs: Date.now() }, { merge: true });
    if (sale.status === 'available') {
      tx.set(db.collection('creatorPrivate').doc(sale.creatorId), {
        balanceAvailable: FieldValue.increment(-num(sale.creatorEarning)),
        balancePending: FieldValue.increment(num(sale.creatorEarning)),
      }, { merge: true });
    }
    return { frozen: true };
  });
}

// Dispute rejected: the earning goes back where it came from.
async function unfreezeSale(db, saleId, nowMs = Date.now()) {
  const saleRef = db.collection('creatorSales').doc(saleId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(saleRef);
    if (!snap.exists || snap.data().status !== 'disputed') return { restored: false };
    const sale = snap.data();
    const stillHeld = sale.frozenFrom === 'held' && num(sale.releaseAtMs) > nowMs;
    if (stillHeld) { tx.set(saleRef, { status: 'held' }, { merge: true }); return { restored: true, to: 'held' }; }
    tx.set(saleRef, { status: 'available', releasedAtMs: nowMs }, { merge: true });
    tx.set(db.collection('creatorPrivate').doc(sale.creatorId), {
      balancePending: FieldValue.increment(-num(sale.creatorEarning)),
      balanceAvailable: FieldValue.increment(num(sale.creatorEarning)),
    }, { merge: true });
    return { restored: true, to: 'available' };
  });
}

// Dispute upheld: the creator's earning for the order is reversed. (The buyer's
// refund itself is paid by the admin outside the app.)
async function refundSale(db, saleId, nowMs = Date.now()) {
  const saleRef = db.collection('creatorSales').doc(saleId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(saleRef);
    if (!snap.exists) return { refunded: false, reason: 'NO_SALE' };
    const sale = snap.data();
    if (sale.status === 'refunded') return { refunded: true, already: true };
    const earning = num(sale.creatorEarning);
    const pending = sale.status === 'held' || sale.status === 'disputed';
    tx.set(saleRef, { status: 'refunded', refundedAtMs: nowMs }, { merge: true });
    tx.set(db.collection('creatorPrivate').doc(sale.creatorId), pending ? {
      balancePending: FieldValue.increment(-earning),
      totalEarned: FieldValue.increment(-earning),
    } : {
      balanceAvailable: FieldValue.increment(-earning),
      totalEarned: FieldValue.increment(-earning),
    }, { merge: true });
    return { refunded: true, earning: round2(earning), creatorId: sale.creatorId };
  });
}

module.exports = { getHoldDays, releaseSale, releaseDueHolds, freezeSale, unfreezeSale, refundSale, MAX_HOLD_DAYS, splitByFeePct, DEFAULT_PLATFORM_FEE_PCT, attributeCreatorEarning, getDb: sharedGetDb };
