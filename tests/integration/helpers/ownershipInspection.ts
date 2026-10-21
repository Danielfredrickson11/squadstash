// Milestone 5C.4/5C.5 - trusted, Rules-bypassing financial post-condition
// inspection, plus a small set of NARROWLY-SCOPED trusted precondition
// setup helpers. Reuses the invitation suite's own
// `getTrustedInspectionEnv()`/`cleanupTrustedInspectionEnv()` from
// trustedInspection.ts directly (never duplicates the
// `initializeTestEnvironment` call or builds a second
// @firebase/rules-unit-testing environment) - trustedInspection.ts
// itself is never modified.
//
// ===========================================================================
// FROZEN SCOPE - READ BEFORE ADDING ANYTHING HERE
// ===========================================================================
// Trusted setup writes in this file are allowed ONLY to construct a
// precondition that NO public client path exists to reach locally - for
// example, an Admin-only ownership-model state transition
// ("migrating"/"needs_reconciliation"), or a deliberate, otherwise-
// unreachable aggregate/ownership drift, solely so a test can prove how
// the REAL financial callable under test reacts to that precondition.
//
// The operation BEING TESTED must always execute through the real
// production client wrapper -> real Functions Emulator. Trusted writes
// here are NEVER a substitute for:
//   - membership acceptance (always the real acceptTripInvitation call)
//   - contribution (always the real recordSavingsTransaction call)
//   - Shared Stash spending (always the real recordSharedStashExpense call)
//   - personal withdrawal (always the real recordSavingsTransaction call)
// Trusted writes are never used to fabricate the canonical healthy
// two-member financial state itself - that state is built exclusively
// through tests/integration/helpers/financialFixtures.ts's real-callable
// sequencing. This file supplies ONLY: (a) read-only post-condition
// inspection, and (b) the few explicitly-named precondition-only setup
// helpers below, each documented with exactly which otherwise-
// unreachable state it constructs and why no public path can reach it.
// ===========================================================================
import firebaseCompat from "firebase/compat/app";
import "firebase/compat/firestore";
import {getTrustedInspectionEnv} from "./trustedInspection";

/**
 * Trusted, Rules-bypassing read of a single `tripMemberOwnership` row.
 * @param {string} tripId The Trip id.
 * @param {string} uid The member uid.
 * @return {Promise<Record<string, unknown> | undefined>} The raw data,
 *   or undefined if the row does not exist.
 */
export async function inspectOwnership(
  tripId: string,
  uid: string
): Promise<Record<string, unknown> | undefined> {
  const env = await getTrustedInspectionEnv();
  let data: Record<string, unknown> | undefined;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await ctx
      .firestore()
      .collection("tripMemberOwnership")
      .doc(`${tripId}_${uid}`)
      .get();
    data = snap.data();
  });
  return data;
}

/**
 * Trusted, Rules-bypassing read of every `tripMemberOwnership` row for a
 * Trip - used to verify an exact, complete ownership set (e.g. that no
 * extra row was created), not just one member's own row.
 * @param {string} tripId The Trip id.
 * @return {Promise<Record<string, unknown>[]>} Every matching row's
 *   raw data.
 */
export async function inspectAllOwnershipRows(
  tripId: string
): Promise<Record<string, unknown>[]> {
  const env = await getTrustedInspectionEnv();
  let rows: Record<string, unknown>[] = [];
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await ctx
      .firestore()
      .collection("tripMemberOwnership")
      .where("tripId", "==", tripId)
      .get();
    rows = snap.docs.map((d) => d.data());
  });
  return rows;
}

/**
 * Milestone 5C.4+5C.5 isolation/assertion-hardening pass - a
 * deterministic, uid-sorted snapshot of ONLY the stable economic facts
 * needed to prove "zero ownership mutation" across a before/after
 * comparison: exactly `{uid, ownershipMinor}` per row, nothing else.
 * Deliberately excludes `lastUpdatedAt` and any other field whose
 * presence/serialization could vary without the economics themselves
 * changing, and sorts by uid so two snapshots taken moments apart are
 * directly comparable with a plain `toEqual`.
 * @param {string} tripId The Trip id.
 * @return {Promise<Array<{uid: string; ownershipMinor: number}>>} Every
 *   current ownership row for the Trip, sorted ascending by uid.
 */
export async function inspectOwnershipBalancesForTrip(
  tripId: string
): Promise<{uid: string; ownershipMinor: number}[]> {
  const rows = await inspectAllOwnershipRows(tripId);
  return rows
    .map((row) => ({uid: row.uid as string, ownershipMinor: row.ownershipMinor as number}))
    .sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
}

/**
 * Trusted, Rules-bypassing read of every `savingsTransactions` document
 * linked to a given Shared Stash Expense - used to prove a REJECTED
 * `recordSharedStashExpense` call created no linked withdrawal at all
 * (never derives/guesses the backend's own deterministic withdrawal-id
 * algorithm; queries the persisted linkage field directly instead).
 * @param {string} expenseId The Expense id (== the clientRequestId used
 *   for the rejected/attempted call).
 * @return {Promise<Record<string, unknown>[]>} Every matching document's
 *   raw data (empty if none exist).
 */
export async function findSavingsTransactionsLinkedToExpense(
  expenseId: string
): Promise<Record<string, unknown>[]> {
  const env = await getTrustedInspectionEnv();
  let rows: Record<string, unknown>[] = [];
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await ctx
      .firestore()
      .collection("savingsTransactions")
      .where("linkedExpenseId", "==", expenseId)
      .get();
    rows = snap.docs.map((d) => d.data());
  });
  return rows;
}

/**
 * Trusted, Rules-bypassing read of every `tripOwnershipAllocations`
 * record linked to a given Shared Stash Expense - used to prove a
 * REJECTED `recordSharedStashExpense` call created no allocation record
 * at all.
 * @param {string} expenseId The Expense id (== the clientRequestId used
 *   for the rejected/attempted call).
 * @return {Promise<Record<string, unknown>[]>} Every matching document's
 *   raw data (empty if none exist).
 */
export async function findOwnershipAllocationsForExpense(
  expenseId: string
): Promise<Record<string, unknown>[]> {
  const env = await getTrustedInspectionEnv();
  let rows: Record<string, unknown>[] = [];
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await ctx
      .firestore()
      .collection("tripOwnershipAllocations")
      .where("expenseId", "==", expenseId)
      .get();
    rows = snap.docs.map((d) => d.data());
  });
  return rows;
}

/**
 * Trusted, Rules-bypassing read of a single `tripOwnershipAllocations`
 * record (the immutable companion audit/allocation record a successful
 * Shared Stash Expense creates).
 * @param {string} allocationId The record's id (the originating
 *   withdrawal transaction's id).
 * @return {Promise<Record<string, unknown> | undefined>} The raw data,
 *   or undefined if it does not exist.
 */
export async function inspectAllocation(
  allocationId: string
): Promise<Record<string, unknown> | undefined> {
  const env = await getTrustedInspectionEnv();
  let data: Record<string, unknown> | undefined;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await ctx
      .firestore()
      .collection("tripOwnershipAllocations")
      .doc(allocationId)
      .get();
    data = snap.data();
  });
  return data;
}

/**
 * Trusted, Rules-bypassing read of a single `tripExpenses` document.
 * @param {string} expenseId The Expense id.
 * @return {Promise<Record<string, unknown> | undefined>} The raw data,
 *   or undefined if it does not exist.
 */
export async function inspectExpense(
  expenseId: string
): Promise<Record<string, unknown> | undefined> {
  const env = await getTrustedInspectionEnv();
  let data: Record<string, unknown> | undefined;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await ctx.firestore().collection("tripExpenses").doc(expenseId).get();
    data = snap.data();
  });
  return data;
}

/**
 * Trusted, Rules-bypassing read of a single `savingsTransactions`
 * document.
 * @param {string} transactionId The transaction id.
 * @return {Promise<Record<string, unknown> | undefined>} The raw data,
 *   or undefined if it does not exist.
 */
export async function inspectSavingsTransaction(
  transactionId: string
): Promise<Record<string, unknown> | undefined> {
  const env = await getTrustedInspectionEnv();
  let data: Record<string, unknown> | undefined;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await ctx.firestore().collection("savingsTransactions").doc(transactionId).get();
    data = snap.data();
  });
  return data;
}

/**
 * TRUSTED PRECONDITION SETUP (frozen scope - see the file header): places
 * an already-`"initialized"` Trip into `"migrating"` or
 * `"needs_reconciliation"` - states no public client path can ever
 * cause a Trip to enter (only the as-yet-unbuilt 5C.6 migration/
 * reconciliation tooling can). Used ONLY so a test can prove the real
 * financial callable under test rejects a NEW mutation while the Trip is
 * in that state - the callable itself is always what is actually
 * invoked and tested.
 *
 * `"migrating"` requires `ownershipModelVersion` to be absent (per
 * `classifyTripOwnershipModelState` - a present version on a
 * `"migrating"` Trip classifies as `"corrupt"`, a different code path
 * than the one this helper exists to exercise), so this explicitly
 * deletes that field via the compat SDK's `FieldValue.delete()`
 * sentinel - the one Firestore operation `.update()` with a plain value
 * cannot express. `"needs_reconciliation"` requires the version to
 * remain the already-set positive integer, so it is left untouched.
 * @param {string} tripId The Trip id.
 * @param {"migrating" | "needs_reconciliation"} state The target state.
 * @return {Promise<void>}
 */
export async function setTripOwnershipModelState(
  tripId: string,
  state: "migrating" | "needs_reconciliation"
): Promise<void> {
  const env = await getTrustedInspectionEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const update: Record<string, unknown> = {ownershipModelState: state};
    if (state === "migrating") {
      update.ownershipModelVersion = firebaseCompat.firestore.FieldValue.delete();
    }
    await ctx.firestore().collection("trips").doc(tripId).update(update);
  });
}

/**
 * TRUSTED PRECONDITION SETUP (frozen scope - see the file header): sets
 * `archivedAt` on a Trip. No public client path exists in this
 * integration suite to archive a Trip, so this is the only way to reach
 * the precondition the archive-related 5C.4/5C.5 tests need - the
 * financial operation under test (a new Shared Stash Expense, or a
 * personal withdrawal) is always then invoked through the real callable.
 * @param {string} tripId The Trip id.
 * @return {Promise<void>}
 */
export async function setTripArchived(tripId: string): Promise<void> {
  const env = await getTrustedInspectionEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx
      .firestore()
      .collection("trips")
      .doc(tripId)
      .update({archivedAt: firebaseCompat.firestore.FieldValue.serverTimestamp()});
  });
}

/**
 * TRUSTED PRECONDITION SETUP (frozen scope - see the file header, and
 * the frozen preflight §12/§27) - used ONLY by 5C.4's existing-drift-
 * detection test, NEVER by any 5C.5 scenario. Directly overwrites a
 * Trip's `ledgerBalanceMinor` to a value inconsistent with the true sum
 * of its real `tripMemberOwnership` rows - no public client path can
 * ever desynchronize these two values, since every real contribution/
 * withdrawal/Shared-Stash-Expense call updates both atomically in the
 * same transaction. This exists solely to prove
 * `recordSharedStashExpense`'s OWN already-implemented drift detection
 * (it independently re-verifies `aggregate == sum(ownership)` before
 * depleting, and fails the Trip into `"needs_reconciliation"` if they
 * disagree) - the callable itself is always what is actually invoked
 * and tested; this helper only constructs the otherwise-unreachable
 * drifted precondition beforehand.
 * @param {string} tripId The Trip id.
 * @param {number} ledgerBalanceMinor The (deliberately inconsistent)
 *   aggregate value to write.
 * @return {Promise<void>}
 */
export async function setTripLedgerBalanceDrift(
  tripId: string,
  ledgerBalanceMinor: number
): Promise<void> {
  const env = await getTrustedInspectionEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().collection("trips").doc(tripId).update({ledgerBalanceMinor});
  });
}
