# LEXDEN NOVA — MCP Setup Guide

This connects Claude or ChatGPT to the existing Render backend for
admin operations — including product/catalog tools, code diagnostics,
and code editing. The storefront and backend also receive updates in
this archive; this guide covers only MCP connection setup.

## 1. Set these on Render (Dashboard → your service → Environment)

```
MCP_BASE_URL=https://lexden-nova.onrender.com
```
This MUST exactly match your real Render URL (no trailing slash) — it's
baked into OAuth redirect validation.

```
GITHUB_REPO=lexdendigital/LEXDEN-NOVA
```
Replace with your actual `owner/repo`. Needed for the code-reading and
code-editing tools (`nova_read_source_file`, `nova_replace_in_source_file`,
`nova_write_source_file`).

```
GITHUB_TOKEN=
```
Only needed for the two **write** tools (`nova_replace_in_source_file`,
`nova_write_source_file`) — reading works on a public repo without it.
Create one at github.com → Settings → Developer settings → Personal
access tokens → generate one scoped to just this repo with **Contents:
Read and write** permission (fine-grained token) — do NOT use a
classic token with full `repo` scope across every repo you own if you
can avoid it.

Everything else (`FIREBASE_*`, `PAYSTACK_SECRET_KEY`, etc.) stays as it
already is — the MCP layer reuses your existing Firebase Admin
connection, it doesn't need its own credentials.

Product image uploads also use Firebase Storage. Set `FIREBASE_STORAGE_BUCKET`
to the exact bucket name shown in Firebase Console → Storage (for example,
`your-project.firebasestorage.app` or `your-project.appspot.com`). The upload
tool intentionally requires this explicit value; it does not guess the bucket.

## 2. Make sure Render is actually running Node 20+

`package.json`'s `engines.node` is now `>=20` (the MCP SDK requires it).
Render usually respects this automatically, but to be certain: Render
Dashboard → your service → Environment → add `NODE_VERSION=20` if it
isn't already on 20 or later.

## 3. Deploy

Push this update (or upload the zip's contents over your repo) and let
Render redeploy. Confirm it's up:

```
curl https://lexden-nova.onrender.com/.well-known/oauth-authorization-server
```

You should get back JSON, not an error.

## 4. Connect Claude

Settings → Connectors → Add custom connector. Enter **exactly** this:

**Name**
```
LEXDEN NOVA Admin
```

**MCP server URL**
```
https://lexden-nova.onrender.com/mcp
```

**Requires sign-in** — leave this **ON** (it already defaults to on).

**OAuth client ID** — leave **blank**.
**OAuth client secret** — leave **blank**.

Leave both blank on purpose: this server implements Dynamic Client
Registration (`/register`), so Claude registers itself automatically the
first time you connect — there's no fixed client ID to type in. Tap
**Add**.

## 5. Connect ChatGPT

ChatGPT's custom MCP app workflow is available in supported plans and
workspaces. Full read/write MCP is currently available on ChatGPT
Business and Enterprise/Edu; personal Pro access is currently limited
to read/fetch actions. The setup is in ChatGPT on the web.

1. Enable Developer mode / custom MCP connectors in workspace or user
   settings (the available location depends on the plan).
2. Open **Apps → Create** and add a custom app.
3. Enter `https://lexden-nova.onrender.com/mcp` as the MCP server URL and
   select OAuth authentication.
4. Start **Scan tools**. Complete the Lexden Nova admin sign-in when
   ChatGPT opens the OAuth page, then wait for the tool scan to finish.
5. Create the app as a draft and test a read action such as listing
   products. Review the displayed write actions before using them.

The `nova_upload_product_image` tool lets ChatGPT attach generated artwork
to an existing product. Ask ChatGPT to create the image first, then call
the tool with that product's id, the generated PNG/JPEG/WebP bytes as a
base64 data URI, and accurate alt text. It stores the image in Firebase
Storage and adds its URL to both `gallery` and `images` on that product;
it does not publish the product. Uploads are limited to 5 MB and the
existing eight-item gallery limit still applies. Configure
`FIREBASE_STORAGE_BUCKET` before using this tool.

The server supports Dynamic Client Registration and stores the exact
redirect URL registered by the client. This allows ChatGPT's
workspace-specific OAuth callback URL while still checking it against
that client's registration. If a ChatGPT setup flow skips registration
and presents a fixed redirect URI instead, add that exact URI to
`MCP_EXTRA_REDIRECT_URIS` on Render, then redeploy.

ChatGPT requires a refresh-capable OAuth session for durable connections.
The authorization-server metadata advertises `offline_access`, and the
server issues refresh tokens. If ChatGPT reports OAuth discovery or
refresh problems, check the deployed metadata at
`https://lexden-nova.onrender.com/.well-known/oauth-authorization-server`.

## 6. First connection

Claude will open a sign-in page hosted by your own server (not a
Claude-branded page) titled "Connect Claude to LEXDEN NOVA". Sign in
with the same admin email + password you use for the admin portal
(`ruthanselem2@gmail.com` unless you've changed it). That's the actual
security check — this page talks to Firebase directly, your password
never touches this server. If sign-in succeeds but you're told "not the
LEXDEN NOVA admin account", you signed in as the wrong account.

After that, the assistant has access for up to 90 days (access tokens auto-
refresh every hour behind the scenes; you won't be asked to sign in
again unless 90 days pass or you disconnect the connector).

## 7. Try it

Ask Claude things like:
- "How many pending affiliate withdrawals do I have?"
- "Why does my admin login say incorrect password?" (uses
  `nova_check_admin_login` — this is the tool built for your current issue)
- "Add a new FAQ about shipping times"
- "Read server.js and tell me how CORS is configured"
- "Change the hero title on the homepage to X" (uses `nova_update_content`)

For product sourcing with CJ, search with `nova_cj_search_products`,
then import a reviewed result with `nova_cj_import_product`. It saves a
physical product as an unpublished draft and rejects duplicates. When
the supplier has no usable image, verify an exact model match on the web
before adding it through `nova_update_product`; do not substitute a
lookalike.

## Revoking access

There's no "disconnect" button inside this app (there's only one admin,
so no user-management UI was built for it) — remove the connector from
Claude's Settings → Connectors, or manually delete the
`mcpRefreshTokens`/`mcpAccessTokens` documents in Firestore Console if
you ever need to force an immediate cutoff before a token would
naturally expire.

## A note on the code-editing tools

`nova_replace_in_source_file` and `nova_write_source_file` commit
straight to your GitHub repo, and Render auto-deploys on every push to
the watched branch — there is no draft/staging step. Claude will always
ask you to confirm before using either (they require `confirm: true`),
but "confirm" in a chat message is not the same guarantee as a pull
request review. For anything you're not 100% sure about, ask Claude to
show you the change first ("show me the diff before you commit it")
rather than approving blind.

## Keeping two things in sync manually

Two admin tabs' data structurally cannot be reached by a server-side
tool, and the MCP tools say so rather than pretending otherwise:
- **Error Codes** — hardcoded in `index.html`'s `ERROR_CODES` constant,
  mirrored as a static copy in `mcp/tools/misc.js`. If you ever add or
  change a code in `index.html`, update the copy in that file too.
- **Logs** (the admin portal's own tab) — reads a browser-only
  `localStorage` activity log that never reaches the server. This is not
  fixable without changing what that tab stores; `nova_get_audit_log` is
  a genuinely different, server-side record (of MCP activity
  specifically), not a substitute for that tab.
