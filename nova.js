// Shared helpers for the LEXDEN NOVA link-preview redirector.
//
// Why this exists: GitHub Pages only serves static files, so the real
// app's <meta> og:tags are baked in once and never change per post/
// product. WhatsApp's preview bot fetches a URL and reads whatever
// meta tags are in the raw HTML response — it does not run JavaScript.
// These tiny serverless routes sit in front of the real PWA: they pull
// the specific post/product straight from Firestore's public REST API
// (no secret key needed — same public-read data the app itself uses),
// print a small HTML page with THAT item's real title/description/
// image in the OG tags, then instantly forward real visitors into the
// actual app via a hash route. Crawlers stop at the HTML; humans never
// notice the hop.

const PROJECT_ID = 'lexden-nova';
const APP_NAME = 'LEXDEN NOVA';
const SITE_BASE = 'https://lexdendigital.github.io/LEXDEN-NOVA/index.html';
const DEFAULT_IMAGE = 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=1200&h=630&fit=crop';
const DEFAULT_DESCRIPTION = 'Discover, compare and buy the best digital courses, tools and bundles. Curated by LEXDEN NOVA.';

// ---- Firestore REST (public read, no API key required) ----

function fromFirestoreValue(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFirestoreValue);
  if ('mapValue' in v) {
    const out = {};
    const fields = v.mapValue.fields || {};
    for (const k in fields) out[k] = fromFirestoreValue(fields[k]);
    return out;
  }
  return null;
}

function fromFirestoreDoc(doc) {
  const out = {};
  const fields = (doc && doc.fields) || {};
  for (const k in fields) out[k] = fromFirestoreValue(fields[k]);
  return out;
}

// 5s timeout so a slow/unreachable Firestore never hangs the redirect —
// worst case, the visitor still gets bounced into the app with generic
// site-wide OG tags instead of the specific post/product ones.
async function getFirestoreDoc(collection, id) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${collection}/${id}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.error) return null;
    return fromFirestoreDoc(json);
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ---- text/image helpers (mirrors logic already in index.html) ----

function firstParagraph(text, maxLen) {
  maxLen = maxLen || 200;
  const para = (text || '').split(/\n\s*\n/).map(s => s.trim()).find(Boolean) || (text || '').trim();
  return para.length > maxLen ? para.slice(0, maxLen - 1).trim() + '…' : para;
}

// Crops/optimizes Cloudinary URLs to a proper 1200x630 social-card size.
// Non-Cloudinary URLs (or anything malformed) pass through untouched.
function cldOg(url) {
  if (!url || typeof url !== 'string') return url;
  const marker = '/upload/';
  const idx = url.indexOf(marker);
  if (!url.includes('res.cloudinary.com') || idx === -1) return url;
  if (/\/upload\/[^/]*f_auto/.test(url)) return url;
  return url.slice(0, idx + marker.length) + 'f_auto,q_auto,w_1200,h_630,c_fill/' + url.slice(idx + marker.length);
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---- the actual HTML shell every route returns ----

function renderHtml({ title, description, image, pageUrl, deepLink, appName, type }) {
  const t = escapeHtml(title);
  const d = escapeHtml(description);
  const img = escapeHtml(image);
  const u = escapeHtml(pageUrl);
  const a = escapeHtml(appName);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${t}</title>
<meta name="description" content="${d}">
<link rel="canonical" href="${u}">

<meta property="og:type" content="${type || 'website'}">
<meta property="og:site_name" content="${a}">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:image" content="${img}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="${u}">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${img}">

<meta http-equiv="refresh" content="0; url=${escapeHtml(deepLink)}">
<script>location.replace(${JSON.stringify(deepLink)});</script>
<style>
  body{background:#0a0e27;color:#e8eefc;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px}
  a{color:#00d9ff}
</style>
</head>
<body>
<div>
  <p>Opening ${t}…</p>
  <p><a href="${escapeHtml(deepLink)}">Tap here if it doesn't redirect automatically</a></p>
</div>
</body>
</html>`;
}

function setCommonHeaders(res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Short client cache, longer CDN cache with background revalidation —
  // new posts show up in previews within minutes without hammering
  // Firestore on every single share-link tap.
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=600, stale-while-revalidate=86400');
}

module.exports = {
  PROJECT_ID, APP_NAME, SITE_BASE, DEFAULT_IMAGE, DEFAULT_DESCRIPTION,
  getFirestoreDoc, firstParagraph, cldOg, escapeHtml, renderHtml, setCommonHeaders,
};
