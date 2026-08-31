// Comprehensive Firestore rules coverage for the `buckets` collection,
// run against the local Firestore emulator using the real firestore.rules
// file (never weakened to make a test pass - see helpers/buckets.js).
const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { deleteField, serverTimestamp } = require('firebase/firestore');
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
  // Milestone 2B Checkpoint 4G-3: direct client Bucket creation is now
  // permanently closed - the trusted createBucket Cloud Function is the
  // sole creation path. Even an otherwise-perfectly-valid payload
  // (ownerId = uid, ownerId in memberIds, valid types) is denied.
  it('authenticated user: cannot directly create a bucket', async () => {
    await assertFails(
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

  // Milestone 2B Checkpoint 4G-3: Starting Balance is no longer a direct
  // client create input at all - it must go through the trusted
  // createBucket callable as startingBalanceMinor, which atomically
  // initializes balance/ledgerOpeningBalanceMinor/ledgerBalanceMinor
  // together.
  it('create: nonzero Starting Balance direct create is denied', async () => {
    await assertFails(
      bucketDoc(asOwner(), 'new-bucket').set(validBucketData({ balance: 500 }))
    );
  });

  it('create: zero Starting Balance direct create is denied', async () => {
    await assertFails(
      bucketDoc(asOwner(), 'new-bucket').set(validBucketData({ balance: 0 }))
    );
  });

  it('create: a negative Starting Balance is rejected', async () => {
    await assertFails(
      bucketDoc(asOwner(), 'new-bucket').set(validBucketData({ balance: -50 }))
    );
  });

  // Milestone 2B Checkpoint 4G-3: this was the exact nine-field shape the
  // OLD direct-write createBucket service used to send (see git history
  // of src/services/firebase/buckets.ts) - now that service invokes the
  // trusted callable instead, and this shape is denied unconditionally
  // regardless of how faithfully it reconstructs the former write.
  it('create: former nine-field client service shape is denied', async () => {
    await assertFails(
      bucketDoc(asOwner(), 'new-bucket').set({
        ...validBucketData(),
        createdAt: serverTimestamp(),
        lastUpdatedAt: serverTimestamp(),
        lastUpdatedBy: OWNER_UID,
      })
    );
  });

  it('create: an arbitrary extra field is rejected', async () => {
    await assertFails(
      bucketDoc(asOwner(), 'new-bucket').set(
        validBucketData({ notes: 'hi' })
      )
    );
  });

  // Milestone 2B Checkpoint 4F: the whole point of this checkpoint - a
  // client must never be able to inject either trusted ledger field, not
  // even at create time. The eventual canonical initialization of these
  // fields belongs solely to a future trusted create callable (Admin
  // SDK), never to a direct client write.
  it('create: ledgerBalanceMinor cannot be injected', async () => {
    await assertFails(
      bucketDoc(asOwner(), 'new-bucket').set(
        validBucketData({ ledgerBalanceMinor: 999999 })
      )
    );
  });

  it('create: ledgerOpeningBalanceMinor cannot be injected', async () => {
    await assertFails(
      bucketDoc(asOwner(), 'new-bucket').set(
        validBucketData({ ledgerOpeningBalanceMinor: 999999 })
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

  // Milestone 2B Checkpoint 4E: existing-Bucket balance is now
  // backend-managed only (see recordSavingsTransaction) - the owner can
  // no longer mutate it via a direct client update.
  it('owner: cannot directly change balance', async () => {
    await assertFails(bucketDoc(asOwner(), BUCKET_ID).update({ balance: 50 }));
  });

  it('owner: cannot delete balance', async () => {
    await assertFails(
      bucketDoc(asOwner(), BUCKET_ID).update({ balance: deleteField() })
    );
  });

  it('owner: cannot add ledgerBalanceMinor when absent', async () => {
    await assertFails(
      bucketDoc(asOwner(), BUCKET_ID).update({ ledgerBalanceMinor: 5000 })
    );
  });

  it('owner: cannot change ledgerBalanceMinor when already present', async () => {
    await seedBucket(
      testEnv,
      BUCKET_ID,
      validBucketData({ ledgerBalanceMinor: 5000, ledgerOpeningBalanceMinor: 5000 })
    );
    await assertFails(
      bucketDoc(asOwner(), BUCKET_ID).update({ ledgerBalanceMinor: 9999 })
    );
  });

  it('owner: cannot delete ledgerBalanceMinor when present', async () => {
    await seedBucket(
      testEnv,
      BUCKET_ID,
      validBucketData({ ledgerBalanceMinor: 5000, ledgerOpeningBalanceMinor: 5000 })
    );
    await assertFails(
      bucketDoc(asOwner(), BUCKET_ID).update({ ledgerBalanceMinor: deleteField() })
    );
  });

  it('owner: cannot add ledgerOpeningBalanceMinor when absent', async () => {
    await assertFails(
      bucketDoc(asOwner(), BUCKET_ID).update({ ledgerOpeningBalanceMinor: 5000 })
    );
  });

  it('owner: cannot change ledgerOpeningBalanceMinor when already present', async () => {
    await seedBucket(
      testEnv,
      BUCKET_ID,
      validBucketData({ ledgerBalanceMinor: 5000, ledgerOpeningBalanceMinor: 5000 })
    );
    await assertFails(
      bucketDoc(asOwner(), BUCKET_ID).update({ ledgerOpeningBalanceMinor: 9999 })
    );
  });

  it('owner: cannot delete ledgerOpeningBalanceMinor when present', async () => {
    await seedBucket(
      testEnv,
      BUCKET_ID,
      validBucketData({ ledgerBalanceMinor: 5000, ledgerOpeningBalanceMinor: 5000 })
    );
    await assertFails(
      bucketDoc(asOwner(), BUCKET_ID).update({ ledgerOpeningBalanceMinor: deleteField() })
    );
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

  it('member: cannot add/change ledgerBalanceMinor', async () => {
    await assertFails(
      bucketDoc(asMember(), BUCKET_ID).update({ ledgerBalanceMinor: 5000 })
    );
  });

  it('member: cannot add/change ledgerOpeningBalanceMinor', async () => {
    await assertFails(
      bucketDoc(asMember(), BUCKET_ID).update({ ledgerOpeningBalanceMinor: 5000 })
    );
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
