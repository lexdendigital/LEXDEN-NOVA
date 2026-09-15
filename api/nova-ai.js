// /api/nova-ai.js
//
// CONVERTED FOR RENDER: this used to be a Vercel Edge function
// (`export const config = { runtime: 'edge' }`, `export default async
// function handler(request)` returning a Fetch-API `Response`). Render's
// free Node Web Service runs plain Node, not the Edge runtime, so this is
// now a normal Express-style `(req, res)` handler — same Gemini call,
// key-rotation, image-grounding and system-prompt logic as before, just
// wired to req/res instead of Request/Response. CORS/OPTIONS are handled
// once, globally, by server.js's `cors()` middleware — this file no
// longer sets its own CORS headers.

// Gemini key-rotation logic now lives in gemini-shared.js (shared with
// the new Affiliate Assistant, api/affiliate/ai.js) — same behavior as
// before, just no longer duplicated between the two files.
const { getApiKeys, callGeminiWithRotation } = require('./gemini-shared');

/* ============================================================
   IMAGE GROUNDING
   Fetches a capped, prioritized set of product/feed COVER images
   server-side and turns them into Gemini inline_data parts, so
   Gemini's answers are grounded in what the photos actually show
   — not just admin-typed specs/descriptions.
   ============================================================ */
const MAX_PRODUCT_IMAGES = 8;
const MAX_FEED_IMAGES = 6;
const MAX_TOTAL_IMAGES = 12;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // 3MB safety cap per image
const IMAGE_FETCH_TIMEOUT_MS = 4000;

const imageCache = new Map(); // url -> {mime, base64}
const IMAGE_CACHE_MAX = 300;

// Render runs plain Node (not the Edge runtime), so Buffer is available —
// used instead of the Edge-only btoa()/Uint8Array chunking trick.
function arrayBufferToBase64(buffer) {
  return Buffer.from(buffer).toString("base64");
}

async function fetchImageInline(url) {
  if (!url) return null;
  const cached = imageCache.get(url);
  if (cached) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const contentType = (res.headers.get("content-type") || "").split(";")[0].trim();
    if (!contentType.startsWith("image/")) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) return null;
    const entry = { mime: contentType, base64: arrayBufferToBase64(buf) };
    if (imageCache.size >= IMAGE_CACHE_MAX) {
      const firstKey = imageCache.keys().next().value;
      imageCache.delete(firstKey);
    }
    imageCache.set(url, entry);
    return entry;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

function pickImageCandidates(context) {
  const products = Array.isArray(context.products) ? context.products : [];
  const feed = Array.isArray(context.feed) ? context.feed : [];
  const topCategory = context.shopper?.topInterestCategory || context.shopper?.topCategory || null;

  const sortedProducts = topCategory
    ? [...products].sort((a, b) => (b.category === topCategory) - (a.category === topCategory))
    : products;

  const candidates = [];
  for (const p of sortedProducts.slice(0, MAX_PRODUCT_IMAGES)) {
    const img = (p.media || []).find(m => m.type === "image");
    if (img?.url) candidates.push({ url: img.url, label: `product "${p.name}"` });
  }
  for (const f of feed.slice(0, MAX_FEED_IMAGES)) {
    const img = (f.media || []).find(m => m.type === "image");
    if (img?.url) candidates.push({ url: img.url, label: `feed post "${f.title}"` });
  }
  return candidates.slice(0, MAX_TOTAL_IMAGES);
}

async function buildImageParts(context) {
  const candidates = pickImageCandidates(context);
  if (candidates.length === 0) return [];

  const results = await Promise.allSettled(candidates.map(c => fetchImageInline(c.url)));
  const parts = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value) {
      parts.push({ text: `[Reference photo — ${candidates[i].label}]` });
      parts.push({ inline_data: { mime_type: r.value.mime, data: r.value.base64 } });
    }
  });
  return parts;
}

function buildSystemPrompt(context) {
  const products = (context.products || [])
    .map(p => {
      const price = p.free ? "Free" : `$${p.priceUSD}${p.salePriceUSD ? ` (sale $${p.salePriceUSD})` : ""}`;
      const specs = Object.entries(p.specs || {}).map(([k, v]) => `${k}: ${v}`).join(", ");
      return `- ${p.name} [${p.category}] — ${price}, rating ${p.rating}/5. ${specs ? "Specs: " + specs + ". " : ""}${p.description || ""}`;
    })
    .join("\n");

  const feedSummary = (context.feed || [])
    .map(f => `- ${f.title}${f.productId ? ` (about product ${f.productId})` : ""}: ${(f.body || "").slice(0, 150)}`)
    .join("\n");

  const faqs = (context.faqs || []).map(f => `Q: ${f.q}\nA: ${f.a}`).join("\n");
  const appName = context.content?.appName || "LEXDEN NOVA";
  const currency = context.currency || "USD";

  return `You are NOVA, the friendly in-app shopping assistant for ${appName}, a digital products and gadgets marketplace.
Speak naturally and concisely — this is a mobile chat widget, not an essay. Ground every answer in the catalog, feed, and FAQ
data below; never invent products, prices, or policies that aren't listed. Prices shown to you are in USD; the shopper's
selected display currency is ${currency}, so mention amounts in a natural way rather than doing currency math yourself unless
asked. Some reference photos of products/feed posts may be attached below the catalog as visual context — use them only to
describe appearance more accurately (color, style, packaging, etc.) when it's relevant to what's being asked; the shopper
themselves cannot send you photos, so never ask them to show or upload an image. If a shopper asks something the
catalog/FAQs/photos can't answer, say so honestly and suggest contacting support instead of guessing.
Format your reply as clean HTML using only <p>, <strong>, <em>, <ul>, <li>, and <br> tags — no markdown, no code fences.

CATALOG:
${products || "(no published products yet)"}

RECENT FEED POSTS:
${feedSummary || "(no feed posts yet)"}

FAQs:
${faqs || "(no FAQs yet)"}`;
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "POST") {
    return res.status(405).json({ text: "Method not allowed" });
  }

  const { message, context } = req.body || {};
  if (!message || typeof message !== "string") {
    return res.status(400).json({ text: "No message provided." });
  }

  const keys = getApiKeys();
  if (keys.length === 0) {
    return res.status(500).json({
      text: "Server is missing its API key(s) — please configure GEMINI_API_KEYS (or GEMINI_API_KEY) in Render → Environment.",
    });
  }

  try {
    const ctx = context || {};
    const imageParts = await buildImageParts(ctx);

    const requestBody = {
      contents: [
        {
          role: "user",
          parts: [...imageParts, { text: message.slice(0, 2000) }],
        },
      ],
      systemInstruction: {
        parts: [{ text: buildSystemPrompt(ctx) }],
      },
      generationConfig: {
        maxOutputTokens: 600,
      },
    };

    const result = await callGeminiWithRotation(keys, requestBody);

    if (!result.ok) {
      console.error("Gemini API error after key rotation:", result.status, result.error);
      return res.status(200).json({ text: "I couldn't reach my full brain just now — please try again shortly." });
    }

    const html = result.data.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, I couldn't generate a response.";
    return res.status(200).json({ html });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(200).json({ text: "Something went wrong reaching Gemini. Try again in a moment." });
  }
};
