const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const firebasePath = path.join(__dirname, '..', 'js', 'firebase.js');
const source = fs.readFileSync(firebasePath, 'utf8');

function executableLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//'));
}

test('shopper auth never starts an anonymous Firebase identity', () => {
  const code = executableLines(source).join('\n');
  assert.equal(/\bsignInAnonymously\s*\(/.test(code), false);
  assert.equal(/getAuth\s*,\s*signInAnonymously\b/.test(code), false);
});

test('real shopper auth is explicitly configured for LOCAL persistence', () => {
  assert.match(source, /setPersistence\(fbAuth,\s*browserLocalPersistence\)/);
  assert.match(source, /window\.__fbAuthPersistenceReady\s*=\s*authPersistenceReady/);
});

test('email login and account creation wait for persistence setup', () => {
  assert.match(
    source,
    /window\.__emailSignIn\s*=\s*async function\([^)]*\)\s*\{\s*await authPersistenceReady;\s*const result = await signInWithEmailAndPassword/s
  );
  assert.match(
    source,
    /window\.__emailSignUp\s*=\s*async function\([^)]*\)\s*\{\s*await authPersistenceReady;\s*const result = await createUserWithEmailAndPassword/s
  );
});

test('Google sign-in waits for persistence setup before popup auth', () => {
  assert.match(
    source,
    /window\.__signInWithGoogle\s*=\s*async function\(\)\s*\{\s*try\s*\{\s*await authPersistenceReady;\s*const result = await signInWithPopup/s
  );
});

test('signed-out and legacy anonymous states expose no shopper uid', () => {
  assert.match(source, /Legacy anonymous Auth session ignored; guest mode retained\./);
  assert.match(
    source,
    /window\.__fbUid\s*=\s*null;\s*window\.__fbAdminEmail\s*=\s*null;\s*window\.__fbShopper\s*=\s*null;/s
  );
  assert.doesNotMatch(source, /window\.__fbUid\s*=\s*user\.uid;\s*window\.__fbAdminEmail\s*=\s*null;\s*window\.__fbShopper\s*=\s*null;/s);
});

test('sign-out does not create a replacement guest auth identity', () => {
  assert.match(source, /await signOut\(fbAuth\);/);
  const signoutStart = source.indexOf('window.__googleSignOut');
  assert.notEqual(signoutStart, -1);
  const signoutSection = source.slice(signoutStart);
  assert.equal(/signInAnonymously\s*\(/.test(signoutSection), false);
});
