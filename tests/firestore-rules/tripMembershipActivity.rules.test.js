// Comprehensive Firestore rules coverage for the `tripMembershipActivity`
// collection (Checkpoint 6.8B3, per the frozen 6.8A through 6.8A4
// architecture). Run against the local Firestore emulator using the real
// firestore.rules file (never weakened to make a test pass - see
// helpers/trips.js's own comment). Mirrors tripExpenses.rules.test.js's
// own structure closely, since both collections share the exact same
// canAccessTripById(tripId) read-authorization mechanism.
//
// Client CREATE/UPDATE/DELETE are permanently closed - the trusted
// backend transactions that write each real event (createTripCore,
// createTripInvitationCore, acceptTripInvitationCore,
// declineTripInvitationCore, cancelTripInvitationCore,
// executeTripMembershipDeparture) all use the Admin SDK, which bypasses
// these rules entirely. Read fixtures below are seeded exclusively via
// the rules-disabled admin context.
const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { Timestamp } = require('firebase/firestore');
const { createTestEnv } = require('./helpers/testEnv');
const { seedTrip, validTripData } = require('./helpers/trips');
const {
  OWNER_UID,
  MEMBER_UID,
  OUTSIDER_UID,
  TRIP_ID,
  OWNER_B_UID,
  MEMBER_B_UID,
  TRIP_B_ID,
  INVITEE_UID,
  FORMER_MEMBER_UID,
  tripCreatedActivity,
  invitationCreatedActivity,
  invitationAcceptedActivity,
  memberLeftActivity,
  memberRemovedActivity,
  historyTrackingStartedActivity,
  seedTripMembershipActivity,
  activityDoc,
  activityCollection,
} = require('./helpers/tripMembershipActivity');

const ACTIVITY_ID = 'activity-1';

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
function asMemberB() {
  return testEnv.authenticatedContext(MEMBER_B_UID);
}
function asOutsider() {
  return testEnv.authenticatedContext(OUTSIDER_UID);
}
function asFormerMember() {
  return testEnv.authenticatedContext(FORMER_MEMBER_UID);
}
function asInvitee() {
  return testEnv.authenticatedContext(INVITEE_UID);
}
function asUnauthenticated() {
  return testEnv.unauthenticatedContext();
}

describe('firestore.rules: tripMembershipActivity - owner reads', () => {
  beforeEach(async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
    await seedTripMembershipActivity(testEnv, ACTIVITY_ID, tripCreatedActivity());
  });

  it('owner can get an activity document for their own Trip', async () => {
    await assertSucceeds(activityDoc(asOwner(), ACTIVITY_ID).get());
  });

  it('owner can run the exact paginated query shape (tripId == + orderBy createdAt desc + limit)', async () => {
    const snap = await assertSucceeds(
      activityCollection(asOwner())
        .where('tripId', '==', TRIP_ID)
        .orderBy('createdAt', 'desc')
        .limit(20)
        .get()
    );
    expect(snap.docs.map((d) => d.id)).toContain(ACTIVITY_ID);
  });
});

describe('firestore.rules: tripMembershipActivity - current (non-owner) member reads', () => {
  beforeEach(async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
    await seedTripMembershipActivity(testEnv, ACTIVITY_ID, tripCreatedActivity());
  });

  it('current non-owner member can get an activity document', async () => {
    await assertSucceeds(activityDoc(asMember(), ACTIVITY_ID).get());
  });

  it('current member can run the exact Trip-scoped paginated query', async () => {
    const snap = await assertSucceeds(
      activityCollection(asMember())
        .where('tripId', '==', TRIP_ID)
        .orderBy('createdAt', 'desc')
        .limit(20)
        .get()
    );
    expect(snap.docs.map((d) => d.id)).toContain(ACTIVITY_ID);
  });
});

describe('firestore.rules: tripMembershipActivity - outsider isolation', () => {
  beforeEach(async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
    await seedTripMembershipActivity(testEnv, ACTIVITY_ID, tripCreatedActivity());
  });

  it('outsider cannot get an activity document', async () => {
    await assertFails(activityDoc(asOutsider(), ACTIVITY_ID).get());
  });

  it('outsider cannot list/query the Trip-scoped activity', async () => {
    await assertFails(
      activityCollection(asOutsider())
        .where('tripId', '==', TRIP_ID)
        .orderBy('createdAt', 'desc')
        .limit(20)
        .get()
    );
  });

  it('unauthenticated caller cannot get an activity document', async () => {
    await assertFails(activityDoc(asUnauthenticated(), ACTIVITY_ID).get());
  });

  it('unauthenticated caller cannot list/query', async () => {
    await assertFails(
      activityCollection(asUnauthenticated())
        .where('tripId', '==', TRIP_ID)
        .orderBy('createdAt', 'desc')
        .limit(20)
        .get()
    );
  });
});

// "Firestore Rules are not filters" (mirrors tripExpenses.rules.test.js's
// own §10 section verbatim): a query's own WHERE constraints, not the
// rule alone, must prove every possible returned document belongs to a
// Trip the caller is authorized for.
describe('firestore.rules: tripMembershipActivity - cross-Trip isolation (Rules are not filters)', () => {
  const OTHER_ACTIVITY_ID = 'activity-b-1';

  beforeEach(async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
    await seedTrip(
      testEnv,
      TRIP_B_ID,
      validTripData({ ownerId: OWNER_B_UID, memberIds: [OWNER_B_UID, MEMBER_B_UID] })
    );
    await seedTripMembershipActivity(testEnv, ACTIVITY_ID, tripCreatedActivity());
    await seedTripMembershipActivity(
      testEnv,
      OTHER_ACTIVITY_ID,
      tripCreatedActivity({ tripId: TRIP_B_ID, actorUid: OWNER_B_UID, targetUid: OWNER_B_UID })
    );
  });

  it('member of Trip A cannot get an activity document belonging to Trip B', async () => {
    await assertFails(activityDoc(asMember(), OTHER_ACTIVITY_ID).get());
  });

  it('member of Trip A cannot query Trip B activity by targeting Trip B directly', async () => {
    await assertFails(
      activityCollection(asMember())
        .where('tripId', '==', TRIP_B_ID)
        .orderBy('createdAt', 'desc')
        .limit(20)
        .get()
    );
  });

  it("member of Trip A's own Trip-scoped query returns ONLY Trip A's activity, never Trip B's", async () => {
    const snap = await assertSucceeds(
      activityCollection(asMember())
        .where('tripId', '==', TRIP_ID)
        .orderBy('createdAt', 'desc')
        .limit(20)
        .get()
    );
    expect(snap.docs.map((d) => d.id)).toEqual([ACTIVITY_ID]);
  });

  it('an unscoped (no tripId filter) collection query is denied outright - membership in Trip A grants no global activity visibility', async () => {
    await assertFails(activityCollection(asMember()).get());
    await assertFails(activityCollection(asMember()).orderBy('createdAt', 'desc').limit(20).get());
  });

  it("an 'in' query spanning both Trips is denied - it could return Trip B's data", async () => {
    await assertFails(
      activityCollection(asMember())
        .where('tripId', 'in', [TRIP_ID, TRIP_B_ID])
        .get()
    );
  });

  it('a member of Trip B can read Trip B activity (symmetric proof - access follows the tripId field, never the document id)', async () => {
    await assertSucceeds(activityDoc(asMemberB(), OTHER_ACTIVITY_ID).get());
  });
});

describe('firestore.rules: tripMembershipActivity - former-member denial', () => {
  beforeEach(async () => {
    // FORMER_MEMBER_UID is deliberately NOT included in memberIds - the
    // Trip reflects CURRENT post-departure state, exactly as the trusted
    // leaveTrip/removeTripMember callable would have already left it.
    await seedTrip(testEnv, TRIP_ID, validTripData({ memberIds: [OWNER_UID, MEMBER_UID] }));
    await seedTripMembershipActivity(testEnv, ACTIVITY_ID, tripCreatedActivity());
    await seedTripMembershipActivity(
      testEnv,
      'activity-member-left',
      memberLeftActivity()
    );
  });

  it('a former member (no longer in memberIds) cannot get activity for that Trip, even their own departure event', async () => {
    await assertFails(activityDoc(asFormerMember(), ACTIVITY_ID).get());
    await assertFails(activityDoc(asFormerMember(), 'activity-member-left').get());
  });

  it('a former member cannot list/query activity for that Trip', async () => {
    await assertFails(
      activityCollection(asFormerMember())
        .where('tripId', '==', TRIP_ID)
        .orderBy('createdAt', 'desc')
        .limit(20)
        .get()
    );
  });

  it('a member who WAS current when the Trip was seeded, then removed, immediately loses access (never grandfathered)', async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData({ memberIds: [OWNER_UID] }));
    await assertFails(activityDoc(asMember(), ACTIVITY_ID).get());
  });
});

describe('firestore.rules: tripMembershipActivity - pending invitee denial', () => {
  beforeEach(async () => {
    // INVITEE_UID is deliberately NOT included in memberIds - a pending
    // invitation never grants current membership (6.8A2/6.8A4's own
    // frozen invariant).
    await seedTrip(testEnv, TRIP_ID, validTripData({ memberIds: [OWNER_UID, MEMBER_UID] }));
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await context
        .firestore()
        .collection('tripInvitations')
        .doc(`${TRIP_ID}_${INVITEE_UID}`)
        .set({
          tripId: TRIP_ID,
          inviterUid: OWNER_UID,
          inviteeEmail: 'invitee@example.com',
          inviteeUid: INVITEE_UID,
          status: 'pending',
          createdAt: Timestamp.now(),
          expiresAt: Timestamp.fromMillis(Date.now() + 14 * 24 * 60 * 60 * 1000),
          respondedAt: null,
        });
    });
    await seedTripMembershipActivity(
      testEnv,
      'activity-invitation-created',
      invitationCreatedActivity()
    );
  });

  it('a pending invitee cannot get activity for the Trip they are invited to', async () => {
    await assertFails(activityDoc(asInvitee(), 'activity-invitation-created').get());
  });

  it('a pending invitee cannot list/query activity for that Trip', async () => {
    await assertFails(
      activityCollection(asInvitee())
        .where('tripId', '==', TRIP_ID)
        .orderBy('createdAt', 'desc')
        .limit(20)
        .get()
    );
  });
});

describe('firestore.rules: tripMembershipActivity - declined/cancelled invitee denial', () => {
  it('a declined invitee (never added to memberIds) still cannot get activity', async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData({ memberIds: [OWNER_UID, MEMBER_UID] }));
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await context
        .firestore()
        .collection('tripInvitations')
        .doc(`${TRIP_ID}_${INVITEE_UID}`)
        .set({
          tripId: TRIP_ID,
          inviterUid: OWNER_UID,
          inviteeEmail: 'invitee@example.com',
          inviteeUid: INVITEE_UID,
          status: 'declined',
          createdAt: Timestamp.now(),
          expiresAt: Timestamp.fromMillis(Date.now() + 14 * 24 * 60 * 60 * 1000),
          respondedAt: Timestamp.now(),
        });
    });
    await seedTripMembershipActivity(
      testEnv,
      'activity-invitation-created',
      invitationCreatedActivity()
    );
    await assertFails(activityDoc(asInvitee(), 'activity-invitation-created').get());
  });

  it('terminal invitation status ALONE never grants access - only current memberIds/ownerId does', async () => {
    // Even a historically-ACCEPTED invitation grants nothing by itself:
    // what matters is whether the uid is in CURRENT memberIds, which this
    // fixture deliberately omits for INVITEE_UID despite an "accepted"
    // invitation record existing (simulating corrupted/inconsistent
    // state - the Rule must never trust invitation history as a
    // membership proxy).
    await seedTrip(testEnv, TRIP_ID, validTripData({ memberIds: [OWNER_UID, MEMBER_UID] }));
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await context
        .firestore()
        .collection('tripInvitations')
        .doc(`${TRIP_ID}_${INVITEE_UID}`)
        .set({
          tripId: TRIP_ID,
          inviterUid: OWNER_UID,
          inviteeEmail: 'invitee@example.com',
          inviteeUid: INVITEE_UID,
          status: 'accepted',
          createdAt: Timestamp.now(),
          expiresAt: Timestamp.fromMillis(Date.now() + 14 * 24 * 60 * 60 * 1000),
          respondedAt: Timestamp.now(),
        });
    });
    await seedTripMembershipActivity(
      testEnv,
      'activity-invitation-accepted',
      invitationAcceptedActivity()
    );
    await assertFails(activityDoc(asInvitee(), 'activity-invitation-accepted').get());
  });
});

describe('firestore.rules: tripMembershipActivity - direct client writes are always denied', () => {
  beforeEach(async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
  });

  it('owner cannot directly create a seemingly-valid activity event', async () => {
    await assertFails(
      activityDoc(asOwner(), 'attempt-owner').set(tripCreatedActivity())
    );
  });

  it('current member cannot directly create an activity event', async () => {
    await assertFails(
      activityDoc(asMember(), 'attempt-member').set(tripCreatedActivity())
    );
  });

  it('outsider cannot directly create an activity event', async () => {
    await assertFails(
      activityDoc(asOutsider(), 'attempt-outsider').set(tripCreatedActivity())
    );
  });

  it('unauthenticated caller cannot directly create an activity event', async () => {
    await assertFails(
      activityDoc(asUnauthenticated(), 'attempt-unauth').set(tripCreatedActivity())
    );
  });

  describe('once an activity document exists', () => {
    beforeEach(async () => {
      await seedTripMembershipActivity(testEnv, ACTIVITY_ID, tripCreatedActivity());
    });

    it('owner cannot update an activity event', async () => {
      await assertFails(
        activityDoc(asOwner(), ACTIVITY_ID).update({ actorUid: 'tampered' })
      );
    });

    it('current member cannot update an activity event', async () => {
      await assertFails(
        activityDoc(asMember(), ACTIVITY_ID).update({ actorUid: 'tampered' })
      );
    });

    it('owner cannot delete an activity event', async () => {
      await assertFails(activityDoc(asOwner(), ACTIVITY_ID).delete());
    });

    it('current member cannot delete an activity event', async () => {
      await assertFails(activityDoc(asMember(), ACTIVITY_ID).delete());
    });

    it('outsider cannot update or delete an activity event', async () => {
      await assertFails(
        activityDoc(asOutsider(), ACTIVITY_ID).update({ actorUid: 'tampered' })
      );
      await assertFails(activityDoc(asOutsider(), ACTIVITY_ID).delete());
    });
  });
});

describe('firestore.rules: tripMembershipActivity - malformed/missing Trip relationship fails closed', () => {
  it('an activity document pointing to a nonexistent Trip is unreadable by anyone', async () => {
    await seedTripMembershipActivity(
      testEnv,
      'activity-orphan',
      tripCreatedActivity({ tripId: 'no-such-trip' })
    );
    await assertFails(activityDoc(asOwner(), 'activity-orphan').get());
    await assertFails(activityDoc(asMember(), 'activity-orphan').get());
    await assertFails(activityDoc(asOutsider(), 'activity-orphan').get());
  });

  it('an activity document with a malformed/non-string tripId is unreadable', async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
    await seedTripMembershipActivity(
      testEnv,
      'activity-malformed',
      tripCreatedActivity({ tripId: 12345 })
    );
    await assertFails(activityDoc(asOwner(), 'activity-malformed').get());
    await assertFails(activityDoc(asMember(), 'activity-malformed').get());
  });

  it('an activity document missing tripId entirely is unreadable', async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
    const data = tripCreatedActivity();
    delete data.tripId;
    await seedTripMembershipActivity(testEnv, 'activity-no-tripid', data);
    await assertFails(activityDoc(asOwner(), 'activity-no-tripid').get());
  });
});

// The Rules security decision depends ONLY on Trip membership + tripId,
// never on event type (6.8B3 item 5) - proven by exercising the same
// owner/outsider read outcome uniformly across every representative
// event family.
describe('firestore.rules: tripMembershipActivity - read policy is uniform across every representative event type', () => {
  const FIXTURES = [
    ['trip_created', tripCreatedActivity],
    ['invitation_created', invitationCreatedActivity],
    ['invitation_accepted', invitationAcceptedActivity],
    ['member_left', memberLeftActivity],
    ['member_removed', memberRemovedActivity],
    ['history_tracking_started', historyTrackingStartedActivity],
  ];

  beforeEach(async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
  });

  for (const [label, buildFixture] of FIXTURES) {
    it(`owner can get a ${label} event; outsider cannot`, async () => {
      const id = `activity-${label}`;
      await seedTripMembershipActivity(testEnv, id, buildFixture());
      await assertSucceeds(activityDoc(asOwner(), id).get());
      await assertFails(activityDoc(asOutsider(), id).get());
    });
  }
});
