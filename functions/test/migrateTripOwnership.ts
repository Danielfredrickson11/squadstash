// Checkpoint 5B.4B: emulator-backed integration tests for the trusted
// Trip-ownership migration/backfill tool
// (functions/src/admin/migrateTripOwnership.ts), against the local
// Firestore emulator via the Admin SDK - NEVER production. Covers the
// dry-run/apply happy paths (including the frozen 900/100 -> 200
// worked example), eligibility rejection, already-completed handling,
// the fresh-lock pre-existing-output guard, phase-aware resumability
// (resume from "locked" and from "reconstructed"), the finalization
// out-of-band-mutation gate, and the pure CLI execution-target guard.
import assert from "node:assert/strict";
import {after, before, beforeEach, describe, it} from "node:test";
import {deleteApp, initializeApp} from "firebase-admin/app";
import type {App} from "firebase-admin/app";
import {FieldValue, Timestamp, getFirestore} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";
import {
  AUTOMATIC_MIGRATION_HISTORY_LIMIT,
  PRODUCTION_PROJECT_ID,
  materializeAllocationOutputs,
  materializeOwnershipOutputs,
  resolveExecutionTarget,
  runApply,
  runDryRun,
} from "../src/admin/migrateTripOwnership";
import {CURRENT_TRIP_OWNERSHIP_MODEL_VERSION} from "../src/domain/tripOwnershipModel";
import {
  buildLockedFinancialBasis,
} from "../src/domain/tripOwnershipMigrationState";
import {
  computeAllocationDigest,
  computeOwnershipDigest,
  computeSourceHistoryDigest,
} from "../src/domain/tripOwnershipMigrationDigest";
import {
  buildLogicalEvents,
  orderLogicalEvents,
  replayLogicalEvents,
} from "../src/domain/tripOwnershipMigrationReplay";
import type {
  RawSavingsTransactionRecord,
  RawTripExpenseRecord,
} from "../src/domain/tripOwnershipMigrationReplay";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "FIRESTORE_EMULATOR_HOST is not set. Run these tests via " +
      '`firebase emulators:exec --only firestore "npm --prefix functions test"` ' +
      "so the Admin SDK talks to the local emulator, never production."
  );
}

const TRIP_ID = "test-trip";

let app: App;
let db: Firestore;

before(() => {
  app = initializeApp({
    projectId: "demo-squadstash-functions-test-migrate-trip-ownership",
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
    "tripOwnershipMigrationState",
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
      ownerId: "daniel",
      memberIds: ["daniel", "friend"],
      title: "Test Trip",
      target: 1000,
      saved: 0,
      imageUrl: "https://example.com/trip.jpg",
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

async function seedSharedStashExpense(
  expenseId: string,
  withdrawalId: string,
  amountMinor: number,
  millis: number
): Promise<void> {
  const createdAt = Timestamp.fromMillis(millis);
  await db.collection("savingsTransactions").doc(withdrawalId).set({
    resourceType: "trip",
    resourceId: TRIP_ID,
    memberUid: "daniel",
    type: "withdrawal",
    amountMinor,
    currency: "USD",
    createdAt,
    reversalOf: null,
    linkedExpenseId: expenseId,
  });
  await db.collection("tripExpenses").doc(expenseId).set({
    tripId: TRIP_ID,
    paymentSource: "shared_stash",
    amountMinor,
    currency: "USD",
    sharedStashTransactionId: withdrawalId,
    status: "active",
    createdAt,
  });
}

async function seedSharedStashReversal(
  expenseId: string,
  withdrawalId: string,
  refundId: string,
  amountMinor: number,
  millis: number
): Promise<void> {
  const reversedAt = Timestamp.fromMillis(millis);
  await db.collection("savingsTransactions").doc(refundId).set({
    resourceType: "trip",
    resourceId: TRIP_ID,
    memberUid: "daniel",
    type: "contribution",
    amountMinor,
    currency: "USD",
    createdAt: reversedAt,
    reversalOf: withdrawalId,
    linkedExpenseId: expenseId,
  });
  await db.collection("tripExpenses").doc(expenseId).update({
    status: "reversed",
    reversedAt,
    refundTransactionId: refundId,
  });
}

async function getOwnershipMap(): Promise<Map<string, number>> {
  const snap = await db
    .collection("tripMemberOwnership")
    .where("tripId", "==", TRIP_ID)
    .get();
  const map = new Map<string, number>();
  for (const doc of snap.docs) {
    const d = doc.data();
    map.set(d.uid, d.ownershipMinor);
  }
  return map;
}

/**
 * Independently computes the full reconstruction digests/counts a real
 * run would freeze at the "locked" -> "reconstructed" transition -
 * used only to directly seed a "reconstructed"-phase migrationState
 * document for resumability/out-of-band-mutation tests, without
 * depending on the admin tool's own (unexported) internal pipeline.
 * @param {RawSavingsTransactionRecord[]} transactions The history.
 * @param {Array} expenses The history (full digest-shaped fields).
 * @return {object} The three digest/count pairs this test needs.
 */
function computeExpectedReconstruction(
  transactions: RawSavingsTransactionRecord[],
  expenses: Array<
    RawTripExpenseRecord & {
      replacesExpenseId: string | null;
      replacedByExpenseId: string | null;
    }
  >
) {
  const built = buildLogicalEvents(transactions, expenses, "USD");
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error("unreachable");
  const ordered = orderLogicalEvents(built.events);
  assert.equal(ordered.ok, true);
  if (!ordered.ok) throw new Error("unreachable");
  const replayed = replayLogicalEvents(ordered.ordered, TRIP_ID);
  assert.equal(replayed.ok, true);
  if (!replayed.ok) throw new Error("unreachable");
  const sourceDigest = computeSourceHistoryDigest(transactions, expenses);
  const ownershipDigest = computeOwnershipDigest(replayed.ownership);
  const allocationDigest = computeAllocationDigest(
    replayed.allocations.map((a) => ({
      id: a.withdrawalTransactionId,
      tripId: a.tripId,
      expenseId: a.expenseId,
      withdrawalTransactionId: a.withdrawalTransactionId,
      amountMinor: a.amountMinor,
      currency: a.currency,
      allocations: a.allocations,
      provenance: "migrated",
      createdAt: a.createdAt,
    }))
  );
  return {sourceDigest, ownershipDigest, allocationDigest};
}

// ---------------------------------------------------------------------
// DRY RUN
// ---------------------------------------------------------------------

describe("runDryRun", () => {
  it("reports safe_to_migrate for a zero-history legacy Trip", async () => {
    await seedTrip();
    const result = await runDryRun(db, TRIP_ID);
    assert.equal(result.verdict, "safe_to_migrate");
    assert.equal(result.mode, "dry_run");
    assert.deepEqual(result.reconstructedOwnership, []);
    assert.equal(result.anomalies.length, 0);
  });

  it("reports the frozen 900/100 -> 200/180/20 worked example", async () => {
    await seedTrip({ledgerOpeningBalanceMinor: 0, ledgerBalanceMinor: 800});
    await seedOrdinaryTransaction("tx-1", "daniel", "contribution", 900, 1000);
    await seedOrdinaryTransaction("tx-2", "friend", "contribution", 100, 2000);
    await seedSharedStashExpense("expense-1", "withdrawal-1", 200, 3000);

    const result = await runDryRun(db, TRIP_ID);
    assert.equal(result.verdict, "safe_to_migrate");
    const byUid = new Map(
      (result.reconstructedOwnership ?? []).map((b) => [
        b.uid,
        b.ownershipMinor,
      ])
    );
    assert.equal(byUid.get("daniel"), 720);
    assert.equal(byUid.get("friend"), 80);
    assert.equal(result.allocationsToCreate?.length, 1);
    assert.equal(result.allocationsToCreate?.[0].amountMinor, 200);
    assert.equal(result.reconciliation.aggregateMatches, true);
    assert.equal(result.reconciliation.historyReplayMatches, true);
  });

  it("reports requires_manual_review for a positive ambiguous opening balance", async () => {
    await seedTrip({ledgerOpeningBalanceMinor: 100, ledgerBalanceMinor: 100});
    const result = await runDryRun(db, TRIP_ID);
    assert.equal(result.verdict, "requires_manual_review");
    assert.equal(
      result.anomalies[0].reasonCode,
      "positive_ambiguous_opening_balance"
    );
  });

  it("reports requires_manual_review for a Trip already migrating", async () => {
    await seedTrip({ownershipModelState: "migrating"});
    const result = await runDryRun(db, TRIP_ID);
    assert.equal(result.verdict, "requires_manual_review");
    assert.equal(result.anomalies[0].reasonCode, "not_legacy_state_migrating");
  });

  // Checkpoint 5B.4B.1, Section C: already_completed is strictly
  // proven - never inferred merely from ownershipModelState.
  it("reports already_completed for an initialized Trip with a valid, matching completed migration-state document", async () => {
    await seedTrip({
      ownershipModelState: "initialized",
      ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
    });
    await db.collection("tripOwnershipMigrationState").doc(TRIP_ID).set({
      tripId: TRIP_ID,
      attemptId: "attempt-already-done",
      phase: "completed",
      lockedAt: Timestamp.now(),
      startedAt: Timestamp.now(),
      lockedFinancialBasis: {
        ledgerInitializationKind: "initialized",
        ledgerOpeningBalanceMinor: 0,
        ledgerBalanceMinor: 0,
        effectiveCurrency: "USD",
      },
      sourceHistoryDigest: "abc",
      sourceHistoryDocumentCount: 0,
      expectedOwnershipDigest: "def",
      expectedOwnershipCount: 0,
      expectedAllocationDigest: "ghi",
      expectedAllocationCount: 0,
      completedAt: Timestamp.now(),
    });
    const result = await runDryRun(db, TRIP_ID);
    assert.equal(result.verdict, "already_completed");
  });

  it("reports requires_manual_review (never already_completed) for an initialized Trip with NO migration-state document", async () => {
    await seedTrip({
      ownershipModelState: "initialized",
      ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
    });
    const result = await runDryRun(db, TRIP_ID);
    assert.equal(result.verdict, "requires_manual_review");
    assert.equal(
      result.anomalies[0].reasonCode,
      "invalid_migration_state_phase"
    );
  });

  it("reports requires_manual_review (never already_completed) for needs_reconciliation, even with a completed migration-state document", async () => {
    await seedTrip({
      ownershipModelState: "needs_reconciliation",
      ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
    });
    await db.collection("tripOwnershipMigrationState").doc(TRIP_ID).set({
      tripId: TRIP_ID,
      attemptId: "attempt-already-done",
      phase: "completed",
      lockedAt: Timestamp.now(),
      startedAt: Timestamp.now(),
      lockedFinancialBasis: {
        ledgerInitializationKind: "initialized",
        ledgerOpeningBalanceMinor: 0,
        ledgerBalanceMinor: 0,
        effectiveCurrency: "USD",
      },
      sourceHistoryDigest: "abc",
      sourceHistoryDocumentCount: 0,
      expectedOwnershipDigest: "def",
      expectedOwnershipCount: 0,
      expectedAllocationDigest: "ghi",
      expectedAllocationCount: 0,
      completedAt: Timestamp.now(),
    });
    const result = await runDryRun(db, TRIP_ID);
    assert.equal(result.verdict, "requires_manual_review");
    assert.equal(
      result.anomalies[0].reasonCode,
      "needs_reconciliation_blocked"
    );
  });

  it("reports requires_manual_review for an initialized Trip whose migration-state tripId disagrees", async () => {
    await seedTrip({
      ownershipModelState: "initialized",
      ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
    });
    await db.collection("tripOwnershipMigrationState").doc(TRIP_ID).set({
      tripId: "some-other-trip",
      attemptId: "attempt-already-done",
      phase: "completed",
      lockedAt: Timestamp.now(),
      startedAt: Timestamp.now(),
      lockedFinancialBasis: {
        ledgerInitializationKind: "initialized",
        ledgerOpeningBalanceMinor: 0,
        ledgerBalanceMinor: 0,
        effectiveCurrency: "USD",
      },
      sourceHistoryDigest: "abc",
      sourceHistoryDocumentCount: 0,
      expectedOwnershipDigest: "def",
      expectedOwnershipCount: 0,
      expectedAllocationDigest: "ghi",
      expectedAllocationCount: 0,
      completedAt: Timestamp.now(),
    });
    const result = await runDryRun(db, TRIP_ID);
    assert.equal(result.verdict, "requires_manual_review");
    assert.equal(
      result.anomalies[0].reasonCode,
      "invalid_migration_state_phase"
    );
  });

  it("reports requires_manual_review for an initialized Trip at an unsupported ownership version", async () => {
    await seedTrip({
      ownershipModelState: "initialized",
      ownershipModelVersion: 999,
    });
    const result = await runDryRun(db, TRIP_ID);
    assert.equal(result.verdict, "requires_manual_review");
    assert.equal(
      result.anomalies[0].reasonCode,
      "unsupported_ownership_version"
    );
  });

  it("reports requires_manual_review for an initialized Trip whose migration-state is still phase \"reconstructed\"", async () => {
    await seedTrip({
      ownershipModelState: "initialized",
      ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
    });
    await db.collection("tripOwnershipMigrationState").doc(TRIP_ID).set({
      tripId: TRIP_ID,
      attemptId: "attempt-already-done",
      phase: "reconstructed",
      lockedAt: Timestamp.now(),
      startedAt: Timestamp.now(),
      lockedFinancialBasis: {
        ledgerInitializationKind: "initialized",
        ledgerOpeningBalanceMinor: 0,
        ledgerBalanceMinor: 0,
        effectiveCurrency: "USD",
      },
      sourceHistoryDigest: "abc",
      sourceHistoryDocumentCount: 0,
      expectedOwnershipDigest: "def",
      expectedOwnershipCount: 0,
      expectedAllocationDigest: "ghi",
      expectedAllocationCount: 0,
    });
    const result = await runDryRun(db, TRIP_ID);
    assert.equal(result.verdict, "requires_manual_review");
    assert.equal(
      result.anomalies[0].reasonCode,
      "invalid_migration_state_phase"
    );
  });

  it("throws for a nonexistent Trip", async () => {
    await assert.rejects(runDryRun(db, "no-such-trip"));
  });
});

// ---------------------------------------------------------------------
// APPLY - fresh lock, full completion
// ---------------------------------------------------------------------

describe("runApply - fresh lock, full completion", () => {
  it("completes the frozen 900/100 -> 200/180/20 worked example end to end", async () => {
    await seedTrip({ledgerOpeningBalanceMinor: 0, ledgerBalanceMinor: 800});
    await seedOrdinaryTransaction("tx-1", "daniel", "contribution", 900, 1000);
    await seedOrdinaryTransaction("tx-2", "friend", "contribution", 100, 2000);
    await seedSharedStashExpense("expense-1", "withdrawal-1", 200, 3000);

    const result = await runApply(db, TRIP_ID);
    assert.equal(result.verdict, "safe_to_migrate");
    assert.equal(result.phase, "completed");

    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    const tripData = tripSnap.data();
    assert.equal(tripData?.ownershipModelState, "initialized");
    assert.equal(
      tripData?.ownershipModelVersion,
      CURRENT_TRIP_OWNERSHIP_MODEL_VERSION
    );

    const ownership = await getOwnershipMap();
    assert.equal(ownership.get("daniel"), 720);
    assert.equal(ownership.get("friend"), 80);

    const allocationSnap = await db
      .collection("tripOwnershipAllocations")
      .doc("withdrawal-1")
      .get();
    assert.equal(allocationSnap.exists, true);
    const allocationData = allocationSnap.data();
    assert.equal(allocationData?.provenance, "migrated");
    assert.equal(allocationData?.amountMinor, 200);
    assert.ok(allocationData?.migratedAt instanceof Timestamp);
    assert.equal(
      (allocationData?.createdAt as Timestamp).toMillis(),
      3000
    );

    const migrationStateSnap = await db
      .collection("tripOwnershipMigrationState")
      .doc(TRIP_ID)
      .get();
    assert.equal(migrationStateSnap.data()?.phase, "completed");
  });

  it("handles exact reversal replay - ownership ends unchanged, allocation record retained", async () => {
    await seedTrip({ledgerOpeningBalanceMinor: 0, ledgerBalanceMinor: 1000});
    await seedOrdinaryTransaction("tx-1", "daniel", "contribution", 900, 1000);
    await seedOrdinaryTransaction("tx-2", "friend", "contribution", 100, 2000);
    await seedSharedStashExpense("expense-1", "withdrawal-1", 200, 3000);
    await seedSharedStashReversal("expense-1", "withdrawal-1", "refund-1", 200, 4000);

    const result = await runApply(db, TRIP_ID);
    assert.equal(result.verdict, "safe_to_migrate");

    const ownership = await getOwnershipMap();
    assert.equal(ownership.get("daniel"), 900);
    assert.equal(ownership.get("friend"), 100);

    const allocationSnap = await db
      .collection("tripOwnershipAllocations")
      .doc("withdrawal-1")
      .get();
    assert.equal(allocationSnap.exists, true);
  });

  it("handles a zero-history legacy Trip (case_a_equivalent)", async () => {
    await seedTrip();
    const result = await runApply(db, TRIP_ID);
    assert.equal(result.verdict, "safe_to_migrate");
    const tripData = (await db.collection("trips").doc(TRIP_ID).get()).data();
    assert.equal(tripData?.ownershipModelState, "initialized");
  });

  it("rejects a fresh lock when a pre-existing ownership row already exists", async () => {
    await seedTrip();
    await db.collection("tripMemberOwnership").doc(`${TRIP_ID}_daniel`).set({
      tripId: TRIP_ID,
      uid: "daniel",
      ownershipMinor: 999,
      lastUpdatedAt: new Date(),
    });

    const result = await runApply(db, TRIP_ID);
    assert.equal(
      result.anomalies[0].reasonCode,
      "pre_existing_output_on_fresh_lock"
    );
    const tripData = (await db.collection("trips").doc(TRIP_ID).get()).data();
    assert.equal(tripData?.ownershipModelState, undefined);
  });

  it("reports invalid_migration_state_phase for an initialized Trip with no migration-state document", async () => {
    await seedTrip({
      ownershipModelState: "initialized",
      ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
    });
    const result = await runApply(db, TRIP_ID);
    assert.equal(
      result.anomalies[0].reasonCode,
      "invalid_migration_state_phase"
    );
  });

  it("reports unexplained_migrating_state for a migrating Trip with no migration-state document", async () => {
    await seedTrip({ownershipModelState: "migrating"});
    const result = await runApply(db, TRIP_ID);
    assert.equal(
      result.anomalies[0].reasonCode,
      "unexplained_migrating_state"
    );
  });

  // Checkpoint 5B.4B.1, Sections B/C - the apply-path mirror of the
  // dry-run tests above.
  it("reports already_completed for an initialized Trip with a valid, matching completed migration-state document", async () => {
    await seedTrip({
      ownershipModelState: "initialized",
      ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
    });
    await db.collection("tripOwnershipMigrationState").doc(TRIP_ID).set({
      tripId: TRIP_ID,
      attemptId: "attempt-already-done",
      phase: "completed",
      lockedAt: Timestamp.now(),
      startedAt: Timestamp.now(),
      lockedFinancialBasis: {
        ledgerInitializationKind: "initialized",
        ledgerOpeningBalanceMinor: 0,
        ledgerBalanceMinor: 0,
        effectiveCurrency: "USD",
      },
      sourceHistoryDigest: "abc",
      sourceHistoryDocumentCount: 0,
      expectedOwnershipDigest: "def",
      expectedOwnershipCount: 0,
      expectedAllocationDigest: "ghi",
      expectedAllocationCount: 0,
      completedAt: Timestamp.now(),
    });
    const result = await runApply(db, TRIP_ID);
    assert.equal(result.verdict, "already_completed");
  });

  it("fails closed (never already_completed) for needs_reconciliation, even with a completed migration-state document", async () => {
    await seedTrip({
      ownershipModelState: "needs_reconciliation",
      ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
    });
    await db.collection("tripOwnershipMigrationState").doc(TRIP_ID).set({
      tripId: TRIP_ID,
      attemptId: "attempt-already-done",
      phase: "completed",
      lockedAt: Timestamp.now(),
      startedAt: Timestamp.now(),
      lockedFinancialBasis: {
        ledgerInitializationKind: "initialized",
        ledgerOpeningBalanceMinor: 0,
        ledgerBalanceMinor: 0,
        effectiveCurrency: "USD",
      },
      sourceHistoryDigest: "abc",
      sourceHistoryDocumentCount: 0,
      expectedOwnershipDigest: "def",
      expectedOwnershipCount: 0,
      expectedAllocationDigest: "ghi",
      expectedAllocationCount: 0,
      completedAt: Timestamp.now(),
    });
    const result = await runApply(db, TRIP_ID);
    assert.notEqual(result.verdict, "already_completed");
    assert.equal(
      result.anomalies[0].reasonCode,
      "needs_reconciliation_blocked"
    );
    const tripData = (await db.collection("trips").doc(TRIP_ID).get()).data();
    assert.equal(tripData?.ownershipModelState, "needs_reconciliation");
  });
});

// ---------------------------------------------------------------------
// Checkpoint 5B.4B.4: audit-output completeness for a successful
// apply - reconstructedOwnershipTotalMinor, allocationsToCreate, and
// the reconciliation evidence must all be genuinely populated from
// real, already-computed values, never fabricated from counts alone.
// ---------------------------------------------------------------------

describe("runApply - audit-output completeness on success (Checkpoint 5B.4B.4)", () => {
  it("zero-balance apply reports exact empty reconstruction and fully-verified reconciliation", async () => {
    await seedTrip();
    const result = await runApply(db, TRIP_ID);

    assert.equal(result.verdict, "safe_to_migrate");
    assert.deepEqual(result.reconstructedOwnership, []);
    assert.equal(result.reconstructedOwnershipTotalMinor, 0);
    assert.deepEqual(result.allocationsToCreate, []);
    assert.ok(result.sourceHistoryDigest);
    assert.ok(result.expectedOwnershipDigest);
    assert.ok(result.expectedAllocationDigest);

    assert.equal(result.reconciliation.aggregateMatches, true);
    assert.equal(result.reconciliation.historyReplayMatches, true);
    assert.equal(result.reconciliation.lockedFinancialBasisMatches, true);
    assert.equal(result.reconciliation.sourceHistoryDigestMatches, true);
    assert.equal(result.reconciliation.exactOwnershipOutputMatches, true);
    assert.equal(result.reconciliation.exactAllocationOutputMatches, true);
  });

  it("nonzero reconstruction reports the exact ownership total and allocation output", async () => {
    await seedTrip({ledgerOpeningBalanceMinor: 0, ledgerBalanceMinor: 800});
    await seedOrdinaryTransaction("tx-1", "daniel", "contribution", 900, 1000);
    await seedOrdinaryTransaction("tx-2", "friend", "contribution", 100, 2000);
    await seedSharedStashExpense("expense-1", "withdrawal-1", 200, 3000);

    const result = await runApply(db, TRIP_ID);

    assert.equal(result.verdict, "safe_to_migrate");
    const byUid = new Map(
      (result.reconstructedOwnership ?? []).map((b) => [
        b.uid,
        b.ownershipMinor,
      ])
    );
    assert.equal(byUid.get("daniel"), 720);
    assert.equal(byUid.get("friend"), 80);
    // The exact sum of the reconstructed ownership set - never the
    // aggregate used merely as a proxy for it.
    assert.equal(result.reconstructedOwnershipTotalMinor, 800);

    assert.equal(result.allocationsToCreate?.length, 1);
    assert.equal(
      result.allocationsToCreate?.[0].withdrawalTransactionId,
      "withdrawal-1"
    );
    assert.equal(result.allocationsToCreate?.[0].amountMinor, 200);
    assert.deepEqual(
      result.allocationsToCreate?.[0].allocations,
      [
        {uid: "daniel", amountMinor: 180},
        {uid: "friend", amountMinor: 20},
      ]
    );

    assert.equal(result.reconciliation.aggregateMatches, true);
    assert.equal(result.reconciliation.historyReplayMatches, true);
    assert.equal(result.reconciliation.lockedFinancialBasisMatches, true);
    assert.equal(result.reconciliation.sourceHistoryDigestMatches, true);
    assert.equal(result.reconciliation.exactOwnershipOutputMatches, true);
    assert.equal(result.reconciliation.exactAllocationOutputMatches, true);
  });

  it("an early failure (before reconstruction even runs) leaves every reconciliation field null, never a fabricated true", async () => {
    await seedTrip({ownershipModelState: "migrating"});
    await db.collection("tripOwnershipMigrationState").doc(TRIP_ID).set({
      tripId: TRIP_ID,
      attemptId: "attempt-early-fail",
      phase: "reconstructed",
      lockedAt: new Date(),
      startedAt: new Date(),
      lockedFinancialBasis: buildLockedFinancialBasis(
        {kind: "case_a_equivalent"},
        "USD"
      ),
      sourceHistoryDigest: "this-will-never-match-anything",
      sourceHistoryDocumentCount: 0,
      expectedOwnershipDigest: "def",
      expectedOwnershipCount: 0,
      expectedAllocationDigest: "ghi",
      expectedAllocationCount: 0,
    });

    const result = await runApply(db, TRIP_ID);
    assert.equal(
      result.anomalies[0].reasonCode,
      "out_of_band_mutation_detected"
    );
    assert.equal(result.reconciliation.aggregateMatches, null);
    assert.equal(result.reconciliation.historyReplayMatches, null);
    assert.equal(result.reconciliation.lockedFinancialBasisMatches, null);
    // Reached and failed (the frozen digest is deliberately bogus) -
    // an honest false, not the null this run never got to.
    assert.equal(result.reconciliation.sourceHistoryDigestMatches, false);
    assert.equal(result.reconciliation.exactOwnershipOutputMatches, null);
    assert.equal(result.reconciliation.exactAllocationOutputMatches, null);
  });

  it("a finalization-only failure (locked financial basis mismatch) reports partial, honest evidence - never a false true", async () => {
    await seedTrip({ledgerOpeningBalanceMinor: 0, ledgerBalanceMinor: 800});
    await seedOrdinaryTransaction("tx-1", "daniel", "contribution", 900, 1000);
    await seedOrdinaryTransaction("tx-2", "friend", "contribution", 100, 2000);
    await seedSharedStashExpense("expense-1", "withdrawal-1", 200, 3000);

    const transactions: RawSavingsTransactionRecord[] = [
      {
        id: "tx-1",
        resourceType: "trip",
        resourceId: TRIP_ID,
        memberUid: "daniel",
        type: "contribution",
        amountMinor: 900,
        currency: "USD",
        createdAt: Timestamp.fromMillis(1000),
        reversalOf: null,
        linkedExpenseId: null,
      },
      {
        id: "tx-2",
        resourceType: "trip",
        resourceId: TRIP_ID,
        memberUid: "friend",
        type: "contribution",
        amountMinor: 100,
        currency: "USD",
        createdAt: Timestamp.fromMillis(2000),
        reversalOf: null,
        linkedExpenseId: null,
      },
      {
        id: "withdrawal-1",
        resourceType: "trip",
        resourceId: TRIP_ID,
        memberUid: "daniel",
        type: "withdrawal",
        amountMinor: 200,
        currency: "USD",
        createdAt: Timestamp.fromMillis(3000),
        reversalOf: null,
        linkedExpenseId: "expense-1",
      },
    ];
    const expenses = [
      {
        id: "expense-1",
        tripId: TRIP_ID,
        paymentSource: "shared_stash",
        amountMinor: 200,
        currency: "USD",
        sharedStashTransactionId: "withdrawal-1",
        status: "active",
        createdAt: Timestamp.fromMillis(3000),
        reversedAt: null,
        refundTransactionId: null,
        replacesExpenseId: null,
        replacedByExpenseId: null,
      },
    ];
    const expected = computeExpectedReconstruction(transactions, expenses);

    await db.collection("trips").doc(TRIP_ID).update({
      ownershipModelState: "migrating",
    });
    // The FROZEN basis correctly matches the replayed history (800),
    // so runReconstructionPipeline's own independent aggregate-replay
    // check passes - this isolates the failure to finalization's own
    // step-2b re-derivation from the Trip's CURRENT document, which
    // is the only place an out-of-band edit to the Trip's own ledger
    // field (simulated below) is ever actually caught.
    await db.collection("tripOwnershipMigrationState").doc(TRIP_ID).set({
      tripId: TRIP_ID,
      attemptId: "attempt-basis-mismatch",
      phase: "reconstructed",
      lockedAt: new Date(),
      startedAt: new Date(),
      lockedFinancialBasis: {
        ledgerInitializationKind: "initialized",
        ledgerOpeningBalanceMinor: 0,
        ledgerBalanceMinor: 800,
        effectiveCurrency: "USD",
      },
      sourceHistoryDigest: expected.sourceDigest.hash,
      sourceHistoryDocumentCount: expected.sourceDigest.count,
      expectedOwnershipDigest: expected.ownershipDigest.hash,
      expectedOwnershipCount: expected.ownershipDigest.count,
      expectedAllocationDigest: expected.allocationDigest.hash,
      expectedAllocationCount: expected.allocationDigest.count,
    });
    // Simulated out-of-band edit to the Trip's own ledger field,
    // AFTER the basis was locked - finalization re-reads this fresh.
    await db.collection("trips").doc(TRIP_ID).update({
      ledgerBalanceMinor: 850,
    });

    const result = await runApply(db, TRIP_ID);
    assert.equal(
      result.anomalies[0].reasonCode,
      "locked_financial_basis_mismatch"
    );
    // Reached and failed - an honest false, never a fabricated true.
    assert.equal(result.reconciliation.lockedFinancialBasisMatches, false);
    // Reached (during reconstruction, which ran successfully before
    // finalization) and genuinely true.
    assert.equal(result.reconciliation.aggregateMatches, true);
    assert.equal(result.reconciliation.historyReplayMatches, true);
    // runApply's own pre-finalization check DID run and pass (the
    // frozen source digest is valid) - true, not null, even though
    // finalization itself never reaches its own fresher source-history
    // check because it fails closed earlier, at step 2b.
    assert.equal(result.reconciliation.sourceHistoryDigestMatches, true);
    assert.equal(result.reconciliation.exactOwnershipOutputMatches, null);
    assert.equal(result.reconciliation.exactAllocationOutputMatches, null);
    // Finalization never committed - Trip remains migrating.
    const tripData = (await db.collection("trips").doc(TRIP_ID).get()).data();
    assert.equal(tripData?.ownershipModelState, "migrating");
  });
});

// ---------------------------------------------------------------------
// Checkpoint 5B.4B.4, Section B: already_completed audit-report
// enrichment - safe, read-only, frozen/persisted data only.
// ---------------------------------------------------------------------

describe("already_completed - safe audit-report enrichment (Checkpoint 5B.4B.4/5B.4C)", () => {
  async function seedCompletedTrip(overrides: {
    lockedFinancialBasis: Record<string, unknown>;
    ownershipRows?: Array<{uid: string; ownershipMinor: number}>;
    expectedOwnershipDigest?: string;
    expectedOwnershipCount?: number;
    expectedAllocationDigest?: string;
    expectedAllocationCount?: number;
  }): Promise<void> {
    const ownershipRows = overrides.ownershipRows ?? [];
    // Checkpoint 5B.4C, Section A: the frozen expected digest/count
    // default to the REAL computed digest/count of the seeded rows -
    // i.e. a Trip whose current output is still exactly the original
    // migration output - unless a test deliberately overrides them to
    // simulate drift/evolution.
    const realOwnershipDigest = computeOwnershipDigest(ownershipRows);
    await seedTrip({
      ownershipModelState: "initialized",
      ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
    });
    await db.collection("tripOwnershipMigrationState").doc(TRIP_ID).set({
      tripId: TRIP_ID,
      attemptId: "attempt-completed-report",
      phase: "completed",
      lockedAt: Timestamp.now(),
      startedAt: Timestamp.now(),
      lockedFinancialBasis: overrides.lockedFinancialBasis,
      sourceHistoryDigest: "frozen-source-digest",
      sourceHistoryDocumentCount: 3,
      expectedOwnershipDigest:
        overrides.expectedOwnershipDigest ?? realOwnershipDigest.hash,
      expectedOwnershipCount:
        overrides.expectedOwnershipCount ?? realOwnershipDigest.count,
      expectedAllocationDigest:
        overrides.expectedAllocationDigest ?? computeAllocationDigest([]).hash,
      expectedAllocationCount: overrides.expectedAllocationCount ?? 0,
      completedAt: Timestamp.now(),
    });
    for (const row of ownershipRows) {
      await db.collection("tripMemberOwnership").doc(`${TRIP_ID}_${row.uid}`).set({
        tripId: TRIP_ID,
        uid: row.uid,
        ownershipMinor: row.ownershipMinor,
        lastUpdatedAt: new Date(),
      });
    }
  }

  // Checkpoint 5B.4C, test matrix item 1: current digests exactly
  // equal the frozen values - historical fields may be populated.
  it("immediately after migration (current digest/count exactly matches frozen) - historical fields are populated", async () => {
    await seedCompletedTrip({
      lockedFinancialBasis: {
        ledgerInitializationKind: "initialized",
        ledgerOpeningBalanceMinor: 0,
        ledgerBalanceMinor: 1000,
        effectiveCurrency: "USD",
      },
      ownershipRows: [
        {uid: "daniel", ownershipMinor: 900},
        {uid: "friend", ownershipMinor: 100},
      ],
    });

    const result = await runDryRun(db, TRIP_ID);
    assert.equal(result.verdict, "already_completed");
    assert.equal(result.attemptId, "attempt-completed-report");
    assert.deepEqual(result.lockedFinancialBasis, {
      ledgerInitializationKind: "initialized",
      ledgerOpeningBalanceMinor: 0,
      ledgerBalanceMinor: 1000,
      effectiveCurrency: "USD",
    });
    assert.equal(result.openingBalanceMinor, 0);
    assert.equal(result.aggregateLedgerBalanceMinor, 1000);
    assert.equal(result.sourceHistoryDigest, "frozen-source-digest");
    assert.equal(result.sourceHistoryDocumentCount, 3);
    assert.ok(result.expectedOwnershipDigest);
    assert.ok(result.expectedAllocationDigest);

    const byUid = new Map(
      (result.reconstructedOwnership ?? []).map((b) => [
        b.uid,
        b.ownershipMinor,
      ])
    );
    assert.equal(byUid.get("daniel"), 900);
    assert.equal(byUid.get("friend"), 100);
    assert.equal(result.reconstructedOwnershipTotalMinor, 1000);
    assert.deepEqual(result.allocationsToCreate, []);

    // Intentionally never fabricated: the per-category history
    // breakdown and this run's own reconciliation evidence were never
    // persisted by the original completing run.
    assert.equal(result.historyCounts, null);
    assert.equal(result.reconciliation.aggregateMatches, null);
    assert.equal(result.reconciliation.historyReplayMatches, null);
    assert.equal(result.reconciliation.lockedFinancialBasisMatches, null);
    assert.equal(result.reconciliation.sourceHistoryDigestMatches, null);
    assert.equal(result.reconciliation.exactOwnershipOutputMatches, null);
    assert.equal(result.reconciliation.exactAllocationOutputMatches, null);
  });

  it("apply's already_completed path reports the same safe enrichment", async () => {
    await seedCompletedTrip({
      lockedFinancialBasis: {
        ledgerInitializationKind: "uninitialized",
        derivedLegacyOpeningBalanceMinor: 0,
        effectiveCurrency: "USD",
      },
      ownershipRows: [],
    });

    const result = await runApply(db, TRIP_ID);
    assert.equal(result.verdict, "already_completed");
    assert.equal(result.attemptId, "attempt-completed-report");
    assert.equal(result.openingBalanceMinor, 0);
    assert.equal(result.aggregateLedgerBalanceMinor, 0);
    assert.deepEqual(result.reconstructedOwnership, []);
    assert.equal(result.reconstructedOwnershipTotalMinor, 0);
    assert.deepEqual(result.allocationsToCreate, []);
    assert.equal(result.historyCounts, null);
    assert.equal(result.reconciliation.aggregateMatches, null);
  });

  // Checkpoint 5B.4C, test matrix item 2: legitimate post-migration
  // ownership evolution (e.g. a lazy-initialized new contribution) -
  // verdict stays already_completed, this is NEVER reported as an
  // anomaly, and the now-stale current rows are NOT mislabeled as the
  // historical migration output.
  it("after legitimate post-migration ownership evolution - verdict unchanged, no anomaly, historical ownership fields left null", async () => {
    await seedCompletedTrip({
      lockedFinancialBasis: {
        ledgerInitializationKind: "initialized",
        ledgerOpeningBalanceMinor: 0,
        ledgerBalanceMinor: 1000,
        effectiveCurrency: "USD",
      },
      ownershipRows: [
        {uid: "daniel", ownershipMinor: 900},
        {uid: "friend", ownershipMinor: 100},
      ],
    });
    // Simulates a legitimate post-migration lazy-initialized
    // contribution changing daniel's row.
    await db.collection("tripMemberOwnership").doc(`${TRIP_ID}_daniel`).update({
      ownershipMinor: 950,
    });

    const result = await runDryRun(db, TRIP_ID);
    assert.equal(result.verdict, "already_completed");
    assert.equal(result.anomalies.length, 0);
    // The current set no longer matches the frozen digest - it must
    // NOT be reported as the historical migration output.
    assert.equal(result.reconstructedOwnership, null);
    assert.equal(result.reconstructedOwnershipTotalMinor, null);
    // Allocations were untouched and still match - still populated.
    assert.deepEqual(result.allocationsToCreate, []);
    // Frozen/persisted fields remain reported regardless.
    assert.ok(result.expectedOwnershipDigest);
  });

  // Checkpoint 5B.4C, test matrix item 3: legitimate post-migration
  // allocation additions (e.g. a brand-new Shared-Stash Expense) -
  // verdict stays already_completed, allocationsToCreate is not
  // mislabeled as historical migration output.
  it("after legitimate post-migration allocation additions - verdict unchanged, no anomaly, historical allocation field left null", async () => {
    await seedCompletedTrip({
      lockedFinancialBasis: {
        ledgerInitializationKind: "initialized",
        ledgerOpeningBalanceMinor: 0,
        ledgerBalanceMinor: 1000,
        effectiveCurrency: "USD",
      },
      ownershipRows: [
        {uid: "daniel", ownershipMinor: 900},
        {uid: "friend", ownershipMinor: 100},
      ],
    });
    // Simulates a legitimate NEW post-migration Shared-Stash Expense
    // (live "original" provenance, not "migrated") adding a record
    // the frozen expectedAllocationCount never accounted for.
    await db.collection("tripOwnershipAllocations").doc("new-withdrawal").set({
      tripId: TRIP_ID,
      expenseId: "new-expense",
      withdrawalTransactionId: "new-withdrawal",
      amountMinor: 50,
      currency: "USD",
      allocations: [{uid: "daniel", amountMinor: 50}],
      provenance: "original",
      createdAt: Timestamp.now(),
    });

    const result = await runDryRun(db, TRIP_ID);
    assert.equal(result.verdict, "already_completed");
    assert.equal(result.anomalies.length, 0);
    // Ownership untouched and still matches - still populated.
    const byUid = new Map(
      (result.reconstructedOwnership ?? []).map((b) => [
        b.uid,
        b.ownershipMinor,
      ])
    );
    assert.equal(byUid.get("daniel"), 900);
    // The current allocation set no longer matches the frozen count -
    // it must NOT be reported as the historical migration output.
    assert.equal(result.allocationsToCreate, null);
  });

  // Checkpoint 5B.4C, test matrix item 4: exact digest AND exact
  // count are both required - a count that happens to match the
  // frozen value is not sufficient on its own if the digest (i.e. the
  // actual content) disagrees.
  it("requires BOTH exact digest and exact count - a matching count with a wrong digest still leaves the field null", async () => {
    const ownershipRows = [
      {uid: "daniel", ownershipMinor: 900},
      {uid: "friend", ownershipMinor: 100},
    ];
    await seedCompletedTrip({
      lockedFinancialBasis: {
        ledgerInitializationKind: "initialized",
        ledgerOpeningBalanceMinor: 0,
        ledgerBalanceMinor: 1000,
        effectiveCurrency: "USD",
      },
      ownershipRows,
      // Same COUNT (2) as the real set, but a digest that could never
      // honestly match any real 2-row set's content.
      expectedOwnershipDigest: "deliberately-wrong-digest-same-count",
      expectedOwnershipCount: ownershipRows.length,
    });

    const result = await runDryRun(db, TRIP_ID);
    assert.equal(result.verdict, "already_completed");
    assert.equal(result.anomalies.length, 0);
    assert.equal(result.reconstructedOwnership, null);
    assert.equal(result.reconstructedOwnershipTotalMinor, null);
  });

  it("strict already_completed validation is unchanged - a malformed completed migration-state document still fails closed with no enrichment", async () => {
    await seedTrip({
      ownershipModelState: "initialized",
      ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
    });
    await db.collection("tripOwnershipMigrationState").doc(TRIP_ID).set({
      tripId: "some-other-trip",
      attemptId: "attempt-x",
      phase: "completed",
      lockedAt: Timestamp.now(),
      startedAt: Timestamp.now(),
      lockedFinancialBasis: {
        ledgerInitializationKind: "initialized",
        ledgerOpeningBalanceMinor: 0,
        ledgerBalanceMinor: 0,
        effectiveCurrency: "USD",
      },
      sourceHistoryDigest: "abc",
      sourceHistoryDocumentCount: 0,
      expectedOwnershipDigest: "def",
      expectedOwnershipCount: 0,
      expectedAllocationDigest: "ghi",
      expectedAllocationCount: 0,
      completedAt: Timestamp.now(),
    });

    const result = await runDryRun(db, TRIP_ID);
    assert.equal(result.verdict, "requires_manual_review");
    assert.equal(
      result.anomalies[0].reasonCode,
      "invalid_migration_state_phase"
    );
    assert.equal(result.lockedFinancialBasis, null);
    assert.equal(result.reconstructedOwnership, null);
  });
});

// ---------------------------------------------------------------------
// Checkpoint 5B.4C, Section B / test matrix item 5: FinalizationEvidence
// must be retry-safe - `finalizeMigration` declares its `evidence`
// object INSIDE the `db.runTransaction` callback (never outside and
// mutated from within), so the Firestore Admin SDK's own documented
// retry behavior (re-invoking the ENTIRE callback from scratch,
// including that declaration) can never leak a stale/partial evidence
// object from an earlier, aborted attempt into the final result - each
// attempt gets its own fresh object, and only the attempt whose
// return value actually commits is ever seen by the caller. This test
// forces a genuine write conflict (two concurrent `runApply` calls
// racing to finalize the SAME Trip) to exercise a real retry, then
// proves the losing side's evidence is never a fabricated success.
// ---------------------------------------------------------------------

describe("FinalizationEvidence retry safety (Checkpoint 5B.4C, Section B)", () => {
  it("two concurrent finalizations of the same Trip never leak stale/partial evidence into either result", async () => {
    await seedTrip({ledgerOpeningBalanceMinor: 0, ledgerBalanceMinor: 800});
    await seedOrdinaryTransaction("tx-1", "daniel", "contribution", 900, 1000);
    await seedOrdinaryTransaction("tx-2", "friend", "contribution", 100, 2000);
    await seedSharedStashExpense("expense-1", "withdrawal-1", 200, 3000);

    const transactions: RawSavingsTransactionRecord[] = [
      {
        id: "tx-1",
        resourceType: "trip",
        resourceId: TRIP_ID,
        memberUid: "daniel",
        type: "contribution",
        amountMinor: 900,
        currency: "USD",
        createdAt: Timestamp.fromMillis(1000),
        reversalOf: null,
        linkedExpenseId: null,
      },
      {
        id: "tx-2",
        resourceType: "trip",
        resourceId: TRIP_ID,
        memberUid: "friend",
        type: "contribution",
        amountMinor: 100,
        currency: "USD",
        createdAt: Timestamp.fromMillis(2000),
        reversalOf: null,
        linkedExpenseId: null,
      },
      {
        id: "withdrawal-1",
        resourceType: "trip",
        resourceId: TRIP_ID,
        memberUid: "daniel",
        type: "withdrawal",
        amountMinor: 200,
        currency: "USD",
        createdAt: Timestamp.fromMillis(3000),
        reversalOf: null,
        linkedExpenseId: "expense-1",
      },
    ];
    const expenses = [
      {
        id: "expense-1",
        tripId: TRIP_ID,
        paymentSource: "shared_stash",
        amountMinor: 200,
        currency: "USD",
        sharedStashTransactionId: "withdrawal-1",
        status: "active",
        createdAt: Timestamp.fromMillis(3000),
        reversedAt: null,
        refundTransactionId: null,
        replacesExpenseId: null,
        replacedByExpenseId: null,
      },
    ];
    const expected = computeExpectedReconstruction(transactions, expenses);

    await db.collection("trips").doc(TRIP_ID).update({
      ownershipModelState: "migrating",
    });
    const lockedFinancialBasis = buildLockedFinancialBasis(
      {kind: "case_a", currentBalanceMinor: 800, openingBalanceMinor: 0},
      "USD"
    );
    await db.collection("tripOwnershipMigrationState").doc(TRIP_ID).set({
      tripId: TRIP_ID,
      attemptId: "attempt-race",
      phase: "reconstructed",
      lockedAt: new Date(),
      startedAt: new Date(),
      lockedFinancialBasis,
      sourceHistoryDigest: expected.sourceDigest.hash,
      sourceHistoryDocumentCount: expected.sourceDigest.count,
      expectedOwnershipDigest: expected.ownershipDigest.hash,
      expectedOwnershipCount: expected.ownershipDigest.count,
      expectedAllocationDigest: expected.allocationDigest.hash,
      expectedAllocationCount: expected.allocationDigest.count,
    });

    const [resultA, resultB] = await Promise.all([
      runApply(db, TRIP_ID),
      runApply(db, TRIP_ID),
    ]);

    const winner = [resultA, resultB].find(
      (r) => r.verdict === "safe_to_migrate"
    );
    const loser = [resultA, resultB].find((r) => r !== winner);
    assert.ok(winner, "expected exactly one call to actually finalize");
    assert.equal(winner?.phase, "completed");
    assert.equal(winner?.reconciliation.lockedFinancialBasisMatches, true);
    assert.equal(winner?.reconciliation.sourceHistoryDigestMatches, true);
    assert.equal(winner?.reconciliation.exactOwnershipOutputMatches, true);
    assert.equal(winner?.reconciliation.exactAllocationOutputMatches, true);
    assert.equal(winner?.reconciliation.aggregateMatches, true);

    // The loser must never report a fabricated success - either it
    // also reconciles to already_completed (if its own retry happened
    // to land after the winner's commit, and it re-classified fresh),
    // or it fails closed; either way it must NEVER claim
    // verdict === "safe_to_migrate" a second time, and any
    // reconciliation field it reports must be an HONEST reflection of
    // a check THAT SAME losing attempt actually reached - never a
    // leaked true from the winner's own attempt.
    assert.notEqual(loser?.verdict, "safe_to_migrate");
    if (loser?.verdict === "requires_manual_review") {
      // Failed closed before (or during) finalization - every
      // finalization-only evidence field it reports must be either
      // null (never reached) or false (reached and correctly failed,
      // since the Trip had already moved on) - never true, since
      // THIS attempt's own finalization never actually committed.
      assert.notEqual(loser.reconciliation.exactOwnershipOutputMatches, true);
      assert.notEqual(
        loser.reconciliation.exactAllocationOutputMatches,
        true
      );
    }

    // Exactly one commit happened - the persisted state is correct
    // and not corrupted by the race.
    const tripData = (await db.collection("trips").doc(TRIP_ID).get()).data();
    assert.equal(tripData?.ownershipModelState, "initialized");
    const ownership = await getOwnershipMap();
    assert.equal(ownership.get("daniel"), 720);
    assert.equal(ownership.get("friend"), 80);
    const msSnap = await db
      .collection("tripOwnershipMigrationState")
      .doc(TRIP_ID)
      .get();
    assert.equal(msSnap.data()?.phase, "completed");
  });
});

// ---------------------------------------------------------------------
// APPLY - phase-aware resumability (§19/§20)
// ---------------------------------------------------------------------

describe("runApply - resumability", () => {
  it("resumes from phase \"locked\" (crash before reconstruction)", async () => {
    await seedTrip({ledgerOpeningBalanceMinor: 0, ledgerBalanceMinor: 800});
    await seedOrdinaryTransaction("tx-1", "daniel", "contribution", 900, 1000);
    await seedOrdinaryTransaction("tx-2", "friend", "contribution", 100, 2000);
    await seedSharedStashExpense("expense-1", "withdrawal-1", 200, 3000);

    await db.collection("trips").doc(TRIP_ID).update({
      ownershipModelState: "migrating",
    });
    const lockedFinancialBasis = buildLockedFinancialBasis(
      {kind: "case_a", currentBalanceMinor: 800, openingBalanceMinor: 0},
      "USD"
    );
    await db.collection("tripOwnershipMigrationState").doc(TRIP_ID).set({
      tripId: TRIP_ID,
      attemptId: "attempt-resume-1",
      phase: "locked",
      lockedAt: new Date(),
      startedAt: new Date(),
      lockedFinancialBasis,
    });

    const result = await runApply(db, TRIP_ID);
    assert.equal(result.verdict, "safe_to_migrate");
    assert.equal(result.phase, "completed");
    const ownership = await getOwnershipMap();
    assert.equal(ownership.get("daniel"), 720);
    assert.equal(ownership.get("friend"), 80);
  });

  it("resumes from phase \"reconstructed\" (crash before materialization)", async () => {
    await seedTrip({ledgerOpeningBalanceMinor: 0, ledgerBalanceMinor: 800});
    await seedOrdinaryTransaction("tx-1", "daniel", "contribution", 900, 1000);
    await seedOrdinaryTransaction("tx-2", "friend", "contribution", 100, 2000);
    await seedSharedStashExpense("expense-1", "withdrawal-1", 200, 3000);

    const transactions: RawSavingsTransactionRecord[] = [
      {
        id: "tx-1",
        resourceType: "trip",
        resourceId: TRIP_ID,
        memberUid: "daniel",
        type: "contribution",
        amountMinor: 900,
        currency: "USD",
        createdAt: Timestamp.fromMillis(1000),
        reversalOf: null,
        linkedExpenseId: null,
      },
      {
        id: "tx-2",
        resourceType: "trip",
        resourceId: TRIP_ID,
        memberUid: "friend",
        type: "contribution",
        amountMinor: 100,
        currency: "USD",
        createdAt: Timestamp.fromMillis(2000),
        reversalOf: null,
        linkedExpenseId: null,
      },
      {
        id: "withdrawal-1",
        resourceType: "trip",
        resourceId: TRIP_ID,
        memberUid: "daniel",
        type: "withdrawal",
        amountMinor: 200,
        currency: "USD",
        createdAt: Timestamp.fromMillis(3000),
        reversalOf: null,
        linkedExpenseId: "expense-1",
      },
    ];
    const expenses = [
      {
        id: "expense-1",
        tripId: TRIP_ID,
        paymentSource: "shared_stash",
        amountMinor: 200,
        currency: "USD",
        sharedStashTransactionId: "withdrawal-1",
        status: "active",
        createdAt: Timestamp.fromMillis(3000),
        reversedAt: null,
        refundTransactionId: null,
        replacesExpenseId: null,
        replacedByExpenseId: null,
      },
    ];
    const expected = computeExpectedReconstruction(transactions, expenses);

    await db.collection("trips").doc(TRIP_ID).update({
      ownershipModelState: "migrating",
    });
    const lockedFinancialBasis = buildLockedFinancialBasis(
      {kind: "case_a", currentBalanceMinor: 800, openingBalanceMinor: 0},
      "USD"
    );
    await db.collection("tripOwnershipMigrationState").doc(TRIP_ID).set({
      tripId: TRIP_ID,
      attemptId: "attempt-resume-2",
      phase: "reconstructed",
      lockedAt: new Date(),
      startedAt: new Date(),
      lockedFinancialBasis,
      sourceHistoryDigest: expected.sourceDigest.hash,
      sourceHistoryDocumentCount: expected.sourceDigest.count,
      expectedOwnershipDigest: expected.ownershipDigest.hash,
      expectedOwnershipCount: expected.ownershipDigest.count,
      expectedAllocationDigest: expected.allocationDigest.hash,
      expectedAllocationCount: expected.allocationDigest.count,
    });

    const result = await runApply(db, TRIP_ID);
    assert.equal(result.verdict, "safe_to_migrate");
    const ownership = await getOwnershipMap();
    assert.equal(ownership.get("daniel"), 720);
    assert.equal(ownership.get("friend"), 80);
  });

  it("fails closed with out_of_band_mutation_detected when history changes after reconstruction", async () => {
    await seedTrip({ledgerOpeningBalanceMinor: 0, ledgerBalanceMinor: 800});
    await seedOrdinaryTransaction("tx-1", "daniel", "contribution", 900, 1000);
    await seedOrdinaryTransaction("tx-2", "friend", "contribution", 100, 2000);
    await seedSharedStashExpense("expense-1", "withdrawal-1", 200, 3000);

    const transactions: RawSavingsTransactionRecord[] = [
      {
        id: "tx-1",
        resourceType: "trip",
        resourceId: TRIP_ID,
        memberUid: "daniel",
        type: "contribution",
        amountMinor: 900,
        currency: "USD",
        createdAt: Timestamp.fromMillis(1000),
        reversalOf: null,
        linkedExpenseId: null,
      },
      {
        id: "tx-2",
        resourceType: "trip",
        resourceId: TRIP_ID,
        memberUid: "friend",
        type: "contribution",
        amountMinor: 100,
        currency: "USD",
        createdAt: Timestamp.fromMillis(2000),
        reversalOf: null,
        linkedExpenseId: null,
      },
      {
        id: "withdrawal-1",
        resourceType: "trip",
        resourceId: TRIP_ID,
        memberUid: "daniel",
        type: "withdrawal",
        amountMinor: 200,
        currency: "USD",
        createdAt: Timestamp.fromMillis(3000),
        reversalOf: null,
        linkedExpenseId: "expense-1",
      },
    ];
    const expenses = [
      {
        id: "expense-1",
        tripId: TRIP_ID,
        paymentSource: "shared_stash",
        amountMinor: 200,
        currency: "USD",
        sharedStashTransactionId: "withdrawal-1",
        status: "active",
        createdAt: Timestamp.fromMillis(3000),
        reversedAt: null,
        refundTransactionId: null,
        replacesExpenseId: null,
        replacedByExpenseId: null,
      },
    ];
    const expected = computeExpectedReconstruction(transactions, expenses);

    await db.collection("trips").doc(TRIP_ID).update({
      ownershipModelState: "migrating",
    });
    const lockedFinancialBasis = buildLockedFinancialBasis(
      {kind: "case_a", currentBalanceMinor: 800, openingBalanceMinor: 0},
      "USD"
    );
    await db.collection("tripOwnershipMigrationState").doc(TRIP_ID).set({
      tripId: TRIP_ID,
      attemptId: "attempt-resume-3",
      phase: "reconstructed",
      lockedAt: new Date(),
      startedAt: new Date(),
      lockedFinancialBasis,
      sourceHistoryDigest: expected.sourceDigest.hash,
      sourceHistoryDocumentCount: expected.sourceDigest.count,
      expectedOwnershipDigest: expected.ownershipDigest.hash,
      expectedOwnershipCount: expected.ownershipDigest.count,
      expectedAllocationDigest: expected.allocationDigest.hash,
      expectedAllocationCount: expected.allocationDigest.count,
    });

    // Out-of-band tamper: change tx-2's own amount after reconstruction
    // froze the digest.
    await db.collection("savingsTransactions").doc("tx-2").update({
      amountMinor: 150,
    });

    const result = await runApply(db, TRIP_ID);
    assert.equal(
      result.anomalies[0].reasonCode,
      "out_of_band_mutation_detected"
    );
    const tripData = (await db.collection("trips").doc(TRIP_ID).get()).data();
    assert.equal(tripData?.ownershipModelState, "migrating");
  });
});

// ---------------------------------------------------------------------
// Checkpoint 5B.4B.1, Section E: locked -> reconstructed must
// re-verify the CURRENT financial basis against the locked one,
// rebuilt fresh inside the transition's own transaction.
// ---------------------------------------------------------------------

describe("runApply - locked financial basis revalidation (Section E)", () => {
  async function seedLockedTrip(
    tripOverrides: Record<string, unknown>
  ): Promise<void> {
    await seedTrip({
      ledgerOpeningBalanceMinor: 0,
      ledgerBalanceMinor: 800,
      ...tripOverrides,
    });
    await seedOrdinaryTransaction("tx-1", "daniel", "contribution", 900, 1000);
    await seedOrdinaryTransaction("tx-2", "friend", "contribution", 100, 2000);
    await seedSharedStashExpense("expense-1", "withdrawal-1", 200, 3000);
    await db.collection("trips").doc(TRIP_ID).update({
      ownershipModelState: "migrating",
    });
    const lockedFinancialBasis = buildLockedFinancialBasis(
      {kind: "case_a", currentBalanceMinor: 800, openingBalanceMinor: 0},
      "USD"
    );
    await db.collection("tripOwnershipMigrationState").doc(TRIP_ID).set({
      tripId: TRIP_ID,
      attemptId: "attempt-basis-check",
      phase: "locked",
      lockedAt: new Date(),
      startedAt: new Date(),
      lockedFinancialBasis,
    });
  }

  it("rejects when the current aggregate changed after lock", async () => {
    await seedLockedTrip({});
    await db.collection("trips").doc(TRIP_ID).update({
      ledgerBalanceMinor: 850,
    });

    const result = await runApply(db, TRIP_ID);
    assert.equal(
      result.anomalies[0].reasonCode,
      "locked_financial_basis_mismatch"
    );
    const msSnap = await db
      .collection("tripOwnershipMigrationState")
      .doc(TRIP_ID)
      .get();
    assert.equal(msSnap.data()?.phase, "locked");
    const tripData = (await db.collection("trips").doc(TRIP_ID).get()).data();
    assert.equal(tripData?.ownershipModelState, "migrating");
  });

  it("rejects when the opening balance changed after lock", async () => {
    await seedLockedTrip({});
    await db.collection("trips").doc(TRIP_ID).update({
      ledgerOpeningBalanceMinor: 50,
      ledgerBalanceMinor: 850,
    });

    const result = await runApply(db, TRIP_ID);
    assert.equal(
      result.anomalies[0].reasonCode,
      "locked_financial_basis_mismatch"
    );
  });

  it("rejects when the currency changed after lock", async () => {
    await seedLockedTrip({currency: "USD"});
    await db.collection("trips").doc(TRIP_ID).update({currency: "EUR"});

    const result = await runApply(db, TRIP_ID);
    assert.equal(
      result.anomalies[0].reasonCode,
      "locked_financial_basis_mismatch"
    );
  });

  it("rejects when ledger fields disappear after lock", async () => {
    await seedLockedTrip({});
    await db.collection("trips").doc(TRIP_ID).update({
      ledgerOpeningBalanceMinor: FieldValue.delete(),
      ledgerBalanceMinor: FieldValue.delete(),
    });

    const result = await runApply(db, TRIP_ID);
    assert.equal(
      result.anomalies[0].reasonCode,
      "locked_financial_basis_mismatch"
    );
  });

  it("rejects when a legacy saved-derived opening balance changes after lock (uninitialized basis)", async () => {
    await seedTrip({saved: 0});
    await db.collection("trips").doc(TRIP_ID).update({
      ownershipModelState: "migrating",
    });
    const lockedFinancialBasis = buildLockedFinancialBasis(
      {kind: "case_a_equivalent"},
      "USD"
    );
    await db.collection("tripOwnershipMigrationState").doc(TRIP_ID).set({
      tripId: TRIP_ID,
      attemptId: "attempt-basis-check-2",
      phase: "locked",
      lockedAt: new Date(),
      startedAt: new Date(),
      lockedFinancialBasis,
    });
    // saved changes from 0 to a positive value after lock - the
    // derived opening balance would now differ.
    await db.collection("trips").doc(TRIP_ID).update({saved: 5});

    const result = await runApply(db, TRIP_ID);
    assert.equal(
      result.anomalies[0].reasonCode,
      "locked_financial_basis_mismatch"
    );
  });

  it("accepts an unchanged basis and proceeds to completion", async () => {
    await seedLockedTrip({});
    const result = await runApply(db, TRIP_ID);
    assert.equal(result.verdict, "safe_to_migrate");
  });
});

// ---------------------------------------------------------------------
// Checkpoint 5B.4B.1, Section F: phase "locked" must never coexist
// with any migration output.
// ---------------------------------------------------------------------

describe("runApply - zero-output-while-locked invariant (Section F)", () => {
  async function seedLockedTripWithBasis(): Promise<void> {
    await seedTrip({ledgerOpeningBalanceMinor: 0, ledgerBalanceMinor: 900});
    await seedOrdinaryTransaction("tx-1", "daniel", "contribution", 900, 1000);
    await db.collection("trips").doc(TRIP_ID).update({
      ownershipModelState: "migrating",
    });
    const lockedFinancialBasis = buildLockedFinancialBasis(
      {kind: "case_a", currentBalanceMinor: 900, openingBalanceMinor: 0},
      "USD"
    );
    await db.collection("tripOwnershipMigrationState").doc(TRIP_ID).set({
      tripId: TRIP_ID,
      attemptId: "attempt-zero-output",
      phase: "locked",
      lockedAt: new Date(),
      startedAt: new Date(),
      lockedFinancialBasis,
    });
  }

  it("rejects the transition when an ownership output already exists while still locked", async () => {
    await seedLockedTripWithBasis();
    await db.collection("tripMemberOwnership").doc(`${TRIP_ID}_rogue`).set({
      tripId: TRIP_ID,
      uid: "rogue",
      ownershipMinor: 1,
      lastUpdatedAt: new Date(),
    });

    const result = await runApply(db, TRIP_ID);
    assert.equal(
      result.anomalies[0].reasonCode,
      "invalid_migration_state_phase"
    );
    const msSnap = await db
      .collection("tripOwnershipMigrationState")
      .doc(TRIP_ID)
      .get();
    assert.equal(msSnap.data()?.phase, "locked");
  });

  it("rejects the transition when an allocation output already exists while still locked", async () => {
    await seedLockedTripWithBasis();
    await db.collection("tripOwnershipAllocations").doc("rogue-withdrawal").set({
      tripId: TRIP_ID,
      expenseId: "rogue-expense",
      withdrawalTransactionId: "rogue-withdrawal",
      amountMinor: 1,
      currency: "USD",
      allocations: [{uid: "daniel", amountMinor: 1}],
      provenance: "migrated",
      createdAt: new Date(),
      migratedAt: new Date(),
    });

    const result = await runApply(db, TRIP_ID);
    assert.equal(
      result.anomalies[0].reasonCode,
      "invalid_migration_state_phase"
    );
  });
});

// ---------------------------------------------------------------------
// Checkpoint 5B.4B.1, Section H: each output-write chunk re-proves the
// full lifecycle immediately before its own commit - tested directly
// against the exported materializer functions, simulating a state
// change occurring between two chunks.
// ---------------------------------------------------------------------

describe("materialization write-boundary lifecycle recheck (Section H)", () => {
  async function seedReconstructedState(attemptId: string): Promise<void> {
    await seedTrip({ledgerOpeningBalanceMinor: 0, ledgerBalanceMinor: 600});
    await db.collection("trips").doc(TRIP_ID).update({
      ownershipModelState: "migrating",
    });
    const lockedFinancialBasis = buildLockedFinancialBasis(
      {kind: "case_a", currentBalanceMinor: 600, openingBalanceMinor: 0},
      "USD"
    );
    await db.collection("tripOwnershipMigrationState").doc(TRIP_ID).set({
      tripId: TRIP_ID,
      attemptId,
      phase: "reconstructed",
      lockedAt: new Date(),
      startedAt: new Date(),
      lockedFinancialBasis,
      sourceHistoryDigest: "abc",
      sourceHistoryDocumentCount: 0,
      expectedOwnershipDigest: "def",
      expectedOwnershipCount: 1,
      expectedAllocationDigest: "ghi",
      expectedAllocationCount: 0,
    });
  }

  it("writes successfully while the lifecycle still matches", async () => {
    await seedReconstructedState("attempt-h-1");
    const result = await materializeOwnershipOutputs(db, TRIP_ID, "attempt-h-1", [
      {uid: "daniel", ownershipMinor: 600},
    ]);
    assert.equal(result.ok, true);
    assert.equal(await getOwnershipMap().then((m) => m.get("daniel")), 600);
  });

  it("refuses to write once the migration-state attemptId no longer matches (simulating a state change between chunks)", async () => {
    await seedReconstructedState("attempt-h-2");
    // Simulate another process having advanced/changed this attempt
    // between reconstruction and this chunk's own write.
    await db.collection("tripOwnershipMigrationState").doc(TRIP_ID).update({
      attemptId: "attempt-h-2-superseded",
    });

    const result = await materializeOwnershipOutputs(db, TRIP_ID, "attempt-h-2", [
      {uid: "daniel", ownershipMinor: 600},
    ]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reasonCode, "invalid_migration_state_phase");
    }
    assert.equal(await getOwnershipMap().then((m) => m.get("daniel")), undefined);
  });

  it("refuses to write once the Trip is no longer migrating", async () => {
    await seedReconstructedState("attempt-h-3");
    await db.collection("trips").doc(TRIP_ID).update({
      ownershipModelState: "needs_reconciliation",
      ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
    });

    const result = await materializeOwnershipOutputs(db, TRIP_ID, "attempt-h-3", [
      {uid: "daniel", ownershipMinor: 600},
    ]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reasonCode, "unexpected_state_change");
    }
  });

  it("refuses to write once the migration-state phase regressed to \"locked\"", async () => {
    await seedReconstructedState("attempt-h-4");
    await db.collection("tripOwnershipMigrationState").doc(TRIP_ID).update({
      phase: "locked",
      sourceHistoryDigest: FieldValue.delete(),
      sourceHistoryDocumentCount: FieldValue.delete(),
      expectedOwnershipDigest: FieldValue.delete(),
      expectedOwnershipCount: FieldValue.delete(),
      expectedAllocationDigest: FieldValue.delete(),
      expectedAllocationCount: FieldValue.delete(),
    });

    const result = await materializeOwnershipOutputs(db, TRIP_ID, "attempt-h-4", [
      {uid: "daniel", ownershipMinor: 600},
    ]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reasonCode, "invalid_migration_state_phase");
    }
  });

  it("allocation materialization also refuses to write once state no longer matches", async () => {
    await seedReconstructedState("attempt-h-5");
    await db.collection("tripOwnershipMigrationState").doc(TRIP_ID).update({
      attemptId: "attempt-h-5-superseded",
    });

    const result = await materializeAllocationOutputs(
      db,
      TRIP_ID,
      "attempt-h-5",
      [
        {
          tripId: TRIP_ID,
          expenseId: "expense-1",
          withdrawalTransactionId: "withdrawal-1",
          amountMinor: 200,
          currency: "USD",
          allocations: [{uid: "daniel", amountMinor: 200}],
          createdAt: Timestamp.fromMillis(3000),
        },
      ]
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reasonCode, "invalid_migration_state_phase");
    }
    const allocSnap = await db
      .collection("tripOwnershipAllocations")
      .doc("withdrawal-1")
      .get();
    assert.equal(allocSnap.exists, false);
  });
});

// ---------------------------------------------------------------------
// Checkpoint 5B.4B.1, Section J: immutable migrated-allocation
// matching requires EXACT createdAt equality and a valid migratedAt -
// never merely the economic fields.
// ---------------------------------------------------------------------

describe("materializeAllocationOutputs - immutable matching (Section J)", () => {
  async function seedReconstructedStateForAllocation(
    attemptId: string
  ): Promise<void> {
    await seedTrip({ledgerOpeningBalanceMinor: 0, ledgerBalanceMinor: 600});
    await db.collection("trips").doc(TRIP_ID).update({
      ownershipModelState: "migrating",
    });
    const lockedFinancialBasis = buildLockedFinancialBasis(
      {kind: "case_a", currentBalanceMinor: 600, openingBalanceMinor: 0},
      "USD"
    );
    await db.collection("tripOwnershipMigrationState").doc(TRIP_ID).set({
      tripId: TRIP_ID,
      attemptId,
      phase: "reconstructed",
      lockedAt: new Date(),
      startedAt: new Date(),
      lockedFinancialBasis,
      sourceHistoryDigest: "abc",
      sourceHistoryDocumentCount: 0,
      expectedOwnershipDigest: "def",
      expectedOwnershipCount: 0,
      expectedAllocationDigest: "ghi",
      expectedAllocationCount: 1,
    });
  }

  const freshAllocation = {
    tripId: TRIP_ID,
    expenseId: "expense-1",
    withdrawalTransactionId: "withdrawal-1",
    amountMinor: 200,
    currency: "USD",
    allocations: [{uid: "daniel", amountMinor: 200}],
    createdAt: Timestamp.fromMillis(3000),
  };

  it("skips an exact existing migrated allocation idempotently", async () => {
    await seedReconstructedStateForAllocation("attempt-j-1");
    await db.collection("tripOwnershipAllocations").doc("withdrawal-1").set({
      tripId: TRIP_ID,
      expenseId: "expense-1",
      withdrawalTransactionId: "withdrawal-1",
      amountMinor: 200,
      currency: "USD",
      allocations: [{uid: "daniel", amountMinor: 200}],
      provenance: "migrated",
      createdAt: Timestamp.fromMillis(3000),
      migratedAt: Timestamp.fromMillis(9999),
    });

    const result = await materializeAllocationOutputs(
      db,
      TRIP_ID,
      "attempt-j-1",
      [freshAllocation]
    );
    assert.equal(result.ok, true);
    const snap = await db
      .collection("tripOwnershipAllocations")
      .doc("withdrawal-1")
      .get();
    assert.equal(snap.data()?.migratedAt.toMillis(), 9999);
  });

  it("rejects when the existing record's createdAt disagrees with the historical value", async () => {
    await seedReconstructedStateForAllocation("attempt-j-2");
    await db.collection("tripOwnershipAllocations").doc("withdrawal-1").set({
      tripId: TRIP_ID,
      expenseId: "expense-1",
      withdrawalTransactionId: "withdrawal-1",
      amountMinor: 200,
      currency: "USD",
      allocations: [{uid: "daniel", amountMinor: 200}],
      provenance: "migrated",
      createdAt: Timestamp.fromMillis(4000),
      migratedAt: Timestamp.fromMillis(9999),
    });

    const result = await materializeAllocationOutputs(
      db,
      TRIP_ID,
      "attempt-j-2",
      [freshAllocation]
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reasonCode, "conflicting_existing_allocation");
    }
  });

  it("rejects when the existing record is missing a valid migratedAt", async () => {
    await seedReconstructedStateForAllocation("attempt-j-3");
    await db.collection("tripOwnershipAllocations").doc("withdrawal-1").set({
      tripId: TRIP_ID,
      expenseId: "expense-1",
      withdrawalTransactionId: "withdrawal-1",
      amountMinor: 200,
      currency: "USD",
      allocations: [{uid: "daniel", amountMinor: 200}],
      provenance: "migrated",
      createdAt: Timestamp.fromMillis(3000),
      migratedAt: "not-a-timestamp",
    });

    const result = await materializeAllocationOutputs(
      db,
      TRIP_ID,
      "attempt-j-3",
      [freshAllocation]
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reasonCode, "malformed_existing_allocation_record");
    }
  });

  it("rejects when the existing record's amount disagrees", async () => {
    await seedReconstructedStateForAllocation("attempt-j-4");
    await db.collection("tripOwnershipAllocations").doc("withdrawal-1").set({
      tripId: TRIP_ID,
      expenseId: "expense-1",
      withdrawalTransactionId: "withdrawal-1",
      amountMinor: 199,
      currency: "USD",
      allocations: [{uid: "daniel", amountMinor: 199}],
      provenance: "migrated",
      createdAt: Timestamp.fromMillis(3000),
      migratedAt: Timestamp.fromMillis(9999),
    });

    const result = await materializeAllocationOutputs(
      db,
      TRIP_ID,
      "attempt-j-4",
      [freshAllocation]
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reasonCode, "conflicting_existing_allocation");
    }
  });

  it("rejects when the existing allocations array disagrees", async () => {
    await seedReconstructedStateForAllocation("attempt-j-5");
    await db.collection("tripOwnershipAllocations").doc("withdrawal-1").set({
      tripId: TRIP_ID,
      expenseId: "expense-1",
      withdrawalTransactionId: "withdrawal-1",
      amountMinor: 200,
      currency: "USD",
      allocations: [{uid: "someone-else", amountMinor: 200}],
      provenance: "migrated",
      createdAt: Timestamp.fromMillis(3000),
      migratedAt: Timestamp.fromMillis(9999),
    });

    const result = await materializeAllocationOutputs(
      db,
      TRIP_ID,
      "attempt-j-5",
      [freshAllocation]
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reasonCode, "conflicting_existing_allocation");
    }
  });

  it("rejects an existing record with provenance \"original\"", async () => {
    await seedReconstructedStateForAllocation("attempt-j-6");
    await db.collection("tripOwnershipAllocations").doc("withdrawal-1").set({
      tripId: TRIP_ID,
      expenseId: "expense-1",
      withdrawalTransactionId: "withdrawal-1",
      amountMinor: 200,
      currency: "USD",
      allocations: [{uid: "daniel", amountMinor: 200}],
      provenance: "original",
      createdAt: Timestamp.fromMillis(3000),
    });

    const result = await materializeAllocationOutputs(
      db,
      TRIP_ID,
      "attempt-j-6",
      [freshAllocation]
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reasonCode, "conflicting_existing_allocation");
    }
  });
});

// ---------------------------------------------------------------------
// Checkpoint 5B.4B.1, Section L: AUTOMATIC_MIGRATION_HISTORY_LIMIT
// emulator behavior - real documents, real count() queries, never the
// pure classifier alone. The limit itself is never changed for this.
// ---------------------------------------------------------------------

describe("AUTOMATIC_MIGRATION_HISTORY_LIMIT - emulator behavior (Section L)", () => {
  async function seedManyContributions(count: number): Promise<void> {
    const collection = db.collection("savingsTransactions");
    let batch = db.batch();
    let opsInBatch = 0;
    for (let i = 0; i < count; i++) {
      batch.set(collection.doc(`tx-bulk-${i}`), {
        resourceType: "trip",
        resourceId: TRIP_ID,
        memberUid: "daniel",
        type: "contribution",
        amountMinor: 1,
        currency: "USD",
        createdAt: Timestamp.fromMillis(1000 + i),
        reversalOf: null,
      });
      opsInBatch++;
      if (opsInBatch === 450) {
        await batch.commit();
        batch = db.batch();
        opsInBatch = 0;
      }
    }
    if (opsInBatch > 0) {
      await batch.commit();
    }
  }

  it("accepts a Trip with exactly AUTOMATIC_MIGRATION_HISTORY_LIMIT history documents", async () => {
    await seedTrip({
      ledgerOpeningBalanceMinor: 0,
      ledgerBalanceMinor: AUTOMATIC_MIGRATION_HISTORY_LIMIT,
    });
    await seedManyContributions(AUTOMATIC_MIGRATION_HISTORY_LIMIT);

    const result = await runDryRun(db, TRIP_ID);
    assert.equal(result.verdict, "safe_to_migrate");
    assert.equal(
      result.historyCounts?.totalHistoryDocumentCount,
      AUTOMATIC_MIGRATION_HISTORY_LIMIT
    );
  });

  it("over-limit dry run requires manual review with zero writes of any kind", async () => {
    const overLimit = AUTOMATIC_MIGRATION_HISTORY_LIMIT + 1;
    await seedTrip({
      ledgerOpeningBalanceMinor: 0,
      ledgerBalanceMinor: overLimit,
    });
    await seedManyContributions(overLimit);

    const result = await runDryRun(db, TRIP_ID);
    assert.equal(result.verdict, "requires_manual_review");
    assert.equal(
      result.anomalies[0].reasonCode,
      "history_exceeds_automatic_migration_limit"
    );

    const msSnap = await db
      .collection("tripOwnershipMigrationState")
      .doc(TRIP_ID)
      .get();
    assert.equal(msSnap.exists, false);
    const ownershipSnap = await db
      .collection("tripMemberOwnership")
      .where("tripId", "==", TRIP_ID)
      .get();
    assert.equal(ownershipSnap.size, 0);
    const allocationSnap = await db
      .collection("tripOwnershipAllocations")
      .where("tripId", "==", TRIP_ID)
      .get();
    assert.equal(allocationSnap.size, 0);
    const tripData = (await db.collection("trips").doc(TRIP_ID).get()).data();
    assert.equal(tripData?.ownershipModelState, undefined);
  });

  it("over-limit apply refuses BEFORE lock acquisition - Trip remains legacy, no migration-state document", async () => {
    const overLimit = AUTOMATIC_MIGRATION_HISTORY_LIMIT + 1;
    await seedTrip({
      ledgerOpeningBalanceMinor: 0,
      ledgerBalanceMinor: overLimit,
    });
    await seedManyContributions(overLimit);

    const result = await runApply(db, TRIP_ID);
    assert.equal(
      result.anomalies[0].reasonCode,
      "history_exceeds_automatic_migration_limit"
    );

    const tripData = (await db.collection("trips").doc(TRIP_ID).get()).data();
    assert.equal(tripData?.ownershipModelState, undefined);
    const msSnap = await db
      .collection("tripOwnershipMigrationState")
      .doc(TRIP_ID)
      .get();
    assert.equal(msSnap.exists, false);
    const ownershipSnap = await db
      .collection("tripMemberOwnership")
      .where("tripId", "==", TRIP_ID)
      .get();
    assert.equal(ownershipSnap.size, 0);
    const allocationSnap = await db
      .collection("tripOwnershipAllocations")
      .where("tripId", "==", TRIP_ID)
      .get();
    assert.equal(allocationSnap.size, 0);
  });
});

// ---------------------------------------------------------------------
// CLI execution-target guard (§2/§24) - pure, no Firestore
// ---------------------------------------------------------------------

describe("resolveExecutionTarget", () => {
  it("is always safe against the emulator, with no extra flags", () => {
    const result = resolveExecutionTarget({
      emulatorHost: "localhost:8080",
      tripId: "trip-1",
      mode: "apply",
      projectFlag: undefined,
      confirmFlag: undefined,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.mode, "emulator");
    }
  });

  it("refuses production without an exact --project match", () => {
    const result = resolveExecutionTarget({
      emulatorHost: undefined,
      tripId: "trip-1",
      mode: "dry_run",
      projectFlag: "some-other-project",
      confirmFlag: undefined,
    });
    assert.equal(result.ok, false);
  });

  it("refuses production without FIRESTORE_EMULATOR_HOST even with a correct --project", () => {
    const result = resolveExecutionTarget({
      emulatorHost: undefined,
      tripId: "trip-1",
      mode: "dry_run",
      projectFlag: undefined,
      confirmFlag: undefined,
    });
    assert.equal(result.ok, false);
  });

  it("allows a production dry run with the exact project id and no confirm flag", () => {
    const result = resolveExecutionTarget({
      emulatorHost: undefined,
      tripId: "trip-1",
      mode: "dry_run",
      projectFlag: PRODUCTION_PROJECT_ID,
      confirmFlag: undefined,
    });
    assert.equal(result.ok, true);
  });

  it("refuses a production apply without a matching --confirm echo-back", () => {
    const result = resolveExecutionTarget({
      emulatorHost: undefined,
      tripId: "trip-1",
      mode: "apply",
      projectFlag: PRODUCTION_PROJECT_ID,
      confirmFlag: undefined,
    });
    assert.equal(result.ok, false);
  });

  it("refuses a production apply when --confirm does not match --trip", () => {
    const result = resolveExecutionTarget({
      emulatorHost: undefined,
      tripId: "trip-1",
      mode: "apply",
      projectFlag: PRODUCTION_PROJECT_ID,
      confirmFlag: "trip-2",
    });
    assert.equal(result.ok, false);
  });

  it("allows a production apply with an exact --confirm echo-back", () => {
    const result = resolveExecutionTarget({
      emulatorHost: undefined,
      tripId: "trip-1",
      mode: "apply",
      projectFlag: PRODUCTION_PROJECT_ID,
      confirmFlag: "trip-1",
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.mode, "production");
    }
  });
});

describe("AUTOMATIC_MIGRATION_HISTORY_LIMIT", () => {
  it("is a positive, named, centralized constant", () => {
    assert.equal(typeof AUTOMATIC_MIGRATION_HISTORY_LIMIT, "number");
    assert.ok(AUTOMATIC_MIGRATION_HISTORY_LIMIT > 0);
  });
});
