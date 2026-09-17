# LEXDEN NOVA

A single-file digital + physical products marketplace built for a Nigerian
audience, with a built-in affiliate program, an AI shopping assistant
(NOVA), and dropshipping fulfilment via CJ Dropshipping — plus a remote
MCP server so Claude can manage the whole admin portal directly.

**Live storefront:** hosted on GitHub Pages
**Backend API:** hosted on Render — `https://lexden-nova.onrender.com`

---

## What's actually in this repo

| Path | What it is |
|---|---|
| `index.html` | The entire storefront + admin portal. One file, vanilla JS, no build step. Hash-based routing (`#products`, `#product/:id`, `#admin`, etc). |
| `affiliate/index.html` | The standalone affiliate dashboard — separate small app, same Firebase project, shares the shopper's existing login (no separate signup). |
| `server.js` | Express entrypoint on Render. Mounts every file in `api/` as a route, handles CORS, and mounts the MCP layer. |
| `api/` | Backend logic — Paystack verification, CJ Dropshipping integration, Brevo transactional email, NOVA's Gemini bridge, OTP/auth email, and the affiliate program's server-side actions (`api/affiliate/`). |
| `mcp/` | The Claude MCP connector — OAuth server, ~60 admin tools, audit log. See `MCP-SETUP.md`. |
| `scripts/generate-sitemap.js` | Standalone script (run via GitHub Actions, not on Render) that rebuilds `sitemap.xml` from live catalog data. |
| `firestore.rules` / `firestore.indexes.json` | Firestore security rules and composite indexes — deploy these to Firebase whenever they change. |
| `manifest.json`, `sw.js`, `icon-*.png` | PWA install support (installable on Android/iOS home screen). |

## Architecture, in one paragraph

The storefront (`index.html`) is a static file with no server-side
rendering — it talks to Firestore directly (client SDK) for catalog data,
and to the Render backend (`api/*.js`) only for anything that needs a
secret: verifying a Paystack payment, calling CJ Dropshipping, sending
email via Brevo, or asking Gemini a question through NOVA. The admin
portal is the same `index.html` file, gated behind a Firebase Auth
email/password check against one hardcoded admin email. The affiliate
program is a second, small static app (`affiliate/index.html`) that
shares the shopper's existing Firebase session — there's no separate
affiliate login.

## Stack

- **Frontend:** Vanilla JavaScript, no framework, no build step — Firebase
  Firestore + Auth (client SDK) for data/login, Paystack Inline JS for
  checkout.
- **Backend:** Node.js + Express, deployed as a single Render Web
  Service. Requires **Node 20+**.
- **Database:** Firebase Firestore.
- **Payments:** Paystack (checkout + affiliate payouts via Transfers).
- **Fulfilment:** CJ Dropshipping API, for physical products.
- **Email:** Brevo (transactional templates for OTP, orders, receipts).
- **AI:** Google Gemini, proxied through `api/nova-ai.js` so the API key
  never reaches the browser.
- **Admin automation:** Claude, via the MCP connector in `mcp/`.

## Setting it up from scratch

1. **Firebase** — create a project, enable Firestore + Authentication
   (Email/Password provider), deploy `firestore.rules` and
   `firestore.indexes.json`. Create exactly one Auth user for your admin
   email (Console → Authentication → Users → Add user) — this is a
   separate manual step from anything in the app itself, and skipping it
   is the #1 cause of "admin login says incorrect password."
2. **Paystack** — get your test/live secret + public keys.
3. **Render** — create a Web Service pointed at this repo, set the
   environment variables listed in `.env.example`, deploy.
4. **index.html** — paste your Firebase config (`firebaseConfig` near the
   top of the `<script>` block) and set `ADMIN_EMAIL` to your admin
   address. In Admin → Payments / NOVA AI Setup / CJ Dropshipping, paste
   your live Render URLs into each "endpoint" field and save.
5. **affiliate/index.html** — paste the same `firebaseConfig`
   (`apiKey`/`storageBucket`/`messagingSenderId`/`appId` — the file has
   comments marking exactly where).
6. **GitHub Pages** — serve `index.html`, `affiliate/index.html`, and the
   PWA assets from Pages (or any static host).
7. *(Optional)* **Claude MCP connector** — see `MCP-SETUP.md`.

## Where things live (so you don't go looking in the wrong place)

- **Catalog** (products/categories) → Firestore `catalog/products` and
  `catalog/categories`, each a doc with a `list` array.
- **App content, branding, NOVA AI mode, payment endpoints** → one doc,
  `catalog/settings`, under its `content` key.
- **Services, Feed Posts, FAQs, Suppliers, Team members** → also
  `catalog/settings`, each its own array field.
- **Orders, Reviews, Users, Contact messages, Newsletter signups** →
  their own top-level Firestore collections (`orders`, `reviews`,
  `users`, `leads`, `newsletterSubs`).
- **Affiliates & withdrawals** → `affiliates` and `affiliateWithdrawals`
  collections.
- **Error Codes** shown in the admin portal are a hardcoded reference
  object in `index.html` (`ERROR_CODES`) — not stored in Firestore.
- **The admin portal's "Logs" tab** reads a browser-only `localStorage`
  activity log — it never touches the server, so it's specific to
  whichever browser/device you're using at the time.

## Known constraints worth knowing before you change something

- `index.html` is large and intentionally dependency-free — resist the
  urge to add a framework; the whole point is zero build step and zero
  hosting cost beyond GitHub Pages.
- Every secret (Paystack, Gemini, CJ, Brevo, Firebase Admin) lives in
  Render's environment variables — never in `index.html`, which anyone
  can view-source.
- The affiliate program activates automatically on signup — there's no
  admin approval step by design. Suspending a problem affiliate is still
  fully under admin control (Admin → Affiliate Program → Suspend).
- Automated affiliate payouts (via Paystack Transfers) require a real
  bank code. An affiliate who picked "my bank isn't listed" at signup can
  still be paid — just manually ("Mark Paid"), not through the automated
  Transfer button — until/unless their account is confirmed.

## Documentation index

- `MCP-SETUP.md` — connecting Claude to the admin portal.
- `MCP-IMPLEMENTATION-REPORT.md` — what the MCP layer does, what was
  tested, and known limitations.
- `AFFILIATE-UPDATE-README.md` — history of the affiliate program build.
