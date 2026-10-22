# Staging smoke test (Paystack TEST keys, CJ sandbox/test account, separate Firebase project)

Do these in order. Stop at the first failure.

1. **Boot:** server starts; `GET /api/creator-profile` (as creator) shows `platformFeePct: 10`.
2. **Rules:** publish rules to staging; confirm a signed-in creator cannot read another creator's `inventoryItems`, nobody can read `deliveryCodes` / `riderTasks`.
3. **Inventory:** create a physical listing with stock 1. In two browsers press Buy at the same time: exactly one reaches Paystack, the other sees "out of stock".
4. **Abandon:** open Paystack, close it; after ~15 min (or run job `reservations`) stock is available again.
5. **Pay:** complete a TEST payment. Order created, stock 0, fulfilment PENDING, creator sale shows 10% commission.
6. **Exact amount:** change the amount client-side by 1 kobo (dev tools) and pay: order NOT fulfilled, an `orderExceptions` row opens.
7. **Replay:** POST `/api/verify-paystack` twice with the same reference: still one order, stock decremented once.
8. **Suspended seller:** suspend the creator and pay: order held with exception, no fulfilment, no stock consumed.
9. **CJ gate:** with `CJ_FUNDING_MODE` unset, a paid CJ listing makes **no** CJ call and opens `SUPPLIER_FUNDING_UNAVAILABLE`. Then set `CREATOR_ACCOUNT` and confirm the CJ order is created and `paymentState` is honest.
10. **Delivery code:** ship an order, buyer requests a code (6 chars, no O/0/I/1), wrong code x5 locks, re-issue works, right code via rider task token moves to DELIVERED and starts the 14-day clock. Confirm the code never appears in creator/admin/MCP views.
11. **Dispute:** open a dispute inside 14 days after delivery; after 14 days it is refused.
12. **Refund:** request a refund; it shows "approved/processing", never "completed", until Paystack confirms. With `PAYSTACK_REFUNDS_ENABLED` unset, it becomes a tracked manual step.
13. **Webhook:** send a signed `refund.processed` for one of two refunds on the same order: only the matching one completes.
14. **Affiliate:** the withdrawal screen shows 5% fee and net before submit; the stored withdrawal has the snapshot. Creator withdrawal shows no 5% fee.
15. **Legal:** build policies, open `/legal/`; every page shows DRAFT banner; footer links are first-party; no Google links.
16. **Admin:** product form shows the Advanced listing fields; product page renders them; share preview uses SEO title.
17. **Migration:** `node scripts/migrate-upgrade.js` prints a report and changes nothing; `--apply` twice produces the same result.
18. **Roll back drill:** redeploy previous build; site still loads.
