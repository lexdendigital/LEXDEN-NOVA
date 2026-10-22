# LEXDEN NOVA CREATOR — FEES, LEDGER & PAYOUT POLICY

**Version:** 1.0-draft  
**Effective date:** [EFFECTIVE DATE]

## 1. Financial truth

The server-side financial ledger is authoritative. Browser-submitted balances, commission figures and payment messages are not authoritative.

## 2. Fees

NOVA may impose configurable Creator, Affiliate, transaction, withdrawal, payment-processing or other applicable fees.

**Current configured fees** (values are generated from NOVA's server configuration when this page is built, so they cannot drift from what the system actually charges):

- **Creator commission: {{CREATOR_FEE_PCT}}%** of the eligible sale subtotal (the price of the item after any item discount, excluding delivery and tax). It is calculated in whole kobo and the rate used is stored with each sale.
- **Affiliate withdrawal fee: {{AFFILIATE_WITHDRAWAL_FEE_PCT}}%** of the gross amount an affiliate asks to withdraw. It applies to affiliate withdrawals only and is shown before the request is submitted.
- **Creator withdrawals** do not carry the affiliate withdrawal fee. Any creator withdrawal fee is shown on the withdrawal screen before the request is submitted.

These rates may change for legitimate commercial, provider, tax, operational or risk reasons. A change applies to future sales and withdrawals only; the rate used is stored on each historical record.

## 3. Payment provider

NOVA may use Paystack or another approved provider. Paystack's current documentation supports subaccounts and transaction splits, including marketplace/vendor settlement patterns. The precise settlement structure must follow the provider's current agreement and capabilities.

## 4. Ledger

The ledger may record sales, refunds, platform fees, affiliate commissions, payment fees, reserve holds/releases, adjustments, payout requests, completions, chargebacks and reversals.

## 5. Balance states

Example operational states:

`PENDING` → `AVAILABLE` → `WITHDRAWAL_REQUESTED` → `UNDER_REVIEW` → `PROCESSING` → `PAID`

Other outcomes may include `FAILED`, `CANCELLED` and `REVERSED`.

## 6. Release controls

Funds may remain pending where there is a buyer-protection period, open dispute, incomplete fulfilment, likely refund exposure, chargeback or reserve requirement.

## 7. Withdrawal

A withdrawal request is a request for settlement, not a guarantee of immediate payment. NOVA may verify identity, payout ownership, account status, reserve exposure and unresolved disputes.

## 8. Reversals and negative balances

Refunds, chargebacks and payout reversals may reduce amounts previously released. To the extent permitted by law and the Creator agreement, NOVA may offset valid amounts owed against future settlements or request repayment.

## 9. No guaranteed settlement rail

NOVA will not promise a specific payout rail until the provider, contract and operational flow have been confirmed.
