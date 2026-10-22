// Checkpoint 5C.6: emulator-backed integration tests for the trusted
// Trip-ownership reconciliation/repair tool
// (functions/src/admin/reconcileTripOwnership.ts), against the local
// Firestore emulator via the Admin SDK - NEVER production. Covers the
// dry-run/apply happy paths, the control-document concurrency model,
// allocation validation (both provenances), zero-row retention,
// rogue-row deletion, finalization re-verification, failure/retry
// semantics, archived-Trip repair, and the pure CLI execution-target
// guard.
import assert from "node:assert/strict";
import {after, before, beforeEach, describe, it} from "node:test";
import {deleteApp, initializeApp} from "firebase-admin/app";
import type {App} from "firebase-admin/app";
import {FieldValue, Timestamp, getFirestore} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";
import {
  AUTOMATIC_RECONCILIATION_HISTORY_LIMIT,
  PRODUCTION_PROJECT_ID,
  resolveReconciliationExecutionTarget,
  runApply,
  runDryRun,
} from "../src/admin/reconcileTripOwnership";
import {CURRENT_TRIP_OWNERSHIP_MODEL_VERSION} from "../src/domain/tripOwnershipModel";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "FIRESTORE_EMULATOR_HOST is not set. Run these tests via " +
      '`firebase emulators:exec --only firestore "npm --prefix functions test"` ' +
      "so the Admin SDK talks to the local emulator, never production."
  );
}

const TRIP_ID = "test-trip";
const DANIEL = "daniel";
const FRIEND = "friend";

let app: App;
let db: Firestore;

before(() => {
  app = initializeApp({
    projectId: "demo-squadstash-functions-test-reconcile-trip-ownership",
  });
  db = getFirestore(app);
});

after(async () => {
  await deleteApp(app);
});

async function clearFirestore(): Promise<void> {
  for (const name of [
    "trips",
    "savingsTransactions",
    "tripExpenses",
    "tripMemberOwnership",
    "tripOwnershipAllocations",
    "tripOwnershipReconciliationAttempts",
    "tripOwnershipReconciliationControl",
  ]) {
    const snap = await db.collection(name).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

beforeEach(async () => {
  await clearFirestore();
});

function seedTrip(
  overrides: Record<string, unknown> = {}
): Promise<FirebaseFirestore.WriteResult> {
  return db
    .collection("trips")
    .doc(TRIP_ID)
    .set({
      ownerId: DANIEL,
      memberIds: [DANIEL, FRIEND],
      title: "Test Trip",
      target: 1000,
      saved: 10,
      ledgerOpeningBalanceMinor: 0,
      ledgerBalanceMinor: 1000,
      currency: "USD",
      imageUrl: "https://example.com/trip.jpg",
      ownershipModelState: "needs_reconciliation",
      ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
      ...overrides,
    });
}

function seedOrdinaryTransaction(
  id: string,
  uid: string,
  type: "contribution" | "withdrawal",
  amountMinor: number,
  millis: number
): Promise<FirebaseFirestore.WriteResult> {
  return db.collection("savingsTransactions").doc(id).set({
    resourceType: "trip",
    resourceId: TRIP_ID,
    memberUid: uid,
    type,
    amountMinor,
    currency: "USD",
    createdAt: Timestamp.fromMillis(millis),
    reversalOf: null,
  });
}

function seedOwnershipRow(
  uid: string,
  ownershipMinor: number
): Promise<FirebaseFirestore.WriteResult> {
  return db
    .collection("tripMemberOwnership")
    .doc(`${TRIP_ID}_${uid}`)
    .set({
      tripId: TRIP_ID,
      uid,
      ownershipMinor,
      lastUpdatedAt: FieldValue.serverTimestamp(),
    });
}

/**
 * Seeds the canonical healthy two-contribution fixture: daniel +600,
 * friend +400, aggregate 1000, matching ownership rows already present
 * and consistent (no drift) - the baseline every "repaired" happy-path
 * test starts from.
 */
async function seedHealthyFixture(): Promise<void> {
  await seedTrip();
  await seedOrdinaryTransaction("tx-1", DANIEL, "contribution", 600, 1000);
  await seedOrdinaryTransaction("tx-2", FRIEND, "contribution", 400, 2000);
  await seedOwnershipRow(DANIEL, 600);
  await seedOwnershipRow(FRIEND, 400);
}

// ---------------------------------------------------------------------
// Pure CLI execution-target guard
// ---------------------------------------------------------------------

describe("resolveReconciliationExecutionTarget", () => {
  it("accepts emulator mode regardless of project flag", () => {
    const result = resolveReconciliationExecutionTarget({
      emulatorHost: "127.0.0.1:8080",
      tripId: TRIP_ID,
      mode: "apply",
      projectFlag: undefined,
      confirmFlag: undefined,
    });
    assert.deepEqual(result, {
      ok: true,
      mode: "emulator",
      projectId: "demo-reconcile-trip-ownership",
    });
  });

  it("refuses a wrong/missing production project", () => {
    const result = resolveReconciliationExecutionTarget({
      emulatorHost: undefined,
      tripId: TRIP_ID,
      mode: "dry_run",
      projectFlag: "some-other-project",
      confirmFlag: undefined,
    });
    assert.equal(result.ok, false);
  });

  it("refuses production apply missing --confirm", () => {
    const result = resolveReconciliationExecutionTarget({
      emulatorHost: undefined,
      tripId: TRIP_ID,
      mode: "apply",
      projectFlag: PRODUCTION_PROJECT_ID,
      confirmFlag: undefined,
    });
    assert.equal(result.ok, false);
  });

  it("refuses production apply with a WRONG --confirm", () => {
    const result = resolveReconciliationExecutionTarget({
      emulatorHost: undefined,
      tripId: TRIP_ID,
      mode: "apply",
      projectFlag: PRODUCTION_PROJECT_ID,
      confirmFlag: "wrong-trip-id",
    });
    assert.equal(result.ok, false);
  });

  it("accepts production apply with the EXACT confirm echo-back", () => {
    const result = resolveReconciliationExecutionTarget({
      emulatorHost: undefined,
      tripId: TRIP_ID,
      mode: "apply",
      projectFlag: PRODUCTION_PROJECT_ID,
      confirmFlag: TRIP_ID,
    });
    assert.deepEqual(result, {
      ok: true,
      mode: "production",
      projectId: PRODUCTION_PROJECT_ID,
    });
  });

  it("accepts production dry-run with no --confirm at all", () => {
    const result = resolveReconciliationExecutionTarget({
      emulatorHost: undefined,
      tripId: TRIP_ID,
      mode: "dry_run",
      projectFlag: PRODUCTION_PROJECT_ID,
      confirmFlag: undefined,
    });
    assert.equal(result.ok, true);
  });
});

// ---------------------------------------------------------------------
// Dry run - zero writes under any circumstance.
// ---------------------------------------------------------------------

describe("runDryRun", () => {
  it("a Trip not needing reconciliation is requires_manual_review, zero writes", async () => {
    await seedTrip({
      ownershipModelState: "initialized",
      ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
    });
    const result = await runDryRun(db, TRIP_ID);
    assert.equal(result.verdict, "requires_manual_review");
    assert.equal(
      result.anomalies.some((a) => a.reasonCode === "trip_not_eligible"),
      true
    );
    const attemptsSnap = await db
      .collection("tripOwnershipReconciliationAttempts")
      .get();
    assert.equal(attemptsSnap.size, 0);
    const controlSnap = await db
      .collection("tripOwnershipReconciliationControl")
      .doc(TRIP_ID)
      .get();
    assert.equal(controlSnap.exists, false);
  });

  it("a healthy needs_reconciliation Trip is safe_to_reconcile, zero writes", async () => {
    await seedHealthyFixture();
    const result = await runDryRun(db, TRIP_ID);
    assert.equal(result.verdict, "safe_to_reconcile");
    assert.equal(result.expectedOwnershipTotalMinor, 1000);
    assert.deepEqual(
      [...(result.expectedOwnership ?? [])].sort((a, b) => (a.uid < b.uid ? -1 : 1)),
      [
        {uid: DANIEL, ownershipMinor: 600},
        {uid: FRIEND, ownershipMinor: 400},
      ]
    );
    assert.deepEqual(result.rogueOwnershipRowUids, []);

    const attemptsSnap = await db
      .collection("tripOwnershipReconciliationAttempts")
      .get();
    assert.equal(attemptsSnap.size, 0);
    const controlSnap = await db
      .collection("tripOwnershipReconciliationControl")
      .doc(TRIP_ID)
      .get();
    assert.equal(controlSnap.exists, false);
  });

  it("history exceeding the automatic limit is requires_manual_review", async () => {
    await seedTrip({ledgerBalanceMinor: 0, saved: 0});
    const batchSize = 500;
    const totalDocs = AUTOMATIC_RECONCILIATION_HISTORY_LIMIT + 1;
    for (let start = 0; start < totalDocs; start += batchSize) {
      const batch = db.batch();
      const end = Math.min(start + batchSize, totalDocs);
      for (let i = start; i < end; i++) {
        batch.set(db.collection("savingsTransactions").doc(`bulk-${i}`), {
          resourceType: "trip",
          resourceId: TRIP_ID,
          memberUid: DANIEL,
          type: "contribution",
          amountMinor: 1,
          currency: "USD",
          createdAt: Timestamp.fromMillis(1000 + i),
          reversalOf: null,
        });
      }
      await batch.commit();
    }

    const result = await runDryRun(db, TRIP_ID);
    assert.equal(result.verdict, "requires_manual_review");
    assert.equal(
      result.anomalies.some(
        (a) => a.reasonCode === "history_exceeds_automatic_reconciliation_limit"
      ),
      true
    );
  });

  it("a persisted allocation economic mismatch is requires_manual_review", async () => {
    await seedTrip();
    await seedOrdinaryTransaction("tx-1", DANIEL, "contribution", 1000, 1000);
    await db.collection("tripExpenses").doc("exp-1").set({
      tripId: TRIP_ID,
      paymentSource: "shared_stash",
      amountMinor: 300,
      currency: "USD",
      sharedStashTransactionId: "wd-1",
      status: "active",
      createdAt: Timestamp.fromMillis(2000),
    });
    await db.collection("savingsTransactions").doc("wd-1").set({
      resourceType: "trip",
      resourceId: TRIP_ID,
      memberUid: DANIEL,
      recordedBy: DANIEL,
      type: "withdrawal",
      amountMinor: 300,
      currency: "USD",
      createdAt: Timestamp.fromMillis(2000),
      reversalOf: null,
      linkedExpenseId: "exp-1",
    });
    await seedOwnershipRow(DANIEL, 700);
    await seedTrip({ledgerBalanceMinor: 700, saved: 7});
    // Corrupted: the persisted allocation claims a different amount than
    // the real withdrawal/expense (300).
    await db.collection("tripOwnershipAllocations").doc("wd-1").set({
      tripId: TRIP_ID,
      expenseId: "exp-1",
      withdrawalTransactionId: "wd-1",
      amountMinor: 299,
      currency: "USD",
      allocations: [{uid: DANIEL, amountMinor: 299}],
      provenance: "original",
      createdAt: Timestamp.fromMillis(2000),
    });

    const result = await runDryRun(db, TRIP_ID);
    assert.equal(result.verdict, "requires_manual_review");
    assert.equal(
      result.anomalies.some(
        (a) => a.reasonCode === "allocation_economic_mismatch"
      ),
      true
    );
  });

  it("a missing persisted allocation is requires_manual_review", async () => {
    await seedTrip();
    await seedOrdinaryTransaction("tx-1", DANIEL, "contribution", 1000, 1000);
    await db.collection("tripExpenses").doc("exp-1").set({
      tripId: TRIP_ID,
      paymentSource: "shared_stash",
      amountMinor: 300,
      currency: "USD",
      sharedStashTransactionId: "wd-1",
      status: "active",
      createdAt: Timestamp.fromMillis(2000),
    });
    await db.collection("savingsTransactions").doc("wd-1").set({
      resourceType: "trip",
      resourceId: TRIP_ID,
      memberUid: DANIEL,
      recordedBy: DANIEL,
      type: "withdrawal",
      amountMinor: 300,
      currency: "USD",
      createdAt: Timestamp.fromMillis(2000),
      reversalOf: null,
      linkedExpenseId: "exp-1",
    });
    await seedOwnershipRow(DANIEL, 700);
    await seedTrip({ledgerBalanceMinor: 700, saved: 7});
    // No tripOwnershipAllocations record created at all.

    const result = await runDryRun(db, TRIP_ID);
    assert.equal(result.verdict, "requires_manual_review");
    assert.equal(
      result.anomalies.some(
        (a) => a.reasonCode === "missing_persisted_allocation"
      ),
      true
    );
  });

  it("an extra persisted allocation (no corresponding replay output) is requires_manual_review", async () => {
    await seedHealthyFixture();
    // A stray allocation record referencing a withdrawal that was never
    // part of this Trip's real history.
    await db.collection("tripOwnershipAllocations").doc("stray-wd").set({
      tripId: TRIP_ID,
      expenseId: "stray-exp",
      withdrawalTransactionId: "stray-wd",
      amountMinor: 50,
      currency: "USD",
      allocations: [{uid: DANIEL, amountMinor: 50}],
      provenance: "original",
      createdAt: Timestamp.fromMillis(5000),
    });

    const result = await runDryRun(db, TRIP_ID);
    assert.equal(result.verdict, "requires_manual_review");
    assert.equal(
      result.anomalies.some(
        (a) => a.reasonCode === "extra_persisted_allocation"
      ),
      true
    );
  });

  it("rogue ownership rows (no supporting history) are reported, not silently ignored", async () => {
    await seedHealthyFixture();
    await seedOwnershipRow("rogue-uid", 500);

    const result = await runDryRun(db, TRIP_ID);
    assert.equal(result.verdict, "safe_to_reconcile");
    assert.deepEqual(result.rogueOwnershipRowUids, ["rogue-uid"]);
  });
});

// ---------------------------------------------------------------------
// Apply - happy path, control/attempt lifecycle.
// ---------------------------------------------------------------------

describe("runApply - happy path", () => {
  it("first-ever attempt: repairs, creates the control document, marks completed", async () => {
    await seedHealthyFixture();
    const result = await runApply(db, TRIP_ID);
    assert.equal(result.verdict, "repaired");
    assert.equal(result.phase, "completed");
    assert.ok(result.attemptId);

    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.ownershipModelState, "initialized");
    assert.equal(tripSnap.data()?.ledgerBalanceMinor, 1000);

    const controlSnap = await db
      .collection("tripOwnershipReconciliationControl")
      .doc(TRIP_ID)
      .get();
    assert.equal(controlSnap.data()?.activeAttemptId, null);
    assert.equal(controlSnap.data()?.lastCompletedAttemptId, result.attemptId);

    const attemptSnap = await db
      .collection("tripOwnershipReconciliationAttempts")
      .doc(`${TRIP_ID}_${result.attemptId}`)
      .get();
    assert.equal(attemptSnap.data()?.phase, "completed");
  });

  it("leaves Trip.lastUpdatedAt and Trip.lastUpdatedBy completely untouched", async () => {
    await seedTrip({lastUpdatedAt: Timestamp.fromMillis(42), lastUpdatedBy: "nobody"});
    await seedOrdinaryTransaction("tx-1", DANIEL, "contribution", 1000, 1000);
    await seedOwnershipRow(DANIEL, 1000);

    await runApply(db, TRIP_ID);

    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.deepEqual(tripSnap.data()?.lastUpdatedAt, Timestamp.fromMillis(42));
    assert.equal(tripSnap.data()?.lastUpdatedBy, "nobody");
  });

  it("repairs a drifted existing ownership row back to the replay-proven value", async () => {
    await seedTrip();
    await seedOrdinaryTransaction("tx-1", DANIEL, "contribution", 600, 1000);
    await seedOrdinaryTransaction("tx-2", FRIEND, "contribution", 400, 2000);
    // Drifted: daniel's row is corrupted to 999 instead of 600.
    await seedOwnershipRow(DANIEL, 999);
    await seedOwnershipRow(FRIEND, 400);

    const result = await runApply(db, TRIP_ID);
    assert.equal(result.verdict, "repaired");

    const danielSnap = await db
      .collection("tripMemberOwnership")
      .doc(`${TRIP_ID}_${DANIEL}`)
      .get();
    assert.equal(danielSnap.data()?.ownershipMinor, 600);
  });

  it("retains a legitimate zero-balance row (withdrawn to exactly zero)", async () => {
    await seedTrip({ledgerBalanceMinor: 400, saved: 4});
    await seedOrdinaryTransaction("tx-1", DANIEL, "contribution", 600, 1000);
    await seedOrdinaryTransaction("tx-2", DANIEL, "withdrawal", 600, 2000);
    await seedOrdinaryTransaction("tx-3", FRIEND, "contribution", 400, 3000);
    await seedOwnershipRow(DANIEL, 0);
    await seedOwnershipRow(FRIEND, 400);

    const result = await runApply(db, TRIP_ID);
    assert.equal(result.verdict, "repaired");

    const danielSnap = await db
      .collection("tripMemberOwnership")
      .doc(`${TRIP_ID}_${DANIEL}`)
      .get();
    assert.equal(danielSnap.exists, true);
    assert.equal(danielSnap.data()?.ownershipMinor, 0);
  });

  it("deletes a rogue row with no supporting financial history", async () => {
    await seedHealthyFixture();
    await seedOwnershipRow("rogue-uid", 500);

    const result = await runApply(db, TRIP_ID);
    assert.equal(result.verdict, "repaired");
    assert.deepEqual(result.rogueOwnershipRowUids, ["rogue-uid"]);

    const rogueSnap = await db
      .collection("tripMemberOwnership")
      .doc(`${TRIP_ID}_rogue-uid`)
      .get();
    assert.equal(rogueSnap.exists, false);
  });

  it("validates original-provenance allocation evidence and repairs successfully", async () => {
    await seedTrip();
    await seedOrdinaryTransaction("tx-1", DANIEL, "contribution", 1000, 1000);
    await db.collection("tripExpenses").doc("exp-1").set({
      tripId: TRIP_ID,
      paymentSource: "shared_stash",
      amountMinor: 300,
      currency: "USD",
      sharedStashTransactionId: "wd-1",
      status: "active",
      createdAt: Timestamp.fromMillis(2000),
    });
    await db.collection("savingsTransactions").doc("wd-1").set({
      resourceType: "trip",
      resourceId: TRIP_ID,
      memberUid: DANIEL,
      recordedBy: DANIEL,
      type: "withdrawal",
      amountMinor: 300,
      currency: "USD",
      createdAt: Timestamp.fromMillis(2000),
      reversalOf: null,
      linkedExpenseId: "exp-1",
    });
    await db.collection("tripOwnershipAllocations").doc("wd-1").set({
      tripId: TRIP_ID,
      expenseId: "exp-1",
      withdrawalTransactionId: "wd-1",
      amountMinor: 300,
      currency: "USD",
      allocations: [{uid: DANIEL, amountMinor: 300}],
      provenance: "original",
      createdAt: Timestamp.fromMillis(2000),
    });
    await seedTrip({ledgerBalanceMinor: 700, saved: 7});
    await seedOwnershipRow(DANIEL, 700);

    const result = await runApply(db, TRIP_ID);
    assert.equal(result.verdict, "repaired");
    assert.equal(result.validatedAllocationCount, 1);
  });

  it("validates migrated-provenance allocation evidence and repairs successfully", async () => {
    await seedTrip();
    await seedOrdinaryTransaction("tx-1", DANIEL, "contribution", 1000, 1000);
    await db.collection("tripExpenses").doc("exp-1").set({
      tripId: TRIP_ID,
      paymentSource: "shared_stash",
      amountMinor: 300,
      currency: "USD",
      sharedStashTransactionId: "wd-1",
      status: "active",
      createdAt: Timestamp.fromMillis(2000),
    });
    await db.collection("savingsTransactions").doc("wd-1").set({
      resourceType: "trip",
      resourceId: TRIP_ID,
      memberUid: DANIEL,
      recordedBy: DANIEL,
      type: "withdrawal",
      amountMinor: 300,
      currency: "USD",
      createdAt: Timestamp.fromMillis(2000),
      reversalOf: null,
      linkedExpenseId: "exp-1",
    });
    await db.collection("tripOwnershipAllocations").doc("wd-1").set({
      tripId: TRIP_ID,
      expenseId: "exp-1",
      withdrawalTransactionId: "wd-1",
      amountMinor: 300,
      currency: "USD",
      allocations: [{uid: DANIEL, amountMinor: 300}],
      provenance: "migrated",
      createdAt: Timestamp.fromMillis(2000),
      migratedAt: FieldValue.serverTimestamp(),
    });
    await seedTrip({ledgerBalanceMinor: 700, saved: 7});
    await seedOwnershipRow(DANIEL, 700);

    const result = await runApply(db, TRIP_ID);
    assert.equal(result.verdict, "repaired");
    assert.equal(result.validatedAllocationCount, 1);
  });

  it("validates a MIXED persisted allocation set (one \"original\" + one \"migrated\") and repairs successfully", async () => {
    await seedTrip();
    await seedOrdinaryTransaction("tx-1", DANIEL, "contribution", 1000, 1000);

    // Allocation 1 - provenance "original" (a genuine live spend).
    await db.collection("tripExpenses").doc("exp-1").set({
      tripId: TRIP_ID,
      paymentSource: "shared_stash",
      amountMinor: 200,
      currency: "USD",
      sharedStashTransactionId: "wd-1",
      status: "active",
      createdAt: Timestamp.fromMillis(2000),
    });
    await db.collection("savingsTransactions").doc("wd-1").set({
      resourceType: "trip",
      resourceId: TRIP_ID,
      memberUid: DANIEL,
      recordedBy: DANIEL,
      type: "withdrawal",
      amountMinor: 200,
      currency: "USD",
      createdAt: Timestamp.fromMillis(2000),
      reversalOf: null,
      linkedExpenseId: "exp-1",
    });
    await db.collection("tripOwnershipAllocations").doc("wd-1").set({
      tripId: TRIP_ID,
      expenseId: "exp-1",
      withdrawalTransactionId: "wd-1",
      amountMinor: 200,
      currency: "USD",
      allocations: [{uid: DANIEL, amountMinor: 200}],
      provenance: "original",
      createdAt: Timestamp.fromMillis(2000),
    });

    // Allocation 2 - provenance "migrated" (backfilled by the migration
    // tool), chronologically AFTER allocation 1 - both coexist on the
    // SAME Trip simultaneously, exactly as a real post-migration Trip
    // with subsequent live spending would.
    await db.collection("tripExpenses").doc("exp-2").set({
      tripId: TRIP_ID,
      paymentSource: "shared_stash",
      amountMinor: 100,
      currency: "USD",
      sharedStashTransactionId: "wd-2",
      status: "active",
      createdAt: Timestamp.fromMillis(3000),
    });
    await db.collection("savingsTransactions").doc("wd-2").set({
      resourceType: "trip",
      resourceId: TRIP_ID,
      memberUid: DANIEL,
      recordedBy: DANIEL,
      type: "withdrawal",
      amountMinor: 100,
      currency: "USD",
      createdAt: Timestamp.fromMillis(3000),
      reversalOf: null,
      linkedExpenseId: "exp-2",
    });
    await db.collection("tripOwnershipAllocations").doc("wd-2").set({
      tripId: TRIP_ID,
      expenseId: "exp-2",
      withdrawalTransactionId: "wd-2",
      amountMinor: 100,
      currency: "USD",
      allocations: [{uid: DANIEL, amountMinor: 100}],
      provenance: "migrated",
      createdAt: Timestamp.fromMillis(3000),
      migratedAt: FieldValue.serverTimestamp(),
    });

    await seedTrip({ledgerBalanceMinor: 700, saved: 7});
    await seedOwnershipRow(DANIEL, 700);

    const result = await runApply(db, TRIP_ID);
    assert.equal(result.verdict, "repaired");
    // Both allocations - one of EACH provenance - were validated
    // together, producing ONE combined digest over the complete set.
    assert.equal(result.validatedAllocationCount, 2);
  });

  it("archived Trips are repaired with no special blocking", async () => {
    await seedHealthyFixture();
    await db
      .collection("trips")
      .doc(TRIP_ID)
      .update({archivedAt: FieldValue.serverTimestamp()});

    const result = await runApply(db, TRIP_ID);
    assert.equal(result.verdict, "repaired");
  });

  it("a later, independent repair episode after a completed one creates a brand-new attempt", async () => {
    await seedHealthyFixture();
    const first = await runApply(db, TRIP_ID);
    assert.equal(first.verdict, "repaired");

    // Independently drift the Trip again.
    await db.collection("trips").doc(TRIP_ID).update({
      ownershipModelState: "needs_reconciliation",
    });
    await seedOwnershipRow(DANIEL, 999);

    const second = await runApply(db, TRIP_ID);
    assert.equal(second.verdict, "repaired");
    assert.notEqual(second.attemptId, first.attemptId);

    const controlSnap = await db
      .collection("tripOwnershipReconciliationControl")
      .doc(TRIP_ID)
      .get();
    assert.equal(controlSnap.data()?.lastCompletedAttemptId, second.attemptId);

    const attemptsSnap = await db
      .collection("tripOwnershipReconciliationAttempts")
      .where("tripId", "==", TRIP_ID)
      .get();
    assert.equal(attemptsSnap.size, 2);
  });
});

// ---------------------------------------------------------------------
// Concurrency / control-document model.
// ---------------------------------------------------------------------

describe("runApply - concurrency / control-document model", () => {
  it("two concurrent fresh starts never create two active attempts", async () => {
    await seedHealthyFixture();
    const [a, b] = await Promise.all([
      runApply(db, TRIP_ID),
      runApply(db, TRIP_ID),
    ]);

    // The two calls may genuinely overlap (both observe and resolve the
    // SAME single attempt, both reporting "repaired") or may run
    // effectively sequentially at the Firestore RPC level (the second
    // call's own acquisition then correctly observes an already-
    // "initialized" Trip and reports "trip_not_eligible") - both are
    // legitimate outcomes of true concurrency; what must NEVER happen is
    // two DIFFERENT active attempts, or a genuine failure. Exactly one
    // of the two calls must report "repaired".
    const verdicts = [a.verdict, b.verdict];
    assert.ok(
      verdicts.includes("repaired"),
      `expected at least one call to report "repaired", got: ${verdicts}`
    );
    for (const result of [a, b]) {
      if (result.verdict !== "repaired") {
        assert.equal(result.verdict, "requires_manual_review");
        assert.equal(
          result.anomalies.some((anom) => anom.reasonCode === "trip_not_eligible"),
          true,
          `the non-"repaired" call must only ever fail with ` +
            `"trip_not_eligible" (the Trip already finished), never a ` +
            `genuine anomaly - got: ${JSON.stringify(result.anomalies)}`
        );
      }
    }

    const attemptsSnap = await db
      .collection("tripOwnershipReconciliationAttempts")
      .where("tripId", "==", TRIP_ID)
      .get();
    assert.equal(attemptsSnap.size, 1);

    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.ownershipModelState, "initialized");
  });

  it("control absent but attempt history exists fails closed (missing_reconciliation_control)", async () => {
    await seedHealthyFixture();
    await db
      .collection("tripOwnershipReconciliationAttempts")
      .doc(`${TRIP_ID}_orphan-attempt`)
      .set({
        tripId: TRIP_ID,
        attemptId: "orphan-attempt",
        phase: "completed",
        startedAt: FieldValue.serverTimestamp(),
        lockedFinancialBasis: {
          ledgerInitializationKind: "initialized",
          ledgerOpeningBalanceMinor: 0,
          ledgerBalanceMinor: 1000,
          effectiveCurrency: "USD",
        },
        sourceHistoryDigest: "x".repeat(64),
        sourceHistoryDocumentCount: 2,
        validatedAllocationDigest: "y".repeat(64),
        validatedAllocationCount: 0,
        expectedOwnershipDigest: "z".repeat(64),
        expectedOwnershipCount: 2,
        expectedAggregateMinor: 1000,
        completedAt: FieldValue.serverTimestamp(),
      });

    const result = await runApply(db, TRIP_ID);
    assert.equal(result.verdict, "requires_manual_review");
    assert.equal(
      result.anomalies.some(
        (a) => a.reasonCode === "missing_reconciliation_control"
      ),
      true
    );
  });

  it("malformed control document fails closed", async () => {
    await seedHealthyFixture();
    await db
      .collection("tripOwnershipReconciliationControl")
      .doc(TRIP_ID)
      .set({tripId: TRIP_ID, activeAttemptId: 123});

    const result = await runApply(db, TRIP_ID);
    assert.equal(result.verdict, "requires_manual_review");
    assert.equal(
      result.anomalies.some(
        (a) => a.reasonCode === "malformed_reconciliation_control"
      ),
      true
    );
  });

  it("activeAttemptId referencing a missing attempt fails closed", async () => {
    await seedHealthyFixture();
    await db.collection("tripOwnershipReconciliationControl").doc(TRIP_ID).set({
      tripId: TRIP_ID,
      activeAttemptId: "ghost-attempt",
      lastCompletedAttemptId: null,
      updatedAt: FieldValue.serverTimestamp(),
    });

    const result = await runApply(db, TRIP_ID);
    assert.equal(result.verdict, "requires_manual_review");
    assert.equal(
      result.anomalies.some(
        (a) => a.reasonCode === "malformed_reconciliation_control"
      ),
      true
    );
  });

  it("activeAttemptId referencing an already-completed attempt fails closed", async () => {
    await seedHealthyFixture();
    await db
      .collection("tripOwnershipReconciliationAttempts")
      .doc(`${TRIP_ID}_done-attempt`)
      .set({
        tripId: TRIP_ID,
        attemptId: "done-attempt",
        phase: "completed",
        startedAt: FieldValue.serverTimestamp(),
        lockedFinancialBasis: {
          ledgerInitializationKind: "initialized",
          ledgerOpeningBalanceMinor: 0,
          ledgerBalanceMinor: 1000,
          effectiveCurrency: "USD",
        },
        sourceHistoryDigest: "x".repeat(64),
        sourceHistoryDocumentCount: 2,
        validatedAllocationDigest: "y".repeat(64),
        validatedAllocationCount: 0,
        expectedOwnershipDigest: "z".repeat(64),
        expectedOwnershipCount: 2,
        expectedAggregateMinor: 1000,
        completedAt: FieldValue.serverTimestamp(),
      });
    await db.collection("tripOwnershipReconciliationControl").doc(TRIP_ID).set({
      tripId: TRIP_ID,
      activeAttemptId: "done-attempt",
      lastCompletedAttemptId: null,
      updatedAt: FieldValue.serverTimestamp(),
    });

    const result = await runApply(db, TRIP_ID);
    assert.equal(result.verdict, "requires_manual_review");
    assert.equal(
      result.anomalies.some(
        (a) => a.reasonCode === "malformed_reconciliation_control"
      ),
      true
    );
  });

  it("activeAttemptId equal to lastCompletedAttemptId fails closed", async () => {
    await seedHealthyFixture();
    await db.collection("tripOwnershipReconciliationControl").doc(TRIP_ID).set({
      tripId: TRIP_ID,
      activeAttemptId: "same-id",
      lastCompletedAttemptId: "same-id",
      updatedAt: FieldValue.serverTimestamp(),
    });

    const result = await runApply(db, TRIP_ID);
    assert.equal(result.verdict, "requires_manual_review");
    assert.equal(
      result.anomalies.some(
        (a) => a.reasonCode === "malformed_reconciliation_control"
      ),
      true
    );
  });

  it("lastCompletedAttemptId referencing a failed attempt fails closed", async () => {
    await seedHealthyFixture();
    await db
      .collection("tripOwnershipReconciliationAttempts")
      .doc(`${TRIP_ID}_failed-attempt`)
      .set({
        tripId: TRIP_ID,
        attemptId: "failed-attempt",
        phase: "failed",
        startedAt: FieldValue.serverTimestamp(),
        lockedFinancialBasis: {
          ledgerInitializationKind: "initialized",
          ledgerOpeningBalanceMinor: 0,
          ledgerBalanceMinor: 1000,
          effectiveCurrency: "USD",
        },
        sourceHistoryDigest: "x".repeat(64),
        sourceHistoryDocumentCount: 2,
        validatedAllocationDigest: "y".repeat(64),
        validatedAllocationCount: 0,
        expectedOwnershipDigest: "z".repeat(64),
        expectedOwnershipCount: 2,
        expectedAggregateMinor: 1000,
        failedAt: FieldValue.serverTimestamp(),
        failureReasonCode: "out_of_band_mutation_detected",
      });
    await db.collection("tripOwnershipReconciliationControl").doc(TRIP_ID).set({
      tripId: TRIP_ID,
      activeAttemptId: null,
      lastCompletedAttemptId: "failed-attempt",
      updatedAt: FieldValue.serverTimestamp(),
    });

    const result = await runApply(db, TRIP_ID);
    assert.equal(result.verdict, "requires_manual_review");
    assert.equal(
      result.anomalies.some(
        (a) => a.reasonCode === "malformed_reconciliation_control"
      ),
      true
    );
  });

  it("resumes an existing valid active (locked) attempt rather than creating a second one", async () => {
    await seedHealthyFixture();
    const basis = {
      ledgerInitializationKind: "initialized" as const,
      ledgerOpeningBalanceMinor: 0,
      ledgerBalanceMinor: 1000,
      effectiveCurrency: "USD",
    };
    await db
      .collection("tripOwnershipReconciliationAttempts")
      .doc(`${TRIP_ID}_resume-me`)
      .set({
        tripId: TRIP_ID,
        attemptId: "resume-me",
        phase: "locked",
        startedAt: FieldValue.serverTimestamp(),
        lockedFinancialBasis: basis,
      });
    await db.collection("tripOwnershipReconciliationControl").doc(TRIP_ID).set({
      tripId: TRIP_ID,
      activeAttemptId: "resume-me",
      lastCompletedAttemptId: null,
      updatedAt: FieldValue.serverTimestamp(),
    });

    const result = await runApply(db, TRIP_ID);
    assert.equal(result.verdict, "repaired");
    assert.equal(result.attemptId, "resume-me");

    const attemptsSnap = await db
      .collection("tripOwnershipReconciliationAttempts")
      .where("tripId", "==", TRIP_ID)
      .get();
    assert.equal(attemptsSnap.size, 1);
  });
});

// ---------------------------------------------------------------------
// Failure / retry semantics and finalization re-verification.
// ---------------------------------------------------------------------

describe("runApply - failure / retry semantics", () => {
  it("a stale source-history digest on a resumed reconstructed attempt fails the attempt and clears activeAttemptId", async () => {
    await seedHealthyFixture();
    const dryRun = await runDryRun(db, TRIP_ID);
    assert.equal(dryRun.verdict, "safe_to_reconcile");

    // Hand-construct a "reconstructed" attempt whose frozen digest is
    // already stale relative to what will be loaded when runApply reads
    // history again (we mutate history AFTER constructing this attempt).
    await db
      .collection("tripOwnershipReconciliationAttempts")
      .doc(`${TRIP_ID}_stale-attempt`)
      .set({
        tripId: TRIP_ID,
        attemptId: "stale-attempt",
        phase: "reconstructed",
        startedAt: FieldValue.serverTimestamp(),
        lockedFinancialBasis: {
          ledgerInitializationKind: "initialized",
          ledgerOpeningBalanceMinor: 0,
          ledgerBalanceMinor: 1000,
          effectiveCurrency: "USD",
        },
        sourceHistoryDigest: dryRun.sourceHistoryDigest,
        sourceHistoryDocumentCount: dryRun.sourceHistoryDocumentCount,
        validatedAllocationDigest: dryRun.validatedAllocationDigest,
        validatedAllocationCount: dryRun.validatedAllocationCount,
        expectedOwnershipDigest: dryRun.expectedOwnershipDigest,
        expectedOwnershipCount: dryRun.expectedOwnership?.length,
        expectedAggregateMinor: dryRun.expectedOwnershipTotalMinor,
      });
    await db.collection("tripOwnershipReconciliationControl").doc(TRIP_ID).set({
      tripId: TRIP_ID,
      activeAttemptId: "stale-attempt",
      lastCompletedAttemptId: null,
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Mutate history out-of-band AFTER the attempt froze its digest -
    // the aggregate must still match for a clean replay, so also bump
    // the Trip's own aggregate to stay internally consistent, proving
    // this is caught by the DIGEST check, not merely aggregate drift.
    await seedOrdinaryTransaction("tx-3", DANIEL, "contribution", 1, 9999);
    await db.collection("trips").doc(TRIP_ID).update({
      ledgerBalanceMinor: 1001,
      saved: 10.01,
    });

    const result = await runApply(db, TRIP_ID);
    assert.equal(result.verdict, "requires_manual_review");
    assert.equal(
      result.anomalies.some(
        (a) => a.reasonCode === "out_of_band_mutation_detected"
      ),
      true
    );

    const attemptSnap = await db
      .collection("tripOwnershipReconciliationAttempts")
      .doc(`${TRIP_ID}_stale-attempt`)
      .get();
    assert.equal(attemptSnap.data()?.phase, "failed");
    assert.ok(attemptSnap.data()?.failureReasonCode);

    const controlSnap = await db
      .collection("tripOwnershipReconciliationControl")
      .doc(TRIP_ID)
      .get();
    assert.equal(controlSnap.data()?.activeAttemptId, null);
  });

  it("a locked financial basis mismatch at finalization fails the attempt, retaining it permanently", async () => {
    await seedHealthyFixture();
    const dryRun = await runDryRun(db, TRIP_ID);
    assert.equal(dryRun.verdict, "safe_to_reconcile");

    // The attempt's OWN frozen basis is fully self-consistent with the
    // real history (so reconstruction's independent aggregate-replay
    // check, which compares against THIS frozen basis, passes cleanly) -
    // but the LIVE Trip document is independently mutated out-of-band
    // AFTER this attempt was frozen, so only finalization's own FRESH
    // re-derivation (read directly from the live Trip document) can
    // ever detect the disagreement.
    await db
      .collection("tripOwnershipReconciliationAttempts")
      .doc(`${TRIP_ID}_bad-basis`)
      .set({
        tripId: TRIP_ID,
        attemptId: "bad-basis",
        phase: "reconstructed",
        startedAt: FieldValue.serverTimestamp(),
        lockedFinancialBasis: {
          ledgerInitializationKind: "initialized",
          ledgerOpeningBalanceMinor: 0,
          ledgerBalanceMinor: 1000,
          effectiveCurrency: "USD",
        },
        sourceHistoryDigest: dryRun.sourceHistoryDigest,
        sourceHistoryDocumentCount: dryRun.sourceHistoryDocumentCount,
        validatedAllocationDigest: dryRun.validatedAllocationDigest,
        validatedAllocationCount: dryRun.validatedAllocationCount,
        expectedOwnershipDigest: dryRun.expectedOwnershipDigest,
        expectedOwnershipCount: dryRun.expectedOwnership?.length,
        expectedAggregateMinor: dryRun.expectedOwnershipTotalMinor,
      });
    await db.collection("tripOwnershipReconciliationControl").doc(TRIP_ID).set({
      tripId: TRIP_ID,
      activeAttemptId: "bad-basis",
      lastCompletedAttemptId: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    // Out-of-band mutation of the LIVE Trip document only, after the
    // attempt above already froze its own (still-correct-at-the-time)
    // basis - deliberately inconsistent with that frozen basis. (A
    // currency change, rather than a ledger-field change, so this is
    // caught via a direct effectiveCurrency disagreement rather than
    // the unrelated ambiguous-opening-balance classification.)
    await db.collection("trips").doc(TRIP_ID).update({currency: "EUR"});

    const result = await runApply(db, TRIP_ID);
    assert.equal(result.verdict, "requires_manual_review");
    assert.equal(
      result.anomalies.some(
        (a) => a.reasonCode === "locked_financial_basis_mismatch"
      ),
      true
    );

    const attemptSnap = await db
      .collection("tripOwnershipReconciliationAttempts")
      .doc(`${TRIP_ID}_bad-basis`)
      .get();
    assert.equal(attemptSnap.data()?.phase, "failed");

    // Trip financial state must remain untouched.
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.ownershipModelState, "needs_reconciliation");
    assert.equal(tripSnap.data()?.ledgerBalanceMinor, 1000);
  });

  it("after a failed attempt clears activeAttemptId, a later run creates a brand-new attempt and succeeds", async () => {
    await seedHealthyFixture();
    await db.collection("tripOwnershipReconciliationAttempts").doc(`${TRIP_ID}_pre-failed`).set({
      tripId: TRIP_ID,
      attemptId: "pre-failed",
      phase: "failed",
      startedAt: FieldValue.serverTimestamp(),
      lockedFinancialBasis: {
        ledgerInitializationKind: "initialized",
        ledgerOpeningBalanceMinor: 0,
        ledgerBalanceMinor: 1000,
        effectiveCurrency: "USD",
      },
      sourceHistoryDigest: "x".repeat(64),
      sourceHistoryDocumentCount: 2,
      validatedAllocationDigest: "y".repeat(64),
      validatedAllocationCount: 0,
      expectedOwnershipDigest: "z".repeat(64),
      expectedOwnershipCount: 2,
      expectedAggregateMinor: 1000,
      failedAt: FieldValue.serverTimestamp(),
      failureReasonCode: "out_of_band_mutation_detected",
    });
    await db.collection("tripOwnershipReconciliationControl").doc(TRIP_ID).set({
      tripId: TRIP_ID,
      activeAttemptId: null,
      lastCompletedAttemptId: null,
      updatedAt: FieldValue.serverTimestamp(),
    });

    const result = await runApply(db, TRIP_ID);
    assert.equal(result.verdict, "repaired");
    assert.notEqual(result.attemptId, "pre-failed");

    const preFailedSnap = await db
      .collection("tripOwnershipReconciliationAttempts")
      .doc(`${TRIP_ID}_pre-failed`)
      .get();
    assert.equal(preFailedSnap.data()?.phase, "failed");
  });

  it("dry-run never creates an attempt/control document even when a repair would otherwise be needed", async () => {
    await seedTrip();
    await seedOrdinaryTransaction("tx-1", DANIEL, "contribution", 600, 1000);
    await seedOwnershipRow(DANIEL, 999); // drifted

    await runDryRun(db, TRIP_ID);

    const attemptsSnap = await db
      .collection("tripOwnershipReconciliationAttempts")
      .get();
    assert.equal(attemptsSnap.size, 0);
    const controlSnap = await db
      .collection("tripOwnershipReconciliationControl")
      .doc(TRIP_ID)
      .get();
    assert.equal(controlSnap.exists, false);
  });
});
