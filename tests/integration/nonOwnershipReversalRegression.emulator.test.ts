// Milestone 5C.6 - the real, local, emulator-backed REGRESSION proof
// that reverseTripExpense and reverseTripSettlement remain ownership-
// model-gate-free and economically correct, per the frozen docs/audits/
// MULTI_MEMBER_REVERSAL_RECONCILIATION_PREFLIGHT_2026-10-20.md. Neither
// callable is modified by 5C.6, and neither one ever reads
// ownershipModelState at all - this suite proves that remains true even
// on an "initialized" Trip with real Shared-Stash ownership activity
// alongside the ordinary member_out_of_pocket Expense/Settlement this
// suite exercises. Every Expense/Settlement/reversal here goes through
// the REAL production client service wrappers and the REAL Functions
// Emulator - never a mock, never a directly-invoked Core function.
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
  createAcceptedTwoMemberTrip,
} from "./helpers/reconciliationFixtures";
import {
  inspectExpense,
  inspectOwnershipBalancesForTrip,
} from "./helpers/ownershipInspection";
import {
  generateExpenseClientRequestId,
  recordTripExpense,
  reverseTripExpense,
} from "../../src/services/firebase/expenses";
import {
  generateSettlementClientRequestId,
  recordTripSettlement,
  reverseTripSettlement,
} from "../../src/services/firebase/settlements";

type OwnershipSnapshot = {
  ledgerBalanceMinor: unknown;
  ownershipModelState: unknown;
  ownership: {uid: string; ownershipMinor: number}[];
};

async function captureOwnershipSnapshot(tripId: string): Promise<OwnershipSnapshot> {
  const trip = await inspectTrip(tripId);
  const ownership = await inspectOwnershipBalancesForTrip(tripId);
  return {
    ledgerBalanceMinor: trip?.ledgerBalanceMinor,
    ownershipModelState: trip?.ownershipModelState,
    ownership,
  };
}

describe("5C.6 - non-ownership reversal regression: reverseTripExpense", () => {
  it("reverses a member_out_of_pocket Expense correctly on an \"initialized\" Trip, proving Shared-Stash ownership never moves", async () => {
    const fixture = await createAcceptedTwoMemberTrip("5c6-nonownership-expense");
    await signInAs(fixture.owner.email);
    await contributeReal(fixture.tripId, fixture.owner.uid, 600);
    await signInAs(fixture.member.email);
    await contributeReal(fixture.tripId, fixture.member.uid, 400);

    await signInAs(fixture.owner.email);
    const expense = await recordTripExpense({
      tripId: fixture.tripId,
      payerUid: fixture.owner.uid,
      amountMinor: 200,
      currency: "USD",
      description: "5C.6 non-ownership expense",
      splitStrategy: "equal",
      participants: [{uid: fixture.owner.uid}, {uid: fixture.member.uid}],
      clientRequestId: generateExpenseClientRequestId(),
    });

    // Captured AFTER the member_out_of_pocket Expense itself (which has
    // its own, separate, non-Shared-Stash economic effect via
    // tripExpenseSplits/balances - never ledgerBalanceMinor or
    // tripMemberOwnership) - this is the exact pre-reversal baseline the
    // reversal itself must leave completely undisturbed.
    const before = await captureOwnershipSnapshot(fixture.tripId);

    const reversal = await reverseTripExpense({
      expenseId: expense.expenseId,
      clientRequestId: generateExpenseClientRequestId(),
    });
    expect(reversal.expenseId).toBe(expense.expenseId);

    const expenseAfter = await inspectExpense(expense.expenseId);
    expect(expenseAfter?.status).toBe("reversed");

    // Proves the claim directly: Shared-Stash ownership (the complete
    // uid-sorted row set) and the Trip's own ledgerBalanceMinor/
    // ownershipModelState are byte-for-byte unchanged by this reversal.
    const after = await captureOwnershipSnapshot(fixture.tripId);
    expect(after).toEqual(before);
    expect(after.ownershipModelState).toBe("initialized");
  });

  it("an outsider cannot reverse the Expense - authorization is unchanged and unrelated to ownership state", async () => {
    const fixture = await createAcceptedTwoMemberTrip("5c6-nonownership-expense-auth");
    await signInAs(fixture.owner.email);
    const expense = await recordTripExpense({
      tripId: fixture.tripId,
      payerUid: fixture.owner.uid,
      amountMinor: 100,
      currency: "USD",
      description: "5C.6 auth check",
      splitStrategy: "equal",
      participants: [{uid: fixture.owner.uid}],
      clientRequestId: generateExpenseClientRequestId(),
    });

    await signInAs(fixture.member.email);
    await expectCallableErrorCode(
      reverseTripExpense({
        expenseId: expense.expenseId,
        clientRequestId: generateExpenseClientRequestId(),
      }),
      "functions/permission-denied"
    );
  });
});

describe("5C.6 - non-ownership reversal regression: reverseTripSettlement", () => {
  it("reverses a Settlement correctly on an \"initialized\" Trip, proving Shared-Stash ownership never moves", async () => {
    const fixture = await createAcceptedTwoMemberTrip("5c6-nonownership-settlement");
    await signInAs(fixture.owner.email);
    await contributeReal(fixture.tripId, fixture.owner.uid, 600);
    await signInAs(fixture.member.email);
    await contributeReal(fixture.tripId, fixture.member.uid, 400);

    // recordTripSettlement requires the caller to be the RECIPIENT
    // (toUid) - the owner, here.
    await signInAs(fixture.owner.email);
    const settlement = await recordTripSettlement({
      tripId: fixture.tripId,
      fromUid: fixture.member.uid,
      toUid: fixture.owner.uid,
      amountMinor: 50,
      currency: "USD",
      method: "cash",
      clientRequestId: generateSettlementClientRequestId(),
    });

    const before = await captureOwnershipSnapshot(fixture.tripId);

    const reversal = await reverseTripSettlement({
      settlementId: settlement.settlementId,
      clientRequestId: generateSettlementClientRequestId(),
    });
    expect(reversal.settlementId).toBe(settlement.settlementId);

    const after = await captureOwnershipSnapshot(fixture.tripId);
    expect(after).toEqual(before);
    expect(after.ownershipModelState).toBe("initialized");
  });

  it("the narrower toUid-only authorization is unchanged - the Trip owner alone cannot reverse a Settlement they are not the recipient of", async () => {
    const fixture = await createAcceptedTwoMemberTrip("5c6-nonownership-settlement-auth");
    // recordTripSettlement requires the caller to be the RECIPIENT
    // (toUid) - the member, here (auth is already signed in as the
    // member right after fixture creation).
    const settlement = await recordTripSettlement({
      tripId: fixture.tripId,
      fromUid: fixture.owner.uid,
      toUid: fixture.member.uid,
      amountMinor: 20,
      currency: "USD",
      method: "cash",
      clientRequestId: generateSettlementClientRequestId(),
    });

    // Owner is the FROM party, not the TO party - reverseTripSettlement's
    // own frozen, narrower authorization (toUid-only, no owner override)
    // must still reject this, unrelated to any ownership-model concern.
    await signInAs(fixture.owner.email);
    await expectCallableErrorCode(
      reverseTripSettlement({
        settlementId: settlement.settlementId,
        clientRequestId: generateSettlementClientRequestId(),
      }),
      "functions/permission-denied"
    );
  });
});

afterAll(async () => {
  await cleanupTrustedInspectionEnv();
  await cleanupDemoFirebaseInstances();
});
