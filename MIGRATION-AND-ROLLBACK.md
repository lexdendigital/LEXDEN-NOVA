# Migration and rollback

All changes are additive. No existing collection is rewritten, no balance is edited.

## Before deploy
1. Export Firestore (console backup) and keep the previous Render deploy available.
2. Run the dry run (changes nothing): `node scripts/migrate-upgrade.js` (needs Firebase admin env). It reports listings missing numeric stock, legacy `available` physical sales, sales without a fee snapshot, open recovery exceptions and orders awaiting supplier funding.
3. Fix the "missing numeric stock" listings or accept that they show OUT OF STOCK.
4. Set env (see DEPLOYMENT-CHECKLIST.md). Leave all feature flags at their defaults.

## Deploy
1. Deploy backend. 2. `node scripts/migrate-upgrade.js --apply` (creates stock pools from the stock each seller typed; idempotent). 3. `npm run build:policies` and publish `legal/` with the site. 4. Publish Firestore rules (`firestore.rules`). No new composite index is needed (every new query is equality-only).

## What changes for existing data
- New sales get a fee snapshot (10%); old sales keep what they were credited.
- Old sales with no `releaseGate` are treated as before.
- New collections: `inventoryItems`, `inventoryMovements`, `inventoryReservations`, `channelListings`, `refunds`, `orderExceptions`, `ledgerExceptions`, `deliveryCodes`, `riderTasks`, `pickupStations`, `policyAcceptances`.

## Rollback
- Redeploy the previous backend build and the previous site. New collections can stay; the old code ignores them.
- Stock: pools hold the live quantity. If you roll back, the old code reads `publishedSnapshot.stock`, which the new code does **not** decrement. Before rolling back, copy current `onHand` back to each listing (script left to you: one write per pool) or accept stale stock.
- Fee: sales already recorded at 10% stay at 10%; they are not recalculated.
- Refunds recorded in `refunds` have no old-code equivalent; finish them manually in the Paystack dashboard.
- Never delete `inventoryMovements` or `refunds`; they are the audit trail.
