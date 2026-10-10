// Checkpoint 5B.1: the trusted ownership-allocation SOURCE-OF-TRUTH
// schema primitives, per docs/audits/
// TRIP_WALLET_OWNERSHIP_WITHDRAWAL_PREFLIGHT_2026-10-08.md §12 (as
// clarified by Amendment 5B.0B, item 7). This module defines only the
// durable storage shape and its validators - NOT the proportional
// depletion algorithm itself (that is explicitly 5B.2's job: "BigInt
// proportional math belongs in 5B.2").
//
// Canonical identity (frozen, 5B.0B item 7): there is exactly ONE
// allocation record per Shared-Stash Expense, keyed solely by the id of
// that Expense's ORIGINAL Shared-Stash withdrawal `SavingsTransaction`
// (`Expense.sharedStashTransactionId`) - a reversal never creates a
// second, competing record keyed by the refund.
//
// Representation choice (this checkpoint, per the preflight's own
// explicit invitation to freeze one): an ARRAY of {uid, amountMinor}
// entries, not a map keyed by uid. This mirrors the already-established,
// already-tested `ExpenseSplitAllocation[]` shape
// (functions/src/domain/tripExpenseSplits.ts) exactly, and avoids two
// real costs a map representation would have: (1) Firestore Rules has
// no generic map-iteration/reduce primitive, so a map's own internal
// "sum equals amountMinor" invariant could never be Rules-expressible
// even in principle (moot here since this collection is client-write-
// closed, but an array keeps the door open without ever needing it);
// (2) using an arbitrary uid as a Firestore map FIELD NAME invites
// avoidable edge cases (field-name character restrictions, dotted-path
// ambiguity) that a plain array of uid *values* never raises.
// Checkpoint 5B.1A, item 6: allocation entries must be stored in
// canonical STRICTLY ASCENDING uid order (never merely "no duplicates")
// - since this collection is immutable/append-only and is a source of
// truth, a logically identical allocation must have exactly one
// representation, never two differently-ordered-but-equivalent ones.
// This strengthens deterministic migration/rebuild, replay comparison,
// and audit readability. The validator below rejects a correctly-valued
// but incorrectly-ordered array outright - it never silently re-sorts
// one. A future 5B.2 allocator must itself output this canonical order
// (not implemented here - this checkpoint only freezes the requirement).
import type {Timestamp} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";

export type TripOwnershipAllocationProvenance = "original" | "migrated";

export type TripOwnershipAllocationEntry = {
  uid: string;
  amountMinor: number;
};

// Checkpoint 5B.1A, item 4: the fields a future trusted callable
// (5B.2/5B.3) must determine BEFORE any write - everything except the
// server-assigned id/createdAt/migratedAt. This is exactly what
// validateTripOwnershipAllocationShape checks; it intentionally does
// NOT include createdAt/migratedAt, since those are always
// FieldValue.serverTimestamp() sentinels at write time, never real
// values this pure validator could meaningfully check before the write
// actually happens.
export type TripOwnershipAllocationCandidate = {
  tripId: string;
  expenseId: string;
  withdrawalTransactionId: string;
  allocations: TripOwnershipAllocationEntry[];
  amountMinor: number;
  currency: string;
  provenance: TripOwnershipAllocationProvenance;
};

// The full PERSISTED document shape, once read back from Firestore.
// `createdAt` is always present; `migratedAt` is present if and only if
// `provenance` is `"migrated"` - expressed as a discriminated union so
// reading `migratedAt` off an `"original"` record is a compile-time
// error, never a silent runtime `undefined`. Checkpoint 5B.1A, item 4
// (the 5B.1 original omitted both timestamp fields entirely).
type TripOwnershipAllocationCommon = {
  id: string;
  tripId: string;
  expenseId: string;
  withdrawalTransactionId: string;
  allocations: TripOwnershipAllocationEntry[];
  amountMinor: number;
  currency: string;
  createdAt: Timestamp;
};

export type TripOwnershipAllocation =
  | (TripOwnershipAllocationCommon & {provenance: "original"})
  | (TripOwnershipAllocationCommon & {
      provenance: "migrated";
      migratedAt: Timestamp;
    });

export type TripOwnershipAllocationValidationResult =
  | {ok: true}
  | {ok: false; reason: string};

/**
 * True if `value` is a non-empty string.
 * @param {unknown} value The candidate value.
 * @return {boolean} True if value is a non-empty string.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * True if `value` is a positive (never zero) safe integer.
 * @param {unknown} value The candidate value.
 * @return {boolean} True if value is a positive safe integer.
 */
function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * True if `value` is one of the two frozen provenance values. No third
 * value exists in this design - "migration" (a gerund) was considered
 * and rejected in favor of the preflight's own already-frozen
 * "migrated" (past tense, matching "original"'s own tense).
 * @param {unknown} value The candidate value.
 * @return {boolean} True if value is a valid provenance.
 */
export function isValidTripOwnershipAllocationProvenance(
  value: unknown
): value is TripOwnershipAllocationProvenance {
  return value === "original" || value === "migrated";
}

/**
 * Validates an allocation-entries array against the amount it must
 * exactly sum to: non-empty, every entry a well-formed {uid,
 * amountMinor} pair with a positive safe-integer amount, no duplicate
 * uid, STRICTLY ASCENDING uid order (Checkpoint 5B.1A, item 6 - the one
 * canonical representation a source-of-truth record must have), and an
 * exact sum match - checked with a running-total overflow guard exactly
 * like tripExpenseSplits.ts's own sumSafeIntegers.
 * @param {unknown} entries The candidate allocations array.
 * @param {number} amountMinor The exact total the entries must sum to.
 * @return {TripOwnershipAllocationValidationResult} Ok, or the specific
 *   reason validation failed.
 */
export function validateTripOwnershipAllocationEntries(
  entries: unknown,
  amountMinor: number
): TripOwnershipAllocationValidationResult {
  if (!Array.isArray(entries) || entries.length === 0) {
    return {ok: false, reason: "allocations must be a non-empty array."};
  }

  const seenUids = new Set<string>();
  let previousUid: string | null = null;
  let total = 0;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      return {ok: false, reason: "Every allocation entry must be an object."};
    }
    const e = entry as Record<string, unknown>;
    if (!isNonEmptyString(e.uid)) {
      return {
        ok: false,
        reason: "Every allocation entry must have a non-empty uid.",
      };
    }
    // Duplicate-uid rejection is checked explicitly and FIRST, even
    // though the ordering check below would also reject most
    // duplicates - explicit validation/error messaging is valuable on
    // its own (Checkpoint 5B.1A, item 6's own instruction), not merely
    // a side effect of the ordering rule.
    if (seenUids.has(e.uid)) {
      return {ok: false, reason: `Duplicate allocation uid "${e.uid}".`};
    }
    if (previousUid !== null && e.uid <= previousUid) {
      return {
        ok: false,
        reason: "allocations must be sorted in strictly ascending uid " +
          `order (encountered "${e.uid}" after "${previousUid}").`,
      };
    }
    seenUids.add(e.uid);
    previousUid = e.uid;

    if (!isPositiveSafeInteger(e.amountMinor)) {
      return {
        ok: false,
        reason: `Allocation entry for "${e.uid}" must have a positive ` +
          "safe-integer amountMinor.",
      };
    }

    const next = total + e.amountMinor;
    if (!Number.isSafeInteger(next)) {
      return {
        ok: false,
        reason: "Allocation entries sum exceeded the safe integer range.",
      };
    }
    total = next;
  }

  if (total !== amountMinor) {
    return {
      ok: false,
      reason: `Allocation entries sum to ${total}, which does not match ` +
        `amountMinor (${amountMinor}).`,
    };
  }

  return {ok: true};
}

/**
 * Validates the full shape of a tripOwnershipAllocations record, before
 * it is ever written. Does not compute anything - a future callable
 * (5B.2/5B.3) is responsible for producing a candidate allocation; this
 * function only proves (or disproves) that the candidate is well-formed.
 * Accepts `unknown`-typed fields (not the narrowed
 * TripOwnershipAllocationCandidate type) since the whole point is to
 * validate an not-yet-trusted value.
 * @param {object} input The candidate allocation record's own fields.
 * @return {TripOwnershipAllocationValidationResult} Ok, or the specific
 *   reason validation failed.
 */
export function validateTripOwnershipAllocationShape(input: {
  tripId: unknown;
  expenseId: unknown;
  withdrawalTransactionId: unknown;
  amountMinor: unknown;
  currency: unknown;
  allocations: unknown;
  provenance: unknown;
}): TripOwnershipAllocationValidationResult {
  if (!isNonEmptyString(input.tripId)) {
    return {ok: false, reason: "tripId must be a non-empty string."};
  }
  if (!isNonEmptyString(input.expenseId)) {
    return {ok: false, reason: "expenseId must be a non-empty string."};
  }
  if (!isNonEmptyString(input.withdrawalTransactionId)) {
    return {
      ok: false,
      reason: "withdrawalTransactionId must be a non-empty string.",
    };
  }
  if (!isNonEmptyString(input.currency)) {
    return {ok: false, reason: "currency must be a non-empty string."};
  }
  if (!isPositiveSafeInteger(input.amountMinor)) {
    return {ok: false, reason: "amountMinor must be a positive safe integer."};
  }
  if (!isValidTripOwnershipAllocationProvenance(input.provenance)) {
    return {
      ok: false,
      reason: "provenance must be \"original\" or \"migrated\".",
    };
  }

  return validateTripOwnershipAllocationEntries(
    input.allocations,
    input.amountMinor
  );
}

/**
 * Convenience wrapper that throws the project's standard
 * `HttpsError("failed-precondition", ...)` instead of returning a
 * result object - for a future callable that wants to fail immediately
 * rather than branch on the result itself.
 * @param {object} input The candidate allocation record's own fields.
 * @return {void}
 */
export function assertValidTripOwnershipAllocationShape(input: {
  tripId: unknown;
  expenseId: unknown;
  withdrawalTransactionId: unknown;
  amountMinor: unknown;
  currency: unknown;
  allocations: unknown;
  provenance: unknown;
}): void {
  const result = validateTripOwnershipAllocationShape(input);
  if (!result.ok) {
    throw new HttpsError("failed-precondition", result.reason);
  }
}

/**
 * The canonical tripOwnershipAllocations document id for a Shared-Stash
 * Expense's allocation record - frozen (Amendment 5B.0B, item 7; made
 * concrete in code by Checkpoint 5B.1A, item 7) as EXACTLY the id of
 * that Expense's original Shared-Stash withdrawal `SavingsTransaction`,
 * returned unchanged. This is deliberately NOT a composite id - it has
 * only one component, so the `_` delimiter restriction that governs
 * tripInvitationId/tripMemberOwnershipId does not apply here at all;
 * there is no second component it could ever collide with.
 * @param {string} withdrawalTransactionId The original Shared-Stash
 *   withdrawal transaction's own (already-deterministic) id.
 * @return {string} The canonical allocation document id - identical to
 *   the input.
 */
export function tripOwnershipAllocationId(
  withdrawalTransactionId: string
): string {
  if (withdrawalTransactionId.length === 0) {
    throw new HttpsError(
      "invalid-argument",
      "withdrawalTransactionId must be a non-empty string."
    );
  }
  return withdrawalTransactionId;
}

/**
 * True if a candidate allocation document's own id matches the
 * withdrawal transaction id its `withdrawalTransactionId` field claims -
 * i.e. that the document was actually written at its own canonical
 * location, never at a mismatched or forged one. A future 5B.3/5B.4
 * writer/reader should call this before trusting a read allocation
 * record's content.
 * @param {string} documentId The allocation document's own Firestore id.
 * @param {string} withdrawalTransactionId The record's own
 *   `withdrawalTransactionId` field value.
 * @return {boolean} True if the two agree exactly.
 */
export function isValidTripOwnershipAllocationIdentity(
  documentId: string,
  withdrawalTransactionId: string
): boolean {
  return documentId === withdrawalTransactionId;
}
