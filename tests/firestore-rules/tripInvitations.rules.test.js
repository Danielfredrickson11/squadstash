// Comprehensive Firestore rules coverage for the `tripInvitations`
// collection (Checkpoint 5A), run against the local Firestore emulator
// using the real firestore.rules file (never weakened to make a test
// pass).
const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { serverTimestamp, Timestamp } = require('firebase/firestore');
const { createTestEnv } = require('./helpers/testEnv');
const { seedTrip, validTripData } = require('./helpers/trips');
const {
  OWNER_UID,
  INVITEE_UID,
  OUTSIDER_UID,
  TRIP_ID,
  invitationId,
  validInvitationData,
  seedTripInvitation,
  tripInvitationDoc,
  tripInvitationsCollection,
} = require('./helpers/tripInvitations');

const INVITATION_ID = invitationId(TRIP_ID, INVITEE_UID);

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
  await seedTrip(testEnv, TRIP_ID, validTripData({ memberIds: [OWNER_UID] }));
});

function asOwner() {
  return testEnv.authenticatedContext(OWNER_UID);
}
function asInvitee() {
  return testEnv.authenticatedContext(INVITEE_UID);
}
function asOutsider() {
  return testEnv.authenticatedContext(OUTSIDER_UID);
}
function asUnauthenticated() {
  return testEnv.unauthenticatedContext();
}

describe('firestore.rules: tripInvitations - create is always closed', () => {
  it('owner cannot directly create an invitation (trusted callable only)', async () => {
    await assertFails(
      tripInvitationDoc(asOwner(), INVITATION_ID).set(validInvitationData())
    );
  });

  it('the invitee cannot create their own invitation record', async () => {
    await assertFails(
      tripInvitationDoc(asInvitee(), INVITATION_ID).set(validInvitationData())
    );
  });
});

describe('firestore.rules: tripInvitations - reads', () => {
  beforeEach(async () => {
    await seedTripInvitation(testEnv, INVITATION_ID, validInvitationData());
  });

  it('the invitee can read their own invitation', async () => {
    await assertSucceeds(tripInvitationDoc(asInvitee(), INVITATION_ID).get());
  });

  it('the Trip owner can read it', async () => {
    await assertSucceeds(tripInvitationDoc(asOwner(), INVITATION_ID).get());
  });

  it('an outsider cannot read it', async () => {
    await assertFails(tripInvitationDoc(asOutsider(), INVITATION_ID).get());
  });

  it('an unauthenticated user cannot read it', async () => {
    await assertFails(tripInvitationDoc(asUnauthenticated(), INVITATION_ID).get());
  });
});

describe('firestore.rules: tripInvitations - invitee responses', () => {
  beforeEach(async () => {
    await seedTripInvitation(testEnv, INVITATION_ID, validInvitationData());
  });

  it('the invitee can accept a pending invitation', async () => {
    await assertSucceeds(
      tripInvitationDoc(asInvitee(), INVITATION_ID).update({
        status: 'accepted',
        respondedAt: serverTimestamp(),
      })
    );
  });

  it('the invitee can decline a pending invitation', async () => {
    await assertSucceeds(
      tripInvitationDoc(asInvitee(), INVITATION_ID).update({
        status: 'declined',
        respondedAt: serverTimestamp(),
      })
    );
  });

  it('the invitee cannot set status to "cancelled" (owner-only transition)', async () => {
    await assertFails(
      tripInvitationDoc(asInvitee(), INVITATION_ID).update({
        status: 'cancelled',
        respondedAt: serverTimestamp(),
      })
    );
  });

  it('the invitee cannot forge an arbitrary respondedAt instead of server time', async () => {
    await assertFails(
      tripInvitationDoc(asInvitee(), INVITATION_ID).update({
        status: 'accepted',
        respondedAt: Timestamp.fromDate(new Date('2020-01-01')),
      })
    );
  });

  it('the invitee cannot combine a response with another field change', async () => {
    await assertFails(
      tripInvitationDoc(asInvitee(), INVITATION_ID).update({
        status: 'accepted',
        respondedAt: serverTimestamp(),
        inviterUid: INVITEE_UID,
      })
    );
  });

  it('the owner cannot accept on the invitee\'s behalf', async () => {
    await assertFails(
      tripInvitationDoc(asOwner(), INVITATION_ID).update({
        status: 'accepted',
        respondedAt: serverTimestamp(),
      })
    );
  });

  it('an outsider cannot respond at all', async () => {
    await assertFails(
      tripInvitationDoc(asOutsider(), INVITATION_ID).update({
        status: 'accepted',
        respondedAt: serverTimestamp(),
      })
    );
  });

  describe('once already responded', () => {
    beforeEach(async () => {
      await seedTripInvitation(
        testEnv,
        INVITATION_ID,
        validInvitationData({ status: 'accepted', respondedAt: Timestamp.now() })
      );
    });

    it('the invitee cannot change status again', async () => {
      await assertFails(
        tripInvitationDoc(asInvitee(), INVITATION_ID).update({
          status: 'declined',
          respondedAt: serverTimestamp(),
        })
      );
    });

    it('the owner cannot cancel an already-accepted invitation', async () => {
      await assertFails(
        tripInvitationDoc(asOwner(), INVITATION_ID).update({
          status: 'cancelled',
          respondedAt: serverTimestamp(),
        })
      );
    });
  });
});

// Checkpoint 5A.1, item 2: expiry must be enforced at the actual write
// boundary, not only by the UI/domain-layer isTripInvitationExpired
// helper.
describe('firestore.rules: tripInvitations - expiry enforcement', () => {
  function seedWithExpiry(expiresAt) {
    return seedTripInvitation(testEnv, INVITATION_ID, validInvitationData({ expiresAt }));
  }

  it('pending + unexpired: accepting succeeds', async () => {
    await seedWithExpiry(Timestamp.fromMillis(Date.now() + 60 * 60 * 1000));
    await assertSucceeds(
      tripInvitationDoc(asInvitee(), INVITATION_ID).update({
        status: 'accepted',
        respondedAt: serverTimestamp(),
      })
    );
  });

  it('pending + expired: accepting fails', async () => {
    await seedWithExpiry(Timestamp.fromMillis(Date.now() - 60 * 60 * 1000));
    await assertFails(
      tripInvitationDoc(asInvitee(), INVITATION_ID).update({
        status: 'accepted',
        respondedAt: serverTimestamp(),
      })
    );
  });

  it('expiration boundary: expiresAt exactly equal to request.time fails (must be strictly in the future)', async () => {
    // expiresAt == request.time means the invitation expires AT this
    // instant - resource.data.expiresAt > request.time correctly treats
    // that instant itself as already expired, never as the last valid
    // moment.
    await seedWithExpiry(Timestamp.now());
    await assertFails(
      tripInvitationDoc(asInvitee(), INVITATION_ID).update({
        status: 'accepted',
        respondedAt: serverTimestamp(),
      })
    );
  });

  it('pending + expired: declining still succeeds (documented choice - harmless)', async () => {
    await seedWithExpiry(Timestamp.fromMillis(Date.now() - 60 * 60 * 1000));
    await assertSucceeds(
      tripInvitationDoc(asInvitee(), INVITATION_ID).update({
        status: 'declined',
        respondedAt: serverTimestamp(),
      })
    );
  });

  it('pending + expired: owner cancellation still succeeds (documented choice - harmless)', async () => {
    await seedWithExpiry(Timestamp.fromMillis(Date.now() - 60 * 60 * 1000));
    await assertSucceeds(
      tripInvitationDoc(asOwner(), INVITATION_ID).update({
        status: 'cancelled',
        respondedAt: serverTimestamp(),
      })
    );
  });

  it('the invitee cannot alter expiresAt while accepting', async () => {
    await seedWithExpiry(Timestamp.fromMillis(Date.now() + 60 * 60 * 1000));
    await assertFails(
      tripInvitationDoc(asInvitee(), INVITATION_ID).update({
        status: 'accepted',
        respondedAt: serverTimestamp(),
        expiresAt: Timestamp.fromMillis(Date.now() + 365 * 24 * 60 * 60 * 1000),
      })
    );
  });

  it('terminal states remain terminal regardless of expiry (accepted cannot be re-responded-to after expiry passes)', async () => {
    await seedTripInvitation(
      testEnv,
      INVITATION_ID,
      validInvitationData({
        status: 'accepted',
        respondedAt: Timestamp.now(),
        expiresAt: Timestamp.fromMillis(Date.now() - 60 * 60 * 1000),
      })
    );
    await assertFails(
      tripInvitationDoc(asInvitee(), INVITATION_ID).update({
        status: 'declined',
        respondedAt: serverTimestamp(),
      })
    );
  });
});

describe('firestore.rules: tripInvitations - owner cancellation', () => {
  beforeEach(async () => {
    await seedTripInvitation(testEnv, INVITATION_ID, validInvitationData());
  });

  it('the owner can cancel a pending invitation', async () => {
    await assertSucceeds(
      tripInvitationDoc(asOwner(), INVITATION_ID).update({
        status: 'cancelled',
        respondedAt: serverTimestamp(),
      })
    );
  });

  it('a non-owner cannot cancel', async () => {
    await assertFails(
      tripInvitationDoc(asOutsider(), INVITATION_ID).update({
        status: 'cancelled',
        respondedAt: serverTimestamp(),
      })
    );
  });

  it('the owner cannot forge an arbitrary respondedAt instead of server time', async () => {
    await assertFails(
      tripInvitationDoc(asOwner(), INVITATION_ID).update({
        status: 'cancelled',
        respondedAt: Timestamp.fromDate(new Date('2020-01-01')),
      })
    );
  });
});

describe('firestore.rules: tripInvitations - delete is always closed', () => {
  beforeEach(async () => {
    await seedTripInvitation(testEnv, INVITATION_ID, validInvitationData());
  });

  it('the owner cannot delete an invitation', async () => {
    await assertFails(tripInvitationDoc(asOwner(), INVITATION_ID).delete());
  });

  it('the invitee cannot delete their own invitation', async () => {
    await assertFails(tripInvitationDoc(asInvitee(), INVITATION_ID).delete());
  });
});

// Checkpoint 5A.1 (item 8): the service layer's fetchInvitationsForTrip
// (owner, by tripId) and fetchPendingInvitationsForUser (invitee, by
// inviteeUid) are plain equality queries, not only point reads - a
// point-read test alone does not prove a query is authorized. Two
// different invitees are seeded for the SAME Trip so a query that would
// expose a document belonging to someone else is actually exercised,
// not vacuously true.
describe('firestore.rules: tripInvitations - query-level access', () => {
  const SECOND_INVITEE_UID = 'second-invitee-uid';
  const SECOND_INVITATION_ID = invitationId(TRIP_ID, SECOND_INVITEE_UID);

  beforeEach(async () => {
    await seedTripInvitation(testEnv, INVITATION_ID, validInvitationData());
    await seedTripInvitation(
      testEnv,
      SECOND_INVITATION_ID,
      validInvitationData({ inviteeUid: SECOND_INVITEE_UID })
    );
  });

  it('the Trip owner can query every invitation for their Trip (fetchInvitationsForTrip shape)', async () => {
    const snap = await assertSucceeds(
      tripInvitationsCollection(asOwner()).where('tripId', '==', TRIP_ID).get()
    );
    expect(snap.docs.map((d) => d.id).sort()).toEqual(
      [INVITATION_ID, SECOND_INVITATION_ID].sort()
    );
  });

  it('an invitee CANNOT run the owner\'s by-tripId query, because it would expose another invitee\'s document', async () => {
    await assertFails(
      tripInvitationsCollection(asInvitee()).where('tripId', '==', TRIP_ID).get()
    );
  });

  it('an outsider cannot run the by-tripId query at all', async () => {
    await assertFails(
      tripInvitationsCollection(asOutsider()).where('tripId', '==', TRIP_ID).get()
    );
  });

  it('an invitee can query their own invitations by inviteeUid (fetchPendingInvitationsForUser shape)', async () => {
    const snap = await assertSucceeds(
      tripInvitationsCollection(asInvitee()).where('inviteeUid', '==', INVITEE_UID).get()
    );
    expect(snap.docs.map((d) => d.id)).toEqual([INVITATION_ID]);
  });

  it('a uid cannot query another uid\'s invitations by inviteeUid', async () => {
    await assertFails(
      tripInvitationsCollection(asInvitee())
        .where('inviteeUid', '==', SECOND_INVITEE_UID)
        .get()
    );
  });

  // Deliberately NOT tested as assertSucceeds: a bare `where('inviteeUid',
  // '==', someoneElse)` query - from ANY caller, owner included - can
  // never be authorized under this rule, because Firestore evaluates
  // `list` rules using ONLY the query's own equality filters as known
  // facts, never real document data. Such a query pins `inviteeUid` to a
  // literal that provably differs from `request.auth.uid`, which makes
  // the self-access branch definitively FALSE - and since this query
  // never also filters by `tripId`, the owner-authority branch has no
  // way to resolve `resource.data.tripId` either, leaving the rule
  // unprovable. This is not a gap: the service layer never issues this
  // query shape (fetchInvitationsForTrip filters by tripId; only a
  // caller's OWN inviteeUid is ever queried self-, never someone else's).
  it('nobody - not even the owner - can query by someone else\'s inviteeUid (no service-layer shape relies on this)', async () => {
    await assertFails(
      tripInvitationsCollection(asOwner()).where('inviteeUid', '==', INVITEE_UID).get()
    );
  });
});
