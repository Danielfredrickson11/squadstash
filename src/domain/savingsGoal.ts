// Pure Personal Savings goal/progress calculations (Milestone 3
// Checkpoint 3D). No Firestore, no UI - only plain arithmetic on a
// resource's trusted display fields (Bucket.balance / Bucket.target,
// already dollar-denominated display values derived from the trusted
// ledger elsewhere - see src/domain/savingsBalance.ts for the minor-unit
// ledger math itself). Extracted here because the same three
// calculations were previously duplicated between
// components/buckets/BucketCard.tsx and app/(tabs)/buckets/[bucketId].tsx.
//
// Goal Reached is deliberately derived, never persisted: it is always
// exactly `balance >= target` for the CURRENT balance, so a later
// withdrawal that drops the balance back below target makes the goal
// "un-reached" automatically, with no stored completion flag to clean up
// or reverse (see Checkpoint 3D's requirements).

// True once a Bucket's current saved amount has met or exceeded its
// target. A non-positive target never counts as "reached" - there is
// nothing to reach.
export function isGoalReached(balance: number, target: number): boolean {
  return target > 0 && balance >= target;
}

// Progress toward the goal, clamped to [0, 1] - saved amounts beyond the
// target still report 100% here rather than overflowing past 1, since
// every progress-bar consumer in this app expects a 0..1 value. The
// underlying saved balance itself is never truncated to the target
// anywhere - this function only affects the progress VISUALIZATION.
export function clampProgress(balance: number, target: number): number {
  if (target <= 0) return 0;
  return Math.max(0, Math.min(balance / target, 1));
}

// Amount still needed to reach the goal, floored at 0 - once the target
// is met or exceeded, remaining is always exactly 0, never negative.
export function remainingToGoal(balance: number, target: number): number {
  return Math.max(target - balance, 0);
}
