// Comprehensive Firestore rules coverage for the
// `tripOwnershipReconciliationControl` collection (Checkpoint 5C.6), run
// against the local Firestore emulator using the real firestore.rules
// file (never weakened to make a test pass). Chosen policy: fully
// client-closed - no client role may read or write this collection at
// all, regardless of Trip membership, mirroring
// tripOwnershipMigrationState's own posture exactly.
//
// Fixtures/helpers are kept local to this file (not factored into a
// separate ./helpers/ module) to stay within this checkpoint's own
// exact authorized file-add list.
const { assertFails } = require('@firebase/rules-unit-testing');
const { seedTrip, validTripData } = require('./helpers/trips');
const { createTestEnv } = require('./helpers/testEnv');

const OWNER_UID = 'owner-uid';
const MEMBER_UID = 'member-uid';
const OUTSIDER_UID = 'outsider-uid';
const TRIP_ID = 'test-trip';

function validReconciliationControlData(overrides = {}) {
  return {
    tripId: TRIP_ID,
    activeAttemptId: null,
    lastCompletedAttemptId: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

async function seedTripOwnershipReconciliationControl(testEnv, id, data) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().collection('tripOwnershipReconciliationControl').doc(id).set(data);
  });
}

function tripOwnershipReconciliationControlDoc(context, id) {
  return context.firestore().collection('tripOwnershipReconciliationControl').doc(id);
}

function tripOwnershipReconciliationControlCollection(context) {
  return context.firestore().collection('tripOwnershipReconciliationControl');
}

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

describe('firestore.rules: tripOwnershipReconciliationControl - reads are backend-only for every role', () => {
  beforeEach(async () => {
    await seedTripOwnershipReconciliationControl(
      testEnv,
      TRIP_ID,
      validReconciliationControlData()
    );
  });

  it('the Trip owner cannot read the control document', async () => {
    await assertFails(tripOwnershipReconciliationControlDoc(asOwner(), TRIP_ID).get());
  });

  it('a current Trip member cannot read the control document', async () => {
    await assertFails(tripOwnershipReconciliationControlDoc(asMember(), TRIP_ID).get());
  });

  it('an outsider cannot read the control document', async () => {
    await assertFails(tripOwnershipReconciliationControlDoc(asOutsider(), TRIP_ID).get());
  });

  it('an unauthenticated user cannot read the control document', async () => {
    await assertFails(tripOwnershipReconciliationControlDoc(asUnauthenticated(), TRIP_ID).get());
  });

  it('a current Trip member cannot even query the collection for their own Trip', async () => {
    await assertFails(
      tripOwnershipReconciliationControlCollection(asMember())
        .where('tripId', '==', TRIP_ID)
        .get()
    );
  });
});

describe('firestore.rules: tripOwnershipReconciliationControl - writes are always closed to every client', () => {
  it('the Trip owner cannot directly create the control document', async () => {
    await assertFails(
      tripOwnershipReconciliationControlDoc(asOwner(), TRIP_ID).set(
        validReconciliationControlData()
      )
    );
  });

  it('a non-owner member cannot directly create the control document', async () => {
    await assertFails(
      tripOwnershipReconciliationControlDoc(asMember(), TRIP_ID).set(
        validReconciliationControlData()
      )
    );
  });

  describe('once a document exists', () => {
    beforeEach(async () => {
      await seedTripOwnershipReconciliationControl(
        testEnv,
        TRIP_ID,
        validReconciliationControlData()
      );
    });

    it('the Trip owner cannot update the control document', async () => {
      await assertFails(
        tripOwnershipReconciliationControlDoc(asOwner(), TRIP_ID).update({
          activeAttemptId: 'attempt-1',
        })
      );
    });

    it('the Trip owner cannot delete the control document', async () => {
      await assertFails(tripOwnershipReconciliationControlDoc(asOwner(), TRIP_ID).delete());
    });
  });
});
