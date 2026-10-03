# LEXDEN NOVA — Backend Fix Batch (Oct 2, 2026)

Non-UI/UX pass, per your request — UI/UX rebuild is the next batch,
separate zip. Push this over your repo and redeploy on Render.

## What was actually broken (not what the other session guessed)

The earlier session's theory — a Vercel/Render host mismatch or a
field-mapping bug in `cj-products.js` — was wrong. Your field mapping
(`p.sellPrice`, `p.variantNum`, `p.categoryId`) was already correct.

**Real cause:** CJ's search/list endpoint (`/product/listV2`, used by
`nova_cj_search_products`) is a thin preview by design — it legitimately
returns `sellPrice`/`variantNum`/`categoryId` as null for most products.
Full data (price per variant, category, specs) only exists one call
deeper, at `/product/query` + `/product/variant/query` (your
`cj-product.js` already called this correctly). Nothing forced an AI
agent to chain search → detail before importing, so Claude saw nulls at
the search step and concluded it was a bug.

## Fixed

- **New tool: `nova_cj_import_product`.** One atomic call: fetch full
  CJ detail + variants → price it (cost + markup%, or your exact
  override) → hydrate media (see below) → write a complete product to
  `catalog/products` in the exact shape `index.html` actually reads
  (confirmed by reading the real admin form, not assumed) — `category`,
  `itemCode`, `price`, `physical.{stockMode, stockStatus,
  deliveryEstimate, shippingCountries, weight, supplierCost,
  supplierCurrency, cj:{productId, variantId, sku, syncEnabled}}`,
  `specs`, `images`. Defaults `status:"Draft"` so you review before it
  goes live. Safe to re-run on the same pid — updates in place instead
  of erroring.
- **`nova_cj_search_products`'s description now explicitly warns** any
  AI agent that null fields at search-time are normal, not a bug, and
  points it at the import tool.
- **Fixed a real category-filter bug in `catalog.js`:** `nova_list_products`
  was filtering on `p.categoryId`, a field `index.html` never writes
  (it writes `p.category`). Any product saved with only `categoryId`
  would never show up filtered by category. Fixed to check both.
  Also rewrote `productShape` to list the *actual* field names your
  admin form uses, so future tool calls (yours, ChatGPT's, anyone's)
  stop guessing field names.

## New: automatic image fallback (any supplier, not just CJ)

`mcp/lib/media.js` — new shared helper:
- Re-hosts every supplier image/video URL on Cloudinary (your existing
  `z4nut80g` cloud / `lexden-nova` unsigned preset — no new secret), so
  listings survive even if a supplier later deletes/moves the original.
- **If a supplier gives no usable image at all**, generates one with
  Gemini's image model (`gemini-2.5-flash-image`) using the same
  API-key pool already configured for NOVA AI — zero new cost, zero new
  secret — then uploads that to Cloudinary. The import result always
  tells you plainly when a photo is AI-generated vs. real, so you can
  swap it later if it's not good enough.
- **New standalone tool: `nova_resolve_product_image`** — usable any
  time, not just during import. Give it candidate URLs (e.g. ones you
  or an agent found some other way) and it tries those first; give it
  nothing, or ask it to `generate_only`, and it generates one directly.
  Can attach the result to an existing product or just hand back a URL.

**Honest limit:** true "deep web search for a matching photo" needs a
paid search API (Bing/SerpAPI/etc.) — there's no key for that in this
project. I did not fake it. `searchWebForProductImage()` in
`media.js` is stubbed and ready — wiring in a real provider later is a
one-function change, not a redesign.

## ChatGPT connector

No code change was needed — your OAuth server was already generic,
standard OAuth2 (DCR + PKCE), never Claude-specific. It just didn't
have ChatGPT's callback URL allow-listed. Full steps added to
`MCP-SETUP.md` §6b. Once connected, every tool — including the new
import and image tools — works identically from ChatGPT; same server,
same data.

## Still true, unchanged

Everything about physical-product fields (stock mode, shipping
countries, weight, supplier cost/currency, return policy) already
existed correctly in `index.html`'s admin form and is now also what
`nova_cj_import_product` writes — Nova selling both physical and
digital products was already reflected in the schema; this batch makes
the import tool actually populate it instead of leaving it blank.

## Next: the UI/UX rebuild

Separate batch, starting now — the "verified affiliate partner" badge
gating, platform-not-storefront first impression, and per-category
(App/Course/Template/eBook/Software/Service/Physical) product-page
layouts from your other message.
