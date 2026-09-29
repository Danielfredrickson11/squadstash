// Firestore rules coverage for the `tripSettlements` collection
// (Checkpoint 4E.2, approved docs/audits/
// TRIP_BALANCES_SETTLEMENTS_PREFLIGHT_2026-09-28.md §10/§13, as hardened
// by 4E.0A). Run against the local Firestore emulator using the real
// firestore.rules file (never weakened to make a test pass).
//
// Client CREATE/UPDATE/DELETE are permanently closed - the trusted
// recordTripSettlement/reverseTripSettlement Cloud Functions (Admin SDK,
// which bypass these rules) are the sole write path. Read fixtures below
// are seeded exclusively via the rules-disabled admin context, matching
// this file's own persisted shape as written by
// functions/src/callables/recordTripSettlement.ts.
//
// Mirrors tests/firestore-rules/tripExpenses.rules.test.js's own
// structure/conventions exactly - reuses the existing trips helper to
// seed parent Trips, stays self-contained (firestore.rules and this test
// file only, per this checkpoint's scope).
const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { Timestamp, serverTimestamp } = require('firebase/firestore');
const { createTestEnv } = require('./helpers/testEnv');
const {
  OWNER_UID,
  MEMBER_UID,
  OUTSIDER_UID,
  TRIP_ID,
  validTripData,
  seedTrip,
} = require('./helpers/trips');

// A second, fully independent Trip/actor pair, used only for the
// "document id conveys no authority" isolation test - OWNER_B_UID and
// MEMBER_B_UID have no relationship whatsoever to TRIP_ID.
const OWNER_B_UID = 'owner-b-uid';
const MEMBER_B_UID = 'member-b-uid';
const TRIP_B_ID = 'test-trip-b';

// Checkpoint 4E.2A hardening: the write-lockdown role matrix below needs
// FIVE genuinely distinct identities, never reusing one uid for two
// different roles (the original draft accidentally tested "recipient"
// and "owner" as the same OWNER_UID, and "debtor" and "ordinary member"
// as the same MEMBER_UID, which made those pairs of tests prove nothing
// beyond what the other one already did).
const DEBTOR_UID = 'debtor-uid'; // the canonical Settlement's own fromUid
const RECIPIENT_UID = 'recipient-uid'; // the canonical Settlement's own toUid
const ORDINARY_MEMBER_UID = 'ordinary-member-uid'; // neither fromUid nor toUid

const SETTLEMENT_ID = 'test-settlement';

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
function asUnauthenticated() {
  return testEnv.unauthenticatedContext();
}
function asDebtor() {
  return testEnv.authenticatedContext(DEBTOR_UID);
}
function asRecipient() {
  return testEnv.authenticatedContext(RECIPIENT_UID);
}
function asOrdinaryMember() {
  return testEnv.authenticatedContext(ORDINARY_MEMBER_UID);
}

function settlementDoc(context, id) {
  return context.firestore().collection('tripSettlements').doc(id);
}
function settlementsCollection(context) {
  return context.firestore().collection('tripSettlements');
}

// Seeds bypassing security rules entirely - the only way to seed a
// tripSettlements document now that client create is permanently closed.
async function seedSettlement(id, data) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().collection('tripSettlements').doc(id).set(data);
  });
}

// Shape a real recordTripSettlement call would persist (see
// functions/src/callables/recordTripSettlement.ts) - used only to seed
// read fixtures and to construct otherwise-perfectly-valid create/update
// attempts that must still be denied.
function validSettlementData(overrides = {}) {
  return {
    tripId: TRIP_ID,
    fromUid: MEMBER_UID,
    toUid: OWNER_UID,
    amountMinor: 4000,
    currency: 'USD',
    method: 'venmo',
    createdAt: serverTimestamp(),
    createdBy: OWNER_UID,
    status: 'active',
    creationRequest: {
      tripId: TRIP_ID,
      fromUid: MEMBER_UID,
      toUid: OWNER_UID,
      amountMinor: 4000,
      currency: 'USD',
      method: 'venmo',
      note: null,
      occurredAtInstantMs: null,
    },
    ...overrides,
  };
}

describe('firestore.rules: tripSettlements - reads', () => {
  beforeEach(async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
  });

  it('1. current Trip owner can get a Settlement', async () => {
    await seedSettlement(SETTLEMENT_ID, validSettlementData());
    await assertSucceeds(settlementDoc(asOwner(), SETTLEMENT_ID).get());
  });

  it('2. current Trip member can get a Settlement', async () => {
    await seedSettlement(SETTLEMENT_ID, validSettlementData());
    await assertSucceeds(settlementDoc(asMember(), SETTLEMENT_ID).get());
  });

  it('3. current member can query tripSettlements scoped to their Trip by tripId', async () => {
    await seedSettlement(SETTLEMENT_ID, validSettlementData());
    const snap = await assertSucceeds(
      settlementsCollection(asMember()).where('tripId', '==', TRIP_ID).get()
    );
    expect(snap.docs.map((d) => d.id)).toContain(SETTLEMENT_ID);
  });

  it('4. outsider cannot get a Settlement', async () => {
    await seedSettlement(SETTLEMENT_ID, validSettlementData());
    await assertFails(settlementDoc(asOutsider(), SETTLEMENT_ID).get());
  });

  it('5. outsider cannot perform the Trip-scoped query', async () => {
    await seedSettlement(SETTLEMENT_ID, validSettlementData());
    await assertFails(
      settlementsCollection(asOutsider()).where('tripId', '==', TRIP_ID).get()
    );
  });

  it('6. unauthenticated caller cannot get a Settlement', async () => {
    await seedSettlement(SETTLEMENT_ID, validSettlementData());
    await assertFails(settlementDoc(asUnauthenticated(), SETTLEMENT_ID).get());
  });

  it('7. a removed former member cannot get the Settlement', async () => {
    await seedSettlement(SETTLEMENT_ID, validSettlementData());
    await seedTrip(testEnv, TRIP_ID, validTripData({ memberIds: [OWNER_UID] }));
    await assertFails(settlementDoc(asMember(), SETTLEMENT_ID).get());
  });

  it('8. a current member can still read Settlement history after the Trip is archived', async () => {
    await seedTrip(
      testEnv,
      TRIP_ID,
      validTripData({ archivedAt: Timestamp.now(), archivedBy: OWNER_UID })
    );
    await seedSettlement(SETTLEMENT_ID, validSettlementData());
    await assertSucceeds(settlementDoc(asMember(), SETTLEMENT_ID).get());
    const snap = await assertSucceeds(
      settlementsCollection(asMember()).where('tripId', '==', TRIP_ID).get()
    );
    expect(snap.docs.map((d) => d.id)).toContain(SETTLEMENT_ID);
  });

  it('9. document id conveys no authority - access follows the tripId FIELD only', async () => {
    await seedTrip(
      testEnv,
      TRIP_B_ID,
      validTripData({ ownerId: OWNER_B_UID, memberIds: [OWNER_B_UID, MEMBER_B_UID] })
    );
    // Document id LOOKS like it belongs to Trip A, but its tripId field
    // actually names Trip B.
    const lookalikeId = `${TRIP_ID}-settlement-1`;
    await seedSettlement(lookalikeId, validSettlementData({ tripId: TRIP_B_ID }));

    // A Trip A member/owner (not a Trip B member/owner) must be denied.
    await assertFails(settlementDoc(asMember(), lookalikeId).get());
    await assertFails(settlementDoc(asOwner(), lookalikeId).get());
    // A Trip B member must be allowed - the tripId field is what governs
    // access, never the document's own id string.
    await assertSucceeds(settlementDoc(asMemberB(), lookalikeId).get());
  });

  it('10. a Settlement whose referenced Trip does not exist is unreadable', async () => {
    await seedSettlement(
      SETTLEMENT_ID,
      validSettlementData({ tripId: 'no-such-trip' })
    );
    await assertFails(settlementDoc(asOwner(), SETTLEMENT_ID).get());
    await assertFails(settlementDoc(asMember(), SETTLEMENT_ID).get());
  });

  it('11. a Settlement with a malformed/non-string tripId is unreadable', async () => {
    await seedSettlement(SETTLEMENT_ID, validSettlementData({ tripId: 12345 }));
    await assertFails(settlementDoc(asOwner(), SETTLEMENT_ID).get());
    await assertFails(settlementDoc(asMember(), SETTLEMENT_ID).get());
  });

  it('malformed (non-list) memberIds fails closed for non-owner access but does not lock out the owner', async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData({ memberIds: 'not-a-list' }));
    await seedSettlement(SETTLEMENT_ID, validSettlementData());

    await assertFails(settlementDoc(asMember(), SETTLEMENT_ID).get());
    await assertFails(settlementDoc(asOutsider(), SETTLEMENT_ID).get());
    await assertSucceeds(settlementDoc(asOwner(), SETTLEMENT_ID).get());
  });
});

describe('firestore.rules: tripSettlements - query isolation (Rules are not filters)', () => {
  beforeEach(async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
    await seedTrip(
      testEnv,
      TRIP_B_ID,
      validTripData({ ownerId: OWNER_B_UID, memberIds: [OWNER_B_UID, MEMBER_B_UID] })
    );
    await seedSettlement(SETTLEMENT_ID, validSettlementData());
    // A second Settlement belonging to Trip B, naming MEMBER_UID (Trip
    // A's member) as fromUid even though MEMBER_UID has no access to
    // Trip B - proves naming alone never grants a query result across
    // the Trip boundary.
    await seedSettlement(
      'settlement-b',
      validSettlementData({ tripId: TRIP_B_ID, fromUid: MEMBER_UID })
    );
  });

  it('member A: where(tripId == TripA) succeeds and returns only TripA documents', async () => {
    const snap = await assertSucceeds(
      settlementsCollection(asMember()).where('tripId', '==', TRIP_ID).get()
    );
    expect(snap.docs.map((d) => d.id)).toEqual([SETTLEMENT_ID]);
  });

  it('member A: an unscoped tripSettlements collection query is denied', async () => {
    await assertFails(settlementsCollection(asMember()).get());
  });

  it("member A: where('tripId', 'in', [TripA, TripB]) is denied - the query itself could return TripB's data", async () => {
    await assertFails(
      settlementsCollection(asMember())
        .where('tripId', 'in', [TRIP_ID, TRIP_B_ID])
        .get()
    );
  });

  it('member A: querying only by fromUid, with no tripId constraint, is denied even though a result happens to name them', async () => {
    await assertFails(
      settlementsCollection(asMember()).where('fromUid', '==', MEMBER_UID).get()
    );
  });

  it('a member removed from Trip A can no longer perform the Trip-scoped query', async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData({ memberIds: [OWNER_UID] }));
    await assertFails(
      settlementsCollection(asMember()).where('tripId', '==', TRIP_ID).get()
    );
  });
});

describe('firestore.rules: tripSettlements - direct client writes are denied for every role', () => {
  // Checkpoint 4E.2A: five genuinely distinct identities - the Trip owner,
  // the canonical Settlement's own debtor (fromUid) and recipient (toUid),
  // an ordinary member who is neither, and an outsider who is not a
  // member at all. No uid stands in for more than one role, so each
  // denial below proves something the others do not.
  beforeEach(async () => {
    await seedTrip(
      testEnv,
      TRIP_ID,
      validTripData({
        memberIds: [OWNER_UID, DEBTOR_UID, RECIPIENT_UID, ORDINARY_MEMBER_UID],
      })
    );
  });

  // The one canonical Settlement used by every case below: fromUid is the
  // debtor, toUid is the recipient.
  function canonicalSettlementData(overrides = {}) {
    return validSettlementData({
      fromUid: DEBTOR_UID,
      toUid: RECIPIENT_UID,
      createdBy: RECIPIENT_UID,
      creationRequest: {
        tripId: TRIP_ID,
        fromUid: DEBTOR_UID,
        toUid: RECIPIENT_UID,
        amountMinor: 4000,
        currency: 'USD',
        method: 'venmo',
        note: null,
        occurredAtInstantMs: null,
      },
      ...overrides,
    });
  }

  // --- CREATE: denied for all five roles ---

  it('create denied for the Trip owner', async () => {
    await assertFails(
      settlementDoc(asOwner(), 'attempt-owner').set(canonicalSettlementData())
    );
  });

  it('create denied for the debtor (fromUid)', async () => {
    await assertFails(
      settlementDoc(asDebtor(), 'attempt-debtor').set(canonicalSettlementData())
    );
  });

  it('create denied for the recipient (toUid)', async () => {
    await assertFails(
      settlementDoc(asRecipient(), 'attempt-recipient').set(
        canonicalSettlementData()
      )
    );
  });

  it('create denied for an ordinary member (neither fromUid nor toUid)', async () => {
    await assertFails(
      settlementDoc(asOrdinaryMember(), 'attempt-ordinary-member').set(
        canonicalSettlementData()
      )
    );
  });

  it('create denied for an outsider', async () => {
    await assertFails(
      settlementDoc(asOutsider(), 'attempt-outsider').set(
        canonicalSettlementData()
      )
    );
  });

  // --- UPDATE: denied for all five roles ---

  it('update denied for the Trip owner', async () => {
    await seedSettlement(SETTLEMENT_ID, canonicalSettlementData());
    await assertFails(
      settlementDoc(asOwner(), SETTLEMENT_ID).update({ amountMinor: 1 })
    );
  });

  it('update denied for the debtor (fromUid)', async () => {
    await seedSettlement(SETTLEMENT_ID, canonicalSettlementData());
    await assertFails(
      settlementDoc(asDebtor(), SETTLEMENT_ID).update({ amountMinor: 1 })
    );
  });

  it('update denied for the recipient (toUid)', async () => {
    await seedSettlement(SETTLEMENT_ID, canonicalSettlementData());
    await assertFails(
      settlementDoc(asRecipient(), SETTLEMENT_ID).update({ status: 'reversed' })
    );
  });

  it('update denied for an ordinary member (neither fromUid nor toUid)', async () => {
    await seedSettlement(SETTLEMENT_ID, canonicalSettlementData());
    await assertFails(
      settlementDoc(asOrdinaryMember(), SETTLEMENT_ID).update({ amountMinor: 1 })
    );
  });

  it('update denied for an outsider', async () => {
    await seedSettlement(SETTLEMENT_ID, canonicalSettlementData());
    await assertFails(
      settlementDoc(asOutsider(), SETTLEMENT_ID).update({ amountMinor: 1 })
    );
  });

  // --- DELETE: denied for all five roles ---

  it('delete denied for the Trip owner', async () => {
    await seedSettlement(SETTLEMENT_ID, canonicalSettlementData());
    await assertFails(settlementDoc(asOwner(), SETTLEMENT_ID).delete());
  });

  it('delete denied for the debtor (fromUid)', async () => {
    await seedSettlement(SETTLEMENT_ID, canonicalSettlementData());
    await assertFails(settlementDoc(asDebtor(), SETTLEMENT_ID).delete());
  });

  it('delete denied for the recipient (toUid)', async () => {
    await seedSettlement(SETTLEMENT_ID, canonicalSettlementData());
    await assertFails(settlementDoc(asRecipient(), SETTLEMENT_ID).delete());
  });

  it('delete denied for an ordinary member (neither fromUid nor toUid)', async () => {
    await seedSettlement(SETTLEMENT_ID, canonicalSettlementData());
    await assertFails(
      settlementDoc(asOrdinaryMember(), SETTLEMENT_ID).delete()
    );
  });

  it('delete denied for an outsider', async () => {
    await seedSettlement(SETTLEMENT_ID, canonicalSettlementData());
    await assertFails(settlementDoc(asOutsider(), SETTLEMENT_ID).delete());
  });
});
