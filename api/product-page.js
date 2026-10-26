'use strict';

const {
  SITE_URL, APP_NAME, FALLBACK_IMAGE, FALLBACK_DESCRIPTION,
  esc, getCatalogDoc, firstParagraph, ogImage,
} = require('./_shared');

const API_BASE = (process.env.PUBLIC_API_URL || 'https://lexden-nova.onrender.com').replace(/\/+$/, '');

function httpsUrl(value) {
  try { const u = new URL(String(value || '')); return u.protocol === 'https:' ? u.href : ''; }
  catch { return ''; }
}
function plainText(value, max = 5000) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function isSuspiciousDiscount(product, variant) {
  const base = variant && typeof variant.price === 'number' ? variant.price : Number(product && product.price);
  const sale = variant && typeof variant.salePrice === 'number' ? variant.salePrice : (!variant && product ? Number(product.salePrice) : NaN);
  return Number.isFinite(base) && base > 0 && Number.isFinite(sale) && sale > 0 && sale < base * 0.05;
}
function effectiveCatalogPrice(product) {
  if (!product) return null;
  if (product.free === true) return 0;
  const base = Number(product.price);
  if (!Number.isFinite(base) || base <= 0 || isSuspiciousDiscount(product)) return null;
  const sale = Number(product.salePrice);
  return Number.isFinite(sale) && sale > 0 && sale < base ? sale : base;
}
function isPublicCatalogProduct(product) {
  return !!product && product.status === 'published' && product.active !== false;
}
function isIndexableCatalogProduct(product) {
  if (!isPublicCatalogProduct(product) || product.pricingReviewRequired === true) return false;
  if (!String(product.name || '').trim() || plainText(product.description).length < 40 || !httpsUrl(product.image)) return false;
  if (!plainText(product.sellerName || product.seller, 120)) return false;
  if (effectiveCatalogPrice(product) === null) return false;
  if (String(product.productType || '').toUpperCase() === 'PHYSICAL'
      && String(product.category || product.categoryId || '').toLowerCase() === 'courses') return false;
  return true;
}
function contentOf(settings) { return settings && (settings.content || settings) || {}; }
function priceInfo(product, settings) {
  const base = effectiveCatalogPrice(product);
  if (base === null) return null;
  const c = contentOf(settings);
  const currency = String(c.displayCurrency || 'NGN').toUpperCase();
  const rate = Number(c.exchangeRates && c.exchangeRates[currency]);
  // Product base prices are USD. Never show a converted price based on an
  // old FX snapshot; that creates a trust and underpayment risk.
  if (currency !== 'USD') {
    const updatedAt = Date.parse(c.ratesUpdatedAt || '');
    const age = Date.now() - updatedAt;
    if (!Number.isFinite(updatedAt) || age < 0 || age > 7 * 24 * 60 * 60 * 1000) return null;
  }
  if (!/^[A-Z]{3}$/.test(currency) || !Number.isFinite(rate) || rate <= 0) return null;
  const amount = base * rate;
  if (!Number.isFinite(amount) || amount < 0) return null;
  const displayed = amount >= 100 ? Math.round(amount) : Number(amount.toFixed(2));
  let label;
  try {
    label = new Intl.NumberFormat('en-NG', {
      style: 'currency', currency,
      minimumFractionDigits: displayed >= 100 ? 0 : 2,
      maximumFractionDigits: displayed >= 100 ? 0 : 2,
    }).format(displayed);
  } catch { label = displayed.toFixed(2) + ' ' + currency; }
  return { amount: displayed, currency: /^[A-Z]{3}$/.test(currency) ? currency : 'NGN', label };
}
function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function buildProductPage({ id, product, settings, listing, baseUrl = API_BASE }) {
  const name = plainText(listing ? listing.title : (product.seoTitle || product.name || APP_NAME), 150);
  const details = plainText(listing ? listing.description : product.description);
  const description = firstParagraph(listing ? listing.description : (product.metaDescription || product.shortDescription || product.description) || FALLBACK_DESCRIPTION, 200);
  const image = httpsUrl(listing ? listing.images && listing.images[0] : product.image) || FALLBACK_IMAGE;
  const realImage = image !== FALLBACK_IMAGE;
  const category = plainText(listing ? listing.category : (product.categoryName || product.category || product.categoryId || 'Digital products'), 100);
  const canonical = baseUrl + '/product/' + encodeURIComponent(id);
  const storeLink = SITE_URL + '#product/' + encodeURIComponent(id);
  const external = !listing && httpsUrl(product.externalPaymentLink || product.affiliateLink);
  const suspicious = !listing && isSuspiciousDiscount(product);
  const price = listing
    ? (Number.isFinite(listing.price) ? { amount: listing.price, currency: String(listing.currency || 'USD').toUpperCase(), label: listing.price === 0 ? 'Free' : Number(listing.price).toFixed(2) + ' ' + String(listing.currency || 'USD').toUpperCase() } : null)
    : priceInfo(product, settings);
  const validPrice = !!price && Number.isFinite(Number(price.amount)) && Number(price.amount) >= 0;
  const typeConflict = !listing && String(product.productType || '').toUpperCase() === 'PHYSICAL'
    && String(product.category || product.categoryId || '').toLowerCase() === 'courses';
  const indexable = listing
    ? !!(listing.title && details.length >= 40 && realImage && validPrice)
    : (isIndexableCatalogProduct(product) && !typeConflict && (!!price || !!external));
  const productType = String(product.productType || '').toUpperCase();
  const stock = listing
    ? (listing.inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock')
    : (productType === 'PHYSICAL'
      ? (product.physical && product.physical.stockStatus === 'in_stock' ? 'https://schema.org/InStock'
        : product.physical && product.physical.stockStatus === 'out_of_stock' ? 'https://schema.org/OutOfStock' : null)
      : productType === 'DIGITAL' ? 'https://schema.org/InStock' : null);

  let schema = null;
  if (indexable && !external && !suspicious && validPrice && stock) {
    const offer = { '@type': 'Offer', url: canonical, priceCurrency: price.currency, price: Number(price.amount).toFixed(2), availability: stock };
    const seller = listing ? listing.sellerName : product.sellerName || product.seller;
    if (seller) offer.seller = { '@type': 'Organization', name: plainText(seller, 120) };
    schema = {
      '@context': 'https://schema.org', '@type': 'Product',
      name, description: details, image: [image], sku: String(listing ? listing.id : (product.itemCode || product.id)),
      url: canonical, offers: offer,
    };
    const brand = !listing && plainText(product.brand || product.brandName, 100);
    if (brand) schema.brand = { '@type': 'Brand', name: brand };
    const rating = Number(product.rating);
    const count = Number(product.reviewCount);
    if (Number.isFinite(rating) && rating > 0 && rating <= 5 && Number.isInteger(count) && count > 0) {
      schema.aggregateRating = { '@type': 'AggregateRating', ratingValue: rating, reviewCount: count };
    }
  }
  const priceHtml = suspicious
    ? '<p class="price pending">Price temporarily unavailable while we verify the listing.</p>'
    : external
      ? '<p class="price pending">Check the seller’s website for its current price and checkout total.</p>'
      : (validPrice ? '<p class="price">' + esc(price.label) + '</p>' : '<p class="price pending">Price details are being verified.</p>');
  const action = suspicious
    ? '<span class="button disabled" aria-disabled="true">Temporarily unavailable</span>'
    : external
      ? '<a class="button primary" href="' + esc(external) + '" target="_blank" rel="noopener noreferrer">Continue to seller checkout ↗</a><p class="note">The seller controls the final price, payment and delivery.</p>'
      : '<a class="button primary" href="' + esc(storeLink) + '">View in LEXDEN NOVA →</a>';
  const warning = indexable
    ? '<p class="note">Review product details and delivery information before completing a purchase.</p>'
    : '<p class="note warning">Some listing information is incomplete or undergoing verification. Rich product data is withheld until details can be trusted.</p>';
  const schemaTag = schema ? '<script type="application/ld+json">' + safeJson(schema) + '</script>' : '';
  const sellerName = plainText(listing ? listing.sellerName : (product.sellerName || product.seller), 120);
  const sellerLine = sellerName
    ? '<p class="trust-line"><strong>Seller</strong><span>' + esc(sellerName) + '</span></p>'
    : '<p class="trust-line"><strong>Seller</strong><span>Identity being verified</span></p>';
  const productType = String(listing ? (listing.physical ? 'PHYSICAL' : 'DIGITAL') : product.productType || '').toUpperCase();
  const deliveryText = listing
    ? plainText(listing.deliveryEstimate || listing.fulfillmentText, 180)
    : (productType === 'PHYSICAL'
      ? plainText(product.physical && product.physical.deliveryEstimate, 180)
      : plainText(product.accessDelivery || product.deliveryFormat || product.format, 180));
  const shippingText = !listing && productType === 'PHYSICAL' && product.physical && Array.isArray(product.physical.shippingCountries)
    ? product.physical.shippingCountries.map(x => plainText(x, 40)).filter(Boolean).join(', ')
    : '';
  const returnsText = plainText(listing ? listing.refundPolicy : (product.refundPolicy || product.returnPolicy || (product.physical && product.physical.returnPolicy)), 220);
  const trustHtml = '<section class="trust-grid" aria-label="Seller and purchase information">' + sellerLine +
    (deliveryText ? '<p class="trust-line"><strong>' + (productType === 'PHYSICAL' ? 'Delivery estimate' : 'Digital access') + '</strong><span>' + esc(deliveryText) + '</span></p>' : '') +
    (shippingText ? '<p class="trust-line"><strong>Ships to</strong><span>' + esc(shippingText) + '</span></p>' : '') +
    (returnsText ? '<p class="trust-line"><strong>Returns / refunds</strong><span>' + esc(returnsText) + '</span></p>' : '<p class="trust-line"><strong>Policies</strong><span>Review the published <a href="https://lexdendigital.github.io/LEXDEN-NOVA/legal/refunds.html">refunds policy</a> and <a href="https://lexdendigital.github.io/LEXDEN-NOVA/legal/terms.html">terms</a>.</span></p>') +
    (external ? '<p class="trust-line"><strong>Checkout</strong><span>Payment and final total are confirmed by the external seller.</span></p>' : '<p class="trust-line"><strong>Checkout</strong><span>Final price and availability are rechecked during checkout.</span></p>') +
    '</section>';
  const tagItems = Array.isArray(product && product.tags) ? product.tags.slice(0, 8).map(t => '<span class="tag">' + esc(String(t).slice(0, 40)) + '</span>').join('') : '';
  const pageTitle = name + ' | LEXDEN NOVA';
  const socialImage = realImage ? ogImage(image) : FALLBACK_IMAGE;
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    '<title>' + esc(pageTitle) + '</title><meta name="description" content="' + esc(description) + '">' +
    '<meta name="robots" content="' + (indexable ? 'index,follow,max-image-preview:large' : 'noindex,follow') + '">' +
    '<link rel="canonical" href="' + esc(canonical) + '"><meta name="theme-color" content="#080b1c">' +
    '<meta property="og:type" content="product"><meta property="og:site_name" content="LEXDEN NOVA">' +
    '<meta property="og:title" content="' + esc(name) + '"><meta property="og:description" content="' + esc(description) + '">' +
    '<meta property="og:image" content="' + esc(socialImage) + '"><meta property="og:url" content="' + esc(canonical) + '">' +
    '<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="' + esc(name) + '">' +
    '<meta name="twitter:description" content="' + esc(description) + '"><meta name="twitter:image" content="' + esc(socialImage) + '">' + schemaTag +
    '<style>:root{color-scheme:dark;--bg:#080b1c;--line:#26304e;--text:#f4f7ff;--muted:#aab5cd;--cyan:#00d9ff;--green:#a3e367}*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 15% 0%,#13234a 0,transparent 38%),var(--bg);color:var(--text);font:16px/1.65 system-ui,-apple-system,Segoe UI,sans-serif}a{color:inherit}a:focus-visible{outline:3px solid var(--cyan);outline-offset:4px}.wrap{width:min(1080px,calc(100% - 32px));margin:auto}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px 0;border-bottom:1px solid var(--line)}.brand{font-weight:850;letter-spacing:.06em;text-decoration:none}.brand span{color:var(--cyan)}.muted,.note{color:var(--muted);font-size:13px}.hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(240px,.8fr);gap:clamp(24px,5vw,64px);align-items:start;padding:clamp(28px,6vw,70px) 0}.art{background:#111a34;border:1px solid var(--line);border-radius:22px;overflow:hidden;aspect-ratio:4/3;display:grid;place-items:center}.art img{width:100%;height:100%;object-fit:contain}.kicker{color:var(--green);font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.crumb{font-size:13px;color:var(--muted);padding-top:18px}h1{font-size:clamp(30px,5vw,48px);line-height:1.12;letter-spacing:-.035em;margin:14px 0 16px}.pill,.tag{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:5px 10px;color:var(--muted);font-size:12px}.price{font-size:clamp(25px,4vw,34px);font-weight:800;margin:20px 0 14px}.pending{font-size:16px;color:#ffdda0}.button{display:inline-flex;align-items:center;justify-content:center;min-height:48px;border-radius:12px;padding:12px 18px;text-decoration:none;font-weight:800;border:1px solid var(--line)}.primary{background:linear-gradient(105deg,var(--cyan),var(--green));color:#07101b;border:0}.disabled{opacity:.6}.warning{border-left:3px solid #f4bd54;padding-left:12px;color:#ffdda0}.tags{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}.trust-grid{display:grid;gap:0;margin:20px 0 8px;border:1px solid var(--line);border-radius:14px;padding:2px 14px;background:rgba(16,22,44,.62)}.trust-line{display:grid;grid-template-columns:minmax(95px,.65fr) minmax(0,1fr);gap:12px;padding:10px 0;margin:0;border-bottom:1px solid var(--line);font-size:13px}.trust-line:last-child{border-bottom:0}.trust-line strong{color:#eef4ff}.trust-line span{color:var(--muted);overflow-wrap:anywhere}.trust-line a{color:#9ceeff}.details{border-top:1px solid var(--line);padding:24px 0 46px}.details h2{font-size:20px}.desc{color:#d1daeb}.foot{border-top:1px solid var(--line);padding:18px 0 26px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;color:var(--muted);font-size:13px}.foot a{color:#9ceeff}@media(max-width:720px){.hero{grid-template-columns:1fr;padding:26px 0 36px;gap:24px}.art{order:-1;aspect-ratio:1.3}.wrap{width:calc(100% - 24px)}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;animation:none!important;transition:none!important}}</style>' +
    '</head><body><div class="wrap"><header class="top"><a class="brand" href="' + esc(SITE_URL) + '">LEXDEN <span>NOVA</span></a><a class="muted" href="' + esc(SITE_URL) + '">Browse marketplace ↗</a></header><main>' +
    '<nav class="crumb" aria-label="Breadcrumb"><a href="' + esc(SITE_URL) + '">Home</a> / ' + esc(category) + '</nav>' +
    '<section class="hero" aria-labelledby="product-title"><div><div class="kicker">' + esc(APP_NAME) + ' marketplace</div><h1 id="product-title">' + esc(name) + '</h1><div class="pill">' + esc(category) + '</div>' +
    priceHtml + action + warning + trustHtml + '<div class="tags">' + tagItems + '</div></div><div class="art">' +
    (realImage ? '<img src="' + esc(image) + '" alt="' + esc(name) + '" fetchpriority="high" decoding="async">' : '<span class="note">Product image is being added.</span>') +
    '</div></section><section class="details"><h2>Product details</h2><p class="desc">' + esc(details || FALLBACK_DESCRIPTION) + '</p>' +
    '<p class="note">Confirm the seller, final price, availability and delivery terms before payment. Third-party offers can change independently.</p></section></main>' +
    '<footer class="foot"><span>© 2026 LEXDEN DIGITAL · LEXDEN NOVA</span><span><a href="' + esc(SITE_URL) + '">Marketplace</a> · <a href="mailto:lexdendigital@gmail.com">Support</a></span></footer></div></body></html>';
}

async function findCreatorListing(id) {
  try {
    const { getDb } = require('./affiliate/shared');
    const { toPublicListing } = require('./creator-listings');
    const db = getDb();
    const snap = await db.collection('products').doc(id).get();
    if (!snap.exists) return null;
    const p = { id: snap.id, ...snap.data() };
    const creator = p.creatorId ? await db.collection('creators').doc(p.creatorId).get() : null;
    return toPublicListing(p, creator && creator.exists ? creator.data() : null);
  } catch (error) {
    console.warn('product-page creator lookup failed:', error && error.message);
    return null;
  }
}
async function handler(req, res) {
  const id = String(req.params && req.params.id || '').trim();
  if (!id || id.length > 160 || id.includes('/')) {
    res.setHeader('X-Robots-Tag', 'noindex');
    return res.status(404).type('text/plain').send('Product not found.');
  }
  const [catalog, settings] = await Promise.all([getCatalogDoc('products'), getCatalogDoc('settings')]);
  if (!catalog || !Array.isArray(catalog.list)) {
    res.setHeader('X-Robots-Tag', 'noindex');
    res.setHeader('Retry-After', '30');
    return res.status(503).type('text/plain').send('Product information is temporarily unavailable. Please try again shortly.');
  }
  const product = catalog.list.find(p => p && String(p.id) === id);
  const listing = product ? null : await findCreatorListing(id);
  if (!listing && (!product || !isPublicCatalogProduct(product))) {
    res.setHeader('X-Robots-Tag', 'noindex');
    return res.status(404).type('text/plain').send('This product is not currently available. Browse the LEXDEN NOVA marketplace for available listings.');
  }
  const html = buildProductPage({ id, product: product || {}, settings, listing });
  const indexable = listing
    ? !!(listing.title && String(listing.description || '').trim().length >= 40 && httpsUrl(listing.images && listing.images[0]) && (listing.price === 0 || Number.isFinite(listing.price)))
    : isIndexableCatalogProduct(product);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
  if (!indexable) res.setHeader('X-Robots-Tag', 'noindex, follow');
  return res.status(200).send(html);
}

module.exports = handler;
module.exports.buildProductPage = buildProductPage;
module.exports.isIndexableCatalogProduct = isIndexableCatalogProduct;
module.exports.isPublicCatalogProduct = isPublicCatalogProduct;
module.exports.isSuspiciousDiscount = isSuspiciousDiscount;
module.exports.effectiveCatalogPrice = effectiveCatalogPrice;
module.exports.priceInfo = priceInfo;
