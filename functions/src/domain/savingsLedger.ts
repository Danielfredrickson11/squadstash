// Pure canonical savings-ledger interpretation/transition rules
// (Checkpoint 4F.5), extracted from the identical logic previously
// duplicated independently inside recordSavingsTransaction.ts and
// recordSharedStashExpense.ts - per the approved docs/audits/
// TRIP_SHARED_STASH_EXPENSE_PREFLIGHT_2026-09-30.md §4/§24, which
// deliberately deferred this extraction until both callables were stable
// (4F.1-4F.4) specifically to avoid touching the already-deployed
// recordSavingsTransaction.ts in the same change that introduced a
// brand-new, untested callable.
//
// This module is INTENTIONALLY narrow: it contains NO Firestore reads or
// writes, no FieldValue sentinels, and knows nothing about callable
// authentication, Trip/Bucket membership, Expense correction, archived-
// Trip authorization, Expense documents, SavingsTransaction document
// construction, clientRequestId, timestamps, or transaction ids. It owns
// ONLY the canonical ledger-state interpretation and balance-transition
// math both callables must apply identically. Every one of those other
// responsibilities remains exactly where it already lives, in each
// callable itself.
//
// LEGACY HISTORY GUARD (§6 of this checkpoint): the legacy/uninitialized
// branch's own history-emptiness guard requires a live Firestore query
// (`savingsTransactions` for this exact resource) - a fact this pure
// module cannot obtain itself without becoming impure. The chosen design
// (the preflight's own second suggested option) splits the "neither
// ledger field present" case into two pure steps with the caller's own
// Firestore read sandwiched between them:
//   1. classifyLedgerInitialization returns `{kind: "uninitialized"}`
//      without yet deriving anything - this is the signal that the
//      caller must now run its OWN historyQuery (exactly as both
//      callables already did before this extraction) before proceeding.
//   2. Only once the caller has confirmed no prior history exists does it
//      call deriveLegacyLedgerInitialization, a second pure step, to
//      compute the actual legacy opening balance.
// This preserves the exact existing guard (never weakened, never
// skipped) while keeping all Firestore I/O in the callable.
export type SavingsTransactionKind = "contribution" | "withdrawal";

// ---------------------------------------------------------------------
// STEP 1: LEDGER-STATE CLASSIFICATION
// ---------------------------------------------------------------------
//
// Mirrors the exact three-way classification both callables already
// perform on `"ledgerOpeningBalanceMinor" in parentData` /
// `"ledgerBalanceMinor" in parentData` - distinguishing "both present but
// invalid" from "exactly one present" since each callable throws a
// DIFFERENT exact message for those two cases today (preserved by each
// callable mapping this discriminant to its own existing message text,
// never by this module choosing the words).
export type LedgerInitializationState =
  | { kind: "initialized"; currentBalanceMinor: number }
  | { kind: "invalid_initialized_state" }
  | { kind: "uninitialized" }
  | { kind: "partial_corrupt" };

/**
 * Classifies a parent resource's (Bucket or Trip) ledger initialization
 * state from its own persisted ledgerOpeningBalanceMinor/
 * ledgerBalanceMinor fields, without inventing or repairing anything.
 * @param {Record<string, unknown>} parentData The parent resource's
 *   document data.
 * @return {LedgerInitializationState} The classified state.
 */
export function classifyLedgerInitialization(
  parentData: Record<string, unknown>
): LedgerInitializationState {
  const hasOpening = "ledgerOpeningBalanceMinor" in parentData;
  const hasBalance = "ledgerBalanceMinor" in parentData;

  if (hasOpening && hasBalance) {
    const opening = parentData.ledgerOpeningBalanceMinor;
    const balance = parentData.ledgerBalanceMinor;
    const openingValid =
      Number.isSafeInteger(opening) && (opening as number) >= 0;
    const balanceValid =
      Number.isSafeInteger(balance) && (balance as number) >= 0;
    if (!openingValid || !balanceValid) {
      return {kind: "invalid_initialized_state"};
    }
    return {kind: "initialized", currentBalanceMinor: balance as number};
  }
  if (!hasOpening && !hasBalance) {
    return {kind: "uninitialized"};
  }
  return {kind: "partial_corrupt"};
}

// ---------------------------------------------------------------------
// STEP 2: LEGACY OPENING-BALANCE DERIVATION (only reached after the
// caller's own history-emptiness check has already passed)
// ---------------------------------------------------------------------
//
// Mirrors the exact legacy-conversion rules both callables already
// apply: the legacy dollars value must be a finite, non-negative number;
// `Math.round(legacyDollars * 100)` must still be a safe integer. The
// caller resolves WHICH field holds the legacy dollars value (Bucket
// `balance` vs Trip `saved ?? 0`) before calling this - that resource-
// shape knowledge belongs to the callable, not this module.
export type LegacyLedgerInitializationResult =
  | {ok: true; currentBalanceMinor: number; initOpeningMinor: number}
  | {ok: false; reason: "invalid_legacy_value" | "unsafe_legacy_conversion"};

/**
 * Derives the legacy opening-balance initialization for a resource whose
 * ledger fields are both entirely absent - only safe to call once the
 * caller has independently confirmed no prior savingsTransactions
 * history exists for this resource.
 * @param {unknown} legacyDollars The resource's own legacy dollar-
 *   denominated balance field (Bucket `balance` or Trip `saved ?? 0`),
 *   already resolved by the caller.
 * @return {LegacyLedgerInitializationResult} The derived minor-unit
 *   initialization, or the specific reason it could not be derived.
 */
export function deriveLegacyLedgerInitialization(
  legacyDollars: unknown
): LegacyLedgerInitializationResult {
  const legacyValid =
    typeof legacyDollars === "number" &&
    Number.isFinite(legacyDollars) &&
    legacyDollars >= 0;
  if (!legacyValid) {
    return {ok: false, reason: "invalid_legacy_value"};
  }
  const legacyMinor = Math.round(legacyDollars * 100);
  if (!Number.isSafeInteger(legacyMinor)) {
    return {ok: false, reason: "unsafe_legacy_conversion"};
  }
  return {
    ok: true,
    currentBalanceMinor: legacyMinor,
    initOpeningMinor: legacyMinor,
  };
}

// ---------------------------------------------------------------------
// CURRENCY RESOLUTION
// ---------------------------------------------------------------------
//
// Mirrors the exact currency rules both callables already apply: the
// parent's own `currency` field, if present, must be a non-empty string
// and becomes the effective currency; if the field is entirely absent,
// the effective currency defaults to "USD". The incoming request
// currency must match the effective currency exactly - no normalization,
// no case-folding, no trimming, no conversion.
export type CurrencyResolutionResult =
  | {ok: true; effectiveCurrency: string}
  | {ok: false; reason: "malformed_parent_currency"}
  | {ok: false; reason: "currency_mismatch"; effectiveCurrency: string};

/**
 * Resolves the parent resource's effective currency and validates the
 * incoming request currency matches it exactly.
 * @param {Record<string, unknown>} parentData The parent resource's
 *   document data.
 * @param {string} requestCurrency The incoming request's own currency.
 * @return {CurrencyResolutionResult} The resolved effective currency, or
 *   the specific reason the request's currency is rejected.
 */
export function resolveEffectiveCurrency(
  parentData: Record<string, unknown>,
  requestCurrency: string
): CurrencyResolutionResult {
  let effectiveCurrency = "USD";
  if ("currency" in parentData) {
    const parentCurrency = parentData.currency;
    if (typeof parentCurrency !== "string" || parentCurrency.length === 0) {
      return {ok: false, reason: "malformed_parent_currency"};
    }
    effectiveCurrency = parentCurrency;
  }
  if (requestCurrency !== effectiveCurrency) {
    return {ok: false, reason: "currency_mismatch", effectiveCurrency};
  }
  return {ok: true, effectiveCurrency};
}

// ---------------------------------------------------------------------
// BALANCE TRANSITION
// ---------------------------------------------------------------------
//
// Mirrors the exact transition rules both callables already apply: a
// contribution adds amountMinor, a withdrawal subtracts it; the result
// must be a safe integer; a negative result is rejected as insufficient
// funds. Pure integer arithmetic only - never floating-point financial
// arithmetic.
export type LedgerTransitionResult =
  | {ok: true; newBalanceMinor: number}
  | {ok: false; reason: "unsafe_result" | "insufficient_funds"};

/**
 * Applies a single contribution/withdrawal transition to a current
 * ledger balance, rejecting an unsafe or negative resulting balance.
 * @param {number} currentBalanceMinor The balance before this
 *   transition, in minor units.
 * @param {SavingsTransactionKind} type Whether this transition adds
 *   ("contribution") or subtracts ("withdrawal") amountMinor.
 * @param {number} amountMinor The transition's own amount, in minor
 *   units.
 * @return {LedgerTransitionResult} The resulting balance, or the
 *   specific reason the transition is rejected.
 */
export function applyLedgerTransition(
  currentBalanceMinor: number,
  type: SavingsTransactionKind,
  amountMinor: number
): LedgerTransitionResult {
  const signedDelta = type === "contribution" ? amountMinor : -amountMinor;
  const newBalanceMinor = currentBalanceMinor + signedDelta;
  if (!Number.isSafeInteger(newBalanceMinor)) {
    return {ok: false, reason: "unsafe_result"};
  }
  if (newBalanceMinor < 0) {
    return {ok: false, reason: "insufficient_funds"};
  }
  return {ok: true, newBalanceMinor};
}
