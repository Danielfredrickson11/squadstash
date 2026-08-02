// Smallest possible smoke suite proving the local Firestore emulator +
// rules-unit-testing setup actually works end-to-end against the real
// firestore.rules file, before the full test matrix is added.
const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { createTestEnv } = require('./helpers/testEnv');

const OWNER_UID = 'owner-uid';
const MEMBER_UID = 'member-uid';
const OUTSIDER_UID = 'outsider-uid';
const BUCKET_ID = 'smoke-bucket';

let testEnv;

beforeAll(async () => {
  testEnv = await createTestEnv();
});

afterAll(async () => {
  if (testEnv) {
    await testEnv.cleanup();
  }
});

beforeEach(async () => {
  await testEnv.clearFirestore();

  // Seed with security rules disabled, per Milestone 1B instructions -
  // never weaken firestore.rules itself just to make seeding possible.
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context
      .firestore()
      .collection('buckets')
      .doc(BUCKET_ID)
      .set({
        ownerId: OWNER_UID,
        memberIds: [OWNER_UID, MEMBER_UID],
        name: 'Smoke Test Bucket',
        target: 100,
        balance: 0,
      });
  });
});

describe('firestore.rules smoke suite: buckets read access', () => {
  it('denies an unauthenticated user from reading a protected bucket', async () => {
    const unauthedDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(unauthedDb.collection('buckets').doc(BUCKET_ID).get());
  });

  it('allows a bucket member to read a bucket they belong to', async () => {
    const memberDb = testEnv.authenticatedContext(MEMBER_UID).firestore();
    await assertSucceeds(memberDb.collection('buckets').doc(BUCKET_ID).get());
  });

  it('denies an outsider from reading a bucket they do not belong to', async () => {
    const outsiderDb = testEnv.authenticatedContext(OUTSIDER_UID).firestore();
    await assertFails(outsiderDb.collection('buckets').doc(BUCKET_ID).get());
  });
});
