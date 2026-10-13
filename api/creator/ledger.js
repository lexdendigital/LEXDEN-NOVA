// api/creator/ledger.js
//
// LEXDEN NOVA CREATOR — Stage F: money/ledger (the earning side).
// Modeled on the app's proven affiliate-commission pattern
// (verify-paystack.js attributeAffiliateCommission + affiliate/admin.js):
// earnings are "available" immediately; admin approval at WITHDRAWAL time
// is the fraud/refund checkpoint, not a separate hold timer.
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
      status: 'available',
      createdAt: FieldValue.serverTimestamp(),
    });
    // set+merge so a missing creatorPrivate doc is initialised, not a NOT_FOUND.
    tx.set(privRef, {
      balanceAvailable: FieldValue.increment(creatorEarning),
      totalEarned: FieldValue.increment(creatorEarning),
    }, { merge: true });
    return true;
  });
  return { credited, creatorEarning };
}

module.exports = { splitByFeePct, DEFAULT_PLATFORM_FEE_PCT, attributeCreatorEarning, getDb: sharedGetDb };
