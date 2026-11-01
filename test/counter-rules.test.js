'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const rules = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');

test('public counters only accept a +1 step (likes and wishlists may also step -1)', () => {
  assert.match(rules, /function counterCreateValid\(\)[\s\S]*?count == 1/);
  assert.match(rules, /function counterStepValid\(step\)[\s\S]*?count == resource\.data\.count \+ step[\s\S]*?count >= 0/);
  for (const coll of ['feedViews', 'productViews', 'productClicks', 'productShares', 'feedShares']) {
    const m = rules.match(new RegExp('match /' + coll + '/\\{\\w+\\} \\{[\\s\\S]*?\\n    \\}'));
    assert.ok(m, coll);
    assert.match(m[0], /allow create: if counterCreateValid\(\);/);
    assert.match(m[0], /allow update: if counterStepValid\(1\);/);
    assert.doesNotMatch(m[0], /counterStepValid\(-1\)/);
  }
  for (const coll of ['feedLikes', 'productWishlists']) {
    const m = rules.match(new RegExp('match /' + coll + '/\\{\\w+\\} \\{[\\s\\S]*?\\n    \\}'));
    assert.ok(m, coll);
    assert.match(m[0], /counterStepValid\(1\) \|\| counterStepValid\(-1\)/);
  }
});

test('the app only ever sends +1 / -1 to those counters', () => {
  const core = fs.readFileSync(path.join(__dirname, '..', 'js', 'core.js'), 'utf8');
  const shopper = fs.readFileSync(path.join(__dirname, '..', 'js', 'shopper.js'), 'utf8');
  assert.match(core, /pushProductWishlistCountToCloud\(id, adding\?1:-1\)/);
  assert.match(shopper, /pushFeedLikeCountToCloud\(id, wasLiked \? -1 : 1\)/);
});
