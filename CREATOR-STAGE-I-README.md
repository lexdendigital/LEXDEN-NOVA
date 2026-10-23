# LEXDEN NOVA CREATOR — Stage I: Automation engine

Stage I makes the marketplace look after itself: it checks supplier and delivery links, keeps CJ orders moving, watches order deadlines, cross-checks the books, and tells the right person. **268 tests pass** (45 new).

## What automation may do — and what it never does
It MAY (all reversible or idempotent):
- **Pause** a published listing whose delivery link or CJ supplier has broken (flagged `pausedByLink` / `pausedBySupplier`, audited as `system`).
- **Pause a seller's physical listings** for repeated missed deadlines — **only if an admin switches auto-restrict ON (default OFF).**
- Create / retry / sync CJ orders (same idempotent code as Stage G).
- Write admin alerts and creator notifications (one per situation, never repeated).

It NEVER moves money, approves/rejects withdrawals, refunds, or suspends an account.

## The jobs
| Job | Every (min gap) | What it does |
|---|---|---|
| `supplierHealth` | 15 min | Re-tests CJ mappings; pauses dropship listings that went bad |
| `cjOrders` | 5 min | Retries orders that failed only because CJ was down; syncs tracking; alerts on stock/attention |
| `links` | 1 hour | Checks external delivery links (SSRF-safe); warns, then pauses after 3 broken / 6 unreachable checks |
| `sla` | 30 min | "Due soon" / "overdue" notifications; flags sellers; optional auto-pause |
| `reconcile` | 22 hours | Paid orders vs ledger/fulfillment/entitlement, each creator's balance vs sales − withdrawals, withdrawals stuck >1h |
| `emailQueue` | 5 min | Runs the existing email queue (it had no scheduler on Render) |

A job that ran recently is skipped, so calling the scheduler often is harmless. Each job has a lock (two triggers can't overlap) and every run is recorded in `automationRuns`.

## Setup (do these in order)
1. **Create `CRON_SECRET`** in Render → LEXDEN-NOVA → Environment: any random string of **16+ characters**. Without it the scheduler endpoint answers 503 and does nothing. (Fails closed.)
2. **Schedule it** — free option: sign up at cron-job.org, create a job calling
   `https://lexden-nova.onrender.com/api/creator-cron`
   every **10 minutes**, with the header `Authorization: Bearer <your CRON_SECRET>`.
   This also keeps the free Render service awake. Alternative: set `CREATOR_CRON_IN_PROCESS=true` to run it inside the server (only works while the service is awake).
3. Upload the files to GitHub, let Render deploy.
4. **Publish `firestore.rules`** (new collections below).
5. Optional: `BREVO_TPL_CREATOR_SLA` (email template for deadline emails; no template = no email, never an error).

**No new Firestore indexes** are needed.

## New collections (rules included)
`adminAlerts`, `automationRuns` (admin read) · `creatorNotifications` (owner read) · `automationLocks`, `automationSettings` (no client access). All writes are server-only.

## New endpoints
- `GET|POST /api/creator-cron[?jobs=sla,links]` — scheduler (secret required)
- `GET /api/creator-notifications[?unread=1]`, `POST {action:"mark_read", ids?}` — creator
- `/api/creator-admin-automation` (admin): `GET ?view=alerts|runs|settings`; `POST` `resolve_alert`, `run_job`, `set_auto_restrict {enabled}`, `lift_pause {scope: sla|link|supplier, creatorId|productId, reason}`
- Creator MCP: 2 new tools (`creator_list_notifications`, `creator_mark_notifications_read`) → **26 tools**.

## Rules for creators
A creator can't resume a listing the platform paused for missed deadlines (`PAUSED_BY_PLATFORM`), and can't resume a link-paused listing until the link works again. An admin lifting a pause re-checks link/supplier problems first and only lifts pauses automation made — never a creator's own pause.

## Deliberately NOT built
- **Auto-release of money after a silent dispute window.** Earnings are available immediately and an admin approves withdrawals; there is no hold to release. Building it would need a hold redesign of the money model. Say the word if you want that.
- **Paystack-vs-ledger reconciliation** — needs Paystack's transaction list; only internal reconciliation is included.
- **UI** for alerts/notifications (APIs and MCP only so far).

## Safety checks included
SSRF protection on link checks (blocks private/loopback/metadata IPs in any spelling, re-validates every redirect, pins the connection to the checked IP, 8s timeout, headers only); constant-time secret compare; secret never echoed.

---
## Email fix + new Brevo templates (added after Stage I)
**Code**
- `api/send-otp.js`: every step is guarded, there is a 15-second hard deadline, and the code email is sent directly so a Brevo failure is reported (with a friendly reason) instead of a fake "code sent". Progress is logged as `send-otp [...] stage +Nms`.
- `server.js`: every `/api/*` handler is wrapped so a thrown error returns a 500 instead of leaving the browser waiting forever.
- `index.html`: the newsletter button gives the cloud write 10 s then moves on; the email call has a 20 s timeout.
- Order confirmation passes `delivery_type` / `processing_days` for marketplace orders; buyers get an order-update email (shipped / delivered / cancelled, with carrier + tracking link) automatically.

**Brevo templates (created, active)**: 22 Creator SLA Alert · 23 Order Confirmation v2 · 24 Order Update v2 (shipping + tracking).
**Render env vars set**: BREVO_TPL_CREATOR_SLA=22, ORDER=23, ORDER_UPDATE=24, CREATOR_ACCOUNT_STATUS=21, CREATOR_APPLICATION_UPDATE=20, ABANDONED_PRODUCT=19, VERIFY=17, NEWSLETTER=18, ADMIN=16.
Old templates 1–8 are untouched (WELCOME, RESET, CONTACT, SECURITY keep whatever IDs you already set).
