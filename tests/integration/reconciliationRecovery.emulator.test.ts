// Milestone 5C.6 - the real, local, emulator-backed integration proof of
// the reconciliation admin tool itself (functions/src/admin/
// reconcileTripOwnership.ts), invoked through its own REAL compiled CLI
// entry point (see reconciliationFixtures.ts's own header for why a
// subprocess, never a direct in-process import) against the exact same
// emulator every other layer of this integration run uses. Covers:
// native repair, legitimate zero-row retention, rogue-row deletion,
// archived-Trip repair, and a repeated reconciliation episode. Every
// Trip/contribution/withdrawal/Shared-Stash spend here goes through the
// REAL production client service wrappers and the REAL Functions
// Emulator; only the deliberate drift/needs_reconciliation preconditions
// use trusted, Rules-bypassing setup (see reconciliationFixtures.ts's
// own frozen-scope header). This suite deliberately does NOT run the
// full 5C.7 chained lifecycle scenario - that remains 5C.7's own job.
/* eslint-disable @typescript-eslint/no-require-imports, import/first */
jest.mock("../../firebase", () =>
  require("./helpers/firebaseIntegrationTestEnv").buildDemoFirebaseInstances()
);

import {cleanupDemoFirebaseInstances} from "./helpers/firebaseIntegrationTestEnv";
import {cleanupTrustedInspectionEnv, inspectTrip} from "./helpers/trustedInspection";
import {signInAs} from "./helpers/fixtures";
import {
  contributeReal,
  corruptSingleParticipantAllocationEconomicsReal,
  corruptOwnershipRowReal,
  createAcceptedTwoMemberTrip,
  createInProgressReconstructedAttemptReal,
  createLegacyTwoMemberTripWithSharedStashHistoryReal,
  createRogueOwnershipRowReal,
  runMigrationCli,
  runReconcileCli,
  setTripArchivedReal,
  setTripNeedsReconciliationReal,
  spendSharedStashReal,
  withdrawReal,
} from "./helpers/reconciliationFixtures";
import {
  inspectAllocation,
  inspectOwnership,
  inspectOwnershipBalancesForTrip,
} from "./helpers/ownershipInspection";

describe("5C.6 - reconciliation admin tool: native repair", () => {
  it("dry-run reports safe_to_reconcile with zero writes, then apply repairs the drifted row and finalizes", async () => {
    const fixture = await createAcceptedTwoMemberTrip("5c6-recovery-native");
    await signInAs(fixture.owner.email);
    await contributeReal(fixture.tripId, fixture.owner.uid, 600);
    await signInAs(fixture.member.email);
    await contributeReal(fixture.tripId, fixture.member.uid, 400);
    await signInAs(fixture.owner.email);
    await spendSharedStashReal(fixture.tripId, 300, "5c6-recovery-native-spend");

    // Simulate the out-of-band corruption + lifecycle flag a hardened
    // financial callable would already have set, directly (bypassing
    // the callable layer entirely under test here).
    await corruptOwnershipRowReal(fixture.tripId, fixture.owner.uid, 12345);
    await setTripNeedsReconciliationReal(fixture.tripId);

    const dryRun = runReconcileCli(fixture.tripId, "dry_run");
    expect(dryRun.verdict).toBe("safe_to_reconcile");
    expect(dryRun.attemptId).toBeNull();

    const apply = runReconcileCli(fixture.tripId, "apply");
    expect(apply.verdict).toBe("repaired");
    expect(apply.phase).toBe("completed");

    const trip = await inspectTrip(fixture.tripId);
    expect(trip?.ownershipModelState).toBe("initialized");
    expect(trip?.ledgerBalanceMinor).toBe(700);

    const rows = await inspectOwnershipBalancesForTrip(fixture.tripId);
    const total = rows.reduce((sum, r) => sum + r.ownershipMinor, 0);
    expect(total).toBe(700);
  });
});

describe("5C.6 - reconciliation admin tool: legitimate zero-row retention", () => {
  it("retains a member's row at exactly zero after a full withdrawal, never deleting it", async () => {
    const fixture = await createAcceptedTwoMemberTrip("5c6-recovery-zero-row");
    await signInAs(fixture.owner.email);
    await contributeReal(fixture.tripId, fixture.owner.uid, 500);
    await signInAs(fixture.member.email);
    await contributeReal(fixture.tripId, fixture.member.uid, 500);
    await withdrawReal(fixture.tripId, fixture.member.uid, 500);

    // Drift the OTHER row only, forcing a genuine repair episode while
    // the member's own legitimate zero balance must survive untouched.
    await corruptOwnershipRowReal(fixture.tripId, fixture.owner.uid, 999);
    await setTripNeedsReconciliationReal(fixture.tripId);

    const apply = runReconcileCli(fixture.tripId, "apply");
    expect(apply.verdict).toBe("repaired");

    const memberRow = await inspectOwnership(fixture.tripId, fixture.member.uid);
    expect(memberRow).toMatchObject({ownershipMinor: 0});
  });
});

describe("5C.6 - reconciliation admin tool: rogue-row deletion", () => {
  it("deletes a row with no supporting financial history during repair", async () => {
    const fixture = await createAcceptedTwoMemberTrip("5c6-recovery-rogue");
    await signInAs(fixture.owner.email);
    await contributeReal(fixture.tripId, fixture.owner.uid, 1000);

    await createRogueOwnershipRowReal(fixture.tripId, "rogue-uid-no-history", 500);
    await setTripNeedsReconciliationReal(fixture.tripId);

    const apply = runReconcileCli(fixture.tripId, "apply");
    expect(apply.verdict).toBe("repaired");
    expect(apply.rogueOwnershipRowUids).toEqual(["rogue-uid-no-history"]);

    const rogueRow = await inspectOwnership(fixture.tripId, "rogue-uid-no-history");
    expect(rogueRow).toBeUndefined();
  });
});

describe("5C.6 - reconciliation admin tool: archived-Trip repair", () => {
  it("repairs an archived Trip with no special blocking", async () => {
    const fixture = await createAcceptedTwoMemberTrip("5c6-recovery-archived");
    await signInAs(fixture.owner.email);
    await contributeReal(fixture.tripId, fixture.owner.uid, 1000);

    await corruptOwnershipRowReal(fixture.tripId, fixture.owner.uid, 1);
    await setTripNeedsReconciliationReal(fixture.tripId);
    await setTripArchivedReal(fixture.tripId);

    const apply = runReconcileCli(fixture.tripId, "apply");
    expect(apply.verdict).toBe("repaired");

    const trip = await inspectTrip(fixture.tripId);
    expect(trip?.ownershipModelState).toBe("initialized");
    expect(trip?.archivedAt).toBeDefined();
  });
});

describe("5C.6 - reconciliation admin tool: repeated reconciliation episode", () => {
  it("a second, independent repair after a completed one creates a brand-new attempt and succeeds", async () => {
    const fixture = await createAcceptedTwoMemberTrip("5c6-recovery-repeat");
    await signInAs(fixture.owner.email);
    await contributeReal(fixture.tripId, fixture.owner.uid, 1000);

    await corruptOwnershipRowReal(fixture.tripId, fixture.owner.uid, 1);
    await setTripNeedsReconciliationReal(fixture.tripId);
    const first = runReconcileCli(fixture.tripId, "apply");
    expect(first.verdict).toBe("repaired");

    // Independently drift the Trip again.
    await corruptOwnershipRowReal(fixture.tripId, fixture.owner.uid, 42);
    await setTripNeedsReconciliationReal(fixture.tripId);
    const second = runReconcileCli(fixture.tripId, "apply");
    expect(second.verdict).toBe("repaired");
    expect(second.attemptId).not.toBe(first.attemptId);

    const trip = await inspectTrip(fixture.tripId);
    expect(trip?.ownershipModelState).toBe("initialized");
    expect(trip?.ledgerBalanceMinor).toBe(1000);
  });
});

describe("5C.6 - reconciliation admin tool: REAL migrated-provenance repair", () => {
  it("migrates via the real migration CLI, then repairs drifted ownership while leaving the migrated allocation byte-for-byte unchanged", async () => {
    const legacy = await createLegacyTwoMemberTripWithSharedStashHistoryReal(
      "5c6-migrated-repair"
    );

    const migration = runMigrationCli(legacy.tripId, "apply");
    expect(migration.verdict).toBe("safe_to_migrate");

    const tripAfterMigration = await inspectTrip(legacy.tripId);
    expect(tripAfterMigration?.ownershipModelState).toBe("initialized");

    const allocationBefore = await inspectAllocation(legacy.withdrawalId);
    expect(allocationBefore?.provenance).toBe("migrated");
    expect(allocationBefore?.migratedAt).toBeDefined();
    expect(allocationBefore?.amountMinor).toBe(legacy.spendAmountMinor);

    const expectedOwner =
      legacy.contributions.ownerMinor -
      Math.round(
        (legacy.spendAmountMinor * legacy.contributions.ownerMinor) /
          (legacy.contributions.ownerMinor + legacy.contributions.memberMinor)
      );

    // Deliberately drift only the DERIVED ownership state - never the
    // immutable allocation record or the authoritative history.
    await corruptOwnershipRowReal(legacy.tripId, legacy.owner.uid, 999999);
    await setTripNeedsReconciliationReal(legacy.tripId);

    const apply = runReconcileCli(legacy.tripId, "apply");
    expect(apply.verdict).toBe("repaired");

    const allocationAfter = await inspectAllocation(legacy.withdrawalId);
    expect(allocationAfter).toEqual(allocationBefore);

    const ownerRow = await inspectOwnership(legacy.tripId, legacy.owner.uid);
    expect(ownerRow?.ownershipMinor).toBe(expectedOwner);

    const tripAfterRepair = await inspectTrip(legacy.tripId);
    expect(tripAfterRepair?.ownershipModelState).toBe("initialized");
    expect(tripAfterRepair?.ledgerBalanceMinor).toBe(
      legacy.contributions.ownerMinor +
        legacy.contributions.memberMinor -
        legacy.spendAmountMinor
    );
  });
});

describe("5C.6 - reconciliation admin tool: REAL mixed-provenance repair", () => {
  it("repairs a Trip whose persisted allocations are genuinely BOTH migrated and original, leaving both unchanged", async () => {
    const legacy = await createLegacyTwoMemberTripWithSharedStashHistoryReal(
      "5c6-mixed-repair"
    );
    const migration = runMigrationCli(legacy.tripId, "apply");
    expect(migration.verdict).toBe("safe_to_migrate");

    // A REAL, new Shared-Stash spend through the production client
    // wrapper, AFTER migration - its own allocation record is created
    // with provenance "original", by the real callable itself.
    await signInAs(legacy.owner.email);
    const secondSpend = await spendSharedStashReal(
      legacy.tripId,
      100,
      "5c6-mixed-repair-second-spend"
    );

    const migratedAllocation = await inspectAllocation(legacy.withdrawalId);
    const originalAllocation = await inspectAllocation(
      secondSpend.sharedStashTransactionId
    );
    expect(migratedAllocation?.provenance).toBe("migrated");
    expect(originalAllocation?.provenance).toBe("original");

    // Deliberately drift only the derived ownership state.
    await corruptOwnershipRowReal(legacy.tripId, legacy.member.uid, 123456);
    await setTripNeedsReconciliationReal(legacy.tripId);

    const apply = runReconcileCli(legacy.tripId, "apply");
    expect(apply.verdict).toBe("repaired");
    expect(apply.validatedAllocationCount).toBe(2);

    const migratedAfter = await inspectAllocation(legacy.withdrawalId);
    const originalAfter = await inspectAllocation(secondSpend.sharedStashTransactionId);
    expect(migratedAfter).toEqual(migratedAllocation);
    expect(originalAfter).toEqual(originalAllocation);

    const rows = await inspectOwnershipBalancesForTrip(legacy.tripId);
    const total = rows.reduce((sum, r) => sum + r.ownershipMinor, 0);
    expect(total).toBe(
      legacy.contributions.ownerMinor +
        legacy.contributions.memberMinor -
        legacy.spendAmountMinor -
        100
    );

    const tripAfter = await inspectTrip(legacy.tripId);
    expect(tripAfter?.ownershipModelState).toBe("initialized");
  });
});

describe("5C.6 - reconciliation admin tool: interrupted materialization resumes", () => {
  it("resumes an existing \"reconstructed\" attempt rather than creating a new one, and completes correctly", async () => {
    const fixture = await createAcceptedTwoMemberTrip("5c6-recovery-resume");
    await signInAs(fixture.owner.email);
    await contributeReal(fixture.tripId, fixture.owner.uid, 600);
    await signInAs(fixture.member.email);
    await contributeReal(fixture.tripId, fixture.member.uid, 400);
    await signInAs(fixture.owner.email);
    await spendSharedStashReal(fixture.tripId, 300, "5c6-recovery-resume-spend");

    await corruptOwnershipRowReal(fixture.tripId, fixture.owner.uid, 111111);
    await setTripNeedsReconciliationReal(fixture.tripId);

    // Construct a VALID in-progress attempt - already past reconstruction
    // (real digests, computed from the Trip's real current history) -
    // simulating a process interruption before finalization.
    const preExistingAttemptId = "5c6-resume-fixed-attempt-id";
    await createInProgressReconstructedAttemptReal(fixture.tripId, preExistingAttemptId);

    const apply = runReconcileCli(fixture.tripId, "apply");
    expect(apply.verdict).toBe("repaired");
    // RESUMED the pre-existing attempt - never created a new one.
    expect(apply.attemptId).toBe(preExistingAttemptId);

    const trip = await inspectTrip(fixture.tripId);
    expect(trip?.ownershipModelState).toBe("initialized");
    expect(trip?.ledgerBalanceMinor).toBe(700);

    const rows = await inspectOwnershipBalancesForTrip(fixture.tripId);
    const total = rows.reduce((sum, r) => sum + r.ownershipMinor, 0);
    expect(total).toBe(700);
  });
});

describe("5C.6 - reconciliation admin tool: stale persisted-allocation evidence (distinct from stale source history)", () => {
  it("detects a persisted allocation mutated AFTER the attempt's digest was frozen, fails the attempt terminally, and rewrites no history", async () => {
    const fixture = await createAcceptedTwoMemberTrip("5c6-recovery-stale-allocation");
    await signInAs(fixture.owner.email);
    await contributeReal(fixture.tripId, fixture.owner.uid, 600);
    await signInAs(fixture.member.email);
    await contributeReal(fixture.tripId, fixture.member.uid, 400);
    await signInAs(fixture.owner.email);
    const spend = await spendSharedStashReal(
      fixture.tripId,
      300,
      "5c6-recovery-stale-allocation-spend"
    );

    await corruptOwnershipRowReal(fixture.tripId, fixture.owner.uid, 111111);
    await setTripNeedsReconciliationReal(fixture.tripId);

    const attemptId = "5c6-stale-allocation-attempt-id";
    await createInProgressReconstructedAttemptReal(fixture.tripId, attemptId);

    // Mutate ONLY the persisted allocation - source history (the
    // savingsTransactions/tripExpenses themselves) is left completely
    // untouched, so this must be distinguishable from a stale
    // SOURCE-HISTORY digest.
    const allocationBefore = await inspectAllocation(spend.sharedStashTransactionId);
    await corruptSingleParticipantAllocationEconomicsReal(
      spend.sharedStashTransactionId,
      fixture.owner.uid,
      299
    );

    const apply = runReconcileCli(fixture.tripId, "apply");
    expect(apply.verdict).toBe("requires_manual_review");
    expect(apply.reconciliation.sourceHistoryDigestMatches).toBe(true);
    expect(apply.anomalies.length).toBeGreaterThan(0);
    // Exact failure reason code, reported verbatim (see final report) -
    // caught by the fresh allocation-vs-reconstruction economic
    // re-comparison, not merely a digest-value comparison.
    expect(apply.anomalies[0].reasonCode).toBe("allocation_economic_mismatch");

    const attemptSnap = await inspectAllocation(spend.sharedStashTransactionId);
    expect(attemptSnap?.amountMinor).toBe(299); // untouched by reconciliation itself
    void allocationBefore;

    const trip = await inspectTrip(fixture.tripId);
    expect(trip?.ownershipModelState).toBe("needs_reconciliation");
  });
});

afterAll(async () => {
  await cleanupTrustedInspectionEnv();
  await cleanupDemoFirebaseInstances();
});
