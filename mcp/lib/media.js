// mcp/lib/media.js
//
// Supplier-agnostic media resolution for product imports (CJ today, any
// future supplier tomorrow). Used by nova_cj_import_product and any later
// nova_<supplier>_import_product tool so this logic is written once.
//
// Order of operations when hydrating a product's media gallery:
//   1. Use whatever image/video URLs the supplier already gave us.
//   2. If NONE came through, generate a product photo with Gemini's image
//      model (reusing the same key-rotation pool as the rest of the app —
//      no new secret, no new cost beyond the Gemini quota already in use)
//      and upload the result to Cloudinary so it has a normal, permanent
//      https://res.cloudinary.com/... URL like every other product image.
//
// NOTE on "deep web search for a matching image": that would need a paid
// search API (Bing/SerpAPI/etc.) that this project does not currently have
// a key for. Rather than silently fake it, this file deliberately only
// implements the re-upload + AI-generation path. Wire in a search provider
// here (searchWebForProductImage, stubbed below) the day a key exists.

const CLOUDINARY_CLOUD_NAME = 'z4nut80g';
const CLOUDINARY_UPLOAD_PRESET = 'lexden-nova';
const { getApiKeys, callGeminiWithRotation } = require('../../api/gemini-shared');

const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';

/** Re-hosts a remote image/video URL on Cloudinary (so it survives even if
 * the original supplier later deletes/moves it) by handing Cloudinary the
 * URL directly — Cloudinary fetches it server-side, we never download the
 * bytes ourselves. */
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

/** Uploads a base64-encoded image (e.g. straight out of Gemini's response)
 * to Cloudinary, returning a normal https URL. */
async function uploadBase64ToCloudinary(base64, mimeType) {
  try {
    const form = new URLSearchParams();
    form.set('file', `data:${mimeType || 'image/png'};base64,${base64}`);
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

/** Generates a clean, catalog-style product photo with Gemini's image model
 * when a supplier gave us no usable media at all, then uploads it to
 * Cloudinary. Returns { ok, url } or { ok:false, error }. */
async function generateProductImage({ name, description, specs }) {
  const keys = getApiKeys();
  if (keys.length === 0) return { ok: false, error: 'no_gemini_keys_configured' };

  const specLine = specs && Object.keys(specs).length
    ? ` Key details: ${Object.entries(specs).slice(0, 6).map(([k, v]) => `${k}: ${v}`).join(', ')}.`
    : '';
  const prompt = `Generate one realistic, clean e-commerce product photo of: ${name}.${description ? ` ${description.slice(0, 300)}.` : ''}${specLine} Plain neutral studio background, centered, well-lit, no text, no watermark, no logo, photorealistic.`;

  const r = await callGeminiWithRotation(
    keys,
    {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE'] },
    },
    GEMINI_IMAGE_MODEL,
  );
  if (!r.ok) return { ok: false, error: r.error || 'gemini_image_failed' };

  const parts = r.data?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find((p) => p.inlineData && p.inlineData.data);
  if (!imgPart) return { ok: false, error: 'no_image_in_gemini_response' };

  const up = await uploadBase64ToCloudinary(imgPart.inlineData.data, imgPart.inlineData.mimeType);
  if (!up.ok) return up;
  return { ok: true, url: up.url, generated: true };
}

/** Placeholder for a future real web-image-search provider. Deliberately
 * returns ok:false today — see note at top of file. Keeping this as a named
 * function (rather than skipping the step entirely) means wiring in a real
 * provider later is a one-function change, not a re-design. */
async function searchWebForProductImage(/* { name, brand } */) {
  return { ok: false, error: 'web_image_search_not_configured' };
}

/** Takes whatever raw media URLs a supplier gave us (images first, we treat
 * the first as cover) and returns up to 8 usable, Cloudinary-hosted URLs.
 * If the supplier gave us nothing at all, falls back to web search (if
 * configured) then AI generation, so no imported product is ever left with
 * an empty gallery. */
async function hydrateMediaGallery({ supplierImages = [], supplierVideo, name, description, specs }) {
  const gallery = [];
  const rawList = [...supplierImages.filter(Boolean)];
  if (supplierVideo) rawList.push(supplierVideo);

  for (const url of rawList.slice(0, 8)) {
    const up = await uploadRemoteUrlToCloudinary(url);
    gallery.push(up.ok ? up.url : url); // keep the original link if re-hosting fails, rather than dropping it
  }

  if (gallery.length === 0) {
    const found = await searchWebForProductImage({ name });
    if (found.ok) {
      gallery.push(found.url);
    } else {
      const gen = await generateProductImage({ name, description, specs });
      if (gen.ok) gallery.push(gen.url);
    }
  }

  return { images: gallery, usedFallback: rawList.length === 0 };
}

module.exports = {
  uploadRemoteUrlToCloudinary,
  uploadBase64ToCloudinary,
  generateProductImage,
  searchWebForProductImage,
  hydrateMediaGallery,
};
