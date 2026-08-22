# LEXDEN NOVA

A single-page digital marketplace for browsing, discovering, and buying digital products — courses, software, templates, and more — with an AI shopping assistant, multi-currency pricing, and a built-in social feed. Built as one self-contained `index.html`, backed by Firebase and a couple of small serverless functions.

**Live site:** https://lexdendigital.github.io/LEXDEN-NOVA/index.html

---

## ✨ Features

### Storefront
- **Product catalog** with category browsing, tag/keyword search, and sort (popular, newest, cheapest, highest rated)
- **Price filtering** — quick presets (under $10, $10–$50, $50+) plus a custom min/max range, entered and displayed in whichever currency the shopper is currently viewing
- **Multi-currency pricing** — prices are stored once and converted live to the shopper's chosen currency, with exchange rates that refresh automatically
- **Product detail pages** — full description, specs, image gallery, discount badges, and support for free products
- **Ratings & reviews** — star ratings with written reviews, aggregated per product
- **Wishlist** — save products for later, sortable by newest, price, or rating, with a shareable link
- **Social feed** — announcements, drops, and updates from the store, each with its own shareable page
- **Per-account likes** — likes on feed posts are tied to the signed-in account, not the device, so switching accounts on the same browser never shows someone else's likes as your own
- **NOVA, the AI shopping assistant** — answers questions about products, pricing, and the catalog. Runs in a free offline/local mode out of the box, with an optional mode that connects to Google's Gemini API for fully conversational, open-ended answers (including understanding images)
- **Checkout** via Paystack, supporting card and other local payment methods
- **Accounts** — email/password and Google sign-in, with guest browsing supported throughout

### Installable app
- Full **Progressive Web App (PWA)** — installable to a home screen or desktop from the browser, works offline for previously visited content, and can receive push notifications for order/store updates

### Discoverability
- Rich **SEO metadata** (title, description, Open Graph, Twitter Card) that updates per product/post
- **Structured data** (schema.org JSON-LD) for the organization, site search, individual products, breadcrumbs, and FAQs, so search engines and AI agents can understand the catalog directly from the page
- Every product and feed post gets its own **real, shareable, individually-indexable page** (via a lightweight link-preview service), rather than being hidden behind a single-page app's URL fragment
- `sitemap.xml` and `robots.txt` for search engine crawling

---

## 🛠️ Tech stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML, CSS, and JavaScript — no framework, no build step, single file |
| Auth & database | [Firebase](https://firebase.google.com/) (Authentication + Firestore) |
| Media storage | [Cloudinary](https://cloudinary.com/) (free tier) |
| Payments | [Paystack](https://paystack.com/) |
| AI assistant | Local rule-based engine by default; optional [Google Gemini API](https://ai.google.dev/) via a serverless proxy |
| Serverless functions | [Vercel](https://vercel.com/) (for payment verification and the Gemini proxy, so secret keys never touch the browser) |
| Hosting | [GitHub Pages](https://pages.github.com/) |
| Offline support | Service worker + Web App Manifest (PWA) |

---

## 📁 Project structure

```
├── index.html            # The entire app — UI, styling, and logic
├── nova-ai.js             # Vercel serverless function: proxies NOVA's questions to Gemini
├── verify-paystack.js      # Vercel serverless function: verifies payments server-side
├── firestore.rules        # Firestore security rules
├── manifest.json          # PWA manifest
├── sw.js                  # Service worker (offline support, caching)
├── icon-192.png            # PWA icon
├── robots.txt             # Search engine crawl rules
└── sitemap.xml             # Search engine sitemap
```

Everything a shopper sees and does lives in `index.html`; the two `.js` files are small serverless functions deployed separately (to Vercel) purely to keep secret API keys off the client.

---

## 🚀 Deployment overview

1. **Frontend** — push `index.html` (plus the PWA/SEO support files) to a GitHub repo and enable **GitHub Pages** on it.
2. **Backend data** — create a [Firebase](https://firebase.google.com/) project, enable **Authentication** (Email/Password + Google) and **Firestore**, and deploy `firestore.rules`.
3. **Media** — create a free [Cloudinary](https://cloudinary.com/) account for image/video uploads.
4. **Payments** — create a [Paystack](https://paystack.com/) account for checkout.
5. **Serverless functions** — import the repo into [Vercel](https://vercel.com/) and deploy `nova-ai.js` and `verify-paystack.js` as serverless functions, with the corresponding API keys set as environment variables on Vercel (never in the frontend code, so they're never exposed to visitors).

Once deployed, the site is fully self-contained — static hosting for the app, Firebase for accounts/data, Cloudinary for media, and two small serverless functions for anything that needs a secret key.

---

## 📄 License

© LEXDEN. All rights reserved.
