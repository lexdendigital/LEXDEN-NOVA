// /api/affiliate/signup.js
//
// FIX (mega-fix batch #2): replaces the old client-direct Firestore
// write in affiliate/index.html's submitOnboarding(). That write had to
// exactly match whatever firestore.rules happened to be PUBLISHED live
// in Firebase Console at the time — and rules are published separately
// from every code deploy, so the two silently drifting out of sync was
// the single most likely cause of "signup never works." Routing signup
// through the Admin SDK here removes that whole failure category: this
// server-side write always bypasses security rules entirely, so there
// is nothing left to drift out of sync.
//
// Per your request: every signup is auto-approved (status:'active')
// UNLESS a concrete, named reason stops it — in which case the request
// is still saved (never silently dropped) as status:'pending' with
// `autoApprove:{ok:false, reason, detail}` attached, so it surfaces in
// Admin -> Affiliate Program's "Needs Attention" list instead of
// vanishing. Two such reasons are checked for right now:
//   - DUPLICATE_PAYOUT_ACCOUNT: this exact bank+account number is
//     already attached to a different affiliate — the most common real
//     fraud pattern (one person running multiple affiliate accounts to
//     multiply referral bonuses), so it gets a human look before money
//     moves, instead of being silently allowed or silently blocked.
//   - WRITE_FAILED: the Firestore write itself threw (quota, transient
//     fault, etc.) on the first attempt — retried once as 'pending'
//     rather than the signup just failing with nothing saved.
//
// POST /api/affiliate-signup   Authorization: Bearer <Firebase ID token>
// body: { displayName, whatsapp, payoutAccount:{bank,bankCode,accountNumber,accountName,needsManualVerification}, targetReach }

const { getAuthAdmin, getDb, isAdminEmail, FieldValue } = require('./shared');
const { queueEmailBackground } = require('../email-shared');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', error: 'Use POST.' });

  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) return res.status(401).json({ ok: false, code: 'NOT_SIGNED_IN', error: 'Sign in first.' });

  let decoded;
  try {
    decoded = await getAuthAdmin().verifyIdToken(idToken);
  } catch (e) {
    return res.status(401).json({ ok: false, code: 'BAD_TOKEN', error: 'Your sign-in expired — sign in again.' });
  }
  const uid = decoded.uid;
  const email = decoded.email || '';

  const body = req.body || {};
  const displayName = String(body.displayName || '').trim();
  const whatsapp = String(body.whatsapp || '').trim();
  const targetReach = String(body.targetReach || '').trim();
  const payoutAccount = body.payoutAccount || {};
  const bank = String(payoutAccount.bank || '').trim();
  const accountNumber = String(payoutAccount.accountNumber || '').replace(/\D/g, '');
  const accountName = String(payoutAccount.accountName || '').trim();

  if (!displayName || !whatsapp || !bank || !accountNumber || !accountName) {
    return res.status(400).json({ ok: false, code: 'BAD_INPUT', error: 'Please fill in every field.' });
  }
  if (accountNumber.length !== 10) {
    return res.status(400).json({ ok: false, code: 'BAD_ACCOUNT_NUMBER', error: 'Account number must be exactly 10 digits.' });
  }

  const db = getDb();
  let effectiveEmail = email;
  if (!effectiveEmail) {
    try { const u = await db.collection('users').doc(uid).get(); effectiveEmail = String((u.exists && u.data().email) || '').trim(); } catch (e) { /* non-fatal */ }
  }

  // Already an affiliate? Don't clobber an existing record.
  const existing = await db.collection('affiliates').doc(uid).get();
  if (existing.exists) {
    return res.status(200).json({ ok: true, status: existing.data().status, alreadyExisted: true });
  }

  // FIX: DUPLICATE_PAYOUT_ACCOUNT check — the one concrete, named reason
  // auto-approval is deliberately withheld for.
  let autoApprove = { ok: true };
  try {
    // Match on the account NUMBER alone: a manually typed bank has an empty bankCode, and
    // spelling variants of a bank name must not let the same account through.
    const dupeSnap = await db.collection('affiliates')
      .where('payoutAccount.accountNumber', '==', accountNumber)
      .limit(5)
      .get();
    const other = dupeSnap.docs.find((d) => d.id !== uid);
    if (other) {
      autoApprove = { ok: false, reason: 'DUPLICATE_PAYOUT_ACCOUNT', detail: `Same account number already registered to affiliate ${other.id}.` };
    }
  } catch (e) {
    console.error('affiliate-signup dupe check failed (non-fatal):', e.message);
  }
  if (autoApprove.ok && payoutAccount.needsManualVerification) {
    autoApprove = { ok: false, reason: 'UNVERIFIED_PAYOUT_ACCOUNT', detail: 'Bank account could not be auto-verified; admin must check the name before approval.' };
  }
  if (autoApprove.ok && !effectiveEmail) {
    autoApprove = { ok: false, reason: 'MISSING_EMAIL', detail: 'No email on the account, so payout notices cannot be delivered.' };
  }

  const baseDoc = {
    displayName, email: effectiveEmail, whatsapp,
    payoutAccount: { bank, bankCode: payoutAccount.bankCode || '', accountNumber, accountName, needsManualVerification: !!payoutAccount.needsManualVerification },
    targetReach,
    balanceAvailable: 0, totalEarned: 0, totalWithdrawn: 0,
    createdAt: FieldValue.serverTimestamp(),
  };

  try {
    const status = autoApprove.ok ? 'active' : 'pending';
    const doc = { ...baseDoc, status, autoApprove };
    if (status === 'active') doc.approvedAt = FieldValue.serverTimestamp();
    await db.collection('affiliates').doc(uid).set(doc);
    if (effectiveEmail) queueEmailBackground({
      templateKey: 'affiliate_welcome_status',
      to: { email: effectiveEmail, name: displayName },
      params: {
        FIRSTNAME: displayName.split(' ')[0] || undefined,
        status,
        affiliate_url: 'https://lexdendigital.github.io/LEXDEN-NOVA/affiliate/'
      }
    });
    return res.status(200).json({ ok: true, status, reason: autoApprove.ok ? null : autoApprove.reason });
  } catch (e) {
    console.error('affiliate-signup write failed, retrying as pending:', e.message);
    try {
      // FIX: WRITE_FAILED fallback — the request is still captured
      // instead of the person's submission just disappearing.
      await db.collection('affiliates').doc(uid).set({
        ...baseDoc, status: 'pending',
        autoApprove: { ok: false, reason: 'WRITE_FAILED', detail: e.message },
      });
      if (effectiveEmail) queueEmailBackground({
        templateKey: 'affiliate_welcome_status',
        to: { email: effectiveEmail, name: displayName },
        params: {
          FIRSTNAME: displayName.split(' ')[0] || undefined,
          status: 'pending',
          affiliate_url: 'https://lexdendigital.github.io/LEXDEN-NOVA/affiliate/'
        }
      });
      return res.status(200).json({ ok: true, status: 'pending', reason: 'WRITE_FAILED' });
    } catch (e2) {
      console.error('affiliate-signup pending fallback ALSO failed:', e2.message);
      return res.status(502).json({ ok: false, code: 'SIGNUP_WRITE_FAILED', error: 'Could not save your application — try again shortly.' });
    }
  }
};
