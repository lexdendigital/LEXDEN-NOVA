# LEXDEN NOVA — Fix Batch (Sept 22, 2026)

Everything in this ZIP is your complete repo state again — push it over
your repo exactly like the last update. Code fixes are done. Four things
below are NOT code and I could not do them for you — do these FIRST,
they're most of the actual fix.

## Do these 4 things now (5 minutes, no code)

1. **Your MCP connector URL is typo'd.** In Claude → Settings →
   Connectors, your "LEXDEN NOVA Admin" connector is pointing at
   `lexden-nova.orender.com.mcp` — missing the "n" in "onrender" and a
   "/" turned into a ".". Edit it to exactly:
   `https://lexden-nova.onrender.com/mcp`
   This alone is very likely why "the MCP system isn't working" — it was
   never reaching your server at all.

2. **Your Render service is on the FREE plan**, which fully sleeps after
   ~15 minutes of no traffic and takes 30-60+ seconds to wake up. I
   pulled your Render logs directly: the server sat asleep for 3 days
   straight before waking up just now when I checked it. This is almost
   certainly your #1 "takes years to load" / "check your connections"
   problem — the very first request after any quiet period looks broken
   when it's actually just waking up.
   **Zero-cost fix:** sign up free at cron-job.org (or UptimeRobot), add
   a job hitting `GET https://lexden-nova.onrender.com/health` every 10
   minutes. That keeps it awake. While you're there, add the two jobs
   your own README already called for and that were never set up:
   - `GET /api/process-email-queue` every 5-10 min
   - `GET /api/process-abandon-emails` every 30 min

3. **Publish your Firestore rules.** A code push to Render/GitHub never
   updates Firestore's rules — those are published separately in
   Firebase Console. Your current code requires `status:'active'` on
   signup (instant-approve). If Firebase Console still has an older
   version of the rules, EVERY signup — including your own test signups
   — gets silently rejected, which is consistent with you never once
   getting into the dashboard. Firebase Console → Firestore Database →
   Rules → paste this repo's `firestore.rules` → **Publish**.

4. **Your Paystack key is almost certainly a TEST key.** "50 banks" and
   "daily test limit reached" are both textbook Paystack test-mode
   behavior (test keys are rate-limited on bank-list/account-resolve
   calls). Render → your service → Environment → replace
   `PAYSTACK_SECRET_KEY` with your LIVE secret key from Paystack
   dashboard → Settings → API Keys & Webhooks (starts with `sk_live_`,
   not `sk_test_`). The banks.js pagination bug itself was already fixed
   in an earlier session — it's this key that's actually capping you now.

## What I already fixed in this ZIP

- **Real error codes everywhere in the affiliate flow** (was: one
  generic "check your connection" for every failure, even when the
  real cause had nothing to do with the network). Every step now shows
  a specific `CODE: ...` alongside a specific message.
- **The dashboard no longer hangs silently.** `affiliate/index.html`'s
  entire load sequence (sign-in → profile → affiliate status →
  dashboard) had zero error handling at all — any failure just left a
  blank screen forever with nothing on it. It now shows a visible
  loader, a 20s timeout, and a real error screen with a Retry button
  and an error code if something goes wrong.
- **AI-powered repeated-failure diagnosis** (new: `POST
  /api/affiliate-diagnose`, `api/affiliate/diagnose.js`). After the
  SAME action fails 3 times in a row, a popup calls this endpoint with
  the exact error, what the person was doing, and a short log of their
  recent activity, and gets back a diagnosis grounded in the known,
  confirmed failure modes of this specific app (cold start, Firestore
  rules mismatch, Paystack test mode, missing env var, offline, CORS) —
  not a generic guess. If Gemini itself is unreachable, a keyword-based
  fallback still gives a specific answer instead of nothing.
- **Admin → Affiliate Program "Pending" list broadened.** It used to
  match `status==='pending'` exactly, which (since signups instantly
  activate now) can never match a NEW doc — so old records with a
  missing/different status field were invisible with no error shown.
  It now shows anything that isn't cleanly `active` or `suspended`, and
  there's a raw "Debug: all affiliate records" panel at the bottom so
  you can see literally every doc's real status/id if something's still
  not appearing where you expect.
- **Paystack test-mode detection** in `banks.js` and
  `resolve-account.js` — the "50 banks" / "limit reached" errors now
  come back with `code: "PAYSTACK_TEST_MODE"` and point straight at the
  live-key swap (item 4 above), instead of looking like a random
  failure.
- **MCP SDK version pinned exactly** (`2.0.0`, was `^2.0.0`) — that
  package is still officially in beta upstream; letting it auto-update
  to a future breaking version on your next deploy could silently take
  the whole backend down. (I also set `MCP_BASE_URL` and `NODE_VERSION`
  directly on your Render service just now via my Render access — those
  were correct already or newly set, no action needed from you there.)

## What I could NOT check/fix directly, and why

- I don't have a connector to your Firebase project, so I can't confirm
  what firestore.rules are actually live right now, or publish them —
  that's item 3 above.
- I have a Brevo connector available, but every call to it came back
  "No approval received" — I couldn't pull your sender/template info to
  auto-fill the `BREVO_*` Render env vars as you asked. Re-check that
  the Brevo connector is approved/authorized on your end, then ask me
  again and I'll pull real values in rather than guessing.
- I don't have GitHub write access, so I can't push this ZIP for you —
  same as last time, upload it over your repo yourself (all files,
  same paths, root level).

## If something's still broken after all of this

Open the "Debug: all affiliate records" panel in Admin → Affiliate
Program, and use the new error codes — they now tell you (and me, if
you paste them back) exactly which of the causes above it actually is,
instead of a dead-end "check your connection."
