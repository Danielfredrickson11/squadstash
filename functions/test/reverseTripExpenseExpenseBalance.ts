// Checkpoint 6.7A: expense-balance-model-state-aware integration tests
// for reverseTripExpenseCore, against the local Firestore emulator via
// the Admin SDK - never production. Deliberately a SEPARATE file from
// reverseTripExpenseCore.ts's own existing (unmodified) legacy test
// suite - that file's continued, untouched pass is itself part of the
// proof that legacy behavior (including a hand-seeded Expense with NO
// split documents at all) is unchanged. This file covers only the NEW
// branches: tripExpenseBalances inverse-delta maintenance, and the
// departed-member reversal-safety freeze gate.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import type { App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { recordTripExpenseCore } from "../src/callables/recordTripExpense";
import { reverseTripExpenseCore } from "../src/callables/reverseTripExpense";
import { CURRENT_TRIP_EXPENSE_BALANCE_MODEL_VERSION } from "../src/domain/tripExpenseBalanceModel";

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
const TRIP_ID = "test-trip";

let app: App;
let db: Firestore;

before(() => {
  app = initializeApp({
    projectId: "demo-squadstash-functions-test-reverse-expense-balance",
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
    "tripExpenseBalances",
  ]) {
    const snap = await db.collection(name).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

beforeEach(async () => {
  await clearFirestore();
});

function balanceId(tripId: string, uid: string): string {
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
      memberIds: [OWNER_UID, MEMBER_UID, OTHER_MEMBER_UID],
      title: "Test Trip",
      target: 1000,
      saved: 0,
      imageUrl: "https://example.com/trip.jpg",
      tripStartDate: "2027-06-12",
      ...overrides,
    });
}

function initializedOverrides(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    expenseBalanceModelState: "initialized",
    expenseBalanceModelVersion: CURRENT_TRIP_EXPENSE_BALANCE_MODEL_VERSION,
    ...overrides,
  };
}

function baseExpenseRequest(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    tripId: TRIP_ID,
    payerUid: MEMBER_UID,
    amountMinor: 100,
    currency: "USD",
    description: "Cabin rental",
    splitStrategy: "equal",
    participants: [{ uid: MEMBER_UID }, { uid: OTHER_MEMBER_UID }],
    clientRequestId: randomUUID(),
    ...overrides,
  };
}

async function getBalance(uid: string): Promise<number | undefined> {
  const snap = await db
    .collection("tripExpenseBalances")
    .doc(balanceId(TRIP_ID, uid))
    .get();
  return snap.exists ?
    (snap.data() as { netBalanceMinor: number }).netBalanceMinor :
    undefined;
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

describe("reverseTripExpense - legacy: Expense with NO split documents still reverses (pre-6.7A behavior unaffected)", () => {
  it("a hand-seeded split-less Expense on a legacy Trip reverses successfully, no balance rows", async () => {
    await seedTrip();
    await db.collection("tripExpenses").doc("legacy-expense").set({
      tripId: TRIP_ID,
      payerUid: MEMBER_UID,
      createdBy: MEMBER_UID,
      amountMinor: 9000,
      currency: "USD",
      description: "Cabin rental",
      splitStrategy: "equal",
      paymentSource: "member_out_of_pocket",
      status: "active",
      createdAt: new Date(),
      creationRequest: {
        tripId: TRIP_ID,
        payerUid: MEMBER_UID,
        amountMinor: 9000,
        currency: "USD",
        description: "Cabin rental",
        category: null,
        splitStrategy: "equal",
        participants: [{ uid: MEMBER_UID }],
        paymentSource: "member_out_of_pocket",
        occurredAtInstantMs: null,
      },
    });

    const result = await reverseTripExpenseCore(db, OWNER_UID, {
      expenseId: "legacy-expense",
      clientRequestId: randomUUID(),
    });
    assert.equal(result.expenseId, "legacy-expense");
    const all = await db.collection("tripExpenseBalances").get();
    assert.equal(all.size, 0);
  });
});

describe("reverseTripExpense - initialized: applies the EXACT inverse of the original forward delta", () => {
  it("reversing a two-participant expense restores every touched balance to its pre-expense value", async () => {
    await seedTrip(initializedOverrides());
    const created = await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseExpenseRequest({ amountMinor: 100 })
    );
    assert.equal(await getBalance(MEMBER_UID), 50);
    assert.equal(await getBalance(OTHER_MEMBER_UID), -50);

    await reverseTripExpenseCore(db, OWNER_UID, {
      expenseId: created.expenseId,
      clientRequestId: randomUUID(),
    });
    assert.equal(await getBalance(MEMBER_UID), 0);
    assert.equal(await getBalance(OTHER_MEMBER_UID), 0);
  });

  it("reversing one of two expenses leaves only the other expense's net effect behind", async () => {
    await seedTrip(initializedOverrides());
    const first = await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseExpenseRequest({ amountMinor: 100 })
    );
    await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseExpenseRequest({ amountMinor: 20, clientRequestId: randomUUID() })
    );
    assert.equal(await getBalance(MEMBER_UID), 60);

    await reverseTripExpenseCore(db, OWNER_UID, {
      expenseId: first.expenseId,
      clientRequestId: randomUUID(),
    });
    // Only the second expense's net effect (+20 payer credit, -10
    // participant debit = +10) remains.
    assert.equal(await getBalance(MEMBER_UID), 10);
    assert.equal(await getBalance(OTHER_MEMBER_UID), -10);
  });

  it("idempotent replay of the reversal does not double-apply the inverse delta", async () => {
    await seedTrip(initializedOverrides());
    const created = await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseExpenseRequest({ amountMinor: 100 })
    );
    const reversalRequest = {
      expenseId: created.expenseId,
      clientRequestId: randomUUID(),
    };
    await reverseTripExpenseCore(db, OWNER_UID, reversalRequest);
    assert.equal(await getBalance(MEMBER_UID), 0);

    await reverseTripExpenseCore(db, OWNER_UID, reversalRequest);
    assert.equal(await getBalance(MEMBER_UID), 0);
    assert.equal(await getBalance(OTHER_MEMBER_UID), 0);
  });
});

describe("reverseTripExpense - departed-member reversal-safety freeze gate (Checkpoint 6.7A)", () => {
  it("every named party still a current member: reversal succeeds (today's only reachable outcome, membership is monotonic)", async () => {
    await seedTrip(initializedOverrides());
    const created = await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseExpenseRequest({ amountMinor: 100 })
    );
    const result = await reverseTripExpenseCore(db, OWNER_UID, {
      expenseId: created.expenseId,
      clientRequestId: randomUUID(),
    });
    assert.equal(result.expenseId, created.expenseId);
  });

  it("a payer who is no longer a current member blocks reversal, leaving the Expense/aggregate untouched", async () => {
    await seedTrip(initializedOverrides());
    const created = await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseExpenseRequest({ amountMinor: 100 })
    );
    // Simulate the payer having since left the Trip - memberIds no
    // longer contains MEMBER_UID (no real departure feature exists yet;
    // this directly manipulates the Trip document to exercise the
    // forward-looking gate).
    await db
      .collection("trips")
      .doc(TRIP_ID)
      .update({ memberIds: [OWNER_UID, OTHER_MEMBER_UID] });

    await assertRejectsWithCode(
      reverseTripExpenseCore(db, OWNER_UID, {
        expenseId: created.expenseId,
        clientRequestId: randomUUID(),
      }),
      "failed-precondition"
    );
    assert.equal(await getBalance(MEMBER_UID), 50);
    assert.equal(await getBalance(OTHER_MEMBER_UID), -50);
    const expenseSnap = await db
      .collection("tripExpenses")
      .doc(created.expenseId)
      .get();
    assert.equal(expenseSnap.data()?.status, "active");
  });

  it("a split participant (not the payer) who is no longer a current member also blocks reversal", async () => {
    await seedTrip(initializedOverrides());
    const created = await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseExpenseRequest({ amountMinor: 100 })
    );
    await db
      .collection("trips")
      .doc(TRIP_ID)
      .update({ memberIds: [OWNER_UID, MEMBER_UID] });

    await assertRejectsWithCode(
      reverseTripExpenseCore(db, OWNER_UID, {
        expenseId: created.expenseId,
        clientRequestId: randomUUID(),
      }),
      "failed-precondition"
    );
  });

  it("the gate re-evaluates LIVE current membership on every attempt - restoring the uid to memberIds un-blocks a previously-rejected reversal", async () => {
    await seedTrip(initializedOverrides());
    const created = await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseExpenseRequest({ amountMinor: 100 })
    );
    await db
      .collection("trips")
      .doc(TRIP_ID)
      .update({ memberIds: [OWNER_UID, OTHER_MEMBER_UID] });
    await assertRejectsWithCode(
      reverseTripExpenseCore(db, OWNER_UID, {
        expenseId: created.expenseId,
        clientRequestId: randomUUID(),
      }),
      "failed-precondition"
    );

    // Restoring membership makes the gate re-evaluate as passing again -
    // the gate checks LIVE current membership each attempt, it does not
    // permanently freeze the Expense the first time it is blocked.
    await db
      .collection("trips")
      .doc(TRIP_ID)
      .update({ memberIds: [OWNER_UID, MEMBER_UID, OTHER_MEMBER_UID] });
    const result = await reverseTripExpenseCore(db, OWNER_UID, {
      expenseId: created.expenseId,
      clientRequestId: randomUUID(),
    });
    assert.equal(result.expenseId, created.expenseId);
  });
});
