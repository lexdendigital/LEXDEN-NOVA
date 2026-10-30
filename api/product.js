const {
  SITE_URL, APP_NAME, FALLBACK_IMAGE, FALLBACK_DESCRIPTION,
  getCatalogDoc, firstParagraph, ogImage, renderRedirectPage,
} = require('./_shared');

module.exports = async (req, res) => {
  const id = String(req.query.id || '');
  let destinationProductId = id;
  let canonicalProductId = id;

  let title = APP_NAME;
  let description = FALLBACK_DESCRIPTION;
  let image = FALLBACK_IMAGE;
  let found = false;
  let catalogRead = false;

  if (id) {
    const catalog = await getCatalogDoc('products');
    catalogRead = !!(catalog && Array.isArray(catalog.list));
    const list = catalog && Array.isArray(catalog.list) ? catalog.list : [];
    const product = list.find(p => p && String(p.id) === id) || list.find(p => p && String(p.shareId || '') === id);
    if (product) {
      found = true;
      destinationProductId = String(product.shareId || product.id);
      canonicalProductId = String(product.shareId || product.id);
      title = product.seoTitle || product.name || title;
      description = firstParagraph(product.metaDescription || product.shortDescription || product.description, 200) || description;
      const mainImage = product.image || (Array.isArray(product.gallery) && (product.gallery.find(item => item && item.type !== 'video' && item.url) || {}).url) || (Array.isArray(product.images) ? product.images[0] : '');
      if (mainImage) image = ogImage(mainImage);
    } else {
      // Not a catalog product: it may be a creator listing (public, sanitised data only).
      try {
        const { getDb } = require('./affiliate/shared');
        const { toPublicListing } = require('./creator-listings');
        const ps = await getDb().collection('products').doc(id).get();
        if (ps.exists) {
          const prod = { id: ps.id, ...ps.data() };
          const cs = prod.creatorId ? await getDb().collection('creators').doc(prod.creatorId).get() : null;
          const l = toPublicListing(prod, cs && cs.exists ? cs.data() : null);
          if (l) {
            found = true;
            title = l.title || title;
            description = firstParagraph(l.description, 200) || description;
            if (l.images && l.images[0]) image = ogImage(l.images[0]);
          }
        }
      } catch (e) { catalogRead = false; /* keep the default preview; never call it missing on an error */ }
    }
  }

  const destUrl = id ? `${SITE_URL}#product/${encodeURIComponent(destinationProductId)}` : SITE_URL;
  // The full product page lives on the Pages host (see scripts/generate-product-share-pages.js).
  // This Render URL is only a share/redirect link, so its canonical points there to keep
  // Google from splitting one product across two hosts.
  const canonicalUrl = `${SITE_URL.replace(/index\.html$/, '')}product/${encodeURIComponent(canonicalProductId)}/`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
  // An id that is definitely not in the catalog (demo items, deleted products) is a real 404 so
  // Google drops it, but only when the catalog was read fine, never on a temporary error.
  const missing = !!id && catalogRead && !found;
  const page = renderRedirectPage({
    title, description, image, canonicalUrl, destUrl, type: 'product',
  });
  res.status(missing ? 404 : 200).send(missing ? page.replace('</head>', '<meta name="robots" content="noindex">\n</head>') : page);
};
