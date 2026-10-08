// Comprehensive Firestore rules coverage for the `tripTerms` and
// `tripTermsCurrent` collections (Checkpoint 5A, hardened by 5A.1), run
// against the local Firestore emulator using the real firestore.rules
// file (never weakened to make a test pass).
const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { createTestEnv } = require('./helpers/testEnv');
const { seedTrip, validTripData } = require('./helpers/trips');
const { seedTripInvitation, validInvitationData, invitationId } = require('./helpers/tripInvitations');
const {
  OWNER_UID,
  MEMBER_UID,
  OUTSIDER_UID,
  TRIP_ID,
  TERMS_ID,
  validTripTermsData,
  seedTripTerms,
  seedTripTermsCurrent,
  tripTermsDoc,
  tripTermsCollection,
  tripTermsCurrentDoc,
} = require('./helpers/tripTerms');

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

describe('firestore.rules: tripTerms - reads', () => {
  beforeEach(async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
    await seedTripTerms(testEnv, TERMS_ID, validTripTermsData());
  });

  it('owner: can read the trip terms', async () => {
    await assertSucceeds(tripTermsDoc(asOwner(), TERMS_ID).get());
  });

  it('non-owner member: can read the trip terms', async () => {
    await assertSucceeds(tripTermsDoc(asMember(), TERMS_ID).get());
  });

  it('an invited-but-not-yet-accepted user can read the trip terms', async () => {
    const invitedUid = 'invited-not-member-uid';
    await seedTripInvitation(
      testEnv,
      invitationId(TRIP_ID, invitedUid),
      validInvitationData({ inviteeUid: invitedUid })
    );
    await assertSucceeds(
      tripTermsDoc(testEnv.authenticatedContext(invitedUid), TERMS_ID).get()
    );
  });

  it('outsider with no invitation and no membership cannot read the trip terms', async () => {
    await assertFails(tripTermsDoc(asOutsider(), TERMS_ID).get());
  });

  it('unauthenticated user cannot read the trip terms', async () => {
    await assertFails(tripTermsDoc(asUnauthenticated(), TERMS_ID).get());
  });
});

// Checkpoint 5A.1 (item 5): direct client creation of tripTerms is now
// permanently closed for every actor, including the Trip owner - only
// the trusted publishTripTerms callable (Admin SDK, bypasses these
// Rules) may create one. See functions/test/publishTripTermsCore.ts for
// that callable's own authorization/versioning coverage.
describe('firestore.rules: tripTerms - create is always closed (trusted callable only)', () => {
  beforeEach(async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
  });

  it('the Trip owner cannot directly create a terms version', async () => {
    await assertFails(
      tripTermsDoc(asOwner(), 'new-terms').set(validTripTermsData())
    );
  });

  it('a non-owner member cannot directly create a terms version', async () => {
    await assertFails(
      tripTermsDoc(asMember(), 'new-terms').set(validTripTermsData())
    );
  });

  it('an outsider cannot directly create a terms version', async () => {
    await assertFails(
      tripTermsDoc(asOutsider(), 'new-terms').set(validTripTermsData())
    );
  });

  it('an unauthenticated user cannot directly create a terms version', async () => {
    await assertFails(
      tripTermsDoc(asUnauthenticated(), 'new-terms').set(validTripTermsData())
    );
  });
});

describe('firestore.rules: tripTerms - update and delete are always closed', () => {
  beforeEach(async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
    await seedTripTerms(testEnv, TERMS_ID, validTripTermsData());
  });

  it('owner: cannot update an existing terms version', async () => {
    await assertFails(
      tripTermsDoc(asOwner(), TERMS_ID).update({ contributionExpectations: 'Changed.' })
    );
  });

  it('owner: cannot delete an existing terms version', async () => {
    await assertFails(tripTermsDoc(asOwner(), TERMS_ID).delete());
  });

  it('non-owner member: cannot update', async () => {
    await assertFails(
      tripTermsDoc(asMember(), TERMS_ID).update({ contributionExpectations: 'Changed.' })
    );
  });
});

// Checkpoint 5A.1 (item 8): the client service's fetchAllTripTermsVersions
// uses a plain equality query, not only point reads - a point-read test
// alone does not prove a query is authorized.
describe('firestore.rules: tripTerms - query-level access (fetchAllTripTermsVersions shape)', () => {
  beforeEach(async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
    await seedTripTerms(testEnv, TERMS_ID, validTripTermsData());
    await seedTripTerms(testEnv, 'test-terms-v2', validTripTermsData({ version: 2 }));
  });

  it('a current member can query all terms versions for their Trip', async () => {
    const snap = await assertSucceeds(
      tripTermsCollection(asMember()).where('tripId', '==', TRIP_ID).get()
    );
    expect(snap.docs.map((d) => d.id).sort()).toEqual([TERMS_ID, 'test-terms-v2'].sort());
  });

  it('an invited-but-not-yet-accepted user can run the same query', async () => {
    const invitedUid = 'invited-not-member-uid';
    await seedTripInvitation(
      testEnv,
      invitationId(TRIP_ID, invitedUid),
      validInvitationData({ inviteeUid: invitedUid })
    );
    await assertSucceeds(
      tripTermsCollection(testEnv.authenticatedContext(invitedUid))
        .where('tripId', '==', TRIP_ID)
        .get()
    );
  });

  it('an outsider cannot run the same query', async () => {
    await assertFails(tripTermsCollection(asOutsider()).where('tripId', '==', TRIP_ID).get());
  });

  it('an outsider cannot use the query to enumerate another Trip\'s terms either', async () => {
    await seedTrip(testEnv, 'other-trip', validTripData({ ownerId: OUTSIDER_UID, memberIds: [OUTSIDER_UID] }));
    await seedTripTerms(testEnv, 'other-trip-terms', validTripTermsData({ tripId: 'other-trip' }));
    // The outsider owns "other-trip" but is querying for TRIP_ID, which
    // they have no relation to at all.
    await assertFails(tripTermsCollection(asOutsider()).where('tripId', '==', TRIP_ID).get());
  });
});

// Checkpoint 5A.1 (items 5/6): the tripTermsCurrent/{tripId} pointer
// document - permanently write-closed to every client; read-gated
// identically to tripTerms itself.
describe('firestore.rules: tripTermsCurrent - the authoritative pointer', () => {
  beforeEach(async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
    await seedTripTerms(testEnv, TERMS_ID, validTripTermsData());
    await seedTripTermsCurrent(testEnv, TRIP_ID);
  });

  it('owner: can read the pointer', async () => {
    await assertSucceeds(tripTermsCurrentDoc(asOwner(), TRIP_ID).get());
  });

  it('non-owner member: can read the pointer', async () => {
    await assertSucceeds(tripTermsCurrentDoc(asMember(), TRIP_ID).get());
  });

  it('an invited-but-not-yet-accepted user can read the pointer', async () => {
    const invitedUid = 'invited-not-member-uid';
    await seedTripInvitation(
      testEnv,
      invitationId(TRIP_ID, invitedUid),
      validInvitationData({ inviteeUid: invitedUid })
    );
    await assertSucceeds(
      tripTermsCurrentDoc(testEnv.authenticatedContext(invitedUid), TRIP_ID).get()
    );
  });

  it('an outsider cannot read the pointer', async () => {
    await assertFails(tripTermsCurrentDoc(asOutsider(), TRIP_ID).get());
  });

  it('an unauthenticated user cannot read the pointer', async () => {
    await assertFails(tripTermsCurrentDoc(asUnauthenticated(), TRIP_ID).get());
  });

  it('the owner cannot directly create a pointer document', async () => {
    await assertFails(
      tripTermsCurrentDoc(asOwner(), 'brand-new-trip').set({
        tripId: 'brand-new-trip',
        currentVersion: 1,
        currentTermsDocId: TERMS_ID,
        updatedAt: new Date(),
      })
    );
  });

  it('the owner cannot directly update the pointer', async () => {
    await assertFails(
      tripTermsCurrentDoc(asOwner(), TRIP_ID).update({ currentVersion: 99 })
    );
  });

  it('the owner cannot directly delete the pointer', async () => {
    await assertFails(tripTermsCurrentDoc(asOwner(), TRIP_ID).delete());
  });
});
