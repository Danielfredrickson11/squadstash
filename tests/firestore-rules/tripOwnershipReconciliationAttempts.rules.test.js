// Comprehensive Firestore rules coverage for the
// `tripOwnershipReconciliationAttempts` collection (Checkpoint 5C.6), run
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
const { createTestEnv } = require('./helpers/testEnv');
const { seedTrip, validTripData } = require('./helpers/trips');

const OWNER_UID = 'owner-uid';
const MEMBER_UID = 'member-uid';
const OUTSIDER_UID = 'outsider-uid';
const TRIP_ID = 'test-trip';
const ATTEMPT_DOC_ID = `${TRIP_ID}_attempt-1`;

function validReconciliationAttemptData(overrides = {}) {
  return {
    tripId: TRIP_ID,
    attemptId: 'attempt-1',
    phase: 'locked',
    startedAt: new Date(),
    lockedFinancialBasis: {
      ledgerInitializationKind: 'initialized',
      ledgerOpeningBalanceMinor: 0,
      ledgerBalanceMinor: 1000,
      effectiveCurrency: 'USD',
    },
    ...overrides,
  };
}

async function seedTripOwnershipReconciliationAttempt(testEnv, id, data) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().collection('tripOwnershipReconciliationAttempts').doc(id).set(data);
  });
}

function tripOwnershipReconciliationAttemptDoc(context, id) {
  return context.firestore().collection('tripOwnershipReconciliationAttempts').doc(id);
}

function tripOwnershipReconciliationAttemptCollection(context) {
  return context.firestore().collection('tripOwnershipReconciliationAttempts');
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

describe('firestore.rules: tripOwnershipReconciliationAttempts - reads are backend-only for every role', () => {
  beforeEach(async () => {
    await seedTripOwnershipReconciliationAttempt(
      testEnv,
      ATTEMPT_DOC_ID,
      validReconciliationAttemptData()
    );
  });

  it('the Trip owner cannot read an attempt document', async () => {
    await assertFails(tripOwnershipReconciliationAttemptDoc(asOwner(), ATTEMPT_DOC_ID).get());
  });

  it('a current Trip member cannot read an attempt document', async () => {
    await assertFails(tripOwnershipReconciliationAttemptDoc(asMember(), ATTEMPT_DOC_ID).get());
  });

  it('an outsider cannot read an attempt document', async () => {
    await assertFails(tripOwnershipReconciliationAttemptDoc(asOutsider(), ATTEMPT_DOC_ID).get());
  });

  it('an unauthenticated user cannot read an attempt document', async () => {
    await assertFails(
      tripOwnershipReconciliationAttemptDoc(asUnauthenticated(), ATTEMPT_DOC_ID).get()
    );
  });

  it('a current Trip member cannot even query the collection for their own Trip', async () => {
    await assertFails(
      tripOwnershipReconciliationAttemptCollection(asMember())
        .where('tripId', '==', TRIP_ID)
        .get()
    );
  });
});

describe('firestore.rules: tripOwnershipReconciliationAttempts - writes are always closed to every client', () => {
  it('the Trip owner cannot directly create an attempt document', async () => {
    await assertFails(
      tripOwnershipReconciliationAttemptDoc(asOwner(), ATTEMPT_DOC_ID).set(
        validReconciliationAttemptData()
      )
    );
  });

  it('a non-owner member cannot directly create an attempt document', async () => {
    await assertFails(
      tripOwnershipReconciliationAttemptDoc(asMember(), ATTEMPT_DOC_ID).set(
        validReconciliationAttemptData()
      )
    );
  });

  describe('once a document exists', () => {
    beforeEach(async () => {
      await seedTripOwnershipReconciliationAttempt(
        testEnv,
        ATTEMPT_DOC_ID,
        validReconciliationAttemptData()
      );
    });

    it('the Trip owner cannot update the attempt document', async () => {
      await assertFails(
        tripOwnershipReconciliationAttemptDoc(asOwner(), ATTEMPT_DOC_ID).update({
          phase: 'completed',
        })
      );
    });

    it('the Trip owner cannot delete the attempt document', async () => {
      await assertFails(tripOwnershipReconciliationAttemptDoc(asOwner(), ATTEMPT_DOC_ID).delete());
    });
  });
});
