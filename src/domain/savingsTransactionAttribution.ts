// Pure display-label resolution for a single savingsTransactions ledger
// entry (Checkpoint 4F.4A), per the approved docs/audits/
// TRIP_SHARED_STASH_EXPENSE_PREFLIGHT_2026-09-30.md §17. No Firestore, no
// React - callers resolve the linked Expense's description (if any)
// themselves and pass it in already-resolved, matching this codebase's
// own established "pass already-resolved display data, never a raw id"
// convention (ExpenseRowPayer, MemberOption, etc.).
//
// `linkedExpenseId`'s presence is the authoritative discriminator that a
// transaction is institutional Shared-Stash-Expense activity, not a
// personal contribution/withdrawal - `memberUid` exists on such a
// transaction only for schema compatibility and is NEVER used here (or
// anywhere) as personal financial attribution. This function therefore
// never takes a memberUid/display-name parameter at all - there is
// nothing it could ever legitimately do with one.
import type { SavingsTransactionType } from "../types/domain";

export function resolveSavingsTransactionLabel(
  transaction: { type: SavingsTransactionType; linkedExpenseId?: string },
  linkedExpenseDescription: string | null | undefined
): string {
  // Ordinary personal contribution/withdrawal - unchanged from this
  // codebase's existing behavior (TransactionRow.tsx/RecentActivityRow.tsx
  // already render exactly this, for every transaction that predates this
  // checkpoint and every transaction that will never carry a
  // linkedExpenseId at all).
  if (transaction.linkedExpenseId === undefined) {
    return transaction.type === "contribution" ? "Contribution" : "Withdrawal";
  }

  // Institutional Expense activity. The Expense's own description, when
  // resolvable, is the most informative, truthful label - never the
  // transaction's own memberUid/recordedBy under any circumstance.
  const trimmedDescription = linkedExpenseDescription?.trim();
  if (transaction.type === "withdrawal") {
    return trimmedDescription ? `Spent on ${trimmedDescription}` : "Shared Stash expense";
  }
  // A linked "contribution" is always the atomic refund
  // reverseSharedStashExpense writes when its Expense is reversed - never
  // an ordinary personal Add Money contribution (which never carries
  // linkedExpenseId).
  return trimmedDescription
    ? `Refunded from ${trimmedDescription}`
    : "Shared Stash expense refund";
}

// ---------------------------------------------------------------------
// LINKED-EXPENSE DESCRIPTION INDEX (Checkpoint 4F.4B)
// ---------------------------------------------------------------------
//
// Builds an `expenseId -> description` lookup from an ALREADY-LOADED
// list of Expenses in a single O(n) pass - the "no N+1" resolution
// strategy the frozen §17 contract requires. A caller with its own
// already-live subscribeToExpensesForTrip subscription (e.g. Trip
// Detail's own Expenses card) builds this ONCE from that same list and
// reuses it for every transaction row's own O(1) `.get()` lookup, rather
// than fetching one Expense independently per transaction row.
export function buildExpenseDescriptionIndex(
  expenses: readonly { id: string; description: string }[]
): Map<string, string> {
  const index = new Map<string, string>();
  expenses.forEach((expense) => index.set(expense.id, expense.description));
  return index;
}
