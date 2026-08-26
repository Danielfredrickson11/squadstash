// Pure savings-balance calculations for the Milestone 2B ledger. No
// Firestore, no UI, no framework imports - only the canonical
// SavingsTransaction domain type and plain arithmetic on integer minor
// units. See src/types/domain/savingsTransaction.ts for the persisted
// shape these functions consume.
import type { SavingsTransaction } from "../types/domain/savingsTransaction";

// The mathematical sign a single transaction contributes to any savings
// sum: a contribution adds, a withdrawal subtracts. `reversalOf` is
// deliberately never inspected here - a reversal is just an ordinary
// transaction of the opposite type and equal amount, and that alone is
// what makes it net to zero when summed (see deriveSavingsBalanceMinor).
export function getSignedSavingsAmountMinor(
  transaction: SavingsTransaction
): number {
  return transaction.type === "contribution"
    ? transaction.amountMinor
    : -transaction.amountMinor;
}

// Resource-level derived savings balance:
//   openingBalanceMinor + sum(contributions) - sum(withdrawals)
//
// openingBalanceMinor is a neutral, resource-level legacy starting point
// (see Bucket.ledgerOpeningBalanceMinor / Trip.ledgerOpeningBalanceMinor)
// - it belongs to the resource as a whole, never to any individual
// member, which is why it is a separate parameter here rather than a
// transaction in the list.
//
// Reversals are not special-cased: a reversal is an ordinary transaction
// of the opposite type and equal amount, so it naturally cancels its
// original's contribution to this sum through getSignedSavingsAmountMinor
// alone.
//
// This function never clamps its result. A transaction history whose
// withdrawals exceed what was contributed (plus any opening balance)
// produces a negative number - that is a deliberately exposed indication
// of invalid/corrupted history, not something this calculation hides.
// Preventing that from happening in practice is the future write layer's
// job, not this function's.
export function deriveSavingsBalanceMinor(
  transactions: readonly SavingsTransaction[],
  openingBalanceMinor = 0
): number {
  return transactions.reduce(
    (total, transaction) => total + getSignedSavingsAmountMinor(transaction),
    openingBalanceMinor
  );
}

// Per-member derived savings balance: sum of only the given member's own
// contributions minus their own withdrawals. Deliberately excludes any
// resource-level openingBalanceMinor - an opening balance is never
// attributable to a specific member (there is no record of who
// historically contributed it), so summing every member's balance will
// not, in general, equal deriveSavingsBalanceMinor's result whenever a
// resource has a nonzero opening balance. That gap is intentional.
export function deriveMemberSavingsBalanceMinor(
  transactions: readonly SavingsTransaction[],
  memberUid: string
): number {
  return transactions
    .filter((transaction) => transaction.memberUid === memberUid)
    .reduce(
      (total, transaction) => total + getSignedSavingsAmountMinor(transaction),
      0
    );
}
