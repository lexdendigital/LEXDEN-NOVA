# LEXDEN NOVA CREATOR — Stage A delivery

Implements **Stage A** of the Implementation README's own §43 migration
strategy: *"data model + auth — creator collections, ownership rules,
roles, indexes, server-side auth middleware."* Nothing past Stage A is in
this zip — see "What's deliberately NOT in Stage A" below, and the blueprint
itself: *"Do not implement every phase simultaneously if it compromises
correctness."*

## What's actually implemented (and tested)

**New Firestore collections**, all backend-write-only (`allow write: if
false` in `firestore.rules` — every write goes through the Admin SDK after
server-side validation, no exceptions):
- `creators/{uid}` — public seller profile. Open read (storefront needs it).
- `creatorApplications/{uid}` — application status + the public half of the
  application. Owner/admin read only.
- `creatorPrivate/{uid}` — legal name, DOB, email, phone, business legal
  name, documentIds. Owner/admin read only — never served to anyone else,
  never rendered on any product page.
- `creatorDocuments/{id}` — metadata only for uploaded KYC/business
  documents. Points at a **private** Firebase Storage path with no public
  URL ever generated.
- `creatorAuditLog/{id}` — every application decision and every
  suspend/restrict/revoke, admin-only read.

**The state machine** (`api/creator/state-machine.js`) — pure, dependency-free,
unit-tested (14 tests): the exact lifecycle from blueprint §5
(`APPLICATION_DRAFT → SUBMITTED → IN_REVIEW → {CHANGES_REQUESTED → SUBMITTED
| REJECTED | APPROVED}`) plus the seller lifecycle
(`ACTIVE ↔ RESTRICTED/SUSPENDED → REVOKED`, terminal). One function decides
every legal transition in the whole system — no handler file has its own
if/else copy of this logic.

**Validation** (`api/creator/validation.js`, 11 tests) — the exact required
fields from blueprint §5 for Personal vs Business, including the §4 age
gate (18+ for Personal, pointing anyone under that at the Business/guardian
route rather than accepting an implausible DOB).

**API endpoints:**
```
GET/POST /api/creator-application          — draft, submit, read own status
GET/POST /api/creator-documents            — upload/list own KYC documents
GET/POST /api/creator-admin-applications   — admin review queue + decisions
                                              (start_review, request_changes,
                                               reject, approve, suspend,
                                               restrict, reactivate, revoke)
```
Every route: Firebase ID token required, admin routes additionally check
the same hardcoded admin email `firestore.rules` already uses, every
state-changing call goes through the state machine, nothing accepts a
client-asserted `status`/`verifiedBusiness`/`creatorId` (Implementation
README §55 — the server derives all of it).

**49/49 tests pass** (24 pre-existing + 25 new), `node --check` clean on
every file.

## What's deliberately NOT in Stage A

Everything past "a reviewable, auditable creator application and seller
status" is a later stage, per the Implementation README's own plan — building
it now, before Stage A is proven, is exactly the mistake blueprint §1 warns
against ("make the Creator cockpit first and then try to retrofit fraud
prevention... afterward"):
- **Stage B** — the actual `/creator/` onboarding UI (this zip is backend
  only; there's no new screen in `index.html` yet)
- **Stage C** — product draft/review/version engine
- **Stage D** — digital delivery (R2/signed URLs, entitlements)
- **Stage E** — physical fulfillment, proof of delivery
- **Stage F** — money/ledger, withdrawals, finance export
- **Stage G** — per-creator CJ Dropshipping connections
- **Stage H** — logistics/shipping provider integration
- **Stage I** — automation engine, scheduled health checks
- **Stage J** — Creator AI Home, scoped Creator MCP

Also out of scope for Stage A specifically (noted inline in code where
relevant): username uniqueness enforcement (free-text `displayName` for
now — a reservation/index collection is Stage B's problem), and the
admin-side signed-URL endpoint for actually *viewing* an uploaded KYC
document (upload + metadata exist now; a short-lived signed-URL reader is
a small, obvious Stage B addition).

## One new environment variable this needs

`creator-documents.js` uploads to Firebase Storage via `getFirebaseBucket()`
(the same helper `nova_upload_product_image` already uses) — so
**`FIREBASE_STORAGE_BUCKET`** needs to be set in Render (Firebase Console →
Storage → the bucket name shown there, e.g. `lexden-nova.appspot.com`) for
document upload to work. Everything else in Stage A only needs the Firebase
Admin + Paystack/Brevo vars already covered.

## Deliberate deviation from the blueprint's suggested rules shape

§33 suggests Firestore rules could let the client write "creator-owned
drafts/application fields only through explicit, validated paths." Stage A
closes this entirely instead — `allow write: if false` on every new
collection, same as `orders/{reference}` already does in this file. Rules
can't express "validate this against `validation.js`" or "check the state
machine," so a rules-level partial-write path would be an unvalidated side
door next to the real one. All writes go through the API. Documented here
so this isn't mistaken for an oversight later.
