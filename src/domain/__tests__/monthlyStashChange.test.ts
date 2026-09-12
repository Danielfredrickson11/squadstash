import {
  computeMonthlyStashChange,
  getCurrentLocalMonthStart,
  reconstructPreviousMonthEndTotalMinor,
} from "../monthlyStashChange";
import type { PersistedTimestamp } from "../../types/domain/common";
import type { Contribution, Withdrawal } from "../../types/domain/savingsTransaction";

// Mirrors src/domain/__tests__/savingsBalance.test.ts's own fixture -
// firebase/firestore's real Timestamp class doesn't transform cleanly as
// a value import under this project's jest-expo config, and nothing
// under test here ever reads a transaction's `createdAt` value itself
// (reconstructPreviousMonthEndTotalMinor trusts the caller's own
// since-month-start bucketing), so this fixture implements
// PersistedTimestamp's public shape directly rather than importing the
// class or reaching for a cast.
const FIXTURE_CREATED_AT: PersistedTimestamp = {
  seconds: 0,
  nanoseconds: 0,
  toDate: () => new Date(0),
  toMillis: () => 0,
  isEqual: (other) => other.seconds === 0 && other.nanoseconds === 0,
  toString: () => "Timestamp(seconds=0, nanoseconds=0)",
  toJSON: () => ({ seconds: 0, nanoseconds: 0, type: "firestore/timestamp/1.0" }),
  valueOf: () => "0",
};

let nextId = 0;

function makeContribution(amountMinor: number, resourceId = "bucket-1"): Contribution {
  nextId += 1;
  return {
    id: `txn-${nextId}`,
    type: "contribution",
    resourceType: "bucket",
    resourceId,
    memberUid: "member-1",
    recordedBy: "member-1",
    amountMinor,
    currency: "USD",
    createdAt: FIXTURE_CREATED_AT,
    reversalOf: null,
  };
}

function makeWithdrawal(amountMinor: number, resourceId = "bucket-1"): Withdrawal {
  nextId += 1;
  return {
    id: `txn-${nextId}`,
    type: "withdrawal",
    resourceType: "bucket",
    resourceId,
    memberUid: "member-1",
    recordedBy: "member-1",
    amountMinor,
    currency: "USD",
    createdAt: FIXTURE_CREATED_AT,
    reversalOf: null,
  };
}

describe("getCurrentLocalMonthStart", () => {
  it("returns local midnight on the 1st of the given date's month", () => {
    const now = new Date(2026, 2, 17, 23, 59, 59); // March 17, 2026, local time
    const start = getCurrentLocalMonthStart(now);
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(2); // March (0-indexed)
    expect(start.getDate()).toBe(1);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getSeconds()).toBe(0);
    expect(start.getMilliseconds()).toBe(0);
  });

  it("rolls over correctly across a year boundary (January -> previous December)", () => {
    const now = new Date(2026, 0, 5); // January 5, 2026
    const start = getCurrentLocalMonthStart(now);
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(0); // January
    expect(start.getDate()).toBe(1);
  });

  it("uses local date fields, not UTC month math", () => {
    // A date constructed from local fields must round-trip through
    // getCurrentLocalMonthStart using those same local fields - this
    // guards against an accidental Date.UTC(...)/toISOString() rewrite
    // that would shift the boundary by the runner's UTC offset.
    const now = new Date(2026, 5, 30, 0, 30); // June 30, 2026, 00:30 local
    const start = getCurrentLocalMonthStart(now);
    expect(start.getMonth()).toBe(5); // still June, not shifted to July
  });
});

describe("reconstructPreviousMonthEndTotalMinor", () => {
  const monthStart = new Date(2026, 2, 1); // March 1, 2026

  it("contribution this month is reversed out of the current balance", () => {
    // Balance is now $150 after a $50 contribution this month -> prior
    // month end must have been $100.
    const buckets = [
      { id: "b1", currentBalanceMinor: 15000, createdAt: new Date(2025, 0, 1) },
    ];
    const txnsSinceStart = { b1: [makeContribution(5000, "b1")] };
    expect(
      reconstructPreviousMonthEndTotalMinor(buckets, txnsSinceStart, monthStart)
    ).toBe(10000);
  });

  it("withdrawal this month is reversed (added back) into the current balance", () => {
    // Balance is now $80 after a $20 withdrawal this month -> prior
    // month end must have been $100.
    const buckets = [
      { id: "b1", currentBalanceMinor: 8000, createdAt: new Date(2025, 0, 1) },
    ];
    const txnsSinceStart = { b1: [makeWithdrawal(2000, "b1")] };
    expect(
      reconstructPreviousMonthEndTotalMinor(buckets, txnsSinceStart, monthStart)
    ).toBe(10000);
  });

  it("bucket created this month with $0 opening balance contributes 0, not its current balance", () => {
    const buckets = [
      { id: "b1", currentBalanceMinor: 5000, createdAt: new Date(2026, 2, 15) },
    ];
    // Its only transaction (the $50 first contribution) is naturally
    // "since start" too, but must not matter - creation-this-month wins.
    const txnsSinceStart = { b1: [makeContribution(5000, "b1")] };
    expect(
      reconstructPreviousMonthEndTotalMinor(buckets, txnsSinceStart, monthStart)
    ).toBe(0);
  });

  it("bucket created this month with a NON-ZERO opening balance still contributes 0", () => {
    // Created this month with a $200 starting balance (no ledger
    // transaction represents that starting balance at all) - it did not
    // exist in Personal Savings before this month, so it must not leak
    // its opening balance into previousMonthEndTotal.
    const buckets = [
      { id: "b1", currentBalanceMinor: 20000, createdAt: new Date(2026, 2, 10) },
    ];
    const txnsSinceStart = { b1: [] };
    expect(
      reconstructPreviousMonthEndTotalMinor(buckets, txnsSinceStart, monthStart)
    ).toBe(0);
  });

  it("goal already existing before current month with no transactions this month is unchanged", () => {
    const buckets = [
      { id: "b1", currentBalanceMinor: 42000, createdAt: new Date(2024, 5, 1) },
    ];
    expect(
      reconstructPreviousMonthEndTotalMinor(buckets, { b1: [] }, monthStart)
    ).toBe(42000);
  });

  it("a balance over target does not affect the raw balance math", () => {
    // This function has no notion of "target" at all - included to
    // document that over-target buckets are not special-cased/clamped.
    const buckets = [
      { id: "b1", currentBalanceMinor: 999999, createdAt: new Date(2024, 5, 1) },
    ];
    expect(
      reconstructPreviousMonthEndTotalMinor(buckets, { b1: [] }, monthStart)
    ).toBe(999999);
  });

  it("a bucket with no createdAt (legacy document) is treated as pre-existing", () => {
    const buckets = [{ id: "b1", currentBalanceMinor: 10000, createdAt: null }];
    const txnsSinceStart = { b1: [makeContribution(1000, "b1")] };
    expect(
      reconstructPreviousMonthEndTotalMinor(buckets, txnsSinceStart, monthStart)
    ).toBe(9000);
  });

  it("sums correctly across multiple buckets in mixed states", () => {
    const buckets = [
      { id: "old", currentBalanceMinor: 10000, createdAt: new Date(2024, 0, 1) }, // no txns -> 10000
      { id: "grew", currentBalanceMinor: 15000, createdAt: new Date(2024, 0, 1) }, // +5000 this month -> 10000
      { id: "new", currentBalanceMinor: 30000, createdAt: new Date(2026, 2, 5) }, // created this month -> 0
    ];
    const txnsSinceStart = {
      old: [],
      grew: [makeContribution(5000, "grew")],
      new: [makeContribution(30000, "new")],
    };
    expect(
      reconstructPreviousMonthEndTotalMinor(buckets, txnsSinceStart, monthStart)
    ).toBe(20000);
  });

  it("a bucket with no recorded transactions since start defaults to its current balance unchanged", () => {
    const buckets = [
      { id: "b1", currentBalanceMinor: 7500, createdAt: new Date(2024, 0, 1) },
    ];
    // No entry at all for "b1" in the map (not even an empty array).
    expect(reconstructPreviousMonthEndTotalMinor(buckets, {}, monthStart)).toBe(7500);
  });
});

describe("computeMonthlyStashChange", () => {
  it("positive month-over-month change", () => {
    const result = computeMonthlyStashChange({
      currentTotalMinor: 12000,
      previousMonthEndTotalMinor: 10000,
    });
    expect(result.status).toBe("available");
    expect(result.direction).toBe("up");
    expect(result.deltaMinor).toBe(2000);
    expect(result.percentChange).toBeCloseTo(20);
  });

  it("negative month-over-month change", () => {
    const result = computeMonthlyStashChange({
      currentTotalMinor: 8000,
      previousMonthEndTotalMinor: 10000,
    });
    expect(result.status).toBe("available");
    expect(result.direction).toBe("down");
    expect(result.deltaMinor).toBe(-2000);
    expect(result.percentChange).toBeCloseTo(-20);
  });

  it("no change (flat)", () => {
    const result = computeMonthlyStashChange({
      currentTotalMinor: 10000,
      previousMonthEndTotalMinor: 10000,
    });
    expect(result.status).toBe("available");
    expect(result.direction).toBe("flat");
    expect(result.deltaMinor).toBe(0);
    expect(result.percentChange).toBeCloseTo(0);
  });

  it("previous total 0, current > 0 -> New this month, never Infinity", () => {
    const result = computeMonthlyStashChange({
      currentTotalMinor: 5000,
      previousMonthEndTotalMinor: 0,
    });
    expect(result.status).toBe("new");
    expect(result.percentChange).toBeNull();
    expect(Number.isFinite(result.percentChange ?? 0)).toBe(true);
  });

  it("both totals zero -> unavailable, no misleading percentage", () => {
    const result = computeMonthlyStashChange({
      currentTotalMinor: 0,
      previousMonthEndTotalMinor: 0,
    });
    expect(result.status).toBe("unavailable");
    expect(result.percentChange).toBeNull();
  });

  it("historyAvailable: false forces unavailable regardless of the numbers passed", () => {
    const result = computeMonthlyStashChange({
      currentTotalMinor: 99999,
      previousMonthEndTotalMinor: 1,
      historyAvailable: false,
    });
    expect(result.status).toBe("unavailable");
    expect(result.percentChange).toBeNull();
  });
});
