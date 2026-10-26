// api/automation/jobs.js
//
// LEXDEN NOVA CREATOR — Stage I: the scheduled jobs. Each job takes
// (db, ctx) and returns a small JSON summary; none throws for an expected
// problem (a failing product never stops the sweep). Everything external is
// injectable through ctx.deps so the jobs run in tests with fakes:
//   deps.fetchImpl / deps.pace   -> CJ (Stage G)
//   deps.resolve / deps.requestOnce -> link checks (ssrf.js)
//   deps.emailFor(uid) / deps.sendEmail(payload) -> optional creator emails
//
// WHAT AUTOMATION MAY DO BY ITSELF (and nothing else):
//   * pause a PUBLISHED listing whose supplier/link broke        (reversible)
//   * pause a seller's physical listings for repeated missed SLAs, ONLY when an admin
//     switched creatorAutoRestrictSla ON (default OFF)           (reversible)
//   * create CJ orders / sync CJ tracking (idempotent, Stage G)
//   * write alerts and notifications
// It NEVER moves money, approves/rejects withdrawals, refunds, or suspends an
// account. Every automatic pause is audited (actorRole 'system') and flagged
// (pausedBySupplier / pausedByLink / pausedBySla) so an admin can tell it apart
// from a creator's own pause and lift it.
const { FieldValue } = require('../creator/shared');
const { PRODUCT_STATES, assertProductTransition } = require('../creator/product-state-machine');
const { evaluateSla, summarizeCreatorSla, toMs } = require('../creator/sla');
const { entitlementId } = require('../creator/entitlements');
const supplierService = require('../supplier/service');
const supplierOrders = require('../supplier/orders');
const store = require('../supplier/store');
const { FULFILLMENT_MODES } = require('../supplier/mapping');
const { checkExternalLink } = require('./ssrf');
const { raiseAlert, resolveAlertByKey, notifyCreator } = require('./alerts');
const L = require('./logic');

const DAY = 86400000;

async function publishedProducts(db) {
  const snap = await db.collection('products').where('status', '==', PRODUCT_STATES.PUBLISHED).limit(500).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// Pause with a reason flag. Idempotent; "not published" means nothing to pause.
async function pauseProduct(db, product, flag, reason) {
  if (!product || product.status !== PRODUCT_STATES.PUBLISHED) return false;
  assertProductTransition(PRODUCT_STATES.PUBLISHED, PRODUCT_STATES.PAUSED);
  await db.collection('products').doc(product.id).set({
    status: PRODUCT_STATES.PAUSED, [flag]: true, pauseReason: String(reason).slice(0, 300), updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  await store.writeProductAudit(db, { actorUid: null, actorRole: 'system', action: `product.auto_paused_${flag.replace(/^pausedBy/, '').toLowerCase()}`, productId: product.id, reason });
  return true;
}

// Optional email for a NEW notification only. Needs BREVO_TPL_CREATOR_SLA set,
// otherwise it is silently skipped (no template = no email, never an error).
async function maybeEmail(ctx, creatorId, params) {
  try {
    if (!process.env.BREVO_TPL_CREATOR_SLA && !(ctx.deps && ctx.deps.sendEmail)) return false;
    const emailFor = (ctx.deps && ctx.deps.emailFor) || (async (uid) => {
      const { getAuthAdmin } = require('../creator/shared');
      return (await getAuthAdmin().getUser(uid)).email || null;
    });
    const email = await emailFor(creatorId);
    if (!email) return false;
    const payload = { templateKey: 'creator_sla', to: { email }, params };
    if (ctx.deps && ctx.deps.sendEmail) await ctx.deps.sendEmail(payload);
    else require('../email-shared').queueEmailBackground(payload);
    return true;
  } catch (e) {
    console.warn('automation email skipped:', e.message);
    return false;
  }
}

// ------------------------------------------------------------------ links
async function checkProductLink(db, product, ctx) {
  const url = product.publishedSnapshot && product.publishedSnapshot.externalUrl;
  const result = await checkExternalLink(url, ctx.deps || {});
  const prior = product.linkHealth || {};
  const verdict = L.deriveLinkHealth(result, prior);
  await db.collection('products').doc(product.id).set({
    linkHealth: {
      state: verdict.state, checkedAtMs: ctx.nowMs, lastCode: result.code, lastStatus: result.status || null,
      consecutiveBroken: verdict.consecutiveBroken, consecutiveTransient: verdict.consecutiveTransient, reason: verdict.reason,
    },
  }, { merge: true });
  return { result, verdict };
}

async function linkHealthJob(db, ctx) {
  const items = (await publishedProducts(db))
    .filter((p) => p.publishedSnapshot && typeof p.publishedSnapshot.externalUrl === 'string' && p.publishedSnapshot.externalUrl)
    .map((p) => ({ ...p, _last: p.linkHealth && p.linkHealth.checkedAtMs }));
  const due = L.pickDue(items, '_last', L.LINK_CHECK_GAP_MS, ctx.nowMs, ctx.limit || 25);
  const out = { eligible: items.length, checked: 0, healthy: 0, warnings: 0, paused: 0, errors: 0 };
  for (const p of due) {
    try {
      const { verdict } = await checkProductLink(db, p, ctx);
      out.checked += 1;
      const key = `link_${p.id}`;
      if (verdict.state === 'HEALTHY') { out.healthy += 1; await resolveAlertByKey(db, key, 'Link is reachable again.'); continue; }
      if (verdict.pause) {
        if (await pauseProduct(db, p, 'pausedByLink', verdict.reason)) {
          out.paused += 1;
          await raiseAlert(db, { key, type: 'LINK_DEGRADED', severity: 'critical', title: 'Listing paused: delivery link failing', detail: `${p.publishedSnapshot.title || p.id}: ${verdict.reason}`, creatorId: p.creatorId, objectId: p.id, nowMs: ctx.nowMs });
          await notifyCreator(db, { creatorId: p.creatorId, key: `link_paused_${p.id}_${Math.floor(ctx.nowMs / DAY)}`, type: 'PRODUCT_PAUSED', title: 'A listing was paused', body: `"${p.publishedSnapshot.title || 'Your listing'}" was taken off sale because its delivery link stopped working. Fix the link, then resume it.`, link: `#creator/products/${p.id}`, nowMs: ctx.nowMs });
        }
      } else {
        out.warnings += 1;
        await notifyCreator(db, { creatorId: p.creatorId, key: `link_warn_${p.id}_${verdict.consecutiveBroken}_${verdict.consecutiveTransient}`, type: 'LINK_WARNING', title: 'A delivery link may be broken', body: `${verdict.reason} Please check it.`, link: `#creator/products/${p.id}`, nowMs: ctx.nowMs });
      }
    } catch (e) { out.errors += 1; console.warn('link check failed:', p.id, e.message); }
  }
  return out;
}

// ---------------------------------------------------------------- supplier
async function supplierHealthJob(db, ctx) {
  const items = (await publishedProducts(db)).filter((p) => p.publishedSnapshot && p.publishedSnapshot.fulfillmentMode === FULFILLMENT_MODES.CJ_DROPSHIP);
  const out = { eligible: items.length, checked: 0, cached: 0, paused: 0, errors: 0 };
  let budget = ctx.limit || 20;
  for (const p of items) {
    if (budget <= 0) break;
    try {
      const r = await supplierService.checkMappingHealth(db, { productId: p.id, minGapMs: L.SUPPLIER_CHECK_GAP_MS }, ctx.deps || {});
      if (r.cached) { out.cached += 1; continue; }
      budget -= 1; out.checked += 1;
      const key = `supplier_${p.id}`;
      if (r.paused) {
        out.paused += 1;
        await raiseAlert(db, { key, type: 'SUPPLIER_DEGRADED', severity: 'critical', title: 'Dropship listing paused: supplier problem', detail: `${p.publishedSnapshot.title || p.id}: ${(r.reasons || [])[0] || ''}`, creatorId: p.creatorId, objectId: p.id, nowMs: ctx.nowMs });
        await notifyCreator(db, { creatorId: p.creatorId, key: `supplier_paused_${p.id}_${Math.floor(ctx.nowMs / DAY)}`, type: 'PRODUCT_PAUSED', title: 'A dropship listing was paused', body: `${(r.reasons || [])[0] || 'The CJ supplier check failed.'} Fix it in your CJ account, then resume the listing.`, link: `#creator/products/${p.id}`, nowMs: ctx.nowMs });
      } else if (r.health === 'HEALTHY') await resolveAlertByKey(db, key, 'Supplier healthy again.');
    } catch (e) { out.errors += 1; console.warn('supplier health failed:', p.id, e.code || e.message); }
  }
  return out;
}

// ----------------------------------------------------- CJ order sync / retry
const SYNC_STATUSES = ['ORDERED', 'AWAITING_PAYMENT', 'PROCESSING', 'SHIPPED'];
async function cjOrderJob(db, ctx) {
  const out = { retried: 0, synced: 0, errors: 0, needsAttention: 0 };
  const limit = ctx.limit || 25;

  // 1) retry orders that failed only because CJ was unreachable (idempotent).
  const retrySnap = await db.collection('supplierOrders').where('status', '==', 'RETRY_LATER').limit(limit).get();
  for (const d of retrySnap.docs) {
    const so = { id: d.id, ...d.data() };
    if (!L.shouldRetrySupplierOrder(so, ctx.nowMs)) continue;
    try { await supplierOrders.createCjOrderForFulfillment(db, so.id, ctx.deps || {}); out.retried += 1; } catch (e) { out.errors += 1; }
  }

  // 2) pull CJ progress for live orders.
  for (const status of SYNC_STATUSES) {
    const snap = await db.collection('supplierOrders').where('status', '==', status).limit(limit).get();
    for (const d of snap.docs) {
      const so = { id: d.id, ...d.data() };
      if (!so.cjOrderId || !L.isDue(so.lastSyncAtMs, L.SYNC_MIN_GAP_MS, ctx.nowMs)) continue;
      try {
        await supplierOrders.syncCjFulfillment(db, so.id, ctx.deps || {});
        out.synced += 1;
        if (status === 'AWAITING_PAYMENT' && ctx.nowMs - (so.createdAtMs || ctx.nowMs) > DAY) {
          await notifyCreator(db, { creatorId: so.creatorId, key: `cj_unpaid_${so.id}`, type: 'ORDER_ACTION', title: 'Pay your CJ order', body: `CJ order for ${so.id} is still unpaid after 24 hours. Pay it in your CJ account so it can ship.`, nowMs: ctx.nowMs });
        }
      } catch (e) { out.errors += 1; }
    }
  }

  // 3) orders a human must look at -> one alert + one notification each.
  for (const status of ['NEEDS_ATTENTION', 'STOCK_ISSUE']) {
    const snap = await db.collection('supplierOrders').where('status', '==', status).limit(limit).get();
    for (const d of snap.docs) {
      const so = { id: d.id, ...d.data() };
      out.needsAttention += 1;
      await raiseAlert(db, { key: `supplier_order_${so.id}`, type: 'SUPPLIER_ORDER', severity: status === 'STOCK_ISSUE' ? 'critical' : 'warning', title: `CJ order needs attention (${status})`, detail: (so.error && so.error.message) || null, creatorId: so.creatorId, objectId: so.id, nowMs: ctx.nowMs });
      await notifyCreator(db, { creatorId: so.creatorId, key: `supplier_order_${so.id}_${status}`, type: 'ORDER_ACTION', title: 'A dropship order needs your attention', body: (so.error && so.error.message) || 'The CJ order could not be placed.', nowMs: ctx.nowMs });
    }
  }
  return out;
}

// -------------------------------------------------------------------- SLA
async function autoRestrictEnabled(db) {
  // Own document (not catalog/settings): the admin portal rewrites that whole
  // document from its local copy, which could silently flip this safety switch.
  const s = await db.collection('automationSettings').doc('config').get();
  return !!(s.exists && s.data().autoRestrictSla === true);
}

async function slaJob(db, ctx) {
  const rows = [];
  for (const status of ['PENDING', 'PACKED', 'SHIPPED']) {
    const snap = await db.collection('fulfillments').where('status', '==', status).limit(500).get();
    for (const d of snap.docs) rows.push({ id: d.id, ...d.data() });
  }
  const out = { open: rows.length, atRisk: 0, breached: 0, notified: 0, creatorsFlagged: 0, autoPausedCreators: 0, autoPausedListings: 0 };
  const byCreator = new Map();
  for (const f of rows) {
    if (!f.creatorId) continue;
    if (!byCreator.has(f.creatorId)) byCreator.set(f.creatorId, []);
    byCreator.get(f.creatorId).push(f);
    const e = evaluateSla(f, ctx.nowMs);
    if (e.overall !== 'AT_RISK' && e.overall !== 'BREACHED') continue;
    if (e.overall === 'AT_RISK') out.atRisk += 1; else out.breached += 1;
    const what = e.breaches.length ? e.breaches[0].replace('_', ' ').toLowerCase() : (e.ack === 'DUE_SOON' ? 'acknowledgement due soon' : 'shipping due soon');
    const isNew = await notifyCreator(db, {
      creatorId: f.creatorId, key: `sla_${f.id}_${e.overall}`, type: 'ORDER_SLA',
      title: e.overall === 'BREACHED' ? 'Order overdue' : 'Order due soon',
      body: `${f.productTitle || 'An order'} (${f.id}): ${what}. ${e.overall === 'BREACHED' ? 'Late orders lower your seller trust.' : 'Act now to stay on time.'}`,
      link: `#creator/orders/${f.id}`, nowMs: ctx.nowMs,
    });
    if (isNew) { out.notified += 1; await maybeEmail(ctx, f.creatorId, { orderId: f.id, product: f.productTitle || '', state: e.overall, issue: what }); }
  }

  const auto = await autoRestrictEnabled(db);
  for (const [uid, list] of byCreator) {
    const s = summarizeCreatorSla(list, ctx.nowMs);
    const key = `sla_creator_${uid}`;
    if (!s.restrictionRecommended && !s.watch) { await resolveAlertByKey(db, key, 'SLA performance recovered.', ctx.nowMs); continue; }
    out.creatorsFlagged += 1;
    await raiseAlert(db, {
      key, type: 'SLA_TRUST', severity: s.restrictionRecommended ? 'critical' : 'warning',
      title: s.restrictionRecommended ? 'Seller repeatedly missing deadlines — restriction recommended' : 'Seller missing deadlines — watch',
      detail: `${s.breached} of ${s.total} open orders breached (${s.breachRatePct}%).`, creatorId: uid, nowMs: ctx.nowMs,
    });
    if (s.restrictionRecommended && auto) {
      const products = (await publishedProducts(db)).filter((p) => p.creatorId === uid && p.publishedSnapshot && p.publishedSnapshot.offeringType === 'PHYSICAL_PRODUCT');
      let n = 0;
      for (const p of products) if (await pauseProduct(db, p, 'pausedBySla', 'Paused automatically: repeated missed fulfillment deadlines.')) n += 1;
      if (n) {
        out.autoPausedCreators += 1; out.autoPausedListings += n;
        await notifyCreator(db, { creatorId: uid, key: `sla_paused_${Math.floor(ctx.nowMs / DAY)}`, type: 'PRODUCT_PAUSED', title: 'Your physical listings were paused', body: 'Several orders passed their deadlines. Ship or cancel the late orders; support will review and re-open your listings.', nowMs: ctx.nowMs });
      }
    }
  }
  return out;
}

// --------------------------------------------------------- reconciliation
async function reconciliationJob(db, ctx) {
  const out = { ordersChecked: 0, orderIssues: 0, creatorsChecked: 0, ledgerIssues: 0, stuckWithdrawals: 0 };
  const cutoff = ctx.nowMs - 14 * DAY;
  const settleMs = 10 * 60 * 1000; // give async crediting a moment before calling it missing

  const snap = await db.collection('orders').orderBy('timestamp', 'desc').limit(400).get();
  for (const d of snap.docs) {
    const o = d.data();
    if (!o.creatorProductId || o.status !== 'paid') continue;
    const at = toMs(o.timestamp);
    if (at == null || at < cutoff || ctx.nowMs - at < settleMs) continue;
    out.ordersChecked += 1;
    const [sale, ful, ent] = await Promise.all([
      db.collection('creatorSales').doc(d.id).get(),
      o.creatorOfferingType === 'PHYSICAL_PRODUCT' ? db.collection('fulfillments').doc(d.id).get() : Promise.resolve({ exists: false }),
      o.creatorOfferingType !== 'PHYSICAL_PRODUCT' ? db.collection('entitlements').doc(entitlementId(d.id, o.creatorProductId)).get() : Promise.resolve({ exists: false }),
    ]);
    const issues = L.reconcileOrder(o, { hasSale: sale.exists, hasFulfillment: ful.exists, hasEntitlement: ent.exists });
    for (const code of issues) {
      out.orderIssues += 1;
      await raiseAlert(db, { key: `recon_order_${d.id}_${code}`, type: 'RECONCILIATION', severity: 'critical', title: `Order ${d.id}: ${code.replace(/_/g, ' ').toLowerCase()}`, detail: `Paid creator order has no ${code === 'MISSING_LEDGER_ENTRY' ? 'ledger entry' : code === 'MISSING_FULFILLMENT' ? 'fulfillment record' : 'buyer entitlement'}. Re-verifying the payment reference repairs it (the repair is idempotent).`, creatorId: o.creatorSellerId || null, objectId: d.id, nowMs: ctx.nowMs });
    }
    if (!issues.length) for (const code of ['MISSING_LEDGER_ENTRY', 'MISSING_FULFILLMENT', 'MISSING_ENTITLEMENT']) await resolveAlertByKey(db, `recon_order_${d.id}_${code}`, 'Repaired.', ctx.nowMs);
  }

  const privs = await db.collection('creatorPrivate').limit(200).get();
  for (const p of privs.docs) {
    const [sales, wds] = await Promise.all([
      db.collection('creatorSales').where('creatorId', '==', p.id).limit(5000).get(),
      db.collection('creatorWithdrawals').where('creatorId', '==', p.id).limit(5000).get(),
    ]);
    out.creatorsChecked += 1;
    const r = L.reconcileCreator({ priv: p.data(), sales: sales.docs.map((x) => x.data()), withdrawals: wds.docs.map((x) => x.data()) });
    const key = `recon_balance_${p.id}`;
    if (r.ok) { await resolveAlertByKey(db, key, 'Balances reconcile.', ctx.nowMs); }
    else {
      out.ledgerIssues += 1;
      await raiseAlert(db, { key, type: 'RECONCILIATION', severity: 'critical', title: 'Creator balance does not reconcile', detail: r.issues.map((i) => `${i.code}: stored ${i.stored}, computed ${i.computed}`).join('; '), creatorId: p.id, nowMs: ctx.nowMs });
    }
    for (const w of wds.docs) {
      const wd = w.data();
      const started = toMs(wd.processingStartedAt);
      if (wd.status === 'processing' && started != null && ctx.nowMs - started > 60 * 60 * 1000) {
        out.stuckWithdrawals += 1;
        await raiseAlert(db, { key: `wd_stuck_${w.id}`, type: 'WITHDRAWAL_STUCK', severity: 'critical', title: 'Withdrawal stuck in processing for over an hour', detail: `Withdrawal ${w.id}: check Paystack before retrying — a second transfer could double-pay.`, creatorId: p.id, objectId: w.id, nowMs: ctx.nowMs });
      }
    }
  }
  return out;
}

// ------------------------------------------------------------- earnings holds
async function holdsJob(db, ctx) {
  const { releaseDueHolds } = require('../creator/ledger');
  return releaseDueHolds(db, ctx.nowMs, ctx.limit || 200);
}


// ---------------------------------------------------- creator weekly report
async function creatorWeeklyEmailJob(db, ctx) {
  const { generateWeeklyEmailReport } = require('../creator-ai');
  const { queueEmailBackground } = require('../email-shared');
  const creators = await db.collection('creators').where('status', '==', 'ACTIVE').limit(ctx.limit || 500).get();
  const out = { creators: creators.size, sent: 0, skipped: 0, errors: 0, ai: 0, fallback: 0 };
  for (const d of creators.docs) {
    try {
      const priv = await db.collection('creatorPrivate').doc(d.id).get();
      const email = priv.exists && priv.data().email;
      if (!email) { out.skipped += 1; continue; }

      const report = await generateWeeklyEmailReport(db, d.id, ctx.nowMs, ctx.deps || {});
      const h = report.home; const r = h.report;
      const displayName = (h.creator && h.creator.displayName) || 'Creator';
      const trend = r.earnedChangePct == null
        ? 'First earnings in this comparison window'
        : r.earnedChangePct > 0 ? ('Up ' + r.earnedChangePct + '% vs previous 7 days')
        : r.earnedChangePct < 0 ? ('Down ' + Math.abs(r.earnedChangePct) + '% vs previous 7 days')
        : 'Level with the previous 7 days';
      const actionCount = h.ordersNeedingAction.length + (h.products.needAttention || 0);
      const top = r.topProducts && r.topProducts[0];

      queueEmailBackground({
        templateKey: 'creator_weekly_report',
        to: { email, name: displayName },
        params: {
          FIRSTNAME: String(displayName).split(' ')[0] || undefined,
          period_label: 'Last 7 days compared with the previous 7 days',
          sales: String(r.sales || 0),
          previous_sales: String(r.previousSales || 0),
          earned: String(r.earned || 0),
          earnings_trend: trend,
          gross: String(r.gross || 0),
          action_count: String(actionCount),
          ai_summary: report.text,
          top_product: top ? ((top.title || top.productId) + ' — ' + top.sales + ' sale' + (top.sales === 1 ? '' : 's')) : ''
        }
      });
      out.sent += 1;
      if (report.ai) out.ai += 1; else out.fallback += 1;
    } catch (e) {
      out.errors += 1;
      console.warn('creator weekly report skipped for', d.id, e.message);
    }
  }
  return out;
}

// ------------------------------------------------------------- email queue
// Releases checkout holds whose payment window passed so abandoned checkouts never lock stock.
async function reservationsJob(db, ctx) {
  const inv = require('../inventory/service');
  const r = await inv.sweepExpired(db, { nowMs: ctx.nowMs, limit: ctx.limit || 200 });
  if (r.released) {
    const snap = await db.collection('inventoryReservations').where('state', '==', 'EXPIRED').limit(50).get();
    const pids = [...new Set(snap.docs.map((d) => d.data().productId))];
    for (const pid of pids) await inv.refreshStockSummary(db, pid).catch(() => {});
  }
  return r;
}

// Two-way Shopify stock sync for every creator with a live connection. OFF unless INVENTORY_CHANNEL_SYNC_ENABLED=true.
async function channelSyncJob(db, ctx) {
  const cfg = require('../core/config');
  if (!cfg.flags((ctx.deps && ctx.deps.env) || process.env).connectedChannelSync) return { skipped: 'FLAG_OFF' };
  const sync = require('../inventory/channel-sync'); const C = require('../inventory/shopify-connection');
  const snap = await db.collection('shopifyConnections').where('status', '==', 'CONNECTED').limit(ctx.limit || 100).get();
  const out = { creators: 0, listings: 0, problems: 0 };
  for (const d of snap.docs) {
    const creatorId = d.id; out.creators += 1;
    try {
      const cr = await db.collection('creators').doc(creatorId).get();
      if (!cr.exists || cr.data().status !== 'ACTIVE') continue; // suspended sellers are not synced
      const conn = await C.load(db, creatorId, { nowMs: ctx.nowMs, fetchImpl: ctx.deps && ctx.deps.fetchImpl });
      if (!conn.locationId) continue;
      const r = await sync.syncCreator(db, creatorId, conn, { nowMs: ctx.nowMs, deps: { fetchImpl: ctx.deps && ctx.deps.fetchImpl } });
      out.listings += r.checked; if (r.stopped || Object.values(r.results).some((c) => /^ERROR|FAILED|STALE|REJECTED|NEEDS/.test(c))) out.problems += 1;
      await d.ref.set({ lastSyncAtMs: ctx.nowMs }, { merge: true });
    } catch (e) { out.problems += 1; await C.recordError(db, creatorId, `${e.code || 'ERROR'}: ${e.message}`); }
  }
  return out;
}

async function emailQueueJob(db, ctx) {
  const { callHandler } = require('../../mcp/lib/callHandler');
  const handler = ctx.deps && ctx.deps.emailQueueHandler ? ctx.deps.emailQueueHandler : require('../process-email-queue');
  const r = await callHandler(handler, { method: 'GET' });
  return { status: r.status };
}

const JOBS = {
  supplierHealth: { run: supplierHealthJob, minIntervalMs: 15 * 60 * 1000 },
  cjOrders: { run: cjOrderJob, minIntervalMs: 5 * 60 * 1000 },
  links: { run: linkHealthJob, minIntervalMs: 60 * 60 * 1000 },
  sla: { run: slaJob, minIntervalMs: 30 * 60 * 1000 },
  reconcile: { run: reconciliationJob, minIntervalMs: 22 * 60 * 60 * 1000 },
  holds: { run: holdsJob, minIntervalMs: 15 * 60 * 1000 },
  reservations: { run: reservationsJob, minIntervalMs: 5 * 60 * 1000 },
  channelSync: { run: channelSyncJob, minIntervalMs: 5 * 60 * 1000 },
  emailQueue: { run: emailQueueJob, minIntervalMs: 5 * 60 * 1000 },
  creatorWeeklyEmail: { run: creatorWeeklyEmailJob, minIntervalMs: 7 * DAY },
};

module.exports = { JOBS, supplierHealthJob, cjOrderJob, linkHealthJob, slaJob, reconciliationJob, holdsJob, reservationsJob, channelSyncJob, emailQueueJob, creatorWeeklyEmailJob, checkProductLink, pauseProduct };
