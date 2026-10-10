// Comprehensive Firestore rules coverage for the `tripMemberOwnership`
// collection (Checkpoint 5B.1), run against the local Firestore
// emulator using the real firestore.rules file (never weakened to make
// a test pass).
const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { createTestEnv } = require('./helpers/testEnv');
const { seedTrip, validTripData } = require('./helpers/trips');
const {
  OWNER_UID,
  MEMBER_UID,
  OUTSIDER_UID,
  TRIP_ID,
  ownershipId,
  validOwnershipData,
  seedTripMemberOwnership,
  tripMemberOwnershipDoc,
  tripMemberOwnershipCollection,
} = require('./helpers/tripMemberOwnership');

const OWNER_OWNERSHIP_ID = ownershipId(TRIP_ID, OWNER_UID);
const MEMBER_OWNERSHIP_ID = ownershipId(TRIP_ID, MEMBER_UID);

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

describe('firestore.rules: tripMemberOwnership - reads', () => {
  beforeEach(async () => {
    await seedTripMemberOwnership(testEnv, OWNER_OWNERSHIP_ID, validOwnershipData());
    await seedTripMemberOwnership(
      testEnv,
      MEMBER_OWNERSHIP_ID,
      validOwnershipData({ uid: MEMBER_UID, ownershipMinor: 10000 })
    );
  });

  it('owner can read their own ownership row', async () => {
    await assertSucceeds(tripMemberOwnershipDoc(asOwner(), OWNER_OWNERSHIP_ID).get());
  });

  it('owner can read ANOTHER member\'s ownership row (Trip-wide visibility, chosen policy)', async () => {
    await assertSucceeds(tripMemberOwnershipDoc(asOwner(), MEMBER_OWNERSHIP_ID).get());
  });

  it('a non-owner member can read their own ownership row', async () => {
    await assertSucceeds(tripMemberOwnershipDoc(asMember(), MEMBER_OWNERSHIP_ID).get());
  });

  it('a non-owner member can read the OWNER\'s ownership row (Trip-wide visibility)', async () => {
    await assertSucceeds(tripMemberOwnershipDoc(asMember(), OWNER_OWNERSHIP_ID).get());
  });

  it('an outsider cannot read any ownership row for this Trip', async () => {
    await assertFails(tripMemberOwnershipDoc(asOutsider(), OWNER_OWNERSHIP_ID).get());
  });

  it('an unauthenticated user cannot read any ownership row', async () => {
    await assertFails(tripMemberOwnershipDoc(asUnauthenticated(), OWNER_OWNERSHIP_ID).get());
  });
});

describe('firestore.rules: tripMemberOwnership - query-level access', () => {
  beforeEach(async () => {
    await seedTripMemberOwnership(testEnv, OWNER_OWNERSHIP_ID, validOwnershipData());
    await seedTripMemberOwnership(
      testEnv,
      MEMBER_OWNERSHIP_ID,
      validOwnershipData({ uid: MEMBER_UID, ownershipMinor: 10000 })
    );
  });

  it('a current member can query every ownership row for their Trip', async () => {
    const snap = await assertSucceeds(
      tripMemberOwnershipCollection(asMember()).where('tripId', '==', TRIP_ID).get()
    );
    expect(snap.docs.map((d) => d.id).sort()).toEqual(
      [OWNER_OWNERSHIP_ID, MEMBER_OWNERSHIP_ID].sort()
    );
  });

  it('an outsider cannot run the same query', async () => {
    await assertFails(
      tripMemberOwnershipCollection(asOutsider()).where('tripId', '==', TRIP_ID).get()
    );
  });

  // Checkpoint 5B.1A, item 9: strengthened query-boundary coverage - a
  // current member of ONE Trip must not be able to retrieve ownership
  // rows belonging to a DIFFERENT Trip they are not a member of, via any
  // query shape.
  describe('a second Trip the member does not belong to', () => {
    const OTHER_TRIP_ID = 'other-trip';
    const OTHER_OWNERSHIP_ID = ownershipId(OTHER_TRIP_ID, OUTSIDER_UID);

    beforeEach(async () => {
      await seedTrip(testEnv, OTHER_TRIP_ID, validTripData({ ownerId: OUTSIDER_UID, memberIds: [OUTSIDER_UID] }));
      await seedTripMemberOwnership(
        testEnv,
        OTHER_OWNERSHIP_ID,
        validOwnershipData({ tripId: OTHER_TRIP_ID, uid: OUTSIDER_UID, ownershipMinor: 5000 })
      );
    });

    it('the member cannot query the OTHER Trip\'s ownership rows by its tripId', async () => {
      await assertFails(
        tripMemberOwnershipCollection(asMember()).where('tripId', '==', OTHER_TRIP_ID).get()
      );
    });

    it('the member cannot retrieve the OTHER Trip\'s row directly by id either', async () => {
      await assertFails(tripMemberOwnershipDoc(asMember(), OTHER_OWNERSHIP_ID).get());
    });

    it('an UNSCOPED collection query (no tripId filter at all) fails, even for a legitimate current member', async () => {
      // Firestore evaluates `list` rules using only the query's own
      // equality filters as known facts, never real document data (see
      // firestore.rules' own comment on this collection and the
      // tripInvitations list-rule precedent) - a query that never
      // constrains tripId can never be proven authorized, regardless of
      // which rows would have actually matched.
      await assertFails(tripMemberOwnershipCollection(asMember()).get());
    });

    it('querying by uid alone (no tripId filter) cannot be used to retrieve ownership rows across Trips', async () => {
      await assertFails(
        tripMemberOwnershipCollection(asMember()).where('uid', '==', OUTSIDER_UID).get()
      );
    });
  });
});

describe('firestore.rules: tripMemberOwnership - writes are always closed to every client', () => {
  it('the owner cannot directly create an ownership row', async () => {
    await assertFails(
      tripMemberOwnershipDoc(asOwner(), OWNER_OWNERSHIP_ID).set(validOwnershipData())
    );
  });

  it('a non-owner member cannot directly create an ownership row', async () => {
    await assertFails(
      tripMemberOwnershipDoc(asMember(), MEMBER_OWNERSHIP_ID).set(
        validOwnershipData({ uid: MEMBER_UID })
      )
    );
  });

  describe('once a row exists', () => {
    beforeEach(async () => {
      await seedTripMemberOwnership(testEnv, OWNER_OWNERSHIP_ID, validOwnershipData());
    });

    it('the owner cannot update their own ownership row', async () => {
      await assertFails(
        tripMemberOwnershipDoc(asOwner(), OWNER_OWNERSHIP_ID).update({ ownershipMinor: 999999 })
      );
    });

    it('the owner cannot delete their own ownership row', async () => {
      await assertFails(tripMemberOwnershipDoc(asOwner(), OWNER_OWNERSHIP_ID).delete());
    });

    it('a non-owner member cannot update someone else\'s ownership row', async () => {
      await assertFails(
        tripMemberOwnershipDoc(asMember(), OWNER_OWNERSHIP_ID).update({ ownershipMinor: 0 })
      );
    });
  });
});
