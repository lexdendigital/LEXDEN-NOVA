const {
  SITE_URL, APP_NAME, FALLBACK_IMAGE, FALLBACK_DESCRIPTION,
  getCatalogDoc, firstParagraph, ogImage, renderRedirectPage,
} = require('./_shared');

module.exports = async (req, res) => {
  const id = String(req.query.id || '');
  const destUrl = id ? `${SITE_URL}#feed/${encodeURIComponent(id)}` : SITE_URL;
  const canonicalUrl = `https://${req.headers.host}/feed/${encodeURIComponent(id)}`;

  let title = APP_NAME;
  let description = FALLBACK_DESCRIPTION;
  let image = FALLBACK_IMAGE;

  if (id) {
    const settings = await getCatalogDoc('settings');
    const feed = settings && Array.isArray(settings.feed) ? settings.feed : [];
    const post = feed.find(p => p && String(p.id) === id);
    if (post) {
      title = post.title || title;
      description = firstParagraph(post.body) || description;
      const media = Array.isArray(post.media) ? post.media : [];
      const firstImage = media.find(m => m && m.type !== 'video' && m.url);
      if (firstImage) image = ogImage(firstImage.url);
    }
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Short public cache — a crawler that re-fetches within a minute gets a
  // fast cached response; an admin edit to the post still shows up within
  // a minute rather than being stuck behind a long-lived cache.
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
  res.status(200).send(renderRedirectPage({
    title, description, image, canonicalUrl, destUrl, type: 'article',
  }));
};
