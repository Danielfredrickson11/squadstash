// Pure logical-request/idempotency + validation helpers for Expense
// reversal (Checkpoint 4D.6), per the frozen docs/audits/
// TRIP_EXPENSE_REVERSAL_CORRECTION_PREFLIGHT_2026-09-17.md §5/§8/§14 and
// TRIP_EXPENSE_UI_UX_PREFLIGHT_2026-09-18.md §22/§23. No Firestore, no
// React - mirrors src/domain/savingsMoneyAction.ts's exact shape and
// discipline (plain fact comparison, generator injected for tests), the
// same precedent src/domain/expenseSubmission.ts already followed for
// Add Expense.
import { deriveCurrentMemberUids } from "./expenseSubmission";

// ---------------------------------------------------------------------
// REASON NORMALIZATION (reversal preflight §8.2/§14)
// ---------------------------------------------------------------------
//
// Mirrors the trusted backend's own frozen normalization exactly: trim,
// then an omitted OR whitespace-only reason both normalize to the SAME
// value (`undefined`) - never treated as two different logical facts -
// matching normalizeTransactionNote's own trim()->undefined-if-empty
// convention (src/domain/savingsMoneyAction.ts), which this reversal
// model explicitly cites as its own precedent. The 500-character cap
// (MAX_DESCRIPTION_LENGTH's own precedent value, reused per the
// reversal preflight §14) applies to the TRIMMED value and is never
// silently truncated - an over-length reason is a validation failure.
const MAX_REVERSAL_REASON_LENGTH = 500;

export type NormalizeReversalReasonResult =
  | { ok: true; value: string | undefined }
  | { ok: false; error: string };

export function normalizeReversalReason(raw: string): NormalizeReversalReasonResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: undefined };
  if (trimmed.length > MAX_REVERSAL_REASON_LENGTH) {
    return {
      ok: false,
      error: `Reason must be ${MAX_REVERSAL_REASON_LENGTH} characters or fewer.`,
    };
  }
  return { ok: true, value: trimmed };
}

// ---------------------------------------------------------------------
// REVERSAL FACTS / IDEMPOTENCY (reversal preflight §8, UI preflight §23)
// ---------------------------------------------------------------------

export type ExpenseReversalFacts = {
  expenseId: string;
  // Already the NORMALIZED value (see normalizeReversalReason above) -
  // never raw/unnormalized text.
  reversalReason: string | undefined;
};

export type PendingExpenseReversalRequest = ExpenseReversalFacts & { clientRequestId: string };

// Field-by-field comparison (never JSON.stringify) - the exact two facts
// the trusted backend's own reversalRequestsMatch snapshot comparison
// covers for this client (expenseId is implicit in which document is
// being reversed; reversalReason is the only free-form client input).
export function expenseReversalFactsEqual(a: ExpenseReversalFacts, b: ExpenseReversalFacts): boolean {
  return a.expenseId === b.expenseId && a.reversalReason === b.reversalReason;
}

// Reuses the previous attempt's clientRequestId if the retained pending
// request has the EXACT same facts (a retry of a failed/ambiguous
// submit); otherwise generates a fresh id via the injected generator and
// replaces the pending record (a genuinely new logical reversal
// request). Mirrors resolveMoneyActionClientRequestId/
// resolveExpenseClientRequestId exactly.
export function resolveExpenseReversalClientRequestId(
  pendingRef: { current: PendingExpenseReversalRequest | null },
  facts: ExpenseReversalFacts,
  generateClientRequestId: () => string
): string {
  const pending = pendingRef.current;
  if (pending && expenseReversalFactsEqual(pending, facts)) {
    return pending.clientRequestId;
  }

  const clientRequestId = generateClientRequestId();
  pendingRef.current = { ...facts, clientRequestId };
  return clientRequestId;
}

// ---------------------------------------------------------------------
// AUTHORIZATION (reversal preflight §5/§7) - ADVISORY ONLY. The trusted
// reverseTripExpense callable independently re-authorizes every request
// server-side regardless of what this function returns; this exists
// purely to decide what the UI *offers*, matching the UI preflight
// §22's own "advisory only, never a security boundary" framing exactly.
// ---------------------------------------------------------------------

export function canReverseExpense(params: {
  currentUid: string | null | undefined;
  expenseStatus: "active" | "reversed";
  expenseCreatedBy: string;
  tripOwnerId: string | null | undefined;
  tripMemberIds: (string | null | undefined)[] | null | undefined;
}): boolean {
  // Only an "active" Expense may be reversed - reached first so neither
  // authorization branch below needs to repeat this check.
  if (params.expenseStatus !== "active") return false;

  const uid = params.currentUid;
  if (!uid) return false;

  // The Trip's CURRENT owner may always reverse - independent of
  // whether Trip data otherwise failed/is still loading (a missing
  // tripOwnerId simply never equals a real uid, so this fails closed by
  // construction rather than needing a special "Trip unavailable" case).
  if (uid === params.tripOwnerId) return true;

  // Otherwise: must be the Expense's own original creator AND still a
  // CURRENT Trip member (ownerId UNION memberIds) - a departed creator
  // loses independent reversal authority entirely (§7 of the reversal
  // preflight). payerUid/participant status grant nothing, matching the
  // frozen model precisely - neither is ever inspected here.
  if (uid !== params.expenseCreatedBy) return false;

  const currentMemberUids = deriveCurrentMemberUids(params.tripOwnerId, params.tripMemberIds);
  return currentMemberUids.includes(uid);
}

// ---------------------------------------------------------------------
// AMBIGUOUS-OUTCOME RECONCILIATION (Checkpoint 4D.6A)
// ---------------------------------------------------------------------
//
// THE BUG THIS FIXES: an earlier 4D.6 draft treated a LIVE snapshot
// update reporting `reversedBy === currentUid` as sufficient proof that
// THIS client's own pending reversal request had committed. It is not -
// the same account can be signed in on more than one device/session at
// once, each capable of independently reversing the same Expense with
// its OWN distinct clientRequestId. `reversedBy` alone cannot say WHICH
// request committed, only WHOSE uid did. A session with a still-
// unresolved (ambiguous) request must not claim success merely because
// the uid matches - it must independently verify by re-submitting its
// OWN exact pending facts (same clientRequestId, same reversalReason)
// through the trusted callable and observing whether THAT specific
// request is accepted as an exact replay (success) or rejected as
// already reversed under different facts (not this request).
//
// This module never calls the callable itself (no Firestore/React
// here) - it only decides, from already-known facts, what UI action a
// caller should take. The two possible SOURCES of those facts:
//   1. A passive LIVE Expense snapshot update (reconcileLiveReversalUpdate/
//      reduceReversalOutcome with a "live_update" event) - can only ever
//      safely conclude "reversed_by_other" (reversedBy is unambiguously
//      not the current uid, on any device) or "none" (nothing provable
//      yet, including the same-uid-but-unverified case).
//   2. An ACTUAL trusted-callable response to an explicit, user-
//      initiated exact-replay verification ("callable_success"/
//      "callable_failure" events) - this is the only source that can
//      ever conclude genuine "success", because the backend's own
//      exact-replay step (reverseTripExpenseCore step B) only returns
//      success when BOTH reversedBy === the caller's own uid AND the
//      full reversalRequest snapshot (clientRequestId + reversalReason)
//      matches EXACTLY - a coincidental uid match from a DIFFERENT
//      request/device is structurally incapable of passing that replay
//      check, so a successful response is real, verified proof, not an
//      inference.

export type ReversalOutcomeEvent =
  | { type: "callable_success" }
  | { type: "callable_failure"; definitelyDifferentRequest: boolean; errorMessage: string }
  | {
      type: "live_update";
      expenseStatus: "active" | "reversed";
      expenseReversedBy: string | undefined;
      currentUid: string | undefined;
    };

// Checkpoint 4D.6A follow-up: classifies a verification/reversal
// callable's own FAILURE for reconciliation purposes - never for copy
// (reversalErrorMessage in the route file owns that). A failure counts
// as "definitely a different request" ONLY when BOTH:
//   (a) the error is the backend's own DEFINITIVE rejection code for
//       exactly this situation (`failed-precondition`, matching
//       reverseTripExpenseCore's own step G "already reversed by a
//       different reverser/request" outcome), AND
//   (b) the live listener has INDEPENDENTLY confirmed the Expense is
//       actually reversed.
// Requiring BOTH prevents an ambiguous transport/unknown failure
// (unavailable/deadline-exceeded/anything else) from ever being
// mistaken for a definitive different-request outcome merely because
// the Expense already happens to display Reversed - live display alone
// proves nothing about what THIS SPECIFIC verification attempt's own
// response actually was; only the response's own error code can.
export function isDefinitiveDifferentRequestFailure(params: {
  errorCode: string | undefined;
  liveStatusIsReversed: boolean;
}): boolean {
  return params.errorCode === "functions/failed-precondition" && params.liveStatusIsReversed;
}

export type ReversalOutcomeResult =
  | { action: "none" }
  | { action: "success" }
  | { action: "reversed_by_other" }
  | { action: "show_error"; message: string };

// Pure reducer: given one event and whether a same-session reversal
// request is still pending/unresolved, decides the single resulting UI
// action. Never issues a retry itself (§7 of the checkpoint prompt) -
// every event here is either a passive observation or the direct result
// of a call the CALLER (the route/controller) already made; this
// function only classifies the outcome.
//
// Idempotent by construction for the "duplicate announcement"/"race"
// requirements (§9/§12): once an event resolves to "success" or
// "reversed_by_other", the caller clears its own pending-request marker
// (hasPendingRequest becomes false) - every subsequent event, from
// EITHER source, in EITHER arrival order, then hits the `!hasPendingRequest`
// guard below and returns "none", so a second "success" (or any other
// action) can never fire for the same already-resolved request.
export function reduceReversalOutcome(
  event: ReversalOutcomeEvent,
  hasPendingRequest: boolean
): ReversalOutcomeResult {
  if (!hasPendingRequest) return { action: "none" };

  switch (event.type) {
    case "callable_success":
      // A direct, successful trusted-callable response for OUR pending
      // request - genuine, verified proof (whether this was the
      // original submission or an explicit user-initiated exact-replay
      // verification of a previously-ambiguous attempt).
      return { action: "success" };

    case "callable_failure":
      // THE FIX (requirement #5, hardened further by the 4D.6A
      // follow-up review): a failed verification attempt never claims
      // success. Only when the failure is ITSELF a definitive
      // different-request rejection (event.definitelyDifferentRequest -
      // see isDefinitiveDifferentRequestFailure's own contract above,
      // which requires the specific failed-precondition code, never
      // merely "the Expense currently displays Reversed") do we
      // conclude a different request got there first. An AMBIGUOUS
      // failure (unavailable/deadline-exceeded/unknown) always falls
      // through to show_error instead, no matter what the Expense
      // currently displays - preserving the pending request for another
      // explicit, user-initiated verification.
      return event.definitelyDifferentRequest
        ? { action: "reversed_by_other" }
        : { action: "show_error", message: event.errorMessage };

    case "live_update":
      if (event.expenseStatus !== "reversed") return { action: "none" };
      // THE FIX (requirements #2/#3): reversedBy === currentUid is
      // EXPLICITLY NOT treated as proof - only a definitively DIFFERENT
      // uid can be concluded from a live update alone, since that can
      // never be us on any device. A same-uid match stays "none" -
      // genuinely unresolved until an explicit exact-replay
      // verification (a "callable_success"/"callable_failure" event)
      // settles it.
      return event.expenseReversedBy !== event.currentUid
        ? { action: "reversed_by_other" }
        : { action: "none" };
  }
}
