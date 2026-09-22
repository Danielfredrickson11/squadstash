// Pure logical-request/idempotency + validation helpers for the Add
// Expense form (Checkpoint 4D.3), per the frozen docs/audits/
// TRIP_EXPENSE_UI_UX_PREFLIGHT_2026-09-18.md §12/§14/§19. No Firestore,
// no React - mirrors src/domain/savingsMoneyAction.ts's exact shape and
// discipline (plain fact comparison, generator injected for tests).
import { parseDollarsToMinorUnits } from "../../utils/format";

// ---------------------------------------------------------------------
// STRICT MONEY INPUT (Checkpoint 4D.3 §13/§14/§15)
// ---------------------------------------------------------------------
//
// Validates the FULL input shape first, strips recognized formatting
// characters ($, ,) only AFTER the shape passes, then hands the
// remaining plain digit-and-decimal-point string to the EXISTING
// parseDollarsToMinorUnits (utils/format.ts) unchanged - this file never
// reimplements cents arithmetic (no Number(text)*100, no parseFloat,
// no Math.round on a decimal).
//
// An optional leading "$" and optional comma-grouped thousands
// separators (in valid 3-digit groups) are accepted; a leading "-" is
// matched SEPARATELY (not inside this shape pattern) so a negative
// amount gets its own specific "Enter a positive amount." message
// instead of being lumped in with genuinely malformed input.
const MONEY_SHAPE_PATTERN = /^\$?(\d{1,3}(,\d{3})*|\d+)(\.\d+)?$/;

export type ParseExpenseMoneyResult =
  | { ok: true; amountMinor: number }
  | { ok: false; error: string };

// Shared shape/strip logic for BOTH the total Expense amount (never
// zero) and a custom per-participant share (zero IS a legitimate
// intentional share, Checkpoint 4D.4 §13) - `allowZero` is the only
// behavioral difference between the two exported wrappers below, so the
// actual parsing logic is written once, not duplicated.
function parseMoneyShape(input: string, allowZero: boolean): ParseExpenseMoneyResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Enter a valid amount." };
  }

  const isNegative = trimmed.startsWith("-");
  const unsigned = isNegative ? trimmed.slice(1) : trimmed;

  // Shape-check FIRST, on the unsigned remainder - "-abc" must still
  // report "Enter a valid amount.", not a negative-specific message.
  if (!MONEY_SHAPE_PATTERN.test(unsigned)) {
    return { ok: false, error: "Enter a valid amount." };
  }
  if (isNegative) {
    return {
      ok: false,
      error: allowZero ? "Enter a non-negative amount." : "Enter a positive amount.",
    };
  }

  // Only NOW, once the whole shape is confirmed acceptable, strip the
  // recognized formatting characters.
  const withoutDollar = unsigned.startsWith("$") ? unsigned.slice(1) : unsigned;
  const withoutCommas = withoutDollar.replace(/,/g, "");

  const decimalPart = withoutCommas.includes(".") ? withoutCommas.split(".")[1] : "";
  if (decimalPart.length > 2) {
    return { ok: false, error: "Enter an amount with at most 2 decimal places." };
  }

  const amountMinor = parseDollarsToMinorUnits(withoutCommas, { allowZero });
  if (amountMinor === null) {
    if (allowZero) {
      // With allowZero:true, parseDollarsToMinorUnits only returns null
      // for an unsafe-integer result now (zero itself is accepted) - no
      // separate "greater than $0" message applies here.
      return { ok: false, error: "Enter a smaller amount." };
    }
    // parseDollarsToMinorUnits returns null for both "exactly zero" (its
    // own allowZero:false rejection) and "unsafe-integer result" - these
    // need different, honest messages, so distinguish them here rather
    // than showing a single generic failure for both.
    const isZero = /^0+(\.0+)?$/.test(withoutCommas);
    return {
      ok: false,
      error: isZero ? "Enter an amount greater than $0." : "Enter a smaller amount.",
    };
  }

  return { ok: true, amountMinor };
}

// The total Expense amount - zero is never valid (unchanged from
// Checkpoint 4D.3).
export function parseExpenseMoneyInput(input: string): ParseExpenseMoneyResult {
  return parseMoneyShape(input, false);
}

// A custom split's per-participant share (Checkpoint 4D.4 §13) - the
// SAME accepted shapes as the total Expense amount, but an explicit $0
// share is valid (someone was included in the expense but owes nothing
// toward it).
export function parseExpenseShareMoneyInput(input: string): ParseExpenseMoneyResult {
  return parseMoneyShape(input, true);
}

// ---------------------------------------------------------------------
// PERCENTAGE INPUT (Checkpoint 4D.4 §7/§8/§9)
// ---------------------------------------------------------------------
//
// Parses a plain percentage string (never a literal "%" suffix - the UI
// indicates percentage visually) into integer basis points (100.00% =
// 10000), by parsing the whole/fractional digit strings directly and
// combining them as integers - NEVER Number(input)*100/parseFloat*100/
// Math.round(decimal*100), matching parseExpenseMoneyInput's own
// no-floating-point-round-trip discipline exactly.
//
// A leading digit is REQUIRED (".5" is rejected - "0.5" is the accepted
// form) - PERCENTAGE_SHAPE_PATTERN's mandatory leading \d+ enforces this
// by construction, with no special-case code needed.
const PERCENTAGE_SHAPE_PATTERN = /^\d+(\.\d+)?$/;

export type ParsePercentageResult =
  | { ok: true; percentageBasisPoints: number }
  | { ok: false; error: string };

export function parsePercentageToBasisPoints(input: string): ParsePercentageResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Enter a valid percentage." };
  }

  const isNegative = trimmed.startsWith("-");
  const unsigned = isNegative ? trimmed.slice(1) : trimmed;

  if (!PERCENTAGE_SHAPE_PATTERN.test(unsigned)) {
    return { ok: false, error: "Enter a valid percentage." };
  }
  if (isNegative) {
    return { ok: false, error: "Enter a percentage from 0 to 100." };
  }

  const decimalPart = unsigned.includes(".") ? unsigned.split(".")[1] : "";
  if (decimalPart.length > 2) {
    return { ok: false, error: "Use at most 2 decimal places." };
  }

  const [wholePart, fractionPart = ""] = unsigned.split(".");
  const paddedFraction = (fractionPart + "00").slice(0, 2);
  const percentageBasisPoints = Number(wholePart) * 100 + Number(paddedFraction);

  if (!Number.isSafeInteger(percentageBasisPoints) || percentageBasisPoints > 10000) {
    return { ok: false, error: "Enter a percentage from 0 to 100." };
  }

  return { ok: true, percentageBasisPoints };
}

// ---------------------------------------------------------------------
// SAFE-INTEGER AGGREGATION (Checkpoint 4D.4 §10/§16/§39)
// ---------------------------------------------------------------------
//
// Sums a list of already-validated integers, checking the RUNNING total
// after every addition (a running sum can leave the safe-integer range
// partway through even when every individual addend is independently
// safe) - mirrors src/domain/tripExpenseSplits.ts's own private
// sumSafeIntegers discipline exactly (that file is frozen/unmodified in
// this checkpoint, so this is a small, deliberate, intentional
// duplication of the same already-proven arithmetic, not a new pattern).
// Returns null (never throws, never a fabricated total) the moment the
// running sum becomes unsafe - callers fail closed on null.
export function sumSafeIntegers(values: number[]): number | null {
  let total = 0;
  for (const value of values) {
    const next = total + value;
    if (!Number.isSafeInteger(next)) return null;
    total = next;
  }
  return total;
}

// ---------------------------------------------------------------------
// DESCRIPTION / CATEGORY (Checkpoint 4D.3 §11/§12)
// ---------------------------------------------------------------------

export type ValidatedTextResult = { ok: true; value: string } | { ok: false; error: string };

export function validateExpenseDescription(raw: string): ValidatedTextResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, error: "Enter a description." };
  if (trimmed.length > 500) {
    return { ok: false, error: "Description must be 500 characters or fewer." };
  }
  return { ok: true, value: trimmed };
}

// category is OPTIONAL - empty-after-trim means "omit it" (value: null),
// never a validation failure on its own.
export type ValidatedCategoryResult = { ok: true; value: string | null } | { ok: false; error: string };

export function validateExpenseCategory(raw: string): ValidatedCategoryResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (trimmed.length > 100) {
    return { ok: false, error: "Category must be 100 characters or fewer." };
  }
  return { ok: true, value: trimmed };
}

// ---------------------------------------------------------------------
// CURRENT-MEMBER SET + PARTICIPANT CAP (Checkpoint 4D.3 §8/§18/§19)
// ---------------------------------------------------------------------

// Mirrors functions/src/callables/recordTripExpense.ts's own
// MAX_EXPENSE_PARTICIPANTS exactly - the backend remains the sole
// authority regardless of this client-side mirror; this constant only
// drives the form's own default-selection/cap UX (frozen preflight §14).
export const MAX_EXPENSE_PARTICIPANTS = 100;

// ownerId UNION memberIds, deduped, ignoring malformed/empty entries -
// matches isCurrentTripMember's own backend semantics (owner appears
// exactly once even though they're also frequently present in
// memberIds).
export function deriveCurrentMemberUids(
  ownerId: string | null | undefined,
  memberIds: (string | null | undefined)[] | null | undefined
): string[] {
  const uids = new Set<string>();
  if (typeof ownerId === "string" && ownerId.length > 0) uids.add(ownerId);
  (memberIds ?? []).forEach((uid) => {
    if (typeof uid === "string" && uid.length > 0) uids.add(uid);
  });
  return Array.from(uids);
}

// Capacity-gated default participant selection (frozen preflight §14):
// at or under the cap, default to every current Trip member; over the
// cap, default to ONLY the current authenticated member - never a
// silently truncated/arbitrary subset of others.
export function defaultParticipantSelection(
  currentMemberUids: string[],
  currentUid: string
): Set<string> {
  if (currentMemberUids.length <= MAX_EXPENSE_PARTICIPANTS) {
    return new Set(currentMemberUids);
  }
  return new Set([currentUid]);
}

// Whether `uid` may be ADDED to the current selection without exceeding
// the cap. Always true for a uid already selected (this governs new
// additions only - deselecting is never blocked).
export function canSelectParticipant(selected: ReadonlySet<string>, uid: string): boolean {
  if (selected.has(uid)) return true;
  return selected.size < MAX_EXPENSE_PARTICIPANTS;
}

// ---------------------------------------------------------------------
// EXPENSE CREATION FACTS (Checkpoint 4D.3 §22/§23/§24)
// ---------------------------------------------------------------------
//
// Deliberately shaped to match recordTripExpense.ts's own
// NormalizedCreationRequest field-for-field (per the frozen preflight
// §19), as a discriminated union on splitStrategy so a future 4D.4
// percentage/custom strategy can be represented in the TYPE without
// changing 4D.3's own equal-only behavior. Only "equal" has any UI in
// 4D.3 - the percentage/custom participant shapes below exist so this
// union is future-compatible, not because either is buildable yet.

export type EqualSplitParticipantFacts = { uid: string };
export type PercentageSplitParticipantFacts = { uid: string; percentageBasisPoints: number };
export type CustomSplitParticipantFacts = { uid: string; amountMinor: number };

type CommonExpenseCreationFacts = {
  tripId: string;
  payerUid: string;
  amountMinor: number;
  currency: "USD";
  description: string;
  category: string | null;
  paymentSource: "member_out_of_pocket";
  // Ordinary 4D.3 creation ALWAYS has both null - no occurredAt input
  // exists yet (§11 of the checkpoint prompt), and correction mode
  // (which would set replacesExpenseId) is not built until 4D.7.
  occurredAtInstantMs: number | null;
  replacesExpenseId: string | null;
};

export type ExpenseCreationFacts =
  | (CommonExpenseCreationFacts & {
      splitStrategy: "equal";
      participants: EqualSplitParticipantFacts[];
    })
  | (CommonExpenseCreationFacts & {
      splitStrategy: "percentage";
      participants: PercentageSplitParticipantFacts[];
    })
  | (CommonExpenseCreationFacts & {
      splitStrategy: "custom";
      participants: CustomSplitParticipantFacts[];
    });

// Canonicalizes a raw participant uid set into the frozen wire/fact
// order (ascending uid, deduped) - the ONLY place ordering is decided.
// expenseCreationFactsEqual below trusts its inputs are already
// canonicalized rather than re-sorting at comparison time.
export function canonicalizeEqualParticipants(uids: Iterable<string>): EqualSplitParticipantFacts[] {
  return Array.from(new Set(uids))
    .sort()
    .map((uid) => ({ uid }));
}

// Percentage/custom canonicalizers (Checkpoint 4D.4 §23/§24/§38) - unlike
// canonicalizeEqualParticipants above (a flat uid list with no attached
// value, where silent dedup is harmless), a duplicate uid here carries
// two INDEPENDENT financial values that may genuinely disagree - picking
// one arbitrarily would silently discard a contradictory input the
// caller never intended. These FAIL LOUDLY on a duplicate uid instead.
export function canonicalizePercentageParticipants(
  participants: Iterable<PercentageSplitParticipantFacts>
): PercentageSplitParticipantFacts[] {
  const byUid = new Map<string, number>();
  for (const p of participants) {
    if (byUid.has(p.uid)) {
      throw new Error(`canonicalizePercentageParticipants: duplicate participant uid "${p.uid}".`);
    }
    byUid.set(p.uid, p.percentageBasisPoints);
  }
  return Array.from(byUid.keys())
    .sort()
    .map((uid) => ({ uid, percentageBasisPoints: byUid.get(uid) as number }));
}

export function canonicalizeCustomParticipants(
  participants: Iterable<CustomSplitParticipantFacts>
): CustomSplitParticipantFacts[] {
  const byUid = new Map<string, number>();
  for (const p of participants) {
    if (byUid.has(p.uid)) {
      throw new Error(`canonicalizeCustomParticipants: duplicate participant uid "${p.uid}".`);
    }
    byUid.set(p.uid, p.amountMinor);
  }
  return Array.from(byUid.keys())
    .sort()
    .map((uid) => ({ uid, amountMinor: byUid.get(uid) as number }));
}

function equalParticipantsEqual(
  a: EqualSplitParticipantFacts[],
  b: EqualSplitParticipantFacts[]
): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => p.uid === b[i].uid);
}

function percentageParticipantsEqual(
  a: PercentageSplitParticipantFacts[],
  b: PercentageSplitParticipantFacts[]
): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => p.uid === b[i].uid && p.percentageBasisPoints === b[i].percentageBasisPoints);
}

function customParticipantsEqual(
  a: CustomSplitParticipantFacts[],
  b: CustomSplitParticipantFacts[]
): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => p.uid === b[i].uid && p.amountMinor === b[i].amountMinor);
}

// Field-by-field comparison (never JSON.stringify, which would make
// equality depend on accidental property/key order) - every fact the
// backend's own replay-detection compares for a client-suppliable
// field, including a deep (already-canonicalized, order-sensitive)
// participant comparison.
export function expenseCreationFactsEqual(a: ExpenseCreationFacts, b: ExpenseCreationFacts): boolean {
  if (
    a.tripId !== b.tripId ||
    a.payerUid !== b.payerUid ||
    a.amountMinor !== b.amountMinor ||
    a.currency !== b.currency ||
    a.description !== b.description ||
    a.category !== b.category ||
    a.paymentSource !== b.paymentSource ||
    a.occurredAtInstantMs !== b.occurredAtInstantMs ||
    a.replacesExpenseId !== b.replacesExpenseId ||
    a.splitStrategy !== b.splitStrategy
  ) {
    return false;
  }

  if (a.splitStrategy === "equal" && b.splitStrategy === "equal") {
    return equalParticipantsEqual(a.participants, b.participants);
  }
  if (a.splitStrategy === "percentage" && b.splitStrategy === "percentage") {
    return percentageParticipantsEqual(a.participants, b.participants);
  }
  if (a.splitStrategy === "custom" && b.splitStrategy === "custom") {
    return customParticipantsEqual(a.participants, b.participants);
  }
  // Unreachable given the splitStrategy equality check above (TypeScript
  // can't narrow the union across the two independent `a`/`b` variables),
  // but never silently treats a strategy mismatch as "equal".
  return false;
}

// ---------------------------------------------------------------------
// IDEMPOTENCY CONTROLLER (Checkpoint 4D.3 §23), mirroring
// src/domain/savingsMoneyAction.ts's resolveMoneyActionClientRequestId
// exactly.
// ---------------------------------------------------------------------

export type PendingExpenseCreationRequest = ExpenseCreationFacts & { clientRequestId: string };

// Reuses the previous attempt's clientRequestId if the retained pending
// request has the EXACT same facts (a retry of a failed/ambiguous
// submit); otherwise generates a fresh id via the injected generator and
// replaces the pending record (a genuinely new logical request).
export function resolveExpenseClientRequestId(
  pendingRef: { current: PendingExpenseCreationRequest | null },
  facts: ExpenseCreationFacts,
  generateClientRequestId: () => string
): string {
  const pending = pendingRef.current;
  if (pending && expenseCreationFactsEqual(pending, facts)) {
    return pending.clientRequestId;
  }

  const clientRequestId = generateClientRequestId();
  pendingRef.current = { ...facts, clientRequestId };
  return clientRequestId;
}
