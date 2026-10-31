# LEXDEN NOVA V3.0.2 — Email Lifecycle Security & Scheduler Integrity

This document describes the V3.0.2 repository implementation. It does **not** claim that Firestore Rules, indexes, Render environment variables, or any production service have been deployed.

## Recipient policy: Policy A

Guest recovery remains supported.

- **checkout_started**: anonymous Firebase sessions and signed-in shoppers may submit the email entered at checkout. The address is `unverified` unless a verified Firebase ID-token email exactly matches it.
- **signup_started**: the anonymous browsing session may submit the entered email only after the OTP send endpoint returned success. Resending the OTP does not create another lifecycle event.
- **product_view**: only a genuine non-anonymous signed-in shopper with a verified Firebase email is eligible. The recipient is taken from the verified token, never from browser input.

An unverified guest email is an eligible recovery recipient under Policy A. It is not represented as proof of ownership.

## Server intake

`POST /api/lifecycle-event` requires `Authorization: Bearer <Firebase ID token>`.

Accepted event types:

- `product_view`
- `checkout_started`
- `signup_started`

The server derives the UID from `verifyIdToken()`. Browser-supplied UID, timestamps, URLs, amount, stage, emailed/delivery state, retry state, verification state and scheduling state are ignored.

Product IDs are validated and resolved against the authoritative NOVA catalog or a currently published creator listing. Recovery links are generated from the canonical NOVA store URL. Browser-supplied product/checkout/signup URLs are never copied into recovery mail. If authoritative price information is not required/reliable, no client amount is included.

New records use `schemaVersion: 1`, `source: "lifecycle-event-api"`, explicit lifecycle state, server-owned stage and `nextAttemptAt`, recipient verification classification and queue linkage.

## Abuse controls

The intake transaction uses fixed server-time windows and hashed document keys. Defaults:

| Control | Default |
|---|---:|
| Events per Firebase UID | 12 / hour |
| Events per trusted Express client IP | 60 / hour |
| Accepted recovery events per normalized recipient | 3 / 24 hours |
| Same recipient + event type + product | 1 / 24 hours |
| Queued lifecycle messages per recipient | 3 / 24 hours |

Environment overrides:

- `LIFECYCLE_UID_HOURLY_LIMIT`
- `LIFECYCLE_IP_HOURLY_LIMIT`
- `LIFECYCLE_RECIPIENT_DAILY_LIMIT`
- `LIFECYCLE_DUPLICATE_DAILY_LIMIT`

The IP control is only one dimension and intentionally has a higher threshold because homes, schools and public networks can share one address.

Express is configured with one trusted proxy and lifecycle/OTP code uses `req.ip`; it does not trust an arbitrary leftmost `X-Forwarded-For` value.

A Firestore rate-limit transaction failure fails the lifecycle/OTP request closed. Checkout/payment itself does not await lifecycle intake.

## Recovery timing and suppression

V3.0.2 preserves:

- product view: 1 hour
- checkout reminder 1: 2 hours
- checkout reminder 2: 22 hours after reminder 1
- signup recovery: 6 hours

New events are queried by trusted source + pending state + due `nextAttemptAt`, ordered by due time. This removes the old fixed-batch starvation problem.

Purchase/account suppression is checked during the lifecycle sweep and **again after an email-queue lease is claimed immediately before provider sending**. This closes the race where a shopper completes the action after queue creation but before delivery.

Lifecycle queue IDs are deterministic per event/stage. Queue creation and lifecycle-stage advancement occur in one Firestore transaction, so a repeated sweep cannot create another queue message for the same stage.

## Legacy records

Pre-V3.0.2 `productViewEvents` were client-creatable and are therefore untrusted. The new worker queries only records carrying the V3.0.2 trusted source marker and schema.

Legacy records are retained for audit and are not automatically emailed, migrated or deleted.

Read-only audit:

```sh
npm run audit:lifecycle:legacy
```

An optional numeric argument changes the bounded scan cap:

```sh
node scripts/audit-lifecycle-events.js 5000
```

Neither command changes live documents.

## Email queue durability

The queue keeps the existing six-attempt maximum, bounded batch size, exponential backoff and dead-letter behavior.

Workers transactionally claim queue items using a lease. Concurrent drains cannot claim the same item. Expired leases are reclaimable after a worker crash.

There is still an unavoidable provider crash window: Brevo may accept an email and the NOVA worker may crash before Firestore records success. V3.0.2 does **not** claim exactly-once provider delivery.

Brevo currently documents `idempotencyKey` with a 30-minute TTL and a `duplicate_parameter` response for its transactional **batch/idempotency** pattern. NOVA’s existing sender uses the single transactional template request shape and does not depend on that batch guarantee. Provider idempotency is therefore not used as an exactly-once claim in this patch.

## OTP hardening

Preserved behavior:

- 60-second per-email resend cooldown
- eight sends per trusted client IP per hour
- ten-minute OTP lifetime
- HMAC-protected OTP values
- bounded verification attempts
- existing verification-token/account-confirmation flow

Rate-limit reservations are now Firestore transactions and fail closed. New OTP documents use hashed email-derived IDs. `verify-otp.js` has a read-only fallback for an in-flight pre-V3.0.2 OTP so a code issued immediately before deployment remains valid for its original lifetime.

## Firestore Rules and indexes

`productViewEvents` is server-only for regular Firebase clients: no create/read/update/delete.

V3.0.1 `users/{uid}` authority rules remain in place.

New/required composite indexes include:

1. `productViewEvents`: `source ASC, lifecycleState ASC, nextAttemptAt ASC`
2. `emailQueue`: `status ASC, leaseUntil ASC`

The existing `emailQueue(status, nextAttemptAt)` index remains.

Root `firebase.json` was absent before V3.0.2. The patch adds only the minimal Firestore mapping:

```json
{
  "firestore": {
    "rules": "firestore.rules",
    "indexes": "firestore.indexes.json"
  }
}
```

No hosting or Functions configuration is invented.

## Cron authentication

`/api/process-email-queue` and `/api/process-abandon-emails` accept GET or POST only and require the existing `CRON_SECRET`:

```text
Authorization: Bearer <CRON_SECRET>
```

or:

```text
x-cron-secret: <CRON_SECRET>
```

The secret must be at least 16 characters. Query-string secrets are rejected by design.

Internal queue/lifecycle execution does not call those public routes. It calls shared processors through the automation runner and its transaction-backed locks.

## App Check

Repository inspection found no existing Firebase App Check integration. V3.0.2 does not add reCAPTCHA Enterprise, a paid service, or production App Check enforcement. App Check remains a later defense-in-depth option; it would not prove ownership of a guest email address.

## Test strategy

Normal `npm test` includes lifecycle intake, timing, suppression, deterministic queueing, client non-blocking behavior, queue leasing, cron auth and OTP concurrency tests.

The dedicated Firestore Emulator workflow keeps the existing V3.0.1 user-authority tests and additionally proves all regular-client operations on `productViewEvents` are denied while rules-disabled/Admin-equivalent test setup can process records.

Tests must not use real Brevo, Paystack, suppliers or production Firestore.

## Operational deployment checklist (manual, after review/merge)

1. Confirm the reviewed commit is merged to `main`.
2. Verify Render has `CRON_SECRET` configured and its value is 16+ characters without printing it.
3. Deploy/restart the backend through the normal production process.
4. Separately deploy `firestore.rules`.
5. Separately deploy `firestore.indexes.json`; wait for index build completion.
6. Verify external scheduler requests send `CRON_SECRET` in a header, never a query string.
7. Run the read-only legacy lifecycle audit if operational visibility is desired.
8. Test one guest checkout recovery intake and one signed-in verified product-view intake without sending production test blasts.
9. Monitor queue/lifecycle error logs and Firestore index errors.
10. Do not remove legacy lifecycle records until a separate retention policy is approved.

V3.0.2 source control work deliberately performs none of those live production deployment steps.
