// Comprehensive Firestore rules coverage for the
// `tripMembershipDepartures` collection (Checkpoint 6.7B1), run against
// the local Firestore emulator using the real firestore.rules file
// (never weakened to make a test pass). Chosen policy: fully client-
// closed - no client role may read or write this collection at all,
// including the departed uid itself, regardless of Trip membership.
// Only the trusted leaveTrip/removeTripMember callables ever touch it.
const { assertFails } = require('@firebase/rules-unit-testing');
const { createTestEnv } = require('./helpers/testEnv');
const { seedTrip, validTripData } = require('./helpers/trips');
const {
  OWNER_UID,
  MEMBER_UID,
  DEPARTED_UID,
  OUTSIDER_UID,
  TRIP_ID,
  DEPARTURE_ID,
  validDepartureData,
  seedTripMembershipDeparture,
  tripMembershipDepartureDoc,
  tripMembershipDepartureCollection,
} = require('./helpers/tripMembershipDepartures');

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
  // DEPARTED_UID is deliberately NOT included in memberIds - they have
  // already departed; the fixture Trip reflects post-departure state,
  // matching what the real trusted callable would have already written.
  await seedTrip(testEnv, TRIP_ID, validTripData({ memberIds: [OWNER_UID, MEMBER_UID] }));
});

function asOwner() {
  return testEnv.authenticatedContext(OWNER_UID);
}
function asMember() {
  return testEnv.authenticatedContext(MEMBER_UID);
}
function asDepartedUser() {
  return testEnv.authenticatedContext(DEPARTED_UID);
}
function asOutsider() {
  return testEnv.authenticatedContext(OUTSIDER_UID);
}
function asUnauthenticated() {
  return testEnv.unauthenticatedContext();
}

describe('firestore.rules: tripMembershipDepartures - reads are closed for every role', () => {
  beforeEach(async () => {
    await seedTripMembershipDeparture(testEnv, DEPARTURE_ID, validDepartureData());
  });

  it('the departed user cannot read their own departure event', async () => {
    await assertFails(tripMembershipDepartureDoc(asDepartedUser(), DEPARTURE_ID).get());
  });

  it('the Trip owner cannot read a departure event', async () => {
    await assertFails(tripMembershipDepartureDoc(asOwner(), DEPARTURE_ID).get());
  });

  it('a current Trip member cannot read a departure event', async () => {
    await assertFails(tripMembershipDepartureDoc(asMember(), DEPARTURE_ID).get());
  });

  it('an outsider cannot read a departure event', async () => {
    await assertFails(tripMembershipDepartureDoc(asOutsider(), DEPARTURE_ID).get());
  });

  it('an unauthenticated user cannot read a departure event', async () => {
    await assertFails(tripMembershipDepartureDoc(asUnauthenticated(), DEPARTURE_ID).get());
  });

  it('nobody can list/query the collection for their own Trip', async () => {
    await assertFails(
      tripMembershipDepartureCollection(asOwner()).where('tripId', '==', TRIP_ID).get()
    );
    await assertFails(
      tripMembershipDepartureCollection(asDepartedUser()).where('tripId', '==', TRIP_ID).get()
    );
  });
});

describe('firestore.rules: tripMembershipDepartures - writes are always closed to every client', () => {
  it('the departed user cannot directly create their own departure event', async () => {
    await assertFails(
      tripMembershipDepartureDoc(asDepartedUser(), DEPARTURE_ID).set(validDepartureData())
    );
  });

  it('the Trip owner cannot directly create a departure event', async () => {
    await assertFails(
      tripMembershipDepartureDoc(asOwner(), DEPARTURE_ID).set(
        validDepartureData({ departureType: 'removed', departedByUid: OWNER_UID })
      )
    );
  });

  it('a non-owner member cannot directly create a departure event', async () => {
    await assertFails(
      tripMembershipDepartureDoc(asMember(), DEPARTURE_ID).set(validDepartureData())
    );
  });

  it('an outsider cannot directly create a departure event', async () => {
    await assertFails(
      tripMembershipDepartureDoc(asOutsider(), DEPARTURE_ID).set(validDepartureData())
    );
  });

  describe('once a departure event exists', () => {
    beforeEach(async () => {
      await seedTripMembershipDeparture(testEnv, DEPARTURE_ID, validDepartureData());
    });

    it('the departed user cannot update their own departure event', async () => {
      await assertFails(
        tripMembershipDepartureDoc(asDepartedUser(), DEPARTURE_ID).update({
          departureType: 'removed',
        })
      );
    });

    it('the Trip owner cannot update a departure event', async () => {
      await assertFails(
        tripMembershipDepartureDoc(asOwner(), DEPARTURE_ID).update({
          tripTitleSnapshot: 'Tampered',
        })
      );
    });

    it('the departed user cannot delete their own departure event', async () => {
      await assertFails(tripMembershipDepartureDoc(asDepartedUser(), DEPARTURE_ID).delete());
    });

    it('the Trip owner cannot delete a departure event', async () => {
      await assertFails(tripMembershipDepartureDoc(asOwner(), DEPARTURE_ID).delete());
    });
  });
});
