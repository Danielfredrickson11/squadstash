// Pure logical-request/idempotency + validation helpers for Settlement
// creation/reversal (Checkpoint 4E.4), per the frozen docs/audits/
// TRIP_BALANCES_SETTLEMENTS_PREFLIGHT_2026-09-28.md §8/§14/§15/§16. No
// Firestore, no React - mirrors src/domain/expenseSubmission.ts's exact
// shape and discipline (plain fact comparison, generator injected for
// tests), the same precedent already followed for Expense creation and
// (in src/domain/expenseReversal.ts) Expense reversal.
import { normalizeReversalReason } from "./expenseReversal";
import type { SettlementMethod } from "../types/domain";

// Checkpoint 4E.4 §10: reuse the already-hardened ambiguous-reversal
// state machine rather than duplicating its internal switch/decision
// logic. These are TRUE re-exports (aliases), not copies -
// expenseReversal.ts is never modified by this file. A future 4E.7
// controller passes Settlement status/reversedBy facts into this exact
// same generic behavior; the expense-specific property naming inside
// ReversalOutcomeEvent (expenseStatus/expenseReversedBy) is not
// sufficient reason to refactor working 4D code in this checkpoint.
export {
  reduceReversalOutcome as reduceSettlementReversalOutcome,
  isDefinitiveDifferentRequestFailure as isDefinitiveSettlementDifferentRequestFailure,
} from "./expenseReversal";

// ---------------------------------------------------------------------
// SETTLEMENT CREATION FACTS (Checkpoint 4E.4 §4, preflight §16)
// ---------------------------------------------------------------------
//
// Deliberately shaped to match recordTripSettlement.ts's own
// NormalizedCreationRequest field-for-field (frozen preflight §10/§16).
// Never includes createdBy/status/createdAt/clientRequestId/reversal
// metadata/creationRequest/reversalRequest - those are either
// server-derived, trusted-internal, or belong to a different type
// entirely.
export type SettlementCreationFacts = {
  tripId: string;
  fromUid: string;
  toUid: string;
  amountMinor: number;
  currency: "USD";
  method: SettlementMethod;
  note: string | null;
  // Preflight §3/§16: the 4E.6 UI always constructs this as null (no
  // date/"when did this happen" field exists on the form) - the field
  // remains part of this shared identity-facts shape so the same
  // equality/idempotency helpers work unmodified for a future caller
  // that does supply a real instant (e.g. a bulk importer).
  occurredAtInstantMs: number | null;
};

// ---------------------------------------------------------------------
// NOTE NORMALIZATION (preflight §10/§16, mirrors the trusted backend's
// own recordTripSettlement.ts note-handling exactly)
// ---------------------------------------------------------------------

const MAX_SETTLEMENT_NOTE_LENGTH = 500;

export type NormalizeSettlementNoteResult =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

// Mirrors the trusted backend's own frozen normalization exactly: trim,
// then an empty OR whitespace-only note normalizes to null (never
// treated as a different logical fact than "omitted entirely") - the
// 500-character cap applies to the TRIMMED value and is never silently
// truncated, matching normalizeReversalReason's own discipline.
export function normalizeSettlementNote(raw: string): NormalizeSettlementNoteResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (trimmed.length > MAX_SETTLEMENT_NOTE_LENGTH) {
    return {
      ok: false,
      error: `Note must be ${MAX_SETTLEMENT_NOTE_LENGTH} characters or fewer.`,
    };
  }
  return { ok: true, value: trimmed };
}

// ---------------------------------------------------------------------
// CREATION FACT EQUALITY + REQUEST-ID RESOLUTION (preflight §16)
// ---------------------------------------------------------------------

// Field-by-field comparison (never JSON.stringify, which would make
// equality depend on accidental property/key order) - every fact the
// backend's own replay-detection compares, mirroring
// expenseCreationFactsEqual's exact discipline.
export function settlementCreationFactsEqual(
  a: SettlementCreationFacts,
  b: SettlementCreationFacts
): boolean {
  return (
    a.tripId === b.tripId &&
    a.fromUid === b.fromUid &&
    a.toUid === b.toUid &&
    a.amountMinor === b.amountMinor &&
    a.currency === b.currency &&
    a.method === b.method &&
    a.note === b.note &&
    a.occurredAtInstantMs === b.occurredAtInstantMs
  );
}

export type PendingSettlementCreationRequest = SettlementCreationFacts & {
  clientRequestId: string;
};

// Reuses the previous attempt's clientRequestId if the retained pending
// request has the EXACT same facts (a retry of a failed/ambiguous
// submit); otherwise generates a fresh id via the injected generator and
// replaces the pending record (a genuinely new logical request). Mirrors
// resolveExpenseClientRequestId/resolveExpenseReversalClientRequestId
// exactly. No side effects other than pendingRef mutation and the
// injected generator call - never calls Firebase, never decides when
// pendingRef gets cleared (that belongs to the later UI/controller code,
// based on definitive vs. ambiguous outcomes).
export function resolveSettlementClientRequestId(
  pendingRef: { current: PendingSettlementCreationRequest | null },
  facts: SettlementCreationFacts,
  generateClientRequestId: () => string
): string {
  const pending = pendingRef.current;
  if (pending && settlementCreationFactsEqual(pending, facts)) {
    return pending.clientRequestId;
  }

  const clientRequestId = generateClientRequestId();
  pendingRef.current = { ...facts, clientRequestId };
  return clientRequestId;
}

// ---------------------------------------------------------------------
// SETTLEMENT REVERSAL FACTS + REQUEST-ID RESOLUTION (preflight §11/§16)
// ---------------------------------------------------------------------

// reversalReason here is ALREADY normalized (see normalizeReversalReason,
// reused unchanged from expenseReversal.ts - the Expense and Settlement
// trusted backends intentionally share the same trim/whitespace-to-
// absence/500-char-cap semantics, so this file never re-implements that
// normalization).
export type SettlementReversalFacts = {
  settlementId: string;
  reversalReason: string | undefined;
};

export function settlementReversalFactsEqual(
  a: SettlementReversalFacts,
  b: SettlementReversalFacts
): boolean {
  return a.settlementId === b.settlementId && a.reversalReason === b.reversalReason;
}

export type PendingSettlementReversalRequest = SettlementReversalFacts & {
  clientRequestId: string;
};

// Same semantics as resolveExpenseReversalClientRequestId: exact same
// facts reuse the id; a changed settlementId or changed normalized
// reversalReason mints a fresh one. Never calls Firebase.
export function resolveSettlementReversalClientRequestId(
  pendingRef: { current: PendingSettlementReversalRequest | null },
  facts: SettlementReversalFacts,
  generateClientRequestId: () => string
): string {
  const pending = pendingRef.current;
  if (pending && settlementReversalFactsEqual(pending, facts)) {
    return pending.clientRequestId;
  }

  const clientRequestId = generateClientRequestId();
  pendingRef.current = { ...facts, clientRequestId };
  return clientRequestId;
}

// Re-exported so a future caller can normalize a raw reversal-reason
// string without importing two different domain modules for one logical
// Settlement-reversal operation - this is a TRUE re-export (see the
// reduceReversalOutcome aliases above), never a duplicated
// implementation. The underlying function itself lives solely in
// expenseReversal.ts.
export { normalizeReversalReason };

// ---------------------------------------------------------------------
// OVER-SETTLEMENT ADVISORY (preflight §8) - ADVISORY ONLY. The trusted
// backend intentionally does NOT hard-cap settlement amount; this exists
// purely to drive optional soft-warning copy in a future UI (4E.6),
// never to block or clamp anything.
// ---------------------------------------------------------------------

export type SettlementDebtAssessment = {
  exceeds: boolean;
  excessMinor: number;
};

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

// Validates inputs rather than silently calculating from malformed
// financial values - a malformed currentDebtMinor/requestedAmountMinor
// throws, never fabricates a warning result from nonsense input.
export function assessSettlementAgainstDebt(
  currentDebtMinor: number,
  requestedAmountMinor: number
): SettlementDebtAssessment {
  if (!isSafeNonNegativeInteger(currentDebtMinor)) {
    throw new Error(
      "assessSettlementAgainstDebt: currentDebtMinor must be a non-negative safe integer."
    );
  }
  if (!isSafePositiveInteger(requestedAmountMinor)) {
    throw new Error(
      "assessSettlementAgainstDebt: requestedAmountMinor must be a positive safe integer."
    );
  }

  if (requestedAmountMinor <= currentDebtMinor) {
    return { exceeds: false, excessMinor: 0 };
  }
  return { exceeds: true, excessMinor: requestedAmountMinor - currentDebtMinor };
}
