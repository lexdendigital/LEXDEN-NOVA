export const config = {
  runtime: 'edge', // Runs on Vercel's global edge network
};

const GEMINI_MODEL = "gemini-2.5-flash"; // multimodal — accepts image parts alongside text

// Exact origins that are always allowed (add your custom domain here if you buy one)
const ALLOWED_ORIGINS = [
  "https://lexdendigital.github.io",
  "https://lexden-nova.vercel.app",
];

// Every Vercel preview/branch deployment gets its own random subdomain
// (e.g. lexden-nova-8kjmtzjvj-lexdendigitals-projects.vercel.app), so instead
// of listing each one, allow anything under your own project/team.
function isAllowedOrigin(origin) {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const host = new URL(origin).hostname;
    return host.startsWith("lexden-nova-") && host.endsWith("-lexdendigitals-projects.vercel.app");
  } catch {
    return false;
  }
}

function corsHeaders(origin) {
  const allow = isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

/* ============================================================
   MULTI-KEY ROTATION
   Supports THREE ways of configuring keys in Vercel, so however
   you paste your ~30 keys in, it works:
     1) GEMINI_API_KEYS = "key1,key2,key3,..."  (one env var, comma
        or newline separated — easiest for 30 keys)
     2) GEMINI_API_KEY_1 ... GEMINI_API_KEY_30  (one env var per key)
     3) GEMINI_API_KEY  (single legacy key — still works alongside
        the above, and on its own if that's all you have)
   On a rate-limit (429) or server error (5xx) from Gemini, the
   handler automatically retries with the NEXT key instead of
   failing the shopper's message. A warm edge instance also
   rotates its *starting* key between requests, so load spreads
   across the whole pool over time instead of hammering key #1.
   ============================================================ */
function getApiKeys() {
  const keys = [];
  const bulk = process.env.GEMINI_API_KEYS;
  if (bulk) {
    bulk.split(/[,\n]/).map(s => s.trim()).filter(Boolean).forEach(k => keys.push(k));
  }
  for (let i = 1; i <= 30; i++) {
    const v = process.env[`GEMINI_API_KEY_${i}`];
    if (v && v.trim()) keys.push(v.trim());
  }
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()) {
    keys.push(process.env.GEMINI_API_KEY.trim());
  }
  return [...new Set(keys)]; // de-dupe in case the same key appears twice
}

// Rotating start-index, kept in module scope so it persists across
// requests on the same warm edge instance (best-effort — not a hard
// guarantee across instances, just spreads load in practice).
let rotateCursor = 0;

// Cap how many keys we'll actually try per single request, so one
// unlucky message can't chain through all 30 keys and time out the
// function. With 30 keys configured this tries 8 before giving up —
// plenty of fallback room without a slow reply.
const MAX_KEY_ATTEMPTS = 8;
const PER_ATTEMPT_TIMEOUT_MS = 9000;

async function callGeminiWithRotation(keys, requestBody) {
  if (keys.length === 0) {
    return { ok: false, status: 500, error: "no_keys" };
  }
  const attempts = Math.min(MAX_KEY_ATTEMPTS, keys.length);
  const startIdx = rotateCursor % keys.length;
  rotateCursor = (rotateCursor + 1) % keys.length;

  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    const key = keys[(startIdx + i) % keys.length];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PER_ATTEMPT_TIMEOUT_MS);
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        }
      );
      clearTimeout(timer);

      if (res.ok) {
        const data = await res.json();
        return { ok: true, data };
      }

      // Rate-limited or transient server error → try the next key.
      if (res.status === 429 || res.status >= 500) {
        lastErr = { status: res.status, body: await res.text().catch(() => "") };
        continue;
      }

      // A 400 (bad request/payload) or 403 (invalid/revoked key) won't be
      // fixed by retrying the same payload on the same key family in most
      // cases — but 403 specifically COULD mean just this one key is bad,
      // so still fall through to the next key for that case; anything
      // else we treat as non-retryable and stop.
      if (res.status === 403) {
        lastErr = { status: res.status, body: await res.text().catch(() => "") };
        continue;
      }
      lastErr = { status: res.status, body: await res.text().catch(() => "") };
      break;
    } catch (err) {
      clearTimeout(timer);
      lastErr = { status: 0, body: String(err) };
      continue; // network error / timeout on this key — try the next one
    }
  }
  return { ok: false, status: lastErr?.status || 500, error: lastErr };
}

/* ============================================================
   IMAGE GROUNDING
   Fetches a capped, prioritized set of product/feed COVER images
   server-side and turns them into Gemini inline_data parts, so
   Gemini's answers are grounded in what the photos actually show
   — not just admin-typed specs/descriptions. This is NOT a
   shopper-facing feature: shoppers never upload anything, chat
   stays text-in/text-out. It's purely enrichment of what Gemini
   already knows about the catalog.

   Kept deliberately capped + cached so a chat reply still feels
   instant:
     - only IMAGE media is fetched (video/embeds skipped — too
       heavy for a quick inline vision call)
     - one cover image per product/feed post, not the whole gallery
     - hard cap on total images per request
     - per-image fetch timeout so one slow URL can't stall the reply
     - tiny in-memory cache (per warm instance) so the same popular
       product/feed cover isn't re-downloaded on every message
   ============================================================ */
const MAX_PRODUCT_IMAGES = 8;
const MAX_FEED_IMAGES = 6;
const MAX_TOTAL_IMAGES = 12;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // 3MB safety cap per image
const IMAGE_FETCH_TIMEOUT_MS = 4000;

const imageCache = new Map(); // url -> {mime, base64}
const IMAGE_CACHE_MAX = 300;

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
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
    if (!contentType.startsWith("image/")) return null; // skip video/other — vision grounding is for photos
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

// Picks which products/feed posts get an image fetched, biasing toward
// whatever the shopper actually seems interested in (so the images that
// DO make it into the request are the ones most likely to matter for
// this conversation), then falls back to catalog order.
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

export default async function handler(request) {
  const origin = request.headers.get("Origin") || "";

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(origin) });
  }
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders(origin) });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ text: "Bad request." }), {
      status: 400, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  }

  const { message, context } = body || {};
  if (!message || typeof message !== "string") {
    return new Response(JSON.stringify({ text: "No message provided." }), {
      status: 400, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  }

  const keys = getApiKeys();
  if (keys.length === 0) {
    return new Response(JSON.stringify({ text: "Server is missing its API key(s) — please configure GEMINI_API_KEYS (or GEMINI_API_KEY) in Vercel settings." }), {
      status: 500, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
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
      return new Response(JSON.stringify({ text: "I couldn't reach my full brain just now — please try again shortly." }), {
        status: 200, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    const html = result.data.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, I couldn't generate a response.";

    return new Response(JSON.stringify({ html }), {
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  } catch (err) {
    console.error("Handler error:", err);
    return new Response(JSON.stringify({ text: "Something went wrong reaching Gemini. Try again in a moment." }), {
      status: 200, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  }
}
