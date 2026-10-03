// mcp/lib/mediaRehost.js
//
// Re-hosts a remote supplier image URL on Cloudinary (same cloud/unsigned
// preset index.html's own client-side uploads already use — see E01 in
// mcp/tools/misc.js and _shared.js's buildOgImage()) so an imported
// product's gallery survives even if the supplier later deletes or moves
// the original file.
//
// Deliberately does NOT generate images — nova_upload_product_image
// already covers "no usable supplier image" by having the calling AI
// agent generate one and upload it with clear alt text (see that tool's
// description in mcp/tools/catalog.js). This file only makes real,
// supplier-given images durable; it never invents one.

const CLOUDINARY_CLOUD_NAME = 'z4nut80g';
const CLOUDINARY_UPLOAD_PRESET = 'lexden-nova';

/** Hands Cloudinary a remote URL directly (Cloudinary fetches it
 * server-side — we never download the bytes ourselves) and returns a
 * permanent https://res.cloudinary.com/... URL. On any failure, returns
 * { ok: false } so the caller can fall back to the original URL rather
 * than lose the image entirely. */
async function uploadRemoteUrlToCloudinary(sourceUrl) {
  if (!sourceUrl) return { ok: false, error: 'no_url' };
  try {
    const form = new URLSearchParams();
    form.set('file', sourceUrl);
    form.set('upload_preset', CLOUDINARY_UPLOAD_PRESET);
    const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/auto/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.secure_url) {
      return { ok: false, error: (data && (data.error?.message || JSON.stringify(data))) || `HTTP ${res.status}` };
    }
    return { ok: true, url: data.secure_url };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Re-hosts a batch of supplier URLs, keeping the original URL for any
 * individual rehost that fails rather than dropping the image. Runs with
 * limited concurrency so an import with many images doesn't open dozens
 * of simultaneous Cloudinary requests. */
async function rehostAll(urls, concurrency = 4) {
  const out = new Array(urls.length);
  let i = 0;
  async function worker() {
    while (i < urls.length) {
      const idx = i++;
      const up = await uploadRemoteUrlToCloudinary(urls[idx]);
      out[idx] = up.ok ? up.url : urls[idx];
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return out;
}

module.exports = { uploadRemoteUrlToCloudinary, rehostAll };
