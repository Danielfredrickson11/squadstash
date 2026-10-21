// Milestone 5C.4 - the real, local, emulator-backed integration proof of
// Multi-Member Shared Stash Spending, per the frozen docs/audits/
// MULTI_MEMBER_SPENDING_WITHDRAWAL_PREFLIGHT_2026-10-20.md. Every Trip/
// terms/invitation/acceptance/contribution/spend in this file goes
// through the REAL production client service wrappers and the REAL
// Functions Emulator - never a mock, never a directly-invoked Core
// function. The canonical two-member fixture is always built through
// tests/integration/helpers/financialFixtures.ts's real-callable
// sequencing - never manually-seeded memberIds or ownership rows. The
// few trusted-setup calls in the authorization/state-failure and drift-
// detection scenarios below construct ONLY an otherwise-unreachable
// precondition (migrating/needs_reconciliation/archived/a deliberate
// aggregate drift) - see tests/integration/helpers/ownershipInspection.ts's
// own frozen-scope header for the full boundary this file honors.
//
// `babel-plugin-jest-hoist` hoists jest.mock(...) above every import in
// this file, and its factory can only reference `require(...)` (not an
// enclosing-scope import) - that is what the two rules below flag, and
// why every other import in this file is unavoidably pushed below this
// statement. Disabled for exactly these two structural rules, nothing
// else in this file is exempted from any other check.
/* eslint-disable @typescript-eslint/no-require-imports, import/first */
jest.mock("../../firebase", () =>
  require("./helpers/firebaseIntegrationTestEnv").buildDemoFirebaseInstances()
);

import {cleanupDemoFirebaseInstances} from "./helpers/firebaseIntegrationTestEnv";
import {cleanupTrustedInspectionEnv, inspectTrip} from "./helpers/trustedInspection";
import {expectCallableErrorCode} from "./helpers/assertions";
import {
  createAndSignInUser,
  setupOwnerTripTermsInvitation,
  signInAs,
} from "./helpers/fixtures";
import {
  contributeReal,
  createAcceptedTwoMemberTrip,
  spendSharedStashReal,
} from "./helpers/financialFixtures";
import {
  findOwnershipAllocationsForExpense,
  findSavingsTransactionsLinkedToExpense,
  inspectAllocation,
  inspectExpense,
  inspectOwnership,
  inspectOwnershipBalancesForTrip,
  inspectSavingsTransaction,
  setTripArchived,
  setTripLedgerBalanceDrift,
  setTripOwnershipModelState,
} from "./helpers/ownershipInspection";
import {
  generateExpenseClientRequestId,
  recordSharedStashExpense,
} from "../../src/services/firebase/expenses";

// Milestone 5C.4+5C.5 isolation/assertion-hardening pass - a small local
// snapshot/assertion pattern proving the FULL frozen zero-partial-
// mutation requirement on a rejected recordSharedStashExpense call, not
// merely one ownership row. Captures every stable economic fact before
// the attempt, then asserts all of it is unchanged afterward, plus the
// absence of every document a successful call would have created.
type FinancialSnapshot = {
  ledgerBalanceMinor: unknown;
  ownership: {uid: string; ownershipMinor: number}[];
};

async function captureFinancialSnapshot(tripId: string): Promise<FinancialSnapshot> {
  const trip = await inspectTrip(tripId);
  const ownership = await inspectOwnershipBalancesForTrip(tripId);
  return {ledgerBalanceMinor: trip?.ledgerBalanceMinor, ownership};
}

async function expectZeroPartialSpendMutation(
  tripId: string,
  clientRequestId: string,
  before: FinancialSnapshot
): Promise<void> {
  const after = await captureFinancialSnapshot(tripId);
  expect(after.ledgerBalanceMinor).toBe(before.ledgerBalanceMinor);
  expect(after.ownership).toEqual(before.ownership);
  expect(await inspectExpense(clientRequestId)).toBeUndefined();
  expect(await findSavingsTransactionsLinkedToExpense(clientRequestId)).toEqual([]);
  expect(await findOwnershipAllocationsForExpense(clientRequestId)).toEqual([]);
}

describe("5C.4 - canonical multi-member pooled spend", () => {
  it("depletes ownership proportionally and persists exact evidence", async () => {
    const fixture = await createAcceptedTwoMemberTrip("sss-canonical");

    await signInAs(fixture.owner.email);
    await contributeReal(fixture.tripId, fixture.owner.uid, 7000);
    await signInAs(fixture.member.email);
    await contributeReal(fixture.tripId, fixture.member.uid, 3000);

    const tripAfterContributions = await inspectTrip(fixture.tripId);
    expect(tripAfterContributions?.ledgerBalanceMinor).toBe(10000);
    expect((await inspectOwnership(fixture.tripId, fixture.owner.uid))?.ownershipMinor).toBe(7000);
    expect((await inspectOwnership(fixture.tripId, fixture.member.uid))?.ownershipMinor).toBe(3000);

    await signInAs(fixture.owner.email);
    const spendResult = await spendSharedStashReal(fixture.tripId, 2500, "canonical spend");
    expect(spendResult.expenseId).toBeTruthy();
    expect(spendResult.sharedStashTransactionId).toBeTruthy();

    const ownerOwnership = await inspectOwnership(fixture.tripId, fixture.owner.uid);
    const memberOwnership = await inspectOwnership(fixture.tripId, fixture.member.uid);
    expect(ownerOwnership?.ownershipMinor).toBe(5250);
    expect(memberOwnership?.ownershipMinor).toBe(2250);

    const tripAfterSpend = await inspectTrip(fixture.tripId);
    expect(tripAfterSpend?.ledgerBalanceMinor).toBe(7500);
    expect(
      (ownerOwnership!.ownershipMinor as number) + (memberOwnership!.ownershipMinor as number)
    ).toBe(7500);
    console.log("PASS 5C.4 canonical multi-member pooled spend");

    // Persisted evidence - read back via trusted inspection, not merely
    // the returned values above.
    const expense = await inspectExpense(spendResult.expenseId);
    expect(expense?.tripId).toBe(fixture.tripId);
    expect(expense?.payerUid).toBeNull();
    expect(expense?.createdBy).toBe(fixture.owner.uid);
    expect(expense?.amountMinor).toBe(2500);
    expect(expense?.currency).toBe("USD");
    expect(expense?.paymentSource).toBe("shared_stash");
    expect(expense?.status).toBe("active");
    expect(expense?.sharedStashTransactionId).toBe(spendResult.sharedStashTransactionId);

    const withdrawalTxn = await inspectSavingsTransaction(spendResult.sharedStashTransactionId);
    expect(withdrawalTxn?.resourceType).toBe("trip");
    expect(withdrawalTxn?.resourceId).toBe(fixture.tripId);
    expect(withdrawalTxn?.amountMinor).toBe(2500);
    expect(withdrawalTxn?.type).toBe("withdrawal");
    expect(withdrawalTxn?.linkedExpenseId).toBe(spendResult.expenseId);
    expect(withdrawalTxn?.memberUid).toBe(fixture.owner.uid);
    expect(withdrawalTxn?.recordedBy).toBe(fixture.owner.uid);

    expect(tripAfterSpend?.saved).toBe(75);
    expect(tripAfterSpend?.lastUpdatedBy).toBe(fixture.owner.uid);

    const allocation = await inspectAllocation(spendResult.sharedStashTransactionId);
    expect(allocation?.tripId).toBe(fixture.tripId);
    expect(allocation?.expenseId).toBe(spendResult.expenseId);
    expect(allocation?.withdrawalTransactionId).toBe(spendResult.sharedStashTransactionId);
    expect(allocation?.amountMinor).toBe(2500);
    expect(allocation?.currency).toBe("USD");
    expect(allocation?.provenance).toBe("original");

    // Never assume owner sorts before member - sort the expected entries
    // by the actual runtime uids, matching the persisted schema's own
    // strictly-ascending-uid requirement.
    const expectedAllocations = [
      {uid: fixture.owner.uid, amountMinor: 1750},
      {uid: fixture.member.uid, amountMinor: 750},
    ].sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
    expect(allocation?.allocations).toEqual(expectedAllocations);

    const allocationSum = (allocation?.allocations as {amountMinor: number}[]).reduce(
      (sum, entry) => sum + entry.amountMinor,
      0
    );
    expect(allocationSum).toBe(2500);
    console.log("PASS 5C.4 persisted spend evidence");
  });
});

describe("5C.4 - largest-remainder tie case", () => {
  it("awards the single residual unit to the lexically smaller real uid", async () => {
    const fixture = await createAcceptedTwoMemberTrip("sss-tie");

    await signInAs(fixture.owner.email);
    await contributeReal(fixture.tripId, fixture.owner.uid, 1);
    await signInAs(fixture.member.email);
    await contributeReal(fixture.tripId, fixture.member.uid, 1);

    // Determined at runtime - never hardcode owner/member as the winner.
    const [smallerUid, largerUid] = [fixture.owner.uid, fixture.member.uid].sort();

    const spendResult = await spendSharedStashReal(fixture.tripId, 1, "tie-break spend");

    expect((await inspectOwnership(fixture.tripId, smallerUid))?.ownershipMinor).toBe(0);
    expect((await inspectOwnership(fixture.tripId, largerUid))?.ownershipMinor).toBe(1);
    expect((await inspectTrip(fixture.tripId))?.ledgerBalanceMinor).toBe(1);

    const allocation = await inspectAllocation(spendResult.sharedStashTransactionId);
    expect(allocation?.allocations).toEqual([{uid: smallerUid, amountMinor: 1}]);
    const allocationSum = (allocation?.allocations as {amountMinor: number}[]).reduce(
      (sum, entry) => sum + entry.amountMinor,
      0
    );
    expect(allocationSum).toBe(1);
    console.log("PASS 5C.4 largest-remainder tie case");
  });
});

describe("5C.4 - spender identity invariance", () => {
  it("produces identical economic depletion regardless of which member initiates the spend", async () => {
    async function runCase(scenarioLabel: string, callerRole: "owner" | "member") {
      const fixture = await createAcceptedTwoMemberTrip(scenarioLabel);
      await signInAs(fixture.owner.email);
      await contributeReal(fixture.tripId, fixture.owner.uid, 7000);
      await signInAs(fixture.member.email);
      await contributeReal(fixture.tripId, fixture.member.uid, 3000);

      const caller = callerRole === "owner" ? fixture.owner : fixture.member;
      await signInAs(caller.email);
      const spendResult = await spendSharedStashReal(fixture.tripId, 2500, `identity-${callerRole}`);

      const ownerOwnership = await inspectOwnership(fixture.tripId, fixture.owner.uid);
      const memberOwnership = await inspectOwnership(fixture.tripId, fixture.member.uid);
      const expense = await inspectExpense(spendResult.expenseId);
      const withdrawalTxn = await inspectSavingsTransaction(spendResult.sharedStashTransactionId);
      const allocation = await inspectAllocation(spendResult.sharedStashTransactionId);
      // Normalized by ROLE, not raw uid - the two Trips use different
      // real uids, so the persisted allocation array itself is never
      // directly comparable across cases; what must match is each
      // role's own economic allocation amount.
      const allocationEntries = (allocation?.allocations ?? []) as {
        uid: string;
        amountMinor: number;
      }[];
      const ownerAllocationMinor = allocationEntries.find(
        (entry) => entry.uid === fixture.owner.uid
      )?.amountMinor;
      const memberAllocationMinor = allocationEntries.find(
        (entry) => entry.uid === fixture.member.uid
      )?.amountMinor;
      const allocationSum = allocationEntries.reduce((sum, entry) => sum + entry.amountMinor, 0);

      return {
        ownerOwnershipMinor: ownerOwnership?.ownershipMinor,
        memberOwnershipMinor: memberOwnership?.ownershipMinor,
        createdBy: expense?.createdBy,
        memberUid: withdrawalTxn?.memberUid,
        recordedBy: withdrawalTxn?.recordedBy,
        callerUid: caller.uid,
        allocationAmountMinor: allocation?.amountMinor,
        allocationProvenance: allocation?.provenance,
        ownerAllocationMinor,
        memberAllocationMinor,
        allocationSum,
      };
    }

    const caseA = await runCase("sss-identity-a", "owner");
    const caseB = await runCase("sss-identity-b", "member");

    expect(caseA.ownerOwnershipMinor).toBe(5250);
    expect(caseA.memberOwnershipMinor).toBe(2250);
    expect(caseB.ownerOwnershipMinor).toBe(5250);
    expect(caseB.memberOwnershipMinor).toBe(2250);

    expect(caseA.createdBy).toBe(caseA.callerUid);
    expect(caseA.memberUid).toBe(caseA.callerUid);
    expect(caseA.recordedBy).toBe(caseA.callerUid);
    expect(caseB.createdBy).toBe(caseB.callerUid);
    expect(caseB.memberUid).toBe(caseB.callerUid);
    expect(caseB.recordedBy).toBe(caseB.callerUid);

    // Same persisted allocation economics in both cases, regardless of
    // which real uid happened to call it.
    expect(caseA.ownerAllocationMinor).toBe(1750);
    expect(caseA.memberAllocationMinor).toBe(750);
    expect(caseB.ownerAllocationMinor).toBe(1750);
    expect(caseB.memberAllocationMinor).toBe(750);
    expect(caseA.allocationAmountMinor).toBe(2500);
    expect(caseB.allocationAmountMinor).toBe(2500);
    expect(caseA.allocationSum).toBe(2500);
    expect(caseB.allocationSum).toBe(2500);
    expect(caseA.allocationProvenance).toBe("original");
    expect(caseB.allocationProvenance).toBe("original");
    console.log("PASS 5C.4 spender identity invariance");
  });
});

describe("5C.4 - authorization and state failures", () => {
  it("rejects a non-member", async () => {
    const fixture = await createAcceptedTwoMemberTrip("sss-outsider");
    const outsider = await createAndSignInUser("sss-outsider-caller");
    await signInAs(outsider.email);

    const before = await captureFinancialSnapshot(fixture.tripId);
    const clientRequestId = generateExpenseClientRequestId();
    await expectCallableErrorCode(
      recordSharedStashExpense({
        tripId: fixture.tripId,
        amountMinor: 100,
        currency: "USD",
        description: "5C.4 outsider attempt",
        clientRequestId,
      }),
      "functions/permission-denied"
    );
    await expectZeroPartialSpendMutation(fixture.tripId, clientRequestId, before);
    console.log("PASS 5C.4 non-member denied");
  });

  it("rejects an invited-but-not-accepted user", async () => {
    const owner = await createAndSignInUser("sss-invited-owner");
    const invitee = await createAndSignInUser("sss-invited-invitee");
    const setup = await setupOwnerTripTermsInvitation({
      ownerEmail: owner.email,
      inviteeEmail: invitee.email,
      scenarioLabel: "sss-invited-not-accepted",
    });
    await signInAs(invitee.email);

    const before = await captureFinancialSnapshot(setup.tripId);
    const clientRequestId = generateExpenseClientRequestId();
    await expectCallableErrorCode(
      recordSharedStashExpense({
        tripId: setup.tripId,
        amountMinor: 100,
        currency: "USD",
        description: "5C.4 invited-not-accepted attempt",
        clientRequestId,
      }),
      "functions/permission-denied"
    );
    await expectZeroPartialSpendMutation(setup.tripId, clientRequestId, before);
    console.log("PASS 5C.4 invited-but-not-accepted denied");
  });

  it("rejects an archived Trip", async () => {
    const fixture = await createAcceptedTwoMemberTrip("sss-archived");
    await signInAs(fixture.owner.email);
    await contributeReal(fixture.tripId, fixture.owner.uid, 1000);
    await setTripArchived(fixture.tripId);

    // Snapshot taken AFTER the archive precondition is in place - that
    // precondition itself is not the operation under test.
    const before = await captureFinancialSnapshot(fixture.tripId);
    const clientRequestId = generateExpenseClientRequestId();
    await expectCallableErrorCode(
      recordSharedStashExpense({
        tripId: fixture.tripId,
        amountMinor: 100,
        currency: "USD",
        description: "5C.4 archived attempt",
        clientRequestId,
      }),
      "functions/failed-precondition"
    );
    await expectZeroPartialSpendMutation(fixture.tripId, clientRequestId, before);
    expect((await inspectTrip(fixture.tripId))?.archivedAt).toBeTruthy();
    console.log("PASS 5C.4 archived Trip denied");
  });

  it("rejects a migrating Trip", async () => {
    const fixture = await createAcceptedTwoMemberTrip("sss-migrating");
    await signInAs(fixture.owner.email);
    await contributeReal(fixture.tripId, fixture.owner.uid, 1000);
    await setTripOwnershipModelState(fixture.tripId, "migrating");

    const before = await captureFinancialSnapshot(fixture.tripId);
    const clientRequestId = generateExpenseClientRequestId();
    await expectCallableErrorCode(
      recordSharedStashExpense({
        tripId: fixture.tripId,
        amountMinor: 100,
        currency: "USD",
        description: "5C.4 migrating attempt",
        clientRequestId,
      }),
      "functions/failed-precondition"
    );
    await expectZeroPartialSpendMutation(fixture.tripId, clientRequestId, before);
    expect((await inspectTrip(fixture.tripId))?.ownershipModelState).toBe("migrating");
    console.log("PASS 5C.4 migrating Trip denied");
  });

  it("rejects a needs_reconciliation Trip", async () => {
    const fixture = await createAcceptedTwoMemberTrip("sss-needsrecon");
    await signInAs(fixture.owner.email);
    await contributeReal(fixture.tripId, fixture.owner.uid, 1000);
    await setTripOwnershipModelState(fixture.tripId, "needs_reconciliation");

    const before = await captureFinancialSnapshot(fixture.tripId);
    const clientRequestId = generateExpenseClientRequestId();
    await expectCallableErrorCode(
      recordSharedStashExpense({
        tripId: fixture.tripId,
        amountMinor: 100,
        currency: "USD",
        description: "5C.4 needs_reconciliation attempt",
        clientRequestId,
      }),
      "functions/failed-precondition"
    );
    await expectZeroPartialSpendMutation(fixture.tripId, clientRequestId, before);
    expect((await inspectTrip(fixture.tripId))?.ownershipModelState).toBe("needs_reconciliation");
    console.log("PASS 5C.4 needs_reconciliation Trip denied");
  });

  it("rejects genuine insufficient ownership on a healthy initialized Trip", async () => {
    const fixture = await createAcceptedTwoMemberTrip("sss-insufficient");
    await signInAs(fixture.owner.email);
    await contributeReal(fixture.tripId, fixture.owner.uid, 100);

    const before = await captureFinancialSnapshot(fixture.tripId);
    const clientRequestId = generateExpenseClientRequestId();
    await expectCallableErrorCode(
      recordSharedStashExpense({
        tripId: fixture.tripId,
        amountMinor: 101,
        currency: "USD",
        description: "5C.4 insufficient ownership attempt",
        clientRequestId,
      }),
      "functions/failed-precondition"
    );
    await expectZeroPartialSpendMutation(fixture.tripId, clientRequestId, before);
    expect((await inspectTrip(fixture.tripId))?.ownershipModelState).toBe("initialized");
    console.log("PASS 5C.4 genuine insufficient ownership denied");
  });

  it("rejects a malformed amount", async () => {
    const fixture = await createAcceptedTwoMemberTrip("sss-malformed-amount");
    await signInAs(fixture.owner.email);

    const before = await captureFinancialSnapshot(fixture.tripId);
    const clientRequestId = generateExpenseClientRequestId();
    await expectCallableErrorCode(
      recordSharedStashExpense({
        tripId: fixture.tripId,
        amountMinor: 0,
        currency: "USD",
        description: "5C.4 malformed amount attempt",
        clientRequestId,
      }),
      "functions/invalid-argument"
    );
    await expectZeroPartialSpendMutation(fixture.tripId, clientRequestId, before);
    console.log("PASS 5C.4 malformed amount denied");
  });
});

describe("5C.4 - existing aggregate/ownership drift detection", () => {
  it("rejects a drifted Trip and flags it needs_reconciliation, with zero financial mutation", async () => {
    // This IS in 5C.4 scope because recordSharedStashExpense already
    // implements this detection - the trusted setup below constructs
    // ONLY the otherwise-unreachable drifted precondition; the operation
    // under test is the real callable (see ownershipInspection.ts's own
    // frozen-scope documentation for setTripLedgerBalanceDrift). This
    // pattern is never reused for 5C.5.
    const fixture = await createAcceptedTwoMemberTrip("sss-drift");
    await signInAs(fixture.owner.email);
    await contributeReal(fixture.tripId, fixture.owner.uid, 900);
    await setTripLedgerBalanceDrift(fixture.tripId, 1000);

    // The drifted precondition itself (ledger=1000, ownership-sum=900)
    // is captured as "before" - the ownershipModelState transition this
    // call itself causes is the ONE expected state change, asserted
    // separately below rather than folded into the generic zero-
    // mutation helper (which would wrongly require the Trip document to
    // be byte-identical afterward).
    const before = await captureFinancialSnapshot(fixture.tripId);
    expect(before.ledgerBalanceMinor).toBe(1000);
    expect(before.ownership).toEqual([{uid: fixture.owner.uid, ownershipMinor: 900}]);

    const clientRequestId = generateExpenseClientRequestId();
    await expectCallableErrorCode(
      recordSharedStashExpense({
        tripId: fixture.tripId,
        amountMinor: 100,
        currency: "USD",
        description: "5C.4 drift detection attempt",
        clientRequestId,
      }),
      "functions/failed-precondition"
    );

    const after = await captureFinancialSnapshot(fixture.tripId);
    const tripAfter = await inspectTrip(fixture.tripId);
    expect(tripAfter?.ownershipModelState).toBe("needs_reconciliation");
    expect(after.ledgerBalanceMinor).toBe(before.ledgerBalanceMinor);
    expect(after.ownership).toEqual(before.ownership);
    expect(await inspectExpense(clientRequestId)).toBeUndefined();
    expect(await findSavingsTransactionsLinkedToExpense(clientRequestId)).toEqual([]);
    expect(await findOwnershipAllocationsForExpense(clientRequestId)).toEqual([]);
    console.log("PASS 5C.4 existing drift detection");
  });
});

// Closes the real Firestore client's long-polling WebChannel connection
// and the separate @firebase/rules-unit-testing environment's own
// Firestore connection - without this, Jest reports unstopped
// asynchronous operations and the wrapping `emulators:exec` process
// never exits after the test run itself has otherwise fully passed.
afterAll(async () => {
  await cleanupTrustedInspectionEnv();
  await cleanupDemoFirebaseInstances();
});
