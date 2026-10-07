// Tests for recordSharedStashExpenseCore against the local Firestore
// emulator via the Admin SDK - never production, guarded below. Run via
// `npm --prefix functions test`, wrapped in
// `firebase emulators:exec --only firestore "..."` so
// FIRESTORE_EMULATOR_HOST is set automatically (the same mechanism
// recordTripExpenseCore.ts/recordSavingsTransactionCore.ts already rely
// on).
//
// Checkpoint 4F.1 coverage (docs/audits/
// TRIP_SHARED_STASH_EXPENSE_PREFLIGHT_2026-09-30.md, as corrected by its
// 4F.0A amendment), extended by Checkpoint 4F.4A's own correction-link
// (replacesExpenseId/replacedByExpenseId) coverage near the end of this
// file - full reversal coverage lives in reverseSharedStashExpenseCore.ts;
// reverseSharedStashExpenseCore is imported here ONLY to build realistic
// "already-reversed" fixtures for the correction tests.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import type { App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import type { CallableRequest } from "firebase-functions/v2/https";
import {
  recordSharedStashExpenseCore,
  requireAuthenticatedUid,
} from "../src/callables/recordSharedStashExpense";
import { reverseSharedStashExpenseCore } from "../src/callables/reverseSharedStashExpense";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "FIRESTORE_EMULATOR_HOST is not set. Run these tests via " +
      '`firebase emulators:exec --only firestore "npm --prefix functions test"` ' +
      "so the Admin SDK talks to the local emulator, never production."
  );
}

const OWNER_UID = "owner-uid";
const MEMBER_UID = "member-uid";
const OTHER_MEMBER_UID = "other-member-uid";
const OUTSIDER_UID = "outsider-uid";
const TRIP_ID = "test-trip";

let app: App;
let db: Firestore;

before(() => {
  // A distinct "demo-" project id from every other functions test file's
  // own test app - Node's test runner executes test FILES concurrently by
  // default, so sharing a project id would let this file's per-test
  // clearFirestore() race with and wipe out documents a concurrently-
  // running suite just seeded (and vice versa).
  app = initializeApp({
    projectId: "demo-squadstash-functions-test-shared-stash-expense",
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
    "tripExpenseSplits",
    "savingsTransactions",
  ]) {
    const snap = await db.collection(name).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

beforeEach(async () => {
  await clearFirestore();
});

// Deliberately carries NO ledgerOpeningBalanceMinor/ledgerBalanceMinor by
// default - a bare seedTrip() is therefore a legacy/uninitialized Trip
// (saved: 100 -> legacy-derived 10000 minor on first write), matching
// recordSavingsTransactionCore.ts's own seedTrip/seedBucket convention
// exactly. Tests that need an ALREADY-initialized Trip pass
// ledgerOpeningBalanceMinor/ledgerBalanceMinor explicitly as overrides.
function seedTrip(
  overrides: Record<string, unknown> = {}
): Promise<FirebaseFirestore.WriteResult> {
  return db
    .collection("trips")
    .doc(TRIP_ID)
    .set({
      ownerId: OWNER_UID,
      memberIds: [OWNER_UID, MEMBER_UID, OTHER_MEMBER_UID],
      title: "Test Trip",
      location: "Somewhere",
      target: 1000,
      saved: 100,
      imageUrl: "https://example.com/trip.jpg",
      tripStartDate: "2027-06-12",
      ...overrides,
    });
}

function baseRequest(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    tripId: TRIP_ID,
    amountMinor: 2000,
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

async function assertNoWrites(): Promise<void> {
  const [expenses, withdrawals, splits] = await Promise.all([
    db.collection("tripExpenses").get(),
    db.collection("savingsTransactions").get(),
    db.collection("tripExpenseSplits").get(),
  ]);
  assert.equal(expenses.size, 0, "expected zero tripExpenses writes");
  assert.equal(
    withdrawals.size,
    0,
    "expected zero savingsTransactions writes"
  );
  assert.equal(splits.size, 0, "expected zero tripExpenseSplits writes");
}

// Independent reproduction of the callable's own deterministic withdrawal
// id derivation (duplicated here deliberately, matching this package's
// existing "duplicate small primitives per test/callable" convention) -
// used only to assert the production code's actual output, never imported
// from production source.
function expectedWithdrawalId(clientRequestId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([clientRequestId, "shared-stash-withdrawal"]), "utf8")
    .digest("hex");
}

describe("recordSharedStashExpenseCore - requireAuthenticatedUid", () => {
  it("throws unauthenticated when auth is absent", () => {
    assert.throws(
      () => requireAuthenticatedUid(undefined as unknown as CallableRequest["auth"]),
      (err: unknown) => {
        assert.ok(err instanceof HttpsError);
        assert.equal((err as HttpsError).code, "unauthenticated");
        return true;
      }
    );
  });

  it("returns uid when auth is present", () => {
    assert.equal(
      requireAuthenticatedUid({ uid: MEMBER_UID } as CallableRequest["auth"]),
      MEMBER_UID
    );
  });
});

describe("recordSharedStashExpenseCore - successful create (initialized Trip)", () => {
  it("1. creates the Expense with the correct server-derived shape", async () => {
    await seedTrip();
    const result = await recordSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseRequest()
    );

    const expenseSnap = await db
      .collection("tripExpenses")
      .doc(result.expenseId)
      .get();
    const expense = expenseSnap.data()!;
    assert.equal(expense.paymentSource, "shared_stash");
    assert.equal(expense.payerUid, null);
    assert.equal(expense.createdBy, MEMBER_UID);
    assert.equal(expense.status, "active");
    assert.equal(expense.amountMinor, 2000);
    assert.equal(expense.currency, "USD");
    assert.equal(expense.description, "Groceries for the cabin");
    assert.equal(expense.sharedStashTransactionId, result.sharedStashTransactionId);
  });

  it("2. the linked withdrawal exists with the correct Trip resource fields and amount", async () => {
    await seedTrip();
    const result = await recordSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseRequest({ amountMinor: 1500 })
    );

    const withdrawalSnap = await db
      .collection("savingsTransactions")
      .doc(result.sharedStashTransactionId)
      .get();
    assert.ok(withdrawalSnap.exists, "expected the linked withdrawal to exist");
    const withdrawal = withdrawalSnap.data()!;
    assert.equal(withdrawal.resourceType, "trip");
    assert.equal(withdrawal.resourceId, TRIP_ID);
    assert.equal(withdrawal.type, "withdrawal");
    assert.equal(withdrawal.amountMinor, 1500);
    assert.equal(withdrawal.currency, "USD");
    assert.equal(withdrawal.reversalOf, null);
  });

  it("3. the withdrawal has correct server attribution and linkedExpenseId", async () => {
    await seedTrip();
    const result = await recordSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseRequest()
    );
    const withdrawalSnap = await db
      .collection("savingsTransactions")
      .doc(result.sharedStashTransactionId)
      .get();
    const withdrawal = withdrawalSnap.data()!;
    assert.equal(withdrawal.memberUid, MEMBER_UID);
    assert.equal(withdrawal.recordedBy, MEMBER_UID);
    assert.equal(withdrawal.linkedExpenseId, result.expenseId);
  });

  it("4. the Trip's canonical balance decreases exactly once", async () => {
    await seedTrip({ ledgerOpeningBalanceMinor: 10000, ledgerBalanceMinor: 10000 });
    await recordSharedStashExpenseCore(db, MEMBER_UID, baseRequest({ amountMinor: 2500 }));

    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()!.ledgerBalanceMinor, 7500);
  });

  it("5. saved/ledger cache fields remain canonical after create", async () => {
    await seedTrip({ ledgerOpeningBalanceMinor: 10000, ledgerBalanceMinor: 10000 });
    await recordSharedStashExpenseCore(db, MEMBER_UID, baseRequest({ amountMinor: 2500 }));

    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    const data = tripSnap.data()!;
    assert.equal(data.saved, 75); // 7500 minor -> $75.00
    assert.equal(data.ledgerOpeningBalanceMinor, 10000); // unchanged, already initialized
    assert.equal(data.lastUpdatedBy, MEMBER_UID);
  });

  it("6. zero tripExpenseSplits documents are created", async () => {
    await seedTrip();
    await recordSharedStashExpenseCore(db, MEMBER_UID, baseRequest());
    const splitsSnap = await db.collection("tripExpenseSplits").get();
    assert.equal(splitsSnap.size, 0);
  });

  it("7. any current member (not only ownerId) may create", async () => {
    await seedTrip();
    const result = await recordSharedStashExpenseCore(
      db,
      OTHER_MEMBER_UID,
      baseRequest()
    );
    const expenseSnap = await db.collection("tripExpenses").doc(result.expenseId).get();
    assert.equal(expenseSnap.data()!.createdBy, OTHER_MEMBER_UID);
  });
});

describe("recordSharedStashExpenseCore - deterministic withdrawal id", () => {
  it("8. the same clientRequestId always derives the same expected withdrawal id", async () => {
    await seedTrip();
    const clientRequestId = randomUUID();
    const result = await recordSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseRequest({ clientRequestId })
    );
    assert.equal(
      result.sharedStashTransactionId,
      expectedWithdrawalId(clientRequestId)
    );
  });
});

describe("recordSharedStashExpenseCore - idempotent exact replay", () => {
  it("9. an exact replay succeeds idempotently with unchanged counts/balance", async () => {
    await seedTrip({ ledgerOpeningBalanceMinor: 10000, ledgerBalanceMinor: 10000 });
    const request = baseRequest({ amountMinor: 2500 });

    const first = await recordSharedStashExpenseCore(db, MEMBER_UID, request);
    const second = await recordSharedStashExpenseCore(db, MEMBER_UID, request);

    assert.deepEqual(first, second);

    const [expenses, withdrawals] = await Promise.all([
      db.collection("tripExpenses").get(),
      db.collection("savingsTransactions").get(),
    ]);
    assert.equal(expenses.size, 1);
    assert.equal(withdrawals.size, 1);

    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()!.ledgerBalanceMinor, 7500); // only decremented once
  });
});

// Checkpoint 4F.1A: a genuine first-call creation is built via the real
// recordSharedStashExpenseCore (so every other field is fully realistic),
// then ONE field on the already-committed withdrawal or Expense document
// is corrupted directly via the Admin SDK - simulating drift/a bug/an
// out-of-band write - before replaying the IDENTICAL original request.
// Each case must reject (failed-precondition) rather than silently
// reconciling as success, and must perform no second withdrawal and no
// further Trip balance mutation.
describe("recordSharedStashExpenseCore - corrupted replay-link detection", () => {
  async function createThenCorruptWithdrawal(
    overrides: Record<string, unknown>
  ): Promise<{
    request: Record<string, unknown>;
    tripBalanceAfterFirstCreate: number;
  }> {
    await seedTrip({ ledgerOpeningBalanceMinor: 10000, ledgerBalanceMinor: 10000 });
    const request = baseRequest({ amountMinor: 2000 });
    const result = await recordSharedStashExpenseCore(db, MEMBER_UID, request);

    const withdrawalRef = db
      .collection("savingsTransactions")
      .doc(result.sharedStashTransactionId);
    const withdrawalData = (await withdrawalRef.get()).data()!;
    await withdrawalRef.set({ ...withdrawalData, ...overrides });

    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    return {
      request,
      tripBalanceAfterFirstCreate: tripSnap.data()!.ledgerBalanceMinor,
    };
  }

  async function assertReplayRejectedWithoutFurtherMutation(
    request: Record<string, unknown>,
    tripBalanceAfterFirstCreate: number
  ): Promise<void> {
    await assertRejectsWithCode(
      recordSharedStashExpenseCore(db, MEMBER_UID, request),
      "failed-precondition"
    );
    const withdrawals = await db.collection("savingsTransactions").get();
    assert.equal(withdrawals.size, 1, "expected no second withdrawal");
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(
      tripSnap.data()!.ledgerBalanceMinor,
      tripBalanceAfterFirstCreate,
      "expected no further Trip balance mutation"
    );
  }

  it("1. wrong withdrawal amount is rejected on replay", async () => {
    const { request, tripBalanceAfterFirstCreate } =
      await createThenCorruptWithdrawal({ amountMinor: 9999 });
    await assertReplayRejectedWithoutFurtherMutation(
      request,
      tripBalanceAfterFirstCreate
    );
  });

  it("2. wrong resourceId is rejected on replay", async () => {
    const { request, tripBalanceAfterFirstCreate } =
      await createThenCorruptWithdrawal({ resourceId: "some-other-trip" });
    await assertReplayRejectedWithoutFurtherMutation(
      request,
      tripBalanceAfterFirstCreate
    );
  });

  it("3. wrong transaction type is rejected on replay", async () => {
    const { request, tripBalanceAfterFirstCreate } =
      await createThenCorruptWithdrawal({ type: "contribution" });
    await assertReplayRejectedWithoutFurtherMutation(
      request,
      tripBalanceAfterFirstCreate
    );
  });

  it("4. wrong currency is rejected on replay", async () => {
    const { request, tripBalanceAfterFirstCreate } =
      await createThenCorruptWithdrawal({ currency: "EUR" });
    await assertReplayRejectedWithoutFurtherMutation(
      request,
      tripBalanceAfterFirstCreate
    );
  });

  it("5a. wrong linkedExpenseId is rejected on replay", async () => {
    const { request, tripBalanceAfterFirstCreate } =
      await createThenCorruptWithdrawal({ linkedExpenseId: "some-other-expense" });
    await assertReplayRejectedWithoutFurtherMutation(
      request,
      tripBalanceAfterFirstCreate
    );
  });

  it("5b. missing linkedExpenseId is rejected on replay", async () => {
    await seedTrip({ ledgerOpeningBalanceMinor: 10000, ledgerBalanceMinor: 10000 });
    const request = baseRequest({ amountMinor: 2000 });
    const result = await recordSharedStashExpenseCore(db, MEMBER_UID, request);

    const withdrawalRef = db
      .collection("savingsTransactions")
      .doc(result.sharedStashTransactionId);
    const withdrawalData = (await withdrawalRef.get()).data()!;
    delete withdrawalData.linkedExpenseId;
    await withdrawalRef.set(withdrawalData);

    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    await assertReplayRejectedWithoutFurtherMutation(
      request,
      tripSnap.data()!.ledgerBalanceMinor
    );
  });

  it("6. Expense with a wrong sharedStashTransactionId is rejected on replay", async () => {
    await seedTrip({ ledgerOpeningBalanceMinor: 10000, ledgerBalanceMinor: 10000 });
    const request = baseRequest({ amountMinor: 2000 });
    const result = await recordSharedStashExpenseCore(db, MEMBER_UID, request);

    const expenseRef = db.collection("tripExpenses").doc(result.expenseId);
    const expenseData = (await expenseRef.get()).data()!;
    await expenseRef.set({
      ...expenseData,
      sharedStashTransactionId: "some-other-withdrawal-id",
    });

    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    await assertReplayRejectedWithoutFurtherMutation(
      request,
      tripSnap.data()!.ledgerBalanceMinor
    );
  });
});

describe("recordSharedStashExpenseCore - different-request collision", () => {
  it("10. reusing clientRequestId with a changed amount rejects as already-exists", async () => {
    await seedTrip({ ledgerOpeningBalanceMinor: 10000, ledgerBalanceMinor: 10000 });
    const clientRequestId = randomUUID();
    await recordSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseRequest({ clientRequestId, amountMinor: 1000 })
    );

    await assertRejectsWithCode(
      recordSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseRequest({ clientRequestId, amountMinor: 2000 })
      ),
      "already-exists"
    );

    const withdrawals = await db.collection("savingsTransactions").get();
    assert.equal(withdrawals.size, 1); // no second withdrawal

    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()!.ledgerBalanceMinor, 9000); // only the first applied
  });

  it("11. a different authenticated caller reusing clientRequestId rejects as already-exists", async () => {
    await seedTrip();
    const clientRequestId = randomUUID();
    await recordSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseRequest({ clientRequestId })
    );
    await assertRejectsWithCode(
      recordSharedStashExpenseCore(
        db,
        OTHER_MEMBER_UID,
        baseRequest({ clientRequestId })
      ),
      "already-exists"
    );
  });
});

describe("recordSharedStashExpenseCore - insufficient funds", () => {
  it("12. rejects and writes nothing when the withdrawal would go negative (initialized Trip)", async () => {
    await seedTrip({ ledgerOpeningBalanceMinor: 1000, ledgerBalanceMinor: 1000 });
    await assertRejectsWithCode(
      recordSharedStashExpenseCore(db, MEMBER_UID, baseRequest({ amountMinor: 1500 })),
      "failed-precondition"
    );
    await assertNoWrites();
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()!.ledgerBalanceMinor, 1000); // unchanged
  });

  it("13. rejects when the withdrawal would go negative from a freshly-legacy-derived balance", async () => {
    await seedTrip({ saved: 10 }); // -> 1000 minor, no ledger fields yet
    await assertRejectsWithCode(
      recordSharedStashExpenseCore(db, MEMBER_UID, baseRequest({ amountMinor: 1500 })),
      "failed-precondition"
    );
    await assertNoWrites();
    // Legacy init must not have been persisted on a rejected transaction.
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal("ledgerBalanceMinor" in tripSnap.data()!, false);
  });
});

describe("recordSharedStashExpenseCore - unauthorized caller", () => {
  it("14. a non-member is rejected and nothing is written", async () => {
    await seedTrip();
    await assertRejectsWithCode(
      recordSharedStashExpenseCore(db, OUTSIDER_UID, baseRequest()),
      "permission-denied"
    );
    await assertNoWrites();
  });
});

describe("recordSharedStashExpenseCore - archived Trip", () => {
  it("15. a current member on an archived Trip is rejected and nothing is written", async () => {
    await seedTrip({ archivedAt: new Date(), archivedBy: OWNER_UID });
    await assertRejectsWithCode(
      recordSharedStashExpenseCore(db, MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
    await assertNoWrites();
  });
});

describe("recordSharedStashExpenseCore - legacy/uninitialized Trip", () => {
  it("16. derives the correct legacy opening balance and initializes the ledger", async () => {
    await seedTrip({ saved: 50 }); // -> 5000 minor, no ledger fields yet
    const result = await recordSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseRequest({ amountMinor: 1500 })
    );

    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    const data = tripSnap.data()!;
    assert.equal(data.ledgerOpeningBalanceMinor, 5000);
    assert.equal(data.ledgerBalanceMinor, 3500); // 5000 - 1500
    assert.equal(data.saved, 35);

    const withdrawalSnap = await db
      .collection("savingsTransactions")
      .doc(result.sharedStashTransactionId)
      .get();
    assert.ok(withdrawalSnap.exists);
  });

  it("17. existing savingsTransactions history with no ledger init fields fails", async () => {
    await seedTrip({ saved: 50 });
    // Simulate a historical/admin-created ledger record predating any
    // ledger initialization on the parent Trip.
    await db.collection("savingsTransactions").doc("legacy-record").set({
      resourceType: "trip",
      resourceId: TRIP_ID,
      memberUid: MEMBER_UID,
      recordedBy: MEMBER_UID,
      amountMinor: 100,
      currency: "USD",
      type: "contribution",
      createdAt: new Date(),
      reversalOf: null,
    });
    await assertRejectsWithCode(
      recordSharedStashExpenseCore(db, MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
  });
});

// seedTrip() always sets BOTH ledger fields together by default - these
// two tests need a Trip document carrying exactly ONE of them, so they
// build the document directly rather than going through seedTrip's
// merged-overrides shape (which cannot selectively omit a field the
// defaults already include).
function seedTripWithExactFields(
  fields: Record<string, unknown>
): Promise<FirebaseFirestore.WriteResult> {
  return db.collection("trips").doc(TRIP_ID).set(fields);
}

describe("recordSharedStashExpenseCore - corrupt partial ledger state", () => {
  it("18. opening-only (no ledgerBalanceMinor) rejects and writes nothing", async () => {
    await seedTripWithExactFields({
      ownerId: OWNER_UID,
      memberIds: [OWNER_UID, MEMBER_UID, OTHER_MEMBER_UID],
      title: "Test Trip",
      saved: 50,
      ledgerOpeningBalanceMinor: 5000,
    });
    const snap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal("ledgerBalanceMinor" in snap.data()!, false);

    await assertRejectsWithCode(
      recordSharedStashExpenseCore(db, MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
    await assertNoWrites();
  });

  it("19. balance-only (no ledgerOpeningBalanceMinor) rejects and writes nothing", async () => {
    await seedTripWithExactFields({
      ownerId: OWNER_UID,
      memberIds: [OWNER_UID, MEMBER_UID, OTHER_MEMBER_UID],
      title: "Test Trip",
      saved: 50,
      ledgerBalanceMinor: 5000,
    });
    const snap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal("ledgerOpeningBalanceMinor" in snap.data()!, false);

    await assertRejectsWithCode(
      recordSharedStashExpenseCore(db, MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
    await assertNoWrites();
  });
});

describe("recordSharedStashExpenseCore - currency", () => {
  it("20. a non-USD request currency is rejected at input validation", async () => {
    await seedTrip();
    await assertRejectsWithCode(
      recordSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseRequest({ currency: "EUR" })
      ),
      "invalid-argument"
    );
    await assertNoWrites();
  });

  it("21. a USD request against a Trip with a malformed currency field rejects", async () => {
    await seedTrip({ currency: "" });
    await assertRejectsWithCode(
      recordSharedStashExpenseCore(db, MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
    await assertNoWrites();
  });
});

describe("recordSharedStashExpenseCore - client cannot control server-derived fields", () => {
  it("22. an attempt to pass paymentSource is rejected outright", async () => {
    await seedTrip();
    await assertRejectsWithCode(
      recordSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseRequest({ paymentSource: "shared_stash" })
      ),
      "invalid-argument"
    );
  });

  it("23. an attempt to pass sharedStashTransactionId is rejected outright", async () => {
    await seedTrip();
    await assertRejectsWithCode(
      recordSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseRequest({ sharedStashTransactionId: "forged-id" })
      ),
      "invalid-argument"
    );
  });

  it("24. an attempt to pass createdBy is rejected outright", async () => {
    await seedTrip();
    await assertRejectsWithCode(
      recordSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseRequest({ createdBy: OTHER_MEMBER_UID })
      ),
      "invalid-argument"
    );
  });

  it("25. an attempt to pass payerUid is rejected outright", async () => {
    await seedTrip();
    await assertRejectsWithCode(
      recordSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseRequest({ payerUid: MEMBER_UID })
      ),
      "invalid-argument"
    );
  });
});

describe("recordSharedStashExpenseCore - atomic failure leaves no partial state", () => {
  it("26. a rejected creation (archived Trip) leaves zero Expense/withdrawal/Trip-mutation side effects", async () => {
    await seedTrip({
      archivedAt: new Date(),
      archivedBy: OWNER_UID,
      ledgerOpeningBalanceMinor: 10000,
      ledgerBalanceMinor: 10000,
    });
    await assertRejectsWithCode(
      recordSharedStashExpenseCore(db, MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
    await assertNoWrites();
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()!.ledgerBalanceMinor, 10000);
    assert.equal(tripSnap.data()!.saved, 100);
  });

  it("27. a rejected creation (insufficient funds) leaves the linked withdrawal id unused for a later legitimate request", async () => {
    await seedTrip({ ledgerOpeningBalanceMinor: 100, ledgerBalanceMinor: 100 });
    const clientRequestId = randomUUID();
    await assertRejectsWithCode(
      recordSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseRequest({ clientRequestId, amountMinor: 5000 })
      ),
      "failed-precondition"
    );
    await assertNoWrites();

    // The SAME clientRequestId can still be used for a legitimate request
    // later (e.g. after the Shared Stash receives more funds) - a rejected
    // attempt must not have poisoned the deterministic id.
    await db.collection("trips").doc(TRIP_ID).update({ ledgerBalanceMinor: 10000 });
    const result = await recordSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseRequest({ clientRequestId, amountMinor: 5000 })
    );
    assert.equal(result.expenseId, clientRequestId);
  });
});

// Checkpoint 4F.4A: Shared-Stash Expense correction (reverse-then-create)
// mirrors recordTripExpense.ts's own replacesExpenseId/replacedByExpenseId
// correction-link model exactly. Builds genuine "already-reversed shared
// stash Expense" fixtures via the real create+reverse callables (never
// hand-seeded), so every field is exactly what production would produce.
async function createAndReverseSharedStashExpense(
  creatorUid: string,
  reverserUid: string,
  amountMinor = 2000
): Promise<{ oldExpenseId: string; amountMinor: number }> {
  const createResult = await recordSharedStashExpenseCore(
    db,
    creatorUid,
    baseRequest({ amountMinor })
  );
  await reverseSharedStashExpenseCore(db, reverserUid, {
    expenseId: createResult.expenseId,
    clientRequestId: randomUUID(),
  });
  return { oldExpenseId: createResult.expenseId, amountMinor };
}

describe("recordSharedStashExpenseCore - correction link (Checkpoint 4F.4A)", () => {
  it("accepts a correction replacing a reversed Shared-Stash Expense on the same Trip, by the original creator", async () => {
    await seedTrip();
    const { oldExpenseId, amountMinor } = await createAndReverseSharedStashExpense(
      MEMBER_UID,
      MEMBER_UID
    );

    const result = await recordSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseRequest({ amountMinor, replacesExpenseId: oldExpenseId })
    );

    const newExpenseSnap = await db
      .collection("tripExpenses")
      .doc(result.expenseId)
      .get();
    assert.equal(newExpenseSnap.data()!.replacesExpenseId, oldExpenseId);

    const oldExpenseSnap = await db
      .collection("tripExpenses")
      .doc(oldExpenseId)
      .get();
    assert.equal(oldExpenseSnap.data()!.replacedByExpenseId, result.expenseId);
  });

  it("2. the Trip's current owner may claim the correction even though they did not create or reverse the original", async () => {
    await seedTrip();
    const { oldExpenseId, amountMinor } = await createAndReverseSharedStashExpense(
      MEMBER_UID,
      MEMBER_UID
    );
    const result = await recordSharedStashExpenseCore(
      db,
      OWNER_UID,
      baseRequest({ amountMinor, replacesExpenseId: oldExpenseId })
    );
    assert.notEqual(result.expenseId, oldExpenseId);
  });

  it("3. a creator/reverser who has since left the Trip loses correction-claim authority, but the owner can still claim it", async () => {
    // reverseSharedStashExpenseCore's own authority rule is
    // isOwner || isOriginalCreatorStillMember - the reverser of an
    // Expense can therefore only ever be the owner or the original
    // creator (never a third uid), so isOldReverserStillMember is only
    // ever reachable as "the creator, who also reversed their own
    // Expense, is STILL a member" vs. "...is no longer a member." This
    // test exercises the latter: once the creator/reverser departs, both
    // isOldCreatorStillMember and isOldReverserStillMember fail together
    // (same uid, same membership check) - only isOwner remains.
    await seedTrip();
    const { oldExpenseId, amountMinor } = await createAndReverseSharedStashExpense(
      MEMBER_UID,
      MEMBER_UID
    );
    await db.collection("trips").doc(TRIP_ID).update({
      memberIds: [OWNER_UID, OTHER_MEMBER_UID], // MEMBER_UID removed
    });

    await assertRejectsWithCode(
      recordSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseRequest({ amountMinor, replacesExpenseId: oldExpenseId })
      ),
      "permission-denied"
    );

    const result = await recordSharedStashExpenseCore(
      db,
      OWNER_UID,
      baseRequest({ amountMinor, replacesExpenseId: oldExpenseId })
    );
    assert.ok(result.expenseId);
  });

  it("13. rejects a correction attempt by an unrelated member (not owner, not creator, not reverser)", async () => {
    await seedTrip();
    const { oldExpenseId, amountMinor } = await createAndReverseSharedStashExpense(
      MEMBER_UID,
      MEMBER_UID
    );
    await assertRejectsWithCode(
      recordSharedStashExpenseCore(
        db,
        OTHER_MEMBER_UID,
        baseRequest({ amountMinor, replacesExpenseId: oldExpenseId })
      ),
      "permission-denied"
    );
  });

  it("11. rejects a replacement targeting an Expense on a different Trip", async () => {
    await seedTrip();
    const { oldExpenseId, amountMinor } = await createAndReverseSharedStashExpense(
      MEMBER_UID,
      MEMBER_UID
    );
    const SECOND_TRIP_ID = "second-trip";
    await db.collection("trips").doc(SECOND_TRIP_ID).set({
      ownerId: OWNER_UID,
      memberIds: [OWNER_UID, MEMBER_UID, OTHER_MEMBER_UID],
      title: "Second Trip",
      saved: 100,
    });
    await assertRejectsWithCode(
      recordSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseRequest({
          tripId: SECOND_TRIP_ID,
          amountMinor,
          replacesExpenseId: oldExpenseId,
        })
      ),
      "failed-precondition"
    );
  });

  it("12. rejects a replacement whose old Expense is member_out_of_pocket, not shared_stash", async () => {
    await seedTrip();
    const outOfPocketId = "out-of-pocket-old";
    await db.collection("tripExpenses").doc(outOfPocketId).set({
      tripId: TRIP_ID,
      payerUid: MEMBER_UID,
      createdBy: MEMBER_UID,
      amountMinor: 2000,
      currency: "USD",
      description: "Dinner",
      splitStrategy: "equal",
      paymentSource: "member_out_of_pocket",
      status: "reversed",
      reversedAt: new Date(),
      reversedBy: MEMBER_UID,
      createdAt: new Date(),
    });
    await assertRejectsWithCode(
      recordSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseRequest({ replacesExpenseId: outOfPocketId })
      ),
      "failed-precondition"
    );
  });

  it("rejects a replacement whose old Expense is still active (not yet reversed)", async () => {
    await seedTrip();
    const activeResult = await recordSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseRequest({ amountMinor: 1000 })
    );
    await assertRejectsWithCode(
      recordSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseRequest({ amountMinor: 1000, replacesExpenseId: activeResult.expenseId })
      ),
      "failed-precondition"
    );
  });

  it("10. rejects a replacement whose old Expense already has a canonical replacement (duplicate replacement attempt)", async () => {
    await seedTrip();
    const { oldExpenseId, amountMinor } = await createAndReverseSharedStashExpense(
      MEMBER_UID,
      MEMBER_UID
    );
    const first = await recordSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseRequest({ amountMinor, replacesExpenseId: oldExpenseId })
    );

    await assertRejectsWithCode(
      recordSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseRequest({ amountMinor, replacesExpenseId: oldExpenseId })
      ),
      "failed-precondition"
    );

    // The old Expense's canonical replacement link is still the FIRST
    // one - never silently overwritten by the rejected second attempt.
    const oldSnap = await db.collection("tripExpenses").doc(oldExpenseId).get();
    assert.equal(oldSnap.data()!.replacedByExpenseId, first.expenseId);
  });

  it("rejects a replacesExpenseId that does not reference an existing expense", async () => {
    await seedTrip();
    await assertRejectsWithCode(
      recordSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseRequest({ replacesExpenseId: "does-not-exist" })
      ),
      "failed-precondition"
    );
  });

  it("14. an exact replay (same clientRequestId, same facts including replacesExpenseId) stays idempotent", async () => {
    await seedTrip();
    const { oldExpenseId, amountMinor } = await createAndReverseSharedStashExpense(
      MEMBER_UID,
      MEMBER_UID
    );
    const clientRequestId = randomUUID();
    const request = baseRequest({ amountMinor, replacesExpenseId: oldExpenseId, clientRequestId });
    const first = await recordSharedStashExpenseCore(db, MEMBER_UID, request);
    const second = await recordSharedStashExpenseCore(db, MEMBER_UID, request);
    assert.deepEqual(first, second);
  });

  it("a reused clientRequestId with a DIFFERENT replacesExpenseId is a different-request collision", async () => {
    await seedTrip();
    const { oldExpenseId: oldA, amountMinor } = await createAndReverseSharedStashExpense(
      MEMBER_UID,
      MEMBER_UID
    );
    const { oldExpenseId: oldB } = await createAndReverseSharedStashExpense(
      MEMBER_UID,
      MEMBER_UID,
      amountMinor
    );
    const clientRequestId = randomUUID();
    await recordSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseRequest({ amountMinor, replacesExpenseId: oldA, clientRequestId })
    );
    await assertRejectsWithCode(
      recordSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseRequest({ amountMinor, replacesExpenseId: oldB, clientRequestId })
      ),
      "already-exists"
    );
  });

  it("an ordinary (non-correction) create still succeeds with replacesExpenseId omitted", async () => {
    await seedTrip();
    const result = await recordSharedStashExpenseCore(db, MEMBER_UID, baseRequest());
    const snap = await db.collection("tripExpenses").doc(result.expenseId).get();
    assert.equal("replacesExpenseId" in snap.data()!, false);
  });

  it("rejects a malformed replacesExpenseId at input validation", async () => {
    await seedTrip();
    await assertRejectsWithCode(
      recordSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseRequest({ replacesExpenseId: "" })
      ),
      "invalid-argument"
    );
  });
});
