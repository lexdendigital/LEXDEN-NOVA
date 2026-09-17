// mcp/index.js
//
// Wires the whole MCP layer into the existing Express app (see the
// `mountMcp(app)` call added near the bottom of server.js). Three things
// happen here:
//   1. OAuth endpoints (mcp/oauth.js) — unauthenticated by design, since
//      their entire job IS authenticating someone.
//   2. /mcp itself — gated by mcp/lib/authMiddleware.js, then handed to
//      the real MCP protocol handler from @modelcontextprotocol/server.
//   3. Every tool call gets wrapped with mcp/lib/audit.js logging and
//      turned into a clean isError result instead of a raw exception, so
//      a "product not found" reads as a normal tool response Claude can
//      react to, not a broken connection.

const { McpServer, createMcpHandler } = require('@modelcontextprotocol/server');
const { toNodeHandler } = require('@modelcontextprotocol/node');

const oauth = require('./oauth');
const { bearerAuthMiddleware } = require('./lib/authMiddleware');
const { writeAuditEntry } = require('./lib/audit');
const { recordServerError } = require('./tools/diagnostics');

const TOOL_MODULES = [
  require('./tools/diagnostics'),
  require('./tools/catalog'),
  require('./tools/content'),
  require('./tools/settingsArrays'),
  require('./tools/collections'),
  require('./tools/affiliate'),
  require('./tools/cj'),
  require('./tools/misc'),
];

function buildServer(authInfo) {
  const email = authInfo && authInfo.extra ? authInfo.extra.email : null;
  const mcpServer = new McpServer(
    { name: 'lexden-nova-admin', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // Wrap registerTool once, here, so none of the individual tool files
  // need to know audit logging or error-shaping exists.
  const originalRegisterTool = mcpServer.registerTool.bind(mcpServer);
  mcpServer.registerTool = (name, config, handler) => {
    const wrapped = async (args, extra) => {
      const started = Date.now();
      try {
        const result = await handler(args, extra);
        writeAuditEntry({ email, tool: name, args, ok: true, tookMs: Date.now() - started }).catch(() => {});
        return result;
      } catch (e) {
        writeAuditEntry({ email, tool: name, args, ok: false, error: e.message, tookMs: Date.now() - started }).catch(() => {});
        return { content: [{ type: 'text', text: `Error: ${e.message || 'Tool call failed.'}` }], isError: true };
      }
    };
    return originalRegisterTool(name, config, wrapped);
  };

  for (const mod of TOOL_MODULES) mod.register(mcpServer);
  return mcpServer;
}

function mountMcp(app) {
  if (!process.env.MCP_BASE_URL) {
    console.warn('[mcp] MCP_BASE_URL is not set — OAuth redirect/metadata URLs will fall back to the incoming request\'s own host, which breaks if that ever differs from your real public URL. Set MCP_BASE_URL in your environment (see MCP-SETUP.md).');
  }

  oauth.registerRoutes(app);

  const handler = createMcpHandler((ctx) => buildServer(ctx && ctx.authInfo), { legacy: 'stateless' });
  const nodeHandler = toNodeHandler(handler);
  const gate = bearerAuthMiddleware(oauth.baseUrl);

  app.all('/mcp', gate, (req, res) => nodeHandler(req, res, req.body));
}

module.exports = { mountMcp, recordServerError };
