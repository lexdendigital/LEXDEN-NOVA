# LEXDEN NOVA CREATOR — Stage D delivery

Digital delivery: the "order paid → entitlement issued → signed URL"
pipeline from the blueprint's §11, which Stage C's own README and
`creator-product-assets.js`'s file-level comment both explicitly deferred
to this stage. Backend only, same A→B→C split — no new screens in
`index.html` yet.

## What's implemented (and tested — 14 new tests, 98/98 total passing)

**New Firestore collection**, same `write: if false` discipline as every
other stage:
- `entitlements/{orderId_productId}` — proof a buyer may download a
  creator product's assets. Deterministic doc ID (`orderId_productId`)
  makes granting idempotent by construction — a retried payment-
  verification call can never double-grant or silently resurrect a
  revoked entitlement. Admin-only read (no legitimate client-side read —
  both new endpoints below go through the Admin SDK); every write goes
  through `grantEntitlement()` in `api/creator/entitlements.js`.

**`api/creator/entitlements.js`** — the shared module, split the same way
as every other stage between pure decision logic (unit-tested, no I/O)
and the thin Firestore wrapper around it:
- `resolveCreatorProductPrice(product, currency)` — pure. Mirrors
  `verify-paystack.js`'s existing `getExpectedAmount()` contract exactly:
  returns `null` for anything that can't be confidently priced (not
  `PUBLISHED`, no snapshot, non-positive price, currency mismatch) —
  `null` always means "don't fulfill," never "trust the client."
- `canDownloadAsset(entitlement)` — pure allow/deny decision given a
  plain entitlement object (or `null`).
- `grantEntitlement()` / `getEntitlement()` / `findActiveEntitlement()` —
  the Firestore side. `findActiveEntitlement` checks both `buyerUid` and
  `buyerEmail`, since `verify-paystack.js` already allows guest checkout
  (`uid` can be `null`) and a guest buyer should still be able to
  download later once they sign in with the same email.

**Hooked into `verify-paystack.js`'s order-completion path** — exactly
the cross-cutting change both Stage C's README and
`creator-product-assets.js` called out as Stage D's job, done as a
**pure addition**, not a rewrite:
- The existing legacy-catalog price lookup (`getExpectedAmount`) runs
  first, completely unchanged. Only if it returns `null` (productId isn't
  in the legacy `catalog/products` array) does a new fallback,
  `getCreatorProductSelection()`, check the `products/{id}` collection via
  the Admin SDK. This means every legacy product's checkout path is
  byte-for-byte what it was before this stage — zero risk to the
  already-proven, heavily-tested payment flow.
- When a creator-product purchase is detected, the order write gains
  three extra fields (`creatorProductId`, `creatorVersionId`,
  `creatorAssetIds`) — present only for creator-product orders, absent
  for every legacy order.
- `grantEntitlement()` is called **and awaited** right after the order
  write succeeds — unlike the email/CJ-order/affiliate calls just below
  it, which are intentionally fire-and-forget. An entitlement is part of
  what "fulfilled" means for a creator product, not a secondary effect.
- If the grant call itself fails (e.g. a transient Firestore error), the
  payment response still reports `ok:true` — the charge genuinely
  succeeded and the order genuinely exists, so reporting failure here
  would be wrong and could prompt a shopper to pay twice. Instead, the
  **existing idempotency check** at the top of the handler (which already
  short-circuits a retried call for a reference whose order exists) now
  also re-attempts the grant on that short-circuit path, using the
  `creatorProductId`/`creatorVersionId`/`creatorAssetIds` just saved on
  the order. This closes the gap a naive "await it, but don't fail the
  response either" approach would otherwise leave: without the retry
  hook, a failed grant would have no second chance, ever.

**Two new endpoints:**
```
GET /api/creator-product-download?productId=X
    -> { links: [{ assetId, fileName, mimeType, url, expiresAt }] }
    Any signed-in buyer (NOT gated behind requireActiveCreator — a buyer
    needn't be a creator). Checks for an active entitlement, then mints
    one Firebase Storage V4 signed URL per asset the entitlement covers,
    valid for 10 minutes. NO_ENTITLEMENT and REVOKED both return the same
    generic 403 on purpose — this endpoint can never be used to probe
    whether a given product was ever purchased, by anyone, revoked or not.

GET /api/creator-entitlements
    -> { entitlements: [{ id, productId, productTitle, grantedAt, price,
                           currency }] }
    The signed-in buyer's own active entitlements, for a future "My
    Library" screen. productTitle/price/currency are denormalized onto
    the entitlement at grant time specifically so this listing never
    needs a second product read per item, and still shows something
    sensible even if the product is later archived.
```

**New composite indexes** (`firestore.indexes.json`) for the three
queries the above two endpoints and `findActiveEntitlement` run:
`(productId, buyerUid, status)`, `(productId, buyerEmail, status)`, and
`(buyerUid, status, grantedAt desc)`.

## One deliberate deviation from the blueprint, same reasoning as Stage C

**Storage: Firebase Storage V4 signed URLs, not Cloudflare R2.** §11 specs
R2 for delivery; R2 still isn't provisioned anywhere in this app. Stage C
already put paid files in the same private Firebase Storage bucket KYC
documents use — this stage delivers off that same bucket rather than
standing up a second storage provider just for the download half of the
same files.

## What's NOT here — next steps

- **Storefront integration** — creator products still don't appear
  anywhere in the shop UI. A shopper can only end up buying one today if
  something elsewhere (a direct link, a future "My Library"/creator-store
  page) sends `productId` to the existing checkout flow with that
  product's own ID. This was already called out as its own,
  deliberately-separate piece of work in Stage C's README ("these are two
  different data models right now and merging them into the live
  storefront is its own careful piece of work") — still true, still not
  bundled into this stage either.
- **The actual "My Library" UI** in `index.html` — `creator-entitlements`
  and `creator-product-download` are ready for it, but no screen calls
  them yet.
- **Malware/AV scanning** on delivered files — still the same honest gap
  Stage C recorded (`scanStatus: 'not_scanned'`); this stage didn't touch
  it, it's orthogonal to delivery.
- **Refunds revoking entitlements** — `canDownloadAsset()` already
  understands a `'revoked'` status and the Firestore rules already permit
  an admin to read any entitlement for support purposes, but nothing yet
  *writes* `status: 'revoked'` — no refund/revoke workflow exists in the
  admin portal yet to call it from. A small, obvious next addition once
  there's an admin refund flow to wire it to, same relationship Stage A's
  README had with Stage B's signed-URL-reader-for-KYC-docs note.

## No new environment variables

This stage reuses the Firebase Admin credentials (`FIREBASE_PROJECT_ID`,
`FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`) and
`FIREBASE_STORAGE_BUCKET` every earlier stage already requires in Render.
Signed URL generation uses the same service-account credentials Admin SDK
init already needs — nothing additional to configure.
