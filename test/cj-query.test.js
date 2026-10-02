'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCjQuery } = require('../api/cj-query');

test('serializes CJ array parameters as repeated keys and skips empty values', () => {
  const query = new URLSearchParams(buildCjQuery({
    page: 1, size: 20, keyWord: 'blue headphones',
    features: ['enable_description', 'enable_category', 'enable_video'],
    categoryId: undefined, countryCode: '',
  }));
  assert.deepEqual(query.getAll('features'), ['enable_description', 'enable_category', 'enable_video']);
  assert.equal(query.get('page'), '1');
  assert.equal(query.get('size'), '20');
  assert.equal(query.get('keyWord'), 'blue headphones');
  assert.equal(query.has('categoryId'), false);
  assert.equal(query.has('countryCode'), false);
});
