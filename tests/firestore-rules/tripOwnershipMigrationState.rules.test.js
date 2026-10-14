// Comprehensive Firestore rules coverage for the
// `tripOwnershipMigrationState` collection (Checkpoint 5B.4B), run
// against the local Firestore emulator using the real firestore.rules
// file (never weakened to make a test pass). Chosen policy: fully
// client-closed - no client role may read or write this collection at
// all, regardless of Trip membership, mirroring
// tripOwnershipAllocations's own posture exactly.
const { assertFails } = require('@firebase/rules-unit-testing');
const { createTestEnv } = require('./helpers/testEnv');
const { seedTrip, validTripData } = require('./helpers/trips');
const {
  OWNER_UID,
  MEMBER_UID,
  OUTSIDER_UID,
  TRIP_ID,
  validMigrationStateData,
  seedTripOwnershipMigrationState,
  tripOwnershipMigrationStateDoc,
  tripOwnershipMigrationStateCollection,
} = require('./helpers/tripOwnershipMigrationState');

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

describe('firestore.rules: tripOwnershipMigrationState - reads are backend-only for every role', () => {
  beforeEach(async () => {
    await seedTripOwnershipMigrationState(testEnv, TRIP_ID, validMigrationStateData());
  });

  it('the Trip owner cannot read the migration-state document', async () => {
    await assertFails(tripOwnershipMigrationStateDoc(asOwner(), TRIP_ID).get());
  });

  it('a current Trip member cannot read the migration-state document', async () => {
    await assertFails(tripOwnershipMigrationStateDoc(asMember(), TRIP_ID).get());
  });

  it('an outsider cannot read the migration-state document', async () => {
    await assertFails(tripOwnershipMigrationStateDoc(asOutsider(), TRIP_ID).get());
  });

  it('an unauthenticated user cannot read the migration-state document', async () => {
    await assertFails(tripOwnershipMigrationStateDoc(asUnauthenticated(), TRIP_ID).get());
  });

  it('a current Trip member cannot even query the collection for their own Trip', async () => {
    await assertFails(
      tripOwnershipMigrationStateCollection(asMember()).where('tripId', '==', TRIP_ID).get()
    );
  });
});

describe('firestore.rules: tripOwnershipMigrationState - writes are always closed to every client', () => {
  it('the Trip owner cannot directly create a migration-state document', async () => {
    await assertFails(
      tripOwnershipMigrationStateDoc(asOwner(), TRIP_ID).set(validMigrationStateData())
    );
  });

  it('a non-owner member cannot directly create a migration-state document', async () => {
    await assertFails(
      tripOwnershipMigrationStateDoc(asMember(), TRIP_ID).set(validMigrationStateData())
    );
  });

  describe('once a document exists', () => {
    beforeEach(async () => {
      await seedTripOwnershipMigrationState(testEnv, TRIP_ID, validMigrationStateData());
    });

    it('the Trip owner cannot update the migration-state document', async () => {
      await assertFails(
        tripOwnershipMigrationStateDoc(asOwner(), TRIP_ID).update({ phase: 'completed' })
      );
    });

    it('the Trip owner cannot delete the migration-state document', async () => {
      await assertFails(tripOwnershipMigrationStateDoc(asOwner(), TRIP_ID).delete());
    });
  });
});
