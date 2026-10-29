// Checkpoint 6.7A: expense-balance-model-state-aware integration tests
// for reverseTripSettlementCore, against the local Firestore emulator
// via the Admin SDK - never production. Deliberately a SEPARATE file
// from reverseTripSettlementCore.ts's own existing (unmodified) legacy
// test suite. This file covers only the NEW branches: tripExpenseBalances
// inverse-delta maintenance, and the departed-member reversal-safety
// freeze gate (checking BOTH fromUid and toUid).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import type { App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { recordTripSettlementCore } from "../src/callables/recordTripSettlement";
import { reverseTripSettlementCore } from "../src/callables/reverseTripSettlement";
import { CURRENT_TRIP_EXPENSE_BALANCE_MODEL_VERSION } from "../src/domain/tripExpenseBalanceModel";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "FIRESTORE_EMULATOR_HOST is not set. Run these tests via " +
      '`firebase emulators:exec --only firestore "npm --prefix functions test"` ' +
      "so the Admin SDK talks to the local emulator, never production."
  );
}

const OWNER_UID = "owner-uid";
const MEMBER_UID = "member-uid"; // fromUid
const OTHER_MEMBER_UID = "other-member-uid"; // toUid
const TRIP_ID = "test-trip";

let app: App;
let db: Firestore;

before(() => {
  app = initializeApp({
    projectId: "demo-squadstash-functions-test-reverse-settlement-balance",
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

function baseSettlementRequest(
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

describe("reverseTripSettlement - legacy: no balance rows involved", () => {
  it("reverses successfully with no tripExpenseBalances row created", async () => {
    await seedTrip();
    const created = await recordTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseSettlementRequest()
    );
    await reverseTripSettlementCore(db, OTHER_MEMBER_UID, {
      settlementId: created.settlementId,
      clientRequestId: randomUUID(),
    });
    const all = await db.collection("tripExpenseBalances").get();
    assert.equal(all.size, 0);
  });
});

describe("reverseTripSettlement - initialized: applies the EXACT inverse of the original forward delta", () => {
  it("reversing a settlement restores both balances to their pre-settlement values", async () => {
    await seedTrip(initializedOverrides());
    const created = await recordTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseSettlementRequest()
    );
    assert.equal(await getBalance(MEMBER_UID), 500);
    assert.equal(await getBalance(OTHER_MEMBER_UID), -500);

    await reverseTripSettlementCore(db, OTHER_MEMBER_UID, {
      settlementId: created.settlementId,
      clientRequestId: randomUUID(),
    });
    assert.equal(await getBalance(MEMBER_UID), 0);
    assert.equal(await getBalance(OTHER_MEMBER_UID), 0);
  });

  it("idempotent replay of the reversal does not double-apply the inverse delta", async () => {
    await seedTrip(initializedOverrides());
    const created = await recordTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseSettlementRequest()
    );
    const reversalRequest = {
      settlementId: created.settlementId,
      clientRequestId: randomUUID(),
    };
    await reverseTripSettlementCore(db, OTHER_MEMBER_UID, reversalRequest);
    await reverseTripSettlementCore(db, OTHER_MEMBER_UID, reversalRequest);
    assert.equal(await getBalance(MEMBER_UID), 0);
    assert.equal(await getBalance(OTHER_MEMBER_UID), 0);
  });
});

describe("reverseTripSettlement - departed-member reversal-safety freeze gate (Checkpoint 6.7A)", () => {
  it("both parties still current members: reversal succeeds", async () => {
    await seedTrip(initializedOverrides());
    const created = await recordTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseSettlementRequest()
    );
    const result = await reverseTripSettlementCore(db, OTHER_MEMBER_UID, {
      settlementId: created.settlementId,
      clientRequestId: randomUUID(),
    });
    assert.equal(result.settlementId, created.settlementId);
  });

  it("fromUid no longer a current member blocks reversal, leaving the Settlement/aggregate untouched", async () => {
    await seedTrip(initializedOverrides());
    const created = await recordTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseSettlementRequest()
    );
    await db
      .collection("trips")
      .doc(TRIP_ID)
      .update({ memberIds: [OWNER_UID, OTHER_MEMBER_UID] });

    await assertRejectsWithCode(
      reverseTripSettlementCore(db, OTHER_MEMBER_UID, {
        settlementId: created.settlementId,
        clientRequestId: randomUUID(),
      }),
      "failed-precondition"
    );
    assert.equal(await getBalance(MEMBER_UID), 500);
    assert.equal(await getBalance(OTHER_MEMBER_UID), -500);
    const settlementSnap = await db
      .collection("tripSettlements")
      .doc(created.settlementId)
      .get();
    assert.equal(settlementSnap.data()?.status, "active");
  });

  it("toUid no longer a current member also blocks reversal (even though toUid is also the only authorized reverser)", async () => {
    await seedTrip(initializedOverrides());
    const created = await recordTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseSettlementRequest()
    );
    await db
      .collection("trips")
      .doc(TRIP_ID)
      .update({ memberIds: [OWNER_UID, MEMBER_UID] });

    // toUid (OTHER_MEMBER_UID) is no longer a current member, so it can
    // no longer even pass this callable's own authorization check
    // (toUid === authUid AND a current member) - the freeze gate is
    // unreachable in this exact scenario, but authorization itself
    // already converges on the same rejection family (failed-precondition
    // is reserved for the gate; this path actually surfaces as
    // permission-denied from the EXISTING authorization check, which
    // this test documents rather than assumes).
    await assertRejectsWithCode(
      reverseTripSettlementCore(db, OTHER_MEMBER_UID, {
        settlementId: created.settlementId,
        clientRequestId: randomUUID(),
      }),
      "permission-denied"
    );
    assert.equal(await getBalance(MEMBER_UID), 500);
    assert.equal(await getBalance(OTHER_MEMBER_UID), -500);
  });
});
