// Comprehensive Firestore rules coverage for the `tripTerms` and
// `tripTermsCurrent` collections (Checkpoint 5A, hardened by 5A.1), run
// against the local Firestore emulator using the real firestore.rules
// file (never weakened to make a test pass).
const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { Timestamp } = require('firebase/firestore');
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

// Checkpoint 5C.2 (frozen docs/audits/
// TRIP_FINANCIAL_MEMBERSHIP_ACCEPTANCE_PREFLIGHT_2026-10-16.md §16/§18
// item 5, Option B): pre-join terms access now requires a CURRENTLY
// actionable - pending AND unexpired - invitation, not merely any
// invitation of any status. This describe block's name/content reflect
// that narrowing; the former any-status hasTripInvitationRecord behavior
// this block used to prove is gone.
describe('firestore.rules: tripTerms - reads (Option B pre-join privacy, Checkpoint 5C.2)', () => {
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

  it('a pending+unexpired named invitee can read the trip terms', async () => {
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

  it('a pending+EXPIRED invitee cannot read the trip terms', async () => {
    const invitedUid = 'expired-invitee-uid';
    await seedTripInvitation(
      testEnv,
      invitationId(TRIP_ID, invitedUid),
      validInvitationData({
        inviteeUid: invitedUid,
        expiresAt: Timestamp.fromMillis(Date.now() - 60 * 60 * 1000),
      })
    );
    await assertFails(
      tripTermsDoc(testEnv.authenticatedContext(invitedUid), TERMS_ID).get()
    );
  });

  it('a declined invitee cannot read the trip terms', async () => {
    const invitedUid = 'declined-invitee-uid';
    await seedTripInvitation(
      testEnv,
      invitationId(TRIP_ID, invitedUid),
      validInvitationData({
        inviteeUid: invitedUid,
        status: 'declined',
        respondedAt: Timestamp.now(),
      })
    );
    await assertFails(
      tripTermsDoc(testEnv.authenticatedContext(invitedUid), TERMS_ID).get()
    );
  });

  it('a cancelled invitee cannot read the trip terms', async () => {
    const invitedUid = 'cancelled-invitee-uid';
    await seedTripInvitation(
      testEnv,
      invitationId(TRIP_ID, invitedUid),
      validInvitationData({
        inviteeUid: invitedUid,
        status: 'cancelled',
        respondedAt: Timestamp.now(),
      })
    );
    await assertFails(
      tripTermsDoc(testEnv.authenticatedContext(invitedUid), TERMS_ID).get()
    );
  });

  // An accepted INVITATION alone must never be post-join authority -
  // trips.memberIds is the sole source of truth (frozen preflight §16).
  // This uid's invitation says "accepted" but was never actually added
  // to trips.memberIds - an inconsistent/unlinked state that must still
  // fail closed, never treated as equivalent to real membership.
  it('an accepted invitation ALONE (uid not in trips.memberIds) cannot read the trip terms', async () => {
    const acceptedNotMemberUid = 'accepted-not-member-uid';
    await seedTripInvitation(
      testEnv,
      invitationId(TRIP_ID, acceptedNotMemberUid),
      validInvitationData({
        inviteeUid: acceptedNotMemberUid,
        status: 'accepted',
        respondedAt: Timestamp.now(),
      })
    );
    await assertFails(
      tripTermsDoc(testEnv.authenticatedContext(acceptedNotMemberUid), TERMS_ID).get()
    );
  });

  // The mirror image of the test above - once a uid IS in
  // trips.memberIds, they read via ordinary canAccessTripById, never
  // through the invitation relationship at all (the accepted invitation
  // here is present only to prove it is not what's granting access).
  it('an accepted invitation + CURRENT trips.memberIds membership can read the trip terms', async () => {
    const acceptedMemberUid = 'accepted-and-member-uid';
    await seedTrip(
      testEnv,
      TRIP_ID,
      validTripData({ memberIds: [OWNER_UID, MEMBER_UID, acceptedMemberUid] })
    );
    await seedTripInvitation(
      testEnv,
      invitationId(TRIP_ID, acceptedMemberUid),
      validInvitationData({
        inviteeUid: acceptedMemberUid,
        status: 'accepted',
        respondedAt: Timestamp.now(),
      })
    );
    await assertSucceeds(
      tripTermsDoc(testEnv.authenticatedContext(acceptedMemberUid), TERMS_ID).get()
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

  it('a pending+unexpired invited user can run the same query', async () => {
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

  // Checkpoint 5C.2: Firestore evaluates a `list`/query rule using the
  // query's own filters plus a per-document Rules check for each
  // candidate, so the Option-B narrowing (§16) must be proven at the
  // query level too, not only for a single point-read get() - list/query
  // authorization is evaluated independently and can diverge from a
  // point get() if the Rules expression were ever written differently
  // for the two (it is not, here, but this is exactly the kind of gap a
  // point-read-only test suite would miss).
  it('an expired invited user cannot run the same query', async () => {
    const invitedUid = 'expired-invitee-uid';
    await seedTripInvitation(
      testEnv,
      invitationId(TRIP_ID, invitedUid),
      validInvitationData({
        inviteeUid: invitedUid,
        expiresAt: Timestamp.fromMillis(Date.now() - 60 * 60 * 1000),
      })
    );
    await assertFails(
      tripTermsCollection(testEnv.authenticatedContext(invitedUid))
        .where('tripId', '==', TRIP_ID)
        .get()
    );
  });

  it('a declined invited user cannot run the same query', async () => {
    const invitedUid = 'declined-invitee-uid';
    await seedTripInvitation(
      testEnv,
      invitationId(TRIP_ID, invitedUid),
      validInvitationData({
        inviteeUid: invitedUid,
        status: 'declined',
        respondedAt: Timestamp.now(),
      })
    );
    await assertFails(
      tripTermsCollection(testEnv.authenticatedContext(invitedUid))
        .where('tripId', '==', TRIP_ID)
        .get()
    );
  });

  it('a cancelled invited user cannot run the same query', async () => {
    const invitedUid = 'cancelled-invitee-uid';
    await seedTripInvitation(
      testEnv,
      invitationId(TRIP_ID, invitedUid),
      validInvitationData({
        inviteeUid: invitedUid,
        status: 'cancelled',
        respondedAt: Timestamp.now(),
      })
    );
    await assertFails(
      tripTermsCollection(testEnv.authenticatedContext(invitedUid))
        .where('tripId', '==', TRIP_ID)
        .get()
    );
  });

  it('an accepted-invitation-but-not-member user cannot run the same query', async () => {
    const acceptedNotMemberUid = 'accepted-not-member-uid';
    await seedTripInvitation(
      testEnv,
      invitationId(TRIP_ID, acceptedNotMemberUid),
      validInvitationData({
        inviteeUid: acceptedNotMemberUid,
        status: 'accepted',
        respondedAt: Timestamp.now(),
      })
    );
    await assertFails(
      tripTermsCollection(testEnv.authenticatedContext(acceptedNotMemberUid))
        .where('tripId', '==', TRIP_ID)
        .get()
    );
  });

  it('an accepted current member can run the same query (via memberIds, not the invitation)', async () => {
    const acceptedMemberUid = 'accepted-and-member-uid';
    await seedTrip(
      testEnv,
      TRIP_ID,
      validTripData({ memberIds: [OWNER_UID, MEMBER_UID, acceptedMemberUid] })
    );
    await seedTripInvitation(
      testEnv,
      invitationId(TRIP_ID, acceptedMemberUid),
      validInvitationData({
        inviteeUid: acceptedMemberUid,
        status: 'accepted',
        respondedAt: Timestamp.now(),
      })
    );
    await assertSucceeds(
      tripTermsCollection(testEnv.authenticatedContext(acceptedMemberUid))
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

  it('a pending+unexpired named invitee can read the pointer', async () => {
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

  // Checkpoint 5C.2 (frozen preflight §16/§18 item 5, Option B): the
  // tripTermsCurrent pointer's read rule shares the exact same
  // hasPendingUnexpiredTripInvitation helper as tripTerms itself - this
  // block mirrors that collection's full privacy matrix rather than only
  // the happy path, since the two Rules clauses could in principle drift
  // independently even though they do not today.
  it('a pending+EXPIRED invitee cannot read the pointer', async () => {
    const invitedUid = 'expired-invitee-uid';
    await seedTripInvitation(
      testEnv,
      invitationId(TRIP_ID, invitedUid),
      validInvitationData({
        inviteeUid: invitedUid,
        expiresAt: Timestamp.fromMillis(Date.now() - 60 * 60 * 1000),
      })
    );
    await assertFails(
      tripTermsCurrentDoc(testEnv.authenticatedContext(invitedUid), TRIP_ID).get()
    );
  });

  it('a declined invitee cannot read the pointer', async () => {
    const invitedUid = 'declined-invitee-uid';
    await seedTripInvitation(
      testEnv,
      invitationId(TRIP_ID, invitedUid),
      validInvitationData({
        inviteeUid: invitedUid,
        status: 'declined',
        respondedAt: Timestamp.now(),
      })
    );
    await assertFails(
      tripTermsCurrentDoc(testEnv.authenticatedContext(invitedUid), TRIP_ID).get()
    );
  });

  it('a cancelled invitee cannot read the pointer', async () => {
    const invitedUid = 'cancelled-invitee-uid';
    await seedTripInvitation(
      testEnv,
      invitationId(TRIP_ID, invitedUid),
      validInvitationData({
        inviteeUid: invitedUid,
        status: 'cancelled',
        respondedAt: Timestamp.now(),
      })
    );
    await assertFails(
      tripTermsCurrentDoc(testEnv.authenticatedContext(invitedUid), TRIP_ID).get()
    );
  });

  it('an accepted invitation ALONE (uid not in trips.memberIds) cannot read the pointer', async () => {
    const acceptedNotMemberUid = 'accepted-not-member-uid';
    await seedTripInvitation(
      testEnv,
      invitationId(TRIP_ID, acceptedNotMemberUid),
      validInvitationData({
        inviteeUid: acceptedNotMemberUid,
        status: 'accepted',
        respondedAt: Timestamp.now(),
      })
    );
    await assertFails(
      tripTermsCurrentDoc(testEnv.authenticatedContext(acceptedNotMemberUid), TRIP_ID).get()
    );
  });

  it('an accepted invitation + CURRENT trips.memberIds membership can read the pointer', async () => {
    const acceptedMemberUid = 'accepted-and-member-uid';
    await seedTrip(
      testEnv,
      TRIP_ID,
      validTripData({ memberIds: [OWNER_UID, MEMBER_UID, acceptedMemberUid] })
    );
    await seedTripInvitation(
      testEnv,
      invitationId(TRIP_ID, acceptedMemberUid),
      validInvitationData({
        inviteeUid: acceptedMemberUid,
        status: 'accepted',
        respondedAt: Timestamp.now(),
      })
    );
    await assertSucceeds(
      tripTermsCurrentDoc(testEnv.authenticatedContext(acceptedMemberUid), TRIP_ID).get()
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
