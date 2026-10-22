# Test report

Command: `npm test` (`node --test`). Result on the delivered tree: **420 pass, 0 fail**.
Level of evidence: UNIT (in-memory Firestore double, mocked fetch/CJ). **No sandbox or production test has been run.**

New or rewritten test files: core-money 13 · ledger-gates 17 · disputes-refunds 18 · inventory 26 · inventory-endpoints 3 · checkout 6 · delivery-proof 10 · stations 4 · policies 8 · review-fixes 6 · supplier-orders 16 (2 new, others adapted to `CJ_FUNDING_MODE=CREATOR_ACCOUNT`) · ledger 9 (updated 15%→10%) · migrate 2.
Remaining pre-existing files unchanged and passing.

## Not covered by any automated test
- `verify-paystack.js` as a whole handler (only its new helper modules are tested).
- Firestore security rules (no emulator run).
- Browser behaviour of the creator UI, shopper checkout reserve step, affiliate fee preview.
- Real Paystack (refunds, webhooks, signatures with live keys), real CJ, real Brevo.
- Real Firestore transaction contention (the double serialises transactions, which matches Firestore's retry semantics but is not proof).
- `creator-withdraw.js` / `affiliate/withdraw.js` were not independently reviewed.

## Independent review
A separate reviewer read the money paths and found 10 issues; 8 were fixed with regression tests; 2 are logged as open (IMPLEMENTATION-REPORT.md, Open items).

## Known weakness
Several tests were first written with a defect (a vacuous assertion on a non-existent `cj.calls`); that one was found and fixed. Other vacuous assertions may remain.
