# Conflict and decision register

Decisions I made (reversible) and decisions that are yours.

| # | Conflict / question | What I did | Needs you? |
|---|---|---|---|
| 1 | Old admin keys `creatorPlatformFeePct` (15) and `affiliateWithdrawalFeePct` (2.5) vs the approved 10% / 5% | Ignored the old keys. New admin keys are `creatorCommissionBps` / `affiliateWithdrawalFeeBps`. Creator profile screen previously showed 15% by default; fixed. | Confirm 10% / 5% are final. |
| 2 | Creator withdrawal fee (2.5%) is not one of the approved fees | Left at 2.5%, kept separate from the affiliate fee, snapshotted. | **Yes: keep, change, or remove.** |
| 3 | Listings with no numeric stock were treated as unlimited | Now OUT OF STOCK until the seller sets a number. Migration report lists them. | Tell sellers before go-live. |
| 4 | Balances stored in major units (float increments) | Not migrated (touching live money records). Reconciliation tolerance covers drift. | Later project. |
| 5 | Existing physical sales already `available` (released under the old rules) | Not changed. Reported by `migrate-upgrade.js`. | Decide per sale. |
| 6 | Dispute after the creator already withdrew | Sale frozen without a negative balance; recovery exception raised; offset policy not automated. | Decide recovery/offset policy with legal advice. |
| 7 | Legacy admin-curated catalogue keeps the old 2% amount tolerance | Left unchanged; only creator products are exact-checked. | Optional. |
| 8 | Digital/service dispute windows (14 days from purchase) | Placeholder policy values, snapshotted per sale, flagged for review. | Confirm values. |
| 9 | Policy pack says "5% creator / 2.5% affiliate" (initial concept) | Rewritten to generated values (10% / 5%). | Legal review of all text. |
| 10 | Spec URLs `/creator/terms` collide with the creator app folder `creator/` | Creator documents live at `legal/creator-*.html`. | Accept. |
| 11 | Static site cannot read env at runtime | The DRAFT banner is decided when `npm run build:policies` runs (`POLICY_PUBLICATION_APPROVED=true` removes it, and the build refuses while placeholders remain). | Accept. |
| 12 | `exceptionOpen` on non-physical sale with `releaseGate: NONE` | May stay held after resolution; admin must release manually. | Low priority. |
| 13 | Paystack refund API | Off by default; manual dashboard step is tracked. | Enable only after sandbox test. |
| 14 | FAQ / NOVA AI copy said NOVA is only a showcase and refunds are seller-only | Reworded to match the marketplace model; points to the draft policy. | Legal review. |
