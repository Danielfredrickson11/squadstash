// Pure logical-request/authorization/prefill helpers for correcting an
// existing out-of-pocket Trip Expense (Checkpoint 4D.7), per the frozen
// docs/audits/TRIP_EXPENSE_UI_UX_PREFLIGHT_2026-09-18.md §19/§20/§24-§29
// and TRIP_EXPENSE_REVERSAL_CORRECTION_PREFLIGHT_2026-09-17.md §9. No
// Firestore, no React, not even type-only Firestore imports - mirrors
// src/domain/tripExpenseSplits.ts's own "intentionally has no
// Firebase/Firestore imports at all" discipline exactly. Callers convert
// a persisted Expense/ExpenseSplit (which DO carry real Firestore
// Timestamps) into the plain CorrectionSourceExpense/CorrectionSourceSplit
// shapes below before calling in here - occurredAt is always already
// resolved to occurredAtInstantMs (via Timestamp.toMillis()) by the
// caller, never touched as a Timestamp in this file.
import { deriveCurrentMemberUids } from "./expenseSubmission";
import { computeEqualSplit, computePercentageSplit } from "./tripExpenseSplits";

// ---------------------------------------------------------------------
// CORRECTION-TRIGGERED REVERSAL REASON
// ---------------------------------------------------------------------
//
// The correction flow's own confirmation dialog (§7 of the checkpoint
// prompt) never collects a free-text reversal reason (unlike the
// standalone Reverse flow's ReverseExpenseDialog) - reversing the
// original as step 1 of a two-step correction always carries this fixed,
// deterministic reason instead, so the resulting reversal's own audit
// trail is truthful and informative without asking the user to type
// anything.
export const CORRECTION_REVERSAL_REASON = "Corrected";

// ---------------------------------------------------------------------
// CORRECTION-LINK AUTHORIZATION (reversal/correction preflight §9.4,
// implemented server-side in recordTripExpense.ts's own D2/5C step) -
// ADVISORY ONLY, mirrors canReverseExpense's own "never a security
// boundary" framing exactly (src/domain/expenseReversal.ts). Narrower
// than ordinary Expense-creation authority: payerUid/participant status
// grant nothing, matching the frozen model precisely. Deliberately does
// NOT depend on the old Expense's own status (active/reversed) - that is
// a SEPARATE axis, resolved by resolveCorrectionAction below.
// ---------------------------------------------------------------------

export function canClaimCorrection(params: {
  currentUid: string | null | undefined;
  expenseCreatedBy: string;
  expenseReversedBy: string | undefined;
  tripOwnerId: string | null | undefined;
  tripMemberIds: (string | null | undefined)[] | null | undefined;
}): boolean {
  const uid = params.currentUid;
  if (!uid) return false;
  if (uid === params.tripOwnerId) return true;

  const currentMemberUids = deriveCurrentMemberUids(params.tripOwnerId, params.tripMemberIds);
  if (!currentMemberUids.includes(uid)) return false;

  return uid === params.expenseCreatedBy || uid === params.expenseReversedBy;
}

// ---------------------------------------------------------------------
// STATE-DEPENDENT ACTION (UI preflight §24 "Active vs. already-reversed
// correction mode") - what Expense Detail should OFFER, given the old
// Expense's own current persisted state and whether canClaimCorrection
// above already passed. "none" covers both "not authorized" and "already
// has a canonical replacement" (replacedByExpenseId set) - the backend's
// own frozen one-to-one replacement rule means a second correction
// attempt against an already-replaced Expense can only ever fail, so the
// UI must never offer an action that can only fail.
// ---------------------------------------------------------------------

export type CorrectionAction =
  | { kind: "none" }
  | { kind: "start" } // old Expense is "active" - "Correct expense", reverse THEN create.
  | { kind: "finish" }; // old Expense is "reversed", unlinked - "Finish correction", create only.

export function resolveCorrectionAction(params: {
  expenseStatus: "active" | "reversed";
  replacedByExpenseId: string | undefined;
  canClaim: boolean;
}): CorrectionAction {
  if (!params.canClaim) return { kind: "none" };
  if (params.replacedByExpenseId) return { kind: "none" };
  return params.expenseStatus === "active" ? { kind: "start" } : { kind: "finish" };
}

// ---------------------------------------------------------------------
// INPUT-TEXT FORMATTING (exact inverse of
// src/domain/expenseSubmission.ts's parseExpenseMoneyInput/
// parseExpenseShareMoneyInput/parsePercentageToBasisPoints) - integer
// digit-string math only, NEVER (amountMinor / 100).toFixed(2) or any
// other floating-point division, matching this codebase's own frozen
// "no floating-point round-trip" discipline for money exactly. A value
// formatted here and re-parsed by the matching parser in
// expenseSubmission.ts always round-trips to the exact same integer.
// ---------------------------------------------------------------------

export function formatMinorUnitsForInput(amountMinor: number): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new Error("formatMinorUnitsForInput: amountMinor must be a non-negative safe integer.");
  }
  const dollars = Math.trunc(amountMinor / 100);
  const cents = amountMinor - dollars * 100;
  return `${dollars}.${String(cents).padStart(2, "0")}`;
}

export function formatBasisPointsForInput(percentageBasisPoints: number): string {
  if (!Number.isSafeInteger(percentageBasisPoints) || percentageBasisPoints < 0) {
    throw new Error(
      "formatBasisPointsForInput: percentageBasisPoints must be a non-negative safe integer."
    );
  }
  const whole = Math.trunc(percentageBasisPoints / 100);
  const fraction = percentageBasisPoints - whole * 100;
  return `${whole}.${String(fraction).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------
// MEMBERSHIP ELIGIBILITY (§4 of the checkpoint prompt) - a historical
// participant/payer may have since left the Trip. This never decides
// what to DO about an ineligible participant (never auto-drops, never
// auto-transfers their share) - it only partitions the persisted
// participant set so the caller can render an honest explanation and let
// the existing Add Expense form's own current-member-only selector and
// its existing split-total validation force an explicit, reviewed choice
// before the corrected replacement can be saved.
// ---------------------------------------------------------------------

export function partitionParticipantsByEligibility(
  participantUids: string[],
  currentMemberUids: string[]
): { eligible: string[]; ineligible: string[] } {
  const currentSet = new Set(currentMemberUids);
  const eligible: string[] = [];
  const ineligible: string[] = [];
  for (const uid of participantUids) {
    if (currentSet.has(uid)) eligible.push(uid);
    else ineligible.push(uid);
  }
  return { eligible, ineligible };
}

// ---------------------------------------------------------------------
// CORRECTION PREFILL (UI preflight §26) - maps the immutable persisted
// financial facts of the OLD Expense + its Splits into values the
// existing Add Expense form/controller already understand. This is a
// VALIDATOR, never a repairer: any contract violation in the persisted
// Splits (duplicate participant, mismatched total, missing/malformed
// percentage or custom data) returns an explicit error rather than
// silently reinterpreting historical financial data (§3 of the
// checkpoint prompt).
// ---------------------------------------------------------------------

export type CorrectionSourceExpense = {
  paymentSource: "member_out_of_pocket" | "shared_stash";
  payerUid: string | null;
  description: string;
  amountMinor: number;
  category?: string;
  splitStrategy: "equal" | "percentage" | "custom";
  // Already resolved by the caller via Timestamp.toMillis() - null when
  // the old Expense has no occurredAt at all (§5/§26: preserved exactly,
  // never re-derived, never omitted merely because it's inconvenient).
  occurredAtInstantMs: number | null;
};

export type CorrectionSourceSplit = {
  userId: string;
  amountMinor: number;
  percentageBasisPoints?: number;
};

export type CorrectionPrefillData = {
  description: string;
  amountMinor: number;
  amountText: string;
  category: string;
  payerUid: string;
  splitStrategy: "equal" | "percentage" | "custom";
  // ALL historical participants (sorted ascending), regardless of
  // current-membership eligibility - the caller partitions this via
  // partitionParticipantsByEligibility before applying it to form state.
  participantUids: string[];
  percentageInputs: Record<string, string>;
  customInputs: Record<string, string>;
  occurredAtInstantMs: number | null;
};

export type CorrectionPrefillResult =
  | { ok: true; data: CorrectionPrefillData }
  | { ok: false; error: string };

// Sums individually-valid safe integers while checking the RUNNING total
// after every addition - mirrors expenseSubmission.ts's own
// sumSafeIntegers exactly (a small, deliberate duplication of the same
// already-proven arithmetic, matching that file's own precedent for
// duplicating tripExpenseSplits.ts's private sumSafeIntegers).
function sumSafeIntegers(values: number[]): number | null {
  let total = 0;
  for (const value of values) {
    const next = total + value;
    if (!Number.isSafeInteger(next)) return null;
    total = next;
  }
  return total;
}

export function buildCorrectionPrefill(
  oldExpense: CorrectionSourceExpense,
  splits: CorrectionSourceSplit[]
): CorrectionPrefillResult {
  // Checkpoint 4D.7's own scope is "existing out-of-pocket Trip
  // Expenses" - the Add Expense form this correction flow reuses can
  // only ever build a member_out_of_pocket replacement (it has no
  // Shared-Stash creation UI at all in this milestone), so a
  // Shared-Stash-funded original is explicitly unsupported here rather
  // than silently mis-prefilled.
  if (oldExpense.paymentSource !== "member_out_of_pocket") {
    return {
      ok: false,
      error: "This expense was paid from the Shared Stash and can't be corrected here.",
    };
  }
  const payerUid = oldExpense.payerUid;
  if (payerUid === null) {
    return { ok: false, error: "This expense is missing payer information and can't be corrected." };
  }

  if (splits.length === 0) {
    return { ok: false, error: "This expense's split details are missing or incomplete." };
  }

  const seenUids = new Set<string>();
  for (const split of splits) {
    if (seenUids.has(split.userId)) {
      return { ok: false, error: "This expense's split details include a duplicate participant." };
    }
    seenUids.add(split.userId);
  }

  const participantUids = splits.map((s) => s.userId).sort();
  const percentageInputs: Record<string, string> = {};
  const customInputs: Record<string, string> = {};

  // Checkpoint 4D.7A §3: every strategy's persisted amountMinor rows are
  // validated as plain non-negative safe integers first, regardless of
  // whether prefill actually reuses those specific values - a malformed
  // persisted amount is a corrupted historical record and must surface
  // as an explicit error even for Equal (which otherwise only needs the
  // participant SET, not the amounts themselves).
  for (const split of splits) {
    if (!Number.isSafeInteger(split.amountMinor) || split.amountMinor < 0) {
      return { ok: false, error: "This expense's split amounts are invalid." };
    }
  }

  if (oldExpense.splitStrategy === "equal") {
    // Integrity check, not a prefill input: Equal never reuses these
    // persisted amounts (the replacement always recomputes fresh from
    // the participant SET, exactly like ordinary Add Expense), but a
    // persisted row set that doesn't match the frozen deterministic
    // Equal algorithm for these exact participants/amount is corrupted
    // historical data and must be rejected rather than silently trusted
    // merely because the participant set and total superficially look
    // right (the previously-missing check this checkpoint adds).
    let expected;
    try {
      expected = computeEqualSplit(oldExpense.amountMinor, participantUids);
    } catch {
      return { ok: false, error: "This expense's split amounts don't match its participants." };
    }
    const expectedByUid = new Map(expected.map((a) => [a.uid, a.amountMinor]));
    const matches = splits.every((s) => expectedByUid.get(s.userId) === s.amountMinor);
    if (!matches) {
      return { ok: false, error: "This expense's split amounts don't match its participants." };
    }
  } else if (oldExpense.splitStrategy === "percentage") {
    const values: number[] = [];
    const computeParticipants: { uid: string; percentageBasisPoints: number }[] = [];
    for (const split of splits) {
      const pb = split.percentageBasisPoints;
      if (pb === undefined || !Number.isSafeInteger(pb) || pb < 0 || pb > 10000) {
        return { ok: false, error: "This expense's percentage split details are invalid." };
      }
      values.push(pb);
      computeParticipants.push({ uid: split.userId, percentageBasisPoints: pb });
      percentageInputs[split.userId] = formatBasisPointsForInput(pb);
    }
    const total = sumSafeIntegers(values);
    if (total !== 10000) {
      return { ok: false, error: "This expense's percentage split doesn't total 100%." };
    }
    // Cross-check the persisted allocation AMOUNTS against what the
    // frozen Percentage algorithm deterministically produces for these
    // exact basis points - basis points totaling 10000 is necessary but
    // not sufficient; the amounts themselves must match too (the
    // previously-missing check this checkpoint adds).
    let expected;
    try {
      expected = computePercentageSplit(oldExpense.amountMinor, computeParticipants);
    } catch {
      return { ok: false, error: "This expense's percentage split amounts don't match its percentages." };
    }
    const expectedByUid = new Map(expected.map((a) => [a.uid, a.amountMinor]));
    const matches = splits.every((s) => expectedByUid.get(s.userId) === s.amountMinor);
    if (!matches) {
      return { ok: false, error: "This expense's percentage split amounts don't match its percentages." };
    }
  } else {
    const values: number[] = [];
    for (const split of splits) {
      values.push(split.amountMinor);
      customInputs[split.userId] = formatMinorUnitsForInput(split.amountMinor);
    }
    const total = sumSafeIntegers(values);
    if (total !== oldExpense.amountMinor) {
      return { ok: false, error: "This expense's custom split doesn't match its total amount." };
    }
  }

  return {
    ok: true,
    data: {
      description: oldExpense.description,
      amountMinor: oldExpense.amountMinor,
      amountText: formatMinorUnitsForInput(oldExpense.amountMinor),
      category: oldExpense.category ?? "",
      payerUid,
      splitStrategy: oldExpense.splitStrategy,
      participantUids,
      percentageInputs,
      customInputs,
      occurredAtInstantMs: oldExpense.occurredAtInstantMs,
    },
  };
}

// ---------------------------------------------------------------------
// TWO-STEP MUTATION PHASE (Checkpoint 4D.7A §5) - the smallest pure
// extraction of the correction confirm handler's own step-skipping
// contract, proven here without mocking React/Firebase. The actual
// handler (expenses/create.tsx's handleConfirmCorrection) satisfies this
// contract BY CONSTRUCTION: it re-derives the current phase fresh on
// every call via initialCorrectionPhase(oldExpenseState.expense.status),
// where oldExpenseState.expense.status is mutated to "reversed" ONLY
// after a verified-successful reversal response (never on a failure,
// never inferred from anything else) - so a fresh
// initialCorrectionPhase(...) call after any outcome is mathematically
// equivalent to threading nextCorrectionPhase through a persisted ref:
//   - reverse_success -> status becomes "reversed" -> next call's
//     initialCorrectionPhase returns "create", matching
//     nextCorrectionPhase("reverse", reverse_success) === "create".
//   - reverse_failure -> status stays "active" -> next call's
//     initialCorrectionPhase still returns "reverse", matching
//     nextCorrectionPhase("reverse", reverse_failure) === "reverse".
//   - create_failure -> status stays "reversed" (already advanced) ->
//     next call's initialCorrectionPhase still returns "create", NEVER
//     regressing to "reverse" - matching
//     nextCorrectionPhase("create", create_failure) === "create". This
//     is the exact property that guarantees "retrying after a
//     reversal-succeeded-but-creation-failed outcome invokes ONLY
//     creation, never a second reversal."
// ---------------------------------------------------------------------

export type CorrectionMutationPhase = "reverse" | "create" | "done";

export type CorrectionMutationEvent =
  | { type: "reverse_success" }
  | { type: "reverse_failure" }
  | { type: "create_success" }
  | { type: "create_failure" };

// An already-reversed (and unlinked) original skips reversal entirely -
// the create-only ("Finish correction") path.
export function initialCorrectionPhase(oldExpenseStatus: "active" | "reversed"): CorrectionMutationPhase {
  return oldExpenseStatus === "active" ? "reverse" : "create";
}

// A failure at either step NEVER advances the phase (the same step is
// retried, reusing that step's own preserved pending clientRequestId -
// resolveExpenseReversalClientRequestId/resolveExpenseClientRequestId,
// both unmodified, already guarantee that reuse for identical facts).
// Success at "reverse" advances to "create"; success at "create"
// completes the correction. "done" is a terminal, idempotent state.
export function nextCorrectionPhase(
  currentPhase: CorrectionMutationPhase,
  event: CorrectionMutationEvent
): CorrectionMutationPhase {
  if (currentPhase === "reverse") {
    return event.type === "reverse_success" ? "create" : "reverse";
  }
  if (currentPhase === "create") {
    return event.type === "create_success" ? "done" : "create";
  }
  return "done";
}
