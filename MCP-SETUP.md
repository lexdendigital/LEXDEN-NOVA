# LEXDEN NOVA — MCP Setup Guide

This turns your existing Render backend into something Claude can connect
to directly and manage your admin portal through — ~60 tools covering
every admin tab, plus code troubleshooting and code editing. Nothing
about your existing storefront, admin portal UI, or API endpoints
changed; this is purely additive.

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

## 4. Add the connector in Claude

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

## 5. First connection

Claude will open a sign-in page hosted by your own server (not a
Claude-branded page) titled "Connect Claude to LEXDEN NOVA". Sign in
with the same admin email + password you use for the admin portal
(`ruthanselem2@gmail.com` unless you've changed it). That's the actual
security check — this page talks to Firebase directly, your password
never touches this server. If sign-in succeeds but you're told "not the
LEXDEN NOVA admin account", you signed in as the wrong account.

After that, Claude has access for up to 90 days (access tokens auto-
refresh every hour behind the scenes; you won't be asked to sign in
again unless 90 days pass or you disconnect the connector).

## 6. Try it

Ask Claude things like:
- "How many pending affiliate withdrawals do I have?"
- "Why does my admin login say incorrect password?" (uses
  `nova_check_admin_login` — this is the tool built for your current issue)
- "Add a new FAQ about shipping times"
- "Read server.js and tell me how CORS is configured"
- "Change the hero title on the homepage to X" (uses `nova_update_content`)

## 6b. Connecting ChatGPT too (same server, no code changes needed)

This server is a standard OAuth2 + MCP implementation (Dynamic Client
Registration, PKCE S256, RFC 8707 resource binding) — it was never
Claude-specific, it just didn't have ChatGPT's callback URL allow-listed
yet. To add ChatGPT:

1. In ChatGPT: Settings → Connectors → Advanced/Developer mode → Add
   custom connector (or "Create" under Apps & Connectors). Enter the
   same MCP server URL: `https://lexden-nova.onrender.com/mcp`.
2. ChatGPT will show you *its own* callback URL on that screen (it
   changes occasionally — copy whatever it actually shows you rather
   than assuming one). On Render, add it to:
   ```
   MCP_EXTRA_REDIRECT_URIS=<paste ChatGPT's callback URL here>
   ```
   (comma-separate if you ever add more than one extra redirect URI).
3. Redeploy, then finish connecting in ChatGPT the same way as step 5
   above — sign in with the admin email/password.

Every tool (including the CJ import and AI image generation/upload
tools) works identically from ChatGPT once connected — it's the same
server, same tools, same Firestore. Nothing in this project is
Claude-only.

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
