// Checkpoint 6.7A: expense-balance-model-state-aware integration tests
// for recordTripSettlementCore, against the local Firestore emulator via
// the Admin SDK - never production. Deliberately a SEPARATE file from
// recordTripSettlementCore.ts's own existing (unmodified) legacy test
// suite - that file's continued, untouched pass is itself part of the
// proof that legacy behavior is unchanged; this file covers only the
// NEW tripExpenseBalances aggregate-maintenance branches.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import type { App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { recordTripSettlementCore } from "../src/callables/recordTripSettlement";
import { CURRENT_TRIP_EXPENSE_BALANCE_MODEL_VERSION } from "../src/domain/tripExpenseBalanceModel";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "FIRESTORE_EMULATOR_HOST is not set. Run these tests via " +
      '`firebase emulators:exec --only firestore "npm --prefix functions test"` ' +
      "so the Admin SDK talks to the local emulator, never production."
  );
}

const OWNER_UID = "owner-uid";
const MEMBER_UID = "member-uid"; // fromUid (the debtor, pays in real life)
const OTHER_MEMBER_UID = "other-member-uid"; // toUid (the recipient)
const TRIP_ID = "test-trip";

let app: App;
let db: Firestore;

before(() => {
  app = initializeApp({
    projectId: "demo-squadstash-functions-test-record-settlement-balance",
  });
  db = getFirestore(app);
});

after(async () => {
  await deleteApp(app);
});

async function clearFirestore(): Promise<void> {
  for (const name of ["trips", "tripSettlements", "tripExpenseBalances"]) {
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
    fromUid: MEMBER_UID,
    toUid: OTHER_MEMBER_UID,
    amountMinor: 500,
    currency: "USD",
    method: "cash",
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

describe("recordTripSettlement - legacy: no tripExpenseBalances row created", () => {
  it("succeeds with state absent, no balance row for either party", async () => {
    await seedTrip();
    await recordTripSettlementCore(db, OTHER_MEMBER_UID, baseRequest());
    const all = await db.collection("tripExpenseBalances").get();
    assert.equal(all.size, 0);
  });
});

describe("recordTripSettlement - initialized: maintains the tripExpenseBalances aggregate", () => {
  it("fromUid credited, toUid debited", async () => {
    await seedTrip(initializedOverrides());
    await recordTripSettlementCore(db, OTHER_MEMBER_UID, baseRequest());
    assert.equal(await getBalance(MEMBER_UID), 500);
    assert.equal(await getBalance(OTHER_MEMBER_UID), -500);
  });

  it("two settlements accumulate rather than overwrite", async () => {
    await seedTrip(initializedOverrides());
    await recordTripSettlementCore(db, OTHER_MEMBER_UID, baseRequest());
    await recordTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseRequest({ amountMinor: 100, clientRequestId: randomUUID() })
    );
    assert.equal(await getBalance(MEMBER_UID), 600);
    assert.equal(await getBalance(OTHER_MEMBER_UID), -600);
  });

  it("idempotent replay does not double-apply the delta", async () => {
    await seedTrip(initializedOverrides());
    const request = baseRequest();
    await recordTripSettlementCore(db, OTHER_MEMBER_UID, request);
    await recordTripSettlementCore(db, OTHER_MEMBER_UID, request);
    assert.equal(await getBalance(MEMBER_UID), 500);
    assert.equal(await getBalance(OTHER_MEMBER_UID), -500);
  });

  it("every balance row sums to exactly zero", async () => {
    await seedTrip(initializedOverrides());
    await recordTripSettlementCore(db, OTHER_MEMBER_UID, baseRequest());
    const all = await db.collection("tripExpenseBalances").get();
    const sum = all.docs.reduce(
      (acc, d) => acc + (d.data().netBalanceMinor as number),
      0
    );
    assert.equal(sum, 0);
  });

  it("a rejected (fromUid not a current member) settlement never touches the aggregate", async () => {
    await seedTrip(initializedOverrides());
    await assertRejectsWithCode(
      recordTripSettlementCore(
        db,
        OTHER_MEMBER_UID,
        baseRequest({ fromUid: "nonmember-uid" })
      ),
      "failed-precondition"
    );
    const all = await db.collection("tripExpenseBalances").get();
    assert.equal(all.size, 0);
  });
});

describe("recordTripSettlement - migrating/needs_reconciliation: new settlements rejected", () => {
  it("migrating rejects a new settlement, no Settlement/balance writes", async () => {
    await seedTrip({ expenseBalanceModelState: "migrating" });
    const request = baseRequest();
    await assertRejectsWithCode(
      recordTripSettlementCore(db, OTHER_MEMBER_UID, request),
      "failed-precondition"
    );
    const settlementSnap = await db
      .collection("tripSettlements")
      .doc(request.clientRequestId as string)
      .get();
    assert.equal(settlementSnap.exists, false);
  });

  it("needs_reconciliation rejects a new settlement identically", async () => {
    await seedTrip({
      expenseBalanceModelState: "needs_reconciliation",
      expenseBalanceModelVersion: CURRENT_TRIP_EXPENSE_BALANCE_MODEL_VERSION,
    });
    await assertRejectsWithCode(
      recordTripSettlementCore(db, OTHER_MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
  });
});

describe("recordTripSettlement - corrupt expense-balance model state fails closed", () => {
  it("initialized with an unsupported version rejects", async () => {
    await seedTrip(initializedOverrides({ expenseBalanceModelVersion: 999 }));
    await assertRejectsWithCode(
      recordTripSettlementCore(db, OTHER_MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
  });

  it("an unknown state string rejects", async () => {
    await seedTrip({ expenseBalanceModelState: "bogus" });
    await assertRejectsWithCode(
      recordTripSettlementCore(db, OTHER_MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
  });
});
