// Milestone 5C.6 - shared fixture-building/corruption-only helpers for
// the reversal/reconciliation hardening integration suite. Per the
// frozen docs/audits/
// MULTI_MEMBER_REVERSAL_RECONCILIATION_PREFLIGHT_2026-10-20.md: this
// file is the DELIBERATE corruption/reconciliation-setup boundary,
// deliberately kept SEPARATE from financialFixtures.ts (which this file
// re-exports/reuses unchanged for every real-callable fixture-building
// step - never duplicated here). Trusted/Admin-SDK-bypassing setup is
// allowed ONLY to construct an otherwise-unreachable precondition
// (aggregate/ownership drift, a corrupted allocation record, a rogue
// ownership row, a reconciliation control/attempt state) - the operation
// UNDER TEST always still runs through the real production
// Functions/admin implementation under the emulator.
//
// `runReconcileCli` is this file's own distinctive addition: the
// reconciliation admin tool (functions/src/admin/reconcileTripOwnership.ts)
// is a trusted, Admin-SDK-only, non-exported, non-callable local script -
// it is never reachable via httpsCallable, and firebase-admin is NOT a
// root devDependency of this package (only functions/'s own
// node_modules has it - see tests/integration/helpers/trustedInspection.ts's
// own header comment for the identical, already-established reasoning).
// The only policy-compliant way for this root-level Jest suite to
// exercise the REAL admin tool is therefore to invoke its own compiled
// CLI entry point as a subprocess, exactly as an operator would from a
// terminal - reusing this SAME run's already-inherited
// FIRESTORE_EMULATOR_HOST/FIREBASE_AUTH_EMULATOR_HOST so the subprocess
// talks to the identical emulator instance every other layer of this
// integration run uses. package.json's own
// "test:multi-member-reconciliation-integration" script always runs
// `npm --prefix functions run build` immediately before this suite
// starts, so the compiled file this helper invokes is always current.
import {execFileSync} from "node:child_process";
import path from "node:path";
import firebaseCompat from "firebase/compat/app";
import "firebase/compat/firestore";
import {getTrustedInspectionEnv} from "./trustedInspection";
import {DEMO_PROJECT_ID} from "./firebaseIntegrationTestEnv";
import {createAndSignInUser} from "./fixtures";

export {
  contributeReal,
  createAcceptedTwoMemberTrip,
  spendSharedStashReal,
  withdrawReal,
} from "./financialFixtures";
export type {AcceptedTwoMemberTrip} from "./financialFixtures";

const RECONCILE_CLI_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "functions",
  "lib",
  "admin",
  "reconcileTripOwnership.js"
);

const MIGRATE_CLI_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "functions",
  "lib",
  "admin",
  "migrateTripOwnership.js"
);

/**
 * The reconciliation admin tool's own structured audit-result shape -
 * deliberately typed loosely here (this is integration-test code
 * consuming the tool's own JSON stdout, not production code) rather
 * than importing functions/'s own TypeScript types across the package
 * boundary.
 */
export type ReconcileCliResult = {
  tripId: string;
  attemptId: string | null;
  mode: "dry_run" | "apply";
  phase: string | null;
  verdict: string;
  anomalies: {reasonCode: string; detail: string}[];
  reconciliation: Record<string, boolean | null>;
  [key: string]: unknown;
};

/**
 * Invokes the REAL reconciliation admin tool's own compiled CLI entry
 * point as a subprocess, against this same run's emulator - never a
 * direct in-process import (see this file's own header for why).
 * @param {string} tripId The Trip to reconcile.
 * @param {"dry_run" | "apply"} mode The run mode.
 * @return {ReconcileCliResult} The tool's own parsed JSON stdout result.
 */
export function runReconcileCli(
  tripId: string,
  mode: "dry_run" | "apply"
): ReconcileCliResult {
  const args = [
    RECONCILE_CLI_PATH,
    "--trip",
    tripId,
    mode === "apply" ? "--apply" : "--dry-run",
    "--project",
    DEMO_PROJECT_ID,
  ];
  const stdout = execFileSync("node", args, {
    env: process.env,
    encoding: "utf8",
  });
  return JSON.parse(stdout) as ReconcileCliResult;
}

/**
 * TRUSTED PRECONDITION SETUP (frozen scope - see the file header):
 * directly deletes a member's `tripMemberOwnership` row out-of-band - no
 * public client path can ever delete this row. Used solely to construct
 * the "existing financial history, but the row vanished" drift
 * precondition the frozen preflight's existing-row hardening gates must
 * detect, or to seed a legitimate-zero-row/rogue-row fixture for the
 * reconciliation admin tool itself.
 * @param {string} tripId The Trip id.
 * @param {string} uid The member uid whose row is deleted.
 * @return {Promise<void>}
 */
export async function deleteOwnershipRowReal(
  tripId: string,
  uid: string
): Promise<void> {
  const env = await getTrustedInspectionEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx
      .firestore()
      .collection("tripMemberOwnership")
      .doc(`${tripId}_${uid}`)
      .delete();
  });
}

/**
 * TRUSTED PRECONDITION SETUP (frozen scope - see the file header):
 * directly overwrites a member's `tripMemberOwnership.ownershipMinor` -
 * no public client path can ever desynchronize this cache from the
 * Trip's own trusted aggregate. Used to construct the existing-row drift
 * precondition the hardened `recordSavingsTransaction` gates (and the
 * reconciliation admin tool's own repair behavior) must each react to.
 * @param {string} tripId The Trip id.
 * @param {string} uid The member uid.
 * @param {number} ownershipMinor The (deliberately inconsistent)
 *   balance to write.
 * @return {Promise<void>}
 */
export async function corruptOwnershipRowReal(
  tripId: string,
  uid: string,
  ownershipMinor: number
): Promise<void> {
  const env = await getTrustedInspectionEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx
      .firestore()
      .collection("tripMemberOwnership")
      .doc(`${tripId}_${uid}`)
      .update({ownershipMinor});
  });
}

/**
 * TRUSTED PRECONDITION SETUP (frozen scope - see the file header):
 * directly creates a `tripMemberOwnership` row for a uid with no
 * supporting financial history whatsoever - no public client path can
 * ever create a row this way. Used solely to construct the "rogue row"
 * precondition the reconciliation admin tool's own rogue-row-deletion
 * behavior must detect and repair.
 * @param {string} tripId The Trip id.
 * @param {string} uid The uid to give a rogue row.
 * @param {number} ownershipMinor The rogue row's own (unsupported)
 *   balance.
 * @return {Promise<void>}
 */
export async function createRogueOwnershipRowReal(
  tripId: string,
  uid: string,
  ownershipMinor: number
): Promise<void> {
  const env = await getTrustedInspectionEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx
      .firestore()
      .collection("tripMemberOwnership")
      .doc(`${tripId}_${uid}`)
      .set({
        tripId,
        uid,
        ownershipMinor,
        lastUpdatedAt: firebaseCompat.firestore.FieldValue.serverTimestamp(),
      });
  });
}

/**
 * TRUSTED PRECONDITION SETUP (frozen scope - see the file header):
 * directly transitions a Trip's `ownershipModelState` to
 * `"needs_reconciliation"`, leaving `ownershipModelVersion` untouched -
 * no public client path can ever cause this transition (only the
 * as-yet-tested 5C.6 admin tool, or an upstream financial-hardening
 * gate, ever writes it). Used to construct the precondition the
 * reconciliation admin tool's own `runApply`/`runDryRun` require.
 * @param {string} tripId The Trip id.
 * @return {Promise<void>}
 */
export async function setTripNeedsReconciliationReal(
  tripId: string
): Promise<void> {
  const env = await getTrustedInspectionEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx
      .firestore()
      .collection("trips")
      .doc(tripId)
      .update({ownershipModelState: "needs_reconciliation"});
  });
}

/**
 * TRUSTED PRECONDITION SETUP (frozen scope - see the file header):
 * directly corrupts a persisted `tripOwnershipAllocations` record's
 * `amountMinor` - no public client path can ever mutate this immutable
 * collection. Used solely to construct the "authoritative historical
 * evidence is corrupted" precondition the reversal/reconciliation
 * hardening must reject, never silently accept or repair.
 * @param {string} allocationId The allocation record's own id.
 * @param {number} amountMinor The corrupted (deliberately inconsistent)
 *   amount to write.
 * @return {Promise<void>}
 */
export async function corruptOwnershipAllocationAmountReal(
  allocationId: string,
  amountMinor: number
): Promise<void> {
  const env = await getTrustedInspectionEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx
      .firestore()
      .collection("tripOwnershipAllocations")
      .doc(allocationId)
      .update({amountMinor});
  });
}

/**
 * TRUSTED PRECONDITION SETUP (frozen scope - see the file header):
 * directly corrupts a persisted, SINGLE-PARTICIPANT `tripOwnershipAllocations`
 * record's economics - rewriting BOTH `amountMinor` AND the one
 * `allocations` entry together, so the record stays internally
 * self-consistent (entries still sum exactly to `amountMinor`) while
 * disagreeing with what the real authoritative history/replay actually
 * produced. Distinct from `corruptOwnershipAllocationAmountReal` (which
 * corrupts only the top-level field, making the record internally
 * malformed instead) - this is the narrower corruption needed to prove
 * the SEPARATE cross-document economic-mismatch detection path, not the
 * internal shape-validation path.
 * @param {string} allocationId The allocation record's own id.
 * @param {string} uid The single participant's uid.
 * @param {number} amountMinor The corrupted (deliberately inconsistent
 *   with real history) amount to write for both fields.
 * @return {Promise<void>}
 */
export async function corruptSingleParticipantAllocationEconomicsReal(
  allocationId: string,
  uid: string,
  amountMinor: number
): Promise<void> {
  const env = await getTrustedInspectionEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx
      .firestore()
      .collection("tripOwnershipAllocations")
      .doc(allocationId)
      .update({
        amountMinor,
        allocations: [{uid, amountMinor}],
      });
  });
}

/**
 * TRUSTED PRECONDITION SETUP (frozen scope - see the file header):
 * directly sets `archivedAt` on a Trip. No public client path exists in
 * this integration suite to archive a Trip - used to prove the
 * reconciliation admin tool (and both reversal callables) remain
 * archive-permissive, with no special blocking.
 * @param {string} tripId The Trip id.
 * @return {Promise<void>}
 */
export async function setTripArchivedReal(tripId: string): Promise<void> {
  const env = await getTrustedInspectionEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx
      .firestore()
      .collection("trips")
      .doc(tripId)
      .update({
        archivedAt: firebaseCompat.firestore.FieldValue.serverTimestamp(),
      });
  });
}

/**
 * The migration admin tool's own structured audit-result shape -
 * deliberately typed loosely, mirroring `ReconcileCliResult` exactly
 * (same reasoning: this is integration-test code consuming a sibling
 * trusted tool's JSON stdout, never production code).
 */
export type MigrateCliResult = {
  tripId: string;
  attemptId: string | null;
  mode: "dry_run" | "apply";
  phase: string | null;
  verdict: string;
  [key: string]: unknown;
};

/**
 * Invokes the REAL migration admin tool's own compiled CLI entry point
 * (functions/src/admin/migrateTripOwnership.ts, never modified by this
 * checkpoint) as a subprocess, against this same run's emulator -
 * mirroring `runReconcileCli`'s own reasoning exactly: firebase-admin is
 * not a root devDependency, so a subprocess invoking the already-built
 * CLI is this package's only policy-compliant way to exercise the REAL
 * migration tool.
 * @param {string} tripId The Trip to migrate.
 * @param {"dry_run" | "apply"} mode The run mode.
 * @return {MigrateCliResult} The tool's own parsed JSON stdout result.
 */
export function runMigrationCli(
  tripId: string,
  mode: "dry_run" | "apply"
): MigrateCliResult {
  const args = [
    MIGRATE_CLI_PATH,
    "--trip",
    tripId,
    mode === "apply" ? "--apply" : "--dry-run",
    "--project",
    DEMO_PROJECT_ID,
  ];
  const stdout = execFileSync("node", args, {
    env: process.env,
    encoding: "utf8",
  });
  return JSON.parse(stdout) as MigrateCliResult;
}

export type LegacyTwoMemberTripFixture = {
  tripId: string;
  owner: {email: string; uid: string};
  member: {email: string; uid: string};
  withdrawalId: string;
  expenseId: string;
  contributions: {ownerMinor: number; memberMinor: number};
  spendAmountMinor: number;
};

/**
 * TRUSTED PRECONDITION SETUP (frozen scope - see the file header, item
 * 5 of the Milestone 5C.6 verification-closure checkpoint): constructs
 * a "legacy" (pre-migration) Trip with a complete, internally-valid
 * authoritative history - two ordinary contributions plus one Shared-
 * Stash expense/withdrawal pair - entirely via trusted, Rules-bypassing
 * document writes, since NO public client path can ever produce a
 * "legacy" Trip in this codebase (the real `createTrip` callable already
 * initializes the ownership model as `"initialized"` from creation, per
 * financialFixtures.ts's own documented behavior). The Trip's
 * `ownerId`/`memberIds` and every transaction's own `memberUid` are real
 * Auth-emulator uids (freshly created here), so a later REAL Shared-
 * Stash spend by one of them (see item 6's mixed-provenance fixture)
 * remains genuinely authorized. The migration itself is never performed
 * here - the caller must separately invoke `runMigrationCli` against
 * the returned `tripId`, through the REAL, unmodified migration admin
 * tool.
 * @param {string} scenarioLabel A short, scenario-distinguishing label.
 * @return {Promise<LegacyTwoMemberTripFixture>} The fixture's resolved
 *   identities and known history facts.
 */
export async function createLegacyTwoMemberTripWithSharedStashHistoryReal(
  scenarioLabel: string
): Promise<LegacyTwoMemberTripFixture> {
  const owner = await createAndSignInUser(`${scenarioLabel}-owner`);
  const member = await createAndSignInUser(`${scenarioLabel}-member`);
  const tripId = `${scenarioLabel}-trip-${Date.now()}`;
  const withdrawalId = `${scenarioLabel}-wd-${Date.now()}`;
  const expenseId = `${scenarioLabel}-exp-${Date.now()}`;

  const ownerContribution = 600;
  const memberContribution = 400;
  const spendAmountMinor = 300;
  const contributionAt = firebaseCompat.firestore.Timestamp.fromMillis(1_700_000_000_000);
  const secondContributionAt = firebaseCompat.firestore.Timestamp.fromMillis(
    1_700_000_001_000
  );
  const spendAt = firebaseCompat.firestore.Timestamp.fromMillis(1_700_000_002_000);

  const env = await getTrustedInspectionEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const firestore = ctx.firestore();
    await firestore.collection("trips").doc(tripId).set({
      ownerId: owner.uid,
      memberIds: [owner.uid, member.uid],
      title: `5C.6 legacy fixture ${scenarioLabel}`,
      target: 1000,
      saved: 7,
      ledgerOpeningBalanceMinor: 0,
      ledgerBalanceMinor: ownerContribution + memberContribution - spendAmountMinor,
      currency: "USD",
      imageUrl: "https://example.com/5c6-legacy.jpg",
      // Deliberately NO ownershipModelState/ownershipModelVersion field
      // at all - the exact "legacy" classification the real migration
      // tool requires as its own eligibility precondition.
    });

    await firestore.collection("savingsTransactions").doc(`${tripId}-tx-1`).set({
      resourceType: "trip",
      resourceId: tripId,
      memberUid: owner.uid,
      recordedBy: owner.uid,
      type: "contribution",
      amountMinor: ownerContribution,
      currency: "USD",
      createdAt: contributionAt,
      reversalOf: null,
    });
    await firestore.collection("savingsTransactions").doc(`${tripId}-tx-2`).set({
      resourceType: "trip",
      resourceId: tripId,
      memberUid: member.uid,
      recordedBy: member.uid,
      type: "contribution",
      amountMinor: memberContribution,
      currency: "USD",
      createdAt: secondContributionAt,
      reversalOf: null,
    });

    await firestore.collection("savingsTransactions").doc(withdrawalId).set({
      resourceType: "trip",
      resourceId: tripId,
      memberUid: owner.uid,
      recordedBy: owner.uid,
      type: "withdrawal",
      amountMinor: spendAmountMinor,
      currency: "USD",
      createdAt: spendAt,
      reversalOf: null,
      linkedExpenseId: expenseId,
    });
    await firestore.collection("tripExpenses").doc(expenseId).set({
      tripId,
      paymentSource: "shared_stash",
      amountMinor: spendAmountMinor,
      currency: "USD",
      sharedStashTransactionId: withdrawalId,
      status: "active",
      createdAt: spendAt,
    });
  });

  return {
    tripId,
    owner: {email: owner.email, uid: owner.uid},
    member: {email: member.email, uid: member.uid},
    withdrawalId,
    expenseId,
    contributions: {ownerMinor: ownerContribution, memberMinor: memberContribution},
    spendAmountMinor,
  };
}

/**
 * TRUSTED PRECONDITION SETUP (frozen scope - see the file header, item
 * 7 of the Milestone 5C.6 verification-closure checkpoint): constructs
 * a VALID in-progress reconciliation attempt - Trip `needs_reconciliation`,
 * a real `tripOwnershipReconciliationControl` document with a matching
 * `activeAttemptId`, and a real `tripOwnershipReconciliationAttempts`
 * document already at phase `"reconstructed"` with digests/counts/
 * aggregate taken from an actual fresh `runReconcileCli` dry-run over
 * the Trip's REAL current history - never fabricated or guessed values.
 * This simulates a process interruption after reconstruction (and,
 * narratively, after some materialization) but before finalization -
 * resuming it is the REAL apply CLI's own job, never this helper's.
 * @param {string} tripId The Trip id, already drifted and transitioned
 *   to `needs_reconciliation` by the caller.
 * @param {string} attemptId The fixed attempt id to construct.
 * @return {Promise<void>}
 */
export async function createInProgressReconstructedAttemptReal(
  tripId: string,
  attemptId: string
): Promise<void> {
  const dryRun = runReconcileCli(tripId, "dry_run");
  if (dryRun.verdict !== "safe_to_reconcile") {
    throw new Error(
      "createInProgressReconstructedAttemptReal: dry-run was not " +
        `safe_to_reconcile (got "${dryRun.verdict}") - cannot derive real ` +
        "digests for this fixture."
    );
  }

  const env = await getTrustedInspectionEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const firestore = ctx.firestore();
    await firestore
      .collection("tripOwnershipReconciliationAttempts")
      .doc(`${tripId}_${attemptId}`)
      .set({
        tripId,
        attemptId,
        phase: "reconstructed",
        startedAt: firebaseCompat.firestore.FieldValue.serverTimestamp(),
        lockedFinancialBasis: dryRun.lockedFinancialBasis,
        sourceHistoryDigest: dryRun.sourceHistoryDigest,
        sourceHistoryDocumentCount: dryRun.sourceHistoryDocumentCount,
        validatedAllocationDigest: dryRun.validatedAllocationDigest,
        validatedAllocationCount: dryRun.validatedAllocationCount,
        expectedOwnershipDigest: dryRun.expectedOwnershipDigest,
        expectedOwnershipCount: (dryRun.expectedOwnership as unknown[]).length,
        expectedAggregateMinor: dryRun.expectedOwnershipTotalMinor,
      });
    await firestore.collection("tripOwnershipReconciliationControl").doc(tripId).set({
      tripId,
      activeAttemptId: attemptId,
      lastCompletedAttemptId: null,
      updatedAt: firebaseCompat.firestore.FieldValue.serverTimestamp(),
    });
  });
}
