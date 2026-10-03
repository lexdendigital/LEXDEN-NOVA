// mcp/tools/catalog.js — Products & Categories tabs
const { z } = require('zod');
const { getDb, getFirebaseBucket } = require('../../api/affiliate/shared');
const { listCatalogDoc, upsertCatalogItem, appendCatalogProductMedia, deleteCatalogItem } = require('../lib/settings');
const { decodeProductImage, buildImagePath, appendProductImage } = require('../lib/productImage');
const { randomUUID } = require('node:crypto');

const productShape = z.object({
  id: z.string(),
  name: z.string().optional(),
  price: z.number().optional(),
  salePrice: z.number().nullable().optional(),
  discount: z.number().optional(),
  categoryId: z.string().optional(),
  categoryName: z.string().optional(),
  description: z.string().optional(),
  itemCode: z.string().optional(),
  productType: z.string().optional(),
  seller: z.string().optional(),
  affiliateLink: z.string().optional(),
  affiliateEnabled: z.boolean().optional(),
  affiliateCommissionPct: z.number().nullable().optional(),
  format: z.string().optional(),
  level: z.string().optional(),
  specs: z.record(z.string(), z.any()).optional(),
  gallery: z.array(z.object({ url: z.string(), type: z.string().optional(), alt: z.string().optional() }).catchall(z.any())).optional(),
  deliveryLink: z.string().optional(),
  fileUrl: z.string().optional(),
  externalPaymentLink: z.string().optional(),
  status: z.string().optional(),
  tags: z.array(z.string()).optional(),
  images: z.array(z.string()).optional(),
  options: z.array(z.object({
    id: z.string(), name: z.string(), values: z.array(z.object({ id: z.string(), label: z.string() }).catchall(z.any())).optional(),
  }).catchall(z.any())).optional(),
  variants: z.array(z.object({
    id: z.string(), title: z.string().optional(), optionValues: z.record(z.string(), z.string()).optional(),
    price: z.number().nullable().optional(), salePrice: z.number().nullable().optional(), stock: z.number().nullable().optional(),
    sku: z.string().optional(), active: z.boolean().optional(), available: z.boolean().optional(),
    deliveryLink: z.string().optional(), fileUrl: z.string().optional(), externalPaymentLink: z.string().optional(),
    affiliateLink: z.string().optional(), affiliateEnabled: z.boolean().nullable().optional(), affiliateCommissionPct: z.number().nullable().optional(),
    image: z.string().optional(), cjVariantId: z.string().optional(),
  }).catchall(z.any())).optional(),
  stock: z.number().optional(),
  active: z.boolean().optional(),
  physical: z.object({
    supplierId: z.string().optional(),
    routing: z.record(z.any()).optional(),
    stockMode: z.string().optional(),
    stockStatus: z.string().optional(),
    deliveryEstimate: z.string().optional(),
    shippingCountries: z.array(z.string()).optional(),
    weight: z.string().optional(),
    dimensions: z.string().optional(),
    returnPolicy: z.string().optional(),
    supplier: z.string().optional(),
    supplierSku: z.string().optional(),
    supplierCost: z.number().nullable().optional(),
    supplierCurrency: z.string().optional(),
    cj: z.record(z.string(), z.any()).optional(),
  }).partial().catchall(z.any()).optional(),
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
    description: 'Adds a complete new physical or digital Lexden Nova product to catalog/products. Populate all details known to you for the admin product form: productType, name, description, local categoryId, regular/sale price and currency/specs, format/level, seller, tags, up to 8 gallery media links, fulfillment and physical supplier/stock/shipping fields where applicable. Search the supplier and web for an exact model image; never attach a lookalike. If an exact image is unavailable or the admin requests generated artwork, generate a relevant image and attach it with nova_upload_product_image before finishing. For physical products, never generate imagery that invents product features or presents a fictional item as the exact product. Set status to draft until reviewed; never guess inventory, policies, currency conversion or model-specific specs. Add affiliateLink only when the admin has supplied it, and leave it empty otherwise. id must not already exist — use nova_update_product to edit an existing one.',
    inputSchema: { product: productShape },
  }, async ({ product }) => {
    const db = getDb();
    const saved = await upsertCatalogItem(db, 'products', product, { isNew: true });
    return { content: [{ type: 'text', text: JSON.stringify(saved, null, 2) }] };
  });

  server.registerTool('nova_update_product', {
    title: 'Update product',
    description: 'Shallow-merges the given fields into an existing physical or digital product (identified by id) in catalog/products. Only send the fields you want changed. When adding an affiliateLink, use the exact URL the admin provides. For a missing supplier image, search the web for the exact brand/model and attach only a verified match; do not use a lookalike or invented URL. If no exact match is available or the admin requests generated artwork, generate a relevant image and attach it with nova_upload_product_image. For physical products, generated images must not invent product features or imply they are exact supplier photography.',
    inputSchema: { product: productShape },
  }, async ({ product }) => {
    const db = getDb();
    const saved = await upsertCatalogItem(db, 'products', product, { isNew: false });
    return { content: [{ type: 'text', text: JSON.stringify(saved, null, 2) }] };
  });

  server.registerTool('nova_upload_product_image', {
    title: 'Upload and attach a product image',
    description: 'Uploads a ChatGPT-generated or otherwise admin-approved PNG, JPEG, or WebP image to Lexden Nova Firebase Storage and attaches its permanent URL to the selected existing product in catalog/products (gallery and images). Use when no exact product image can be verified, or when the admin requests generated artwork. Generate the image first, then send its base64 bytes or data:image/*;base64 URI. Provide honest alt text; for physical goods, generated artwork must be a clearly illustrative/lifestyle image and must not imply inaccurate product details. Does not publish the product. Maximum 5 MB; supports at most 8 gallery items.',
    inputSchema: {
      productId: z.string().min(1).max(120),
      generatedImage: z.string().min(1).max(7_000_000),
      alt: z.string().min(3).max(240),
    },
  }, async ({ productId, generatedImage, alt }) => {
    const db = getDb();
    const products = await listCatalogDoc(db, 'products');
    const product = products.find((item) => item.id === productId);
    if (!product) throw Object.assign(new Error(`No product with id "${productId}".`), { status: 404 });
    const { buffer, contentType, extension } = decodeProductImage(generatedImage);
    // Fail before uploading if the product gallery is already full.
    appendProductImage(product, 'https://pending.invalid/image', alt.trim());
    const token = randomUUID();
    const objectPath = buildImagePath(productId, extension);
    const bucket = getFirebaseBucket();
    const file = bucket.file(objectPath);
    await file.save(buffer, {
      resumable: false,
      metadata: {
        contentType,
        cacheControl: 'public,max-age=31536000,immutable',
        metadata: { firebaseStorageDownloadTokens: token, productId, origin: 'nova-mcp-product-image' },
      },
    });
    const imageUrl = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket.name)}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`;
    try {
      const saved = await appendCatalogProductMedia(db, productId, { url: imageUrl, type: 'image', alt: alt.trim() });
      return { content: [{ type: 'text', text: JSON.stringify({ productId, productName: product.name || '', imageUrl, alt: alt.trim(), galleryCount: (saved.gallery || []).length, status: saved.status || 'draft', message: 'Image uploaded and attached. The product publication status was not changed.' }, null, 2) }] };
    } catch (error) {
      await file.delete({ ignoreNotFound: true }).catch(() => {});
      throw error;
    }
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
