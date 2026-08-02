// Comprehensive Firestore rules coverage for the `buckets` collection,
// run against the local Firestore emulator using the real firestore.rules
// file (never weakened to make a test pass - see helpers/buckets.js).
const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { createTestEnv } = require('./helpers/testEnv');
const {
  OWNER_UID,
  MEMBER_UID,
  OUTSIDER_UID,
  BUCKET_ID,
  validBucketData,
  seedBucket,
  bucketDoc,
  bucketsCollection,
} = require('./helpers/buckets');

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
});

// Small helpers so individual `it` blocks stay focused on actor + action.
function asOwner() {
  return testEnv.authenticatedContext(OWNER_UID);
}
function asMember() {
  return testEnv.authenticatedContext(MEMBER_UID);
}
function asOutsider() {
  return testEnv.authenticatedContext(OUTSIDER_UID);
}
function asUnauthenticated() {
  return testEnv.unauthenticatedContext();
}

describe('firestore.rules: buckets - authentication and reads', () => {
  beforeEach(async () => {
    await seedBucket(testEnv, BUCKET_ID, validBucketData());
  });

  it('unauthenticated user: cannot read a bucket', async () => {
    await assertFails(bucketDoc(asUnauthenticated(), BUCKET_ID).get());
  });

  it('owner: can read their bucket', async () => {
    await assertSucceeds(bucketDoc(asOwner(), BUCKET_ID).get());
  });

  it('member who is not owner: can read the bucket', async () => {
    await assertSucceeds(bucketDoc(asMember(), BUCKET_ID).get());
  });

  it('outsider: cannot read the bucket', async () => {
    await assertFails(bucketDoc(asOutsider(), BUCKET_ID).get());
  });

  it('authenticated member: a memberIds-scoped query returns the permitted bucket', async () => {
    const snap = await assertSucceeds(
      bucketsCollection(asMember()).where('memberIds', 'array-contains', MEMBER_UID).get()
    );
    expect(snap.docs.map((d) => d.id)).toContain(BUCKET_ID);
  });

  it('outsider: cannot retrieve a protected bucket through a query for another user', async () => {
    await assertFails(
      bucketsCollection(asOutsider()).where('memberIds', 'array-contains', OWNER_UID).get()
    );
  });
});

describe('firestore.rules: buckets - create', () => {
  it('authenticated user: can create a valid bucket (ownerId = uid, ownerId in memberIds, valid types)', async () => {
    await assertSucceeds(
      bucketDoc(asOwner(), 'new-bucket').set(validBucketData())
    );
  });

  it('unauthenticated user: cannot create a bucket', async () => {
    await assertFails(
      bucketDoc(asUnauthenticated(), 'new-bucket').set(validBucketData())
    );
  });

  it('user: cannot create a bucket owned by another user', async () => {
    await assertFails(
      bucketDoc(asOwner(), 'new-bucket').set(
        validBucketData({ ownerId: OUTSIDER_UID })
      )
    );
  });

  it('create: owner must be included in memberIds', async () => {
    await assertFails(
      bucketDoc(asOwner(), 'new-bucket').set(
        validBucketData({ memberIds: [MEMBER_UID] })
      )
    );
  });

  it('create: invalid memberIds type is rejected', async () => {
    await assertFails(
      bucketDoc(asOwner(), 'new-bucket').set(
        validBucketData({ memberIds: OWNER_UID })
      )
    );
  });

  it('create: invalid target type is rejected', async () => {
    await assertFails(
      bucketDoc(asOwner(), 'new-bucket').set(
        validBucketData({ target: '100' })
      )
    );
  });

  it('create: invalid balance type is rejected', async () => {
    await assertFails(
      bucketDoc(asOwner(), 'new-bucket').set(
        validBucketData({ balance: '0' })
      )
    );
  });

  it('create: invalid name type is rejected', async () => {
    await assertFails(
      bucketDoc(asOwner(), 'new-bucket').set(
        validBucketData({ name: 123 })
      )
    );
  });
});

describe('firestore.rules: buckets - owner updates', () => {
  beforeEach(async () => {
    await seedBucket(testEnv, BUCKET_ID, validBucketData());
  });

  it('owner: can update name', async () => {
    await assertSucceeds(bucketDoc(asOwner(), BUCKET_ID).update({ name: 'Renamed' }));
  });

  it('owner: can update target', async () => {
    await assertSucceeds(bucketDoc(asOwner(), BUCKET_ID).update({ target: 250 }));
  });

  it('owner: can update balance', async () => {
    await assertSucceeds(bucketDoc(asOwner(), BUCKET_ID).update({ balance: 50 }));
  });

  it('owner: can update color', async () => {
    await assertSucceeds(bucketDoc(asOwner(), BUCKET_ID).update({ color: '#EF4444' }));
  });

  it('owner: can update memberIds while keeping themselves included', async () => {
    await assertSucceeds(
      bucketDoc(asOwner(), BUCKET_ID).update({ memberIds: [OWNER_UID, MEMBER_UID, OUTSIDER_UID] })
    );
  });

  it('owner: can update lastUpdatedAt and lastUpdatedBy', async () => {
    await assertSucceeds(
      bucketDoc(asOwner(), BUCKET_ID).update({
        lastUpdatedAt: new Date(),
        lastUpdatedBy: OWNER_UID,
      })
    );
  });

  it('owner: cannot change ownerId', async () => {
    await assertFails(bucketDoc(asOwner(), BUCKET_ID).update({ ownerId: MEMBER_UID }));
  });

  it('owner: cannot remove themselves from memberIds', async () => {
    await assertFails(bucketDoc(asOwner(), BUCKET_ID).update({ memberIds: [MEMBER_UID] }));
  });

  it('owner: cannot add arbitrary fields not in the allowlist', async () => {
    await assertFails(bucketDoc(asOwner(), BUCKET_ID).update({ notes: 'not allowed' }));
  });

  it('owner: cannot write an invalid field type (balance)', async () => {
    await assertFails(bucketDoc(asOwner(), BUCKET_ID).update({ balance: 'fifty' }));
  });
});

describe('firestore.rules: buckets - non-owner member updates', () => {
  beforeEach(async () => {
    await seedBucket(testEnv, BUCKET_ID, validBucketData());
  });

  it('member: can update name (in the non-owner allowlist)', async () => {
    await assertSucceeds(bucketDoc(asMember(), BUCKET_ID).update({ name: 'Member Renamed' }));
  });

  it('member: can update color (in the non-owner allowlist)', async () => {
    await assertSucceeds(bucketDoc(asMember(), BUCKET_ID).update({ color: '#10B981' }));
  });

  it('member: can update lastUpdatedAt and lastUpdatedBy (in the non-owner allowlist)', async () => {
    await assertSucceeds(
      bucketDoc(asMember(), BUCKET_ID).update({
        lastUpdatedAt: new Date(),
        lastUpdatedBy: MEMBER_UID,
      })
    );
  });

  it('member: cannot change target', async () => {
    await assertFails(bucketDoc(asMember(), BUCKET_ID).update({ target: 999 }));
  });

  it('member: cannot change balance', async () => {
    await assertFails(bucketDoc(asMember(), BUCKET_ID).update({ balance: 999 }));
  });

  it('member: cannot change ownerId', async () => {
    await assertFails(bucketDoc(asMember(), BUCKET_ID).update({ ownerId: MEMBER_UID }));
  });

  it('member: cannot change memberIds', async () => {
    await assertFails(
      bucketDoc(asMember(), BUCKET_ID).update({ memberIds: [OWNER_UID, MEMBER_UID, OUTSIDER_UID] })
    );
  });

  it('member: cannot add arbitrary fields not in the allowlist', async () => {
    await assertFails(bucketDoc(asMember(), BUCKET_ID).update({ notes: 'not allowed' }));
  });
});

describe('firestore.rules: buckets - outsider and unauthenticated updates', () => {
  beforeEach(async () => {
    await seedBucket(testEnv, BUCKET_ID, validBucketData());
  });

  it('outsider: cannot update the bucket', async () => {
    await assertFails(bucketDoc(asOutsider(), BUCKET_ID).update({ name: 'Hijacked' }));
  });

  it('unauthenticated user: cannot update the bucket', async () => {
    await assertFails(bucketDoc(asUnauthenticated(), BUCKET_ID).update({ name: 'Hijacked' }));
  });
});

describe('firestore.rules: buckets - deletes', () => {
  beforeEach(async () => {
    await seedBucket(testEnv, BUCKET_ID, validBucketData());
  });

  it('owner: can delete the bucket', async () => {
    await assertSucceeds(bucketDoc(asOwner(), BUCKET_ID).delete());
  });

  it('non-owner member: cannot delete the bucket', async () => {
    await assertFails(bucketDoc(asMember(), BUCKET_ID).delete());
  });

  it('outsider: cannot delete the bucket', async () => {
    await assertFails(bucketDoc(asOutsider(), BUCKET_ID).delete());
  });

  it('unauthenticated user: cannot delete the bucket', async () => {
    await assertFails(bucketDoc(asUnauthenticated(), BUCKET_ID).delete());
  });
});
