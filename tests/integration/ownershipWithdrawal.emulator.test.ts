// Milestone 5C.5 - the real, local, emulator-backed integration proof of
// Ownership-Based Withdrawals, per the frozen docs/audits/
// MULTI_MEMBER_SPENDING_WITHDRAWAL_PREFLIGHT_2026-10-20.md. Every Trip/
// terms/invitation/acceptance/contribution/withdrawal in this file goes
// through the REAL production client service wrappers and the REAL
// Functions Emulator - never a mock, never a directly-invoked Core
// function. The canonical two-member fixture is always built through
// tests/integration/helpers/financialFixtures.ts's real-callable
// sequencing - never manually-seeded memberIds or ownership rows.
//
// Per the frozen preflight §17/§26: this file deliberately does NOT
// construct an aggregate-vs-ownership drift fixture anywhere - that
// scenario is mathematically unreachable in a healthy, reconciled Trip
// once the personal ownership ceiling has already passed, and is
// explicitly deferred to 5C.6. The only trusted-setup calls used here
// are migrating/needs_reconciliation/archived state construction (see
// tests/integration/helpers/ownershipInspection.ts's own frozen-scope
// header) - never the drift helper 5C.4's own drift-detection test uses.
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
  withdrawReal,
} from "./helpers/financialFixtures";
import {
  inspectOwnership,
  inspectOwnershipBalancesForTrip,
  inspectSavingsTransaction,
  setTripArchived,
  setTripOwnershipModelState,
} from "./helpers/ownershipInspection";
import {
  generateSavingsClientRequestId,
  recordSavingsTransaction,
} from "../../src/services/firebase/savingsTransactions";

// Milestone 5C.4+5C.5 isolation/assertion-hardening pass - mirrors
// sharedStashSpending.emulator.test.ts's own snapshot/assertion pattern,
// proving the FULL frozen zero-partial-mutation requirement on a
// rejected recordSavingsTransaction withdrawal, not merely one
// ownership row. Deliberately never constructs an aggregate/ownership
// drift here (see the file header) - only healthy-state rejections use
// this helper.
type FinancialSnapshot = {
  ledgerBalanceMinor: unknown;
  ownership: {uid: string; ownershipMinor: number}[];
};

async function captureFinancialSnapshot(tripId: string): Promise<FinancialSnapshot> {
  const trip = await inspectTrip(tripId);
  const ownership = await inspectOwnershipBalancesForTrip(tripId);
  return {ledgerBalanceMinor: trip?.ledgerBalanceMinor, ownership};
}

async function expectZeroPartialWithdrawalMutation(
  tripId: string,
  clientRequestId: string,
  before: FinancialSnapshot
): Promise<void> {
  const after = await captureFinancialSnapshot(tripId);
  expect(after.ledgerBalanceMinor).toBe(before.ledgerBalanceMinor);
  expect(after.ownership).toEqual(before.ownership);
  expect(await inspectSavingsTransaction(clientRequestId)).toBeUndefined();
}

describe("5C.5 - zero ownership after acceptance", () => {
  it("rejects a positive withdrawal from an absent ownership row, never creating one", async () => {
    const fixture = await createAcceptedTwoMemberTrip("ow-zero");

    // Proves financial authorization exists (real acceptance already
    // added the member to memberIds) while economic ownership is
    // genuinely zero/absent - the direct link from the 5C.3D membership
    // proof to the ownership model's own zero-ownership handling.
    const tripAfterAcceptance = await inspectTrip(fixture.tripId);
    expect((tripAfterAcceptance?.memberIds as string[]).includes(fixture.member.uid)).toBe(true);
    expect(await inspectOwnership(fixture.tripId, fixture.member.uid)).toBeUndefined();

    await signInAs(fixture.member.email);
    const before = await captureFinancialSnapshot(fixture.tripId);
    const clientRequestId = generateSavingsClientRequestId();
    await expectCallableErrorCode(
      recordSavingsTransaction({
        resourceType: "trip",
        resourceId: fixture.tripId,
        memberUid: fixture.member.uid,
        type: "withdrawal",
        amountMinor: 1,
        currency: "USD",
        clientRequestId,
      }),
      "functions/failed-precondition"
    );

    await expectZeroPartialWithdrawalMutation(fixture.tripId, clientRequestId, before);
    expect(await inspectOwnership(fixture.tripId, fixture.member.uid)).toBeUndefined();
    console.log("PASS 5C.5 zero ownership after acceptance");
  });
});

describe("5C.5 - lazy first contribution", () => {
  it("creates the ownership row lazily at the contributed amount", async () => {
    const fixture = await createAcceptedTwoMemberTrip("ow-lazy");
    await signInAs(fixture.member.email);
    const result = await contributeReal(fixture.tripId, fixture.member.uid, 3000);
    expect(result.balanceMinor).toBe(3000);

    expect((await inspectOwnership(fixture.tripId, fixture.member.uid))?.ownershipMinor).toBe(3000);
    expect((await inspectTrip(fixture.tripId))?.ledgerBalanceMinor).toBe(3000);
    console.log("PASS 5C.5 lazy first contribution");
  });
});

describe("5C.5 - normal withdrawal", () => {
  it("decreases only the withdrawing member's ownership and the Trip aggregate", async () => {
    const fixture = await createAcceptedTwoMemberTrip("ow-normal");
    await signInAs(fixture.owner.email);
    await contributeReal(fixture.tripId, fixture.owner.uid, 7000);
    await signInAs(fixture.member.email);
    await contributeReal(fixture.tripId, fixture.member.uid, 3000);

    const result = await withdrawReal(fixture.tripId, fixture.member.uid, 1200);
    expect(result.balanceMinor).toBe(8800);

    expect((await inspectOwnership(fixture.tripId, fixture.owner.uid))?.ownershipMinor).toBe(7000);
    expect((await inspectOwnership(fixture.tripId, fixture.member.uid))?.ownershipMinor).toBe(1800);
    const tripAfter = await inspectTrip(fixture.tripId);
    expect(tripAfter?.ledgerBalanceMinor).toBe(8800);
    expect(tripAfter?.ownershipModelState).toBe("initialized");

    const txn = await inspectSavingsTransaction(result.transactionId);
    expect(txn?.resourceType).toBe("trip");
    expect(txn?.resourceId).toBe(fixture.tripId);
    expect(txn?.memberUid).toBe(fixture.member.uid);
    expect(txn?.recordedBy).toBe(fixture.member.uid);
    expect(txn?.type).toBe("withdrawal");
    expect(txn?.amountMinor).toBe(1200);
    expect(txn?.currency).toBe("USD");
    console.log("PASS 5C.5 normal withdrawal");
  });
});

describe("5C.5 - exact ownership ceiling", () => {
  it("permits withdrawing exactly the full ownership and keeps the row at zero", async () => {
    const fixture = await createAcceptedTwoMemberTrip("ow-exact-ceiling");
    await signInAs(fixture.member.email);
    await contributeReal(fixture.tripId, fixture.member.uid, 100);

    const result = await withdrawReal(fixture.tripId, fixture.member.uid, 100);
    expect(result.balanceMinor).toBe(0);

    const row = await inspectOwnership(fixture.tripId, fixture.member.uid);
    expect(row).toBeDefined();
    expect(row?.ownershipMinor).toBe(0);
    expect((await inspectTrip(fixture.tripId))?.ledgerBalanceMinor).toBe(0);
    console.log("PASS 5C.5 exact ownership ceiling");
  });
});

describe("5C.5 - ownership plus one", () => {
  it("rejects a withdrawal one minor unit over ownership, with zero mutation", async () => {
    const fixture = await createAcceptedTwoMemberTrip("ow-plus-one");
    // Aggregate stays >= 100 and exactly consistent with the sum of real
    // ownership (500 + 100 = 600) - never a constructed drift.
    await signInAs(fixture.owner.email);
    await contributeReal(fixture.tripId, fixture.owner.uid, 500);
    await signInAs(fixture.member.email);
    await contributeReal(fixture.tripId, fixture.member.uid, 100);

    const before = await captureFinancialSnapshot(fixture.tripId);
    const clientRequestId = generateSavingsClientRequestId();
    await expectCallableErrorCode(
      recordSavingsTransaction({
        resourceType: "trip",
        resourceId: fixture.tripId,
        memberUid: fixture.member.uid,
        type: "withdrawal",
        amountMinor: 101,
        currency: "USD",
        clientRequestId,
      }),
      "functions/failed-precondition"
    );

    await expectZeroPartialWithdrawalMutation(fixture.tripId, clientRequestId, before);
    console.log("PASS 5C.5 ownership plus one denied");
  });
});

describe("5C.5 - no owner override", () => {
  it("rejects the owner attempting to withdraw the member's own ownership", async () => {
    const fixture = await createAcceptedTwoMemberTrip("ow-no-override");
    await signInAs(fixture.member.email);
    await contributeReal(fixture.tripId, fixture.member.uid, 1000);

    await signInAs(fixture.owner.email);
    const before = await captureFinancialSnapshot(fixture.tripId);
    const clientRequestId = generateSavingsClientRequestId();
    await expectCallableErrorCode(
      recordSavingsTransaction({
        resourceType: "trip",
        resourceId: fixture.tripId,
        memberUid: fixture.member.uid,
        type: "withdrawal",
        amountMinor: 100,
        currency: "USD",
        clientRequestId,
      }),
      "functions/permission-denied"
    );

    await expectZeroPartialWithdrawalMutation(fixture.tripId, clientRequestId, before);
    console.log("PASS 5C.5 no owner override");
  });
});

describe("5C.5 - outsider and invited-only withdrawal denial", () => {
  it("rejects an outsider's self-withdrawal attempt", async () => {
    const fixture = await createAcceptedTwoMemberTrip("ow-outsider");
    const outsider = await createAndSignInUser("ow-outsider-caller");
    await signInAs(outsider.email);

    const before = await captureFinancialSnapshot(fixture.tripId);
    const clientRequestId = generateSavingsClientRequestId();
    await expectCallableErrorCode(
      recordSavingsTransaction({
        resourceType: "trip",
        resourceId: fixture.tripId,
        memberUid: outsider.uid,
        type: "withdrawal",
        amountMinor: 1,
        currency: "USD",
        clientRequestId,
      }),
      "functions/permission-denied"
    );
    await expectZeroPartialWithdrawalMutation(fixture.tripId, clientRequestId, before);
    console.log("PASS 5C.5 outsider withdrawal denied");
  });

  it("rejects an invited-but-not-accepted user's self-withdrawal attempt", async () => {
    const owner = await createAndSignInUser("ow-invited-owner");
    const invitee = await createAndSignInUser("ow-invited-invitee");
    const setup = await setupOwnerTripTermsInvitation({
      ownerEmail: owner.email,
      inviteeEmail: invitee.email,
      scenarioLabel: "ow-invited-not-accepted",
    });
    await signInAs(invitee.email);

    const before = await captureFinancialSnapshot(setup.tripId);
    const clientRequestId = generateSavingsClientRequestId();
    await expectCallableErrorCode(
      recordSavingsTransaction({
        resourceType: "trip",
        resourceId: setup.tripId,
        memberUid: invitee.uid,
        type: "withdrawal",
        amountMinor: 1,
        currency: "USD",
        clientRequestId,
      }),
      "functions/permission-denied"
    );
    await expectZeroPartialWithdrawalMutation(setup.tripId, clientRequestId, before);
    console.log("PASS 5C.5 invited-but-not-accepted withdrawal denied");
  });
});

describe("5C.5 - migrating and needs_reconciliation withdrawal denial", () => {
  it("rejects a new withdrawal while migrating", async () => {
    const fixture = await createAcceptedTwoMemberTrip("ow-migrating");
    await signInAs(fixture.member.email);
    await contributeReal(fixture.tripId, fixture.member.uid, 1000);
    await setTripOwnershipModelState(fixture.tripId, "migrating");

    const before = await captureFinancialSnapshot(fixture.tripId);
    const clientRequestId = generateSavingsClientRequestId();
    await expectCallableErrorCode(
      recordSavingsTransaction({
        resourceType: "trip",
        resourceId: fixture.tripId,
        memberUid: fixture.member.uid,
        type: "withdrawal",
        amountMinor: 100,
        currency: "USD",
        clientRequestId,
      }),
      "functions/failed-precondition"
    );
    await expectZeroPartialWithdrawalMutation(fixture.tripId, clientRequestId, before);
    expect((await inspectTrip(fixture.tripId))?.ownershipModelState).toBe("migrating");
    console.log("PASS 5C.5 migrating withdrawal denied");
  });

  it("rejects a new withdrawal while needs_reconciliation", async () => {
    const fixture = await createAcceptedTwoMemberTrip("ow-needsrecon");
    await signInAs(fixture.member.email);
    await contributeReal(fixture.tripId, fixture.member.uid, 1000);
    await setTripOwnershipModelState(fixture.tripId, "needs_reconciliation");

    const before = await captureFinancialSnapshot(fixture.tripId);
    const clientRequestId = generateSavingsClientRequestId();
    await expectCallableErrorCode(
      recordSavingsTransaction({
        resourceType: "trip",
        resourceId: fixture.tripId,
        memberUid: fixture.member.uid,
        type: "withdrawal",
        amountMinor: 100,
        currency: "USD",
        clientRequestId,
      }),
      "functions/failed-precondition"
    );
    await expectZeroPartialWithdrawalMutation(fixture.tripId, clientRequestId, before);
    expect((await inspectTrip(fixture.tripId))?.ownershipModelState).toBe("needs_reconciliation");
    console.log("PASS 5C.5 needs_reconciliation withdrawal denied");
  });
});

describe("5C.5 - archived Trip withdrawal wind-down", () => {
  it("permits a valid self-withdrawal from an archived Trip", async () => {
    const fixture = await createAcceptedTwoMemberTrip("ow-archived");
    await signInAs(fixture.owner.email);
    await contributeReal(fixture.tripId, fixture.owner.uid, 7000);
    await signInAs(fixture.member.email);
    await contributeReal(fixture.tripId, fixture.member.uid, 3000);

    await setTripArchived(fixture.tripId);

    const result = await withdrawReal(fixture.tripId, fixture.member.uid, 1000);
    expect(result.balanceMinor).toBe(9000);

    expect((await inspectOwnership(fixture.tripId, fixture.member.uid))?.ownershipMinor).toBe(2000);
    expect((await inspectOwnership(fixture.tripId, fixture.owner.uid))?.ownershipMinor).toBe(7000);
    expect((await inspectTrip(fixture.tripId))?.ledgerBalanceMinor).toBe(9000);

    const txn = await inspectSavingsTransaction(result.transactionId);
    expect(txn?.type).toBe("withdrawal");
    expect(txn?.amountMinor).toBe(1000);
    console.log("PASS 5C.5 archived Trip withdrawal wind-down");
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
