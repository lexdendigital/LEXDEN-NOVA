# LEXDEN NOVA CREATOR — Stage J + storefront/workspace/admin update

## What is new
- **Stage J (AI + insights):** `/api/creator-ai` (weekly report, product checklist, creator assistant). AI only advises — it can never move money, approve, pay or publish (blueprint §48). Creator MCP now has 28 tools (`creator_get_weekly_report`, `creator_get_product_checklist`).
- **"Session expired" fix (Become a Creator):** the server initialised Firebase Admin too late on a cold start and reported that as an expired session. Now config problems are a 500, only real token faults are 401, transient ones 503; the browser retries once with a fresh token.
- **Storefront bridge:** shoppers see published creator listings (`/api/creator-listings`, sanitised), buy them in the listing's own currency at the exact price, and get delivery: signed file download or external access link (`/api/creator-product-download`, entitlement-checked). Library page (#library). Physical orders create fulfilments and decrement stock.
- **Creator workspace:** Home / Products / Orders / Money tabs (create, submit, pause, ship with tracking, payout account, withdrawals, CJ connection).
- **Admin → Creator Ops tab:** Listing review, Payouts (approve / reject / pay via Paystack / manual paid, CSV exports, balances), Orders & SLA, Alerts & automation (resolve alerts, run jobs, auto-pause switch, re-open paused listings).
- **Link previews:** `/api/product` falls back to creator listings for OG previews.
- **firestore.rules:** `products` is no longer publicly readable (owner/admin only); `creatorAiLog`/`creatorAiUsage` rules added. **Publish the rules.**

## Deploy checklist
1. Upload the files to GitHub (Render auto-deploys; Pages serves index.html).
2. Firebase Console → Firestore → Rules → paste `firestore.rules` → Publish.
3. Create the two Stage G `supplierOrders` composite indexes if not yet done.
4. Paystack webhook (live and test): `https://lexden-nova.onrender.com/api/paystack-webhook`.
5. cron-job.org: hit `/api/creator-cron` with header `Authorization: Bearer <CRON_SECRET>`.
6. Render env: `BREVO_API_KEY`, `OTP_SIGNING_SECRET`, `CRON_SECRET`, `MCP_BASE_URL=https://lexden-nova.onrender.com`.
7. Creator MCP URL: `https://lexden-nova.onrender.com/mcp/creator`.

## Stage K (added after the first delivery)
- **Creator type buttons fixed:** Personal / Business now open the application form.
- **Admin lists fixed:** the Affiliate and Creator Applications tabs no longer reload in a loop (which could freeze them), and they survive a sleeping server (retry + 45s budget).
- **Earnings hold (pending until release conditions are met):** Admin → Creator Ops → Reconciliation → "Hold new sales". Default 0 days = old behaviour. A `holds` job (run by the cron) releases due sales.
- **Disputes:** buyers use "Report a problem" in My Library (14-day window, must be the real buyer). The creator's earning for that order is frozen; the admin decides in Creator Ops → Disputes. REFUND reverses the creator's earning only; **you refund the buyer from the Paystack dashboard**. The creator replies in Creator → More → Disputes.
- **Seller pages:** `#seller/<username>` (and `#seller/id:<uid>`); creators set username/tagline/bio in Creator → More. Product pages link to the seller.
- **Creator More tab:** profile, notification list, disputes, selling policies.
- **Reconciliation report:** Creator Ops → Reconciliation (read-only ledger check; optional live Paystack comparison of the 25 latest sales).
- **MCP:** creator connector now 32 tools; admin connector gained 14 creator-marketplace tools (see MCP-SETUP.md). No tool can pay a creator.
- **firestore.rules:** `creatorDisputes` (admin read) and `creatorUsernames` (server only). Publish the rules again.

## Still open (be aware)
- Nothing from the earlier "not built yet" list remains, but the screens are tested with stubs/unit tests only (not clicked through in a real browser with live Firebase/Paystack). Do one Paystack TEST-mode purchase, one dispute and one withdrawal end to end before going live.
- Seller pages have no search/sort yet; link previews for `#seller/...` are not generated (hash routes cannot have server-side previews).
