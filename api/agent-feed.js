'use strict';

const { getCatalogDoc } = require('./_shared');
const { isPublicCatalogProduct, isSuspiciousDiscount, effectiveCatalogPrice } = require('./product-page');
const BASE = (process.env.PUBLIC_API_URL || 'https://lexden-nova.onrender.com').replace(/\/+$/, '');
const MAX_RATE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const FIELDS = ['item_id','title','description','url','brand','seller_name','image_url','price','sale_price','availability','is_eligible_search','is_eligible_checkout'];

function plain(value, max = 5000) {
  return String(value == null ? '' : value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function secureUrl(value) {
  try { const u = new URL(String(value || '')); return u.protocol === 'https:' ? u.href : ''; }
  catch { return ''; }
}
function contentOf(settings) { return settings && (settings.content || settings) || {}; }
function currencyState(settings, now = Date.now()) {
  const c = contentOf(settings);
  const currency = String(c.displayCurrency || '').toUpperCase();
  const updatedAt = Date.parse(c.ratesUpdatedAt || '');
  const age = Number.isFinite(updatedAt) ? now - updatedAt : Infinity;
  const rate = Number(c.exchangeRates && c.exchangeRates[currency]);
  return { currency, rate, age, ok: /^[A-Z]{3}$/.test(currency) && Number.isFinite(rate) && rate > 0 && age >= 0 && age <= MAX_RATE_AGE_MS };
}
function exclusionReason(p, settings, now = Date.now()) {
  if (!p || !String(p.id || '').trim()) return 'missing_id';
  if (!isPublicCatalogProduct(p)) return 'not_explicitly_published';
  if (p.pricingReviewRequired === true || isSuspiciousDiscount(p)) return 'price_requires_review';
  if (effectiveCatalogPrice(p) === null) return 'invalid_price';
  if (!plain(p.name, 150) || plain(p.description).length < 40) return 'missing_product_content';
  if (!secureUrl(p.image)) return 'missing_secure_image';
  if (p.externalPaymentLink || (p.affiliateLink && !['#', ''].includes(String(p.affiliateLink)))) return 'external_checkout_price_unverified';
  const seller = plain(p.sellerName || p.seller, 120);
  const brand = plain(p.brand || p.brandName || (seller.toUpperCase() === 'LEXDEN ACADEMY' ? seller : ''), 100);
  if (!seller || !brand || /^selar$/i.test(seller)) return 'seller_or_brand_unverified';
  const type = String(p.productType || '').toUpperCase();
  if (type === 'PHYSICAL') {
    if (String(p.category || p.categoryId || '').toLowerCase() === 'courses') return 'product_type_conflict';
    if (!p.physical || !['in_stock','out_of_stock','backorder','pre_order'].includes(String(p.physical.stockStatus || '').toLowerCase())) return 'physical_listing_needs_review';
    if (!plain(p.physical.deliveryEstimate, 120)) return 'physical_fulfilment_incomplete';
  } else if (type === 'DIGITAL') {
    if (!secureUrl(p.deliveryLink || p.fileUrl || p.downloadUrl) && !plain(p.accessDelivery, 2000)) return 'digital_delivery_incomplete';
  } else return 'missing_product_type';
  const c = contentOf(settings);
  if (String(c.displayCurrency || '').toUpperCase() !== 'USD' && !currencyState(settings, now).ok) return 'exchange_rate_stale';
  return null;
}
function availabilityFor(p) {
  if (String(p.productType || '').toUpperCase() !== 'PHYSICAL') return 'in_stock';
  const s = String(p.physical && p.physical.stockStatus || '').toLowerCase();
  if (['in_stock','out_of_stock','backorder','pre_order'].includes(s)) return s;
  return 'unknown';
}
function buildAgentFeed({ products = [], settings = {}, baseUrl = BASE, now = Date.now() } = {}) {
  const excluded = {};
  const c = contentOf(settings);
  const currency = String(c.displayCurrency || 'USD').toUpperCase();
  const rate = currency === 'USD' ? 1 : Number(c.exchangeRates && c.exchangeRates[currency]);
  const rows = [];
  for (const p of products) {
    const reason = exclusionReason(p, settings, now);
    if (reason) { excluded[reason] = (excluded[reason] || 0) + 1; continue; }
    // OpenAI's published feed contract distinguishes regular price from
    // sale_price. Keep major units/currency explicit, and never label a
    // computed sale price as the regular price.
    const regularBase = Number(p.price);
    const regularAmount = regularBase * rate;
    const saleBase = Number(p.salePrice);
    const hasSale = Number.isFinite(saleBase) && saleBase > 0 && saleBase < regularBase;
    const saleAmount = hasSale ? saleBase * rate : null;
    if (!Number.isFinite(regularAmount) || regularAmount <= 0 || (hasSale && (!Number.isFinite(saleAmount) || saleAmount <= 0))) { excluded.invalid_price = (excluded.invalid_price || 0) + 1; continue; }
    const seller = plain(p.sellerName || p.seller, 120);
    rows.push({
      item_id: String(p.id), title: plain(p.name, 150), description: plain(p.description, 5000),
      url: baseUrl + '/product/' + encodeURIComponent(String(p.id)),
      brand: plain(p.brand || p.brandName || (seller.toUpperCase() === 'LEXDEN ACADEMY' ? seller : ''), 100),
      seller_name: seller, image_url: secureUrl(p.image),
      price: regularAmount.toFixed(2) + ' ' + currency,
      sale_price: hasSale ? saleAmount.toFixed(2) + ' ' + currency : '',
      availability: availabilityFor(p), is_eligible_search: true, is_eligible_checkout: false,
    });
  }
  const state = currencyState(settings, now);
  return { rows, excluded, currency, rateCurrent: currency === 'USD' || state.ok };
}
function csvCell(value) {
  const s = String(value == null ? '' : value);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(rows) {
  return [FIELDS.join(','), ...rows.map(r => FIELDS.map(k => csvCell(r[k])).join(','))].join('\r\n') + '\r\n';
}
function toJsonl(rows) { return rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''); }
async function loadFeed() {
  const [productDoc, settingsDoc] = await Promise.all([getCatalogDoc('products'), getCatalogDoc('settings')]);
  if (!productDoc || !Array.isArray(productDoc.list) || !settingsDoc) return { ok: false, rows: [], excluded: {}, reason: 'catalog_unavailable' };
  return { ok: true, ...buildAgentFeed({ products: productDoc.list, settings: settingsDoc }), totalCatalogProducts: productDoc.list.length };
}
async function handler(req, res) {
  let report;
  try { report = await loadFeed(); }
  catch (error) {
    console.error('agent product feed failed:', error && error.message);
    return res.status(503).json({ ok: false, error: 'FEED_TEMPORARILY_UNAVAILABLE' });
  }
  res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
  if (String(req.path || '').endsWith('agent-products-status.json')) {
    return res.status(report.ok ? 200 : 503).json({
      ok: report.ok, totalCatalogProducts: report.totalCatalogProducts || null,
      eligibleProducts: report.rows.length, excludedByReason: report.excluded || {},
      currency: report.currency || null, exchangeRateCurrent: report.rateCurrent === true,
      message: report.rows.length ? 'Only validated, directly purchasable offers are exported.' : 'No products currently meet machine-commerce feed validation. Review the live catalog before submitting the feed.',
    });
  }
  if (!report.ok) return res.status(503).json({ ok: false, error: 'CATALOG_UNAVAILABLE' });
  if (!report.rows.length) return res.status(503).json({ ok: false, error: 'FEED_NOT_READY', message: 'No catalog items pass current feed validation. See /feeds/agent-products-status.json.' });
  if (String(req.path || '').endsWith('.csv')) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="lexden-nova-agent-products.csv"');
    return res.status(200).send(toCsv(report.rows));
  }
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="lexden-nova-agent-products.jsonl"');
  return res.status(200).send(toJsonl(report.rows));
}
module.exports = handler;
module.exports.FIELDS = FIELDS;
module.exports.availabilityFor = availabilityFor;
module.exports.buildAgentFeed = buildAgentFeed;
module.exports.exclusionReason = exclusionReason;
module.exports.toCsv = toCsv;
module.exports.toJsonl = toJsonl;
