// Comprehensive Firestore rules coverage for the
// `tripOwnershipAllocations` collection (Checkpoint 5B.1), run against
// the local Firestore emulator using the real firestore.rules file
// (never weakened to make a test pass). Chosen policy: backend/audit-
// only - no client role may read this collection at all, regardless of
// Trip membership.
const { assertFails } = require('@firebase/rules-unit-testing');
const { createTestEnv } = require('./helpers/testEnv');
const { seedTrip, validTripData } = require('./helpers/trips');
const {
  OWNER_UID,
  MEMBER_UID,
  OUTSIDER_UID,
  TRIP_ID,
  WITHDRAWAL_TRANSACTION_ID,
  validAllocationData,
  seedTripOwnershipAllocation,
  tripOwnershipAllocationDoc,
  tripOwnershipAllocationCollection,
} = require('./helpers/tripOwnershipAllocations');

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
  await seedTrip(testEnv, TRIP_ID, validTripData({ memberIds: [OWNER_UID, MEMBER_UID] }));
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

describe('firestore.rules: tripOwnershipAllocations - reads are backend-only for every role', () => {
  beforeEach(async () => {
    await seedTripOwnershipAllocation(
      testEnv,
      WITHDRAWAL_TRANSACTION_ID,
      validAllocationData()
    );
  });

  it('the Trip owner cannot read an allocation record', async () => {
    await assertFails(tripOwnershipAllocationDoc(asOwner(), WITHDRAWAL_TRANSACTION_ID).get());
  });

  it('a current Trip member cannot read an allocation record', async () => {
    await assertFails(tripOwnershipAllocationDoc(asMember(), WITHDRAWAL_TRANSACTION_ID).get());
  });

  it('an outsider cannot read an allocation record', async () => {
    await assertFails(tripOwnershipAllocationDoc(asOutsider(), WITHDRAWAL_TRANSACTION_ID).get());
  });

  it('an unauthenticated user cannot read an allocation record', async () => {
    await assertFails(
      tripOwnershipAllocationDoc(asUnauthenticated(), WITHDRAWAL_TRANSACTION_ID).get()
    );
  });

  it('a current Trip member cannot even query the collection for their own Trip', async () => {
    await assertFails(
      tripOwnershipAllocationCollection(asMember()).where('tripId', '==', TRIP_ID).get()
    );
  });
});

describe('firestore.rules: tripOwnershipAllocations - writes are always closed to every client', () => {
  it('the Trip owner cannot directly create an allocation record', async () => {
    await assertFails(
      tripOwnershipAllocationDoc(asOwner(), WITHDRAWAL_TRANSACTION_ID).set(validAllocationData())
    );
  });

  it('a non-owner member cannot directly create an allocation record', async () => {
    await assertFails(
      tripOwnershipAllocationDoc(asMember(), WITHDRAWAL_TRANSACTION_ID).set(validAllocationData())
    );
  });

  describe('once a record exists', () => {
    beforeEach(async () => {
      await seedTripOwnershipAllocation(
        testEnv,
        WITHDRAWAL_TRANSACTION_ID,
        validAllocationData()
      );
    });

    it('the Trip owner cannot update an allocation record', async () => {
      await assertFails(
        tripOwnershipAllocationDoc(asOwner(), WITHDRAWAL_TRANSACTION_ID).update({
          amountMinor: 1,
        })
      );
    });

    it('the Trip owner cannot delete an allocation record', async () => {
      await assertFails(tripOwnershipAllocationDoc(asOwner(), WITHDRAWAL_TRANSACTION_ID).delete());
    });
  });
});
