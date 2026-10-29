// Comprehensive Firestore rules coverage for the `tripExpenseBalances`
// collection (Checkpoint 6.7A), run against the local Firestore
// emulator using the real firestore.rules file (never weakened to make
// a test pass). Chosen policy: fully client-closed, mirroring
// tripOwnershipAllocations/tripOwnershipMigrationState's own posture
// exactly - no client role may read or write this collection at all,
// regardless of Trip membership. Only the trusted financial callables
// and the local, non-exported Admin SDK migration tool
// (functions/src/admin/migrateTripExpenseBalances.ts) ever touch it.
const { assertFails } = require('@firebase/rules-unit-testing');
const { createTestEnv } = require('./helpers/testEnv');
const { seedTrip, validTripData } = require('./helpers/trips');
const {
  OWNER_UID,
  MEMBER_UID,
  OUTSIDER_UID,
  TRIP_ID,
  BALANCE_ID,
  validBalanceData,
  seedTripExpenseBalance,
  tripExpenseBalanceDoc,
  tripExpenseBalanceCollection,
} = require('./helpers/tripExpenseBalances');

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

describe('firestore.rules: tripExpenseBalances - reads are closed for every role', () => {
  beforeEach(async () => {
    await seedTripExpenseBalance(testEnv, BALANCE_ID, validBalanceData());
  });

  it('the Trip owner cannot read a balance record', async () => {
    await assertFails(tripExpenseBalanceDoc(asOwner(), BALANCE_ID).get());
  });

  it("a current Trip member cannot read their OWN balance record", async () => {
    await assertFails(tripExpenseBalanceDoc(asMember(), BALANCE_ID).get());
  });

  it('an outsider cannot read a balance record', async () => {
    await assertFails(tripExpenseBalanceDoc(asOutsider(), BALANCE_ID).get());
  });

  it('an unauthenticated user cannot read a balance record', async () => {
    await assertFails(tripExpenseBalanceDoc(asUnauthenticated(), BALANCE_ID).get());
  });

  it('a current Trip member cannot even query the collection for their own Trip', async () => {
    await assertFails(
      tripExpenseBalanceCollection(asMember()).where('tripId', '==', TRIP_ID).get()
    );
  });
});

describe('firestore.rules: tripExpenseBalances - writes are always closed to every client', () => {
  it('the Trip owner cannot directly create a balance record', async () => {
    await assertFails(tripExpenseBalanceDoc(asOwner(), BALANCE_ID).set(validBalanceData()));
  });

  it('a non-owner member cannot directly create a balance record (e.g. to fabricate a favorable balance)', async () => {
    await assertFails(tripExpenseBalanceDoc(asMember(), BALANCE_ID).set(validBalanceData()));
  });

  describe('once a record exists', () => {
    beforeEach(async () => {
      await seedTripExpenseBalance(testEnv, BALANCE_ID, validBalanceData());
    });

    it('the Trip owner cannot update a balance record', async () => {
      await assertFails(
        tripExpenseBalanceDoc(asOwner(), BALANCE_ID).update({ netBalanceMinor: 0 })
      );
    });

    it("a member cannot update their OWN balance record", async () => {
      await assertFails(
        tripExpenseBalanceDoc(asMember(), BALANCE_ID).update({ netBalanceMinor: 999999 })
      );
    });

    it('the Trip owner cannot delete a balance record', async () => {
      await assertFails(tripExpenseBalanceDoc(asOwner(), BALANCE_ID).delete());
    });
  });
});
