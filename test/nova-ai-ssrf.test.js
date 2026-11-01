'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isAllowedImageUrl } = require('../api/nova-ai');

test('NOVA AI only fetches https images from the store\'s own image hosts', () => {
  assert.ok(isAllowedImageUrl('https://res.cloudinary.com/z4nut80g/image/upload/a.jpg'));
  assert.ok(isAllowedImageUrl('https://cf.cjdropshipping.com/x.jpg'));
  assert.ok(isAllowedImageUrl('https://images.unsplash.com/photo-1?w=800'));
  for (const bad of [
    'http://res.cloudinary.com/a.jpg', 'https://169.254.169.254/latest/meta-data/', 'http://localhost:3000/health',
    'https://evil.example.com/a.jpg', 'https://res.cloudinary.com.evil.com/a.jpg', 'https://user:pw@res.cloudinary.com/a.jpg',
    'https://res.cloudinary.com:8443/a.jpg', 'file:///etc/passwd', 'not a url', '',
  ]) assert.equal(isAllowedImageUrl(bad), false, bad);
});
