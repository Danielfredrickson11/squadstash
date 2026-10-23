// Milestone 5C.7 - the real, local, emulator-backed Full Multi-Member
// End-to-End Validation lifecycle, per the frozen docs/audits/
// MULTI_MEMBER_END_TO_END_VALIDATION_PREFLIGHT_2026-10-21.md. ONE
// continuous healthy Trip lifecycle: real membership setup, real owner
// contribution, real member contribution, real pooled Shared-Stash
// spend, real member personal withdrawal, three exact-replay spot
// checks, and one final ownership-ceiling rejection. Every financial
// operation goes through the real root client service wrapper -> the
// real Functions Emulator -> the real backend callable - never a Core
// function call, never a direct financial Firestore write. The ONLY
// trusted, Rules-bypassing reads in this file are for INSPECTION
// (membership-acceptance evidence, initial allocation count) - never to
// perform or substitute for the operation under test. This scenario
// never corrupts, reconciles, reverses, or archives the central Trip -
// those properties are each already separately proven by 5C.6/5C.5's
// own suites (see the preflight's §15-§17).
/* eslint-disable @typescript-eslint/no-require-imports, import/first */
jest.mock("../../firebase", () =>
  require("./helpers/firebaseIntegrationTestEnv").buildDemoFirebaseInstances()
);

import {cleanupDemoFirebaseInstances} from "./helpers/firebaseIntegrationTestEnv";
import {
  cleanupTrustedInspectionEnv,
  getTrustedInspectionEnv,
  inspectTrip,
} from "./helpers/trustedInspection";
import {expectCallableErrorCode} from "./helpers/assertions";
import {createAcceptedTwoMemberTrip} from "./helpers/financialFixtures";
import {signInAs} from "./helpers/fixtures";
import {
  findOwnershipAllocationsForExpense,
  findSavingsTransactionsLinkedToExpense,
  inspectAllocation,
  inspectExpense,
  inspectOwnership,
  inspectOwnershipBalancesForTrip,
  inspectSavingsTransaction,
} from "./helpers/ownershipInspection";
import {
  fetchExpenseSplitsForExpense,
  generateExpenseClientRequestId,
  recordSharedStashExpense,
} from "../../src/services/firebase/expenses";
import {
  generateSavingsClientRequestId,
  recordSavingsTransaction,
} from "../../src/services/firebase/savingsTransactions";

// ---------------------------------------------------------------------
// LOCAL, READ-ONLY HELPERS - kept local to this one file, per the
// frozen preflight §19. Neither trustedInspection.ts nor
// ownershipInspection.ts is modified.
// ---------------------------------------------------------------------

/**
 * LOCAL helper (frozen preflight §10): trusted, Rules-bypassing read of
 * every `tripMembershipAcceptances` document for a given (tripId, uid)
 * pair - used only to prove the real acceptance evidence persisted
 * correctly, never to perform or substitute for acceptance itself.
 */
async function findAcceptanceFor(
  tripId: string,
  uid: string
): Promise<Record<string, unknown>[]> {
  const env = await getTrustedInspectionEnv();
  let docs: Record<string, unknown>[] = [];
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await ctx
      .firestore()
      .collection("tripMembershipAcceptances")
      .where("tripId", "==", tripId)
      .where("uid", "==", uid)
      .get();
    docs = snap.docs.map((d) => d.data());
  });
  return docs;
}

/**
 * LOCAL helper (frozen preflight §6): trusted, Rules-bypassing count of
 * every `tripOwnershipAllocations` record for a Trip - used only for
 * the zero-initial-allocation check and the post-replay exactly-one
 * check, never to perform or substitute for the Shared-Stash spend
 * itself.
 */
async function countAllocationsForTrip(tripId: string): Promise<number> {
  const env = await getTrustedInspectionEnv();
  let size = 0;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await ctx
      .firestore()
      .collection("tripOwnershipAllocations")
      .where("tripId", "==", tripId)
      .get();
    size = snap.size;
  });
  return size;
}

type InvariantSnapshot = {
  ledgerBalanceMinor: unknown;
  saved: unknown;
  ownershipModelState: unknown;
  ownershipModelVersion: unknown;
  ownership: {uid: string; ownershipMinor: number}[];
};

/**
 * LOCAL helper (frozen preflight §11), mirroring
 * ownershipWithdrawal.emulator.test.ts's own already-committed
 * `captureFinancialSnapshot` idiom exactly. Deliberately excludes every
 * volatile timestamp field, so two snapshots taken moments apart (e.g.
 * immediately before/after a replay) are directly comparable with a
 * plain `toEqual`.
 */
async function captureInvariantSnapshot(tripId: string): Promise<InvariantSnapshot> {
  const trip = await inspectTrip(tripId);
  const ownership = await inspectOwnershipBalancesForTrip(tripId);
  return {
    ledgerBalanceMinor: trip?.ledgerBalanceMinor,
    saved: trip?.saved,
    ownershipModelState: trip?.ownershipModelState,
    ownershipModelVersion: trip?.ownershipModelVersion,
    ownership,
  };
}

/**
 * LOCAL helper (frozen preflight §11): the running invariant check,
 * run after every healthy-state checkpoint.
 */
function assertHealthyInvariant(snapshot: InvariantSnapshot): void {
  expect(snapshot.ownershipModelState).toBe("initialized");
  expect(snapshot.ownershipModelVersion).toBe(1);
  let sum = 0;
  for (const row of snapshot.ownership) {
    expect(Number.isSafeInteger(row.ownershipMinor)).toBe(true);
    expect(row.ownershipMinor).toBeGreaterThanOrEqual(0);
    sum += row.ownershipMinor;
  }
  expect(sum).toBe(snapshot.ledgerBalanceMinor);
}

describe("5C.7 - full multi-member end-to-end lifecycle", () => {
  it("one continuous healthy Trip lifecycle: membership -> contributions -> pooled spend -> withdrawal -> final rejection", async () => {
    // -----------------------------------------------------------------
    // A/B. Real membership setup (frozen preflight §5/§8) - reused
    // unchanged from financialFixtures.ts. contributeReal/withdrawReal/
    // spendSharedStashReal are deliberately NOT used anywhere in this
    // file - every financial operation below calls the real client
    // wrapper directly with an explicitly generated, retained request
    // id (frozen preflight §7-§9).
    // -----------------------------------------------------------------
    const fixture = await createAcceptedTwoMemberTrip("5c7-lifecycle");

    // Trip.memberIds contains member.uid exactly once.
    const tripAfterAcceptance = await inspectTrip(fixture.tripId);
    const memberIdsAfterAcceptance = tripAfterAcceptance?.memberIds as string[];
    expect(
      memberIdsAfterAcceptance.filter((uid) => uid === fixture.member.uid).length
    ).toBe(1);

    // Neither member has any tripMemberOwnership row yet.
    expect(await inspectOwnership(fixture.tripId, fixture.member.uid)).toBeUndefined();
    expect(await inspectOwnership(fixture.tripId, fixture.owner.uid)).toBeUndefined();

    // Membership-acceptance evidence, made executable via the LOCAL
    // query helper (frozen preflight §10) - exactly one result.
    const acceptances = await findAcceptanceFor(fixture.tripId, fixture.member.uid);
    expect(acceptances.length).toBe(1);
    const acceptance = acceptances[0];
    expect(acceptance.tripId).toBe(fixture.tripId);
    expect(acceptance.uid).toBe(fixture.member.uid);
    expect(acceptance.termsDocId).toBe(fixture.termsV1Id);
    expect(Number.isSafeInteger(acceptance.acceptedTermsVersion)).toBe(true);
    expect(acceptance.acceptedTermsVersion as number).toBeGreaterThan(0);
    expect(acceptance.acceptedAt).toBeDefined();

    // -----------------------------------------------------------------
    // Initial Trip-state checkpoint (frozen preflight §6).
    // -----------------------------------------------------------------
    expect(tripAfterAcceptance?.ownershipModelState).toBe("initialized");
    expect(tripAfterAcceptance?.ownershipModelVersion).toBe(1);
    expect(tripAfterAcceptance?.ledgerBalanceMinor).toBe(0);
    expect(tripAfterAcceptance?.saved).toBe(0);
    expect(await inspectOwnershipBalancesForTrip(fixture.tripId)).toEqual([]);
    expect(await countAllocationsForTrip(fixture.tripId)).toBe(0);
    assertHealthyInvariant(await captureInvariantSnapshot(fixture.tripId));

    // -----------------------------------------------------------------
    // C. Owner contribution - 7000 (frozen preflight §7).
    // -----------------------------------------------------------------
    await signInAs(fixture.owner.email);
    const ownerContributionRequestId = generateSavingsClientRequestId();
    const ownerContributionRequest = {
      resourceType: "trip" as const,
      resourceId: fixture.tripId,
      memberUid: fixture.owner.uid,
      type: "contribution" as const,
      amountMinor: 7000,
      currency: "USD" as const,
      clientRequestId: ownerContributionRequestId,
    };
    const ownerContributionResult = await recordSavingsTransaction(
      ownerContributionRequest
    );
    expect(ownerContributionResult.transactionId).toBe(ownerContributionRequestId);

    expect(await inspectOwnership(fixture.tripId, fixture.owner.uid)).toMatchObject({
      ownershipMinor: 7000,
    });
    expect(await inspectOwnership(fixture.tripId, fixture.member.uid)).toBeUndefined();
    let trip = await inspectTrip(fixture.tripId);
    expect(trip?.ledgerBalanceMinor).toBe(7000);
    expect(trip?.saved).toBe(70);
    expect(trip?.ownershipModelState).toBe("initialized");
    expect(trip?.ownershipModelVersion).toBe(1);
    assertHealthyInvariant(await captureInvariantSnapshot(fixture.tripId));

    const ownerContributionDoc = await inspectSavingsTransaction(
      ownerContributionRequestId
    );
    expect(ownerContributionDoc).toMatchObject({
      resourceType: "trip",
      resourceId: fixture.tripId,
      memberUid: fixture.owner.uid,
      recordedBy: fixture.owner.uid,
      type: "contribution",
      amountMinor: 7000,
      currency: "USD",
    });

    // -----------------------------------------------------------------
    // Owner contribution EXACT REPLAY (frozen preflight §13).
    // -----------------------------------------------------------------
    const beforeOwnerReplay = await captureInvariantSnapshot(fixture.tripId);
    const ownerContributionReplay = await recordSavingsTransaction(
      ownerContributionRequest
    );
    expect(ownerContributionReplay).toEqual(ownerContributionResult);
    const afterOwnerReplay = await captureInvariantSnapshot(fixture.tripId);
    expect(afterOwnerReplay).toEqual(beforeOwnerReplay);
    expect(await inspectSavingsTransaction(ownerContributionRequestId)).toEqual(
      ownerContributionDoc
    );

    // -----------------------------------------------------------------
    // D. Member contribution - 3000 (frozen preflight §7). No separate
    // replay of the member contribution is required by the frozen 5C.7
    // idempotency scope.
    // -----------------------------------------------------------------
    await signInAs(fixture.member.email);
    const memberContributionRequestId = generateSavingsClientRequestId();
    const memberContributionRequest = {
      resourceType: "trip" as const,
      resourceId: fixture.tripId,
      memberUid: fixture.member.uid,
      type: "contribution" as const,
      amountMinor: 3000,
      currency: "USD" as const,
      clientRequestId: memberContributionRequestId,
    };
    const memberContributionResult = await recordSavingsTransaction(
      memberContributionRequest
    );
    expect(memberContributionResult.transactionId).toBe(memberContributionRequestId);

    // -----------------------------------------------------------------
    // E. Ownership/aggregate checkpoint: 7000/3000/10000.
    // -----------------------------------------------------------------
    expect(await inspectOwnership(fixture.tripId, fixture.owner.uid)).toMatchObject({
      ownershipMinor: 7000,
    });
    expect(await inspectOwnership(fixture.tripId, fixture.member.uid)).toMatchObject({
      ownershipMinor: 3000,
    });
    trip = await inspectTrip(fixture.tripId);
    expect(trip?.ledgerBalanceMinor).toBe(10000);
    expect(trip?.saved).toBe(100);
    expect(trip?.ownershipModelState).toBe("initialized");
    expect(trip?.ownershipModelVersion).toBe(1);
    expect(await countAllocationsForTrip(fixture.tripId)).toBe(0);
    assertHealthyInvariant(await captureInvariantSnapshot(fixture.tripId));

    expect(await inspectSavingsTransaction(memberContributionRequestId)).toMatchObject({
      resourceType: "trip",
      resourceId: fixture.tripId,
      memberUid: fixture.member.uid,
      recordedBy: fixture.member.uid,
      type: "contribution",
      amountMinor: 3000,
      currency: "USD",
    });

    // -----------------------------------------------------------------
    // F. Pooled Shared-Stash spend - 2500 (frozen preflight §8).
    // -----------------------------------------------------------------
    await signInAs(fixture.owner.email);
    const sharedStashRequestId = generateExpenseClientRequestId();
    const sharedStashRequest = {
      tripId: fixture.tripId,
      amountMinor: 2500,
      currency: "USD" as const,
      description: "5C.7 pooled Shared Stash spend",
      clientRequestId: sharedStashRequestId,
    };
    const sharedStashResult = await recordSharedStashExpense(sharedStashRequest);
    expect(sharedStashResult.expenseId).toBe(sharedStashRequestId);

    // G/H. Exact depletion 1750/750 -> ownership/aggregate 5250/2250/7500.
    expect(await inspectOwnership(fixture.tripId, fixture.owner.uid)).toMatchObject({
      ownershipMinor: 5250,
    });
    expect(await inspectOwnership(fixture.tripId, fixture.member.uid)).toMatchObject({
      ownershipMinor: 2250,
    });
    trip = await inspectTrip(fixture.tripId);
    expect(trip?.ledgerBalanceMinor).toBe(7500);
    expect(trip?.saved).toBe(75);
    expect(trip?.ownershipModelState).toBe("initialized");
    expect(trip?.ownershipModelVersion).toBe(1);
    assertHealthyInvariant(await captureInvariantSnapshot(fixture.tripId));

    // -----------------------------------------------------------------
    // Shared-Stash persisted evidence + exact linkage (frozen preflight
    // §8/§10).
    // -----------------------------------------------------------------
    const expenseDoc = await inspectExpense(sharedStashResult.expenseId);
    expect(expenseDoc?.paymentSource).toBe("shared_stash");
    expect(expenseDoc?.amountMinor).toBe(2500);
    expect(expenseDoc?.status).toBe("active");
    expect(expenseDoc?.sharedStashTransactionId).toBe(
      sharedStashResult.sharedStashTransactionId
    );

    const linkedWithdrawalDoc = await inspectSavingsTransaction(
      sharedStashResult.sharedStashTransactionId
    );
    expect(linkedWithdrawalDoc).toBeDefined();
    expect(linkedWithdrawalDoc?.type).toBe("withdrawal");
    expect(linkedWithdrawalDoc?.amountMinor).toBe(2500);
    expect(linkedWithdrawalDoc?.linkedExpenseId).toBe(sharedStashResult.expenseId);

    const allocationDoc = await inspectAllocation(
      sharedStashResult.sharedStashTransactionId
    );
    expect(allocationDoc).toBeDefined();
    expect(allocationDoc?.tripId).toBe(fixture.tripId);
    expect(allocationDoc?.expenseId).toBe(sharedStashResult.expenseId);
    expect(allocationDoc?.amountMinor).toBe(2500);
    expect(allocationDoc?.provenance).toBe("original");
    const allocationEntries = allocationDoc?.allocations as {
      uid: string;
      amountMinor: number;
    }[];
    const sumEntries = allocationEntries.reduce((s, e) => s + e.amountMinor, 0);
    expect(sumEntries).toBe(2500);
    // Compare the ACTUAL persisted array, unsorted, against an expected
    // array built by sorting the two real runtime uids ascending - this
    // proves the persisted order is already canonical ascending-uid, not
    // merely that the correct uid set and amounts exist in some order.
    const expectedByUid: Record<string, number> = {
      [fixture.owner.uid]: 1750,
      [fixture.member.uid]: 750,
    };
    const expectedAllocationEntries = [fixture.owner.uid, fixture.member.uid]
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((uid) => ({uid, amountMinor: expectedByUid[uid]}));
    expect(allocationEntries.length).toBe(2);
    expect(allocationEntries).toEqual(expectedAllocationEntries);

    // -----------------------------------------------------------------
    // Mandatory zero-pairwise-debt check (frozen preflight §8) - never
    // optional.
    // -----------------------------------------------------------------
    const splits = await fetchExpenseSplitsForExpense(
      fixture.tripId,
      sharedStashResult.expenseId
    );
    expect(splits).toEqual([]);

    // -----------------------------------------------------------------
    // Shared-Stash EXACT REPLAY (frozen preflight §13).
    // -----------------------------------------------------------------
    const beforeSharedStashReplay = await captureInvariantSnapshot(fixture.tripId);
    const sharedStashReplay = await recordSharedStashExpense(sharedStashRequest);
    expect(sharedStashReplay).toEqual(sharedStashResult);
    expect(sharedStashReplay.expenseId).toBe(sharedStashRequestId);
    const afterSharedStashReplay = await captureInvariantSnapshot(fixture.tripId);
    expect(afterSharedStashReplay).toEqual(beforeSharedStashReplay);
    expect(await inspectExpense(sharedStashRequestId)).toEqual(expenseDoc);

    const linkedWithdrawals = await findSavingsTransactionsLinkedToExpense(
      sharedStashResult.expenseId
    );
    expect(linkedWithdrawals.length).toBe(1);
    const allocationsForExpense = await findOwnershipAllocationsForExpense(
      sharedStashResult.expenseId
    );
    expect(allocationsForExpense.length).toBe(1);
    expect(await countAllocationsForTrip(fixture.tripId)).toBe(1);

    // -----------------------------------------------------------------
    // H. Member personal withdrawal - 1000 (frozen preflight §9).
    // -----------------------------------------------------------------
    await signInAs(fixture.member.email);
    const ownerOwnershipBeforeWithdrawal = await inspectOwnership(
      fixture.tripId,
      fixture.owner.uid
    );
    const memberWithdrawalRequestId = generateSavingsClientRequestId();
    const memberWithdrawalRequest = {
      resourceType: "trip" as const,
      resourceId: fixture.tripId,
      memberUid: fixture.member.uid,
      type: "withdrawal" as const,
      amountMinor: 1000,
      currency: "USD" as const,
      clientRequestId: memberWithdrawalRequestId,
    };
    const memberWithdrawalResult = await recordSavingsTransaction(
      memberWithdrawalRequest
    );
    expect(memberWithdrawalResult.transactionId).toBe(memberWithdrawalRequestId);

    // -----------------------------------------------------------------
    // I. Final ownership/aggregate checkpoint: 5250/1250/6500.
    // -----------------------------------------------------------------
    expect(await inspectOwnership(fixture.tripId, fixture.member.uid)).toMatchObject({
      ownershipMinor: 1250,
    });
    expect(await inspectOwnership(fixture.tripId, fixture.owner.uid)).toEqual(
      ownerOwnershipBeforeWithdrawal
    );
    trip = await inspectTrip(fixture.tripId);
    expect(trip?.ledgerBalanceMinor).toBe(6500);
    expect(trip?.saved).toBe(65);
    expect(trip?.ownershipModelState).toBe("initialized");
    expect(trip?.ownershipModelVersion).toBe(1);
    assertHealthyInvariant(await captureInvariantSnapshot(fixture.tripId));

    const memberWithdrawalDoc = await inspectSavingsTransaction(
      memberWithdrawalRequestId
    );
    expect(memberWithdrawalDoc).toMatchObject({
      type: "withdrawal",
      amountMinor: 1000,
      memberUid: fixture.member.uid,
      recordedBy: fixture.member.uid,
    });
    expect(memberWithdrawalDoc?.linkedExpenseId).toBeUndefined();

    // -----------------------------------------------------------------
    // Member withdrawal EXACT REPLAY (frozen preflight §13).
    // -----------------------------------------------------------------
    const beforeWithdrawalReplay = await captureInvariantSnapshot(fixture.tripId);
    const memberWithdrawalReplay = await recordSavingsTransaction(
      memberWithdrawalRequest
    );
    expect(memberWithdrawalReplay).toEqual(memberWithdrawalResult);
    const afterWithdrawalReplay = await captureInvariantSnapshot(fixture.tripId);
    expect(afterWithdrawalReplay).toEqual(beforeWithdrawalReplay);
    expect(await inspectSavingsTransaction(memberWithdrawalRequestId)).toEqual(
      memberWithdrawalDoc
    );

    // -----------------------------------------------------------------
    // Final complete audit chain (frozen preflight §10/§22) - every
    // artifact cross-linked by exact id, never by count alone.
    // -----------------------------------------------------------------
    const finalAcceptances = await findAcceptanceFor(fixture.tripId, fixture.member.uid);
    expect(finalAcceptances.length).toBe(1);
    expect(finalAcceptances[0].uid).toBe(fixture.member.uid);
    expect(finalAcceptances[0].termsDocId).toBe(fixture.termsV1Id);

    expect(
      (await inspectSavingsTransaction(ownerContributionRequestId)) !== undefined
    ).toBe(true);
    expect(
      (await inspectSavingsTransaction(memberContributionRequestId)) !== undefined
    ).toBe(true);

    expect(await inspectExpense(sharedStashResult.expenseId)).toBeDefined();
    const finalExpense = await inspectExpense(sharedStashResult.expenseId);
    expect(finalExpense?.sharedStashTransactionId).toBe(
      sharedStashResult.sharedStashTransactionId
    );
    const finalWithdrawal = await inspectSavingsTransaction(
      sharedStashResult.sharedStashTransactionId
    );
    expect(finalWithdrawal?.linkedExpenseId).toBe(sharedStashResult.expenseId);
    const finalAllocation = await inspectAllocation(
      sharedStashResult.sharedStashTransactionId
    );
    expect(finalAllocation?.expenseId).toBe(sharedStashResult.expenseId);
    expect(finalAllocation?.tripId).toBe(fixture.tripId);

    const finalOwnerOwnership = await inspectOwnership(fixture.tripId, fixture.owner.uid);
    const finalMemberOwnership = await inspectOwnership(
      fixture.tripId,
      fixture.member.uid
    );
    expect(finalOwnerOwnership?.ownershipMinor).toBe(5250);
    expect(finalMemberOwnership?.ownershipMinor).toBe(1250);
    expect(finalOwnerOwnership?.ownershipMinor as number).toBeGreaterThanOrEqual(0);
    expect(finalMemberOwnership?.ownershipMinor as number).toBeGreaterThanOrEqual(0);

    // -----------------------------------------------------------------
    // Final ownership-ceiling rejection (frozen preflight §14): member
    // withdraws 1251, a NEW request id, never reusing §9's.
    // -----------------------------------------------------------------
    const rejectedRequestId = generateSavingsClientRequestId();
    const beforeRejection = {
      ownerOwnership: finalOwnerOwnership,
      memberOwnership: finalMemberOwnership,
      snapshot: await captureInvariantSnapshot(fixture.tripId),
    };

    await expectCallableErrorCode(
      recordSavingsTransaction({
        resourceType: "trip",
        resourceId: fixture.tripId,
        memberUid: fixture.member.uid,
        type: "withdrawal",
        amountMinor: 1251,
        currency: "USD",
        clientRequestId: rejectedRequestId,
      }),
      "functions/failed-precondition"
    );

    const afterRejection = {
      ownerOwnership: await inspectOwnership(fixture.tripId, fixture.owner.uid),
      memberOwnership: await inspectOwnership(fixture.tripId, fixture.member.uid),
      snapshot: await captureInvariantSnapshot(fixture.tripId),
    };
    expect(afterRejection).toEqual(beforeRejection);
    expect(await inspectSavingsTransaction(rejectedRequestId)).toBeUndefined();

    // Final state, restated explicitly one last time.
    const finalTrip = await inspectTrip(fixture.tripId);
    expect(finalTrip?.ledgerBalanceMinor).toBe(6500);
    expect(finalTrip?.saved).toBe(65);
    expect(finalTrip?.ownershipModelState).toBe("initialized");
    expect(finalTrip?.ownershipModelVersion).toBe(1);
  });
});

afterAll(async () => {
  await cleanupTrustedInspectionEnv();
  await cleanupDemoFirebaseInstances();
});
