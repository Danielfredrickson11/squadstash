import type { CurrencyCode, PersistedTimestamp } from "./common";

export type SettlementMethod =
  | "venmo"
  | "paypal"
  | "zelle"
  | "cash"
  | "other";

// Persisted settlements/{settlementId} document. Settlements are
// TRIP-ONLY. This records that an external payment happened - SquadStash
// never processes or moves money itself. No allocations
// subcollection/type, no expenseId/split reference, and no settled
// boolean: participant balances are always computed from Expense +
// ExpenseSplit + Settlement records together, never cached or linked
// here (frozen Milestone 2A design freeze, correction 1).
export type Settlement = {
  id: string;
  tripId: string;
  fromUid: string;
  toUid: string;
  amountMinor: number;
  currency: CurrencyCode;
  method: SettlementMethod;
  note?: string;
  occurredAt?: PersistedTimestamp;
  createdAt: PersistedTimestamp;
  createdBy: string;
};

// createdAt is server-generated, never caller-supplied. occurredAt, when
// provided, is a plain Date - same convention as CreateExpenseInput and
// CreateSavingsTransactionInput.
export type CreateSettlementInput = {
  tripId: string;
  fromUid: string;
  toUid: string;
  amountMinor: number;
  currency: CurrencyCode;
  method: SettlementMethod;
  note?: string;
  occurredAt?: Date;
  createdBy: string;
};
