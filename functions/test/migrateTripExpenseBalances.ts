// Tests for the tripExpenseBalances admin migration tool (Checkpoint
// 6.7A), against the local Firestore emulator via the Admin SDK - NEVER
// production. This tool itself is never exported/onCall-wrapped and is
// never invoked during this checkpoint outside these tests; see
// functions/src/admin/migrateTripExpenseBalances.ts's own header.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import type { App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import {
  PRODUCTION_PROJECT_ID,
  resolveExecutionTarget,
  runTripExpenseBalanceMigration,
} from "../src/admin/migrateTripExpenseBalances";
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
    projectId: "demo-squadstash-functions-test-migrate-expense-balances",
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
    "tripSettlements",
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

function seedActiveExpense(
  id: string,
  payerUid: string,
  amountMinor: number,
  splitUids: string[],
  overrides: Record<string, unknown> = {}
): Promise<FirebaseFirestore.WriteResult> {
  return db
    .collection("tripExpenses")
    .doc(id)
    .set({
      tripId: TRIP_ID,
      payerUid,
      createdBy: payerUid,
      amountMinor,
      currency: "USD",
      description: "Test expense",
      splitStrategy: "equal",
      paymentSource: "member_out_of_pocket",
      status: "active",
      createdAt: new Date(),
      ...overrides,
    })
    .then(async (result) => {
      const share = Math.floor(amountMinor / splitUids.length);
      const remainder = amountMinor - share * splitUids.length;
      await Promise.all(
        splitUids.map((uid, i) => {
          const amount = share + (i < remainder ? 1 : 0);
          return db
            .collection("tripExpenseSplits")
            .doc(`${id}_${uid}`)
            .set({
              expenseId: id,
              tripId: TRIP_ID,
              userId: uid,
              amountMinor: amount,
              createdAt: new Date(),
            });
        })
      );
      return result;
    });
}

function seedActiveSettlement(
  id: string,
  fromUid: string,
  toUid: string,
  amountMinor: number,
  overrides: Record<string, unknown> = {}
): Promise<FirebaseFirestore.WriteResult> {
  return db.collection("tripSettlements").doc(id).set({
    tripId: TRIP_ID,
    fromUid,
    toUid,
    amountMinor,
    currency: "USD",
    method: "cash",
    createdAt: new Date(),
    createdBy: toUid,
    status: "active",
    ...overrides,
  });
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

describe("runTripExpenseBalanceMigration - not eligible", () => {
  it("an already-initialized Trip is not eligible", async () => {
    await seedTrip({
      expenseBalanceModelState: "initialized",
      expenseBalanceModelVersion: CURRENT_TRIP_EXPENSE_BALANCE_MODEL_VERSION,
    });
    const result = await runTripExpenseBalanceMigration(
      db,
      TRIP_ID,
      "dry_run"
    );
    assert.equal(result.status, "not_eligible");
  });

  it("a migrating Trip is not eligible", async () => {
    await seedTrip({ expenseBalanceModelState: "migrating" });
    const result = await runTripExpenseBalanceMigration(
      db,
      TRIP_ID,
      "dry_run"
    );
    assert.equal(result.status, "not_eligible");
  });

  it("throws for a nonexistent Trip", async () => {
    await assert.rejects(
      runTripExpenseBalanceMigration(db, "nonexistent-trip", "dry_run")
    );
  });
});

describe("runTripExpenseBalanceMigration - dry_run never writes anything", () => {
  it("a Trip with no history: would_initialize with zero computed balances, Trip untouched", async () => {
    await seedTrip();
    const result = await runTripExpenseBalanceMigration(
      db,
      TRIP_ID,
      "dry_run"
    );
    assert.equal(result.status, "would_initialize");
    assert.deepEqual(result.computedBalances, []);
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.expenseBalanceModelState, undefined);
    const all = await db.collection("tripExpenseBalances").get();
    assert.equal(all.size, 0);
  });

  it("a Trip with real history: computes the correct balances without writing them", async () => {
    await seedTrip();
    await seedActiveExpense("exp-1", MEMBER_UID, 100, [
      MEMBER_UID,
      OTHER_MEMBER_UID,
    ]);
    const result = await runTripExpenseBalanceMigration(
      db,
      TRIP_ID,
      "dry_run"
    );
    assert.equal(result.status, "would_initialize");
    const memberBalance = result.computedBalances.find(
      (b) => b.uid === MEMBER_UID
    );
    const otherBalance = result.computedBalances.find(
      (b) => b.uid === OTHER_MEMBER_UID
    );
    assert.equal(memberBalance?.netBalanceMinor, 50);
    assert.equal(otherBalance?.netBalanceMinor, -50);
    const all = await db.collection("tripExpenseBalances").get();
    assert.equal(all.size, 0);
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.expenseBalanceModelState, undefined);
  });
});

describe("runTripExpenseBalanceMigration - apply: full lifecycle", () => {
  it("a Trip with no history initializes cleanly with zero balance rows", async () => {
    await seedTrip();
    const result = await runTripExpenseBalanceMigration(db, TRIP_ID, "apply");
    assert.equal(result.status, "initialized");
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.expenseBalanceModelState, "initialized");
    assert.equal(
      tripSnap.data()?.expenseBalanceModelVersion,
      CURRENT_TRIP_EXPENSE_BALANCE_MODEL_VERSION
    );
    const all = await db.collection("tripExpenseBalances").get();
    assert.equal(all.size, 0);
  });

  it("multiple expenses and settlements: parity between computed and written rows, sums to zero", async () => {
    await seedTrip();
    await seedActiveExpense("exp-1", MEMBER_UID, 100, [
      MEMBER_UID,
      OTHER_MEMBER_UID,
    ]);
    await seedActiveExpense("exp-2", OWNER_UID, 60, [
      OWNER_UID,
      MEMBER_UID,
      OTHER_MEMBER_UID,
    ]);
    await seedActiveSettlement("set-1", MEMBER_UID, OTHER_MEMBER_UID, 20);

    const result = await runTripExpenseBalanceMigration(db, TRIP_ID, "apply");
    assert.equal(result.status, "initialized");

    const all = await db.collection("tripExpenseBalances").get();
    const writtenSum = all.docs.reduce(
      (acc, d) => acc + (d.data().netBalanceMinor as number),
      0
    );
    assert.equal(writtenSum, 0);

    for (const balance of result.computedBalances) {
      const written = await getBalance(balance.uid);
      assert.equal(written, balance.netBalanceMinor);
    }
  });

  it("a reversed expense contributes nothing (forward+inverse already net to zero, so it is correctly excluded)", async () => {
    await seedTrip();
    await seedActiveExpense("exp-1", MEMBER_UID, 100, [
      MEMBER_UID,
      OTHER_MEMBER_UID,
    ]);
    await db.collection("tripExpenses").doc("exp-1").update({
      status: "reversed",
      reversedAt: new Date(),
      reversedBy: OWNER_UID,
    });
    await seedActiveExpense("exp-2", MEMBER_UID, 40, [
      MEMBER_UID,
      OTHER_MEMBER_UID,
    ]);

    const result = await runTripExpenseBalanceMigration(db, TRIP_ID, "apply");
    assert.equal(result.status, "initialized");
    assert.equal(await getBalance(MEMBER_UID), 20);
    assert.equal(await getBalance(OTHER_MEMBER_UID), -20);
  });

  it("a valid shared_stash Expense is recognized as legitimate and contributes zero social balance (that system never maintains this aggregate)", async () => {
    await seedTrip();
    // A genuinely well-formed shared_stash Expense: payerUid null,
    // a real sharedStashTransactionId - mirrors
    // assertValidExpensePaymentShape's own frozen shape exactly.
    await seedActiveExpense("exp-1", MEMBER_UID, 100, [MEMBER_UID], {
      paymentSource: "shared_stash",
      payerUid: null,
      sharedStashTransactionId: "withdrawal-1",
    });
    const result = await runTripExpenseBalanceMigration(db, TRIP_ID, "apply");
    assert.equal(result.status, "initialized");
    const all = await db.collection("tripExpenseBalances").get();
    assert.equal(all.size, 0);
  });

  it("a shared_stash Expense with a malformed payment shape (e.g. a non-null payerUid) is an anomaly, not a silent exclusion", async () => {
    await seedTrip();
    await seedActiveExpense("exp-1", MEMBER_UID, 100, [MEMBER_UID], {
      paymentSource: "shared_stash",
      // payerUid left as MEMBER_UID (not null) and no
      // sharedStashTransactionId - an invalid shared_stash shape.
    });
    const result = await runTripExpenseBalanceMigration(db, TRIP_ID, "apply");
    assert.equal(result.status, "blocked");
    assert.ok(result.anomalies.length > 0);
  });

  it("re-running after successful initialization reports not_eligible and makes no further writes", async () => {
    await seedTrip();
    await seedActiveExpense("exp-1", MEMBER_UID, 100, [
      MEMBER_UID,
      OTHER_MEMBER_UID,
    ]);
    await runTripExpenseBalanceMigration(db, TRIP_ID, "apply");
    const before = await getBalance(MEMBER_UID);

    const second = await runTripExpenseBalanceMigration(
      db,
      TRIP_ID,
      "apply"
    );
    assert.equal(second.status, "not_eligible");
    assert.equal(await getBalance(MEMBER_UID), before);
  });
});

describe("runTripExpenseBalanceMigration - stale/unexpected pre-existing rows block the migration", () => {
  it("a pre-existing tripExpenseBalances row for a LEGACY Trip blocks apply WITHOUT ever setting migrating (Migration Recovery Review §3)", async () => {
    await seedTrip();
    await db
      .collection("tripExpenseBalances")
      .doc(balanceId(TRIP_ID, "stray-uid"))
      .set({ tripId: TRIP_ID, uid: "stray-uid", netBalanceMinor: 999 });

    const result = await runTripExpenseBalanceMigration(db, TRIP_ID, "apply");
    assert.equal(result.status, "blocked");
    assert.equal(result.staleRows.length, 1);
    // Frozen recovery principle: an already-anomalous LEGACY trip must
    // never be converted into a permanently-locked "migrating" trip
    // merely because a migration was attempted - the Trip's legacy
    // state (absent) is left completely unchanged.
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.expenseBalanceModelState, undefined);

    // Never auto-repaired - the stray row is left exactly as it was.
    const strayAfter = await getBalance("stray-uid");
    assert.equal(strayAfter, 999);
  });

  it("the same stale-row scenario is also detected and reported in dry_run, with the Trip left untouched", async () => {
    await seedTrip();
    await db
      .collection("tripExpenseBalances")
      .doc(balanceId(TRIP_ID, "stray-uid"))
      .set({ tripId: TRIP_ID, uid: "stray-uid", netBalanceMinor: 999 });

    const result = await runTripExpenseBalanceMigration(
      db,
      TRIP_ID,
      "dry_run"
    );
    assert.equal(result.status, "blocked");
    assert.equal(result.staleRows.length, 1);
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.expenseBalanceModelState, undefined);
  });
});

describe("runTripExpenseBalanceMigration - malformed source history fails closed, never marks initialized", () => {
  it("a malformed Expense (bad amountMinor) is reported as an anomaly and blocks apply", async () => {
    await seedTrip();
    await seedActiveExpense("exp-1", MEMBER_UID, 100, [
      MEMBER_UID,
      OTHER_MEMBER_UID,
    ]);
    await db
      .collection("tripExpenses")
      .doc("exp-1")
      .update({ amountMinor: "not-a-number" });

    const result = await runTripExpenseBalanceMigration(db, TRIP_ID, "apply");
    assert.equal(result.status, "blocked");
    assert.ok(result.anomalies.length > 0);
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    // Left in "migrating", never silently marked "initialized" despite
    // the failure.
    assert.equal(tripSnap.data()?.expenseBalanceModelState, "migrating");
    const all = await db.collection("tripExpenseBalances").get();
    assert.equal(all.size, 0);
  });

  it("a malformed ExpenseSplit (wrong userId type) is reported as an anomaly and blocks apply", async () => {
    await seedTrip();
    await seedActiveExpense("exp-1", MEMBER_UID, 100, [
      MEMBER_UID,
      OTHER_MEMBER_UID,
    ]);
    await db
      .collection("tripExpenseSplits")
      .doc(`exp-1_${MEMBER_UID}`)
      .update({ userId: 12345 });

    const result = await runTripExpenseBalanceMigration(db, TRIP_ID, "apply");
    assert.equal(result.status, "blocked");
    assert.ok(result.anomalies.length > 0);
  });
});

describe("runTripExpenseBalanceMigration - reversed-settlement migration semantics (Migration Recovery Review item 10)", () => {
  it("a reversed settlement contributes nothing (forward+inverse already net to zero)", async () => {
    await seedTrip();
    await seedActiveSettlement("set-1", MEMBER_UID, OTHER_MEMBER_UID, 500, {
      status: "reversed",
      reversedAt: new Date(),
      reversedBy: OTHER_MEMBER_UID,
    });
    await seedActiveSettlement("set-2", MEMBER_UID, OTHER_MEMBER_UID, 100);

    const result = await runTripExpenseBalanceMigration(db, TRIP_ID, "apply");
    assert.equal(result.status, "initialized");
    assert.equal(await getBalance(MEMBER_UID), 100);
    assert.equal(await getBalance(OTHER_MEMBER_UID), -100);
  });

  it("a settlement with a malformed/unknown status fails the whole migration closed, rather than being silently treated as active or ignored", async () => {
    await seedTrip();
    await seedActiveSettlement("set-1", MEMBER_UID, OTHER_MEMBER_UID, 500, {
      status: "bogus-status",
    });

    const result = await runTripExpenseBalanceMigration(db, TRIP_ID, "apply");
    assert.equal(result.status, "blocked");
    // Settlement status/reversal-shape validation is unified into
    // validateSettlementReversalShape's own "unknown status" wording -
    // see this file's own header comment.
    assert.ok(result.anomalies.some((a) => a.includes("unknown status")));
    const all = await db.collection("tripExpenseBalances").get();
    assert.equal(all.size, 0);
  });

  it("an Expense with a malformed/unknown status also fails the whole migration closed (identical status-handling fix)", async () => {
    await seedTrip();
    await seedActiveExpense(
      "exp-1",
      MEMBER_UID,
      100,
      [MEMBER_UID, OTHER_MEMBER_UID],
      { status: "bogus-status" }
    );

    const result = await runTripExpenseBalanceMigration(db, TRIP_ID, "apply");
    assert.equal(result.status, "blocked");
    assert.ok(
      result.anomalies.some((a) => a.includes("unsupported status"))
    );
  });
});

describe("runTripExpenseBalanceMigration - zero-share splits and validate-before-skip (Checkpoint 6.7A Final Financial Parity Review)", () => {
  it("an active out-of-pocket expense with a legitimate zero-share participant migrates successfully; balances exactly match expected", async () => {
    await seedTrip();
    // Hand-seeded splits (not the equal-split helper) so one
    // participant's share is genuinely, deliberately 0 - mirrors a
    // real custom-split persisted allocation.
    await db.collection("tripExpenses").doc("exp-1").set({
      tripId: TRIP_ID,
      payerUid: MEMBER_UID,
      createdBy: MEMBER_UID,
      amountMinor: 100,
      currency: "USD",
      description: "Zero-share test",
      splitStrategy: "custom",
      paymentSource: "member_out_of_pocket",
      status: "active",
      createdAt: new Date(),
    });
    await db.collection("tripExpenseSplits").doc("exp-1_zero").set({
      expenseId: "exp-1",
      tripId: TRIP_ID,
      userId: MEMBER_UID,
      amountMinor: 0,
      createdAt: new Date(),
    });
    await db.collection("tripExpenseSplits").doc("exp-1_full").set({
      expenseId: "exp-1",
      tripId: TRIP_ID,
      userId: OTHER_MEMBER_UID,
      amountMinor: 100,
      createdAt: new Date(),
    });

    const result = await runTripExpenseBalanceMigration(db, TRIP_ID, "apply");
    assert.equal(result.status, "initialized");
    assert.equal(await getBalance(MEMBER_UID), 100);
    assert.equal(await getBalance(OTHER_MEMBER_UID), -100);
  });

  it("a malformed REVERSED Expense (bad amountMinor) is blocked, never silently skipped merely because status is reversed", async () => {
    await seedTrip();
    await seedActiveExpense(
      "exp-1",
      MEMBER_UID,
      100,
      [MEMBER_UID, OTHER_MEMBER_UID],
      {
        status: "reversed",
        reversedAt: new Date(),
        reversedBy: OWNER_UID,
        amountMinor: "not-a-number",
      }
    );

    const result = await runTripExpenseBalanceMigration(db, TRIP_ID, "apply");
    assert.equal(result.status, "blocked");
    assert.ok(
      result.anomalies.some((a) => a.includes("malformed amountMinor"))
    );
    const all = await db.collection("tripExpenseBalances").get();
    assert.equal(all.size, 0);
  });

  it("a malformed REVERSED Settlement (missing reversedBy) is blocked, never silently skipped merely because status is reversed", async () => {
    await seedTrip();
    await seedActiveSettlement("set-1", MEMBER_UID, OTHER_MEMBER_UID, 500, {
      status: "reversed",
      reversedAt: new Date(),
      // reversedBy deliberately omitted - an invalid reversed shape.
    });

    const result = await runTripExpenseBalanceMigration(db, TRIP_ID, "apply");
    assert.equal(result.status, "blocked");
    assert.ok(result.anomalies.some((a) => a.includes("reversedBy")));
    const all = await db.collection("tripExpenseBalances").get();
    assert.equal(all.size, 0);
  });

  it("an unknown Expense paymentSource is a migration anomaly, never silently absent from the scan", async () => {
    await seedTrip();
    await seedActiveExpense(
      "exp-1",
      MEMBER_UID,
      100,
      [MEMBER_UID, OTHER_MEMBER_UID],
      { paymentSource: "bogus-payment-source" }
    );

    const result = await runTripExpenseBalanceMigration(db, TRIP_ID, "apply");
    assert.equal(result.status, "blocked");
    assert.ok(result.anomalies.some((a) => a.includes("paymentSource")));
  });
});

describe("runTripExpenseBalanceMigration - Trip-wide ExpenseSplit scan parity (Final ExpenseSplit Parity Audit)", () => {
  it("an ORPHAN split (expenseId references a nonexistent Expense) blocks migration - never silently invisible to a per-Expense query", async () => {
    await seedTrip();
    await seedActiveExpense("exp-1", MEMBER_UID, 100, [
      MEMBER_UID,
      OTHER_MEMBER_UID,
    ]);
    await db.collection("tripExpenseSplits").doc("orphan-split").set({
      tripId: TRIP_ID,
      expenseId: "does-not-exist",
      userId: OTHER_MEMBER_UID,
      amountMinor: 100,
      createdAt: new Date(),
    });

    const result = await runTripExpenseBalanceMigration(db, TRIP_ID, "apply");
    assert.equal(result.status, "blocked");
    assert.ok(
      result.anomalies.some((a) => a.includes("does not exist"))
    );
    const all = await db.collection("tripExpenseBalances").get();
    assert.equal(all.size, 0);
  });

  it("a split whose tripId matches this Trip but whose expenseId belongs to a DIFFERENT Trip blocks migration (cross-Trip routing)", async () => {
    const OTHER_TRIP_ID = "other-trip";
    await seedTrip();
    await db.collection("trips").doc(OTHER_TRIP_ID).set({
      ownerId: OWNER_UID,
      memberIds: [OWNER_UID, MEMBER_UID],
      title: "Other Trip",
      target: 500,
      saved: 0,
      imageUrl: "https://example.com/other.jpg",
      tripStartDate: "2027-01-01",
    });
    // A real, validly-shaped Expense - but it belongs to OTHER_TRIP_ID,
    // not the Trip being migrated.
    await db.collection("tripExpenses").doc("foreign-exp").set({
      tripId: OTHER_TRIP_ID,
      payerUid: MEMBER_UID,
      createdBy: MEMBER_UID,
      amountMinor: 50,
      currency: "USD",
      description: "Belongs to a different trip",
      splitStrategy: "equal",
      paymentSource: "member_out_of_pocket",
      status: "active",
      createdAt: new Date(),
    });
    // Malrouted: claims THIS Trip's tripId (so it is included in this
    // Trip's own split scan) but points at the OTHER Trip's Expense id.
    await db.collection("tripExpenseSplits").doc("malrouted-split").set({
      tripId: TRIP_ID,
      expenseId: "foreign-exp",
      userId: OTHER_MEMBER_UID,
      amountMinor: 50,
      createdAt: new Date(),
    });

    const result = await runTripExpenseBalanceMigration(db, TRIP_ID, "apply");
    assert.equal(result.status, "blocked");
    assert.ok(
      result.anomalies.some((a) => a.includes("does not exist"))
    );
  });

  it("a duplicate logical split (same expenseId + userId, different doc ids) blocks migration", async () => {
    await seedTrip();
    await seedActiveExpense("exp-1", MEMBER_UID, 100, [
      MEMBER_UID,
      OTHER_MEMBER_UID,
    ]);
    // A SECOND split document, different doc id, but the identical
    // logical (expenseId, userId) pair as an already-seeded split.
    await db.collection("tripExpenseSplits").doc("exp-1_duplicate").set({
      tripId: TRIP_ID,
      expenseId: "exp-1",
      userId: OTHER_MEMBER_UID,
      amountMinor: 50,
      createdAt: new Date(),
    });

    const result = await runTripExpenseBalanceMigration(db, TRIP_ID, "apply");
    assert.equal(result.status, "blocked");
    assert.ok(result.anomalies.some((a) => a.includes("Duplicate")));
  });

  it("a shared_stash Expense with attached splits whose total does NOT match its amountMinor blocks migration - splits are read and validated even though they are never queried for economic contribution", async () => {
    await seedTrip();
    await db.collection("tripExpenses").doc("stash-exp").set({
      tripId: TRIP_ID,
      payerUid: null,
      sharedStashTransactionId: "withdrawal-1",
      createdBy: MEMBER_UID,
      amountMinor: 100,
      currency: "USD",
      description: "Shared stash with bad split total",
      paymentSource: "shared_stash",
      status: "active",
      createdAt: new Date(),
    });
    await db.collection("tripExpenseSplits").doc("stash-exp_b").set({
      tripId: TRIP_ID,
      expenseId: "stash-exp",
      userId: MEMBER_UID,
      amountMinor: 60,
      createdAt: new Date(),
    });
    await db.collection("tripExpenseSplits").doc("stash-exp_c").set({
      tripId: TRIP_ID,
      expenseId: "stash-exp",
      userId: OTHER_MEMBER_UID,
      amountMinor: 20,
      createdAt: new Date(),
    });
    // 60 + 20 = 80, but the Expense's own amountMinor is 100 - malformed.

    const result = await runTripExpenseBalanceMigration(db, TRIP_ID, "apply");
    assert.equal(result.status, "blocked");
    assert.ok(
      result.anomalies.some((a) => a.includes("sum to 80"))
    );
    const all = await db.collection("tripExpenseBalances").get();
    assert.equal(all.size, 0);
  });

  it("a shared_stash Expense with VALID attached splits still contributes zero social delta (reporting-only evidence, never pairwise debt)", async () => {
    await seedTrip();
    await db.collection("tripExpenses").doc("stash-exp").set({
      tripId: TRIP_ID,
      payerUid: null,
      sharedStashTransactionId: "withdrawal-1",
      createdBy: MEMBER_UID,
      amountMinor: 100,
      currency: "USD",
      description: "Shared stash with valid reporting splits",
      paymentSource: "shared_stash",
      status: "active",
      createdAt: new Date(),
    });
    await db.collection("tripExpenseSplits").doc("stash-exp_b").set({
      tripId: TRIP_ID,
      expenseId: "stash-exp",
      userId: MEMBER_UID,
      amountMinor: 60,
      createdAt: new Date(),
    });
    await db.collection("tripExpenseSplits").doc("stash-exp_c").set({
      tripId: TRIP_ID,
      expenseId: "stash-exp",
      userId: OTHER_MEMBER_UID,
      amountMinor: 40,
      createdAt: new Date(),
    });

    const result = await runTripExpenseBalanceMigration(db, TRIP_ID, "apply");
    assert.equal(result.status, "initialized");
    const all = await db.collection("tripExpenseBalances").get();
    assert.equal(all.size, 0);
    assert.equal(await getBalance(MEMBER_UID), undefined);
    assert.equal(await getBalance(OTHER_MEMBER_UID), undefined);
  });
});

describe("runTripExpenseBalanceMigration - crash recovery via explicit resume (Migration Recovery Review §§5-8)", () => {
  it("crash immediately after lock: migrating with zero rows resumes and initializes cleanly", async () => {
    await seedTrip({ expenseBalanceModelState: "migrating" });
    await seedActiveExpense("exp-1", MEMBER_UID, 100, [
      MEMBER_UID,
      OTHER_MEMBER_UID,
    ]);

    // Without --resume, a migrating Trip is not eligible at all.
    const withoutResume = await runTripExpenseBalanceMigration(
      db,
      TRIP_ID,
      "apply"
    );
    assert.equal(withoutResume.status, "not_eligible");
    const all0 = await db.collection("tripExpenseBalances").get();
    assert.equal(all0.size, 0);

    const result = await runTripExpenseBalanceMigration(
      db,
      TRIP_ID,
      "apply",
      { resume: true }
    );
    assert.equal(result.status, "initialized");
    assert.equal(await getBalance(MEMBER_UID), 50);
    assert.equal(await getBalance(OTHER_MEMBER_UID), -50);
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.expenseBalanceModelState, "initialized");
  });

  it("crash after partial row write: exact partial rows are accepted, missing rows are written, no duplicates", async () => {
    await seedTrip({ expenseBalanceModelState: "migrating" });
    await seedActiveExpense("exp-1", MEMBER_UID, 100, [
      MEMBER_UID,
      OTHER_MEMBER_UID,
    ]);
    // One of the two expected rows was already written before the
    // crash, with the EXACT correct recomputed value.
    await db
      .collection("tripExpenseBalances")
      .doc(balanceId(TRIP_ID, MEMBER_UID))
      .set({
        tripId: TRIP_ID,
        uid: MEMBER_UID,
        netBalanceMinor: 50,
        updatedAt: new Date(),
      });

    const result = await runTripExpenseBalanceMigration(
      db,
      TRIP_ID,
      "apply",
      { resume: true }
    );
    assert.equal(result.status, "initialized");
    assert.equal(await getBalance(MEMBER_UID), 50);
    assert.equal(await getBalance(OTHER_MEMBER_UID), -50);
    const all = await db.collection("tripExpenseBalances").get();
    assert.equal(all.size, 2);
  });

  it("crash after ALL rows written, before the final state flip: resume validates parity and initializes without changing any value", async () => {
    await seedTrip({ expenseBalanceModelState: "migrating" });
    await seedActiveExpense("exp-1", MEMBER_UID, 100, [
      MEMBER_UID,
      OTHER_MEMBER_UID,
    ]);
    await db
      .collection("tripExpenseBalances")
      .doc(balanceId(TRIP_ID, MEMBER_UID))
      .set({ tripId: TRIP_ID, uid: MEMBER_UID, netBalanceMinor: 50 });
    await db
      .collection("tripExpenseBalances")
      .doc(balanceId(TRIP_ID, OTHER_MEMBER_UID))
      .set({ tripId: TRIP_ID, uid: OTHER_MEMBER_UID, netBalanceMinor: -50 });

    const result = await runTripExpenseBalanceMigration(
      db,
      TRIP_ID,
      "apply",
      { resume: true }
    );
    assert.equal(result.status, "initialized");
    assert.equal(await getBalance(MEMBER_UID), 50);
    assert.equal(await getBalance(OTHER_MEMBER_UID), -50);
  });

  it("a dry_run resume previews initialization without writing or finalizing", async () => {
    await seedTrip({ expenseBalanceModelState: "migrating" });
    await seedActiveExpense("exp-1", MEMBER_UID, 100, [
      MEMBER_UID,
      OTHER_MEMBER_UID,
    ]);

    const result = await runTripExpenseBalanceMigration(
      db,
      TRIP_ID,
      "dry_run",
      { resume: true }
    );
    assert.equal(result.status, "would_initialize");
    const all = await db.collection("tripExpenseBalances").get();
    assert.equal(all.size, 0);
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.expenseBalanceModelState, "migrating");
  });

  it("conflicting partial row (wrong value): resume rejects, leaves migrating, does not overwrite the wrong value", async () => {
    await seedTrip({ expenseBalanceModelState: "migrating" });
    await seedActiveExpense("exp-1", MEMBER_UID, 100, [
      MEMBER_UID,
      OTHER_MEMBER_UID,
    ]);
    await db
      .collection("tripExpenseBalances")
      .doc(balanceId(TRIP_ID, MEMBER_UID))
      .set({ tripId: TRIP_ID, uid: MEMBER_UID, netBalanceMinor: 9999 });

    const result = await runTripExpenseBalanceMigration(
      db,
      TRIP_ID,
      "apply",
      { resume: true }
    );
    assert.equal(result.status, "blocked");
    assert.equal(result.staleRows.length, 1);
    assert.equal(result.staleRows[0].uid, MEMBER_UID);
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.expenseBalanceModelState, "migrating");
    // The wrong value is left exactly as it was - never auto-repaired.
    assert.equal(await getBalance(MEMBER_UID), 9999);
    assert.equal(await getBalance(OTHER_MEMBER_UID), undefined);
  });

  it("unexpected extra row (uid not in recomputed truth): resume rejects, leaves migrating, does not delete the row", async () => {
    await seedTrip({ expenseBalanceModelState: "migrating" });
    await seedActiveExpense("exp-1", MEMBER_UID, 100, [
      MEMBER_UID,
      OTHER_MEMBER_UID,
    ]);
    await db
      .collection("tripExpenseBalances")
      .doc(balanceId(TRIP_ID, "extra-uid"))
      .set({ tripId: TRIP_ID, uid: "extra-uid", netBalanceMinor: 1 });

    const result = await runTripExpenseBalanceMigration(
      db,
      TRIP_ID,
      "apply",
      { resume: true }
    );
    assert.equal(result.status, "blocked");
    assert.equal(result.staleRows.length, 1);
    assert.equal(result.staleRows[0].uid, "extra-uid");
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.expenseBalanceModelState, "migrating");
    const extraSnap = await db
      .collection("tripExpenseBalances")
      .doc(balanceId(TRIP_ID, "extra-uid"))
      .get();
    assert.equal(extraSnap.exists, true);
    assert.equal(await getBalance(MEMBER_UID), undefined);
  });

  it("malformed existing row (wrong shape): resume rejects, leaves migrating", async () => {
    await seedTrip({ expenseBalanceModelState: "migrating" });
    await seedActiveExpense("exp-1", MEMBER_UID, 100, [
      MEMBER_UID,
      OTHER_MEMBER_UID,
    ]);
    // Deliberately written at a NONCANONICAL document id, mirroring the
    // established tripMemberOwnership precedent for this exact class of
    // defensive test.
    await db.collection("tripExpenseBalances").doc("rogue-doc-id").set({
      tripId: TRIP_ID,
      uid: MEMBER_UID,
      netBalanceMinor: 50,
    });

    const result = await runTripExpenseBalanceMigration(
      db,
      TRIP_ID,
      "apply",
      { resume: true }
    );
    assert.equal(result.status, "blocked");
    assert.equal(result.staleRows.length, 1);
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.expenseBalanceModelState, "migrating");
  });
});

describe("runTripExpenseBalanceMigration - concurrent first-run lock acquisition (Migration Recovery Review §9/§4)", () => {
  it("of two concurrent first-run apply attempts, exactly one acquires the legacy -> migrating transition and succeeds; the other fails safely", async () => {
    await seedTrip();
    await seedActiveExpense("exp-1", MEMBER_UID, 100, [
      MEMBER_UID,
      OTHER_MEMBER_UID,
    ]);

    const [first, second] = await Promise.all([
      runTripExpenseBalanceMigration(db, TRIP_ID, "apply"),
      runTripExpenseBalanceMigration(db, TRIP_ID, "apply"),
    ]);

    const statuses = [first.status, second.status].sort();
    // Exactly one of the two genuinely-concurrent attempts observes the
    // Trip still "legacy" at its own lock-acquisition instant and wins;
    // the other observes the now-changed state and is blocked. Neither
    // attempt is silently retried or allowed to double-apply.
    assert.deepEqual(statuses, ["blocked", "initialized"]);

    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.expenseBalanceModelState, "initialized");
    assert.equal(await getBalance(MEMBER_UID), 50);
    assert.equal(await getBalance(OTHER_MEMBER_UID), -50);
    const all = await db.collection("tripExpenseBalances").get();
    assert.equal(all.size, 2);
  });
});

describe("resolveExecutionTarget - production safety", () => {
  it("the emulator is always safe with no --project flag", () => {
    const target = resolveExecutionTarget({
      emulatorHost: "localhost:8080",
      tripId: TRIP_ID,
      mode: "dry_run",
      projectFlag: undefined,
      confirmFlag: undefined,
    });
    assert.equal(target.ok, true);
    if (target.ok) assert.equal(target.mode, "emulator");
  });

  it("no emulator and a non-matching --project refuses to run", () => {
    const target = resolveExecutionTarget({
      emulatorHost: undefined,
      tripId: TRIP_ID,
      mode: "dry_run",
      projectFlag: "some-other-project",
      confirmFlag: undefined,
    });
    assert.equal(target.ok, false);
  });

  it("production dry_run is allowed with just --project matching", () => {
    const target = resolveExecutionTarget({
      emulatorHost: undefined,
      tripId: TRIP_ID,
      mode: "dry_run",
      projectFlag: PRODUCTION_PROJECT_ID,
      confirmFlag: undefined,
    });
    assert.equal(target.ok, true);
    if (target.ok) assert.equal(target.mode, "production");
  });

  it("production apply without --confirm matching the tripId refuses to run", () => {
    const target = resolveExecutionTarget({
      emulatorHost: undefined,
      tripId: TRIP_ID,
      mode: "apply",
      projectFlag: PRODUCTION_PROJECT_ID,
      confirmFlag: undefined,
    });
    assert.equal(target.ok, false);
  });

  it("production apply with --confirm exactly matching the tripId is allowed", () => {
    const target = resolveExecutionTarget({
      emulatorHost: undefined,
      tripId: TRIP_ID,
      mode: "apply",
      projectFlag: PRODUCTION_PROJECT_ID,
      confirmFlag: TRIP_ID,
    });
    assert.equal(target.ok, true);
  });

  it("production apply with --confirm NOT matching the tripId refuses to run", () => {
    const target = resolveExecutionTarget({
      emulatorHost: undefined,
      tripId: TRIP_ID,
      mode: "apply",
      projectFlag: PRODUCTION_PROJECT_ID,
      confirmFlag: "some-other-trip",
    });
    assert.equal(target.ok, false);
  });
});
