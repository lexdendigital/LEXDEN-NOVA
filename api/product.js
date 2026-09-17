const {
  SITE_URL, APP_NAME, FALLBACK_IMAGE, FALLBACK_DESCRIPTION,
  getCatalogDoc, firstParagraph, ogImage, renderRedirectPage,
} = require('./_shared');

module.exports = async (req, res) => {
  const id = String(req.query.id || '');
  const destUrl = id ? `${SITE_URL}#product/${encodeURIComponent(id)}` : SITE_URL;
  const canonicalUrl = `https://${req.headers.host}/product/${encodeURIComponent(id)}`;

  let title = APP_NAME;
  let description = FALLBACK_DESCRIPTION;
  let image = FALLBACK_IMAGE;

  if (id) {
    const catalog = await getCatalogDoc('products');
    const list = catalog && Array.isArray(catalog.list) ? catalog.list : [];
    const product = list.find(p => p && String(p.id) === id);
    if (product) {
      title = product.name || title;
      description = firstParagraph(product.description, 200) || description;
      if (product.image) image = ogImage(product.image);
    }
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
  res.status(200).send(renderRedirectPage({
    title, description, image, canonicalUrl, destUrl, type: 'product',
  }));
};
