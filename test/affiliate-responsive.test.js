const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const affiliateHtml = fs.readFileSync(path.join(__dirname, '..', 'affiliate', 'index.html'), 'utf8');

test('affiliate dashboard has responsive desktop, visible focus, and reduced-motion rules', () => {
  assert.match(affiliateHtml, /@media\s*\(min-width:\s*900px\)/);
  assert.match(affiliateHtml, /\.screen:has\(\.stat-grid\)/);
  assert.match(affiliateHtml, /:focus-visible\s*\{/);
  assert.match(affiliateHtml, /prefers-reduced-motion:\s*reduce/);
  assert.match(affiliateHtml, /min-height:\s*44px/);
});
