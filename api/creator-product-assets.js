// /api/creator-product-assets.js
//
// LEXDEN NOVA CREATOR — Stage C.
//
// Uploads a digital product's deliverable file (the thing a buyer
// actually gets — a PDF, a zip, an installer). Documented deviation from
// the blueprint §11, which specs Cloudflare R2 for this: R2 isn't
// provisioned anywhere in this app. Firebase Storage already provides the
// same "private bucket, no public URL, admin/owner-gated access" shape
// Stage A's creator-documents.js uses for KYC files — reusing it here
// avoids standing up a second storage provider for the same job. A real
// gap this leaves, honestly: no malware/antivirus scan runs on these
// files (the blueprint's asset pipeline wants one) — `scanStatus` is
// recorded as 'not_scanned' rather than silently implying one happened.
// Wiring an actual scanner is Stage D-or-later work, not a quick addition.
//
// Also NOT yet built here: the buyer-side signed-URL download flow
// (blueprint's "order paid → entitlement issued → signed URL" pipeline).
// That requires hooking into verify-paystack.js's order-completion path —
// a cross-cutting change deliberately left for Stage D, not bolted on
// here. This endpoint only gets a file INTO the system; getting it back
// OUT to a paying buyer is Stage D.
//
// POST /api/creator-product-assets { productId, fileBase64, fileName, mimeType }
// GET  /api/creator-product-assets?productId=X -> own assets for that product
const crypto = require('crypto');
const { getFirebaseBucket, requireActiveCreator, getProductDoc, writeProductAuditLog, getDb, FieldValue, ok, fail, setCors } = require('./creator/shared');

const ALLOWED_MIME_TO_EXT = {
  'application/pdf': 'pdf', 'application/zip': 'zip', 'application/x-zip-compressed': 'zip',
  'application/epub+zip': 'epub', 'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'image/jpeg': 'jpg', 'image/png': 'png',
};
const MAX_BYTES = 8 * 1024 * 1024; // see file-level comment — larger files need a direct-to-storage flow, not base64-over-JSON; that's Stage D scope too

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  let decoded;
  try {
    ({ decoded } = await requireActiveCreator(req));
  } catch (e) {
    return fail(res, e);
  }
  const uid = decoded.uid;

  if (req.method === 'GET') {
    try {
      const productId = req.query && req.query.productId;
      if (!productId) return fail(res, { status: 422, code: 'MISSING_PRODUCT_ID', message: 'productId is required.' });
      const product = await getProductDoc(productId);
      if (!product || product.creatorId !== uid) return fail(res, { status: 404, code: 'NOT_FOUND', message: 'No product found.' });
      const snap = await getDb().collection('productAssets').where('productId', '==', productId).get();
      return ok(res, { assets: snap.docs.map(d => { const v = d.data(); return { id: d.id, fileName: v.fileName, mimeType: v.mimeType, sizeBytes: v.sizeBytes, scanStatus: v.scanStatus, createdAt: v.createdAt }; }) });
    } catch (e) {
      return fail(res, e);
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' } });
  }

  const { productId, fileBase64, fileName, mimeType } = req.body || {};
  const product = productId && await getProductDoc(productId);
  if (!product || product.creatorId !== uid) return fail(res, { status: 404, code: 'NOT_FOUND', message: 'No product found.' });

  const ext = ALLOWED_MIME_TO_EXT[mimeType];
  if (!ext) return fail(res, { status: 422, code: 'INVALID_MIME_TYPE', message: `mimeType must be one of: ${Object.keys(ALLOWED_MIME_TO_EXT).join(', ')}.` });
  if (typeof fileBase64 !== 'string' || !fileBase64.length) return fail(res, { status: 422, code: 'MISSING_FILE', message: 'fileBase64 is required.' });

  let buffer;
  try { buffer = Buffer.from(fileBase64, 'base64'); } catch { return fail(res, { status: 422, code: 'INVALID_BASE64', message: 'fileBase64 could not be decoded.' }); }
  if (!buffer.length) return fail(res, { status: 422, code: 'EMPTY_FILE', message: 'The decoded file is empty.' });
  if (buffer.length > MAX_BYTES) return fail(res, { status: 413, code: 'FILE_TOO_LARGE', message: `Files must be ${MAX_BYTES / (1024 * 1024)}MB or smaller for now.` });

  const assetId = crypto.randomUUID();
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const storagePath = `product-assets/${uid}/${productId}/${assetId}.${ext}`;

  try {
    const bucket = getFirebaseBucket();
    await bucket.file(storagePath).save(buffer, { contentType: mimeType, resumable: false });

    await getDb().collection('productAssets').doc(assetId).set({
      productId, creatorId: uid, storagePath, mimeType,
      fileName: typeof fileName === 'string' ? fileName.slice(0, 200) : null,
      sizeBytes: buffer.length,
      sha256,
      scanStatus: 'not_scanned', // see file-level comment — honest, not a stub pretending otherwise
      reviewStatus: 'PENDING_REVIEW',
      createdAt: FieldValue.serverTimestamp(),
    });

    await writeProductAuditLog({ actorUid: uid, actorRole: 'creator', action: 'asset.uploaded', productId, metadata: { assetId, mimeType, sizeBytes: buffer.length } });
    return ok(res, { assetId, mimeType, sizeBytes: buffer.length }, 201);
  } catch (e) {
    return fail(res, e);
  }
};
