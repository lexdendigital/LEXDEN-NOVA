// api/creator/insights.js
//
// LEXDEN NOVA CREATOR — Stage J: the numbers behind the Creator AI Home.
// PURE (no I/O). Every figure the seller sees comes from here, computed from
// their own records — the AI only phrases advice AROUND these facts, it never
// invents or recalculates them (blueprint §48: co-pilot, not an administrator).
const { evaluateSla, summarizeCreatorSla, toMs } = require('./sla');

const DAY = 86400000;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function sumBy(rows, f) { return round2(rows.reduce((s, r) => s + (Number(f(r)) || 0), 0)); }
function pctChange(cur, prev) {
  if (!prev) return cur > 0 ? null : 0; // null = "new" (no previous period to compare)
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

/**
 * Sales performance, last 7 days vs the 7 before. sales = creatorSales docs.
 */
function salesReport(sales, nowMs, days = 7) {
  const span = days * DAY;
  const rows = (sales || []).map((s) => ({ ...s, _t: toMs(s.createdAt) })).filter((s) => s._t != null);
  const cur = rows.filter((s) => s._t > nowMs - span && s._t <= nowMs);
  const prev = rows.filter((s) => s._t > nowMs - 2 * span && s._t <= nowMs - span);
  const byProduct = new Map();
  for (const s of cur) {
    const k = s.productId || 'unknown';
    const e = byProduct.get(k) || { productId: k, title: s.productTitle || null, sales: 0, earned: 0 };
    e.sales += 1; e.earned = round2(e.earned + (Number(s.creatorEarning) || 0));
    byProduct.set(k, e);
  }
  const curEarn = sumBy(cur, (s) => s.creatorEarning);
  const prevEarn = sumBy(prev, (s) => s.creatorEarning);
  return {
    periodDays: days,
    sales: cur.length, previousSales: prev.length,
    earned: curEarn, previousEarned: prevEarn,
    earnedChangePct: pctChange(curEarn, prevEarn),
    gross: sumBy(cur, (s) => s.saleAmount),
    platformFees: sumBy(cur, (s) => s.platformFeeAmount),
    topProducts: [...byProduct.values()].sort((a, b) => b.earned - a.earned).slice(0, 3),
  };
}

/** Orders the seller must act on, most urgent first. */
function ordersNeedingAction(fulfillments, nowMs) {
  const list = [];
  for (const f of fulfillments || []) {
    if (!['PENDING', 'PACKED', 'SHIPPED'].includes(f.status)) continue;
    const e = evaluateSla(f, nowMs);
    if (e.overall !== 'AT_RISK' && e.overall !== 'BREACHED') continue;
    list.push({ orderId: f.id, product: f.productTitle || null, status: f.status, sla: e.overall, issue: e.breaches[0] || (e.ack === 'DUE_SOON' ? 'ACK_DUE_SOON' : 'SHIP_DUE_SOON'), dueAtMs: e.dueAtMs });
  }
  const rank = { BREACHED: 0, AT_RISK: 1 };
  return list.sort((a, b) => rank[a.sla] - rank[b.sla] || (a.dueAtMs || 0) - (b.dueAtMs || 0)).slice(0, 10);
}

/**
 * Deterministic listing-quality checklist (blueprint §48 "product improvement
 * checklist"). fields = publishedSnapshot or a version's fields.
 */
function productChecklist(fields) {
  const f = fields || {};
  const items = [];
  const add = (ok, id, tip) => items.push({ id, ok: !!ok, tip });
  const title = String(f.title || '').trim();
  const desc = String(f.description || '').trim();
  add(title.length >= 15 && title.length <= 80, 'title_length', 'Use a clear title of 15–80 characters that says what the buyer gets.');
  add(desc.length >= 150, 'description_length', 'Write at least ~150 characters: what it is, who it is for, what is included.');
  add(/\n|•|- |\d\./.test(desc), 'description_structure', 'Break the description into short lines or bullet points so it is easy to scan.');
  add(Array.isArray(f.images) && f.images.length >= 3, 'images', 'Add at least 3 images (cover, detail, what is included).');
  add(f.isFree === true || (typeof f.price === 'number' && f.price > 0), 'price', 'Set a price (or mark the listing free).');
  add(!!String(f.category || '').trim(), 'category', 'Choose a category so buyers can find it.');
  add(String(f.refundPolicy || '').trim().length >= 20, 'refund_policy', 'State your refund/return policy in a sentence or two — it builds trust.');
  if (f.offeringType === 'PHYSICAL_PRODUCT') {
    add(Number.isFinite(f.processingDays) || f.fulfillmentMode === 'CJ_DROPSHIP', 'processing_time', 'Tell buyers how many days you need to dispatch.');
  }
  const failed = items.filter((i) => !i.ok);
  return { score: Math.round(((items.length - failed.length) / items.length) * 100), items, todo: failed.map((i) => i.tip) };
}

/**
 * One compact, safe-to-share facts object for the home screen and the AI.
 * Never includes buyer personal data, bank details or credentials.
 */
function buildHome({ creator, priv, products, sales, fulfillments, unreadNotifications }, nowMs) {
  const byStatus = {};
  for (const p of products || []) byStatus[p.status || 'UNKNOWN'] = (byStatus[p.status || 'UNKNOWN'] || 0) + 1;
  const published = (products || []).filter((p) => p.status === 'PUBLISHED' && p.publishedSnapshot);
  const weakest = published
    .map((p) => ({ productId: p.id, title: p.publishedSnapshot.title || null, ...productChecklist(p.publishedSnapshot) }))
    .filter((x) => x.score < 100).sort((a, b) => a.score - b.score).slice(0, 3)
    .map((x) => ({ productId: x.productId, title: x.title, score: x.score, todo: x.todo.slice(0, 3) }));
  const sla = summarizeCreatorSla(fulfillments || [], nowMs);
  return {
    creator: { displayName: (creator && (creator.displayName || creator.storeName)) || null, status: (creator && creator.status) || null },
    money: {
      balanceAvailable: round2(priv && priv.balanceAvailable), totalEarned: round2(priv && priv.totalEarned), totalWithdrawn: round2(priv && priv.totalWithdrawn),
      hasPayoutAccount: !!(priv && priv.payoutAccount && priv.payoutAccount.accountNumber),
    },
    products: { total: (products || []).length, byStatus, needAttention: (products || []).filter((p) => ['REJECTED', 'CHANGES_REQUESTED', 'PAUSED'].includes(p.status)).length },
    report: salesReport(sales, nowMs),
    ordersNeedingAction: ordersNeedingAction(fulfillments, nowMs),
    sla: { total: sla.total, breached: sla.breached, breachRatePct: sla.breachRatePct, watch: !!sla.watch, restrictionRecommended: !!sla.restrictionRecommended },
    listingsToImprove: weakest,
    unreadNotifications: unreadNotifications || 0,
  };
}

/** Plain-language weekly summary built ONLY from the facts (works with no AI). */
function plainSummary(home) {
  const r = home.report;
  const L = [];
  const trend = r.earnedChangePct == null ? 'first sales in this window' : r.earnedChangePct > 0 ? `up ${r.earnedChangePct}% on the week before` : r.earnedChangePct < 0 ? `down ${Math.abs(r.earnedChangePct)}% on the week before` : 'level with the week before';
  L.push(`Last ${r.periodDays} days: ${r.sales} sale${r.sales === 1 ? '' : 's'}, you earned ${r.earned} (${trend}).`);
  if (r.topProducts.length) L.push(`Best seller: ${r.topProducts[0].title || r.topProducts[0].productId} (${r.topProducts[0].sales} sale${r.topProducts[0].sales === 1 ? '' : 's'}).`);
  if (home.ordersNeedingAction.length) {
    const late = home.ordersNeedingAction.filter((o) => o.sla === 'BREACHED').length;
    L.push(`${home.ordersNeedingAction.length} order${home.ordersNeedingAction.length === 1 ? '' : 's'} need action${late ? ` (${late} already overdue)` : ' soon'} — handle these first.`);
  } else L.push('No orders are overdue or about to be.');
  if (home.products.needAttention) L.push(`${home.products.needAttention} listing${home.products.needAttention === 1 ? '' : 's'} need your attention (rejected, changes requested or paused).`);
  if (home.listingsToImprove.length) L.push(`Easiest win: improve "${home.listingsToImprove[0].title || home.listingsToImprove[0].productId}" — ${home.listingsToImprove[0].todo[0]}`);
  if (!home.money.hasPayoutAccount && home.money.balanceAvailable > 0) L.push('Add a payout account so you can withdraw your balance.');
  return L.join('\n');
}

/** Model output -> safe plain text (no markup, no control chars, bounded). */
function sanitizeAiText(s, max = 2500) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim().slice(0, max);
}

module.exports = { salesReport, ordersNeedingAction, productChecklist, buildHome, plainSummary, sanitizeAiText };
