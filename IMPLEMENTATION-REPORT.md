# LEXDEN NOVA upgrade — IMPLEMENTATION REPORT

Baseline: `LEXDEN-NOVA-CREATOR-FINAL` (the zip supplied on 2026-10-18). Prompt implemented: `LEXDEN_NOVA_MASTER_IMPLEMENTATION_PROMPT_CLAUDE_SONNET_5_5.md` v1.0.
Merged: the four product-listing commits you pushed on 2026-10-19 (`4735620`, `28f24fe`, `c11ba4f`, `ff8c59d`: structured listing fields, SEO/FAQ metadata).

**Evidence labels used everywhere:** `UNIT` = unit-tested against an in-memory Firestore double · `MOCK` = tested against a mocked provider · `SANDBOX` = run against a provider sandbox · `PROD` = verified in production · `UNVERIFIED` = not run.
Nothing below is `SANDBOX` or `PROD`. No staging run has happened. See STAGING-SMOKE-TEST-CHECKLIST.md.

## Complete (UNIT)

| Area | What exists |
|---|---|
| Fees | 10% creator commission on the eligible subtotal in integer kobo (BigInt, half-up), snapshot stored on each sale. 5% affiliate withdrawal fee on the gross request, shown before submitting (`GET /api/affiliate-withdraw?amount=`), snapshot stored. Never applied to creator withdrawals. `api/core/money.js`, `api/core/config.js`. |
| Disputes | 14 days after **confirmed** delivery for physical orders. Digital/service categories carry a per-category policy snapshot. Only authoritative evidence (carrier, buyer, buyer code, recipient code, admin) starts the clock; creator-reported and rider-entered do not. |
| Ledger | Delivery-gated release, freeze/unfreeze, refund reversal, dispute-after-withdrawal handled without negative balance (`fundsAlreadyWithdrawn`, `recoveryDue`), reconciliation updated. |
| Refunds | Lifecycle REQUESTED → APPROVED → PROVIDER_INITIATED → PROCESSING → COMPLETED/FAILED/REQUIRES_REVIEW. "Completed" only after provider confirmation. No automatic 30%/70% deductions; any deduction is a reviewed record. Webhook `refund.*` events matched to exactly one refund. |
| Checkout | Exact-amount match in kobo for creator products (2% tolerance removed for them), product PUBLISHED + seller ACTIVE at payment time, replay-safe, order exceptions (`orderExceptions`) instead of silent fulfilment. |
| Inventory | Atomic reserve → consume once → release; movements are immutable and idempotent; variants/locations; safety stock; quick actions with attribution; return-to-stock needs resellable confirmation; CSV preview/commit; channel mapping by SKU/GTIN only; honest sync health. Listings with no numeric stock are OUT of stock. Reservation expiry job. |
| CJ funding | `CJ_FUNDING_MODE` default `DISABLED`: no CJ call, order held, operator-visible exception. `CREATOR_ACCOUNT` is an explicit opt-in with truthful `paymentState`. `NOVA_FUNDED` fails safe (not implemented). |
| Delivery proof | 6-char code (no O/0/I/1), HMAC-stored, ~10 min, single use, 5 attempts then LOCKED, rider task token bound to one order, authorised-recipient path, problem-report path. Code appears only in the buyer's own response. |
| Documents & Policies Centre | 20 first-party static pages generated from `policies/src` with fee/window values taken from config; DRAFT / REVIEW REQUIRED banner until `POLICY_PUBLICATION_APPROVED`; internal procedures served only via admin API; versioned acceptance records; Google-search links removed. |
| UI | Creator nav Home · Products · Orders · Store · Earnings; Inventory Hub; earnings breakdown (pending/available/reserved/paid/disputed/reversed); shopper reserves stock before Paystack and sends the reservation. |
| AI/MCP | Reviewed. Existing gate (`mcp/lib/risk.js`) already blocks AI execution of payouts, withdrawals, dispute decisions, application/listing approvals, source edits; schemas and audit log present. Added the new listing fields to the admin product schema. No inventory/refund tools exist for AI. |
| Security hardening | Firestore rules for new collections (no public reads of private data; writes server-only). |

## Partial or blocked

Built on 2026-10-22 (UNIT-tested, UI not browser-tested): pickup stations (`/api/pickup-stations`, admin review tab, shopper `#pickup` page; not selectable at checkout yet), rider link page (`rider/index.html`, admin "Rider links" tab, buyer "Get delivery code" buttons), NOVA-funded CJ via per-order admin attestation (`/api/creator-admin-funding`, not verified with CJ), creator updates feed (`/api/creator-updates`, creator Store tab, public seller page), admin screens for order problems and refunds.

Still not possible or not done:
- **Channel sync:** needs a real marketplace API account and credentials. Stays off.
- **Paystack refund API:** code exists (MOCK). Switch on with `PAYSTACK_REFUNDS_ENABLED=true` only after a Paystack test-mode refund works.
- **Checkout station choice:** buyers cannot yet choose a pickup station when paying.

## Open items (known, not hidden)

1. Review finding 9: the dispute window anchors on the fulfilment's confirmation time while release anchors on the sale's *first* authoritative evidence. If carrier and buyer confirmation differ, release can precede the end of the dispute window. Mitigated only because both default to 14 days.
2. Review finding 6: creator earning credit and fulfilment after payment are non-fatal; if the process dies and no webhook follows, an order can exist without a credit. The webhook retry mitigates.
3. The reviewer did **not** review `creator-withdraw.js` or `affiliate/withdraw.js` (fee wiring is covered by unit tests only) and did not check the tests for vacuity beyond one case I fixed.
4. Balances are still stored in major units with `FieldValue.increment` (float drift tolerated by reconciliation).
5. Creator withdrawal fee remains 2.5% (not one of the approved fees). Needs your decision.
6. Sources: Paystack refund docs checked 2026-10-18. CJ, Firebase, FCCPC, NDPC are **UNVERIFIED** (see `policies/src/implementation/RESEARCH_AND_SOURCE_REGISTER.md`).
