const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const RUN_FIRESTORE_RULE_TESTS = process.env.RUN_FIRESTORE_RULE_TESTS === '1';

if (!RUN_FIRESTORE_RULE_TESTS) {
  test('Firestore users authority rules suite', {
    skip: 'Run through the dedicated Firestore Emulator workflow.',
  }, () => {});
} else {
  const {
    assertFails,
    assertSucceeds,
    initializeTestEnvironment,
  } = require('@firebase/rules-unit-testing');

  const {
    doc,
    getDoc,
    setDoc,
    updateDoc,
    deleteDoc,
  } = require('firebase/firestore');

  const PROJECT_ID = 'demo-lexden-nova-v301';
  const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');

  let testEnv;

function normalProfile(uid = 'alice', email = 'alice@example.com') {
  return {
    uid,
    name: 'Alice Example',
    email,
    photoURL: 'https://example.test/alice.jpg',
    address: 'Lagos, Nigeria',
    occupation: 'Student',
    gender: 'Female',
    dob: '2008-04-12',
    country: 'Nigeria',
    state: 'Lagos',
    howHeard: 'Friend',
    legalAccepted: true,
    legalAcceptedAt: '2026-10-29T20:00:00.000Z',
    termsVersion: '1.0',
    privacyVersion: '1.0',
    marketingConsent: false,
    marketingConsentAt: '',
    marketingConsentSource: '',
    profileSetupDone: true,
    provider: 'password',
    updatedAt: '2026-10-29T20:00:00.000Z',
    createdAt: '2026-10-29T20:00:00.000Z',
  };
}

function authedDb(uid = 'alice', email = 'alice@example.com') {
  return testEnv.authenticatedContext(uid, { email }).firestore();
}

async function seedUser(uid, data) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'users', uid), data);
  });
}

test.before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host: '127.0.0.1',
      port: 8080,
      rules: fs.readFileSync(RULES_PATH, 'utf8'),
    },
  });
});

test.beforeEach(async () => {
  await testEnv.clearFirestore();
});

test.after(async () => {
  if (testEnv) await testEnv.cleanup();
});

test('A owner can create a legitimate shopper profile', async () => {
  const db = authedDb();
  await assertSucceeds(setDoc(doc(db, 'users', 'alice'), normalProfile()));
});

test('B owner cannot create another UID profile', async () => {
  const db = authedDb();
  await assertFails(setDoc(doc(db, 'users', 'bob'), normalProfile('bob', 'alice@example.com')));
});

test('C unauthenticated client cannot create or update a shopper profile', async () => {
  const anonDb = testEnv.unauthenticatedContext().firestore();
  await assertFails(setDoc(doc(anonDb, 'users', 'alice'), normalProfile()));

  await seedUser('alice', normalProfile());
  await assertFails(updateDoc(doc(anonDb, 'users', 'alice'), { name: 'Anonymous attacker' }));
});

test('D owner can perform a legitimate profile edit', async () => {
  await seedUser('alice', normalProfile());
  const db = authedDb();

  await assertSucceeds(updateDoc(doc(db, 'users', 'alice'), {
    name: 'Alice Updated',
    address: 'Abuja, Nigeria',
    occupation: 'Designer',
    updatedAt: '2026-10-29T21:00:00.000Z',
  }));
});

test('E owner cannot add generalAffiliateConsumed', async () => {
  await seedUser('alice', normalProfile());
  const db = authedDb();

  await assertFails(updateDoc(doc(db, 'users', 'alice'), {
    generalAffiliateConsumed: true,
  }));
});

test('F owner cannot reset generalAffiliateConsumed', async () => {
  await seedUser('alice', {
    ...normalProfile(),
    generalAffiliateConsumed: true,
  });
  const db = authedDb();

  await assertFails(updateDoc(doc(db, 'users', 'alice'), {
    generalAffiliateConsumed: false,
  }));
});

test('G replacement write cannot delete generalAffiliateConsumed', async () => {
  await seedUser('alice', {
    ...normalProfile(),
    generalAffiliateConsumed: true,
  });
  const db = authedDb();

  await assertFails(setDoc(doc(db, 'users', 'alice'), {
    ...normalProfile(),
    name: 'Replacement attempt',
  }));
});

test('H arbitrary future fields fail closed', async () => {
  await seedUser('alice', normalProfile());
  const db = authedDb();

  await assertFails(updateDoc(doc(db, 'users', 'alice'), {
    futureSensitiveField: true,
    balance: 999999,
  }));
});

test('I UID and email identity tampering are denied', async () => {
  await seedUser('alice', normalProfile());
  const db = authedDb();

  await assertFails(updateDoc(doc(db, 'users', 'alice'), { uid: 'bob' }));
  await assertFails(updateDoc(doc(db, 'users', 'alice'), { email: 'attacker@example.com' }));
});

test('J normal merge preserves existing server-owned state', async () => {
  await seedUser('alice', {
    ...normalProfile(),
    generalAffiliateConsumed: true,
  });
  const db = authedDb();

  const profileSave = {
    ...normalProfile(),
    name: 'Alice Merge Edit',
    address: 'Ibadan, Nigeria',
    updatedAt: '2026-10-29T21:30:00.000Z',
  };

  await assertSucceeds(setDoc(doc(db, 'users', 'alice'), profileSave, { merge: true }));

  const snap = await assertSucceeds(getDoc(doc(db, 'users', 'alice')));
  assert.equal(snap.data().generalAffiliateConsumed, true);
  assert.equal(snap.data().name, 'Alice Merge Edit');
});

test('K affiliateAttributions remains compatible client-owned legacy state', async () => {
  await seedUser('alice', normalProfile());
  const db = authedDb();

  const pending = {
    nova_aff_general: { ref: 'affiliate-123', ts: 1793307600000 },
  };

  await assertSucceeds(setDoc(
    doc(db, 'users', 'alice'),
    { affiliateAttributions: pending },
    { merge: true },
  ));

  const snap = await assertSucceeds(getDoc(doc(db, 'users', 'alice')));
  assert.deepEqual(snap.data().affiliateAttributions, pending);
});

test('additional: createdAt cannot be rewritten after it exists', async () => {
  await seedUser('alice', normalProfile());
  const db = authedDb();

  await assertFails(updateDoc(doc(db, 'users', 'alice'), {
    createdAt: '1999-01-01T00:00:00.000Z',
  }));
});

test('additional: create rejects UID or email that contradict Firebase Auth', async () => {
  const db = authedDb();

  await assertFails(setDoc(doc(db, 'users', 'alice'), normalProfile('bob', 'alice@example.com')));
  await assertFails(setDoc(doc(db, 'users', 'alice'), normalProfile('alice', 'attacker@example.com')));
});

test('V3.0.2 lifecycle: unauthenticated client cannot create lifecycle events', async () => {
  const db = testEnv.unauthenticatedContext().firestore();
  await assertFails(setDoc(doc(db, 'productViewEvents', 'e1'), { email: 'guest@example.com' }));
});

test('V3.0.2 lifecycle: anonymous authenticated client cannot create lifecycle events directly', async () => {
  const db = testEnv.authenticatedContext('anon-session', { firebase: { sign_in_provider: 'anonymous' } }).firestore();
  await assertFails(setDoc(doc(db, 'productViewEvents', 'e1'), { email: 'guest@example.com' }));
});

test('V3.0.2 lifecycle: signed-in shopper cannot create lifecycle events directly', async () => {
  const db = authedDb();
  await assertFails(setDoc(doc(db, 'productViewEvents', 'e1'), { email: 'alice@example.com' }));
});

test('V3.0.2 lifecycle: clients cannot read, update or delete lifecycle events', async () => {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'productViewEvents', 'e1'), {
      schemaVersion: 1,
      source: 'lifecycle-event-api',
      email: 'alice@example.com',
      lifecycleState: 'pending',
    });
  });

  const shopper = authedDb();
  const guest = testEnv.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(shopper, 'productViewEvents', 'e1')));
  await assertFails(getDoc(doc(guest, 'productViewEvents', 'e1')));
  await assertFails(updateDoc(doc(shopper, 'productViewEvents', 'e1'), { lifecycleState: 'completed' }));
  await assertFails(deleteDoc(doc(shopper, 'productViewEvents', 'e1')));
});

test('V3.0.2 lifecycle: Admin SDK-equivalent rules-disabled processing remains possible', async () => {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const ref = doc(context.firestore(), 'productViewEvents', 'server-event');
    await assertSucceeds(setDoc(ref, { source: 'lifecycle-event-api', lifecycleState: 'pending' }));
    await assertSucceeds(updateDoc(ref, { lifecycleState: 'completed' }));
    const snap = await assertSucceeds(getDoc(ref));
    assert.equal(snap.data().lifecycleState, 'completed');
    await assertSucceeds(deleteDoc(ref));
  });
});

}