import type { CurrencyCode, PersistedTimestamp, ResourceType } from "./common";

export type SavingsTransactionType = "contribution" | "withdrawal";

// Persisted savingsTransactions/{transactionId} document. ONE collection
// for both contributions and withdrawals - `type` is a discriminator,
// never a separate collection (frozen Milestone 2A design freeze).
//
// Append-only: original records are never mutated. A reversal is a
// separate SavingsTransaction whose `reversalOf` references the id of
// the transaction it reverses - there is no mutable "reversed" status
// field on the original. Deterministic reversal document-path behavior
// (guaranteeing at most one reversal per original) is implementation
// behavior for a later milestone, not part of this types-only checkpoint.
export type SavingsTransactionBase = {
  id: string;
  resourceType: ResourceType;
  resourceId: string;
  memberUid: string;
  recordedBy: string;
  amountMinor: number;
  currency: CurrencyCode;
  note?: string;
  occurredAt?: PersistedTimestamp;
  createdAt: PersistedTimestamp;
  reversalOf: string | null;
};

export type Contribution = SavingsTransactionBase & { type: "contribution" };
export type Withdrawal = SavingsTransactionBase & { type: "withdrawal" };
export type SavingsTransaction = Contribution | Withdrawal;

// Input for creating a new savings transaction. createdAt is
// server-generated, never caller-supplied. occurredAt, when the user
// picked a specific date, is a plain Date - the service converts it to a
// PersistedTimestamp at the write boundary; it is never a
// serverTimestamp()/FieldValue sentinel, since it represents a real
// chosen date rather than "now". reversalOf is accepted here since a
// reversal is created the same way as any other transaction, just
// referencing what it reverses.
type CreateSavingsTransactionInputBase = {
  resourceType: ResourceType;
  resourceId: string;
  memberUid: string;
  recordedBy: string;
  amountMinor: number;
  currency: CurrencyCode;
  note?: string;
  occurredAt?: Date;
  reversalOf?: string | null;
};

export type CreateContributionInput = CreateSavingsTransactionInputBase & {
  type: "contribution";
};
export type CreateWithdrawalInput = CreateSavingsTransactionInputBase & {
  type: "withdrawal";
};
export type CreateSavingsTransactionInput =
  | CreateContributionInput
  | CreateWithdrawalInput;
