import type { CurrencyCode, PersistedTimestamp } from "./common";

export type SplitStrategy = "equal" | "percentage" | "custom";

// Persisted expenses/{expenseId} document. Expenses are TRIP-ONLY in the
// frozen Milestone 2A architecture - tripId, not resourceType/resourceId
// (unlike SavingsTransaction, which is bucket-or-trip). Do not generalize
// this to buckets.
export type Expense = {
  id: string;
  tripId: string;
  payerUid: string;
  createdBy: string;
  amountMinor: number;
  currency: CurrencyCode;
  description: string;
  category?: string;
  receiptImageUrl?: string | null;
  splitStrategy: SplitStrategy;
  occurredAt?: PersistedTimestamp;
  createdAt: PersistedTimestamp;
};

// Persisted expenses/{expenseId}/splits/{participantUid} document.
// shareAmountMinor is always the authoritative financial share;
// percentageBasisPoints (100.00% = 10000) is informational only, present
// when splitStrategy == "percentage". No settled boolean, no settledAt,
// no settlement/allocation reference - participant balances are always
// computed from Expense + ExpenseSplit + Settlement records together,
// never cached or linked here (frozen Milestone 2A design freeze,
// correction 1).
export type ExpenseSplit = {
  participantUid: string;
  shareAmountMinor: number;
  percentageBasisPoints?: number;
};

// createdAt is server-generated, never caller-supplied. occurredAt, when
// provided, is a plain Date - converted to a PersistedTimestamp at the
// write boundary, same convention as CreateSavingsTransactionInput.
export type CreateExpenseInput = {
  tripId: string;
  payerUid: string;
  createdBy: string;
  amountMinor: number;
  currency: CurrencyCode;
  description: string;
  category?: string;
  receiptImageUrl?: string | null;
  splitStrategy: SplitStrategy;
  occurredAt?: Date;
};

export type CreateExpenseSplitInput = {
  participantUid: string;
  shareAmountMinor: number;
  percentageBasisPoints?: number;
};
