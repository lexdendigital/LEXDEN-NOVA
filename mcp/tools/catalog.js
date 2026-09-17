// mcp/tools/catalog.js — Products & Categories tabs
const { z } = require('zod');
const { getDb } = require('../../api/affiliate/shared');
const { listCatalogDoc, upsertCatalogItem, deleteCatalogItem } = require('../lib/settings');

const productShape = z.object({
  id: z.string(),
  name: z.string().optional(),
  price: z.number().optional(),
  categoryId: z.string().optional(),
  description: z.string().optional(),
  images: z.array(z.string()).optional(),
  stock: z.number().optional(),
  active: z.boolean().optional(),
  physical: z.object({
    supplierId: z.string().optional(),
    routing: z.record(z.any()).optional(),
  }).partial().optional(),
}).catchall(z.any()); // this catalog has grown organically; don't reject fields the app itself uses that aren't listed above

const categoryShape = z.object({ id: z.string() }).catchall(z.any());

function register(server) {
  server.registerTool('nova_list_products', {
    title: 'List products',
    description: 'Lists every product in catalog/products, optionally filtered by category or a simple name/description text search.',
    inputSchema: {
      categoryId: z.string().optional(),
      search: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(50),
    },
  }, async ({ categoryId, search, limit }) => {
    const db = getDb();
    let list = await listCatalogDoc(db, 'products');
    if (categoryId) list = list.filter((p) => p.categoryId === categoryId);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((p) => (p.name || '').toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q));
    }
    return { content: [{ type: 'text', text: JSON.stringify(list.slice(0, limit), null, 2) }] };
  });

  server.registerTool('nova_get_product', {
    title: 'Get product',
    description: 'Fetches one product by id from catalog/products.',
    inputSchema: { id: z.string() },
  }, async ({ id }) => {
    const db = getDb();
    const list = await listCatalogDoc(db, 'products');
    const item = list.find((p) => p.id === id);
    if (!item) throw Object.assign(new Error(`No product with id "${id}".`), { status: 404 });
    return { content: [{ type: 'text', text: JSON.stringify(item, null, 2) }] };
  });

  server.registerTool('nova_create_product', {
    title: 'Create product',
    description: 'Adds a new product to catalog/products. id must not already exist — use nova_update_product to edit an existing one.',
    inputSchema: { product: productShape },
  }, async ({ product }) => {
    const db = getDb();
    const saved = await upsertCatalogItem(db, 'products', product, { isNew: true });
    return { content: [{ type: 'text', text: JSON.stringify(saved, null, 2) }] };
  });

  server.registerTool('nova_update_product', {
    title: 'Update product',
    description: 'Shallow-merges the given fields into an existing product (identified by id) in catalog/products. Only send the fields you want changed.',
    inputSchema: { product: productShape },
  }, async ({ product }) => {
    const db = getDb();
    const saved = await upsertCatalogItem(db, 'products', product, { isNew: false });
    return { content: [{ type: 'text', text: JSON.stringify(saved, null, 2) }] };
  });

  server.registerTool('nova_delete_product', {
    title: 'Delete product',
    description: 'Permanently removes a product from catalog/products. Requires confirm: true.',
    inputSchema: { id: z.string(), confirm: z.literal(true) },
  }, async ({ id }) => {
    const db = getDb();
    await deleteCatalogItem(db, 'products', id);
    return { content: [{ type: 'text', text: `Deleted product ${id}.` }] };
  });

  // Supplier Routing tab is really just product.physical.routing — a thin,
  // clearly-named wrapper on the same update path rather than a separate
  // storage location (confirmed by reading adminSupplierRouting() in
  // index.html; there is no separate "routing" collection to route to).
  server.registerTool('nova_update_supplier_routing', {
    title: 'Update product supplier routing',
    description: 'Sets which supplier fulfills a product and its routing config — this is the "Supplier Routing" admin tab, which is stored on the product itself (product.physical.routing), not a separate collection.',
    inputSchema: { productId: z.string(), supplierId: z.string().optional(), routing: z.record(z.any()).optional() },
  }, async ({ productId, supplierId, routing }) => {
    const db = getDb();
    const physical = {};
    if (supplierId !== undefined) physical.supplierId = supplierId;
    if (routing !== undefined) physical.routing = routing;
    const saved = await upsertCatalogItem(db, 'products', { id: productId, physical }, { isNew: false });
    return { content: [{ type: 'text', text: JSON.stringify(saved, null, 2) }] };
  });

  server.registerTool('nova_list_categories', {
    title: 'List categories',
    description: 'Lists every category in catalog/categories.',
    inputSchema: {},
  }, async () => {
    const db = getDb();
    const list = await listCatalogDoc(db, 'categories');
    return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
  });

  server.registerTool('nova_create_category', {
    title: 'Create category',
    description: 'Adds a new category to catalog/categories. id must not already exist.',
    inputSchema: { category: categoryShape },
  }, async ({ category }) => {
    const db = getDb();
    const saved = await upsertCatalogItem(db, 'categories', category, { isNew: true });
    return { content: [{ type: 'text', text: JSON.stringify(saved, null, 2) }] };
  });

  server.registerTool('nova_update_category', {
    title: 'Update category',
    description: 'Shallow-merges the given fields into an existing category by id.',
    inputSchema: { category: categoryShape },
  }, async ({ category }) => {
    const db = getDb();
    const saved = await upsertCatalogItem(db, 'categories', category, { isNew: false });
    return { content: [{ type: 'text', text: JSON.stringify(saved, null, 2) }] };
  });

  server.registerTool('nova_delete_category', {
    title: 'Delete category',
    description: 'Permanently removes a category from catalog/categories. Requires confirm: true. Does NOT reassign or delete products in that category — check nova_list_products with this categoryId first.',
    inputSchema: { id: z.string(), confirm: z.literal(true) },
  }, async ({ id }) => {
    const db = getDb();
    await deleteCatalogItem(db, 'categories', id);
    return { content: [{ type: 'text', text: `Deleted category ${id}.` }] };
  });
}

module.exports = { register };
