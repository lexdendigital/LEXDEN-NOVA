# LEXDEN NOVA — production-readiness and marketplace benchmark

**Audit basis:** source repository branch `production-hardening-agent-discovery-2026-10-26`, compared to deployed base commit `39c7000231192e9ceb37dff0fea80c3ad433b312`, plus current official platform documentation reviewed on 26 October 2026.

## Executive finding

The repository has a substantial feature surface: storefront, Paystack verification, Firestore catalogue, Creator marketplace, affiliate system, supplier integration, MCP administration, fulfillment, policy acceptance, notification and lifecycle automation. The main scaling constraint is not the number of features. It is inconsistent enforcement of catalog completeness, price freshness, public product rendering, origin policy, and seller/fulfillment truth across the different systems.

The appropriate strategy is **a trusted catalog core with channel adapters**. One canonical product record should feed the human storefront, search-engine pages, NOVA AI context, structured data, and any future marketplace/AI feed. Every channel must use the same publication, price, stock, seller, return, and delivery validation.

## Current code changes in this branch

- Adds a shared exact-origin CORS helper and applies it to the main server plus payment, email-verification, affiliate, and supplier API paths.
- Adds a server-rendered `/product/:id` page with crawlable product text, seller/fulfillment/policy information, product metadata, guarded Product/Offer structured data, and mobile-accessible markup.
- Makes product sitemap inclusion depend on product publication and completeness, rather than merely having an ID.
- Adds JSONL/CSV agent-feed routes and a diagnostic status route. The current feed explicitly has search eligibility but **checkout eligibility is false**.
- Excludes suspicious pricing, unverifiable third-party checkout pricing, incomplete seller/brand information, stale currency conversion, incomplete delivery details, and parent-only variant products that cannot yet be represented faithfully.
- Stops displaying converted local-currency prices and starting new non-USD checkout when the saved FX snapshot is older than seven days. The current live catalog settings showed a rate timestamp of 2026-10-03, so this is an active operational blocker until rates are refreshed.
- Removes the viewport zoom restriction.
- Ensures the storefront, catalog JSON-LD and NOVA AI recommendation context only expose explicitly published, active products.
- Adds regression tests for product pages, feed contracts, stale FX behavior, price anomalies and sitemap filters.
- Adds GitHub Actions CI to run `npm ci`, the complete test suite, JavaScript syntax checks, and a production dependency audit.

These changes are on a review branch. They are **not a declaration that the live site has already been changed**.

## What the major platforms do well

| Platform / system | Officially documented mechanism | What NOVA should adopt |
|---|---|---|
| Amazon Marketplace | Product detail page, title, image, bullet, attributes and listing-quality rules | Precise titles, useful images, complete attributes, honest variants and automated listing rejection for missing critical data |
| eBay | Item specifics and product identifiers improve product matching and search filtering | Category-specific required attributes and stable item/variant IDs |
| Etsy | Response rate, on-time shipping/tracking, average review rating and case rate affect service standing and may affect search visibility | Measured seller reliability and customer-service escalation based on real transactions |
| Walmart Marketplace | Listing Quality score covers content, discoverability, offer, ratings/reviews, price, shipping, transactibility and post-purchase quality | A NOVA Listing Quality Score with component scores, explainable failures and precise repair actions |
| Shopify agentic storefronts | Eligible catalogs can be exposed to AI surfaces, with per-channel control and attribution; channel checkout behavior differs | One catalog source of truth, channel-specific eligibility and reliable source attribution |
| Google Merchant Center / UCP | Product feeds provide reach to Google AI shopping surfaces; UCP connects discovery, merchant capabilities and checkout while the merchant remains merchant of record | Merchant feed readiness, real-time price/availability checks, delivery/return rules, and explicit capability negotiation |
| OpenAI Agentic Commerce Protocol | Product feed, dedicated checkout-session endpoints, signed requests, idempotency, authoritative order events and conformance requirements | Keep feed, discovery and checkout as separate milestones; implement authenticated/idempotent checkout only after approved onboarding and PSP compatibility |
| Google Search structured data | Product/Offer, shipping, delivery-time and return-policy data can make merchant listings eligible for richer search displays | Render matching structured data only where visible on-page values are current and verifiable |

### Official references

- Amazon [Product detail page rules](https://sellercentral.amazon.com/help/hub/reference/external/G200390640), [Search optimization](https://sellercentral.amazon.com/help/hub/reference/external/GNYWHX2TP7C8GXHK), [Product image guide](https://sellercentral.amazon.com/help/hub/reference/external/G1881).
- eBay [Item specifics](https://www.ebay.com/sellercenter/listings/item-specifics).
- Etsy [Customer Service Standards](https://help.etsy.com/hc/en-us/articles/360036207794-What-are-Etsy-s-Customer-Service-Standards) and [how service can improve search ranking](https://www.etsy.com/seller-handbook/article/375461267511).
- Walmart [Listing Quality](https://marketplace.walmart.com/listing-quality/) and [Listing Quality API](https://developer.walmart.com/us-marketplace/docs/get-sellers-listing-quality-score).
- Shopify [Agentic storefronts](https://help.shopify.com/en/manual/online-sales-channels/agentic-storefronts).
- Google [Universal Commerce Protocol](https://developers.google.com/universal-commerce-protocol), [merchant listings structured data](https://developers.google.com/search/docs/appearance/structured-data/merchant-listing), and [product variant structured data](https://developers.google.com/search/docs/appearance/structured-data/product-variants).
- OpenAI [Agentic Commerce Protocol](https://developers.openai.com/commerce), [stable product feed schema](https://developers.openai.com/commerce/specs/file-upload/products?view=table), [feed best practices](https://developers.openai.com/commerce/guides/best-practices), and [checkout specification](https://developers.openai.com/commerce/specs/checkout).
- OpenAI [crawler guidance](https://developers.openai.com/api/docs/bots) and [guidance for allowing OpenAI search crawlers](https://help.openai.com/en/articles/20001243-advertiser-guidance-for-allowing-openai-web-crawlers).

## Recommended NOVA Listing Quality Score (100 points)

| Component | Weight | Scoring signals |
|---|---:|---|
| Product identity and content | 20 | Stable ID, title quality, factual description, category, required attributes, brand/seller identity |
| Images and media | 10 | HTTPS image, loadability, sufficient resolution, relevant gallery, no mismatched stock image |
| Price integrity | 15 | Valid regular price, sale price strictly below regular price, approved discount, currency and FX freshness |
| Stock and variants | 15 | Explicit status, selected purchasable variant, correct price/image, stock freshness, no ambiguous zero-price drafts |
| Delivery and returns | 15 | Delivery method/time, supported destinations, shipping costs where applicable, public return/refund terms |
| Seller trust | 10 | Identified seller, verification state, response time, on-time fulfilment, disputes, authentic post-purchase reviews |
| Discovery and accessibility | 10 | Server-rendered URL, canonical, crawl policy, descriptive links, valid structured data, mobile/accessibility checks |
| Transaction readiness | 5 | Checkout route tested, idempotency, final price revalidation, supported payment/delivery rails |
| **Total** | **100** | |

### Publication gates (hard failures override the numeric score)

A product must not be exported to agent shopping feeds or marked as purchase-ready if any of these fail:

- Product is not explicitly published and active.
- Seller identity is missing or the seller is suspended.
- Price is missing, invalid, stale, or under pricing review.
- Main image is missing or not publicly accessible over HTTPS.
- A physical item has no reliable stock status or delivery information.
- A variable product cannot describe each purchasable variant accurately.
- Checkout, currency, or fulfillment claims cannot be confirmed.
- Review totals/ratings cannot be tied to legitimate eligible purchases.

A high score must never compensate for a payment-integrity failure.

## Agent discoverability: what is and is not enabled

### Enabled by code in this branch

- Human-readable server-rendered product pages, not just a JavaScript redirect.
- Sitemap URLs for products that pass the strict indexability gate.
- Explicit crawler permissions for OAI-SearchBot and ChatGPT-User; GPTBot is separately disallowed because search visibility does not require model-training permission.
- An `llms.txt` discovery guide.
- A validated JSONL/CSV feed with stable product URLs, seller name, brand, image, regular price, optional sale price, explicit availability, search eligibility, and checkout disabled.
- Structured data only when core catalog facts pass validation.

### Not automatically enabled by these changes

- Inclusion in ChatGPT shopping results or any other third-party AI channel.
- OpenAI product-feed acceptance or partner approval.
- Direct checkout within ChatGPT or Google AI experiences.
- Access to any merchant program in Nigeria or another unsupported market.
- Payment compatibility with agent-delegated payment instruments.

OpenAI documents that product feeds and checkout are separate onboarding paths, and that Instant Checkout is currently limited to approved partners. Its checkout spec requires authenticated endpoints, request signatures, idempotency, authoritative cart calculations and order webhooks. Google UCP is a separate integration. NOVA must not claim either integration is active until onboarding, country/currency eligibility, PSP support, conformance and end-to-end tests are completed.

## Highest-priority remaining work

1. Refresh and validate foreign-exchange rates through a documented trusted source; until then, non-USD price display and checkout are intentionally gated.
2. Resolve the catalog-quality exceptions surfaced by the admin portal: missing images, statusless records, incorrect product types, missing seller identity, missing fulfillment details, and suspicious discounts. Product records should be reviewed, not silently auto-corrected.
3. Add category-specific product validation in the admin save/publish workflow; show the failed fields and block publication until repaired.
4. Implement variant-specific page URLs and feed rows, including the selected variant's price, image and stock.
5. Add public seller profile pages, verification explanations, support SLA, on-time delivery and dispute metrics, and review provenance.
6. Add accurate policy and shipping data to structured markup only after the public policy pages and operational rules agree.
7. Once catalog gates and payment routes are sound, map the stable feed to the exact approved OpenAI/Google format and submit through the official onboarding process.
8. Only then design/implement agentic checkout sessions, signatures, durable quote snapshots, idempotency, cancellation, refunds, order events, reconciliation and conformance tests.

## Operational decision

Do not push this entire branch directly to `main`. Merge only after the full test suite, dependency audit and manual checkout/Creator/admin smoke tests pass, and after reviewing the fact that the current catalog's stale exchange-rate timestamp blocks non-USD checkout. Live secrets, production product prices, payment mode, and catalog records are not to be changed as part of automated code edits.
