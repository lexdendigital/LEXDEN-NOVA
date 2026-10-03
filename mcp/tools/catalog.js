// mcp/tools/catalog.js — Products & Categories tabs
const { z } = require('zod');
const { getDb } = require('../../api/affiliate/shared');
const { listCatalogDoc, upsertCatalogItem, deleteCatalogItem } = require('../lib/settings');
const { uploadRemoteUrlToCloudinary, generateProductImage } = require('../lib/media');

// Field names here match what index.html's admin form and storefront
// renderer actually read/write (confirmed by reading the real product
// object builder in index.html, not assumed) — NOT a generic guess. Earlier
// drafts of this tool used categoryId/price/active, which index.html never
// reads; that mismatch is why items written through those names rendered
// as blank on the storefront. Kept tolerant via .catchall so nothing the
// app itself uses gets rejected.
const productShape = z.object({
  id: z.string(),
  name: z.string().optional(),
  category: z.string().optional().describe('Category id, e.g. "gadgets" — this is the field index.html actually reads, NOT categoryId.'),
  itemCode: z.string().optional(),
  price: z.number().optional().describe('Regular price in NGN. 0/omitted = free.'),
  salePrice: z.number().optional(),
  productType: z.enum(['PHYSICAL', 'DIGITAL']).optional(),
  affiliateLink: z.string().optional(),
  status: z.enum(['Published', 'Draft']).optional(),
  tags: z.array(z.string()).optional(),
  allowAffiliateCommission: z.boolean().optional(),
  affiliateCommissionPercent: z.number().optional(),
  description: z.string().optional(),
  images: z.array(z.string()).optional(),
  specs: z.record(z.string()).optional().describe('Plain {label: value} object, e.g. {"Brand":"Samsung","RAM":"8GB"} — NOT an array.'),
  deliveryLink: z.string().optional(),
  fileUrl: z.string().optional(),
  externalPaymentLink: z.string().optional(),
  physical: z.object({
    stockMode: z.string().optional(),
    stockStatus: z.string().optional(),
    deliveryEstimate: z.string().optional(),
    shippingCountries: z.array(z.string()).optional(),
    weight: z.string().optional(),
    dimensions: z.string().optional(),
    returnPolicy: z.string().optional(),
    supplierId: z.string().optional(),
    supplierSku: z.string().optional(),
    supplierCost: z.number().optional(),
    supplierCurrency: z.string().optional(),
    routing: z.record(z.any()).optional(),
    cj: z.object({
      productId: z.string().optional(),
      variantId: z.string().optional(),
      sku: z.string().optional(),
      syncEnabled: z.boolean().optional(),
    }).partial().optional(),
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
    if (categoryId) list = list.filter((p) => p.category === categoryId || p.categoryId === categoryId);
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

  server.registerTool('nova_resolve_product_image', {
    title: 'Get/generate a product image and attach it',
    description: 'Use this ANY time a product needs an image and none of the candidate URLs you have are good enough — not just during CJ import. Pass referenceImageUrls if you found some candidates (e.g. from a web search) and want them tried first (they get re-hosted on Cloudinary so they survive even if the source disappears); if none are given, or all fail to upload, or mode is "generate_only" (use this when the human explicitly asks you to generate/create an image), this calls Gemini\'s image model to generate a clean product photo and uploads that instead. Always returns the final image URL. Pass productId to also attach it to that product in catalog/products (appended to images[], or made the cover photo if replaceCover is true); omit productId to just get a URL back without writing anything.',
    inputSchema: {
      name: z.string().describe('Product name — used as the image generation prompt subject if generation is needed.'),
      description: z.string().optional(),
      specs: z.record(z.string()).optional(),
      referenceImageUrls: z.array(z.string()).max(8).optional().describe('Candidate image URLs to try first, e.g. from a web search for this exact product. Leave empty to skip straight to generation.'),
      mode: z.enum(['auto', 'generate_only']).default('auto'),
      productId: z.string().optional().describe('If given, attaches the resolved image to this product in catalog/products.'),
      replaceCover: z.boolean().default(false).describe('If true and productId is given, the resolved image becomes images[0] instead of being appended.'),
    },
  }, async ({ name, description, specs, referenceImageUrls, mode, productId, replaceCover }) => {
    let resolvedUrl = null;
    let source = null;

    if (mode === 'auto' && referenceImageUrls && referenceImageUrls.length) {
      for (const url of referenceImageUrls) {
        const up = await uploadRemoteUrlToCloudinary(url);
        if (up.ok) { resolvedUrl = up.url; source = 'reference'; break; }
      }
    }

    if (!resolvedUrl) {
      const gen = await generateProductImage({ name, description, specs });
      if (!gen.ok) {
        return { content: [{ type: 'text', text: JSON.stringify({ resolved: false, error: gen.error }) }] };
      }
      resolvedUrl = gen.url;
      source = 'generated';
    }

    if (!productId) {
      return { content: [{ type: 'text', text: JSON.stringify({ resolved: true, url: resolvedUrl, source }) }] };
    }

    const db = getDb();
    const list = await listCatalogDoc(db, 'products');
    const existing = list.find((p) => p.id === productId);
    if (!existing) throw Object.assign(new Error(`No product with id "${productId}".`), { status: 404 });
    const images = Array.isArray(existing.images) ? existing.images.slice() : [];
    if (replaceCover) images.unshift(resolvedUrl); else images.push(resolvedUrl);
    const saved = await upsertCatalogItem(db, 'products', { id: productId, images: images.slice(0, 8) }, { isNew: false });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          resolved: true, url: resolvedUrl, source, attachedTo: productId,
          note: source === 'generated' ? 'This image is AI-generated, not a real product photo — flag that to the human.' : undefined,
          product: saved,
        }, null, 2),
      }],
    };
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
