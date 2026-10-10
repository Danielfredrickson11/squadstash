// Checkpoint 5B.3: ownership-model-state-aware integration tests for
// reverseSharedStashExpenseCore, against the local Firestore emulator
// via the Admin SDK - never production. Deliberately a SEPARATE file
// from reverseSharedStashExpenseCore.ts's own existing (unmodified)
// legacy test suite - that file's continued, untouched pass is itself
// part of the proof that legacy behavior is unchanged; this file covers
// only the NEW ownership-model-state branches (exact-allocation
// restoration, cross-document corruption rejection, migrating/
// needs_reconciliation rejection).
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {after, before, beforeEach, describe, it} from "node:test";
import {deleteApp, initializeApp} from "firebase-admin/app";
import type {App} from "firebase-admin/app";
import {Timestamp, getFirestore} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {recordSharedStashExpenseCore} from "../src/callables/recordSharedStashExpense";
import {reverseSharedStashExpenseCore} from "../src/callables/reverseSharedStashExpense";
import {CURRENT_TRIP_OWNERSHIP_MODEL_VERSION} from "../src/domain/tripOwnershipModel";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "FIRESTORE_EMULATOR_HOST is not set. Run these tests via " +
      '`firebase emulators:exec --only firestore "npm --prefix functions test"` ' +
      "so the Admin SDK talks to the local emulator, never production."
  );
}

const OWNER_UID = "owner-uid";
const MEMBER_UID = "member-uid";
const FRIEND_UID = "friend-uid";
const TRIP_ID = "test-trip";

let app: App;
let db: Firestore;

before(() => {
  app = initializeApp({
    projectId: "demo-squadstash-functions-test-reverse-shared-stash-own",
  });
  db = getFirestore(app);
});

after(async () => {
  await deleteApp(app);
});

async function clearFirestore(): Promise<void> {
  for (const name of [
    "trips",
    "tripExpenses",
    "savingsTransactions",
    "tripMemberOwnership",
    "tripOwnershipAllocations",
  ]) {
    const snap = await db.collection(name).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

beforeEach(async () => {
  await clearFirestore();
});

function ownershipId(tripId: string, uid: string): string {
  return `${tripId}_${uid}`;
}

function seedTrip(
  overrides: Record<string, unknown> = {}
): Promise<FirebaseFirestore.WriteResult> {
  return db
    .collection("trips")
    .doc(TRIP_ID)
    .set({
      ownerId: OWNER_UID,
      memberIds: [OWNER_UID, MEMBER_UID, FRIEND_UID],
      title: "Test Trip",
      target: 1000,
      saved: 10,
      imageUrl: "https://example.com/trip.jpg",
      ...overrides,
    });
}

function initializedOverrides(
  ledgerBalanceMinor: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ledgerOpeningBalanceMinor: 0,
    ledgerBalanceMinor,
    saved: ledgerBalanceMinor / 100,
    currency: "USD",
    ownershipModelState: "initialized",
    ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
    ...overrides,
  };
}

function seedOwnership(
  tripId: string,
  uid: string,
  ownershipMinor: number,
  overrides: Record<string, unknown> = {}
): Promise<FirebaseFirestore.WriteResult> {
  return db
    .collection("tripMemberOwnership")
    .doc(ownershipId(tripId, uid))
    .set({
      tripId,
      uid,
      ownershipMinor,
      lastUpdatedAt: new Date(),
      ...overrides,
    });
}

async function getOwnership(uid: string): Promise<number | undefined> {
  const snap = await db
    .collection("tripMemberOwnership")
    .doc(ownershipId(TRIP_ID, uid))
    .get();
  return snap.exists ?
    (snap.data() as {ownershipMinor: number}).ownershipMinor :
    undefined;
}

async function getOwnershipLastUpdatedAt(
  uid: string
): Promise<Timestamp | undefined> {
  const snap = await db
    .collection("tripMemberOwnership")
    .doc(ownershipId(TRIP_ID, uid))
    .get();
  return snap.exists ?
    (snap.data() as {lastUpdatedAt: Timestamp}).lastUpdatedAt :
    undefined;
}

function createRequest(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    tripId: TRIP_ID,
    amountMinor: 200,
    currency: "USD",
    description: "Groceries for the cabin",
    clientRequestId: randomUUID(),
    ...overrides,
  };
}

function baseReversalRequest(
  expenseId: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    expenseId,
    clientRequestId: randomUUID(),
    ...overrides,
  };
}

async function assertRejectsWithCode(
  promise: Promise<unknown>,
  code: string
): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof HttpsError, "expected an HttpsError");
    assert.equal((err as HttpsError).code, code);
    return true;
  });
}

// Creates a genuine, fully realistic active shared_stash Expense (plus
// its linked withdrawal AND, on an initialized Trip, its linked
// tripOwnershipAllocations record) via the real create callable, so
// every field is exactly what production would actually produce.
async function createActiveExpense(
  creatorUid: string,
  overrides: Record<string, unknown> = {}
): Promise<{expenseId: string; sharedStashTransactionId: string}> {
  const result = await recordSharedStashExpenseCore(
    db,
    creatorUid,
    createRequest(overrides)
  );
  return result;
}

// Checkpoint 5B.3A, items 7-8: a hand-constructed, otherwise fully
// VALID initialized-reversal fixture (Expense + linked withdrawal +
// linked allocation), built WITHOUT the real create callable so each
// corruption test can tamper exactly one field of exactly one document
// while leaving every other document genuinely well-formed. Returns
// the three refs so a test can corrupt any one of them directly.
// A field explicitly set to this sentinel in an overrides object is
// OMITTED from the final write entirely (Firestore rejects a literal
// `undefined` value outright) - used by tests proving a genuinely
// ABSENT field (as opposed to a present-but-wrong one) is rejected.
function omitUndefined(
  data: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

async function seedManualExpenseFixture(overrides: {
  withdrawal?: Record<string, unknown>;
  expense?: Record<string, unknown>;
  allocation?: Record<string, unknown>;
} = {}): Promise<{
  expenseId: string;
  withdrawalId: string;
}> {
  const withdrawalId = "manual-withdrawal";
  const expenseId = "manual-expense";
  await db.collection("savingsTransactions").doc(withdrawalId).set(
    omitUndefined({
      resourceType: "trip",
      resourceId: TRIP_ID,
      memberUid: OWNER_UID,
      recordedBy: OWNER_UID,
      amountMinor: 100,
      currency: "USD",
      type: "withdrawal",
      reversalOf: null,
      linkedExpenseId: expenseId,
      ...overrides.withdrawal,
    })
  );
  await db.collection("tripExpenses").doc(expenseId).set(
    omitUndefined({
      tripId: TRIP_ID,
      payerUid: null,
      createdBy: OWNER_UID,
      amountMinor: 100,
      currency: "USD",
      description: "Manual fixture",
      splitStrategy: "equal",
      paymentSource: "shared_stash",
      sharedStashTransactionId: withdrawalId,
      status: "active",
      creationRequest: {
        tripId: TRIP_ID,
        amountMinor: 100,
        currency: "USD",
        description: "Manual fixture",
        category: null,
        paymentSource: "shared_stash",
        occurredAtInstantMs: null,
        replacesExpenseId: null,
      },
      ...overrides.expense,
    })
  );
  await db.collection("tripOwnershipAllocations").doc(withdrawalId).set(
    omitUndefined({
      tripId: TRIP_ID,
      expenseId,
      withdrawalTransactionId: withdrawalId,
      amountMinor: 100,
      currency: "USD",
      allocations: [{uid: OWNER_UID, amountMinor: 100}],
      provenance: "original",
      createdAt: Timestamp.now(),
      ...overrides.allocation,
    })
  );
  return {expenseId, withdrawalId};
}

// ---------------------------------------------------------------------
// Legacy regression (Checkpoint 5B.3, item 23/17) - reversal succeeds
// without any allocation record or ownership-cache dependency, exactly
// as today, for both absent and explicit "legacy" state.
// ---------------------------------------------------------------------

describe("legacy regression - reversal requires no allocation record", () => {
  it("reverses successfully with state absent, no allocation record ever existed", async () => {
    await seedTrip();
    const {expenseId} = await createActiveExpense(MEMBER_UID);
    const result = await reverseSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseReversalRequest(expenseId)
    );
    assert.equal(result.expenseId, expenseId);
  });

  it("reverses successfully with explicit state \"legacy\"", async () => {
    await seedTrip({ownershipModelState: "legacy"});
    const {expenseId} = await createActiveExpense(MEMBER_UID);
    const result = await reverseSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseReversalRequest(expenseId)
    );
    assert.equal(result.expenseId, expenseId);
  });
});

// ---------------------------------------------------------------------
// Initialized reversal (Checkpoint 5B.3, item 27)
// ---------------------------------------------------------------------

describe("initialized reversal - exact restoration", () => {
  it("every restored ownership row's lastUpdatedAt advances to a trusted server timestamp (Checkpoint 5B.3A, item 4)", async () => {
    await seedTrip(initializedOverrides(1000));
    const oldSentinel = Timestamp.fromMillis(1000);
    await seedOwnership(TRIP_ID, OWNER_UID, 900, {
      lastUpdatedAt: oldSentinel,
    });
    await seedOwnership(TRIP_ID, FRIEND_UID, 100, {
      lastUpdatedAt: oldSentinel,
    });
    const {expenseId} = await createActiveExpense(MEMBER_UID, {
      amountMinor: 200,
    });

    // The depletion write itself already advanced both participating
    // rows away from the sentinel - reset them to a new, still-OLD
    // sentinel so the REVERSAL's own write is what this test proves.
    const preReversalSentinel = Timestamp.fromMillis(2000);
    await seedOwnership(TRIP_ID, OWNER_UID, 720, {
      lastUpdatedAt: preReversalSentinel,
    });
    await seedOwnership(TRIP_ID, FRIEND_UID, 80, {
      lastUpdatedAt: preReversalSentinel,
    });

    await reverseSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseReversalRequest(expenseId)
    );

    const ownerAfter = await getOwnershipLastUpdatedAt(OWNER_UID);
    const friendAfter = await getOwnershipLastUpdatedAt(FRIEND_UID);
    assert.ok(ownerAfter, "expected owner lastUpdatedAt to be set");
    assert.ok(friendAfter, "expected friend lastUpdatedAt to be set");
    assert.ok(
      ownerAfter!.toMillis() > preReversalSentinel.toMillis(),
      "expected owner lastUpdatedAt to advance past the sentinel"
    );
    assert.ok(
      friendAfter!.toMillis() > preReversalSentinel.toMillis(),
      "expected friend lastUpdatedAt to advance past the sentinel"
    );
  });

  it("a rejected reversal leaves lastUpdatedAt untouched", async () => {
    await seedTrip(initializedOverrides(1000));
    const sentinel = Timestamp.fromMillis(1000);
    await seedOwnership(TRIP_ID, OWNER_UID, 900, {lastUpdatedAt: sentinel});
    await seedOwnership(TRIP_ID, FRIEND_UID, 100, {lastUpdatedAt: sentinel});
    const {expenseId} = await createActiveExpense(MEMBER_UID, {
      amountMinor: 200,
    });

    const postDepletionFriendStamp =
      await getOwnershipLastUpdatedAt(FRIEND_UID);
    // Corrupt the allocation record so reversal is rejected before any
    // restoration write.
    const expenseSnap = await db.collection("tripExpenses").doc(expenseId).get();
    await db
      .collection("tripOwnershipAllocations")
      .doc(expenseSnap.data()!.sharedStashTransactionId)
      .update({currency: "EUR"});

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseReversalRequest(expenseId)
      ),
      "failed-precondition"
    );

    const friendAfter = await getOwnershipLastUpdatedAt(FRIEND_UID);
    assert.deepEqual(friendAfter, postDepletionFriendStamp);
  });

  it("restores the exact original ownership allocation; aggregate adds back to CURRENT balance", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, OWNER_UID, 900);
    await seedOwnership(TRIP_ID, FRIEND_UID, 100);

    const {expenseId} = await createActiveExpense(MEMBER_UID, {
      amountMinor: 200,
    });
    assert.equal(await getOwnership(OWNER_UID), 720);
    assert.equal(await getOwnership(FRIEND_UID), 80);

    // Unrelated activity on the aggregate between create and reverse -
    // the refund must add to the CURRENT aggregate, never a restored
    // historical snapshot.
    await db
      .collection("trips")
      .doc(TRIP_ID)
      .update({ledgerBalanceMinor: 750});

    await reverseSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseReversalRequest(expenseId)
    );

    assert.equal(await getOwnership(OWNER_UID), 900);
    assert.equal(await getOwnership(FRIEND_UID), 100);
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.ledgerBalanceMinor, 950); // 750 + 200
  });

  it("the frozen worked example: restores the exact original delta, never recomputing against changed current proportions", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, OWNER_UID, 900);
    await seedOwnership(TRIP_ID, FRIEND_UID, 100);

    const {expenseId} = await createActiveExpense(MEMBER_UID, {
      amountMinor: 200,
    });
    // Original depletion was Daniel(owner) -180, Friend -20.

    // Ownership proportions have since materially changed.
    await seedOwnership(TRIP_ID, OWNER_UID, 5000);
    await seedOwnership(TRIP_ID, FRIEND_UID, 10);

    await reverseSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseReversalRequest(expenseId)
    );

    // Restoration adds back exactly the ORIGINAL deltas (180/20), never
    // a fresh proportional split of today's 5000/10 balances.
    assert.equal(await getOwnership(OWNER_UID), 5180);
    assert.equal(await getOwnership(FRIEND_UID), 30);
  });

  it("the allocation document itself is never touched by reversal, and no second one is created", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, OWNER_UID, 1000);

    const {expenseId, sharedStashTransactionId} = await createActiveExpense(
      MEMBER_UID,
      {amountMinor: 100}
    );
    const beforeSnap = await db
      .collection("tripOwnershipAllocations")
      .doc(sharedStashTransactionId)
      .get();
    const beforeData = beforeSnap.data();

    await reverseSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseReversalRequest(expenseId)
    );

    const afterSnap = await db
      .collection("tripOwnershipAllocations")
      .doc(sharedStashTransactionId)
      .get();
    assert.deepEqual(afterSnap.data(), beforeData);
    const allSnap = await db.collection("tripOwnershipAllocations").get();
    assert.equal(allSnap.size, 1);
  });

  it("idempotent replay does not restore twice", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, OWNER_UID, 900);
    await seedOwnership(TRIP_ID, FRIEND_UID, 100);
    const {expenseId} = await createActiveExpense(MEMBER_UID, {
      amountMinor: 200,
    });
    const reversalRequest = baseReversalRequest(expenseId);

    const first = await reverseSharedStashExpenseCore(
      db,
      MEMBER_UID,
      reversalRequest
    );
    assert.equal(await getOwnership(OWNER_UID), 900);

    const second = await reverseSharedStashExpenseCore(
      db,
      MEMBER_UID,
      reversalRequest
    );
    assert.deepEqual(second, first);
    assert.equal(await getOwnership(OWNER_UID), 900);
    assert.equal(await getOwnership(FRIEND_UID), 100);
  });

  it("missing allocation document rejects", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, OWNER_UID, 1000);
    const {expenseId, sharedStashTransactionId} = await createActiveExpense(
      MEMBER_UID,
      {amountMinor: 100}
    );
    await db
      .collection("tripOwnershipAllocations")
      .doc(sharedStashTransactionId)
      .delete();

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseReversalRequest(expenseId)
      ),
      "failed-precondition"
    );
    assert.equal(await getOwnership(OWNER_UID), 900);
  });

  it("allocation referencing the wrong Trip rejects", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, OWNER_UID, 1000);
    const {expenseId, sharedStashTransactionId} = await createActiveExpense(
      MEMBER_UID,
      {amountMinor: 100}
    );
    await db
      .collection("tripOwnershipAllocations")
      .doc(sharedStashTransactionId)
      .update({tripId: "some-other-trip"});

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseReversalRequest(expenseId)
      ),
      "failed-precondition"
    );
  });

  it("allocation referencing the wrong Expense link rejects", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, OWNER_UID, 1000);
    const {expenseId, sharedStashTransactionId} = await createActiveExpense(
      MEMBER_UID,
      {amountMinor: 100}
    );
    await db
      .collection("tripOwnershipAllocations")
      .doc(sharedStashTransactionId)
      .update({expenseId: "some-other-expense"});

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseReversalRequest(expenseId)
      ),
      "failed-precondition"
    );
  });

  it("allocation referencing the wrong withdrawalTransactionId rejects", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, OWNER_UID, 1000);
    const {expenseId, sharedStashTransactionId} = await createActiveExpense(
      MEMBER_UID,
      {amountMinor: 100}
    );
    await db
      .collection("tripOwnershipAllocations")
      .doc(sharedStashTransactionId)
      .update({withdrawalTransactionId: "some-other-id"});

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseReversalRequest(expenseId)
      ),
      "failed-precondition"
    );
  });

  it("allocation amountMinor mismatch rejects", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, OWNER_UID, 1000);
    const {expenseId, sharedStashTransactionId} = await createActiveExpense(
      MEMBER_UID,
      {amountMinor: 100}
    );
    await db
      .collection("tripOwnershipAllocations")
      .doc(sharedStashTransactionId)
      .update({amountMinor: 99});

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseReversalRequest(expenseId)
      ),
      "failed-precondition"
    );
  });

  it("allocation currency mismatch rejects", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, OWNER_UID, 1000);
    const {expenseId, sharedStashTransactionId} = await createActiveExpense(
      MEMBER_UID,
      {amountMinor: 100}
    );
    await db
      .collection("tripOwnershipAllocations")
      .doc(sharedStashTransactionId)
      .update({currency: "EUR"});

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseReversalRequest(expenseId)
      ),
      "failed-precondition"
    );
  });

  it("missing current ownership row for a named allocated uid rejects, never recreated", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, OWNER_UID, 900);
    await seedOwnership(TRIP_ID, FRIEND_UID, 100);
    const {expenseId} = await createActiveExpense(MEMBER_UID, {
      amountMinor: 200,
    });

    await db
      .collection("tripMemberOwnership")
      .doc(ownershipId(TRIP_ID, FRIEND_UID))
      .delete();

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseReversalRequest(expenseId)
      ),
      "failed-precondition"
    );
    // The owner's row must also be untouched - no partial reversal.
    assert.equal(await getOwnership(OWNER_UID), 720);
  });

  it("ownership overflow on restoration rejects", async () => {
    // The surviving member's CURRENT ownership is placed right at the
    // safe-integer boundary, deliberately overflowing on restore.
    await seedTrip(initializedOverrides(100, {ownerId: OWNER_UID}));
    const {expenseId} = await seedManualExpenseFixture();
    await seedOwnership(TRIP_ID, OWNER_UID, Number.MAX_SAFE_INTEGER - 50);

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        OWNER_UID,
        baseReversalRequest(expenseId)
      ),
      "failed-precondition"
    );
    assert.equal(
      await getOwnership(OWNER_UID),
      Number.MAX_SAFE_INTEGER - 50
    );
  });
});

// ---------------------------------------------------------------------
// Original-withdrawal cross-document corruption (Checkpoint 5B.3A,
// item 7) - the allocation/Expense are left genuinely valid; only the
// ORIGINAL linked withdrawal SavingsTransaction is tampered, one field
// at a time, proving reversal validates against it too.
// ---------------------------------------------------------------------

describe("initialized reversal - original-withdrawal corruption", () => {
  async function assertFixtureUntouched(
    expenseId: string,
    ownershipBefore: number
  ): Promise<void> {
    const expenseSnap = await db.collection("tripExpenses").doc(expenseId).get();
    assert.equal(expenseSnap.data()?.status, "active");
    // Counts the TOTAL savingsTransactions population rather than
    // filtering by `type` - the manual fixture's own (deliberately
    // corrupted) withdrawal document may itself carry a tampered
    // `type` field in some of these tests, which would otherwise be
    // misidentified as a genuine refund by a type-filtered query.
    const allTransactions = await db.collection("savingsTransactions").get();
    assert.equal(
      allTransactions.size,
      1,
      "expected only the original withdrawal - no refund created"
    );
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.ledgerBalanceMinor, 100);
    assert.equal(await getOwnership(OWNER_UID), ownershipBefore);
  }

  it("a withdrawal pointing at the wrong Trip (resourceId) rejects", async () => {
    await seedTrip(initializedOverrides(100, {ownerId: OWNER_UID}));
    await seedOwnership(TRIP_ID, OWNER_UID, 0);
    const {expenseId} = await seedManualExpenseFixture({
      withdrawal: {resourceId: "some-other-trip"},
    });

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        OWNER_UID,
        baseReversalRequest(expenseId)
      ),
      "failed-precondition"
    );
    await assertFixtureUntouched(expenseId, 0);
  });

  it("a withdrawal with the wrong linkedExpenseId rejects", async () => {
    await seedTrip(initializedOverrides(100, {ownerId: OWNER_UID}));
    await seedOwnership(TRIP_ID, OWNER_UID, 0);
    const {expenseId} = await seedManualExpenseFixture({
      withdrawal: {linkedExpenseId: "some-other-expense"},
    });

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        OWNER_UID,
        baseReversalRequest(expenseId)
      ),
      "failed-precondition"
    );
    await assertFixtureUntouched(expenseId, 0);
  });

  it("a withdrawal with a currency mismatch against the Expense rejects", async () => {
    await seedTrip(initializedOverrides(100, {ownerId: OWNER_UID}));
    await seedOwnership(TRIP_ID, OWNER_UID, 0);
    const {expenseId} = await seedManualExpenseFixture({
      withdrawal: {currency: "EUR"},
    });

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        OWNER_UID,
        baseReversalRequest(expenseId)
      ),
      "failed-precondition"
    );
    await assertFixtureUntouched(expenseId, 0);
  });

  it("a withdrawal with type \"contribution\" instead of \"withdrawal\" rejects (wrong sign convention)", async () => {
    await seedTrip(initializedOverrides(100, {ownerId: OWNER_UID}));
    await seedOwnership(TRIP_ID, OWNER_UID, 0);
    const {expenseId} = await seedManualExpenseFixture({
      withdrawal: {type: "contribution"},
    });

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        OWNER_UID,
        baseReversalRequest(expenseId)
      ),
      "failed-precondition"
    );
    await assertFixtureUntouched(expenseId, 0);
  });

  it("a withdrawal with a mismatched amountMinor rejects", async () => {
    await seedTrip(initializedOverrides(100, {ownerId: OWNER_UID}));
    await seedOwnership(TRIP_ID, OWNER_UID, 0);
    const {expenseId} = await seedManualExpenseFixture({
      withdrawal: {amountMinor: 50},
    });

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        OWNER_UID,
        baseReversalRequest(expenseId)
      ),
      "failed-precondition"
    );
    await assertFixtureUntouched(expenseId, 0);
  });
});

// ---------------------------------------------------------------------
// Full allocation-record runtime validation (Checkpoint 5B.3A, item 8)
// ---------------------------------------------------------------------

describe("initialized reversal - allocation-record runtime validation", () => {
  it("a \"migrated\" provenance record with a valid migratedAt restores correctly", async () => {
    await seedTrip(initializedOverrides(100, {ownerId: OWNER_UID}));
    await seedOwnership(TRIP_ID, OWNER_UID, 0);
    const {expenseId} = await seedManualExpenseFixture({
      allocation: {
        provenance: "migrated",
        migratedAt: Timestamp.now(),
      },
    });

    const result = await reverseSharedStashExpenseCore(
      db,
      OWNER_UID,
      baseReversalRequest(expenseId)
    );
    assert.equal(result.expenseId, expenseId);
    assert.equal(await getOwnership(OWNER_UID), 100);
  });

  it("a \"migrated\" provenance record missing migratedAt rejects", async () => {
    await seedTrip(initializedOverrides(100, {ownerId: OWNER_UID}));
    await seedOwnership(TRIP_ID, OWNER_UID, 0);
    const {expenseId} = await seedManualExpenseFixture({
      allocation: {provenance: "migrated"},
    });

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        OWNER_UID,
        baseReversalRequest(expenseId)
      ),
      "failed-precondition"
    );
    assert.equal(await getOwnership(OWNER_UID), 0);
  });

  it("an \"original\" provenance record that also carries migratedAt rejects", async () => {
    await seedTrip(initializedOverrides(100, {ownerId: OWNER_UID}));
    await seedOwnership(TRIP_ID, OWNER_UID, 0);
    const {expenseId} = await seedManualExpenseFixture({
      allocation: {migratedAt: Timestamp.now()},
    });

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        OWNER_UID,
        baseReversalRequest(expenseId)
      ),
      "failed-precondition"
    );
    assert.equal(await getOwnership(OWNER_UID), 0);
  });

  it("a record missing createdAt entirely rejects", async () => {
    await seedTrip(initializedOverrides(100, {ownerId: OWNER_UID}));
    await seedOwnership(TRIP_ID, OWNER_UID, 0);
    const {expenseId} = await seedManualExpenseFixture({
      allocation: {createdAt: undefined},
    });

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        OWNER_UID,
        baseReversalRequest(expenseId)
      ),
      "failed-precondition"
    );
    assert.equal(await getOwnership(OWNER_UID), 0);
  });

  it("an unknown/malformed provenance value rejects", async () => {
    await seedTrip(initializedOverrides(100, {ownerId: OWNER_UID}));
    await seedOwnership(TRIP_ID, OWNER_UID, 0);
    const {expenseId} = await seedManualExpenseFixture({
      allocation: {provenance: "bogus"},
    });

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        OWNER_UID,
        baseReversalRequest(expenseId)
      ),
      "failed-precondition"
    );
    assert.equal(await getOwnership(OWNER_UID), 0);
  });

  it("malformed allocation entries (non-ascending uid order) reject", async () => {
    await seedTrip(initializedOverrides(150, {ownerId: OWNER_UID}));
    await seedOwnership(TRIP_ID, OWNER_UID, 0);
    await seedOwnership(TRIP_ID, FRIEND_UID, 0);
    const {expenseId} = await seedManualExpenseFixture({
      withdrawal: {amountMinor: 150},
      expense: {amountMinor: 150},
      allocation: {
        amountMinor: 150,
        allocations: [
          {uid: OWNER_UID, amountMinor: 100},
          {uid: FRIEND_UID, amountMinor: 50},
        ],
      },
    });

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        OWNER_UID,
        baseReversalRequest(expenseId)
      ),
      "failed-precondition"
    );
    assert.equal(await getOwnership(OWNER_UID), 0);
    assert.equal(await getOwnership(FRIEND_UID), 0);
  });

  it("malformed allocation entries (duplicate uid) reject", async () => {
    await seedTrip(initializedOverrides(200, {ownerId: OWNER_UID}));
    await seedOwnership(TRIP_ID, OWNER_UID, 0);
    const {expenseId} = await seedManualExpenseFixture({
      withdrawal: {amountMinor: 200},
      expense: {amountMinor: 200},
      allocation: {
        amountMinor: 200,
        allocations: [
          {uid: OWNER_UID, amountMinor: 100},
          {uid: OWNER_UID, amountMinor: 100},
        ],
      },
    });

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        OWNER_UID,
        baseReversalRequest(expenseId)
      ),
      "failed-precondition"
    );
    assert.equal(await getOwnership(OWNER_UID), 0);
  });
});

// ---------------------------------------------------------------------
// Migrating / needs_reconciliation (Checkpoint 5B.3, items 22/28/29)
// ---------------------------------------------------------------------

describe("migrating - every new reversal rejects", () => {
  it("rejects a new reversal of an already-active expense", async () => {
    await seedTrip();
    const {expenseId} = await createActiveExpense(MEMBER_UID);
    await db
      .collection("trips")
      .doc(TRIP_ID)
      .update({ownershipModelState: "migrating"});

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseReversalRequest(expenseId)
      ),
      "failed-precondition"
    );
  });

  it("an exact replay of an already-committed reversal survives the Trip later entering migrating", async () => {
    await seedTrip();
    const {expenseId} = await createActiveExpense(MEMBER_UID);
    const reversalRequest = baseReversalRequest(expenseId);
    const first = await reverseSharedStashExpenseCore(
      db,
      MEMBER_UID,
      reversalRequest
    );

    await db
      .collection("trips")
      .doc(TRIP_ID)
      .update({ownershipModelState: "migrating"});

    const replay = await reverseSharedStashExpenseCore(
      db,
      MEMBER_UID,
      reversalRequest
    );
    assert.deepEqual(replay, first);
  });
});

describe("needs_reconciliation - every new reversal rejects, identically to migrating", () => {
  it("rejects a new reversal", async () => {
    await seedTrip();
    const {expenseId} = await createActiveExpense(MEMBER_UID);
    await db
      .collection("trips")
      .doc(TRIP_ID)
      .update({
        ownershipModelState: "needs_reconciliation",
        ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
      });

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseReversalRequest(expenseId)
      ),
      "failed-precondition"
    );
  });

  it("an exact replay of an already-committed reversal survives the Trip later needing reconciliation", async () => {
    await seedTrip();
    const {expenseId} = await createActiveExpense(MEMBER_UID);
    const reversalRequest = baseReversalRequest(expenseId);
    const first = await reverseSharedStashExpenseCore(
      db,
      MEMBER_UID,
      reversalRequest
    );

    await db
      .collection("trips")
      .doc(TRIP_ID)
      .update({
        ownershipModelState: "needs_reconciliation",
        ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
      });

    const replay = await reverseSharedStashExpenseCore(
      db,
      MEMBER_UID,
      reversalRequest
    );
    assert.deepEqual(replay, first);
  });
});

// ---------------------------------------------------------------------
// Conflicting idempotency payload during quiescence (Checkpoint
// 5B.3A, item 3) - a reused reversal clientRequestId with a CONFLICTING
// payload must never be treated as exact replay, in EITHER quiescence
// state, and must never mutate anything.
// ---------------------------------------------------------------------

describe("conflicting reversal payload during quiescence never counts as replay", () => {
  for (const state of ["migrating", "needs_reconciliation"] as const) {
    it(`a reused clientRequestId with a different reversalReason rejects while ${state}`, async () => {
      await seedTrip();
      const {expenseId} = await createActiveExpense(MEMBER_UID);
      const reversalRequest = baseReversalRequest(expenseId, {
        reversalReason: "original reason",
      });
      await reverseSharedStashExpenseCore(db, MEMBER_UID, reversalRequest);

      await db
        .collection("trips")
        .doc(TRIP_ID)
        .update({
          ownershipModelState: state,
          ...(state === "needs_reconciliation" ?
            {ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION} :
            {}),
        });

      const conflictingRequest = {
        ...reversalRequest,
        reversalReason: "a completely different reason",
      };
      await assertRejectsWithCode(
        reverseSharedStashExpenseCore(db, MEMBER_UID, conflictingRequest),
        "failed-precondition"
      );

      // No second refund was ever created.
      const refunds = await db
        .collection("savingsTransactions")
        .where("type", "==", "contribution")
        .get();
      assert.equal(refunds.size, 1);
    });
  }
});

// ---------------------------------------------------------------------
// Corrupt / unsupported state (Checkpoint 5B.3, item 30)
// ---------------------------------------------------------------------

describe("corrupt / unsupported ownership model state - fails closed", () => {
  it("initialized with an unsupported version rejects", async () => {
    await seedTrip();
    const {expenseId} = await createActiveExpense(MEMBER_UID);
    await db
      .collection("trips")
      .doc(TRIP_ID)
      .update({ownershipModelState: "initialized", ownershipModelVersion: 999});

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseReversalRequest(expenseId)
      ),
      "failed-precondition"
    );
  });

  it("an unknown state string rejects", async () => {
    await seedTrip();
    const {expenseId} = await createActiveExpense(MEMBER_UID);
    await db
      .collection("trips")
      .doc(TRIP_ID)
      .update({ownershipModelState: "bogus"});

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseReversalRequest(expenseId)
      ),
      "failed-precondition"
    );
  });
});
