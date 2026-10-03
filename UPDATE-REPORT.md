# Lexden Nova update report

Updated 3 October 2026. This report describes the source in this archive; it does not claim a Render deployment or live-service acceptance.

## Implemented

- Corrected CJ `listV2` query parameters and flattened `content[].productList[]` before mapping. Imports now preserve available supplier descriptions, categories, options, dimensions, weights, packaging/customs fields, supplier cost, stock lookup status, media, and supplier variant IDs. CJ products are saved as unpublished drafts without an admin selling price, and duplicate CJ IDs are rejected.
- Added normalized product options and variants to the admin editor, with a bounded combination matrix and editable variant price, sale price, stock, SKU, delivery/file/external/affiliate links, image, CJ variant ID, and affiliate commission settings. Imported CJ variant IDs are preserved across admin edits. Published physical products require a positive price; incomplete supplier pricing remains private and requires admin review.
- Added variant-aware storefront selection and price/availability/image/action updates, an order review step, server-side Paystack price/availability validation, persistence of selected variant identity in orders and retry records, variant-specific digital delivery, and CJ fulfilment variant mapping.
- Updated catalog discovery and detail UI: free resources and category entry points are visible from the home page; discovery separates digital/services, physical, and free listings; search includes category, format, tags, specs, options, and variants; cards show product kind and relevant action; detail pages use a gallery/decision layout and category-specific information blocks. App actions say **Install**. Related items stay within category and product kind. Physical products remain supported.
- “Verified affiliate partner” is shown only when an admin has entered a valid absolute HTTP(S) affiliate link for that product. Blank and placeholder links do not show it.
- Added `nova_upload_product_image` to the MCP server. It validates PNG/JPEG/WebP bytes and a 5 MB limit, writes to a product-scoped Firebase Storage object, and appends the image and alt text transactionally to both product media fields, up to the eight-image limit. Failed catalog writes attempt to remove the uploaded object. The tool does not publish the product.
- Updated MCP product guidance for complete structured product entry and exact-match media handling. When no verifiable supplier/exact-product image exists, an assistant can attach an explicitly illustrative generated image with the upload tool. This flow requires `FIREBASE_STORAGE_BUCKET` on Render and has not been exercised against the production bucket.
- Updated MCP OAuth callback handling and refresh-capable scope metadata; `MCP-SETUP.md` documents ChatGPT setup. The workspace connection and production deployment must still be completed separately.
- Added an affiliate dashboard responsive pass: on wide screens it expands to a desktop dashboard, lays out the key metrics in a responsive grid, keeps route navigation visible, and centers the diagnostic sheet. Added visible keyboard focus, 44 px navigation targets, reduced-motion behavior, and narrow-phone spacing while preserving the existing mobile layout and routes.
- Added regression coverage for CJ normalization, image validation/storage behavior, product import fields, variant pricing and checkout, affiliate disclosure, discovery/search, same-kind recommendations, action labels, and storefront script parsing.

## CJ search diagnosis

The supplied source archive did not contain the Firestore `cjSyncLogs` records. Source inspection showed two concrete mapping defects: the `/product/listV2` call used the old route's query parameter names, and the mapper treated each `content` group as a product instead of reading that group's `productList`. These explain a successful upstream request followed by empty/stub product rows. The code now logs raw and incomplete row counts to make future failures diagnosable. Query and response handling were checked against [CJ Product List V2 documentation](https://developers.cjdropshipping.com/en/api/api2/api/product.html).

## Validation performed

- `node --test`: **24 passed, 0 failed**.
- `node --check` passed for `api/product-variants.js`, `api/verify-paystack.js`, `api/cj-order.js`, `mcp/tools/catalog.js`, and `mcp/lib/productImage.js`.
- The regression suite parses inline storefront JavaScript successfully.
- A local browser visual pass could not be completed: the Codex in-app browser timed out while attaching the local preview. Production viewport checks (320–1440 px), keyboard/screen-reader review, weak-network checks, and field Core Web Vitals remain unverified.
- `npm test` could not run because `npm` is absent from this machine's PATH; the equivalent built-in `node --test` command passed.
- Live Firebase Storage upload, Render deployment/health, ChatGPT OAuth authorization, Paystack test-mode checkout, sign-in, and CJ fulfilment were not exercised. The prior live OAuth discovery read still reflected the currently deployed old `admin`-only scope, so the source changes are not live until deployed and verified.

## Remaining scope and deployment

This is a substantial implementation pass, not a claim that every item in the 178-section specification is complete. The affiliate dashboard now adapts to desktop but has not had its requested full visual rebuild or end-to-end affiliate variant reporting audit. NOVA AI contextual redesign, full primary-navigation/routing architecture, wishlist/order experience audit, preview parity, broad screen-reader review, weak-network testing, and live payment/fulfilment acceptance remain open. No production secrets or customer data were used for testing.

Before production use, deploy the backend and static files, configure the exact Firebase Storage bucket, then verify OAuth discovery, ChatGPT tool connection, image upload, admin publish flows, Paystack test-mode variant checkout, digital delivery, physical address/order flow, and CJ variant fulfillment. Check mobile and desktop layouts in a real browser and monitor field performance; Core Web Vitals should be assessed on field data at the 75th percentile, not inferred from source tests. Baymard product-page/listing research and the web.dev Core Web Vitals guidance informed the hierarchy and acceptance notes: [Baymard product-page research](https://baymard.com/research/product-page), [Baymard product-listing guidance](https://baymard.com/research-articles/product-listing-information), and [web.dev Web Vitals](https://web.dev/articles/vitals).
