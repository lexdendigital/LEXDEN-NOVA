'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isAllowedOrigin } = require('../api/cors');

test('production CORS only accepts the configured exact storefront origin', () => {
  const previousMode = process.env.NODE_ENV;
  const previousOrigins = process.env.CORS_ALLOWED_ORIGINS;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.CORS_ALLOWED_ORIGINS;
    assert.equal(isAllowedOrigin('https://lexdendigital.github.io'), true);
    assert.equal(isAllowedOrigin('https://another-site.github.io'), false);
    assert.equal(isAllowedOrigin('https://some-service.onrender.com'), false);
    assert.equal(isAllowedOrigin('http://localhost:3000'), false);
    assert.equal(isAllowedOrigin('https://lexdendigital.github.io.evil.example'), false);
  } finally {
    if (previousMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousMode;
    if (previousOrigins === undefined) delete process.env.CORS_ALLOWED_ORIGINS; else process.env.CORS_ALLOWED_ORIGINS = previousOrigins;
  }
});

test('additional production origins must be explicitly listed in CORS_ALLOWED_ORIGINS', () => {
  const previousMode = process.env.NODE_ENV;
  const previousOrigins = process.env.CORS_ALLOWED_ORIGINS;
  try {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ALLOWED_ORIGINS = 'https://nova.example.com, https://admin.example.com';
    assert.equal(isAllowedOrigin('https://nova.example.com'), true);
    assert.equal(isAllowedOrigin('https://admin.example.com'), true);
    assert.equal(isAllowedOrigin('https://evil.example.com'), false);
  } finally {
    if (previousMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousMode;
    if (previousOrigins === undefined) delete process.env.CORS_ALLOWED_ORIGINS; else process.env.CORS_ALLOWED_ORIGINS = previousOrigins;
  }
});
