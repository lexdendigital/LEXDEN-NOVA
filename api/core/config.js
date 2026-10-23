// api/core/config.js
//
// ONE place for the product decisions that money, disputes and fulfilment code
// must agree on (IMPLEMENTATION PROMPT Part I). Everything here is server-side;
// the browser may DISPLAY these values (via /api/creator-profile or the policy
// build) but can never supply them.
//
// Admin-editable overrides live in catalog/settings.content under NEW key names
// (creatorCommissionBps, affiliateWithdrawalFeeBps). The older percentage keys
// (creatorPlatformFeePct 15, affiliateWithdrawalFeePct 2.5) are deliberately
// IGNORED so a stale value saved by an earlier admin screen cannot silently
// override the approved rates. See MIGRATION-AND-ROLLBACK.md.

// ---- Fees (basis points: 100 bps = 1%) -------------------------------------
const CREATOR_COMMISSION_BPS = 1000;        // 10% of the eligible sale subtotal
const AFFILIATE_WITHDRAWAL_FEE_BPS = 500;   // 5% of the requested gross withdrawal
const MAX_FEE_BPS = 5000;                   // sanity ceiling for an admin override
const FEE_BASIS = 'ELIGIBLE_SUBTOTAL_AFTER_ITEM_DISCOUNTS_EXCL_DELIVERY_AND_TAX';
const FEE_CONFIG_VERSION = '2026-10-16.1';

function validBps(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_FEE_BPS;
}

/** Creator-sale commission rate in bps, from admin settings content or the default. */
function resolveCreatorCommissionBps(content) {
  const v = content && content.creatorCommissionBps;
  return validBps(v) ? v : CREATOR_COMMISSION_BPS;
}

/** Affiliate withdrawal fee rate in bps. NEVER used for creator withdrawals. */
function resolveAffiliateWithdrawalFeeBps(content) {
  const v = content && content.affiliateWithdrawalFeeBps;
  return validBps(v) ? v : AFFILIATE_WITHDRAWAL_FEE_BPS;
}

// ---- Dispute / buyer-protection policy -------------------------------------
// 14 calendar days AFTER CONFIRMED DELIVERY for physical orders. Digital goods,
// services, appointments, commissions and custom work are different workflows,
// so each category carries its own anchor; the policy applied is snapshotted on
// the sale/dispute so a later change never rewrites history.
const DISPUTE_POLICY_VERSION = '2026-10-16.1';
const DISPUTE_POLICIES = Object.freeze({
  PHYSICAL: { windowDays: 14, anchor: 'CONFIRMED_DELIVERY' },
  DIGITAL: { windowDays: 14, anchor: 'PURCHASE' },
  SERVICE: { windowDays: 14, anchor: 'PURCHASE' },
});

/** offeringType -> policy category. Unknown types fall to SERVICE (conservative: never "physical"). */
function disputeCategoryFor(offeringType) {
  if (offeringType === 'PHYSICAL_PRODUCT') return 'PHYSICAL';
  if (['EBOOK', 'COURSE', 'TEMPLATE', 'SOFTWARE', 'DIGITAL_FILE', 'DIGITAL_PRODUCT', 'AUDIO', 'VIDEO', 'PRESET', 'DOWNLOADABLE'].includes(offeringType)) return 'DIGITAL';
  return 'SERVICE';
}

function disputePolicySnapshot(offeringType) {
  const category = disputeCategoryFor(offeringType);
  return { version: DISPUTE_POLICY_VERSION, category, ...DISPUTE_POLICIES[category] };
}

// After confirmed delivery, how long a physical sale's earning stays pending
// before it can be released (the buyer-protection window). Defaults to the
// dispute window so the earning cannot move while a dispute can still be opened.
const DEFAULT_PROTECTION_DAYS_AFTER_DELIVERY = DISPUTE_POLICIES.PHYSICAL.windowDays;
const MAX_PROTECTION_DAYS = 60;

function resolveProtectionDays(content) {
  const n = content && Number(content.creatorProtectionDaysAfterDelivery);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), MAX_PROTECTION_DAYS) : DEFAULT_PROTECTION_DAYS_AFTER_DELIVERY;
}

// ---- Delivery evidence ------------------------------------------------------
// Which sources can START the release clock. A creator's own "delivered" claim
// is recorded but is NOT authoritative on its own.
const EVIDENCE_SOURCES = Object.freeze({
  CARRIER: 'CARRIER',                     // courier / CJ tracking says delivered
  BUYER_CONFIRMED: 'BUYER_CONFIRMED',     // buyer pressed "I received it"
  BUYER_CODE: 'BUYER_CODE',               // one-time delivery code entered by rider/creator
  RECIPIENT_CODE: 'RECIPIENT_CODE',       // code given to the buyer-authorised recipient
  ADMIN_VERIFIED: 'ADMIN_VERIFIED',       // admin exception path with evidence recorded
  CREATOR_REPORTED: 'CREATOR_REPORTED',   // creator says delivered (not authoritative)
  RIDER_ENTERED: 'RIDER_ENTERED',         // rider typed something (supports, not proves)
});
const AUTHORITATIVE_EVIDENCE = Object.freeze([
  EVIDENCE_SOURCES.CARRIER, EVIDENCE_SOURCES.BUYER_CONFIRMED, EVIDENCE_SOURCES.BUYER_CODE,
  EVIDENCE_SOURCES.RECIPIENT_CODE, EVIDENCE_SOURCES.ADMIN_VERIFIED,
]);
const isAuthoritativeEvidence = (s) => AUTHORITATIVE_EVIDENCE.includes(s);

// ---- Feature flags (fail-safe: OFF unless the prerequisite is proven) --------
// Read lazily so tests can set process.env per test.
function flags(env = process.env) {
  const on = (k) => String(env[k] || '').toLowerCase() === 'true' || env[k] === '1';
  const fundingMode = String(env.CJ_FUNDING_MODE || 'DISABLED').toUpperCase();
  return {
    // DISABLED (default) | CREATOR_ACCOUNT (legacy: creator pays inside their own CJ account, explicit opt-in)
    // | NOVA_FUNDED (needs an approved route + adapter; not implemented -> fails safe)
    cjFundingMode: ['DISABLED', 'CREATOR_ACCOUNT', 'NOVA_FUNDED'].includes(fundingMode) ? fundingMode : 'DISABLED',
    paystackRefundsEnabled: on('PAYSTACK_REFUNDS_ENABLED'),
    // Public legal pages stay DRAFT/REVIEW REQUIRED until every blocker is closed.
    policyPublicationApproved: on('POLICY_PUBLICATION_APPROVED'),
    connectedChannelSync: on('INVENTORY_CHANNEL_SYNC_ENABLED'),
    pickupStationsEnabled: on('PICKUP_STATIONS_ENABLED'),
    // Rider vault (task-bound delivery code entry) — off until staging smoke test passes.
    riderVaultEnabled: on('RIDER_VAULT_ENABLED'),
  };
}

// ---- Delivery code ----------------------------------------------------------
const DELIVERY_CODE = Object.freeze({
  LENGTH: 6,
  ALPHABET: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', // no O, 0, I, 1
  TTL_MS: 10 * 60 * 1000,                        // ~10 minutes, configurable per call
  MAX_FAILED_ATTEMPTS: 5,
});

// ---- Inventory --------------------------------------------------------------
const RESERVATION_TTL_MS = 15 * 60 * 1000;

module.exports = {
  CREATOR_COMMISSION_BPS, AFFILIATE_WITHDRAWAL_FEE_BPS, MAX_FEE_BPS, FEE_BASIS, FEE_CONFIG_VERSION,
  resolveCreatorCommissionBps, resolveAffiliateWithdrawalFeeBps,
  DISPUTE_POLICY_VERSION, DISPUTE_POLICIES, disputeCategoryFor, disputePolicySnapshot,
  DEFAULT_PROTECTION_DAYS_AFTER_DELIVERY, MAX_PROTECTION_DAYS, resolveProtectionDays,
  EVIDENCE_SOURCES, AUTHORITATIVE_EVIDENCE, isAuthoritativeEvidence,
  flags, DELIVERY_CODE, RESERVATION_TTL_MS,
};
