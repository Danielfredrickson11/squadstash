// Milestone 5C.6 - the real, local, emulator-backed REGRESSION proof
// that reverseSharedStashExpense's own already-shipped, fully fail-
// closed corrupted-allocation checklist continues to hold unmodified,
// per the frozen docs/audits/
// MULTI_MEMBER_REVERSAL_RECONCILIATION_PREFLIGHT_2026-10-20.md (no
// hardening gap was found there - this suite exists to PROVE that,
// never to patch it). reverseSharedStashExpense.ts itself is never
// modified. Every Expense/withdrawal/reversal here goes through the
// REAL production client service wrappers and the REAL Functions
// Emulator; only the deliberate allocation-corruption precondition uses
// trusted, Rules-bypassing setup (see reconciliationFixtures.ts's own
// frozen-scope header).
/* eslint-disable @typescript-eslint/no-require-imports, import/first */
jest.mock("../../firebase", () =>
  require("./helpers/firebaseIntegrationTestEnv").buildDemoFirebaseInstances()
);

import {cleanupDemoFirebaseInstances} from "./helpers/firebaseIntegrationTestEnv";
import {cleanupTrustedInspectionEnv, inspectTrip} from "./helpers/trustedInspection";
import {expectCallableErrorCode} from "./helpers/assertions";
import {signInAs} from "./helpers/fixtures";
import {
  contributeReal,
  corruptOwnershipAllocationAmountReal,
  createAcceptedTwoMemberTrip,
  spendSharedStashReal,
} from "./helpers/reconciliationFixtures";
import {
  inspectAllOwnershipRows,
  inspectExpense,
  inspectOwnershipBalancesForTrip,
  inspectSavingsTransaction,
} from "./helpers/ownershipInspection";
import {
  generateExpenseClientRequestId,
  reverseSharedStashExpense,
} from "../../src/services/firebase/expenses";

describe("5C.6 - Shared-Stash reversal regression: exact economics", () => {
  it("restores the EXACT pre-spend ownership map, not merely the total", async () => {
    const fixture = await createAcceptedTwoMemberTrip("5c6-ssr-exact");
    await signInAs(fixture.owner.email);
    await contributeReal(fixture.tripId, fixture.owner.uid, 600);
    await signInAs(fixture.member.email);
    await contributeReal(fixture.tripId, fixture.member.uid, 400);

    const beforeSpend = await inspectOwnershipBalancesForTrip(fixture.tripId);
    expect(beforeSpend).toEqual([
      {uid: fixture.owner.uid, ownershipMinor: 600},
      {uid: fixture.member.uid, ownershipMinor: 400},
    ].sort((a, b) => (a.uid < b.uid ? -1 : 1)));

    await signInAs(fixture.owner.email);
    const spend = await spendSharedStashReal(fixture.tripId, 300, "5c6-ssr-exact-spend");

    // Confirm the depleted state - proportional to the pre-spend
    // ownership (600:400 = 180:120 of the 300 spent).
    const afterSpend = await inspectOwnershipBalancesForTrip(fixture.tripId);
    expect(afterSpend).toEqual([
      {uid: fixture.owner.uid, ownershipMinor: 420},
      {uid: fixture.member.uid, ownershipMinor: 280},
    ].sort((a, b) => (a.uid < b.uid ? -1 : 1)));

    const reversal = await reverseSharedStashExpense({
      expenseId: spend.expenseId,
      clientRequestId: generateExpenseClientRequestId(),
    });
    expect(reversal.expenseId).toBe(spend.expenseId);
    expect(reversal.refundTransactionId).toBeTruthy();

    // Exact restoration to the pre-spend map - never merely the total.
    const afterReversal = await inspectOwnershipBalancesForTrip(fixture.tripId);
    expect(afterReversal).toEqual(beforeSpend);

    const trip = await inspectTrip(fixture.tripId);
    expect(trip?.ledgerBalanceMinor).toBe(1000);
  });
});

describe("5C.6 - Shared-Stash reversal regression: exact idempotent replay", () => {
  it("a second call with the SAME clientRequestId returns the identical result and makes zero additional mutation", async () => {
    const fixture = await createAcceptedTwoMemberTrip("5c6-ssr-replay");
    await signInAs(fixture.owner.email);
    await contributeReal(fixture.tripId, fixture.owner.uid, 600);
    await signInAs(fixture.member.email);
    await contributeReal(fixture.tripId, fixture.member.uid, 400);

    await signInAs(fixture.owner.email);
    const spend = await spendSharedStashReal(fixture.tripId, 300, "5c6-ssr-replay-spend");

    const reversalClientRequestId = generateExpenseClientRequestId();
    const first = await reverseSharedStashExpense({
      expenseId: spend.expenseId,
      clientRequestId: reversalClientRequestId,
    });

    const ownershipAfterFirst = await inspectOwnershipBalancesForTrip(fixture.tripId);
    const tripAfterFirst = await inspectTrip(fixture.tripId);
    const allRowsAfterFirst = await inspectAllOwnershipRows(fixture.tripId);

    // The REAL idempotent replay: the SAME caller, the SAME expenseId,
    // the SAME clientRequestId (and therefore the same deterministic
    // refund id) - never a different request that merely happens to
    // also succeed.
    const replay = await reverseSharedStashExpense({
      expenseId: spend.expenseId,
      clientRequestId: reversalClientRequestId,
    });

    expect(replay).toEqual(first);
    expect(replay.refundTransactionId).toBe(first.refundTransactionId);

    const ownershipAfterReplay = await inspectOwnershipBalancesForTrip(fixture.tripId);
    const tripAfterReplay = await inspectTrip(fixture.tripId);
    const allRowsAfterReplay = await inspectAllOwnershipRows(fixture.tripId);

    expect(ownershipAfterReplay).toEqual(ownershipAfterFirst);
    expect(tripAfterReplay?.ledgerBalanceMinor).toBe(tripAfterFirst?.ledgerBalanceMinor);
    expect(allRowsAfterReplay).toEqual(allRowsAfterFirst);

    // The original refund transaction still exists, unchanged, and no
    // second refund/reversal artifact was created for this Expense.
    const refund = await inspectSavingsTransaction(first.refundTransactionId);
    expect(refund).toBeDefined();
    expect(refund?.linkedExpenseId).toBe(spend.expenseId);
    expect(refund?.reversalOf).toBe(spend.sharedStashTransactionId);

    const expenseAfter = await inspectExpense(spend.expenseId);
    expect(expenseAfter?.status).toBe("reversed");
    expect(expenseAfter?.refundTransactionId).toBe(first.refundTransactionId);
  });
});

describe("5C.6 - Shared-Stash reversal regression: duplicate reversal rejection", () => {
  it("rejects a SECOND, differently-requested reversal of an already-reversed Expense with zero further mutation", async () => {
    const fixture = await createAcceptedTwoMemberTrip("5c6-ssr-duplicate");
    await signInAs(fixture.owner.email);
    await contributeReal(fixture.tripId, fixture.owner.uid, 600);
    await signInAs(fixture.member.email);
    await contributeReal(fixture.tripId, fixture.member.uid, 400);

    await signInAs(fixture.owner.email);
    const spend = await spendSharedStashReal(fixture.tripId, 300, "5c6-ssr-duplicate-spend");

    const first = await reverseSharedStashExpense({
      expenseId: spend.expenseId,
      clientRequestId: generateExpenseClientRequestId(),
    });

    const ownershipBefore = await inspectOwnershipBalancesForTrip(fixture.tripId);
    const tripBefore = await inspectTrip(fixture.tripId);
    const expenseBefore = await inspectExpense(spend.expenseId);

    // A genuinely NEW request (different clientRequestId) against the
    // SAME already-reversed Expense - this is NOT a replay of the first
    // reversal (reverseSharedStashExpenseCore's own replay match requires
    // an exact normalized reversalRequest match, which a new
    // clientRequestId breaks) - the callable's own existing
    // already-reversed guard must reject it.
    await expectCallableErrorCode(
      reverseSharedStashExpense({
        expenseId: spend.expenseId,
        clientRequestId: generateExpenseClientRequestId(),
      }),
      "functions/failed-precondition"
    );

    const ownershipAfter = await inspectOwnershipBalancesForTrip(fixture.tripId);
    const tripAfter = await inspectTrip(fixture.tripId);
    const expenseAfter = await inspectExpense(spend.expenseId);

    expect(ownershipAfter).toEqual(ownershipBefore);
    expect(tripAfter?.ledgerBalanceMinor).toBe(tripBefore?.ledgerBalanceMinor);
    expect(expenseAfter).toEqual(expenseBefore);
    expect(expenseAfter?.status).toBe("reversed");
    expect(expenseAfter?.refundTransactionId).toBe(first.refundTransactionId);
  });
});

describe("5C.6 - Shared-Stash reversal regression: corrupted allocation evidence", () => {
  it("rejects a reversal whose persisted allocation amount was corrupted, with zero mutation and no reconciliation transition", async () => {
    const fixture = await createAcceptedTwoMemberTrip("5c6-ssr-corrupt");
    await signInAs(fixture.owner.email);
    await contributeReal(fixture.tripId, fixture.owner.uid, 600);
    await signInAs(fixture.member.email);
    await contributeReal(fixture.tripId, fixture.member.uid, 400);

    await signInAs(fixture.owner.email);
    const spend = await spendSharedStashReal(fixture.tripId, 300, "5c6-ssr-corrupt-spend");

    // Corrupt the immutable allocation record's own amount - no public
    // client path can ever do this.
    await corruptOwnershipAllocationAmountReal(spend.sharedStashTransactionId, 299);

    const before = await inspectAllOwnershipRows(fixture.tripId);
    const beforeTrip = await inspectTrip(fixture.tripId);

    await expectCallableErrorCode(
      reverseSharedStashExpense({
        expenseId: spend.expenseId,
        clientRequestId: generateExpenseClientRequestId(),
      }),
      "functions/failed-precondition"
    );

    const after = await inspectAllOwnershipRows(fixture.tripId);
    expect(after).toEqual(before);
    const afterTrip = await inspectTrip(fixture.tripId);
    expect(afterTrip?.ledgerBalanceMinor).toBe(beforeTrip?.ledgerBalanceMinor);
    // Corrupted historical EVIDENCE never implies a live drift - the
    // Trip's ownershipModelState must remain "initialized", never
    // transitioned to "needs_reconciliation" (frozen preflight: these
    // two failure categories are never conflated).
    expect(afterTrip?.ownershipModelState).toBe("initialized");
    const expenseAfter = await inspectExpense(spend.expenseId);
    expect(expenseAfter?.status).toBe("active");
  });
});

afterAll(async () => {
  await cleanupTrustedInspectionEnv();
  await cleanupDemoFirebaseInstances();
});
