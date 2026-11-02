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

function authedDb(uid = 'alice', email = 'alice@example.com', claims = {}) {
  return testEnv.authenticatedContext(uid, { email, ...claims }).firestore();
}

function adminDb(emailVerified = true) {
  return authedDb('admin-user', 'ruthanselem2@gmail.com', { email_verified: emailVerified });
}

async function seedUser(uid, data) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'users', uid), data);
  });
}

async function seedAffiliate(uid, data = {}) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'affiliates', uid), {
      status: 'active',
      balanceAvailable: 0,
      totalEarned: 0,
      ...data,
    });
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

test('K browser clients cannot write affiliateAttributions into shopper profiles', async () => {
  await seedUser('alice', normalProfile());
  const db = authedDb();

  const pending = {
    nova_aff_general: { ref: 'affiliate-123', ts: 1793307600000 },
  };

  await assertFails(setDoc(
    doc(db, 'users', 'alice'),
    { affiliateAttributions: pending },
    { merge: true },
  ));
});

test('L admin access requires the designated account and a verified email', async () => {
  const unverifiedAdmin = adminDb(false);
  const verifiedAdmin = adminDb(true);

  await assertFails(setDoc(doc(unverifiedAdmin, 'catalog', 'settings'), { content: {} }));
  await assertSucceeds(setDoc(doc(verifiedAdmin, 'catalog', 'settings'), { content: {} }));
});

test('M no browser client, including admin, can mutate affiliate account records', async () => {
  await seedAffiliate('alice', { payoutAccount: { accountNumber: '1234567890' } });
  const owner = authedDb();
  const verifiedAdmin = adminDb(true);

  await assertSucceeds(getDoc(doc(owner, 'affiliates', 'alice')));
  await assertSucceeds(getDoc(doc(verifiedAdmin, 'affiliates', 'alice')));

  await assertFails(setDoc(doc(owner, 'affiliates', 'alice'), { balanceAvailable: 999999 }, { merge: true }));
  await assertFails(updateDoc(doc(owner, 'affiliates', 'alice'), { balanceAvailable: 999999 }));
  await assertFails(deleteDoc(doc(owner, 'affiliates', 'alice')));

  await assertFails(setDoc(doc(verifiedAdmin, 'affiliates', 'bob'), { balanceAvailable: 999999 }));
  await assertFails(updateDoc(doc(verifiedAdmin, 'affiliates', 'alice'), { balanceAvailable: 999999 }));
  await assertFails(deleteDoc(doc(verifiedAdmin, 'affiliates', 'alice')));
});

test('N server-only collections reject reads and writes from browser SDKs', async () => {
  const client = authedDb();
  const serverOnly = [
    'cjAuth',
    'email_otps',
    'otp_ip_limits',
    'shippingQuotes',
    'storeFulfillmentJobs',
  ];

  for (const collectionName of serverOnly) {
    const ref = doc(client, collectionName, 'rules-test');
    await assertFails(getDoc(ref));
    await assertFails(setDoc(ref, { clientWrite: true }));
  }
});

test('O affiliate dashboard does not attempt the removed profile attribution write', () => {
  const affiliateHtml = fs.readFileSync(path.join(__dirname, '..', 'affiliate', 'index.html'), 'utf8');
  assert.doesNotMatch(affiliateHtml, /affiliateAttributions|mergePendingAttributionsToProfile/);
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

}