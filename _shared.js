// Shared helpers for LEXDEN NOVA's link-preview microsite.
//
// WHY THIS EXISTS: the real app (LEXDEN NOVA) is a client-rendered SPA on
// GitHub Pages using hash routing (#feed/123, #product/123). A hash isn't
// even sent to the server, so GitHub Pages always serves the exact same
// static index.html — with the exact same generic og:title/og:image — no
// matter which post or product someone shares. Every chat app's link
// unfurler (WhatsApp, Telegram, Facebook, X, iMessage, etc.) reads meta
// tags via a plain HTTP GET; none of them run the SPA's JavaScript. So a
// shared feed/product link always showed the same generic site card.
//
// This microsite is the fix: /feed/:id and /product/:id here are real
// server routes. A crawler hitting them gets that specific post's real
// title, first paragraph, and image in the meta tags. A real person's
// browser gets an instant redirect straight into the SPA at the right
// screen.

const SITE_URL = 'https://lexdendigital.github.io/LEXDEN-NOVA/index.html';
const APP_NAME = 'LEXDEN NOVA';
const FALLBACK_IMAGE = 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=1200&h=630&fit=crop';
const FALLBACK_DESCRIPTION = 'Discover, compare and buy the best digital courses, tools and bundles. Curated by LEXDEN NOVA.';
const FIRESTORE_PROJECT = 'lexden-nova';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Minimal Firestore REST "Value" decoder — only the shapes this app's
// catalog documents actually use (strings, numbers, bools, arrays, maps).
function fsValue(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fsValue);
  if ('mapValue' in v) return fsFields(v.mapValue.fields || {});
  return null;
}
function fsFields(fields) {
  const out = {};
  for (const k in fields) out[k] = fsValue(fields[k]);
  return out;
}

// Fetches one document from `catalog/{docId}` (e.g. "settings", "products")
// and returns it as a plain JS object, or null if it doesn't exist / the
// request fails. Never throws — callers always have a safe generic
// fallback to use instead.
async function getCatalogDoc(docId) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents/catalog/${docId}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    if (!data || !data.fields) return null;
    return fsFields(data.fields);
  } catch (e) {
    console.warn('getCatalogDoc failed for', docId, e);
    return null;
  }
}

// First real paragraph of a body, trimmed to a safe meta-description
// length — mirrors the app's own firstParagraph() so previews read the
// same way whether generated client-side (native share text) or here
// (crawler-facing meta tags).
function firstParagraph(text, maxLen) {
  maxLen = maxLen || 200;
  const para = String(text || '').split(/\n\s*\n/).map(s => s.trim()).find(Boolean) || String(text || '').trim();
  return para.length > maxLen ? para.slice(0, maxLen - 1).trim() + '…' : para;
}

// Forces a Cloudinary delivery URL to a fixed 1200x630 JPG — the safe,
// universally-supported shape for a social share image. (The app's own
// cldOptimize() uses f_auto, which can hand a crawler a WebP/AVIF it
// doesn't render — fine for in-app <img> tags, risky for OG images.)
function ogImage(url) {
  if (!url || typeof url !== 'string') return FALLBACK_IMAGE;
  const marker = '/upload/';
  const idx = url.indexOf(marker);
  if (!url.includes('res.cloudinary.com') || idx === -1) return url;
  return url.slice(0, idx + marker.length) + 'c_fill,w_1200,h_630,f_jpg,q_auto/' + url.slice(idx + marker.length);
}

function renderRedirectPage({ title, description, image, canonicalUrl, destUrl, type }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonicalUrl)}">

<meta property="og:type" content="${esc(type)}">
<meta property="og:site_name" content="${APP_NAME}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="${esc(canonicalUrl)}">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image)}">

<meta http-equiv="refresh" content="0; url=${esc(destUrl)}">
<script>location.replace(${JSON.stringify(destUrl)});</script>
<style>
  body{background:#0a0e27;color:#e8eefc;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px}
  a{color:#00d9ff}
</style>
</head>
<body>
<div>
  <p>Opening ${esc(title)}…</p>
  <p><a href="${esc(destUrl)}">Tap here if it doesn't redirect automatically</a></p>
</div>
</body>
</html>`;
}

module.exports = {
  SITE_URL, APP_NAME, FALLBACK_IMAGE, FALLBACK_DESCRIPTION,
  esc, getCatalogDoc, firstParagraph, ogImage, renderRedirectPage,
};
