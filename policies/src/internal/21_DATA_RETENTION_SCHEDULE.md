# LEXDEN NOVA — INTERNAL DATA RETENTION SCHEDULE

**Status:** Operational baseline; validate against final legal/accounting requirements before production enforcement.

| Record class | Typical examples | Operational target | Notes |
|---|---|---:|---|
| Account | user profile, auth metadata | account life + defined deletion window | Keep minimum security/audit fields as allowed |
| Creator KYC | identity/business/address evidence | shortest lawful period consistent with provider, fraud and legal needs | Restricted access |
| Orders | order, payment ref, fulfillment | legally/operationally required period | Financial truth must be immutable/auditable |
| Refunds/disputes | claims, evidence, decisions | through dispute + applicable record period | Preserve policy snapshot |
| Payouts/ledger | settlements, withdrawals, reversals | applicable financial/accounting period | Never rely on browser copy |
| Delivery | tracking, POD, delivery evidence | transaction lifecycle + dispute window | Minimize precise location retention |
| Digital entitlements | downloads/access | account/entitlement life + dispute needs | Keep access audit events as necessary |
| Support | tickets, emails, complaints | support lifecycle + legal/dispute period | Remove unnecessary sensitive content |
| Reviews/content moderation | reports, flags, actions | while enforcement/dispute need exists | Protect reporter privacy |
| AI audit | approved action, tool call, result | risk/compliance-defined period | Avoid storing unnecessary prompt data |
| Security logs | auth/security events | security-defined period | Restrict staff access |

## Rules

1. Legal retention requirements override operational targets.
2. Delete/anonymize data when the retention purpose ends, unless another lawful purpose applies.
3. Avoid retaining complete KYC documents merely because a user once had a Creator account.
4. Policy/version snapshots that explain historical transactions should be preserved even when public policy text later changes.
