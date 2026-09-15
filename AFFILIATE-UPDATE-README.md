# LEXDEN NOVA — Affiliate Program Mega-Update

Everything in this ZIP is your **complete, final repo state** — every file here
either is unchanged from what you already have, or has your requested edits
already made directly in it. There is nothing to copy-paste or manually merge:
push this ZIP's contents over your repo (same file paths, root-level) and
you're done on the code side. The setup steps below are all *outside* the
code — env vars, Firestore, Paystack dashboard settings.

## What changed and why (plain language, per your questions)

- **`ADMIN_EMAILS`** — turned out to be unnecessary confusion on my part. Your
  app already has exactly ONE admin login (`ruthanselem2@gmail.com`), hardcoded
  in both `index.html` and `firestore.rules`. The backend now just checks
  against that same address automatically. **You don't need to set or touch
  anything for this.**
- **No more `catalog/affiliateSettings`** — I found your real settings doc is
  `catalog/settings`, and everything (commission %, withdrawal fee %, minimum
  withdrawal, WhatsApp/Telegram links) now lives as new fields inside it,
  synced through your *existing* save mechanism. **You edit all of this from
  Admin → Affiliate Program in your existing admin portal** — no separate
  settings screen, no new doc.
- **7-day withdrawal wait** — implemented as: an affiliate can request a
  withdrawal, then must wait 7 days (Sundays don't count toward that count)
  before requesting again. Commissions themselves are available to withdraw
  immediately after a sale; your manual approve-before-payout step in the
  Affiliate Program tab is the actual fraud/refund checkpoint, not a separate
  timer.
- **`affiliate/` directory** — confirmed: the customer/affiliate-facing
  dashboard lives at `affiliate/index.html` in your GitHub repo root. Backend
  affiliate files live under `api/affiliate/` in the same repo (Render deploys
  from the same repo as GitHub Pages).
- **Attribution logic** — confirmed exactly as you described: a product-specific
  link keeps paying out for that exact product no matter how many other
  things get bought first, with no expiry. The general store link pays out
  once, for whichever product is bought first.
- **Automated payout** — implemented via Paystack Transfers (see below) as the
  free "code walkaround" — no separate paid automation tool needed, just the
  Paystack account you already have.

## Setup steps

1. **Push everything in this ZIP** to the root of your `lexdendigital/LEXDEN-NOVA`
   repo (overwrite existing files with the same names — `index.html`,
   `server.js`, `package.json`, `firestore.rules`, `firestore.indexes.json`,
   everything under `api/`). Delete `vercel.json` if it's still in the repo —
   Render doesn't use it and it's no longer needed.

2. **Paste your Firebase config** into `affiliate/index.html` — copy the
   `apiKey`, `storageBucket`, `messagingSenderId`, `appId` values from your
   `index.html`'s `firebaseConfig` object (projectId/authDomain are already
   filled in).

3. **Deploy the Firestore rules and indexes** — Firebase Console → Firestore →
   Rules (paste `firestore.rules`), and → Indexes (or `firebase deploy
   --only firestore:indexes` if you use the CLI with `firestore.indexes.json`).

4. **Render environment variables** — everything you already have
   (`FIREBASE_*`, `PAYSTACK_SECRET_KEY`, `BREVO_API_KEY`, `GEMINI_*`) stays
   the same. Nothing new is *required* to set. `STORE_URL` is optional
   (defaults to your GitHub Pages URL already).

5. **Enable Paystack Transfers for automated payouts (optional)** — in your
   Paystack dashboard → Settings → Preferences → enable Transfers. This
   requires your business verification to be approved by Paystack first (their
   process, not something I can do for you). Until it's enabled, the "Pay
   Automatically" button in the admin Withdrawals section will fail cleanly
   with a clear error, and "Mark Paid" (manual bank transfer) works exactly
   as it does today — so nothing is blocked while you wait on Paystack's
   approval.

6. **Set up the abandoned-view email cron** — point an external cron (e.g.
   cron-job.org, free) at `GET https://lexden-nova.onrender.com/api/process-abandon-emails`
   every 30 minutes. Same pattern as your existing `process-email-queue` cron.

7. **Upload the 6 email templates** from the separate ZIP to Brevo and set
   their template-ID env vars — see that ZIP's own README for details on
   what's live now vs. queued as a fast follow-up.

## How a sale gets attributed, end to end

1. Affiliate copies their product link from **My Store**:
   `https://lexden-nova.onrender.com/go/<their-uid>/<productId>`
2. Someone clicks it → Render logs the click server-side (accurate — survives
   ad-blockers) → 302 redirect to `index.html?ref=<uid>&pid=<productId>`
3. `index.html`'s landing script writes `localStorage['nova_aff_<productId>']`
   — no expiry.
4. Whenever that browser (or that signed-in account, on any device, once
   merged) completes checkout for that exact product — even after buying 90
   other things first — `verify-paystack.js` validates the affiliate is
   active, the product is affiliate-enabled, blocks self-referral, and
   credits the commission immediately.
5. Admin reviews and approves the withdrawal when the affiliate requests one;
   pays manually or via the automated Paystack button.

## New admin capabilities (Admin → Affiliate Program)

- Program settings (commission %, fee %, minimum withdrawal, community links)
- Pending applications → Approve
- Active affiliates → Suspend
- Withdrawal requests, shown with account name/number/bank front-and-center
  → Approve / Reject / Mark Paid / Pay Automatically (Paystack)

## New affiliate dashboard (`affiliate/index.html`)

- **Dashboard** — balance, total earned, clicks, sales, conversion rate, a
  30-day clicks-vs-sales graph, recent commissions
- **My Store** — general link + per-product links, each showing its own
  click count, sale count, and conversion rate
- **Withdraw** — request withdrawal, fee preview, cooldown countdown, history
- **Leaders** — leaderboard ranked by total earnings (name + totals only,
  never payout details)
- **Assistant** — the affiliate-focused Nova AI, grounded in their own real
  stats, for sales advice and troubleshooting
- **Community** — WhatsApp/Telegram invite (admin-editable), profile, sign out

## What's deliberately flagged, not silently skipped

- Automatic email notifications for commission-earned / withdrawal-requested
  / withdrawal-paid / withdrawal-rejected — templates are ready (separate
  ZIP), wiring the send calls is a small fast-follow
- Refund → commission reversal — the `status:'reversed'` field exists on
  commission docs, but nothing currently calls it from wherever you mark an
  order refunded
