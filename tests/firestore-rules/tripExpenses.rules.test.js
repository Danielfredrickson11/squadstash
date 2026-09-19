// Firestore rules coverage for the `tripExpenses`/`tripExpenseSplits`
// collections (Checkpoint 4C.2B, approved docs/audits/
// TRIP_OUT_OF_POCKET_EXPENSE_PERSISTENCE_PREFLIGHT_2026-09-15.md as
// hardened by 4C.1A/4C.1B). Run against the local Firestore emulator
// using the real firestore.rules file (never weakened to make a test
// pass - see helpers/trips.js).
//
// Client CREATE/UPDATE/DELETE are permanently closed for both
// collections - the trusted recordTripExpense Cloud Function (Admin SDK,
// which bypasses these rules) is the sole write path. Read fixtures below
// are seeded exclusively via the rules-disabled admin context, matching
// this file's own persisted shape as written by
// functions/src/callables/recordTripExpense.ts.
//
// Reuses the existing trips helper to seed parent Trips - no shared
// helper file is modified; this file stays self-contained per this
// checkpoint's scope (firestore.rules and this test file only), matching
// savingsTransactions.rules.test.js's own precedent exactly.
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
// "document id conveys no authority" isolation test (§12.A) - OWNER_B_UID
// and MEMBER_B_UID have no relationship whatsoever to TRIP_ID.
const OWNER_B_UID = 'owner-b-uid';
const MEMBER_B_UID = 'member-b-uid';
const TRIP_B_ID = 'test-trip-b';

const EXPENSE_ID = 'test-expense';
const SPLIT_ID = 'test-split';

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

function expenseDoc(context, id) {
  return context.firestore().collection('tripExpenses').doc(id);
}
function expensesCollection(context) {
  return context.firestore().collection('tripExpenses');
}
function splitDoc(context, id) {
  return context.firestore().collection('tripExpenseSplits').doc(id);
}
function splitsCollection(context) {
  return context.firestore().collection('tripExpenseSplits');
}

// Seeds bypassing security rules entirely - the only way to seed a
// tripExpenses/tripExpenseSplits document now that client create is
// permanently closed.
async function seedExpense(id, data) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().collection('tripExpenses').doc(id).set(data);
  });
}
async function seedSplit(id, data) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().collection('tripExpenseSplits').doc(id).set(data);
  });
}

// Shape a real recordTripExpense call would persist (see
// functions/src/callables/recordTripExpense.ts) - used only to seed read
// fixtures and to construct otherwise-perfectly-valid create/update
// attempts that must still be denied.
function validExpenseData(overrides = {}) {
  return {
    tripId: TRIP_ID,
    payerUid: MEMBER_UID,
    createdBy: MEMBER_UID,
    amountMinor: 9000,
    currency: 'USD',
    description: 'Cabin rental',
    splitStrategy: 'equal',
    paymentSource: 'member_out_of_pocket',
    status: 'active',
    createdAt: serverTimestamp(),
    creationRequest: {
      tripId: TRIP_ID,
      payerUid: MEMBER_UID,
      amountMinor: 9000,
      currency: 'USD',
      description: 'Cabin rental',
      category: null,
      splitStrategy: 'equal',
      participants: [{ uid: OWNER_UID }, { uid: MEMBER_UID }],
      paymentSource: 'member_out_of_pocket',
      occurredAtInstantMs: null,
    },
    ...overrides,
  };
}

function validSplitData(overrides = {}) {
  return {
    expenseId: EXPENSE_ID,
    tripId: TRIP_ID,
    userId: MEMBER_UID,
    amountMinor: 4500,
    createdAt: serverTimestamp(),
    ...overrides,
  };
}

describe('firestore.rules: tripExpenses - reads', () => {
  beforeEach(async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
  });

  it('1. current Trip member can get an Expense', async () => {
    await seedExpense(EXPENSE_ID, validExpenseData());
    await assertSucceeds(expenseDoc(asMember(), EXPENSE_ID).get());
  });

  it('2. Trip owner can get an Expense', async () => {
    await seedExpense(EXPENSE_ID, validExpenseData());
    await assertSucceeds(expenseDoc(asOwner(), EXPENSE_ID).get());
  });

  it('3. outsider cannot get an Expense', async () => {
    await seedExpense(EXPENSE_ID, validExpenseData());
    await assertFails(expenseDoc(asOutsider(), EXPENSE_ID).get());
  });

  it('4. unauthenticated caller cannot get an Expense', async () => {
    await seedExpense(EXPENSE_ID, validExpenseData());
    await assertFails(expenseDoc(asUnauthenticated(), EXPENSE_ID).get());
  });

  it('5. current member can get an Expense after the Trip is archived', async () => {
    await seedTrip(
      testEnv,
      TRIP_ID,
      validTripData({ archivedAt: Timestamp.now(), archivedBy: OWNER_UID })
    );
    await seedExpense(EXPENSE_ID, validExpenseData());
    await assertSucceeds(expenseDoc(asMember(), EXPENSE_ID).get());
  });

  it('6. a removed former member cannot get the Expense', async () => {
    await seedExpense(EXPENSE_ID, validExpenseData());
    // Remove MEMBER_UID from the Trip roster after the Expense exists.
    await seedTrip(testEnv, TRIP_ID, validTripData({ memberIds: [OWNER_UID] }));
    await assertFails(expenseDoc(asMember(), EXPENSE_ID).get());
  });

  it('7./C. the original createdBy, no longer a current Trip member, cannot get the Expense merely because they created it', async () => {
    // MEMBER_UID both created this Expense (createdBy) AND paid it
    // (payerUid) - neither fact grants read access once they are no
    // longer a current Trip member. Access follows CURRENT Trip
    // membership only, never createdBy/payerUid (preflight §13/§4).
    await seedExpense(EXPENSE_ID, validExpenseData());
    await seedTrip(testEnv, TRIP_ID, validTripData({ memberIds: [OWNER_UID] }));
    await assertFails(expenseDoc(asMember(), EXPENSE_ID).get());
  });

  it('8./E. an Expense whose referenced Trip does not exist is unreadable', async () => {
    await seedExpense(EXPENSE_ID, validExpenseData({ tripId: 'no-such-trip' }));
    await assertFails(expenseDoc(asOwner(), EXPENSE_ID).get());
    await assertFails(expenseDoc(asMember(), EXPENSE_ID).get());
  });

  it('9. an Expense with a malformed/non-string tripId is unreadable', async () => {
    await seedExpense(EXPENSE_ID, validExpenseData({ tripId: 12345 }));
    await assertFails(expenseDoc(asOwner(), EXPENSE_ID).get());
    await assertFails(expenseDoc(asMember(), EXPENSE_ID).get());
  });
});

describe('firestore.rules: tripExpenses - list/query', () => {
  beforeEach(async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
    await seedExpense(EXPENSE_ID, validExpenseData());
  });

  it('10. current member can query tripExpenses scoped to their Trip by tripId', async () => {
    const snap = await assertSucceeds(
      expensesCollection(asMember()).where('tripId', '==', TRIP_ID).get()
    );
    expect(snap.docs.map((d) => d.id)).toContain(EXPENSE_ID);
  });

  it('11. outsider cannot perform the same Trip-scoped query', async () => {
    await assertFails(
      expensesCollection(asOutsider()).where('tripId', '==', TRIP_ID).get()
    );
  });

  it('12. owner can perform the Trip-scoped query', async () => {
    const snap = await assertSucceeds(
      expensesCollection(asOwner()).where('tripId', '==', TRIP_ID).get()
    );
    expect(snap.docs.map((d) => d.id)).toContain(EXPENSE_ID);
  });

  it('13. a member of an archived Trip can still perform the Trip-scoped query', async () => {
    await seedTrip(
      testEnv,
      TRIP_ID,
      validTripData({ archivedAt: Timestamp.now(), archivedBy: OWNER_UID })
    );
    const snap = await assertSucceeds(
      expensesCollection(asMember()).where('tripId', '==', TRIP_ID).get()
    );
    expect(snap.docs.map((d) => d.id)).toContain(EXPENSE_ID);
  });
});

describe('firestore.rules: tripExpenses - direct client writes are denied', () => {
  beforeEach(async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
  });

  it('24. create denied for member', async () => {
    await assertFails(
      expenseDoc(asMember(), 'attempt-1').set(validExpenseData())
    );
  });

  it('25. create denied for owner', async () => {
    await assertFails(
      expenseDoc(asOwner(), 'attempt-2').set(validExpenseData())
    );
  });

  it('create denied for outsider', async () => {
    await assertFails(
      expenseDoc(asOutsider(), 'attempt-3').set(validExpenseData())
    );
  });

  it('26. update denied for member', async () => {
    await seedExpense(EXPENSE_ID, validExpenseData());
    await assertFails(
      expenseDoc(asMember(), EXPENSE_ID).update({ amountMinor: 1 })
    );
  });

  it('27. update denied for owner', async () => {
    await seedExpense(EXPENSE_ID, validExpenseData());
    await assertFails(
      expenseDoc(asOwner(), EXPENSE_ID).update({ amountMinor: 1 })
    );
  });

  it('28. delete denied for member', async () => {
    await seedExpense(EXPENSE_ID, validExpenseData());
    await assertFails(expenseDoc(asMember(), EXPENSE_ID).delete());
  });

  it('29. delete denied for owner', async () => {
    await seedExpense(EXPENSE_ID, validExpenseData());
    await assertFails(expenseDoc(asOwner(), EXPENSE_ID).delete());
  });
});

describe('firestore.rules: tripExpenseSplits - reads', () => {
  beforeEach(async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
  });

  it('14. current Trip member can get a Split', async () => {
    await seedSplit(SPLIT_ID, validSplitData());
    await assertSucceeds(splitDoc(asMember(), SPLIT_ID).get());
  });

  it('15. Trip owner can get a Split', async () => {
    await seedSplit(SPLIT_ID, validSplitData());
    await assertSucceeds(splitDoc(asOwner(), SPLIT_ID).get());
  });

  it('16. outsider cannot get a Split', async () => {
    await seedSplit(SPLIT_ID, validSplitData());
    await assertFails(splitDoc(asOutsider(), SPLIT_ID).get());
  });

  it('17. unauthenticated caller cannot get a Split', async () => {
    await seedSplit(SPLIT_ID, validSplitData());
    await assertFails(splitDoc(asUnauthenticated(), SPLIT_ID).get());
  });

  it('18. a member of an archived Trip can still get a Split', async () => {
    await seedTrip(
      testEnv,
      TRIP_ID,
      validTripData({ archivedAt: Timestamp.now(), archivedBy: OWNER_UID })
    );
    await seedSplit(SPLIT_ID, validSplitData());
    await assertSucceeds(splitDoc(asMember(), SPLIT_ID).get());
  });

  it('19. a removed former member cannot get the Split', async () => {
    await seedSplit(SPLIT_ID, validSplitData());
    await seedTrip(testEnv, TRIP_ID, validTripData({ memberIds: [OWNER_UID] }));
    await assertFails(splitDoc(asMember(), SPLIT_ID).get());
  });

  it('20./E. a Split whose referenced Trip does not exist is unreadable', async () => {
    await seedSplit(SPLIT_ID, validSplitData({ tripId: 'no-such-trip' }));
    await assertFails(splitDoc(asOwner(), SPLIT_ID).get());
    await assertFails(splitDoc(asMember(), SPLIT_ID).get());
  });

  it('21. a Split with a malformed/non-string tripId is unreadable', async () => {
    await seedSplit(SPLIT_ID, validSplitData({ tripId: 12345 }));
    await assertFails(splitDoc(asOwner(), SPLIT_ID).get());
    await assertFails(splitDoc(asMember(), SPLIT_ID).get());
  });

  it('B. a current Trip member may read a Split even when they are NOT its userId (shared Trip financial records, never inferred from userId)', async () => {
    // OWNER_UID reads a split whose userId is MEMBER_UID - access is
    // granted purely by Trip membership, never by userId matching the
    // caller.
    await seedSplit(SPLIT_ID, validSplitData({ userId: MEMBER_UID }));
    await assertSucceeds(splitDoc(asOwner(), SPLIT_ID).get());
  });

  it('B2. split.userId equaling the caller grants nothing on its own when the caller is not a current Trip member', async () => {
    // OUTSIDER_UID happens to be named as the split's own userId, but is
    // not a member/owner of the referenced Trip at all - must still be
    // denied. userId is never an authorization signal for this rule.
    await seedSplit(SPLIT_ID, validSplitData({ userId: OUTSIDER_UID }));
    await assertFails(splitDoc(asOutsider(), SPLIT_ID).get());
  });
});

describe('firestore.rules: tripExpenseSplits - list/query', () => {
  beforeEach(async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
    await seedSplit(SPLIT_ID, validSplitData());
  });

  it('22. current member can query Splits scoped by tripId', async () => {
    const snap = await assertSucceeds(
      splitsCollection(asMember()).where('tripId', '==', TRIP_ID).get()
    );
    expect(snap.docs.map((d) => d.id)).toContain(SPLIT_ID);
  });

  it('23. outsider cannot perform the same query', async () => {
    await assertFails(
      splitsCollection(asOutsider()).where('tripId', '==', TRIP_ID).get()
    );
  });
});

describe('firestore.rules: tripExpenseSplits - direct client writes are denied', () => {
  beforeEach(async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
  });

  it('30. create denied for member', async () => {
    await assertFails(
      splitDoc(asMember(), 'attempt-1').set(validSplitData())
    );
  });

  it('31. create denied for owner', async () => {
    await assertFails(
      splitDoc(asOwner(), 'attempt-2').set(validSplitData())
    );
  });

  it('create denied for outsider', async () => {
    await assertFails(
      splitDoc(asOutsider(), 'attempt-3').set(validSplitData())
    );
  });

  it('32. update denied for member', async () => {
    await seedSplit(SPLIT_ID, validSplitData());
    await assertFails(
      splitDoc(asMember(), SPLIT_ID).update({ amountMinor: 1 })
    );
  });

  it('33. update denied for owner', async () => {
    await seedSplit(SPLIT_ID, validSplitData());
    await assertFails(
      splitDoc(asOwner(), SPLIT_ID).update({ amountMinor: 1 })
    );
  });

  it('34. delete denied for member', async () => {
    await seedSplit(SPLIT_ID, validSplitData());
    await assertFails(splitDoc(asMember(), SPLIT_ID).delete());
  });

  it('35. delete denied for owner', async () => {
    await seedSplit(SPLIT_ID, validSplitData());
    await assertFails(splitDoc(asOwner(), SPLIT_ID).delete());
  });
});

describe('firestore.rules: tripExpenses/tripExpenseSplits - security edge cases (§12)', () => {
  it('A. document id conveys no authority - access follows the tripId FIELD only', async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
    await seedTrip(
      testEnv,
      TRIP_B_ID,
      validTripData({ ownerId: OWNER_B_UID, memberIds: [OWNER_B_UID, MEMBER_B_UID] })
    );
    // Document id LOOKS like it belongs to Trip A, but its tripId field
    // actually names Trip B.
    const lookalikeId = `${TRIP_ID}-expense-1`;
    await seedExpense(lookalikeId, validExpenseData({ tripId: TRIP_B_ID }));

    // A Trip A member (not a Trip B member/owner) must be denied.
    await assertFails(expenseDoc(asMember(), lookalikeId).get());
    await assertFails(expenseDoc(asOwner(), lookalikeId).get());
    // A Trip B member must be allowed - the tripId field is what governs
    // access, never the document's own id string.
    await assertSucceeds(expenseDoc(asMemberB(), lookalikeId).get());
  });

  it('F. malformed (non-list) memberIds fails closed for non-owner access but does not lock out the owner', async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData({ memberIds: 'not-a-list' }));
    await seedExpense(EXPENSE_ID, validExpenseData());

    // Non-owner access depends on `uid in memberIds`, which errors for a
    // malformed (non-list) memberIds value - Firestore Rules treats that
    // error as `false` for this operand, so a non-owner correctly fails
    // closed rather than being accidentally granted access.
    await assertFails(expenseDoc(asMember(), EXPENSE_ID).get());
    await assertFails(expenseDoc(asOutsider(), EXPENSE_ID).get());
    // The owner-fallback check (`ownerId == uid`) does not depend on
    // memberIds at all, so a corrupted memberIds field does not
    // accidentally lock the Trip's own owner out of their Expense
    // history - this is the intentional, documented behavior the Rules
    // implementation depends on (see firestore.rules'
    // canAccessTripById() comment).
    await assertSucceeds(expenseDoc(asOwner(), EXPENSE_ID).get());
  });
});

// Checkpoint 4C.2C §10: "Firestore Rules are not filters." A query's own
// WHERE constraints, not the rule alone, must prove every possible
// returned document belongs to a Trip the caller is authorized for -
// Firestore evaluates `list` against each candidate document using the
// same `allow get, list` predicate, so a query that could return an
// unauthorized Trip's documents is rejected outright, never silently
// filtered down to only the authorized subset.
describe('firestore.rules: tripExpenses/tripExpenseSplits - query isolation (Rules are not filters, §10)', () => {
  beforeEach(async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
    // Trip B: MEMBER_UID (Trip A's member) has NO relationship to Trip B
    // at all - neither a member nor its owner.
    await seedTrip(
      testEnv,
      TRIP_B_ID,
      validTripData({ ownerId: OWNER_B_UID, memberIds: [OWNER_B_UID, MEMBER_B_UID] })
    );
    await seedExpense(EXPENSE_ID, validExpenseData());
    await seedSplit(SPLIT_ID, validSplitData());
    // A second Expense/Split pair belonging to Trip B, with payerUid/
    // userId deliberately naming MEMBER_UID (Trip A's member) even
    // though MEMBER_UID has no access to Trip B - tests D/I below prove
    // that naming alone never grants a query result across the Trip
    // boundary.
    await seedExpense('expense-b', validExpenseData({ tripId: TRIP_B_ID, payerUid: MEMBER_UID }));
    await seedSplit('split-b', validSplitData({ tripId: TRIP_B_ID, userId: MEMBER_UID }));
  });

  it('A. member A: where(tripId == TripA) succeeds and returns only TripA documents', async () => {
    const snap = await assertSucceeds(
      expensesCollection(asMember()).where('tripId', '==', TRIP_ID).get()
    );
    expect(snap.docs.map((d) => d.id)).toEqual([EXPENSE_ID]);
  });

  it('B. member A: an unscoped tripExpenses collection query is denied', async () => {
    await assertFails(expensesCollection(asMember()).get());
  });

  it("C. member A: where('tripId', 'in', [TripA, TripB]) is denied - the query itself could return TripB's data", async () => {
    await assertFails(
      expensesCollection(asMember())
        .where('tripId', 'in', [TRIP_ID, TRIP_B_ID])
        .get()
    );
  });

  it('D. member A: querying only by payerUid, with no tripId constraint, is denied even though every result happens to name them as payer', async () => {
    await assertFails(
      expensesCollection(asMember()).where('payerUid', '==', MEMBER_UID).get()
    );
  });

  it('E. a member removed from Trip A can no longer perform the Trip-scoped query', async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData({ memberIds: [OWNER_UID] }));
    await assertFails(
      expensesCollection(asMember()).where('tripId', '==', TRIP_ID).get()
    );
  });

  it('F. member A: where(tripId == TripA) succeeds for Splits and returns only TripA documents', async () => {
    const snap = await assertSucceeds(
      splitsCollection(asMember()).where('tripId', '==', TRIP_ID).get()
    );
    expect(snap.docs.map((d) => d.id)).toEqual([SPLIT_ID]);
  });

  it('G. member A: an unscoped tripExpenseSplits collection query is denied', async () => {
    await assertFails(splitsCollection(asMember()).get());
  });

  it("H. member A: where('tripId', 'in', [TripA, TripB]) is denied for Splits", async () => {
    await assertFails(
      splitsCollection(asMember())
        .where('tripId', 'in', [TRIP_ID, TRIP_B_ID])
        .get()
    );
  });

  it('I. member A: querying Splits only by userId, with no tripId constraint, is denied even though every result happens to name them', async () => {
    await assertFails(
      splitsCollection(asMember()).where('userId', '==', MEMBER_UID).get()
    );
  });

  it('J. a member removed from Trip A can no longer perform the Trip-scoped Split query', async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData({ memberIds: [OWNER_UID] }));
    await assertFails(
      splitsCollection(asMember()).where('tripId', '==', TRIP_ID).get()
    );
  });
});

// Checkpoint 4D.1B: proves the EXACT two-filter query shape
// src/services/firebase/expenses.ts's own fetchExpenseSplitsForExpense
// issues - where("tripId","==",tripId).where("expenseId","==",expenseId) -
// is itself Rules-compatible against the real, unmodified firestore.rules
// (Splits are authorized strictly via resource.data.tripId, never
// expenseId alone, so the tripId filter is what the Rules engine actually
// checks; the expenseId filter narrows the result set but contributes no
// authority of its own). This is a Rules-compatibility/query-isolation
// proof only, NOT a production composite-index proof - a query combining
// only equality filters (no orderBy on a different field, no inequality)
// never requires a manual composite index, but this suite does not run
// against production index configuration and firestore.indexes.json is
// intentionally left untouched by this checkpoint.
describe('firestore.rules: tripExpenseSplits - two-filter (tripId + expenseId) query shape (Checkpoint 4D.1B)', () => {
  const OTHER_EXPENSE_ID = 'other-expense';
  const OTHER_SPLIT_ID = 'other-split';

  beforeEach(async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
    await seedSplit(SPLIT_ID, validSplitData());
    // A second Split for a DIFFERENT Expense, in the SAME Trip - proves
    // the query's own expenseId filter (not just the Rule) isolates
    // results to the requested Expense.
    await seedSplit(
      OTHER_SPLIT_ID,
      validSplitData({ expenseId: OTHER_EXPENSE_ID })
    );
  });

  it('A. current Trip member: the exact two-filter query succeeds', async () => {
    const snap = await assertSucceeds(
      splitsCollection(asMember())
        .where('tripId', '==', TRIP_ID)
        .where('expenseId', '==', EXPENSE_ID)
        .get()
    );
    expect(snap.docs.map((d) => d.id)).toEqual([SPLIT_ID]);
  });

  it('B. outsider: the exact two-filter query is denied', async () => {
    await assertFails(
      splitsCollection(asOutsider())
        .where('tripId', '==', TRIP_ID)
        .where('expenseId', '==', EXPENSE_ID)
        .get()
    );
  });

  it("C. the query returns only the requested Expense's Split(s), excluding another Split for a different Expense in the same Trip", async () => {
    const snap = await assertSucceeds(
      splitsCollection(asMember())
        .where('tripId', '==', TRIP_ID)
        .where('expenseId', '==', EXPENSE_ID)
        .get()
    );
    const ids = snap.docs.map((d) => d.id);
    expect(ids).toContain(SPLIT_ID);
    expect(ids).not.toContain(OTHER_SPLIT_ID);
  });
});
