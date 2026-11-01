// mcp/publicTools.js — the PUBLIC, read-only tool set for AI assistants (no sign-in).
// Only data that product pages already show. No tool here can buy, reserve, change or
// delete anything, and none reads a user, order or payment record.
const { z } = require('zod');
const { fetchLiveProducts } = require('../scripts/generate-product-share-pages');
const { buildCatalog } = require('../scripts/generate-catalog');
const { filterProducts } = require('../api/catalog');

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const TTL_MS = 60 * 1000;
let cache = { at: 0, catalog: null };

async function getCatalog() {
  const now = Date.now();
  if (cache.catalog && now - cache.at < TTL_MS) return cache.catalog;
  cache = { at: now, catalog: buildCatalog(await fetchLiveProducts()) };
  return cache.catalog;
}
const text = (data, isError) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], ...(isError ? { isError: true } : {}) });

function register(server) {
  server.registerTool('search_products', {
    title: 'Search LEXDEN NOVA products',
    description: 'Search the public catalogue by words (name, description, category, seller) and/or kind. Prices are in USD. Each result has a page URL to send the shopper to; purchase happens on that page.',
    inputSchema: {
      query: z.string().max(100).optional(),
      type: z.enum(['digital', 'course', 'physical']).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: READ,
  }, async ({ query, type, limit }) => {
    const catalog = await getCatalog();
    const products = filterProducts(catalog.products, { q: query, type, limit });
    return text({ count: products.length, products });
  });

  server.registerTool('get_product', {
    title: 'Get one LEXDEN NOVA product',
    description: 'Full public details for one product id (for example "p15") from search_products.',
    inputSchema: { id: z.string().max(40) },
    annotations: READ,
  }, async ({ id }) => {
    const catalog = await getCatalog();
    const product = catalog.products.find((p) => p.id === id);
    return product ? text({ product }) : text({ error: 'No product with that id.' }, true);
  });

  server.registerTool('list_categories', {
    title: 'List LEXDEN NOVA categories',
    description: 'The categories that currently have products, with counts.',
    inputSchema: {},
    annotations: READ,
  }, async () => {
    const catalog = await getCatalog();
    const counts = {};
    catalog.products.forEach((p) => { const k = p.category || 'Other'; counts[k] = (counts[k] || 0) + 1; });
    return text({ categories: Object.entries(counts).map(([name, count]) => ({ name, count })) });
  });
}

const INSTRUCTIONS = 'LEXDEN NOVA public catalogue (read-only). Use search_products to find items, get_product for details. Prices are USD; the page URL on each product is where a person buys it. You cannot purchase, and you should not claim stock or delivery beyond what the data says.';

module.exports = { register, INSTRUCTIONS };
