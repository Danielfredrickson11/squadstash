import type { CurrencyCode, PersistedTimestamp } from "./common";

export type SettlementMethod =
  | "venmo"
  | "paypal"
  | "zelle"
  | "cash"
  | "other";

// Checkpoint 4E.1, per the frozen docs/audits/
// TRIP_BALANCES_SETTLEMENTS_PREFLIGHT_2026-09-28.md §10/§11 (as hardened
// by 4E.0A): mirrors Expense.status exactly - a reversed Settlement is
// NEVER destructively edited or deleted (amount/fromUid/toUid/method are
// immutable once created); a mistaken Settlement is corrected by
// reversing it, never by mutation. Deliberately NOT a compensating
// (opposite-direction) Settlement record - see §11 for why that would
// leave the original wrong record looking active forever.
export type SettlementStatus = "active" | "reversed";

// Persisted tripSettlements/{clientRequestId} document (Checkpoint 4B.2
// comment fix - the approved audit's collection path and idempotent-id
// scheme, audit §12/§13, not the earlier draft's bare
// "settlements/{settlementId}"). Note this describes the DOCUMENT ID a
// future trusted callable will use, not a persisted field - clientRequestId
// is deliberately NOT added below merely because it doubles as the future
// document id, matching the same convention already used for Expense/
// savingsTransactions (the id is derived from the request, not stored a
// second time as an ordinary field). Settlements are
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

  // Checkpoint 4E.1 (frozen preflight §10/§11): required from the moment
  // a Settlement is created (mirrors Expense.status's own required-from-
  // creation shape exactly) - never optional, never inferred from field
  // presence. reversedAt/reversedBy/reversalReason are present ONLY when
  // status === "reversed" (required together on a reversed record,
  // forbidden on an active one - the same conditional-shape contract
  // already enforced for the identical Expense fields). Trusted-internal
  // fields (creationRequest, reversalRequest) are deliberately NOT part
  // of this client-facing type - see the future mapSettlementDocument's
  // own exclusion, mirroring mapExpenseDocument's identical one.
  status: SettlementStatus;
  reversedAt?: PersistedTimestamp;
  reversedBy?: string;
  reversalReason?: string;
};

// createdAt is server-generated, never caller-supplied. occurredAt, when
// provided, is a plain Date - same convention as CreateExpenseInput and
// CreateSavingsTransactionInput.
//
// Checkpoint 4B.1 §3: createdBy REMOVED from this client-facing input
// (the persisted Settlement type above keeps it unchanged). The approved
// architecture requires a future trusted recordTripSettlement callable
// to derive createdBy from the authenticated caller (request.auth.uid),
// never from client input - this type is hardened to make that
// impossible to get wrong, ahead of that callable existing. Also note
// (audit §10, 4A.1): that same future callable additionally requires
// the authenticated caller to equal `toUid` specifically (only the
// recipient may record a completed Settlement) - a permission rule
// enforced by the callable itself, not representable in this type.
export type CreateSettlementInput = {
  tripId: string;
  fromUid: string;
  toUid: string;
  amountMinor: number;
  currency: CurrencyCode;
  method: SettlementMethod;
  note?: string;
  occurredAt?: Date;
};
