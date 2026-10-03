# Merge + bugfix notes — 3 Oct 2026

This zip merges the two archives you uploaded and adds one fix.

## Base
Zip 2 (`Lexden-Nova-platform-update.zip`) — it already contained the full
UI/UX rebuild (category-specific product pages, affiliate badge gating,
Install button, free-content-first home page, variant/options system) and
a 24-test regression suite, which Zip 1 did not have.

## Ported in from Zip 1
- **Cloudinary re-hosting for CJ-imported images** (new file
  `mcp/lib/mediaRehost.js`, wired into `nova_cj_import_product` in
  `mcp/tools/cj.js`). Supplier image URLs are now re-uploaded to the same
  Cloudinary cloud/preset `index.html` already uses client-side, so a
  listing's photos survive even if the original supplier later deletes or
  moves them. If Cloudinary re-hosting fails for a given URL, the original
  URL is kept rather than the image being dropped.

## Deliberately NOT ported from Zip 1
- Zip 1's automatic Gemini image **generation** during import. Zip 2's own
  design is more deliberate here: `nova_upload_product_image`'s tool
  description already instructs the calling AI agent (Claude/ChatGPT) to
  generate and clearly label an image itself, as an explicit, reviewable
  step, rather than the server silently manufacturing a "photo" of a
  product no one has verified. Kept Zip 2's behavior.
- Zip 1's ChatGPT OAuth callback changes — Zip 2's `mcp/oauth.js` already
  has a superset of this (dynamic client registration, `offline_access`
  refresh scope for ChatGPT) that Zip 1 doesn't.

## CJ listV2 bug
Kept Zip 2's fix (corrected query params + `content[].productList[]`
flattening) — it's the one with passing regression coverage
(`test/cj-query.test.js`, `test/cj-normalize.test.js`).

## Bug audit performed
- `node --check` on every `.js` file in the repo: clean.
- `node --test`: **24/24 passing** after the merge.
- Read `server.js` end-to-end: route table, CORS, body-parsing (the
  `cj-webhook` raw-body exemption is correct — it reads the stream itself
  for HMAC verification), OAuth form-encoding fix, error-handling
  middleware — no bugs found.
- Read `api/gemini-shared.js`, `api/nova-ai.js`, `api/verify-paystack.js`
  end-to-end. **Root cause of all three live issues you reported (NOVA AI
  not reaching Gemini, Paystack not confirming, emails not sending) is
  simply that the required secrets were never set in Render's
  Environment tab** — the code already detects this and fails with an
  explicit, correct error message in each case; it is not silently
  swallowing the problem. See the chat for the full list of variables
  still needed from you (`GEMINI_API_KEY`, `BREVO_API_KEY`,
  `FIREBASE_PROJECT_ID`/`FIREBASE_CLIENT_EMAIL`/`FIREBASE_PRIVATE_KEY`,
  and a rotated `PAYSTACK_SECRET_KEY` live key).
- No `TODO`/`FIXME`/`XXX` markers left anywhere in the codebase.

## Already set on Render for you (not in this zip — these are server config, not code)
- `GITHUB_REPO=lexdendigital/LEXDEN-NOVA` (lets the MCP server read its own
  source for future debugging)
- `OTP_SIGNING_SECRET` — freshly generated random key
- `PAYSTACK_SECRET_KEY` — set to your **test** key for now

## Next
Push this zip over your repo, let Render redeploy, then send me the
remaining credentials listed above so I can finish wiring Gemini/Brevo/
Firebase Admin and switch Paystack to live once you've rotated that key.
