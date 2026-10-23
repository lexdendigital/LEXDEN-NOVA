#!/usr/bin/env node
// scripts/migrate-upgrade.js  — additive, idempotent, DRY-RUN BY DEFAULT.
//   node scripts/migrate-upgrade.js                 report only (changes nothing)
//   node scripts/migrate-upgrade.js --apply         seed stock pools for published own-stock listings
// It NEVER edits balances, sales, withdrawals or orders. Anything money-related is only REPORTED for a person
// to decide (see MIGRATION-AND-ROLLBACK.md). Safe to run repeatedly.
const inv = require('../api/inventory/service');

async function run(db, { apply = false, nowMs = Date.now() } = {}) {
  const report = { dryRun: !apply, listingsOwnStock: 0, listingsMissingNumericStock: [], stockPoolsSeeded: 0, legacyAvailablePhysicalSales: [], salesWithoutFeeSnapshot: 0, openRecoveryExceptions: 0, ordersAwaitingSupplierFunding: 0 };
  const ps = await db.collection('products').where('status', '==', 'PUBLISHED').limit(5000).get();
  const creators = new Set();
  for (const d of ps.docs) {
    const p = d.data();
    if (!inv.usesUnitStock({ publishedSnapshot: p.publishedSnapshot })) continue;
    report.listingsOwnStock += 1; creators.add(p.creatorId);
    const st = p.publishedSnapshot && p.publishedSnapshot.stock;
    if (!(Number.isInteger(st) && st >= 0)) report.listingsMissingNumericStock.push({ productId: d.id, creatorId: p.creatorId, note: 'Will show OUT OF STOCK until the seller sets a stock number.' });
  }
  if (apply) {
    for (const cid of creators) {
      const before = (await db.collection('inventoryItems').where('creatorId', '==', cid).limit(1000).get()).size;
      await inv.ensureItemsForCreator(db, cid, nowMs);
      const after = (await db.collection('inventoryItems').where('creatorId', '==', cid).limit(1000).get()).size;
      report.stockPoolsSeeded += Math.max(0, after - before);
    }
  }
  const sales = await db.collection('creatorSales').limit(5000).get();
  for (const d of sales.docs) {
    const s = d.data();
    if (!s.feeSnapshot) report.salesWithoutFeeSnapshot += 1;
    if (s.status === 'available' && s.offeringType === 'PHYSICAL_PRODUCT' && !s.releaseGate && !s.deliveredAtMs) report.legacyAvailablePhysicalSales.push({ orderId: d.id, creatorId: s.creatorId, amount: s.creatorEarning, note: 'Released under the old rules (no delivery gate). NOT changed; decide manually.' });
  }
  report.openRecoveryExceptions = (await db.collection('ledgerExceptions').where('status', '==', 'OPEN').limit(1000).get()).size;
  report.ordersAwaitingSupplierFunding = (await db.collection('supplierOrders').where('status', '==', 'FUNDING_BLOCKED').limit(1000).get()).size;
  return report;
}

module.exports = { run };
if (require.main === module) {
  (async () => {
    const apply = process.argv.includes('--apply');
    const { getDb } = require('../api/affiliate/shared');
    const r = await run(getDb(), { apply });
    console.log(JSON.stringify(r, null, 2));
    console.log(apply ? '\nApplied (additive only).' : '\nDRY RUN: nothing was changed. Re-run with --apply to seed stock pools.');
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
