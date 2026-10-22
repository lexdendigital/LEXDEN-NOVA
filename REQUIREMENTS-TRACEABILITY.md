# Requirements traceability

Status: DONE-UNIT (implemented, unit-tested) · DONE-MOCK · PARTIAL · NOT DONE. No row is SANDBOX or PROD verified.

| # | Requirement | Code | Tests | Status |
|---|---|---|---|---|
| 1 | 10% creator commission, integer kobo, snapshot | `api/core/money.js`, `config.js`, `creator/ledger.js` | core-money, ledger, ledger-gates | DONE-UNIT |
| 2 | 5% affiliate withdrawal fee, preview, snapshot, not on creators | `affiliate/withdraw.js`, `creator-withdraw.js` | core-money, ledger-gates | DONE-UNIT (fee wiring not independently reviewed) |
| 3 | Physical disputes 14 days after confirmed delivery | `creator-disputes.js`, `core/config.js` | disputes-refunds | DONE-UNIT |
| 4 | Per-category policy snapshot (digital/service) | `core/config.js`, ledger sale doc | disputes-refunds | DONE-UNIT |
| 5 | Authoritative delivery evidence only | `core/config.js`, `creator/fulfillment.js`, `ledger.markDelivered` | ledger-gates, review-fixes | DONE-UNIT |
| 6 | Refund lifecycle, completed only on provider confirmation | `core/refunds.js`, `creator-admin-refunds.js`, `paystack-webhook.js` | disputes-refunds, review-fixes | DONE-UNIT / DONE-MOCK |
| 7 | No 30%/70% deductions | `core/refunds.js` | disputes-refunds | DONE-UNIT |
| 8 | Append-only ledger / withdrawal safety | `creator/ledger.js`, `automation/logic.js` | ledger, ledger-gates | DONE-UNIT |
| 9 | Server-authoritative checkout (exact amount, active seller, replay-safe) | `creator/checkout.js`, `verify-paystack.js` | checkout, review-fixes | DONE-UNIT (handler itself not end-to-end tested) |
| 10 | Inventory: atomic reservation, movements, variants, locations | `inventory/*`, `creator-checkout.js`, `creator-inventory.js` | inventory, inventory-endpoints | DONE-UNIT |
| 11 | CSV import, channel mapping, honest sync | `inventory/service.js` | inventory | DONE-UNIT (no adapter => no sync) |
| 12 | No numeric stock => out of stock | `inventory/service.js`, `creator-listings.js` | inventory | DONE-UNIT |
| 13 | CJ funding fail-safe | `supplier/funding.js`, `supplier/orders.js` | supplier-orders | DONE-MOCK |
| 14 | Delivery proof code, rider vault, authorised recipient | `delivery/proof.js`, `delivery-proof.js` | delivery-proof | DONE-UNIT (server only) |
| 15 | Pickup stations | `delivery/stations.js` | stations | PARTIAL |
| 16 | Admin application review + MCP/AI authorization audit | `mcp/lib/risk.js`, `mcp/tools/*` | creator-mcp | DONE-UNIT (review; existing gate retained) |
| 17 | Creator nav Home·Products·Orders·Store·Earnings; Inventory Hub; earnings view | `creator/creator.js`, `creator-earnings.js` | syntax check only | PARTIAL (no browser test) |
| 18 | Documents & Policies Centre, versioning, acceptance, DRAFT banner | `scripts/build-policies.js`, `policies/`, `policy-accept.js`, `policy-internal.js` | policies | DONE-UNIT |
| 19 | Replace Google-search legal links | `js/shopper.js` | policies | DONE-UNIT |
| 20 | "Escrow" wording removed, 72h removed | `sla.js`, READMEs, FAQ copy | sla | DONE |
| 21 | Firestore rules for new collections | `firestore.rules` | none (rules not run in emulator) | UNVERIFIED |
| 22 | Migration dry-run | `scripts/migrate-upgrade.js` | migrate | DONE-UNIT |
| 23 | Optional creator updates feed | — | — | NOT DONE |
| 24 | Required docs + clean source zip | this folder | — | DONE |
