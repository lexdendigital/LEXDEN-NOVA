# LEXDEN NOVA — MCP Implementation Report

## Later update included in this archive (2 October 2026)

The product catalog now includes `nova_upload_product_image`, which
validates PNG/JPEG/WebP image bytes (maximum 5 MB), uploads to the
explicit `FIREBASE_STORAGE_BUCKET`, and adds the permanent download URL
and alt text to the existing product's `gallery` and `images` using a
Firestore transaction. Product status is not changed. Configure the
bucket name in Render before calling it. This new storage path has not
been exercised against production credentials. The current source test
suite passes 18 tests; the detailed storefront and feature scope is in
`UPDATE-REPORT.md`. The rest of this report describes the original MCP
integration validation and remains historical context.

## What this is

A remote MCP server mounted at `/mcp` on your existing Render backend,
protected by a real OAuth 2.1 (authorization code + PKCE) flow that
piggybacks on your existing Firebase Auth admin account — no second
password, no separate user system. ~60 tools across every admin tab,
plus code-reading/troubleshooting and code-editing tools added at your
request partway through this build.

## Research done before writing any code

- Verified `@modelcontextprotocol/server` v2, `@modelcontextprotocol/node`,
  and `@modelcontextprotocol/express` are real, current packages (npm +
  official docs), that Node 20+ is genuinely required, and that they ship
  a CommonJS build compatible with this repo's existing `require()`-based
  style.
- Read Anthropic's actual custom-connector documentation
  (`support.claude.com`, `claude.com/docs`) rather than trusting the
  original README's summary of it — confirmed the OAuth requirements
  (PKCE, RFC 9728 protected resource metadata, the two
  `claude.ai`/`claude.com` redirect URIs) and that Claude supports
  Dynamic Client Registration, which is why the connector setup doesn't
  need a manually-entered client ID/secret.
- Installed the real SDK packages in a sandbox and ran an actual MCP
  server against them (unauthenticated 401 + `WWW-Authenticate`,
  `initialize`, `tools/list`, `tools/call`) before touching this repo, to
  confirm the wiring pattern actually works against Express 4 — this
  repo's exact stack — rather than assuming the docs' examples translate
  directly.
- Read the actual admin code in `index.html` (not just the README's
  description of it) to confirm every tab's real data source before
  writing a tool for it — this caught two things the original README got
  wrong (see "Deviations" below).

## What was tested

- **Syntax**: every new/modified file passed `node --check`.
- **Wiring**: the fully assembled `server.js`, with the real
  `@modelcontextprotocol/*` packages installed, boots successfully and:
  - `/health` responds normally (existing routes unaffected)
  - `/.well-known/oauth-protected-resource` and
    `/.well-known/oauth-authorization-server` return correct metadata
  - `/register` (Dynamic Client Registration) returns a valid client
  - `/mcp` without a token returns `401` with a correct
    `WWW-Authenticate: Bearer ... resource_metadata="..."` header
  - `/authorize` with a valid `redirect_uri` renders the sign-in page;
    with an untrusted `redirect_uri` it refuses rather than redirecting
    (the actual attack this validation exists to prevent)
- **Not tested** (no live credentials available in this environment):
  an actual Firebase sign-in through `/authorize`, a real `/token`
  exchange, any live Firestore read/write from a tool, any live Paystack
  transfer, any live CJ Dropshipping API call, and any live GitHub
  commit. All of that code follows the same patterns already proven out
  in this repo's existing handlers (same `getDb()`, same `cjFetch()`,
  same Paystack fetch helper) — but you should do one real end-to-end
  pass yourself after deploying: connect the connector, ask Claude to
  list your products, and confirm it comes back correctly before relying
  on any write tool.

## Deviations from the original README, and why

1. **No Dynamic Client Registration storage / client allowlist.** The
   README implied a "real" OAuth server tracks registered clients.
   `/register` here accepts any registration and hands back a random
   `client_id` — that ID is not the security boundary. The actual gate is
   the Firebase sign-in step at `/authorize`: no token is ever issued
   unless that succeeds AND the resulting email matches your admin
   account. This is a deliberate scope reduction appropriate for a
   single-admin store, not an oversight — see `mcp/oauth.js`'s header
   comment for the full reasoning.
2. **Opaque tokens, not JWTs.** Every MCP call already needs a Firestore
   round trip anyway, so verifying a hashed opaque token against
   Firestore costs nothing extra and — unlike a JWT — is actually
   revocable before it expires.
3. **"Error Codes" tab has no live tool.** It's a hardcoded
   `ERROR_CODES` object in `index.html`, never stored in Firestore. There
   is nothing there to read live. `nova_search_error_codes` uses a static
   mirrored copy instead, with a comment flagging it needs manual
   updates if `index.html`'s copy ever changes.
4. **"Logs" tab has no live tool either.** It reads a browser
   `localStorage` activity log — that data structurally never reaches
   the server. `nova_get_audit_log` is a real but different thing (MCP's
   own activity record), not a stand-in for that tab.
5. **"Reviews" has no approve/hide tool.** The admin portal itself only
   ever offers delete for a review — there's no status field to
   moderate. Rather than inventing a workflow the app doesn't have, only
   `nova_list_reviews`/`nova_delete_review` exist.
6. **Sitemap regeneration isn't wired to auto-publish.**
   `scripts/generate-sitemap.js` writes to the repo checkout for a GitHub
   Actions workflow to commit — that's a different execution context
   than the Render server. This update does not include a sitemap tool
   for that reason (rather than shipping one that silently wouldn't work);
   if you want this, say so and it can be added using the same
   GitHub-commit approach the code-editing tools already use.
7. **Supplier Routing is not a separate store.** Reading
   `adminSupplierRouting()` showed it's really `product.physical.routing`
   on the product itself. `nova_update_supplier_routing` is a thin,
   clearly-labeled wrapper on the product update path, not a separate
   collection.

## Files changed/added

- `api/affiliate/admin.js` — refactored into named exported functions
  (behavior unchanged; now callable from both the HTTP endpoint and MCP)
- `api/affiliate/shared.js` — added `getAuthAdmin()` export
- `server.js` — mounts MCP, adds in-memory recent-error tracking
- `package.json` — added MCP deps, bumped `engines.node` to `>=20`
- `.env.example` — documented new env vars
- `firestore.rules` — explicit deny rules for the four new MCP-only
  collections (defense in depth; the Admin SDK bypasses rules anyway)
- `mcp/` — the entire new module (OAuth server, token store, audit log,
  ~60 tools)
- `affiliate/index.html` — the earlier signup-flow fix from this same
  session is included in this same package for a coherent deploy

## Honest limitations to know about

- The in-memory recent-error log (`nova_get_recent_server_errors`)
  resets on every deploy/restart — Render's free tier has no persistent
  log API, so this only ever covers "since the last restart."
- Code-editing tools operate on GitHub directly; they have no awareness
  of Render's deploy status, so "committed" and "live" are usually the
  same thing within a minute or two, but aren't instantaneous.
- This was built and tested without your real Firebase/GitHub/Paystack
  credentials — see "What was tested" above for exactly what that does
  and doesn't cover.
