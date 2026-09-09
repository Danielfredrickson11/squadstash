import { mergeRecentSavingsTransactions } from "../recentSavingsActivity";
import type { PersistedTimestamp } from "../../types/domain/common";
import type { Contribution, Withdrawal } from "../../types/domain/savingsTransaction";

// firebase/firestore's real Timestamp class doesn't transform cleanly as
// a value import under this project's jest-expo config (see the identical
// fixture in src/domain/__tests__/savingsBalance.test.ts) - this fixture
// implements PersistedTimestamp's actual public shape directly for a
// given millis value, since mergeRecentSavingsTransactions only ever
// calls toMillis().
function makeTimestamp(millis: number): PersistedTimestamp {
  return {
    seconds: Math.floor(millis / 1000),
    nanoseconds: 0,
    toDate: () => new Date(millis),
    toMillis: () => millis,
    isEqual: (other) => other.toMillis() === millis,
    toString: () => `Timestamp(millis=${millis})`,
    toJSON: () => ({
      seconds: Math.floor(millis / 1000),
      nanoseconds: 0,
      type: "firestore/timestamp/1.0",
    }),
    valueOf: () => String(millis),
  };
}

function makeContribution(id: string, resourceId: string, millis: number): Contribution {
  return {
    id,
    type: "contribution",
    resourceType: "bucket",
    resourceId,
    memberUid: "member-1",
    recordedBy: "member-1",
    amountMinor: 1000,
    currency: "USD",
    createdAt: makeTimestamp(millis),
    reversalOf: null,
  };
}

function makeWithdrawal(id: string, resourceId: string, millis: number): Withdrawal {
  return {
    id,
    type: "withdrawal",
    resourceType: "bucket",
    resourceId,
    memberUid: "member-1",
    recordedBy: "member-1",
    amountMinor: 500,
    currency: "USD",
    createdAt: makeTimestamp(millis),
    reversalOf: null,
  };
}

describe("mergeRecentSavingsTransactions", () => {
  it("merges transactions from multiple buckets into one list", () => {
    const bucketA = [makeContribution("a1", "bucket-a", 100)];
    const bucketB = [makeWithdrawal("b1", "bucket-b", 200)];

    const result = mergeRecentSavingsTransactions([bucketA, bucketB], 5);

    expect(result.map((t) => t.id)).toEqual(["b1", "a1"]);
  });

  it("orders newest-first by createdAt across buckets", () => {
    const bucketA = [
      makeContribution("a1", "bucket-a", 100),
      makeContribution("a2", "bucket-a", 300),
    ];
    const bucketB = [makeWithdrawal("b1", "bucket-b", 200)];

    const result = mergeRecentSavingsTransactions([bucketA, bucketB], 5);

    expect(result.map((t) => t.id)).toEqual(["a2", "b1", "a1"]);
  });

  it("truncates to at most limitCount entries", () => {
    const bucketA = [
      makeContribution("a1", "bucket-a", 100),
      makeContribution("a2", "bucket-a", 200),
      makeContribution("a3", "bucket-a", 300),
    ];

    const result = mergeRecentSavingsTransactions([bucketA], 2);

    expect(result.map((t) => t.id)).toEqual(["a3", "a2"]);
  });

  it("returns an empty array for empty input", () => {
    expect(mergeRecentSavingsTransactions([], 5)).toEqual([]);
    expect(mergeRecentSavingsTransactions([[], []], 5)).toEqual([]);
  });

  it("returns fewer than limitCount entries when fewer exist", () => {
    const bucketA = [makeContribution("a1", "bucket-a", 100)];

    const result = mergeRecentSavingsTransactions([bucketA], 5);

    expect(result.map((t) => t.id)).toEqual(["a1"]);
  });

  it("breaks equal-timestamp ties deterministically by id, descending", () => {
    const bucketA = [makeContribution("a1", "bucket-a", 500)];
    const bucketB = [makeWithdrawal("a2", "bucket-b", 500)];

    const result = mergeRecentSavingsTransactions([bucketA, bucketB], 5);

    expect(result.map((t) => t.id)).toEqual(["a2", "a1"]);
  });

  it("never returns more than limitCount even with a non-positive limit", () => {
    const bucketA = [makeContribution("a1", "bucket-a", 100)];

    expect(mergeRecentSavingsTransactions([bucketA], 0)).toEqual([]);
    expect(mergeRecentSavingsTransactions([bucketA], -1)).toEqual([]);
  });
});
