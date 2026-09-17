// mcp/tools/diagnostics.js
//
// Tools for troubleshooting the app itself, not just its data. Added
// alongside the rest of the MCP layer specifically so Claude can check
// things a human would otherwise have to go dig up in Firebase Console
// or Render's dashboard by hand.

const { z } = require('zod');
const { getAuthAdmin } = require('../../api/affiliate/shared');

// ---- recent in-memory server errors ----
// Render's free tier doesn't expose a log API, so this is a small ring
// buffer server.js pushes into (see recordServerError() wired up there).
// It only holds what happened since the last restart/deploy — real, but
// partial, and that limitation is stated plainly in the tool's output
// rather than glossed over.
const RECENT_ERRORS = [];
const MAX_RECENT_ERRORS = 50;
function recordServerError(entry) {
  RECENT_ERRORS.unshift({ ...entry, at: new Date().toISOString() });
  if (RECENT_ERRORS.length > MAX_RECENT_ERRORS) RECENT_ERRORS.length = MAX_RECENT_ERRORS;
}

async function fetchGithubFile({ repo, branch, path }) {
  const url = `https://raw.githubusercontent.com/${repo}/${branch}/${path}`;
  const headers = {};
  if (process.env.GITHUB_TOKEN) headers.Authorization = `token ${process.env.GITHUB_TOKEN}`;
  const r = await fetch(url, { headers });
  if (r.status === 404) throw Object.assign(new Error(`No file at ${path} on branch ${branch} of ${repo}.`), { status: 404 });
  if (!r.ok) throw Object.assign(new Error(`GitHub returned ${r.status} for ${path}.`), { status: 502 });
  return r.text();
}

// ---- Writing code: goes through the GitHub Contents API (needs
// GITHUB_TOKEN with `repo` write scope — read-only above works without
// any token on a public repo, this does not). Render's default setup
// auto-deploys on every push to the watched branch, so a successful
// commit here genuinely ships the change — there is no separate "deploy"
// step to run afterwards. That's also exactly why every write tool below
// requires confirm: true and a real commit message: this isn't a
// sandbox, it's your live site.
async function githubContentsRequest(method, { repo, path, query, body }) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw Object.assign(new Error('GITHUB_TOKEN env var is not set (needs "repo" write scope) — cannot write source files.'), { status: 500 });
  const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
  const url = `https://api.github.com/repos/${repo}/contents/${path}${qs}`;
  const r = await fetch(url, {
    method,
    headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'lexden-nova-mcp' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.message || `GitHub API returned ${r.status}.`), { status: r.status });
  return data;
}

async function getFileSha({ repo, branch, path }) {
  try {
    const data = await githubContentsRequest('GET', { repo, path, query: { ref: branch } });
    return data.sha;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function commitFile({ repo, branch, path, content, message, sha }) {
  const body = {
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch,
    ...(sha ? { sha } : {}),
  };
  const data = await githubContentsRequest('PUT', { repo, path, body });
  return { commitSha: data.commit && data.commit.sha, htmlUrl: data.content && data.content.html_url };
}

function register(server) {
  server.registerTool(
    'nova_check_admin_login',
    {
      title: 'Check admin login account',
      description: 'Looks up the Firebase Auth user record for the configured admin email (default: the one hardcoded as ADMIN_EMAIL in index.html) to diagnose "incorrect email or password" on the admin portal. Never returns or checks the password itself — Firebase never exposes it to anyone, including the Admin SDK — only whether the account exists, which sign-in providers it has, and whether it is disabled.',
      inputSchema: {
        email: z.string().email().optional().describe('Defaults to the ADMIN_EMAILS env var (or ruthanselem2@gmail.com if that is unset).'),
      },
    },
    async ({ email }) => {
      const target = email || (process.env.ADMIN_EMAILS || 'ruthanselem2@gmail.com').split(',')[0].trim();
      try {
        const user = await getAuthAdmin().getUserByEmail(target);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              found: true,
              email: user.email,
              uid: user.uid,
              disabled: user.disabled,
              providers: user.providerData.map((p) => p.providerId),
              hasPasswordProvider: user.providerData.some((p) => p.providerId === 'password'),
              createdAt: user.metadata.creationTime,
              lastSignInAt: user.metadata.lastSignInTime,
              note: user.providerData.some((p) => p.providerId === 'password')
                ? 'Account exists with a password provider — login failures are almost certainly a wrong/forgotten password. Use Firebase Console → Authentication → Users → Reset password.'
                : 'Account exists but has NO password provider (likely Google-only) — the admin portal login specifically requires email/password sign-in and will always reject this account until a password is set for it.',
            }, null, 2),
          }],
        };
      } catch (e) {
        if (e.code === 'auth/user-not-found') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                found: false,
                email: target,
                note: `No Firebase Auth user exists for ${target} at all. This is the most common cause of "incorrect email or password" on first setup — the admin account is not auto-created by anything in this app. Create it once in Firebase Console → Authentication → Users → Add user.`,
              }, null, 2),
            }],
          };
        }
        throw e;
      }
    }
  );

  server.registerTool(
    'nova_get_recent_server_errors',
    {
      title: 'Recent server errors',
      description: 'Returns unhandled errors/exceptions caught by the Express server since its last restart or deploy (in-memory only — Render\'s free tier has no persistent log API, so this resets on every deploy and does not cover errors from before that).',
      inputSchema: { limit: z.number().int().min(1).max(50).default(20) },
    },
    async ({ limit }) => ({
      content: [{ type: 'text', text: JSON.stringify(RECENT_ERRORS.slice(0, limit), null, 2) }],
    })
  );

  server.registerTool(
    'nova_get_deploy_info',
    {
      title: 'Deployment info',
      description: 'Node version, process uptime, and the deployed git commit (if Render\'s RENDER_GIT_COMMIT env var is set) — useful for confirming which version of the code is actually live before troubleshooting further.',
      inputSchema: {},
    },
    async () => ({
      content: [{
        type: 'text',
        text: JSON.stringify({
          nodeVersion: process.version,
          uptimeSeconds: Math.floor(process.uptime()),
          gitCommit: process.env.RENDER_GIT_COMMIT || null,
          renderServiceName: process.env.RENDER_SERVICE_NAME || null,
        }, null, 2),
      }],
    })
  );

  server.registerTool(
    'nova_read_source_file',
    {
      title: 'Read a source file from GitHub',
      description: 'Reads a file straight from the GitHub repo (read-only) so Claude can inspect the actual deployed code when troubleshooting a bug — e.g. path "index.html" or "server.js". Requires GITHUB_REPO env var (format "owner/repo"); works without any token for a public repo, or set GITHUB_TOKEN for a private one.',
      inputSchema: {
        path: z.string().describe('File path within the repo, e.g. "server.js" or "api/affiliate/admin.js".'),
        branch: z.string().default('main'),
      },
    },
    async ({ path, branch }) => {
      const repo = process.env.GITHUB_REPO;
      if (!repo) throw Object.assign(new Error('GITHUB_REPO env var is not set (format "owner/repo") — cannot read source files.'), { status: 500 });
      const text = await fetchGithubFile({ repo, branch, path });
      // Guard against dumping something enormous (e.g. index.html is
      // large) into the model's context in one shot — truncate with a
      // clear note rather than silently cutting content.
      const MAX_CHARS = 60000;
      const truncated = text.length > MAX_CHARS;
      return {
        content: [{
          type: 'text',
          text: (truncated ? text.slice(0, MAX_CHARS) : text)
            + (truncated ? `\n\n[...truncated — file is ${text.length} chars total; ask for a narrower range or a different file if you need more...]` : ''),
        }],
      };
    }
  );

  server.registerTool(
    'nova_replace_in_source_file',
    {
      title: 'Edit a source file (targeted find/replace)',
      description: 'Makes a small, precise code change and commits it straight to GitHub — Render auto-deploys on push, so this genuinely ships to your live site. oldText must appear EXACTLY ONCE in the file (whitespace included) or this refuses rather than guess which occurrence you meant. Always call nova_read_source_file on the same path first so the match is based on real current content, not a guess. Requires confirm: true.',
      inputSchema: {
        path: z.string(),
        branch: z.string().default('main'),
        oldText: z.string().describe('Exact text to replace — must match the file content in exactly one place.'),
        newText: z.string().describe('Replacement text. Empty string deletes the matched text.'),
        commitMessage: z.string().describe('Short, real commit message describing the change.'),
        confirm: z.literal(true),
      },
    },
    async ({ path, branch, oldText, newText, commitMessage }) => {
      const repo = process.env.GITHUB_REPO;
      if (!repo) throw Object.assign(new Error('GITHUB_REPO env var is not set (format "owner/repo").'), { status: 500 });
      const current = await fetchGithubFile({ repo, branch, path });
      const occurrences = current.split(oldText).length - 1;
      if (occurrences === 0) throw Object.assign(new Error('oldText was not found in the file — re-read the file, it may have changed, or the whitespace doesn\'t match exactly.'), { status: 409 });
      if (occurrences > 1) throw Object.assign(new Error(`oldText appears ${occurrences} times — make it unique by including more surrounding text, so there's no ambiguity about which one gets changed.`), { status: 409 });
      const updated = current.replace(oldText, newText);
      const sha = await getFileSha({ repo, branch, path });
      const result = await commitFile({ repo, branch, path, content: updated, message: commitMessage, sha });
      return { content: [{ type: 'text', text: JSON.stringify({ committed: true, ...result }, null, 2) }] };
    }
  );

  server.registerTool(
    'nova_write_source_file',
    {
      title: 'Create or fully overwrite a source file',
      description: 'Creates a new file, or replaces an entire existing file\'s content, and commits straight to GitHub (Render auto-deploys on push). Prefer nova_replace_in_source_file for editing an existing file — this is for genuinely new files, or a rewrite so large that a targeted replace doesn\'t make sense. Requires confirm: true.',
      inputSchema: {
        path: z.string(),
        branch: z.string().default('main'),
        content: z.string(),
        commitMessage: z.string(),
        confirm: z.literal(true),
      },
    },
    async ({ path, branch, content, commitMessage }) => {
      const repo = process.env.GITHUB_REPO;
      if (!repo) throw Object.assign(new Error('GITHUB_REPO env var is not set (format "owner/repo").'), { status: 500 });
      const sha = await getFileSha({ repo, branch, path }); // null for a brand-new file
      const result = await commitFile({ repo, branch, path, content, message: commitMessage, sha });
      return { content: [{ type: 'text', text: JSON.stringify({ committed: true, isNewFile: !sha, ...result }, null, 2) }] };
    }
  );
}

module.exports = { register, recordServerError };
