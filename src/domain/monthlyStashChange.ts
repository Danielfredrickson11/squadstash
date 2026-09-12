// Pure, client-side "Total Stashed vs. last month" calculation
// (Milestone 3 Checkpoint 3F.3A.2). No Firestore, no UI, no framework
// imports - only plain arithmetic on integer minor units plus the
// existing SavingsTransaction sign convention from savingsBalance.ts.
//
// ==========================================================================
// WHAT THIS METRIC IS AND WHY IT IS ACCURATE
// ==========================================================================
// This is a BALANCE-CHANGE metric: how much the user's current real
// Personal Savings total changed since the end of the previous calendar
// month. It is NOT a contribution count, NOT current-month deposits only,
// and NOT any kind of investment return - it is exactly
// currentTotal - previousMonthEndTotal.
//
// previousMonthEndTotal is reconstructed per bucket as:
//   currentBalanceMinor - sum(signed amounts of every transaction for
//                             that bucket with createdAt >= this month's
//                             local start)
// which is exact for any bucket that already existed before the current
// month started: undoing every transaction that happened this month
// necessarily recovers the balance the bucket held the instant before
// this month began, regardless of how large its opening balance was or
// when it was set, because that opening balance is already fully baked
// into the ledger balance from before this month and is never touched by
// undoing only this month's deltas.
//
// A bucket CREATED during the current month is a special case, handled
// by reconstructPreviousMonthEndTotalMinor below: it contributes exactly
// 0 to previousMonthEndTotal, never its startingBalanceMinor - the
// bucket genuinely did not exist in the user's Personal Savings before
// this month, no matter what starting balance it was given this month.
// (A bucket's starting balance is set directly on creation and is
// deliberately NOT its own savingsTransactions ledger entry - see
// functions/src/callables/createBucket.ts - but that never matters for
// THIS reconstruction, because a bucket created this month is excluded
// entirely rather than walked backward past its own creation.)
//
// KNOWN, DOCUMENTED SCOPE LIMITATION: a bucket that was DELETED at any
// point is excluded from both the current total and this reconstruction,
// because deletion (Bucket.deleteBucket) is a hard, un-audited Firestore
// delete with no tombstone/archive trail anywhere in the trusted backend
// - there is no data left to reconstruct what it held. This metric is
// therefore precisely "change in total balance across the Personal
// Savings buckets you currently have" - internally consistent (both
// sides of the comparison use the same currently-existing-bucket
// universe Home's current total already uses), but not a true ledger of
// every dollar that ever passed through a since-deleted bucket. No
// schema/backend change exists today that would close this gap.
import { getSignedSavingsAmountMinor } from "./savingsBalance";
import type { SavingsTransaction } from "../types/domain/savingsTransaction";

export type MonthlyChangeDirection = "up" | "down" | "flat";
// "available": a trustworthy percentChange was computed.
// "new": previousMonthEndTotalMinor was 0 and currentTotalMinor > 0 - a
//        percentage would be mathematically undefined (division by
//        zero/Infinity), so render "New this month" instead of a number.
// "unavailable": either the underlying historical fetch failed/was
//        skipped, or both totals are exactly 0 (nothing meaningful to
//        report either way) - the UI must omit the metric entirely
//        rather than invent one.
export type MonthlyChangeStatus = "available" | "new" | "unavailable";

export type MonthlyStashChange = {
  currentTotalMinor: number;
  previousMonthEndTotalMinor: number;
  deltaMinor: number;
  // null whenever status is not "available" - never NaN/Infinity.
  percentChange: number | null;
  direction: MonthlyChangeDirection;
  status: MonthlyChangeStatus;
};

// Local-calendar-month boundary (Checkpoint 3F.3A.2 explicit choice):
// uses `now`'s LOCAL year/month (Date.getFullYear()/getMonth(), the
// device's local timezone), never UTC. "Previous month end" is the
// instant immediately before this local midnight - a transaction with
// createdAt at or after this instant is "this month" and must be
// reversed to reconstruct the previous month's ending balance.
// Deliberately NOT using Date.UTC(...)/toISOString() month math, which
// would silently shift the boundary by the user's UTC offset (e.g. for a
// user west of UTC, late-night local transactions on the last day of a
// month would otherwise be misclassified as "next month" in UTC).
export function getCurrentLocalMonthStart(now: Date = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
}

// Reconstructs previousMonthEndTotalMinor across every CURRENTLY-EXISTING
// bucket Home includes in its Total Stashed sum. `transactionsSinceStart`
// must contain, for each bucket, every one of ITS OWN transactions with
// createdAt >= monthStart (a bounded query - see
// fetchSavingsTransactionsSinceForResources) - a partial/truncated list
// for any bucket would silently under-reverse that bucket and produce a
// wrong number, so callers must never pass a count-limited fetch here.
export function reconstructPreviousMonthEndTotalMinor(
  buckets: readonly {
    id: string;
    currentBalanceMinor: number;
    // Bucket.createdAt, already converted to a plain Date - null/
    // undefined (legacy documents with no createdAt) is treated as
    // "existed before this month", the only safe assumption when a
    // bucket's real creation date is unknown (a bucket old enough to
    // predate createdAt tracking cannot have been created this month).
    createdAt: Date | null | undefined;
  }[],
  transactionsSinceStart: Readonly<Record<string, readonly SavingsTransaction[]>>,
  monthStart: Date
): number {
  return buckets.reduce((sum, bucket) => {
    const createdThisMonthOrLater =
      bucket.createdAt != null && bucket.createdAt.getTime() >= monthStart.getTime();

    if (createdThisMonthOrLater) {
      // Did not exist in the user's Personal Savings before this month -
      // contributes exactly 0, regardless of any starting balance it was
      // given at creation this month (see the module comment above).
      return sum;
    }

    const txns = transactionsSinceStart[bucket.id] ?? [];
    const reversedMinor = txns.reduce(
      (acc, txn) => acc + getSignedSavingsAmountMinor(txn),
      0
    );
    return sum + (bucket.currentBalanceMinor - reversedMinor);
  }, 0);
}

// Combines an already-computed currentTotalMinor/previousMonthEndTotalMinor
// pair into the final presentation-ready result. `historyAvailable`
// (default true) lets a caller whose bounded historical fetch failed
// force status "unavailable" without fabricating a 0 previous total that
// would otherwise be misread as "New this month".
export function computeMonthlyStashChange(params: {
  currentTotalMinor: number;
  previousMonthEndTotalMinor: number;
  historyAvailable?: boolean;
}): MonthlyStashChange {
  const { currentTotalMinor, previousMonthEndTotalMinor } = params;
  const historyAvailable = params.historyAvailable ?? true;
  const deltaMinor = currentTotalMinor - previousMonthEndTotalMinor;

  if (!historyAvailable) {
    return {
      currentTotalMinor,
      previousMonthEndTotalMinor,
      deltaMinor,
      percentChange: null,
      direction: "flat",
      status: "unavailable",
    };
  }

  if (previousMonthEndTotalMinor === 0) {
    if (currentTotalMinor === 0) {
      // Nothing existed either month - no meaningful percentage either
      // way (not "New", since nothing was actually added).
      return {
        currentTotalMinor,
        previousMonthEndTotalMinor,
        deltaMinor: 0,
        percentChange: null,
        direction: "flat",
        status: "unavailable",
      };
    }
    return {
      currentTotalMinor,
      previousMonthEndTotalMinor,
      deltaMinor,
      percentChange: null,
      direction: "up",
      status: "new",
    };
  }

  const percentChange = (deltaMinor / previousMonthEndTotalMinor) * 100;
  const direction: MonthlyChangeDirection =
    deltaMinor > 0 ? "up" : deltaMinor < 0 ? "down" : "flat";

  return {
    currentTotalMinor,
    previousMonthEndTotalMinor,
    deltaMinor,
    percentChange,
    direction,
    status: "available",
  };
}
