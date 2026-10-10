// Checkpoint 5B.3: ownership-model-state-aware integration tests for
// recordSharedStashExpenseCore, against the local Firestore emulator via
// the Admin SDK - never production. Deliberately a SEPARATE file from
// recordSharedStashExpenseCore.ts's own existing (unmodified) legacy
// test suite - that file's continued, untouched pass is itself part of
// the proof that legacy behavior is unchanged; this file covers only
// the NEW ownership-model-state branches (allocation persistence,
// proportional depletion, reconciliation-drift handling, migrating/
// needs_reconciliation rejection).
import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";
import {after, before, beforeEach, describe, it} from "node:test";
import {deleteApp, initializeApp} from "firebase-admin/app";
import type {App} from "firebase-admin/app";
import {Timestamp, getFirestore} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {recordSharedStashExpenseCore} from "../src/callables/recordSharedStashExpense";
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
    projectId: "demo-squadstash-functions-test-shared-stash-ownership",
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

function expectedWithdrawalId(clientRequestId: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify([clientRequestId, "shared-stash-withdrawal"]),
      "utf8"
    )
    .digest("hex");
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

function baseRequest(
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

// ---------------------------------------------------------------------
// Legacy regression (Checkpoint 5B.3, item 23/9) - minimal, targeted
// proof an explicit "legacy" state behaves identically to absent state.
// No allocation record, no ownership-cache read/write, for either.
// ---------------------------------------------------------------------

describe("legacy regression - no allocation record, no ownership cache", () => {
  it("succeeds with state absent, no allocation record created", async () => {
    await seedTrip();
    const result = await recordSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseRequest()
    );
    const allocationSnap = await db
      .collection("tripOwnershipAllocations")
      .doc(result.sharedStashTransactionId)
      .get();
    assert.equal(allocationSnap.exists, false);
  });

  it("succeeds with explicit state \"legacy\", no allocation record created", async () => {
    await seedTrip({ownershipModelState: "legacy"});
    const result = await recordSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseRequest()
    );
    const allocationSnap = await db
      .collection("tripOwnershipAllocations")
      .doc(result.sharedStashTransactionId)
      .get();
    assert.equal(allocationSnap.exists, false);
  });

  // Checkpoint 5B.3B: legacy must remain completely independent of the
  // tripOwnershipAllocations collection - a stray/stale document at the
  // deterministic withdrawal id must never be inspected, never block
  // the operation, and never be touched, for either legacy
  // representation (absent or explicit "legacy").
  for (const label of ["state absent", "explicit state \"legacy\""] as const) {
    it(`a stray/stale allocation document at the canonical withdrawal id is ignored and left untouched - ${label}`, async () => {
      await seedTrip(
        label === "explicit state \"legacy\"" ?
          {ownershipModelState: "legacy"} :
          {}
      );
      const request = baseRequest({amountMinor: 500});
      const withdrawalId = expectedWithdrawalId(
        request.clientRequestId as string
      );
      const staleAllocation = {
        tripId: "some-other-trip",
        expenseId: "some-stale-expense",
        withdrawalTransactionId: withdrawalId,
        amountMinor: 9999,
        currency: "USD",
        allocations: [{uid: "nobody", amountMinor: 9999}],
        provenance: "original",
        createdAt: Timestamp.now(),
      };
      await db
        .collection("tripOwnershipAllocations")
        .doc(withdrawalId)
        .set(staleAllocation);

      // The legacy operation MUST still succeed, exactly as it would
      // with no stray document present at all.
      const result = await recordSharedStashExpenseCore(
        db,
        MEMBER_UID,
        request
      );
      assert.equal(result.sharedStashTransactionId, withdrawalId);

      // The stale document is byte-for-byte unchanged - never
      // inspected for blocking purposes, never overwritten.
      const allocationSnap = await db
        .collection("tripOwnershipAllocations")
        .doc(withdrawalId)
        .get();
      assert.deepEqual(allocationSnap.data(), staleAllocation);
      const allAllocations = await db.collection("tripOwnershipAllocations").get();
      assert.equal(allAllocations.size, 1);

      // Normal legacy Expense + withdrawal + aggregate behavior, no
      // ownership rows required or created.
      const expenseSnap = await db
        .collection("tripExpenses")
        .doc(result.expenseId)
        .get();
      assert.equal(expenseSnap.exists, true);
      const withdrawalSnap = await db
        .collection("savingsTransactions")
        .doc(withdrawalId)
        .get();
      assert.equal(withdrawalSnap.exists, true);
      const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
      assert.equal(tripSnap.data()?.ledgerBalanceMinor, 500); // 1000 - 500
      const ownershipRows = await db.collection("tripMemberOwnership").get();
      assert.equal(ownershipRows.size, 0);
    });
  }
});

// ---------------------------------------------------------------------
// Initialized Shared-Stash Expense (Checkpoint 5B.3, item 26)
// ---------------------------------------------------------------------

describe("initialized Shared-Stash Expense - basic proportional depletion", () => {
  it("lastUpdatedAt advances for every participating row, and never for a zero-ownership nonparticipating row (Checkpoint 5B.3A, item 4)", async () => {
    await seedTrip(initializedOverrides(1000));
    const oldSentinel = Timestamp.fromMillis(1000);
    await seedOwnership(TRIP_ID, OWNER_UID, 900, {lastUpdatedAt: oldSentinel});
    await seedOwnership(TRIP_ID, FRIEND_UID, 100, {lastUpdatedAt: oldSentinel});

    await recordSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseRequest({amountMinor: 200})
    );

    const ownerAfter = await getOwnershipLastUpdatedAt(OWNER_UID);
    const friendAfter = await getOwnershipLastUpdatedAt(FRIEND_UID);
    assert.ok(ownerAfter, "expected owner lastUpdatedAt to be set");
    assert.ok(friendAfter, "expected friend lastUpdatedAt to be set");
    assert.ok(
      ownerAfter!.toMillis() > oldSentinel.toMillis(),
      "expected owner lastUpdatedAt to advance past the sentinel"
    );
    assert.ok(
      friendAfter!.toMillis() > oldSentinel.toMillis(),
      "expected friend lastUpdatedAt to advance past the sentinel"
    );
  });

  it("a rejected expense leaves lastUpdatedAt untouched", async () => {
    await seedTrip(initializedOverrides(100));
    const sentinel = Timestamp.fromMillis(1000);
    await seedOwnership(TRIP_ID, OWNER_UID, 100, {lastUpdatedAt: sentinel});

    await assertRejectsWithCode(
      recordSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseRequest({amountMinor: 101})
      ),
      "failed-precondition"
    );

    const ownerAfter = await getOwnershipLastUpdatedAt(OWNER_UID);
    assert.deepEqual(ownerAfter, sentinel);
  });


  it("Daniel=900, Friend=100, expense=200 -> Daniel=720, Friend=80, canonical allocation 180/20", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, OWNER_UID, 900);
    await seedOwnership(TRIP_ID, FRIEND_UID, 100);

    const request = baseRequest({amountMinor: 200});
    const result = await recordSharedStashExpenseCore(
      db,
      MEMBER_UID,
      request
    );

    assert.equal(result.sharedStashTransactionId, expectedWithdrawalId(
      request.clientRequestId as string
    ));
    assert.equal(await getOwnership(OWNER_UID), 720);
    assert.equal(await getOwnership(FRIEND_UID), 80);

    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.ledgerBalanceMinor, 800);

    const allocationSnap = await db
      .collection("tripOwnershipAllocations")
      .doc(result.sharedStashTransactionId)
      .get();
    assert.equal(allocationSnap.exists, true);
    const allocationData = allocationSnap.data()!;
    assert.equal(allocationData.tripId, TRIP_ID);
    assert.equal(allocationData.expenseId, result.expenseId);
    assert.equal(
      allocationData.withdrawalTransactionId,
      result.sharedStashTransactionId
    );
    assert.equal(allocationData.amountMinor, 200);
    assert.equal(allocationData.currency, "USD");
    assert.equal(allocationData.provenance, "original");
    assert.deepEqual(allocationData.allocations, [
      {uid: FRIEND_UID, amountMinor: 20},
      {uid: OWNER_UID, amountMinor: 180},
    ]);
    assert.ok(allocationData.createdAt, "expected createdAt to be set");
  });

  it("odd-cent tie: A=1,B=1,C=1, expense=1 -> ascending uid wins", async () => {
    await seedTrip(initializedOverrides(3));
    await seedOwnership(TRIP_ID, "a", 1);
    await seedOwnership(TRIP_ID, "b", 1);
    await seedOwnership(TRIP_ID, "c", 1);

    const result = await recordSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseRequest({amountMinor: 1})
    );

    assert.equal(await getOwnership("a"), 0);
    assert.equal(await getOwnership("b"), 1);
    assert.equal(await getOwnership("c"), 1);

    const allocationSnap = await db
      .collection("tripOwnershipAllocations")
      .doc(result.sharedStashTransactionId)
      .get();
    assert.deepEqual(allocationSnap.data()!.allocations, [
      {uid: "a", amountMinor: 1},
    ]);
  });

  it("full depletion: every participating row becomes zero but remains present", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, OWNER_UID, 900);
    await seedOwnership(TRIP_ID, FRIEND_UID, 100);

    await recordSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseRequest({amountMinor: 1000})
    );

    assert.equal(await getOwnership(OWNER_UID), 0);
    assert.equal(await getOwnership(FRIEND_UID), 0);
    const ownerSnap = await db
      .collection("tripMemberOwnership")
      .doc(ownershipId(TRIP_ID, OWNER_UID))
      .get();
    assert.equal(ownerSnap.exists, true);
  });

  it("a zero-ownership member gets no allocation entry and remains zero, untouched", async () => {
    await seedTrip(initializedOverrides(100));
    await seedOwnership(TRIP_ID, OWNER_UID, 0);
    await seedOwnership(TRIP_ID, FRIEND_UID, 100);

    const result = await recordSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseRequest({amountMinor: 50})
    );

    assert.equal(await getOwnership(OWNER_UID), 0);
    assert.equal(await getOwnership(FRIEND_UID), 50);
    const allocationSnap = await db
      .collection("tripOwnershipAllocations")
      .doc(result.sharedStashTransactionId)
      .get();
    assert.deepEqual(allocationSnap.data()!.allocations, [
      {uid: FRIEND_UID, amountMinor: 50},
    ]);
  });

  it("exactly one immutable allocation document is ever created per expense", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, OWNER_UID, 1000);

    const result = await recordSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseRequest({amountMinor: 100})
    );
    const snap = await db.collection("tripOwnershipAllocations").get();
    assert.equal(snap.size, 1);
    assert.equal(snap.docs[0].id, result.sharedStashTransactionId);
  });

  it("expense amount exceeding a RECONCILED total ownership rejects as genuine insufficient funds, Trip stays initialized (Checkpoint 5B.3A, item 6)", async () => {
    // Checkpoint 5B.3A, item 6: aggregate and ownership total are
    // EQUAL (100 == 100) - this must be a true insufficient-ownership
    // rejection, never a reconciliation-drift one. The earlier version
    // of this test used aggregate=1000 against ownership=100, which
    // triggers drift FIRST (see the dedicated drift tests below) and
    // never actually exercised this path.
    await seedTrip(initializedOverrides(100));
    await seedOwnership(TRIP_ID, OWNER_UID, 100);
    const request = baseRequest({amountMinor: 101});

    await assertRejectsWithCode(
      recordSharedStashExpenseCore(db, MEMBER_UID, request),
      "failed-precondition"
    );
    assert.equal(await getOwnership(OWNER_UID), 100);
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.ledgerBalanceMinor, 100);
    assert.equal(tripSnap.data()?.ownershipModelState, "initialized");
    const expenseSnap = await db
      .collection("tripExpenses")
      .doc(request.clientRequestId as string)
      .get();
    assert.equal(expenseSnap.exists, false);
    const withdrawals = await db.collection("savingsTransactions").get();
    assert.equal(withdrawals.size, 0);
    const allocations = await db.collection("tripOwnershipAllocations").get();
    assert.equal(allocations.size, 0);
  });

  it("idempotent replay creates no second allocation document and does not double-deplete", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, OWNER_UID, 900);
    await seedOwnership(TRIP_ID, FRIEND_UID, 100);
    const request = baseRequest({amountMinor: 200});

    const first = await recordSharedStashExpenseCore(db, MEMBER_UID, request);
    assert.equal(await getOwnership(OWNER_UID), 720);

    const second = await recordSharedStashExpenseCore(
      db,
      MEMBER_UID,
      request
    );
    assert.deepEqual(second, first);
    assert.equal(await getOwnership(OWNER_UID), 720);
    assert.equal(await getOwnership(FRIEND_UID), 80);
    const snap = await db.collection("tripOwnershipAllocations").get();
    assert.equal(snap.size, 1);
  });
});

describe("initialized Shared-Stash Expense - allocation-document collision (Checkpoint 5B.3A, item 1)", () => {
  it("a pre-existing allocation document at the canonical id fails closed for a genuinely new request, byte-for-byte unchanged", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, OWNER_UID, 900);
    await seedOwnership(TRIP_ID, FRIEND_UID, 100);

    const request = baseRequest({amountMinor: 200});
    const withdrawalId = expectedWithdrawalId(
      request.clientRequestId as string
    );
    const staleAllocation = {
      tripId: "some-other-trip",
      expenseId: "some-stale-expense",
      withdrawalTransactionId: withdrawalId,
      amountMinor: 9999,
      currency: "USD",
      allocations: [{uid: "nobody", amountMinor: 9999}],
      provenance: "original",
      createdAt: Timestamp.now(),
    };
    await db
      .collection("tripOwnershipAllocations")
      .doc(withdrawalId)
      .set(staleAllocation);

    await assertRejectsWithCode(
      recordSharedStashExpenseCore(db, MEMBER_UID, request),
      "failed-precondition"
    );

    // The pre-existing (stale/conflicting) allocation document is
    // byte-for-byte unchanged - never overwritten, never merged.
    const allocationSnap = await db
      .collection("tripOwnershipAllocations")
      .doc(withdrawalId)
      .get();
    assert.deepEqual(allocationSnap.data(), staleAllocation);
    const allAllocations = await db.collection("tripOwnershipAllocations").get();
    assert.equal(allAllocations.size, 1);

    // No Expense, no withdrawal SavingsTransaction, aggregate/ownership
    // unchanged.
    const expenseSnap = await db
      .collection("tripExpenses")
      .doc(request.clientRequestId as string)
      .get();
    assert.equal(expenseSnap.exists, false);
    const withdrawalSnap = await db
      .collection("savingsTransactions")
      .doc(withdrawalId)
      .get();
    assert.equal(withdrawalSnap.exists, false);
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.ledgerBalanceMinor, 1000);
    assert.equal(await getOwnership(OWNER_UID), 900);
    assert.equal(await getOwnership(FRIEND_UID), 100);
  });
});

describe("initialized Shared-Stash Expense - canonical ownership document identity (Checkpoint 5B.3A, item 5)", () => {
  it("a noncanonical document id with otherwise-valid fields is rejected, never trusted as ownership state", async () => {
    await seedTrip(initializedOverrides(100));
    // Deliberately written at a NONCANONICAL document id - correct
    // tripId/uid/ownershipMinor fields, but the id itself is not
    // tripMemberOwnershipId(TRIP_ID, OWNER_UID).
    await db.collection("tripMemberOwnership").doc("rogue-doc-id").set({
      tripId: TRIP_ID,
      uid: OWNER_UID,
      ownershipMinor: 100,
      lastUpdatedAt: new Date(),
    });
    const request = baseRequest({amountMinor: 50});

    await assertRejectsWithCode(
      recordSharedStashExpenseCore(db, MEMBER_UID, request),
      "failed-precondition"
    );
    const expenseSnap = await db
      .collection("tripExpenses")
      .doc(request.clientRequestId as string)
      .get();
    assert.equal(expenseSnap.exists, false);
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.ledgerBalanceMinor, 100);
  });

  it("a duplicate canonical + rogue row for the SAME uid fails closed rather than combining or ignoring either", async () => {
    await seedTrip(initializedOverrides(100));
    await seedOwnership(TRIP_ID, OWNER_UID, 100);
    // A SECOND, noncanonical document also claiming to be OWNER_UID's
    // ownership row on this same Trip.
    await db.collection("tripMemberOwnership").doc("rogue-duplicate").set({
      tripId: TRIP_ID,
      uid: OWNER_UID,
      ownershipMinor: 100,
      lastUpdatedAt: new Date(),
    });
    const request = baseRequest({amountMinor: 50});

    await assertRejectsWithCode(
      recordSharedStashExpenseCore(db, MEMBER_UID, request),
      "failed-precondition"
    );
    assert.equal(await getOwnership(OWNER_UID), 100);
    const expenseSnap = await db
      .collection("tripExpenses")
      .doc(request.clientRequestId as string)
      .get();
    assert.equal(expenseSnap.exists, false);
  });
});

describe("initialized Shared-Stash Expense - reconciliation-drift handling", () => {
  it("a genuine aggregate-vs-ownership mismatch is rejected and the Trip moves to needs_reconciliation, with no financial mutation", async () => {
    // Aggregate says 1000, but ownership rows only sum to 900 - a
    // deliberate, contrived drift to exercise the reconciliation check.
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, OWNER_UID, 900);
    const request = baseRequest({amountMinor: 100});

    await assertRejectsWithCode(
      recordSharedStashExpenseCore(db, MEMBER_UID, request),
      "failed-precondition"
    );

    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.ownershipModelState, "needs_reconciliation");
    assert.equal(
      tripSnap.data()?.ownershipModelVersion,
      CURRENT_TRIP_OWNERSHIP_MODEL_VERSION
    );
    // Aggregate itself is untouched by the rejected expense.
    assert.equal(tripSnap.data()?.ledgerBalanceMinor, 1000);
    assert.equal(await getOwnership(OWNER_UID), 900);

    const expenseSnap = await db
      .collection("tripExpenses")
      .doc(request.clientRequestId as string)
      .get();
    assert.equal(expenseSnap.exists, false);
    const allocationSnap = await db.collection("tripOwnershipAllocations").get();
    assert.equal(allocationSnap.size, 0);
  });

  it("a zero-ownership-row Trip with a nonzero aggregate is also treated as drift", async () => {
    await seedTrip(initializedOverrides(500));
    // No ownership rows at all.
    const request = baseRequest({amountMinor: 100});

    await assertRejectsWithCode(
      recordSharedStashExpenseCore(db, MEMBER_UID, request),
      "failed-precondition"
    );
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.ownershipModelState, "needs_reconciliation");
  });

  it("a zero-ownership Trip with a genuinely zero aggregate rejects as unfundable, WITHOUT flagging reconciliation", async () => {
    await seedTrip(initializedOverrides(0));
    const request = baseRequest({amountMinor: 100});

    await assertRejectsWithCode(
      recordSharedStashExpenseCore(db, MEMBER_UID, request),
      "failed-precondition"
    );
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.ownershipModelState, "initialized");
  });
});

// ---------------------------------------------------------------------
// Migrating / needs_reconciliation (Checkpoint 5B.3, items 22/28/29)
// ---------------------------------------------------------------------

describe("migrating - every new Shared-Stash Expense rejects", () => {
  it("rejects a new expense, no writes", async () => {
    await seedTrip({ownershipModelState: "migrating"});
    const request = baseRequest();
    await assertRejectsWithCode(
      recordSharedStashExpenseCore(db, MEMBER_UID, request),
      "failed-precondition"
    );
    const expenseSnap = await db
      .collection("tripExpenses")
      .doc(request.clientRequestId as string)
      .get();
    assert.equal(expenseSnap.exists, false);
  });

  it("an exact replay of an already-committed expense survives the Trip later entering migrating", async () => {
    await seedTrip();
    const request = baseRequest({amountMinor: 300});
    const first = await recordSharedStashExpenseCore(
      db,
      MEMBER_UID,
      request
    );

    await db
      .collection("trips")
      .doc(TRIP_ID)
      .update({ownershipModelState: "migrating"});

    const replay = await recordSharedStashExpenseCore(
      db,
      MEMBER_UID,
      request
    );
    assert.deepEqual(replay, first);

    await assertRejectsWithCode(
      recordSharedStashExpenseCore(db, MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
  });
});

describe("needs_reconciliation - every new Shared-Stash Expense rejects, identically to migrating", () => {
  it("rejects a new expense, no writes", async () => {
    await seedTrip({
      ownershipModelState: "needs_reconciliation",
      ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
    });
    const request = baseRequest();
    await assertRejectsWithCode(
      recordSharedStashExpenseCore(db, MEMBER_UID, request),
      "failed-precondition"
    );
  });

  it("an exact replay of an already-committed expense survives the Trip later needing reconciliation (Checkpoint 5B.3A, item 2)", async () => {
    await seedTrip();
    const request = baseRequest({amountMinor: 300});
    const first = await recordSharedStashExpenseCore(
      db,
      MEMBER_UID,
      request
    );

    await db
      .collection("trips")
      .doc(TRIP_ID)
      .update({
        ownershipModelState: "needs_reconciliation",
        ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
      });

    const replay = await recordSharedStashExpenseCore(
      db,
      MEMBER_UID,
      request
    );
    assert.deepEqual(replay, first);

    await assertRejectsWithCode(
      recordSharedStashExpenseCore(db, MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
  });
});

// ---------------------------------------------------------------------
// Conflicting idempotency payload during quiescence (Checkpoint
// 5B.3A, item 3) - a reused clientRequestId with a CONFLICTING payload
// must never be treated as exact replay, in EITHER quiescence state,
// and must never mutate anything.
// ---------------------------------------------------------------------

describe("conflicting Shared-Stash Expense payload during quiescence never counts as replay", () => {
  for (const state of ["migrating", "needs_reconciliation"] as const) {
    it(`a reused clientRequestId with a different amountMinor rejects while ${state}`, async () => {
      await seedTrip();
      const request = baseRequest({amountMinor: 300});
      await recordSharedStashExpenseCore(db, MEMBER_UID, request);

      await db
        .collection("trips")
        .doc(TRIP_ID)
        .update({
          ownershipModelState: state,
          ...(state === "needs_reconciliation" ?
            {ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION} :
            {}),
        });

      const conflictingRequest = {...request, amountMinor: 301};
      await assertRejectsWithCode(
        recordSharedStashExpenseCore(db, MEMBER_UID, conflictingRequest),
        "already-exists"
      );

      const expenses = await db.collection("tripExpenses").get();
      assert.equal(expenses.size, 1);
    });
  }
});

// ---------------------------------------------------------------------
// Corrupt / unsupported state (Checkpoint 5B.3, item 30)
// ---------------------------------------------------------------------

describe("corrupt / unsupported ownership model state - fails closed", () => {
  it("initialized with an unsupported version rejects", async () => {
    await seedTrip(
      initializedOverrides(1000, {ownershipModelVersion: 999})
    );
    await assertRejectsWithCode(
      recordSharedStashExpenseCore(db, MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
  });

  it("an unknown state string rejects", async () => {
    await seedTrip({ownershipModelState: "bogus"});
    await assertRejectsWithCode(
      recordSharedStashExpenseCore(db, MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
  });
});
