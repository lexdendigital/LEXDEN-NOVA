// /api/creator-documents.js
//
// LEXDEN NOVA CREATOR — Stage A.
//
// Blueprint §2 flags this exact problem: "product files are uploaded
// through Cloudinary's unsigned upload flow... confidential documents,
// quarantined creator files... should move to private controlled
// storage." Identity/business documents are exactly that — so unlike
// product images (which stay on Cloudinary, see mcp/lib/mediaRehost.js),
// this endpoint writes straight to the Firebase Storage bucket with NO
// public URL ever generated or stored. Only a short-lived admin-side
// signed URL (see api/creator-admin-applications.js) can ever read one
// back.
//
// POST /api/creator-documents  { docType, fileBase64, fileName, mimeType }
// GET  /api/creator-documents  -> the signed-in user's own document list
//                                 (metadata only — never the storage path)
const crypto = require('crypto');
const { getFirebaseBucket, requireAuth, writeCreatorAuditLog, getDb, FieldValue, ok, fail, setCors } = require('./creator/shared');

const ALLOWED_DOC_TYPES = ['identity', 'business_registration', 'address_evidence', 'other'];
const ALLOWED_MIME_TO_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };
const MAX_BYTES = 8 * 1024 * 1024; // 8MB — generous for a phone photo of an ID or a scanned PDF

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  let decoded;
  try {
    decoded = await requireAuth(req);
  } catch (e) {
    return fail(res, e);
  }
  const uid = decoded.uid;

  if (req.method === 'GET') {
    try {
      const snap = await getDb().collection('creatorDocuments').where('creatorId', '==', uid).get();
      const docs = snap.docs.map(d => {
        const v = d.data();
        return { id: d.id, docType: v.docType, fileName: v.fileName, reviewStatus: v.reviewStatus, createdAt: v.createdAt };
      });
      return ok(res, { documents: docs });
    } catch (e) {
      return fail(res, e);
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' } });
  }

  const { docType, fileBase64, fileName, mimeType } = req.body || {};
  if (!ALLOWED_DOC_TYPES.includes(docType)) {
    return fail(res, { status: 422, code: 'INVALID_DOC_TYPE', message: `docType must be one of: ${ALLOWED_DOC_TYPES.join(', ')}.` });
  }
  const ext = ALLOWED_MIME_TO_EXT[mimeType];
  if (!ext) {
    return fail(res, { status: 422, code: 'INVALID_MIME_TYPE', message: `mimeType must be one of: ${Object.keys(ALLOWED_MIME_TO_EXT).join(', ')}.` });
  }
  if (typeof fileBase64 !== 'string' || !fileBase64.length) {
    return fail(res, { status: 422, code: 'MISSING_FILE', message: 'fileBase64 is required.' });
  }

  let buffer;
  try {
    buffer = Buffer.from(fileBase64, 'base64');
  } catch {
    return fail(res, { status: 422, code: 'INVALID_BASE64', message: 'fileBase64 could not be decoded.' });
  }
  if (!buffer.length) {
    return fail(res, { status: 422, code: 'EMPTY_FILE', message: 'The decoded file is empty.' });
  }
  if (buffer.length > MAX_BYTES) {
    return fail(res, { status: 413, code: 'FILE_TOO_LARGE', message: `Files must be ${MAX_BYTES / (1024 * 1024)}MB or smaller.` });
  }

  const docId = crypto.randomUUID();
  const storagePath = `creator-documents/${uid}/${docId}.${ext}`;

  try {
    const bucket = getFirebaseBucket();
    const file = bucket.file(storagePath);
    // NOT { public: true } / no makePublic() call anywhere — this is the
    // whole point of this endpoint. Metadata-only, no predictable public
    // URL is ever handed back.
    await file.save(buffer, { contentType: mimeType, resumable: false });

    await getDb().collection('creatorDocuments').doc(docId).set({
      creatorId: uid,
      docType,
      storagePath,
      mimeType,
      fileName: typeof fileName === 'string' ? fileName.slice(0, 200) : null,
      sizeBytes: buffer.length,
      reviewStatus: 'PENDING_REVIEW',
      createdAt: FieldValue.serverTimestamp(),
    });

    await writeCreatorAuditLog({ actorUid: uid, actorRole: 'creator', action: 'document.uploaded', targetType: 'document', targetId: docId, metadata: { docType } });
    return ok(res, { documentId: docId, docType, reviewStatus: 'PENDING_REVIEW' }, 201);
  } catch (e) {
    return fail(res, e);
  }
};
