// Comprehensive Firestore rules coverage for the
// `tripMembershipAcceptances` collection (Checkpoint 5A, hardened by
// 5A.1), run against the local Firestore emulator using the real
// firestore.rules file (never weakened to make a test pass).
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
  TRIP_ID,
  TERMS_ID,
  acceptanceId,
  validAcceptanceData,
  seedTripMembershipAcceptance,
  tripMembershipAcceptanceDoc,
} = require('./helpers/tripMembershipAcceptances');

const ACCEPTANCE_ID = acceptanceId(TRIP_ID, MEMBER_UID, TERMS_ID);
const STALE_TERMS_ID = 'test-terms-v1-stale';
const CURRENT_TERMS_ID = 'test-terms-v2-current';

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
  // Checkpoint 5A.1 (item 3): memberIds contains ONLY the owner. MEMBER_UID
  // is an invited-but-never-financially-authorized user throughout this
  // entire file - every test below that calls it "member" is testing the
  // "accepted terms, not a current Trip member" state Checkpoint 5A is
  // actually supposed to prove is possible.
  await seedTrip(testEnv, TRIP_ID, validTripData({ memberIds: [OWNER_UID] }));
  await seedTripTerms(testEnv, TERMS_ID, validTripTermsData());
  await seedTripTermsCurrent(testEnv, TRIP_ID, { currentTermsDocId: TERMS_ID, currentVersion: 1 });
  // The member accepting terms must already hold an ACTIONABLE invitation
  // record for this Trip (pending+unexpired, or accepted) - see
  // firestore.rules' own hasActionableTripInvitationRecord comment.
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

describe('firestore.rules: tripMembershipAcceptances - create', () => {
  it('a member with a real invitation record can record accepting the current terms', async () => {
    await assertSucceeds(
      tripMembershipAcceptanceDoc(asMember(), ACCEPTANCE_ID).set({
        ...validAcceptanceData(),
        acceptedAt: serverTimestamp(),
      })
    );
  });

  it('cannot record an acceptance for a different uid than the caller', async () => {
    await assertFails(
      tripMembershipAcceptanceDoc(asOwner(), ACCEPTANCE_ID).set({
        ...validAcceptanceData(),
        acceptedAt: serverTimestamp(),
      })
    );
  });

  it('cannot forge an arbitrary acceptedAt instead of server time', async () => {
    await assertFails(
      tripMembershipAcceptanceDoc(asMember(), ACCEPTANCE_ID).set({
        ...validAcceptanceData(),
        acceptedAt: Timestamp.fromDate(new Date('2020-01-01')),
      })
    );
  });

  it('cannot reference a termsDocId that does not exist', async () => {
    const badId = acceptanceId(TRIP_ID, MEMBER_UID, 'no-such-terms');
    await assertFails(
      tripMembershipAcceptanceDoc(asMember(), badId).set({
        ...validAcceptanceData({ termsDocId: 'no-such-terms' }),
        acceptedAt: serverTimestamp(),
      })
    );
  });

  it('cannot claim a version that does not match the referenced TripTerms document', async () => {
    await assertFails(
      tripMembershipAcceptanceDoc(asMember(), ACCEPTANCE_ID).set({
        ...validAcceptanceData({ acceptedTermsVersion: 99 }),
        acceptedAt: serverTimestamp(),
      })
    );
  });

  it('cannot claim a tripId that does not match the referenced TripTerms document', async () => {
    await seedTrip(testEnv, 'other-trip', validTripData({ ownerId: OWNER_UID, memberIds: [OWNER_UID] }));
    const badId = acceptanceId('other-trip', MEMBER_UID, TERMS_ID);
    await assertFails(
      tripMembershipAcceptanceDoc(asMember(), badId).set({
        ...validAcceptanceData({ tripId: 'other-trip' }),
        acceptedAt: serverTimestamp(),
      })
    );
  });

  it('cannot create an acceptance record without any invitation record for that Trip', async () => {
    const uninvitedUid = 'uninvited-uid';
    const id = acceptanceId(TRIP_ID, uninvitedUid, TERMS_ID);
    await assertFails(
      testEnv
        .authenticatedContext(uninvitedUid)
        .firestore()
        .collection('tripMembershipAcceptances')
        .doc(id)
        .set({
          ...validAcceptanceData({ uid: uninvitedUid }),
          acceptedAt: serverTimestamp(),
        })
    );
  });

  it('the document id must match the exact {tripId}_{uid}_{termsDocId} pattern', async () => {
    await assertFails(
      tripMembershipAcceptanceDoc(asMember(), 'wrong-id-shape').set({
        ...validAcceptanceData(),
        acceptedAt: serverTimestamp(),
      })
    );
  });

  it('an arbitrary extra field is rejected', async () => {
    await assertFails(
      tripMembershipAcceptanceDoc(asMember(), ACCEPTANCE_ID).set({
        ...validAcceptanceData(),
        acceptedAt: serverTimestamp(),
        notes: 'hi',
      })
    );
  });

  it('unauthenticated user cannot create an acceptance record', async () => {
    await assertFails(
      tripMembershipAcceptanceDoc(asUnauthenticated(), ACCEPTANCE_ID).set({
        ...validAcceptanceData(),
        acceptedAt: serverTimestamp(),
      })
    );
  });
});

// Checkpoint 5A.1, item 3: the fixture above seeds `memberIds: [OWNER_UID]`
// only - MEMBER_UID is never a current Trip member anywhere in this file.
// These tests make that separation an explicit, positive assertion rather
// than an implicit side effect of the fixture.
describe('firestore.rules: tripMembershipAcceptances - proves terms acceptance is NOT financial membership', () => {
  it('succeeds even though the accepting uid is not in trips.memberIds', async () => {
    const tripData = await readTripUnsafe(TRIP_ID);
    expect(tripData.memberIds).toEqual([OWNER_UID]);

    await assertSucceeds(
      tripMembershipAcceptanceDoc(asMember(), ACCEPTANCE_ID).set({
        ...validAcceptanceData(),
        acceptedAt: serverTimestamp(),
      })
    );
  });

  it('creating the acceptance record does not modify trips.memberIds', async () => {
    await tripMembershipAcceptanceDoc(asMember(), ACCEPTANCE_ID).set({
      ...validAcceptanceData(),
      acceptedAt: serverTimestamp(),
    });
    const tripData = await readTripUnsafe(TRIP_ID);
    expect(tripData.memberIds).toEqual([OWNER_UID]);
  });

  it('the accepting uid still cannot read this Trip directly (not a current member)', async () => {
    await tripMembershipAcceptanceDoc(asMember(), ACCEPTANCE_ID).set({
      ...validAcceptanceData(),
      acceptedAt: serverTimestamp(),
    });
    await assertFails(asMember().firestore().collection('trips').doc(TRIP_ID).get());
  });

  it('the accepting uid gains no read access to this Trip\'s savingsTransactions', async () => {
    await tripMembershipAcceptanceDoc(asMember(), ACCEPTANCE_ID).set({
      ...validAcceptanceData(),
      acceptedAt: serverTimestamp(),
    });
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await context.firestore().collection('savingsTransactions').doc('txn-1').set({
        resourceType: 'trip',
        resourceId: TRIP_ID,
        memberUid: OWNER_UID,
        recordedBy: OWNER_UID,
        amountMinor: 1000,
        currency: 'USD',
        type: 'contribution',
        createdAt: new Date(),
        reversalOf: null,
      });
    });
    await assertFails(
      asMember().firestore().collection('savingsTransactions').doc('txn-1').get()
    );
  });

  it('the accepting uid gains no write authorization under recordSavingsTransaction\'s own membership model', async () => {
    // recordSavingsTransaction's trusted backend (not exercised directly
    // here - see functions/test/recordSavingsTransactionCore.ts for its
    // own full coverage) derives authorization solely from
    // trips.memberIds/ownerId, read fresh server-side. Proving MEMBER_UID
    // is absent from memberIds even after accepting terms (the assertion
    // above) is the complete proof that nothing in THIS checkpoint could
    // ever grant that authorization - there is no second code path for
    // it to come from.
    await tripMembershipAcceptanceDoc(asMember(), ACCEPTANCE_ID).set({
      ...validAcceptanceData(),
      acceptedAt: serverTimestamp(),
    });
    const tripData = await readTripUnsafe(TRIP_ID);
    expect(tripData.memberIds.includes(MEMBER_UID)).toBe(false);
    expect(tripData.ownerId).not.toBe(MEMBER_UID);
  });
});

// Checkpoint 5A.1, item 4: which invitation statuses may be used to
// create a fresh acceptance record.
describe('firestore.rules: tripMembershipAcceptances - invitation status gating', () => {
  function reseedInvitation(overrides) {
    return seedTripInvitation(
      testEnv,
      invitationId(TRIP_ID, MEMBER_UID),
      validInvitationData({ inviteeUid: MEMBER_UID, ...overrides })
    );
  }

  it('pending + unexpired: succeeds (already covered by the default fixture, asserted explicitly here)', async () => {
    await reseedInvitation({
      status: 'pending',
      expiresAt: Timestamp.fromMillis(Date.now() + 60 * 60 * 1000),
    });
    await assertSucceeds(
      tripMembershipAcceptanceDoc(asMember(), ACCEPTANCE_ID).set({
        ...validAcceptanceData(),
        acceptedAt: serverTimestamp(),
      })
    );
  });

  it('pending + expired: fails', async () => {
    await reseedInvitation({
      status: 'pending',
      expiresAt: Timestamp.fromMillis(Date.now() - 60 * 60 * 1000),
    });
    await assertFails(
      tripMembershipAcceptanceDoc(asMember(), ACCEPTANCE_ID).set({
        ...validAcceptanceData(),
        acceptedAt: serverTimestamp(),
      })
    );
  });

  it('accepted: succeeds (supports "invitation accepted -> terms acceptance" ordering)', async () => {
    await reseedInvitation({ status: 'accepted', respondedAt: Timestamp.now() });
    await assertSucceeds(
      tripMembershipAcceptanceDoc(asMember(), ACCEPTANCE_ID).set({
        ...validAcceptanceData(),
        acceptedAt: serverTimestamp(),
      })
    );
  });

  it('declined: fails', async () => {
    await reseedInvitation({ status: 'declined', respondedAt: Timestamp.now() });
    await assertFails(
      tripMembershipAcceptanceDoc(asMember(), ACCEPTANCE_ID).set({
        ...validAcceptanceData(),
        acceptedAt: serverTimestamp(),
      })
    );
  });

  it('cancelled: fails', async () => {
    await reseedInvitation({ status: 'cancelled', respondedAt: Timestamp.now() });
    await assertFails(
      tripMembershipAcceptanceDoc(asMember(), ACCEPTANCE_ID).set({
        ...validAcceptanceData(),
        acceptedAt: serverTimestamp(),
      })
    );
  });
});

// Checkpoint 5A.1, item 6: acceptance must reference the Trip's
// CURRENTLY authoritative terms document, per tripTermsCurrent/{tripId}
// - never a stale historical version.
describe('firestore.rules: tripMembershipAcceptances - current-vs-stale terms', () => {
  beforeEach(async () => {
    await seedTripTerms(testEnv, STALE_TERMS_ID, validTripTermsData({ version: 1 }));
    await seedTripTerms(testEnv, CURRENT_TERMS_ID, validTripTermsData({ version: 2 }));
    await seedTripTermsCurrent(testEnv, TRIP_ID, {
      currentTermsDocId: CURRENT_TERMS_ID,
      currentVersion: 2,
    });
  });

  it('accepting the current version succeeds', async () => {
    const id = acceptanceId(TRIP_ID, MEMBER_UID, CURRENT_TERMS_ID);
    await assertSucceeds(
      tripMembershipAcceptanceDoc(asMember(), id).set({
        tripId: TRIP_ID,
        uid: MEMBER_UID,
        termsDocId: CURRENT_TERMS_ID,
        acceptedTermsVersion: 2,
        acceptedAt: serverTimestamp(),
      })
    );
  });

  it('accepting a stale (superseded) version fails even though that version genuinely exists', async () => {
    const id = acceptanceId(TRIP_ID, MEMBER_UID, STALE_TERMS_ID);
    await assertFails(
      tripMembershipAcceptanceDoc(asMember(), id).set({
        tripId: TRIP_ID,
        uid: MEMBER_UID,
        termsDocId: STALE_TERMS_ID,
        acceptedTermsVersion: 1,
        acceptedAt: serverTimestamp(),
      })
    );
  });

  it('fails outright if no tripTermsCurrent pointer exists at all for this Trip', async () => {
    await testEnv.withSecurityRulesDisabled((context) =>
      context.firestore().collection('tripTermsCurrent').doc(TRIP_ID).delete()
    );
    const id = acceptanceId(TRIP_ID, MEMBER_UID, CURRENT_TERMS_ID);
    await assertFails(
      tripMembershipAcceptanceDoc(asMember(), id).set({
        tripId: TRIP_ID,
        uid: MEMBER_UID,
        termsDocId: CURRENT_TERMS_ID,
        acceptedTermsVersion: 2,
        acceptedAt: serverTimestamp(),
      })
    );
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
