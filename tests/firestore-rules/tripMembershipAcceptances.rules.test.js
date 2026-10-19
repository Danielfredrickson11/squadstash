// Comprehensive Firestore rules coverage for the
// `tripMembershipAcceptances` collection (Checkpoint 5A, hardened by
// 5A.1; direct client creation permanently closed by Checkpoint 5C.2 -
// frozen docs/audits/TRIP_FINANCIAL_MEMBERSHIP_ACCEPTANCE_PREFLIGHT_
// 2026-10-16.md §18 item 2), run against the local Firestore emulator
// using the real firestore.rules file (never weakened to make a test
// pass).
const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { serverTimestamp, Timestamp } = require('firebase/firestore');
const { createTestEnv } = require('./helpers/testEnv');
const { seedTrip, validTripData } = require('./helpers/trips');
const { seedTripTerms, seedTripTermsCurrent, validTripTermsData } = require('./helpers/tripTerms');
const { seedTripInvitation, validInvitationData, invitationId } = require('./helpers/tripInvitations');
const {
  OWNER_UID,
  MEMBER_UID,
  OUTSIDER_UID,
  SECOND_MEMBER_UID,
  TRIP_ID,
  TERMS_ID,
  acceptanceId,
  validAcceptanceData,
  seedTripMembershipAcceptance,
  tripMembershipAcceptanceDoc,
} = require('./helpers/tripMembershipAcceptances');

const ACCEPTANCE_ID = acceptanceId(TRIP_ID, MEMBER_UID, TERMS_ID);

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
  // SECOND_MEMBER_UID is a CURRENT Trip member (distinct from both the
  // owner and MEMBER_UID, the invitee) - used to prove one current
  // member cannot forge an acceptance record claiming another member's
  // uid. MEMBER_UID itself is intentionally NOT a current Trip member -
  // every test below exercises the invitee's (now entirely closed)
  // direct-create path, never ordinary current-member status.
  await seedTrip(testEnv, TRIP_ID, validTripData({ memberIds: [OWNER_UID, SECOND_MEMBER_UID] }));
  await seedTripTerms(testEnv, TERMS_ID, validTripTermsData());
  await seedTripTermsCurrent(testEnv, TRIP_ID, { currentTermsDocId: TERMS_ID, currentVersion: 1 });
  // A live, pending+unexpired invitation for MEMBER_UID - the single most
  // favorable precondition a direct create attempt could ever have.
  await seedTripInvitation(
    testEnv,
    invitationId(TRIP_ID, MEMBER_UID),
    validInvitationData({ inviteeUid: MEMBER_UID })
  );
});

function asOwner() {
  return testEnv.authenticatedContext(OWNER_UID);
}
function asMember() {
  return testEnv.authenticatedContext(MEMBER_UID);
}
function asSecondMember() {
  return testEnv.authenticatedContext(SECOND_MEMBER_UID);
}
function asOutsider() {
  return testEnv.authenticatedContext(OUTSIDER_UID);
}
function asUnauthenticated() {
  return testEnv.unauthenticatedContext();
}

// withSecurityRulesDisabled does not propagate its callback's own return
// value - every other read-after-bypass in this file captures the result
// via a closed-over variable instead (the same pattern every other
// rules-test helper's seed functions already use for writes).
async function readTripUnsafe(tripId) {
  let data;
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const snap = await context.firestore().collection('trips').doc(tripId).get();
    data = snap.data();
  });
  return data;
}

// Checkpoint 5C.2: every test below used to assert assertSucceeds for at
// least one well-formed scenario - direct client creation of this
// collection is now permanently closed (`allow create, update, delete:
// if false`), for every role and every payload shape, no exception. This
// is an intentional reversal of this file's prior coverage, not a
// weakening - see firestore.rules' own comment on this match block for
// why (acceptance now ties directly to real Trip membership via the
// trusted acceptTripInvitation transaction, so the old direct-create path
// became a genuine bypass once that meaning existed).
describe('firestore.rules: tripMembershipAcceptances - create is now permanently closed', () => {
  it('the named invitee cannot directly create a perfectly canonical acceptance - pending+unexpired invitation, exact current terms, correct deterministic id, serverTimestamp acceptedAt', async () => {
    await assertFails(
      tripMembershipAcceptanceDoc(asMember(), ACCEPTANCE_ID).set({
        ...validAcceptanceData(),
        acceptedAt: serverTimestamp(),
      })
    );
  });

  it('an already-accepted invitee cannot directly create one either', async () => {
    await seedTripInvitation(
      testEnv,
      invitationId(TRIP_ID, MEMBER_UID),
      validInvitationData({ inviteeUid: MEMBER_UID, status: 'accepted', respondedAt: Timestamp.now() })
    );
    await assertFails(
      tripMembershipAcceptanceDoc(asMember(), ACCEPTANCE_ID).set({
        ...validAcceptanceData(),
        acceptedAt: serverTimestamp(),
      })
    );
  });

  it('the Trip owner cannot create one on behalf of someone else', async () => {
    await assertFails(
      tripMembershipAcceptanceDoc(asOwner(), ACCEPTANCE_ID).set({
        ...validAcceptanceData(),
        acceptedAt: serverTimestamp(),
      })
    );
  });

  it('a current Trip member cannot forge another member\'s acceptance record', async () => {
    await assertFails(
      tripMembershipAcceptanceDoc(asSecondMember(), ACCEPTANCE_ID).set({
        ...validAcceptanceData({ uid: MEMBER_UID }),
        acceptedAt: serverTimestamp(),
      })
    );
  });

  it('an outsider cannot create an acceptance record', async () => {
    await assertFails(
      tripMembershipAcceptanceDoc(asOutsider(), ACCEPTANCE_ID).set({
        ...validAcceptanceData({ uid: OUTSIDER_UID }),
        acceptedAt: serverTimestamp(),
      })
    );
  });

  it('an unauthenticated user cannot create an acceptance record', async () => {
    await assertFails(
      tripMembershipAcceptanceDoc(asUnauthenticated(), ACCEPTANCE_ID).set({
        ...validAcceptanceData(),
        acceptedAt: serverTimestamp(),
      })
    );
  });
});

// Checkpoint 5C.2: replaces this file's former "proves terms acceptance
// is NOT financial membership" describe block, whose premise (a client-
// written acceptance succeeds but grants nothing extra) no longer
// applies now that client creation cannot succeed at all. This is the
// one regression that premise's removal still calls for: a REJECTED
// direct create must have zero side effects on Trip.memberIds.
describe('firestore.rules: tripMembershipAcceptances - a failed direct create has no side effects', () => {
  it('a rejected direct acceptance-record create does not alter trips.memberIds', async () => {
    const before = await readTripUnsafe(TRIP_ID);
    await assertFails(
      tripMembershipAcceptanceDoc(asMember(), ACCEPTANCE_ID).set({
        ...validAcceptanceData(),
        acceptedAt: serverTimestamp(),
      })
    );
    const after = await readTripUnsafe(TRIP_ID);
    expect(after.memberIds).toEqual(before.memberIds);
    expect(after.memberIds.includes(MEMBER_UID)).toBe(false);
  });
});

describe('firestore.rules: tripMembershipAcceptances - reads', () => {
  beforeEach(async () => {
    await seedTripMembershipAcceptance(testEnv, ACCEPTANCE_ID, validAcceptanceData());
  });

  it('the accepting member can read their own acceptance record', async () => {
    await assertSucceeds(tripMembershipAcceptanceDoc(asMember(), ACCEPTANCE_ID).get());
  });

  it('the Trip owner can read it', async () => {
    await assertSucceeds(tripMembershipAcceptanceDoc(asOwner(), ACCEPTANCE_ID).get());
  });

  it('an outsider cannot read it', async () => {
    await assertFails(tripMembershipAcceptanceDoc(asOutsider(), ACCEPTANCE_ID).get());
  });

  it('an unauthenticated user cannot read it', async () => {
    await assertFails(tripMembershipAcceptanceDoc(asUnauthenticated(), ACCEPTANCE_ID).get());
  });
});

// Checkpoint 5A.1, item 8: fetchTripMembershipAcceptances(tripId, uid) is
// a two-equality-field query, not only a point read.
describe('firestore.rules: tripMembershipAcceptances - query-level access', () => {
  beforeEach(async () => {
    await seedTripMembershipAcceptance(testEnv, ACCEPTANCE_ID, validAcceptanceData());
  });

  it('the accepting member can query their own acceptances for this Trip', async () => {
    const snap = await assertSucceeds(
      testEnv
        .authenticatedContext(MEMBER_UID)
        .firestore()
        .collection('tripMembershipAcceptances')
        .where('tripId', '==', TRIP_ID)
        .where('uid', '==', MEMBER_UID)
        .get()
    );
    expect(snap.docs.map((d) => d.id)).toEqual([ACCEPTANCE_ID]);
  });

  it('the Trip owner can query another member\'s acceptances', async () => {
    await assertSucceeds(
      testEnv
        .authenticatedContext(OWNER_UID)
        .firestore()
        .collection('tripMembershipAcceptances')
        .where('tripId', '==', TRIP_ID)
        .where('uid', '==', MEMBER_UID)
        .get()
    );
  });

  it('an outsider cannot query another uid\'s acceptances', async () => {
    await assertFails(
      testEnv
        .authenticatedContext(OUTSIDER_UID)
        .firestore()
        .collection('tripMembershipAcceptances')
        .where('tripId', '==', TRIP_ID)
        .where('uid', '==', MEMBER_UID)
        .get()
    );
  });
});

describe('firestore.rules: tripMembershipAcceptances - update and delete are always closed', () => {
  beforeEach(async () => {
    await seedTripMembershipAcceptance(testEnv, ACCEPTANCE_ID, validAcceptanceData());
  });

  it('the accepting member cannot update their own acceptance record', async () => {
    await assertFails(
      tripMembershipAcceptanceDoc(asMember(), ACCEPTANCE_ID).update({ acceptedTermsVersion: 2 })
    );
  });

  it('the Trip owner cannot update it either', async () => {
    await assertFails(
      tripMembershipAcceptanceDoc(asOwner(), ACCEPTANCE_ID).update({ acceptedTermsVersion: 2 })
    );
  });

  it('the accepting member cannot delete their own acceptance record', async () => {
    await assertFails(tripMembershipAcceptanceDoc(asMember(), ACCEPTANCE_ID).delete());
  });
});
