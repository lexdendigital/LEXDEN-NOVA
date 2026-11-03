// /api/affiliate/commissions.js
//
// Commission lifecycle helpers shared by verify-paystack.js (creates commissions),
// release.js (frees them), core/refunds.js (cancels them on refund) and withdraw.js.
//
//   pending  --(after the hold period)--> available --(withdrawn by the affiliate)--> paid out
//   pending/available --(order refunded)--> reversed (or reduced, for a partial refund)
//
// Why a hold: buyers have a 7-day refund window, so a commission is RESERVED for 8 days
// (one day longer than the window) and only then counted as withdrawable. A refund inside
// the window therefore never has to claw money back out of a payout.
//
// Money fields on affiliates/{uid}: balancePending (reserved), balanceAvailable (withdrawable),
// totalEarned (reserved + available + already withdrawn), totalWithdrawn.
//
// Every function takes the Firestore handle explicitly so it can be tested with a fake.

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HOLD_DAYS = 8; // refund window is 7 days; hold one day longer
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

// content.affiliateHoldDays overrides the default. 0 = no hold (old behaviour).
function holdDays(content) {
  const raw = content && content.affiliateHoldDays;
  if (raw === null || raw === undefined || raw === '') return DEFAULT_HOLD_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 90) : DEFAULT_HOLD_DAYS;
}

function isAlreadyExists(e) {
  return !!e && (e.code === 6 || /ALREADY_EXISTS/i.test(String(e.message)));
}

/**
 * Moves every commission whose hold has ended from pending -> available.
 * affiliateId = release only that affiliate's commissions (used by their own dashboard and
 * by the withdrawal request); omit it for the all-affiliates sweep.
 * Safe to run any number of times: each commission is re-checked inside its own transaction.
 */
async function releaseDue(db, { affiliateId = null, nowMs = Date.now(), limit = 500 } = {}) {
  const { FieldValue } = require('./shared');
  // Equality-only query => no composite index needed; the due-date test happens in memory.
  let q = db.collection('affiliateCommissions').where('status', '==', 'pending');
  if (affiliateId) q = q.where('affiliateId', '==', affiliateId);
  const snap = await q.limit(limit).get();
  let released = 0;
  let amount = 0;
  for (const d of snap.docs) {
    if (!(Number(d.data().releaseAtMs) <= nowMs)) continue; // still reserved
    const got = await db.runTransaction(async (tx) => {
      const cs = await tx.get(d.ref);
      if (!cs.exists || cs.data().status !== 'pending') return 0; // someone else already moved it
      const c = cs.data();
      const amt = Number(c.commissionAmount) || 0;
      tx.update(d.ref, { status: 'available', releasedAtMs: nowMs });
      tx.update(db.collection('affiliates').doc(c.affiliateId), {
        balancePending: FieldValue.increment(-amt),
        balanceAvailable: FieldValue.increment(amt),
      });
      return amt;
    });
    if (got > 0) { released += 1; amount = round2(amount + got); }
  }
  return { released, amount };
}

/**
 * Called when a refund is COMPLETED. Cancels (or, for a partial refund, reduces) the commission
 * earned on that order. Idempotent per refund id. Never throws for "nothing to do".
 */
async function reverseForRefund(db, refund, { nowMs = Date.now() } = {}) {
  if (!refund) return { reversed: 0, amount: 0 };
  const { FieldValue } = require('./shared');
  const ids = [...new Set([refund.paymentReference, refund.orderId].filter(Boolean).map(String))].filter((id) => !id.includes('/'));
  const paid = Number(refund.paidMinor);
  const refunded = Number(refund.amountMinor);
  const ratio = paid > 0 && refunded > 0 ? Math.min(1, refunded / paid) : 1;
  const full = ratio >= 0.99;
  let reversed = 0;
  let total = 0;

  for (const id of ids) {
    const cRef = db.collection('affiliateCommissions').doc(id);
    const out = await db.runTransaction(async (tx) => {
      const cs = await tx.get(cRef);
      if (!cs.exists) return null;
      const c = cs.data();
      if (c.status !== 'pending' && c.status !== 'available') return null; // reversed / needs_review: nothing to take back
      const seen = Array.isArray(c.refundIds) ? c.refundIds : [];
      if (refund.id && seen.includes(refund.id)) return null; // replay of the same refund
      const aRef = db.collection('affiliates').doc(c.affiliateId);
      const as = await tx.get(aRef);
      const current = Number(c.commissionAmount) || 0;
      const original = current + (Number(c.reversedAmount) || 0);
      const cut = full ? current : Math.min(current, round2(original * ratio));
      if (cut <= 0) return null;

      tx.update(cRef, {
        ...(full ? { status: 'reversed', reversedAtMs: nowMs, reversedReason: 'REFUND' } : { commissionAmount: round2(current - cut) }),
        reversedAmount: round2((Number(c.reversedAmount) || 0) + cut),
        refundIds: [...seen, refund.id].filter(Boolean),
      });
      if (as.exists) {
        tx.update(aRef, {
          [c.status === 'pending' ? 'balancePending' : 'balanceAvailable']: FieldValue.increment(-cut),
          totalEarned: FieldValue.increment(-cut),
        });
      }
      tx.set(db.collection('affiliateLeaderboard').doc(c.affiliateId), {
        totalEarned: FieldValue.increment(-cut), ...(full ? { salesCount: FieldValue.increment(-1) } : {}),
      }, { merge: true });
      if (c.dailyKey) {
        tx.set(db.collection('affiliateDailyStats').doc(c.dailyKey), {
          earnings: FieldValue.increment(-cut), ...(full ? { sales: FieldValue.increment(-1) } : {}),
        }, { merge: true });
      }
      if (full && c.linkKey) {
        tx.set(db.collection('affiliateLinkStats').doc(c.linkKey), { sales: FieldValue.increment(-1) }, { merge: true });
      }
      const balanceAfter = (Number(as.exists && as.data().balanceAvailable) || 0) - cut;
      return { cut, affiliateId: c.affiliateId, wasAvailable: c.status === 'available', negative: c.status === 'available' && balanceAfter < 0 };
    });
    if (!out) continue;
    reversed += 1;
    total = round2(total + out.cut);
    if (out.wasAvailable) {
      // The money had already been released, so it may already have been withdrawn: tell the admin.
      await db.collection('affiliateFlags').add({
        type: 'COMMISSION_REVERSED_AFTER_RELEASE', reason: out.negative ? 'BALANCE_NOW_NEGATIVE' : 'BALANCE_REDUCED',
        reference: id, refundId: refund.id || null, affiliateId: out.affiliateId, amount: out.cut, createdAtMs: nowMs,
      }).catch(() => {});
    }
  }
  return { reversed, amount: total };
}

module.exports = { DAY_MS, DEFAULT_HOLD_DAYS, holdDays, releaseDue, reverseForRefund, isAlreadyExists, round2 };
