// Milestone 5C.6 - the real, local, emulator-backed integration proof of
// recordSavingsTransaction's three closed full-set-reconciliation gaps
// (existing-row contribution, existing-row withdrawal, missing-row
// contribution), per the frozen docs/audits/
// MULTI_MEMBER_REVERSAL_RECONCILIATION_PREFLIGHT_2026-10-20.md. Every
// Trip/terms/invitation/acceptance/contribution/withdrawal in this file
// goes through the REAL production client service wrappers and the REAL
// Functions Emulator - never a mock, never a directly-invoked Core
// function. The canonical two-member fixture is always built through
// financialFixtures.ts's real-callable sequencing; only the deliberate
// drift preconditions below use trusted, Rules-bypassing setup (see
// reconciliationFixtures.ts's own frozen-scope header).
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
  corruptOwnershipRowReal,
  createAcceptedTwoMemberTrip,
  deleteOwnershipRowReal,
} from "./helpers/reconciliationFixtures";
import {
  inspectOwnership,
  inspectOwnershipBalancesForTrip,
  inspectSavingsTransaction,
} from "./helpers/ownershipInspection";
import {
  generateSavingsClientRequestId,
  recordSavingsTransaction,
} from "../../src/services/firebase/savingsTransactions";

type FinancialSnapshot = {
  ownershipModelState: unknown;
  ledgerBalanceMinor: unknown;
  ownership: {uid: string; ownershipMinor: number}[];
};

async function captureFinancialSnapshot(tripId: string): Promise<FinancialSnapshot> {
  const trip = await inspectTrip(tripId);
  const ownership = await inspectOwnershipBalancesForTrip(tripId);
  return {
    ownershipModelState: trip?.ownershipModelState,
    ledgerBalanceMinor: trip?.ledgerBalanceMinor,
    ownership,
  };
}

describe("5C.6 - existing-row contribution drift", () => {
  it("rejects with failed-precondition, transitions to needs_reconciliation, and mutates nothing", async () => {
    const fixture = await createAcceptedTwoMemberTrip("5c6-existing-contrib");
    await signInAs(fixture.owner.email);
    await contributeReal(fixture.tripId, fixture.owner.uid, 600);
    await signInAs(fixture.member.email);
    await contributeReal(fixture.tripId, fixture.member.uid, 400);

    // Deliberately desync the member's own ownership cache from the
    // Trip's trusted aggregate - no public client path can do this.
    await corruptOwnershipRowReal(fixture.tripId, fixture.member.uid, 999);

    const before = await captureFinancialSnapshot(fixture.tripId);
    const clientRequestId = generateSavingsClientRequestId();
    await expectCallableErrorCode(
      recordSavingsTransaction({
        resourceType: "trip",
        resourceId: fixture.tripId,
        memberUid: fixture.member.uid,
        type: "contribution",
        amountMinor: 100,
        currency: "USD",
        clientRequestId,
      }),
      "functions/failed-precondition"
    );

    const after = await captureFinancialSnapshot(fixture.tripId);
    expect(after.ownershipModelState).toBe("needs_reconciliation");
    expect(after.ledgerBalanceMinor).toBe(before.ledgerBalanceMinor);
    expect(after.ownership).toEqual(before.ownership);
    expect(await inspectSavingsTransaction(clientRequestId)).toBeUndefined();
  });
});

describe("5C.6 - existing-row withdrawal drift", () => {
  it("rejects with failed-precondition, transitions to needs_reconciliation, and mutates nothing", async () => {
    const fixture = await createAcceptedTwoMemberTrip("5c6-existing-withdraw");
    await signInAs(fixture.owner.email);
    await contributeReal(fixture.tripId, fixture.owner.uid, 600);
    await signInAs(fixture.member.email);
    await contributeReal(fixture.tripId, fixture.member.uid, 400);

    await corruptOwnershipRowReal(fixture.tripId, fixture.member.uid, 999);

    const before = await captureFinancialSnapshot(fixture.tripId);
    const clientRequestId = generateSavingsClientRequestId();
    await expectCallableErrorCode(
      recordSavingsTransaction({
        resourceType: "trip",
        resourceId: fixture.tripId,
        memberUid: fixture.member.uid,
        type: "withdrawal",
        amountMinor: 50,
        currency: "USD",
        clientRequestId,
      }),
      "functions/failed-precondition"
    );

    const after = await captureFinancialSnapshot(fixture.tripId);
    expect(after.ownershipModelState).toBe("needs_reconciliation");
    expect(after.ledgerBalanceMinor).toBe(before.ledgerBalanceMinor);
    expect(after.ownership).toEqual(before.ownership);
    expect(await inspectSavingsTransaction(clientRequestId)).toBeUndefined();
  });
});

describe("5C.6 - missing-row contribution drift (closing the frozen deferral)", () => {
  it("rejects with failed-precondition and now transitions to needs_reconciliation", async () => {
    const fixture = await createAcceptedTwoMemberTrip("5c6-missing-contrib");
    await signInAs(fixture.owner.email);
    await contributeReal(fixture.tripId, fixture.owner.uid, 600);
    await signInAs(fixture.member.email);
    await contributeReal(fixture.tripId, fixture.member.uid, 400);

    // The member genuinely has a row; corrupt and then DELETE it to
    // simulate "contributed once, then the row was corrupted out-of-
    // band" - leaving the Trip's own aggregate inconsistent with the
    // (now-empty) ownership set, with the acting member themself having
    // no row at all when they attempt their NEXT contribution.
    await corruptOwnershipRowReal(fixture.tripId, fixture.member.uid, 0);
    await deleteOwnershipRowReal(fixture.tripId, fixture.member.uid);

    const before = await captureFinancialSnapshot(fixture.tripId);
    const clientRequestId = generateSavingsClientRequestId();
    await expectCallableErrorCode(
      recordSavingsTransaction({
        resourceType: "trip",
        resourceId: fixture.tripId,
        memberUid: fixture.member.uid,
        type: "contribution",
        amountMinor: 100,
        currency: "USD",
        clientRequestId,
      }),
      "functions/failed-precondition"
    );

    const after = await captureFinancialSnapshot(fixture.tripId);
    expect(after.ownershipModelState).toBe("needs_reconciliation");
    expect(after.ledgerBalanceMinor).toBe(before.ledgerBalanceMinor);
    expect(await inspectOwnership(fixture.tripId, fixture.member.uid)).toBeUndefined();
    expect(await inspectSavingsTransaction(clientRequestId)).toBeUndefined();
  });
});

describe("5C.6 - missing-row withdrawal remains unchanged (no new reconciliation scan)", () => {
  it("rejects immediately on a missing row without transitioning the Trip, even with real drift present", async () => {
    const fixture = await createAcceptedTwoMemberTrip("5c6-missing-withdraw");
    await signInAs(fixture.owner.email);
    await contributeReal(fixture.tripId, fixture.owner.uid, 600);
    // The member never contributes - their own row is genuinely absent.
    // Deliberately drift the OWNER's own row so a full-set scan (if one
    // ran) would detect it - proving this path never runs one.
    await corruptOwnershipRowReal(fixture.tripId, fixture.owner.uid, 1);

    await signInAs(fixture.member.email);
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

    const trip = await inspectTrip(fixture.tripId);
    expect(trip?.ownershipModelState).toBe("initialized");
    expect(await inspectOwnership(fixture.tripId, fixture.member.uid)).toBeUndefined();
  });
});

describe("5C.6 - healthy path and replay remain correct", () => {
  it("a healthy (non-drifted) existing-row contribution still succeeds", async () => {
    const fixture = await createAcceptedTwoMemberTrip("5c6-healthy-contrib");
    await signInAs(fixture.owner.email);
    await contributeReal(fixture.tripId, fixture.owner.uid, 600);
    await signInAs(fixture.member.email);
    await contributeReal(fixture.tripId, fixture.member.uid, 400);

    const result = await contributeReal(fixture.tripId, fixture.member.uid, 100);
    expect(result.balanceMinor).toBe(1100);
    expect(await inspectOwnership(fixture.tripId, fixture.member.uid)).toMatchObject({
      ownershipMinor: 500,
    });
  });

  it("an exact replay of an already-committed contribution still resolves after the Trip later becomes needs_reconciliation", async () => {
    const fixture = await createAcceptedTwoMemberTrip("5c6-replay");
    await signInAs(fixture.owner.email);
    await contributeReal(fixture.tripId, fixture.owner.uid, 600);
    await signInAs(fixture.member.email);
    await contributeReal(fixture.tripId, fixture.member.uid, 400);

    const clientRequestId = generateSavingsClientRequestId();
    const request = {
      resourceType: "trip" as const,
      resourceId: fixture.tripId,
      memberUid: fixture.member.uid,
      type: "contribution" as const,
      amountMinor: 50,
      currency: "USD",
      clientRequestId,
    };
    const first = await recordSavingsTransaction(request);

    // Independently drift the Trip into needs_reconciliation (simulating
    // a later, unrelated out-of-band corruption) via this same 5C.6
    // hardening gate, using the existing-row drift the first test above
    // already proved.
    await corruptOwnershipRowReal(fixture.tripId, fixture.owner.uid, 999);
    await signInAs(fixture.owner.email);
    await expectCallableErrorCode(
      recordSavingsTransaction({
        resourceType: "trip",
        resourceId: fixture.tripId,
        memberUid: fixture.owner.uid,
        type: "contribution",
        amountMinor: 1,
        currency: "USD",
        clientRequestId: generateSavingsClientRequestId(),
      }),
      "functions/failed-precondition"
    );
    const trip = await inspectTrip(fixture.tripId);
    expect(trip?.ownershipModelState).toBe("needs_reconciliation");

    // The original request was recorded by the MEMBER - replay must be
    // attempted by that same original caller.
    await signInAs(fixture.member.email);
    const replay = await recordSavingsTransaction(request);
    expect(replay).toEqual(first);
  });
});

afterAll(async () => {
  await cleanupTrustedInspectionEnv();
  await cleanupDemoFirebaseInstances();
});
