'use strict';

const crypto = require('node:crypto');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const FORMATS = {
  'image/png': { ext: 'png', magic: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  'image/jpeg': { ext: 'jpg', magic: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/webp': { ext: 'webp', magic: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
};

function decodeProductImage(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('generatedImage must contain a PNG, JPEG, or WebP image as base64 or a data URI.');
  let declaredType = '';
  let encoded = input.trim();
  const dataUri = encoded.match(/^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/i);
  if (dataUri) { declaredType = dataUri[1].toLowerCase(); encoded = dataUri[2]; }
  else if (encoded.startsWith('data:')) throw new Error('Only PNG, JPEG, and WebP base64 data URIs are accepted.');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) throw new Error('generatedImage is not valid base64.');
  const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error(`Image must be between 1 byte and ${MAX_IMAGE_BYTES} bytes.`);
  const match = Object.entries(FORMATS).find(([, spec]) => spec.magic(buffer));
  if (!match) throw new Error('Image content is not a valid PNG, JPEG, or WebP file.');
  if (declaredType && declaredType !== match[0]) throw new Error('The data URI media type does not match the image bytes.');
  return { buffer, contentType: match[0], extension: match[1].ext };
}

function safeProductId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(id)) throw new Error('productId must be an existing product id containing only letters, numbers, underscores, or hyphens.');
  return id;
}

function buildImagePath(productId, extension, uuid = crypto.randomUUID()) {
  return `products/${safeProductId(productId)}/generated/${uuid}.${extension}`;
}

function appendProductImage(product, url, alt) {
  const gallery = Array.isArray(product.gallery) ? product.gallery : [];
  if (gallery.length >= 8) throw new Error('This product already has the maximum of 8 gallery media items. Remove one in the admin portal before attaching another.');
  const images = Array.isArray(product.images) ? product.images : [];
  return { gallery: [...gallery, { url, type: 'image', alt }], images: images.includes(url) ? images : [...images, url] };
}

module.exports = { MAX_IMAGE_BYTES, decodeProductImage, safeProductId, buildImagePath, appendProductImage };
