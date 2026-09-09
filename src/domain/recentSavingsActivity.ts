// Pure merge/truncate helper for Home's cross-bucket Recent Activity
// feed (Milestone 3 Checkpoint 3E). Home fans out one bounded, per-bucket
// subscribeToRecentSavingsTransactionsForResource listener per Personal
// Savings bucket (see src/services/firebase/savingsTransactions.ts) -
// this function only combines whatever those listeners have already
// delivered into one newest-first, capped list. It never reads
// Firestore, never derives a balance, and never re-implements any of
// src/domain/savingsBalance.ts's or savingsGoal.ts's logic.
//
// createdAt is never missing/pending here: SavingsTransaction.createdAt
// (src/types/domain/savingsTransaction.ts) is a required
// PersistedTimestamp populated server-side by the trusted
// recordSavingsTransaction callable before a client ever observes the
// document via onSnapshot - there is no client-side optimistic write
// path for this collection that could leave it as a pending
// serverTimestamp() sentinel.
import type { SavingsTransaction } from "../types/domain";

export function mergeRecentSavingsTransactions(
  perBucketTransactions: SavingsTransaction[][],
  limitCount: number
): SavingsTransaction[] {
  const sorted = perBucketTransactions.flat().sort((a, b) => {
    const byTime = b.createdAt.toMillis() - a.createdAt.toMillis();
    if (byTime !== 0) return byTime;
    // Deterministic tiebreaker for same-millisecond transactions,
    // mirroring the __name__ DESC tiebreaker Firestore appends to the
    // deployed savingsTransactions composite index.
    return b.id.localeCompare(a.id);
  });

  return sorted.slice(0, Math.max(0, limitCount));
}
