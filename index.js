const { APP_NAME, SITE_BASE, DEFAULT_IMAGE, DEFAULT_DESCRIPTION, renderHtml, setCommonHeaders } = require('./_lib/nova');

// Bare-domain fallback (someone shares the link-preview domain itself,
// with no /feed/ or /product/ path). Shows the site-wide card and sends
// visitors straight into the real app's home screen.
module.exports = async (req, res) => {
  const pageUrl = `https://${req.headers.host}/`;
  setCommonHeaders(res);
  res.status(200).send(renderHtml({
    title: `${APP_NAME} — Digital Products Marketplace`,
    description: DEFAULT_DESCRIPTION,
    image: DEFAULT_IMAGE,
    pageUrl,
    deepLink: SITE_BASE,
    appName: APP_NAME,
    type: 'website',
  }));
};
