// Firestore rules coverage for the `savingsTransactions` collection
// (Milestone 2B ledger). Run against the local Firestore emulator using
// the real firestore.rules file (never weakened to make a test pass).
//
// Reuses the existing buckets/trips helpers to seed parent resources -
// no shared helper file is modified; this file stays self-contained per
// Checkpoint 2's scope (firestore.rules, firestore.indexes.json, and
// this test file only).
const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { serverTimestamp, Timestamp } = require('firebase/firestore');
const { createTestEnv } = require('./helpers/testEnv');
const {
  OWNER_UID,
  MEMBER_UID,
  OUTSIDER_UID,
  BUCKET_ID,
  validBucketData,
  seedBucket,
} = require('./helpers/buckets');
const {
  TRIP_ID,
  validTripData,
  seedTrip,
} = require('./helpers/trips');

// A second bucket, owned/held entirely by MEMBER_UID, used to represent
// a Trip member's own trip_personal fund - OWNER_UID is the owner of
// TRIP_ID but is not a member of this bucket at all.
const TRIP_PERSONAL_BUCKET_ID = 'test-trip-personal-bucket';

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

function transactionDoc(context, id) {
  return context.firestore().collection('savingsTransactions').doc(id);
}
function transactionsCollection(context) {
  return context.firestore().collection('savingsTransactions');
}

async function seedTransaction(id, data) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().collection('savingsTransactions').doc(id).set(data);
  });
}

// Valid payload shape a client would send when creating a transaction -
// createdAt is deliberately a real serverTimestamp() sentinel, matching
// how the future write service is expected to call it (see
// src/types/domain/savingsTransaction.ts's CreateSavingsTransactionInput
// doc comment: createdAt is always server-generated).
function validContribution(overrides = {}) {
  return {
    resourceType: 'bucket',
    resourceId: BUCKET_ID,
    memberUid: MEMBER_UID,
    recordedBy: MEMBER_UID,
    amountMinor: 1000,
    currency: 'USD',
    type: 'contribution',
    createdAt: serverTimestamp(),
    ...overrides,
  };
}

function validWithdrawal(overrides = {}) {
  return validContribution({ type: 'withdrawal', ...overrides });
}

function validTripContribution(overrides = {}) {
  return validContribution({
    resourceType: 'trip',
    resourceId: TRIP_ID,
    ...overrides,
  });
}

describe('firestore.rules: savingsTransactions - reads', () => {
  beforeEach(async () => {
    await seedBucket(testEnv, BUCKET_ID, validBucketData());
    await seedTrip(testEnv, TRIP_ID, validTripData());
  });

  it('1. unauthenticated user cannot get a bucket transaction', async () => {
    await seedTransaction('txn-1', validContribution());
    await assertFails(transactionDoc(asUnauthenticated(), 'txn-1').get());
  });

  it('2. unauthenticated user cannot query bucket transactions', async () => {
    await seedTransaction('txn-1', validContribution());
    await assertFails(
      transactionsCollection(asUnauthenticated())
        .where('resourceType', '==', 'bucket')
        .where('resourceId', '==', BUCKET_ID)
        .get()
    );
  });

  it('3. bucket member can get a bucket transaction', async () => {
    await seedTransaction('txn-1', validContribution());
    await assertSucceeds(transactionDoc(asMember(), 'txn-1').get());
  });

  it('4. unrelated user cannot get a bucket transaction', async () => {
    await seedTransaction('txn-1', validContribution());
    await assertFails(transactionDoc(asOutsider(), 'txn-1').get());
  });

  it('5. bucket member can perform the resource-scoped history query', async () => {
    await seedTransaction('txn-1', validContribution());
    await seedTransaction('txn-2', validWithdrawal({ amountMinor: 200 }));

    const snap = await assertSucceeds(
      transactionsCollection(asMember())
        .where('resourceType', '==', 'bucket')
        .where('resourceId', '==', BUCKET_ID)
        .orderBy('createdAt', 'desc')
        .get()
    );
    expect(snap.docs.map((d) => d.id).sort()).toEqual(['txn-1', 'txn-2']);
  });

  it('6. unrelated user cannot perform that bucket history query', async () => {
    await seedTransaction('txn-1', validContribution());
    await assertFails(
      transactionsCollection(asOutsider())
        .where('resourceType', '==', 'bucket')
        .where('resourceId', '==', BUCKET_ID)
        .orderBy('createdAt', 'desc')
        .get()
    );
  });

  it('7. trip member can get a trip transaction', async () => {
    await seedTransaction('txn-trip-1', validTripContribution());
    await assertSucceeds(transactionDoc(asMember(), 'txn-trip-1').get());
  });

  it('8. unrelated user cannot get a trip transaction', async () => {
    await seedTransaction('txn-trip-1', validTripContribution());
    await assertFails(transactionDoc(asOutsider(), 'txn-trip-1').get());
  });

  it('9. trip member can perform the trip-scoped history query', async () => {
    await seedTransaction('txn-trip-1', validTripContribution());

    const snap = await assertSucceeds(
      transactionsCollection(asMember())
        .where('resourceType', '==', 'trip')
        .where('resourceId', '==', TRIP_ID)
        .orderBy('createdAt', 'desc')
        .get()
    );
    expect(snap.docs.map((d) => d.id)).toEqual(['txn-trip-1']);
  });

  it('10. unrelated user cannot perform that trip history query', async () => {
    await seedTransaction('txn-trip-1', validTripContribution());
    await assertFails(
      transactionsCollection(asOutsider())
        .where('resourceType', '==', 'trip')
        .where('resourceId', '==', TRIP_ID)
        .orderBy('createdAt', 'desc')
        .get()
    );
  });

  it('11. trip owner does not gain access to a trip_personal bucket merely via linkedTripId', async () => {
    // MEMBER_UID's own trip_personal fund for OWNER_UID's trip - OWNER_UID
    // is not in this bucket's ownerId/memberIds at all.
    await seedBucket(
      testEnv,
      TRIP_PERSONAL_BUCKET_ID,
      validBucketData({
        ownerId: MEMBER_UID,
        memberIds: [MEMBER_UID],
        bucketType: 'trip_personal',
        linkedTripId: TRIP_ID,
      })
    );
    await seedTransaction(
      'txn-personal-1',
      validContribution({ resourceId: TRIP_PERSONAL_BUCKET_ID })
    );

    // OWNER_UID owns the linked Trip but is not a member/owner of this
    // trip_personal bucket - access must be denied.
    await assertFails(transactionDoc(asOwner(), 'txn-personal-1').get());
    // Sanity: the bucket's actual owner can still read it.
    await assertSucceeds(transactionDoc(asMember(), 'txn-personal-1').get());
  });

  it('44. a malformed transaction with an invalid resourceType cannot be read, even if resourceId matches a real Trip', async () => {
    // Seeded only with security rules disabled - this shape could never
    // pass the create rule (validResourceType rejects it there too), but
    // proves the read path independently denies it rather than falling
    // through parentExists()/parentData()'s bucket-vs-else ternary and
    // accidentally treating it as a Trip reference.
    await seedTransaction(
      'txn-malformed-1',
      validContribution({ resourceType: 'expense', resourceId: TRIP_ID })
    );

    await assertFails(transactionDoc(asOwner(), 'txn-malformed-1').get());
    await assertFails(transactionDoc(asMember(), 'txn-malformed-1').get());
  });

  it('45. a resource-scoped query for the invalid resourceType cannot expose the malformed transaction', async () => {
    await seedTransaction(
      'txn-malformed-1',
      validContribution({ resourceType: 'expense', resourceId: TRIP_ID })
    );

    await assertFails(
      transactionsCollection(asMember())
        .where('resourceType', '==', 'expense')
        .where('resourceId', '==', TRIP_ID)
        .get()
    );
  });
});

describe('firestore.rules: savingsTransactions - create (self)', () => {
  beforeEach(async () => {
    await seedBucket(testEnv, BUCKET_ID, validBucketData());
    await seedTrip(testEnv, TRIP_ID, validTripData());
  });

  it('12. bucket member can record their own contribution', async () => {
    await assertSucceeds(
      transactionDoc(asMember(), 'txn-1').set(validContribution())
    );
  });

  it('13. bucket member can record their own withdrawal', async () => {
    await assertSucceeds(
      transactionDoc(asMember(), 'txn-1').set(validWithdrawal())
    );
  });

  it('14. trip member can record their own contribution', async () => {
    await assertSucceeds(
      transactionDoc(asMember(), 'txn-1').set(validTripContribution())
    );
  });

  it('15. trip member can record their own withdrawal', async () => {
    await assertSucceeds(
      transactionDoc(asMember(), 'txn-1').set(
        validTripContribution({ type: 'withdrawal' })
      )
    );
  });
});

describe('firestore.rules: savingsTransactions - create (owner on behalf)', () => {
  beforeEach(async () => {
    await seedBucket(testEnv, BUCKET_ID, validBucketData());
    await seedTrip(testEnv, TRIP_ID, validTripData());
  });

  it('16. bucket owner can record for another current bucket member', async () => {
    await assertSucceeds(
      transactionDoc(asOwner(), 'txn-1').set(
        validContribution({ memberUid: MEMBER_UID, recordedBy: OWNER_UID })
      )
    );
  });

  it('17. trip owner can record for another current trip member', async () => {
    await assertSucceeds(
      transactionDoc(asOwner(), 'txn-1').set(
        validTripContribution({ memberUid: MEMBER_UID, recordedBy: OWNER_UID })
      )
    );
  });
});

describe('firestore.rules: savingsTransactions - create denials', () => {
  beforeEach(async () => {
    await seedBucket(testEnv, BUCKET_ID, validBucketData());
    await seedTrip(testEnv, TRIP_ID, validTripData());
  });

  it('18. ordinary member cannot record for another member', async () => {
    // MEMBER_UID (non-owner) tries to record on behalf of OWNER_UID.
    await assertFails(
      transactionDoc(asMember(), 'txn-1').set(
        validContribution({ memberUid: OWNER_UID, recordedBy: MEMBER_UID })
      )
    );
  });

  it('19. nonmember cannot create a transaction for the resource', async () => {
    await assertFails(
      transactionDoc(asOutsider(), 'txn-1').set(
        validContribution({ memberUid: OUTSIDER_UID, recordedBy: OUTSIDER_UID })
      )
    );
  });

  it('20. owner cannot record for a UID that is not a current member', async () => {
    await assertFails(
      transactionDoc(asOwner(), 'txn-1').set(
        validContribution({ memberUid: OUTSIDER_UID, recordedBy: OWNER_UID })
      )
    );
  });

  it('21. recordedBy spoof is denied', async () => {
    // MEMBER_UID is authenticated but claims recordedBy = OWNER_UID.
    await assertFails(
      transactionDoc(asMember(), 'txn-1').set(
        validContribution({ memberUid: MEMBER_UID, recordedBy: OWNER_UID })
      )
    );
  });

  it('22. invalid resourceType is denied', async () => {
    await assertFails(
      transactionDoc(asMember(), 'txn-1').set(
        validContribution({ resourceType: 'expense' })
      )
    );
  });

  it('23. nonexistent parent resource is denied', async () => {
    await assertFails(
      transactionDoc(asMember(), 'txn-1').set(
        validContribution({ resourceId: 'does-not-exist' })
      )
    );
  });

  it('24. invalid transaction type is denied', async () => {
    await assertFails(
      transactionDoc(asMember(), 'txn-1').set(
        validContribution({ type: 'deposit' })
      )
    );
  });

  it('25. amountMinor = 0 is denied', async () => {
    await assertFails(
      transactionDoc(asMember(), 'txn-1').set(
        validContribution({ amountMinor: 0 })
      )
    );
  });

  it('26. negative amountMinor is denied', async () => {
    await assertFails(
      transactionDoc(asMember(), 'txn-1').set(
        validContribution({ amountMinor: -500 })
      )
    );
  });

  it('27. fractional amountMinor is denied', async () => {
    await assertFails(
      transactionDoc(asMember(), 'txn-1').set(
        validContribution({ amountMinor: 12.34 })
      )
    );
  });

  it('28. currency mismatch is denied', async () => {
    await assertFails(
      transactionDoc(asMember(), 'txn-1').set(
        validContribution({ currency: 'EUR' })
      )
    );
  });

  it('29. explicit non-USD parent currency accepts a matching transaction currency', async () => {
    await seedBucket(
      testEnv,
      'eur-bucket',
      validBucketData({
        ownerId: OWNER_UID,
        memberIds: [OWNER_UID, MEMBER_UID],
        currency: 'EUR',
      })
    );
    await assertSucceeds(
      transactionDoc(asMember(), 'txn-1').set(
        validContribution({ resourceId: 'eur-bucket', currency: 'EUR' })
      )
    );
  });

  it("30. legacy parent with no currency field accepts USD", async () => {
    // validBucketData() has no `currency` key at all - simulates a
    // pre-Milestone-2A legacy document.
    await assertSucceeds(
      transactionDoc(asMember(), 'txn-1').set(
        validContribution({ currency: 'USD' })
      )
    );
  });

  it('31. legacy parent with no currency field rejects non-USD', async () => {
    await assertFails(
      transactionDoc(asMember(), 'txn-1').set(
        validContribution({ currency: 'EUR' })
      )
    );
  });

  it('32. missing a required field is denied', async () => {
    const payload = validContribution();
    delete payload.amountMinor;
    await assertFails(transactionDoc(asMember(), 'txn-1').set(payload));
  });

  it('33. unknown extra field is denied', async () => {
    await assertFails(
      transactionDoc(asMember(), 'txn-1').set(
        validContribution({ extraField: 'not allowed' })
      )
    );
  });

  it('34. invalid note type is denied', async () => {
    await assertFails(
      transactionDoc(asMember(), 'txn-1').set(
        validContribution({ note: 12345 })
      )
    );
  });

  it('35. invalid occurredAt type is denied', async () => {
    await assertFails(
      transactionDoc(asMember(), 'txn-1').set(
        validContribution({ occurredAt: 'yesterday' })
      )
    );
  });

  it('36. invalid reversalOf type is denied', async () => {
    await assertFails(
      transactionDoc(asMember(), 'txn-1').set(
        validContribution({ reversalOf: 12345 })
      )
    );
  });
});

describe('firestore.rules: savingsTransactions - append-only', () => {
  beforeEach(async () => {
    await seedBucket(testEnv, BUCKET_ID, validBucketData());
    await seedTransaction('txn-1', {
      ...validContribution(),
      createdAt: Timestamp.now(),
    });
  });

  it('37. owner cannot update an existing transaction', async () => {
    await assertFails(
      transactionDoc(asOwner(), 'txn-1').update({ amountMinor: 999 })
    );
  });

  it('38. member cannot update an existing transaction', async () => {
    await assertFails(
      transactionDoc(asMember(), 'txn-1').update({ amountMinor: 999 })
    );
  });

  it('39. owner cannot delete an existing transaction', async () => {
    await assertFails(transactionDoc(asOwner(), 'txn-1').delete());
  });

  it('40. member cannot delete an existing transaction', async () => {
    await assertFails(transactionDoc(asMember(), 'txn-1').delete());
  });
});

describe('firestore.rules: savingsTransactions - createdAt / id', () => {
  beforeEach(async () => {
    await seedBucket(testEnv, BUCKET_ID, validBucketData());
  });

  it('41. a non-server createdAt value is denied', async () => {
    await assertFails(
      transactionDoc(asMember(), 'txn-1').set(
        validContribution({ createdAt: Timestamp.now() })
      )
    );
  });

  it('42. a real serverTimestamp() createdAt is accepted', async () => {
    await assertSucceeds(
      transactionDoc(asMember(), 'txn-1').set(
        validContribution({ createdAt: serverTimestamp() })
      )
    );
  });

  it('43. a stored id field is not required - the canonical payload (no id key) is accepted', async () => {
    const payload = validContribution();
    expect('id' in payload).toBe(false);
    await assertSucceeds(transactionDoc(asMember(), 'txn-1').set(payload));
  });
});
