// Regenerates the ready-to-paste ChatGPT files in /chatgpt from the SAME code the server uses.
//   node scripts/generate-gpt-files.js [https://your-render-url]
const fs = require('fs');
const path = require('path');
const { buildOpenApi, buildInstructions } = require('../mcp/gptActions');
const base = (process.argv[2] || process.env.MCP_BASE_URL || 'https://lexden-nova.onrender.com').replace(/\/+$/, '');
const dir = path.join(__dirname, '..', 'chatgpt');
fs.mkdirSync(dir, { recursive: true });
for (const kind of ['admin', 'creator']) {
  fs.writeFileSync(path.join(dir, `openapi-${kind}.json`), JSON.stringify(buildOpenApi(kind, base), null, 2) + '\n');
  fs.writeFileSync(path.join(dir, `instructions-${kind}.txt`), buildInstructions(kind) + '\n');
}
console.log('wrote chatgpt/* for', base);
