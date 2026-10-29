// Checkpoint 6.7A: expense-balance-model-state-aware integration tests
// for recordTripExpenseCore, against the local Firestore emulator via
// the Admin SDK - never production. Deliberately a SEPARATE file from
// recordTripExpenseCore.ts's own existing (unmodified) legacy test
// suite - that file's continued, untouched pass is itself part of the
// proof that legacy behavior is unchanged; this file covers only the
// NEW tripExpenseBalances aggregate-maintenance branches (legacy no-op,
// initialized maintenance, migrating/needs_reconciliation rejection,
// corrupt fail-closed, the MAX_EXPENSE_PARTICIPANTS boundary).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import type { App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { recordTripExpenseCore } from "../src/callables/recordTripExpense";
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
    projectId: "demo-squadstash-functions-test-record-expense-balance",
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

function baseRequest(
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

describe("recordTripExpense - legacy: no tripExpenseBalances row created", () => {
  it("succeeds with state absent, no balance row for either party", async () => {
    await seedTrip();
    await recordTripExpenseCore(db, MEMBER_UID, baseRequest());
    assert.equal(await getBalance(MEMBER_UID), undefined);
    assert.equal(await getBalance(OTHER_MEMBER_UID), undefined);
    const all = await db.collection("tripExpenseBalances").get();
    assert.equal(all.size, 0);
  });

  it("succeeds with explicit state \"legacy\", no balance row created", async () => {
    await seedTrip({ expenseBalanceModelState: "legacy" });
    await recordTripExpenseCore(db, MEMBER_UID, baseRequest());
    const all = await db.collection("tripExpenseBalances").get();
    assert.equal(all.size, 0);
  });
});

describe("recordTripExpense - initialized: maintains the tripExpenseBalances aggregate", () => {
  it("equal split: payer credited, each OTHER participant debited their own share", async () => {
    await seedTrip(initializedOverrides());
    await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseRequest({ amountMinor: 100 })
    );
    // equal split across [MEMBER_UID, OTHER_MEMBER_UID]: 50/50.
    // MEMBER_UID is both payer (+100) and a participant (-50) -> net +50.
    assert.equal(await getBalance(MEMBER_UID), 50);
    assert.equal(await getBalance(OTHER_MEMBER_UID), -50);
  });

  it("payer not a participant: payer net +amount, every participant net -their share", async () => {
    await seedTrip(initializedOverrides());
    await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseRequest({
        payerUid: OWNER_UID,
        amountMinor: 100,
        participants: [{ uid: MEMBER_UID }, { uid: OTHER_MEMBER_UID }],
      })
    );
    assert.equal(await getBalance(OWNER_UID), 100);
    assert.equal(await getBalance(MEMBER_UID), -50);
    assert.equal(await getBalance(OTHER_MEMBER_UID), -50);
  });

  it("a valid zero-share custom split still succeeds and maintains the correct aggregate (Checkpoint 6.7A Final Financial Parity Review item 4) - exercised through the real custom-split input path, not a hand-built allocation", async () => {
    await seedTrip(initializedOverrides());
    const result = await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseRequest({
        amountMinor: 100,
        splitStrategy: "custom",
        participants: [
          { uid: MEMBER_UID, amountMinor: 0 },
          { uid: OTHER_MEMBER_UID, amountMinor: 100 },
        ],
      })
    );
    assert.ok(result.expenseId.length > 0);
    // MEMBER_UID is payer (+100) and a $0-share participant (-0) -> +100.
    assert.equal(await getBalance(MEMBER_UID), 100);
    assert.equal(await getBalance(OTHER_MEMBER_UID), -100);
    const all = await db.collection("tripExpenseBalances").get();
    // Explicit zero-row policy is about the AGGREGATE rows, not every
    // participant needing its own row - MEMBER_UID's own net here is
    // +100 (nonzero), so exactly two rows exist.
    assert.equal(all.size, 2);
  });

  it("a second expense accumulates onto the existing balance row rather than overwriting it", async () => {
    await seedTrip(initializedOverrides());
    await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseRequest({ amountMinor: 100 })
    );
    assert.equal(await getBalance(MEMBER_UID), 50);

    await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseRequest({ amountMinor: 20, clientRequestId: randomUUID() })
    );
    // Second expense: MEMBER_UID +20 payer credit, -10 participant debit
    // -> net +10 this time, accumulated onto the existing +50 -> +60.
    assert.equal(await getBalance(MEMBER_UID), 60);
    assert.equal(await getBalance(OTHER_MEMBER_UID), -60);
  });

  it("every balance row sums to exactly zero across the whole Trip", async () => {
    await seedTrip(initializedOverrides());
    await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseRequest({
        amountMinor: 100,
        participants: [
          { uid: OWNER_UID },
          { uid: MEMBER_UID },
          { uid: OTHER_MEMBER_UID },
        ],
      })
    );
    const all = await db.collection("tripExpenseBalances").get();
    const sum = all.docs.reduce(
      (acc, d) => acc + (d.data().netBalanceMinor as number),
      0
    );
    assert.equal(sum, 0);
  });

  it("idempotent replay does not double-apply the balance delta", async () => {
    await seedTrip(initializedOverrides());
    const request = baseRequest({ amountMinor: 100 });
    await recordTripExpenseCore(db, MEMBER_UID, request);
    assert.equal(await getBalance(MEMBER_UID), 50);

    await recordTripExpenseCore(db, MEMBER_UID, request);
    assert.equal(await getBalance(MEMBER_UID), 50);
    assert.equal(await getBalance(OTHER_MEMBER_UID), -50);
  });

  it("a rejected (payerUid not a current member) expense never touches the aggregate", async () => {
    await seedTrip(initializedOverrides());
    const request = baseRequest({ payerUid: "nonmember-uid" });
    await assertRejectsWithCode(
      recordTripExpenseCore(db, MEMBER_UID, request),
      "failed-precondition"
    );
    const all = await db.collection("tripExpenseBalances").get();
    assert.equal(all.size, 0);
  });
});

describe("recordTripExpense - MAX_EXPENSE_PARTICIPANTS boundary (Checkpoint 6.7A)", () => {
  it("100 participants (the existing cap, unchanged) succeeds and produces exactly 100 balance rows summing to zero", async () => {
    const memberIds = Array.from({ length: 100 }, (_, i) => `p${i}`);
    await seedTrip(
      initializedOverrides({ memberIds: [OWNER_UID, ...memberIds] })
    );
    await recordTripExpenseCore(
      db,
      OWNER_UID,
      baseRequest({
        payerUid: OWNER_UID,
        amountMinor: 1000,
        participants: memberIds.map((uid) => ({ uid })),
      })
    );
    const all = await db.collection("tripExpenseBalances").get();
    // 100 participants + the payer (not itself a participant here) = 101
    // distinct rows - comfortably under Firestore's 500-write transaction
    // limit, confirming the existing 100-participant cap was never
    // raised to accommodate this aggregate.
    assert.equal(all.size, 101);
    const sum = all.docs.reduce(
      (acc, d) => acc + (d.data().netBalanceMinor as number),
      0
    );
    assert.equal(sum, 0);
    assert.equal(await getBalance(OWNER_UID), 1000);
  });
});

describe("recordTripExpense - migrating/needs_reconciliation: new expenses rejected", () => {
  it("migrating rejects a new expense, no Expense/balance writes", async () => {
    await seedTrip({ expenseBalanceModelState: "migrating" });
    const request = baseRequest();
    await assertRejectsWithCode(
      recordTripExpenseCore(db, MEMBER_UID, request),
      "failed-precondition"
    );
    const expenseSnap = await db
      .collection("tripExpenses")
      .doc(request.clientRequestId as string)
      .get();
    assert.equal(expenseSnap.exists, false);
    const all = await db.collection("tripExpenseBalances").get();
    assert.equal(all.size, 0);
  });

  it("needs_reconciliation rejects a new expense identically", async () => {
    await seedTrip({
      expenseBalanceModelState: "needs_reconciliation",
      expenseBalanceModelVersion: CURRENT_TRIP_EXPENSE_BALANCE_MODEL_VERSION,
    });
    await assertRejectsWithCode(
      recordTripExpenseCore(db, MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
  });
});

describe("recordTripExpense - corrupt expense-balance model state fails closed", () => {
  it("initialized with an unsupported version rejects", async () => {
    await seedTrip(initializedOverrides({ expenseBalanceModelVersion: 999 }));
    await assertRejectsWithCode(
      recordTripExpenseCore(db, MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
  });

  it("an unknown state string rejects", async () => {
    await seedTrip({ expenseBalanceModelState: "bogus" });
    await assertRejectsWithCode(
      recordTripExpenseCore(db, MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
  });
});
