// Shared fixtures/helpers for buckets rules tests. Keeps the actual test
// files focused on the "actor -> action -> expected outcome" being tested,
// not on repeating the same seed/document-shape boilerplate.
const OWNER_UID = 'owner-uid';
const MEMBER_UID = 'member-uid';
const OUTSIDER_UID = 'outsider-uid';
const BUCKET_ID = 'test-bucket';

function validBucketData(overrides = {}) {
  return {
    ownerId: OWNER_UID,
    memberIds: [OWNER_UID, MEMBER_UID],
    name: 'Test Bucket',
    target: 100,
    balance: 0,
    color: '#2563EB',
    ...overrides,
  };
}

// Seeds a document bypassing security rules entirely, per Milestone 1B
// instructions - firestore.rules itself must never be weakened just to
// make seeding possible.
async function seedBucket(testEnv, id, data) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().collection('buckets').doc(id).set(data);
  });
}

function bucketDoc(context, id) {
  return context.firestore().collection('buckets').doc(id);
}

function bucketsCollection(context) {
  return context.firestore().collection('buckets');
}

module.exports = {
  OWNER_UID,
  MEMBER_UID,
  OUTSIDER_UID,
  BUCKET_ID,
  validBucketData,
  seedBucket,
  bucketDoc,
  bucketsCollection,
};
