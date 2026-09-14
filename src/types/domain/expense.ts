import type { CurrencyCode, PersistedTimestamp } from "./common";

export type SplitStrategy = "equal" | "percentage" | "custom";

// Checkpoint 4B, per the approved docs/audits/
// TRIP_EXPENSES_ARCHITECTURE_AUDIT_2026-09-13.md (as hardened by its 4A.1
// amendment): describes HOW a shared expense was paid, never WHAT KIND of
// expense it is (there is no separate "personal expense" concept in this
// milestone - see the audit §4). Named `member_out_of_pocket` rather than
// the audit's earlier draft "member_personal" specifically to avoid any
// confusion with My Stash / private personal spending, which this value
// has nothing to do with.
export type ExpensePaymentSource = "member_out_of_pocket" | "shared_stash";

// Checkpoint 4B: finalizes the audit's previously-unresolved reversal
// shape (audit §9/§19 item 6). "reversed" means this Expense was a
// mistake/correction and contributes nothing to any derived balance - it
// is NEVER destructively edited (amount/payer/splits are immutable once
// created) and a corrected version is always a brand-new Expense with
// its own id, not a reuse of this one. Deliberately NOT a pair of
// reciprocal reversalOf/reversedBy fields on two different documents
// (the audit's draft footnote) - that shape makes it unclear, from
// either document alone, which one points at which. A single `status`
// field on the one canonical record is unambiguous: this document,
// looked at by itself, always says whether it currently counts.
export type ExpenseStatus = "active" | "reversed";

// Persisted tripExpenses/{expenseId} document (Checkpoint 4B.1 comment
// fix - the approved audit's collection name, not the earlier draft's
// bare "expenses"). Expenses are TRIP-ONLY in the
// frozen Milestone 2A architecture - tripId, not resourceType/resourceId
// (unlike SavingsTransaction, which is bucket-or-trip). Do not generalize
// this to buckets.
//
// MVP currency policy (audit §3, 4A.1): `currency` must equal "USD" -
// enforced by the pure domain validators in src/domain/tripSettlement.ts,
// and (in a later checkpoint) by the trusted recordTripExpense callable.
// This type does not encode that constraint at the TypeScript level
// (CurrencyCode stays a plain string, matching every other financial
// type in this codebase) - runtime validation is where a claim like this
// actually gets enforced.
export type Expense = {
  id: string;
  tripId: string;
  // Checkpoint 4B correction (audit §1, 4A.1): CONDITIONAL, not always
  // required - a Shared-Stash-funded expense has no personal payer to
  // name, and fabricating one would assert something untrue.
  //   paymentSource === "member_out_of_pocket" -> payerUid REQUIRED
  //     (a real, current Trip member).
  //   paymentSource === "shared_stash"         -> payerUid MUST be null.
  // Enforced at runtime by assertValidExpensePaymentShape() in
  // src/domain/tripSettlement.ts - deliberately NOT encoded as a
  // discriminated union keyed on paymentSource, since every other field
  // on this type is identical across both variants and a full union
  // would force every caller to narrow before touching any other field
  // for no real safety benefit.
  payerUid: string | null;
  createdBy: string;
  amountMinor: number;          // integer minor units — never a float dollar amount
  currency: CurrencyCode;       // MUST be "USD" this milestone - see the module comment above
  description: string;
  category?: string;
  receiptImageUrl?: string | null;
  splitStrategy: SplitStrategy;

  paymentSource: ExpensePaymentSource;
  // Required exactly when paymentSource === "shared_stash" (a real,
  // already-verified savingsTransactions withdrawal id - see the audit
  // §6/§11); absent/undefined when paymentSource === "member_out_of_pocket".
  // There is no persisted state where paymentSource is "shared_stash" and
  // this field is empty - the audit's 4A.1 amendment explicitly removed
  // that "half-linked" possibility.
  sharedStashTransactionId?: string;

  occurredAt?: PersistedTimestamp;
  createdAt: PersistedTimestamp;   // server-generated only, never client-supplied
  lastUpdatedAt?: PersistedTimestamp;
  lastUpdatedBy?: string;

  // Checkpoint 4B reversal shape (see ExpenseStatus above). "active" is
  // the only status a newly-created Expense ever has; a trusted reversal
  // write path (not built in this checkpoint) is the sole way this ever
  // becomes "reversed".
  status: ExpenseStatus;
  reversedAt?: PersistedTimestamp;
  reversedBy?: string;
  reversalReason?: string;
};

// Checkpoint 4B: reshaped to match the audit's approved flat top-level
// `tripExpenseSplits` collection (audit §7/§13) - the PREVIOUS shape here
// (`participantUid`/`shareAmountMinor`, no expenseId/tripId) matched a
// `expenses/{expenseId}/splits/{participantUid}` SUBCOLLECTION design the
// audit explicitly rejected in favor of a flat collection with its own
// deterministic id (`${expenseId}_${participantUid}`), which needs
// `expenseId`/`tripId` as real fields to be queryable/rule-checkable on
// its own. `userId`/`amountMinor` naming now matches the audit's own
// recommended shape exactly (audit §13's persisted-shape code block).
//
// This is the PERSISTED/Firestore-facing shape. Pure split-calculation
// functions (src/domain/tripExpenseSplits.ts) do not know or need
// expenseId/tripId at calculation time - they use the lighter
// `ExpenseSplitAllocation` shape instead and leave attaching those two
// fields to whichever caller actually persists the result. Kept as one
// additional type, not three near-identical ones, per the checkpoint's
// own "do not over-engineer" instruction.
//
// shareAmountMinor's replacement (amountMinor) is always the
// authoritative financial share; percentageBasisPoints (100.00% = 10000)
// stays informational only, present when splitStrategy == "percentage".
// Still no settled boolean, no settledAt, no settlement/allocation
// reference - participant balances are always computed from Expense +
// ExpenseSplit + Settlement records together, never cached or linked
// here (frozen Milestone 2A design freeze, correction 1 - unchanged by
// this checkpoint).
export type ExpenseSplit = {
  expenseId: string;
  tripId: string;
  userId: string;
  amountMinor: number;
  percentageBasisPoints?: number;
  // Checkpoint 4B.2: added to match the approved audit's persisted
  // tripExpenseSplits shape exactly (audit §13) - server-generated only,
  // never client-supplied, same convention as every other createdAt on
  // a trusted document in this codebase. The pure split-calculation
  // functions (src/domain/tripExpenseSplits.ts) are unaffected - they
  // operate on the lighter ExpenseSplitAllocation shape, which has no
  // createdAt at all, since it doesn't exist yet at calculation time.
  createdAt: PersistedTimestamp;
};

// createdAt is server-generated, never caller-supplied. occurredAt, when
// provided, is a plain Date - converted to a PersistedTimestamp at the
// write boundary, same convention as CreateSavingsTransactionInput.
//
// Checkpoint 4B: payerUid/paymentSource/sharedStashTransactionId mirror
// the Expense type's own conditional-shape rules above exactly - status/
// reversal fields are intentionally absent here (every newly-created
// Expense starts "active"; there is no create-time reversal).
//
// Checkpoint 4B.1 §3: createdBy is deliberately ABSENT from this
// client-facing create-input type, even though the persisted Expense
// (above) keeps it. The approved architecture requires a future trusted
// recordTripExpense callable to derive createdBy from the authenticated
// caller (request.auth.uid) - the client must never be authoritative for
// creator identity, so this type simply cannot carry a client-supplied
// value for it. No callable exists yet; this is type-contract hardening
// only, ahead of that callable's own implementation.
export type CreateExpenseInput = {
  tripId: string;
  payerUid: string | null;
  amountMinor: number;
  currency: CurrencyCode;
  description: string;
  category?: string;
  receiptImageUrl?: string | null;
  splitStrategy: SplitStrategy;
  paymentSource: ExpensePaymentSource;
  sharedStashTransactionId?: string;
  occurredAt?: Date;
};

// Checkpoint 4B: the previous CreateExpenseSplitInput (participantUid/
// shareAmountMinor, matching the now-superseded subcollection ExpenseSplit
// shape) is REMOVED rather than reshaped. Splits are never a separate
// client-supplied "create a split" input in the approved architecture -
// a trusted recordTripExpense callable (a later checkpoint) computes and
// persists them server-side from raw per-participant split input shaped
// like src/domain/tripExpenseSplits.ts's own EqualSplitInput/
// PercentageSplitParticipant/CustomSplitParticipant types, which already
// exist there and would only drift out of sync with a redundant type
// here.
