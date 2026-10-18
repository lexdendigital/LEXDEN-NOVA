// /api/file-storage.js
//
// One place for ALL file storage, so the app no longer needs Firebase Storage
// (which is a paid feature). Files go to Cloudinary, which has a free plan.
//
//   savePrivate(path, buffer, mime)  -> { storagePath, storageProvider }
//        Private files: creator ID documents, paid downloads, delivery proof photos.
//        Stored as Cloudinary type "authenticated" (raw): there is NO public link.
//   signedDownloadUrl(asset, ttlMs)  -> temporary link that stops working after ttlMs
//   savePublicImage(path, buffer, mime) -> public https URL (product pictures)
//
// Needs these on Render:   CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
// Optional:                CLOUDINARY_CLOUD_NAME (defaults to the store's cloud)
//
// Old files already saved in Firebase still download (storageProvider missing =
// "firebase"), so nothing that exists today breaks.
const crypto = require('crypto');

const DEFAULT_CLOUD = 'z4nut80g';
const PUBLIC_PRESET = 'lexden-nova'; // existing unsigned preset the site already uses for pictures

function cloudName() { return (process.env.CLOUDINARY_CLOUD_NAME || DEFAULT_CLOUD).trim(); }
function cloudinaryReady() { return !!(process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET); }

function fail(message, status = 500, code = 'STORAGE_NOT_CONFIGURED') {
  return Object.assign(new Error(message), { status, code });
}

// Cloudinary signature: sort params, join as k=v&k=v, append the secret, SHA-1.
function sign(params, secret) {
  const base = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHash('sha1').update(base + secret).digest('hex');
}

async function postForm(url, fields, timeoutMs = 25000) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: 'POST', body: form, signal: ctl.signal });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    if (!r.ok) throw fail(`Cloudinary ${r.status}: ${(json && json.error && json.error.message) || text.slice(0, 200)}`, 502, 'STORAGE_UPLOAD_FAILED');
    return json;
  } catch (e) {
    if (e && e.name === 'AbortError') throw fail('File upload timed out. Please try again.', 504, 'STORAGE_TIMEOUT');
    throw e;
  } finally { clearTimeout(t); }
}

function toBlob(buffer, mime) { return new Blob([buffer], { type: mime || 'application/octet-stream' }); }

async function savePrivate(path, buffer, mime) {
  if (cloudinaryReady()) {
    const params = { public_id: path, timestamp: Math.floor(Date.now() / 1000), type: 'authenticated' };
    await postForm(`https://api.cloudinary.com/v1_1/${cloudName()}/raw/upload`, {
      ...params,
      api_key: process.env.CLOUDINARY_API_KEY,
      signature: sign(params, process.env.CLOUDINARY_API_SECRET),
      file: toBlob(buffer, mime),
    });
    return { storagePath: path, storageProvider: 'cloudinary' };
  }
  // Fallback only if someone still has Firebase Storage set up.
  const { getFirebaseBucket } = require('./affiliate/shared');
  if (!(process.env.FIREBASE_STORAGE_BUCKET || '').trim()) {
    throw fail('File storage is not set up. Add CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET on Render (Cloudinary → Settings → API Keys).');
  }
  await getFirebaseBucket().file(path).save(buffer, { contentType: mime, resumable: false });
  return { storagePath: path, storageProvider: 'firebase' };
}

// Temporary private link. expiresAtMs is an absolute time in ms.
async function signedDownloadUrl(asset, expiresAtMs) {
  if (asset && asset.storageProvider === 'cloudinary') {
    if (!cloudinaryReady()) throw fail('File storage is not set up (CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET missing).');
    const params = {
      public_id: asset.storagePath,
      type: 'authenticated',
      attachment: 'true',
      expires_at: Math.floor(expiresAtMs / 1000),
      timestamp: Math.floor(Date.now() / 1000),
    };
    const qs = new URLSearchParams({ ...params, api_key: process.env.CLOUDINARY_API_KEY, signature: sign(params, process.env.CLOUDINARY_API_SECRET) });
    return `https://api.cloudinary.com/v1_1/${cloudName()}/raw/download?${qs.toString()}`;
  }
  const { getFirebaseBucket } = require('./affiliate/shared');
  const [url] = await getFirebaseBucket().file(asset.storagePath).getSignedUrl({ action: 'read', expires: expiresAtMs });
  return url;
}

// Public pictures (product images). Uses the signed API when keys exist, else the
// same unsigned preset the website already uploads with — so this works even before
// the keys are added.
async function savePublicImage(path, buffer, mime) {
  const dataUri = `data:${mime};base64,${buffer.toString('base64')}`;
  const publicId = String(path).replace(/\.[a-z0-9]+$/i, '');
  const base = `https://api.cloudinary.com/v1_1/${cloudName()}/image/upload`;
  let json;
  if (cloudinaryReady()) {
    const params = { public_id: publicId, timestamp: Math.floor(Date.now() / 1000) };
    json = await postForm(base, { ...params, api_key: process.env.CLOUDINARY_API_KEY, signature: sign(params, process.env.CLOUDINARY_API_SECRET), file: dataUri });
  } else {
    json = await postForm(base, { upload_preset: PUBLIC_PRESET, public_id: publicId, file: dataUri });
  }
  if (!json || !json.secure_url) throw fail('Image upload did not return a link.', 502, 'STORAGE_UPLOAD_FAILED');
  return { url: json.secure_url, publicId: json.public_id };
}

async function deletePublicImage(publicId) {
  if (!cloudinaryReady() || !publicId) return;
  const params = { public_id: publicId, timestamp: Math.floor(Date.now() / 1000) };
  await postForm(`https://api.cloudinary.com/v1_1/${cloudName()}/image/destroy`, { ...params, api_key: process.env.CLOUDINARY_API_KEY, signature: sign(params, process.env.CLOUDINARY_API_SECRET) }).catch(() => {});
}

module.exports = { sign, cloudinaryReady, savePrivate, signedDownloadUrl, savePublicImage, deletePublicImage };
