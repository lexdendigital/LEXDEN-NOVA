const {
  APP_NAME, SITE_BASE, DEFAULT_IMAGE, DEFAULT_DESCRIPTION,
  getFirestoreDoc, firstParagraph, cldOg, renderHtml, setCommonHeaders,
} = require('../_lib/nova');

module.exports = async (req, res) => {
  const id = req.query.id;

  let title = APP_NAME;
  let description = DEFAULT_DESCRIPTION;
  let image = DEFAULT_IMAGE;

  if (id) {
    const settings = await getFirestoreDoc('catalog', 'settings');
    const feed = Array.isArray(settings && settings.feed) ? settings.feed : [];
    const post = feed.find(p => p && p.id === id);
    if (post) {
      title = post.title || title;
      description = firstParagraph(post.body || '', 200) || description;
      const media = Array.isArray(post.media) ? post.media : [];
      const cover = media.find(m => m && m.type !== 'video' && m.url);
      if (cover) image = cldOg(cover.url);
    }
  }

  const deepLink = `${SITE_BASE}#feed/${encodeURIComponent(id || '')}`;
  const pageUrl = `https://${req.headers.host}/feed/${encodeURIComponent(id || '')}`;

  setCommonHeaders(res);
  res.status(200).send(renderHtml({
    title, description, image, pageUrl, deepLink, appName: APP_NAME, type: 'article',
  }));
};
