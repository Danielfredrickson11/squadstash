// Firestore rules coverage for the `savingsTransactions` collection
// (Milestone 2B ledger). Run against the local Firestore emulator using
// the real firestore.rules file (never weakened to make a test pass).
//
// As of Checkpoint 4B, client CREATE/UPDATE/DELETE are all permanently
// closed - the trusted recordSavingsTransaction Cloud Function (Admin
// SDK, which bypasses these rules) is the sole write path. Read fixtures
// below are seeded exclusively via the rules-disabled admin context,
// never via a client create the rules now intentionally deny.
//
// Reuses the existing buckets/trips helpers to seed parent resources -
// no shared helper file is modified; this file stays self-contained per
// this checkpoint's scope (firestore.rules and this test file only).
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

// Seeds a transaction document bypassing security rules entirely - the
// only way to seed one now that client create is closed.
async function seedTransaction(id, data) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().collection('savingsTransactions').doc(id).set(data);
  });
}

// Shape a real recordSavingsTransaction call would persist (see
// functions/src/callables/recordSavingsTransaction.ts) - used only to
// seed read fixtures and to construct otherwise-perfectly-valid create
// attempts that must still be denied.
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
    reversalOf: null,
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

  it('unauthenticated user cannot get a bucket transaction', async () => {
    await seedTransaction('txn-1', validContribution());
    await assertFails(transactionDoc(asUnauthenticated(), 'txn-1').get());
  });

  it('unauthenticated user cannot query bucket transactions', async () => {
    await seedTransaction('txn-1', validContribution());
    await assertFails(
      transactionsCollection(asUnauthenticated())
        .where('resourceType', '==', 'bucket')
        .where('resourceId', '==', BUCKET_ID)
        .get()
    );
  });

  it('1. bucket owner can get an existing transaction', async () => {
    await seedTransaction('txn-1', validContribution());
    await assertSucceeds(transactionDoc(asOwner(), 'txn-1').get());
  });

  it('2. bucket member can get an existing transaction', async () => {
    await seedTransaction('txn-1', validContribution());
    await assertSucceeds(transactionDoc(asMember(), 'txn-1').get());
  });

  it('3. bucket nonmember cannot get', async () => {
    await seedTransaction('txn-1', validContribution());
    await assertFails(transactionDoc(asOutsider(), 'txn-1').get());
  });

  it('4. trip owner can get', async () => {
    await seedTransaction('txn-trip-1', validTripContribution());
    await assertSucceeds(transactionDoc(asOwner(), 'txn-trip-1').get());
  });

  it('5. trip member can get', async () => {
    await seedTransaction('txn-trip-1', validTripContribution());
    await assertSucceeds(transactionDoc(asMember(), 'txn-trip-1').get());
  });

  it('6. trip nonmember cannot get', async () => {
    await seedTransaction('txn-trip-1', validTripContribution());
    await assertFails(transactionDoc(asOutsider(), 'txn-trip-1').get());
  });

  it('7. authorized resource-scoped list query succeeds', async () => {
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

  it('8. unauthorized resource-scoped list query fails', async () => {
    await seedTransaction('txn-1', validContribution());
    await assertFails(
      transactionsCollection(asOutsider())
        .where('resourceType', '==', 'bucket')
        .where('resourceId', '==', BUCKET_ID)
        .orderBy('createdAt', 'desc')
        .get()
    );
  });

  it('also succeeds for an authorized trip-scoped list query (parity with bucket)', async () => {
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

  it('also fails for an unauthorized trip-scoped list query (parity with bucket)', async () => {
    await seedTransaction('txn-trip-1', validTripContribution());
    await assertFails(
      transactionsCollection(asOutsider())
        .where('resourceType', '==', 'trip')
        .where('resourceId', '==', TRIP_ID)
        .orderBy('createdAt', 'desc')
        .get()
    );
  });

  it('9. malformed resourceType get fails', async () => {
    // Seeded only with security rules disabled - this shape could never
    // pass a real create, but proves the read path independently denies
    // it rather than falling through parentExists()/parentData()'s
    // bucket-vs-else ternary and accidentally treating it as a Trip.
    await seedTransaction(
      'txn-malformed-1',
      validContribution({ resourceType: 'expense', resourceId: TRIP_ID })
    );
    await assertFails(transactionDoc(asOwner(), 'txn-malformed-1').get());
    await assertFails(transactionDoc(asMember(), 'txn-malformed-1').get());
  });

  it('10. malformed resourceType query fails', async () => {
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

  it('11. trip ownership does not grant access to another user\'s trip_personal Bucket transaction merely via linkedTripId', async () => {
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
});

describe('firestore.rules: savingsTransactions - direct client create is denied', () => {
  beforeEach(async () => {
    await seedBucket(testEnv, BUCKET_ID, validBucketData());
    await seedTrip(testEnv, TRIP_ID, validTripData());
  });

  it('12. bucket owner cannot directly create a contribution', async () => {
    await assertFails(
      transactionDoc(asOwner(), 'txn-1').set(
        validContribution({ memberUid: OWNER_UID, recordedBy: OWNER_UID })
      )
    );
  });

  it('13. bucket member cannot directly create their own contribution', async () => {
    await assertFails(
      transactionDoc(asMember(), 'txn-1').set(validContribution())
    );
  });

  it('14. trip owner cannot directly create a contribution', async () => {
    await assertFails(
      transactionDoc(asOwner(), 'txn-1').set(
        validTripContribution({ memberUid: OWNER_UID, recordedBy: OWNER_UID })
      )
    );
  });

  it('15. trip member cannot directly create their own contribution', async () => {
    await assertFails(
      transactionDoc(asMember(), 'txn-1').set(validTripContribution())
    );
  });

  it('16. direct withdrawal create is denied', async () => {
    await assertFails(
      transactionDoc(asMember(), 'txn-1').set(validWithdrawal())
    );
  });

  it('17. owner-on-behalf direct create is denied', async () => {
    await assertFails(
      transactionDoc(asOwner(), 'txn-1').set(
        validContribution({ memberUid: MEMBER_UID, recordedBy: OWNER_UID })
      )
    );
  });

  it('18. unauthenticated direct create is denied', async () => {
    await assertFails(
      transactionDoc(asUnauthenticated(), 'txn-1').set(validContribution())
    );
  });

  it('IMPORTANT SECURITY ASSERTION: a perfectly well-formed self-contribution from a legitimate current member is still denied', async () => {
    // This payload satisfies every shape/permission rule the create
    // clause ever validated (Checkpoint 2/2-fix): correct resourceType/
    // resourceId, memberUid == recordedBy == the authenticated member's
    // own uid, a positive integer amountMinor, matching currency, a
    // valid type, a real serverTimestamp() createdAt, reversalOf: null,
    // no missing/extra fields. It is denied purely because create is
    // now unconditionally closed - proving a client cannot bypass the
    // trusted recordSavingsTransaction Function's atomic parent-cache/
    // ledgerBalanceMinor maintenance, non-negative-withdrawal
    // enforcement, idempotency, or legacy-initialization checks merely
    // by constructing an otherwise-valid document by hand.
    const perfectlyValidPayload = validContribution();
    await assertFails(
      transactionDoc(asMember(), 'txn-perfectly-valid').set(
        perfectlyValidPayload
      )
    );
  });
});

describe('firestore.rules: savingsTransactions - append-only (update/delete remain denied)', () => {
  beforeEach(async () => {
    await seedBucket(testEnv, BUCKET_ID, validBucketData());
    await seedTransaction('txn-1', {
      ...validContribution(),
      createdAt: Timestamp.now(),
    });
  });

  it('19. update remains denied', async () => {
    await assertFails(
      transactionDoc(asOwner(), 'txn-1').update({ amountMinor: 999 })
    );
    await assertFails(
      transactionDoc(asMember(), 'txn-1').update({ amountMinor: 999 })
    );
  });

  it('20. delete remains denied', async () => {
    await assertFails(transactionDoc(asOwner(), 'txn-1').delete());
    await assertFails(transactionDoc(asMember(), 'txn-1').delete());
  });
});
