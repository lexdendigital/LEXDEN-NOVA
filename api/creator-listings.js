// /api/creator-listings.js
//
// LEXDEN NOVA CREATOR — storefront bridge (blueprint §99 step 14, §79).
// PUBLIC, read-only. Returns the creators' PUBLISHED listings in a safe shape.
//
//   GET /api/creator-listings            -> { listings: [...] }
//   GET /api/creator-listings?id=<id>    -> { listing }  (404 if not public)
//
// WHY AN ENDPOINT AND NOT A DIRECT FIRESTORE READ: a product doc's
// publishedSnapshot also holds the private delivery details (uploaded-file id,
// external access URL). Those must reach a buyer ONLY after payment (entitlement
// check in creator-product-download.js), so they are never part of this output,
// and the `products` collection is no longer publicly readable (firestore.rules).
//
// A listing is only public while BOTH are true: the product is PUBLISHED and its
// creator is ACTIVE (a restricted/suspended/revoked seller's listings disappear
// from the storefront immediately).
const { getDb, setCors } = require('./creator/shared');

const MAX_LISTINGS = 500;
const DEFAULT_TTL_MS = 20 * 1000;

function httpsOnly(urls) {
  return (Array.isArray(urls) ? urls : []).filter((u) => typeof u === 'string' && /^https:\/\//i.test(u)).slice(0, 12);
}

/** product doc + creator doc -> the public shape (or null when it must not be public). */
function toPublicListing(product, creator) {
  if (!product || product.status !== 'PUBLISHED' || !product.publishedSnapshot) return null;
  if (!creator || creator.status !== 'ACTIVE') return null;
  const s = product.publishedSnapshot;
  if (!s.title) return null;
  const images = httpsOnly(s.images);
  const physical = s.offeringType === 'PHYSICAL_PRODUCT';
  const ownStock = physical && (s.fulfillmentMode || 'SELLER_STOCK') === 'SELLER_STOCK';
  return {
    id: product.id,
    sellerId: product.creatorId,
    sellerName: creator.displayName || 'Creator',
    sellerUsername: typeof creator.username === 'string' ? creator.username : null,
    sellerVerified: !!creator.verifiedBusiness,
    sellerImage: typeof creator.profileImageUrl === 'string' && /^https:\/\//i.test(creator.profileImageUrl) ? creator.profileImageUrl : null,
    offeringType: s.offeringType || null,
    title: String(s.title).slice(0, 140),
    description: String(s.description || '').slice(0, 5000),
    category: s.category || null,
    images,
    isFree: s.isFree === true,
    price: s.isFree === true ? 0 : (typeof s.price === 'number' ? s.price : null),
    currency: s.currency || null,
    refundPolicy: String(s.refundPolicy || '').slice(0, 2000),
    physical,
    inStock: ownStock ? (typeof s.stock === 'number' ? s.stock > 0 : true) : true,
    processingDays: physical && Number.isInteger(s.processingDays) ? s.processingDays : null,
    shippingOrigin: physical && s.shippingOrigin ? String(s.shippingOrigin).slice(0, 200) : null,
    // Display-only, type-specific facts.
    systemRequirements: s.systemRequirements || null,
    pageCount: Number.isFinite(s.pageCount) ? s.pageCount : null,
    compatibility: s.compatibility || null,
    level: s.level || null,
    modules: Array.isArray(s.modules) ? s.modules.slice(0, 100).map((m) => ({ title: String((m && m.title) || '').slice(0, 200) })) : null,
    turnaround: s.turnaround || null,
    deliverables: s.deliverables || null,
    billingInterval: s.billingInterval || null,
  };
}

function makeHandler(deps = {}) {
  const ttl = deps.ttlMs == null ? DEFAULT_TTL_MS : deps.ttlMs;
  let cache = null;

  async function loadAll(db) {
    if (cache && ttl > 0 && Date.now() - cache.at < ttl) return cache.list;
    const snap = await db.collection('products').where('status', '==', 'PUBLISHED').limit(MAX_LISTINGS).get();
    const products = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const creatorIds = [...new Set(products.map((p) => p.creatorId).filter(Boolean))];
    const creators = new Map();
    await Promise.all(creatorIds.map(async (id) => {
      const c = await db.collection('creators').doc(id).get();
      if (c.exists) creators.set(id, c.data());
    }));
    const list = products.map((p) => toPublicListing(p, creators.get(p.creatorId))).filter(Boolean);
    cache = { at: Date.now(), list };
    return list;
  }

  return async function handler(req, res) {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET') return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' } });
    res.setHeader('Cache-Control', 'public, max-age=15');
    try {
      const list = await loadAll(getDb());
      const id = req.query && req.query.id;
      if (id) {
        const one = list.find((l) => l.id === String(id));
        if (!one) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'No listing found.' } });
        return res.status(200).json({ ok: true, data: { listing: one } });
      }
      return res.status(200).json({ ok: true, data: { listings: list } });
    } catch (e) {
      console.error('creator-listings failed:', e && e.message);
      return res.status(503).json({ ok: false, error: { code: 'LISTINGS_UNAVAILABLE', message: 'Could not load listings right now.' } });
    }
  };
}

module.exports = makeHandler();
module.exports.makeHandler = makeHandler;
module.exports.toPublicListing = toPublicListing;
