// Checkpoint 6.7A: the trusted, pure classifier for a Trip's SOCIAL
// expense/settlement balance aggregate lifecycle state - independently
// named and independently versioned from tripOwnershipModel.ts's own
// Shared-Stash ownership model. These are two separate systems (see
// docs/architecture/TRIP_PERMISSIONS.md):
//   - tripMemberOwnership = custodial Shared Stash ownership
//   - tripExpenseBalances = social expense/settlement net position
// Mirrors tripOwnershipModel.ts's own classifier shape/behavior exactly
// (same four-state lifecycle, same reasoning for why it is needed - every
// pre-existing Trip predates this field) - but deliberately does NOT
// reuse or overload `ownershipModelState`/`ownershipModelVersion`. No
// Firestore/HttpsError/FieldValue in this file - pure interpretation
// only, matching tripOwnershipModel.ts's own convention.
//
// Two separate fields, never one overloaded field - absent, or one of
// the four persisted string values below:
//   - Trip.expenseBalanceModelState: absent is treated identically to
//     "legacy".
//   - Trip.expenseBalanceModelVersion: absent for legacy/migrating; a
//     positive safe integer once "initialized"; retained unchanged
//     (never cleared) through a transition into "needs_reconciliation".
export type TripExpenseBalanceModelState =
  | "legacy"
  | "migrating"
  | "initialized"
  | "needs_reconciliation";

// The current version a brand-new Trip (createTrip) is given, and the
// value every expense-balance-aware callable must check for exactly.
export const CURRENT_TRIP_EXPENSE_BALANCE_MODEL_VERSION = 1;

export type TripExpenseBalanceClassification =
  | {kind: "legacy"}
  | {kind: "migrating"}
  | {kind: "initialized"; version: number}
  | {kind: "needs_reconciliation"; version: number}
  | {kind: "corrupt"; reason: string};

/**
 * True if `value` is a positive (never zero) safe integer - the shape
 * every real `expenseBalanceModelVersion` must have.
 * @param {unknown} value The candidate value.
 * @return {boolean} True if value is a valid version number.
 */
function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Classifies a Trip's expense-balance-model lifecycle state from its own
 * persisted `expenseBalanceModelState`/`expenseBalanceModelVersion`
 * fields, never inventing or repairing anything - fails closed (returns
 * `"corrupt"`) on every shape this design does not recognize as valid.
 * The caller (a trusted callable) decides what to do with a `"corrupt"`
 * result (reject the operation) - this function only classifies.
 * @param {unknown} state The Trip document's own
 *   `expenseBalanceModelState` field, exactly as read from Firestore
 *   (may be `undefined`).
 * @param {unknown} version The Trip document's own
 *   `expenseBalanceModelVersion` field, exactly as read from Firestore
 *   (may be `undefined`).
 * @return {TripExpenseBalanceClassification} The classified state.
 */
export function classifyTripExpenseBalanceModelState(
  state: unknown,
  version: unknown
): TripExpenseBalanceClassification {
  if (state === undefined || state === "legacy") {
    if (version !== undefined) {
      return {
        kind: "corrupt",
        reason: state === undefined ?
          "expenseBalanceModelVersion is present but " +
            "expenseBalanceModelState is absent." :
          "expenseBalanceModelState is \"legacy\" but " +
            "expenseBalanceModelVersion is present.",
      };
    }
    return {kind: "legacy"};
  }

  if (state === "migrating") {
    if (version !== undefined) {
      return {
        kind: "corrupt",
        reason: "expenseBalanceModelState is \"migrating\" but " +
          "expenseBalanceModelVersion is present - version must stay " +
          "absent while migrating.",
      };
    }
    return {kind: "migrating"};
  }

  if (state === "initialized") {
    if (!isPositiveSafeInteger(version)) {
      return {
        kind: "corrupt",
        reason: "expenseBalanceModelState is \"initialized\" but " +
          "expenseBalanceModelVersion is not a positive safe integer.",
      };
    }
    return {kind: "initialized", version};
  }

  if (state === "needs_reconciliation") {
    if (!isPositiveSafeInteger(version)) {
      return {
        kind: "corrupt",
        reason: "expenseBalanceModelState is \"needs_reconciliation\" " +
          "but expenseBalanceModelVersion is not a positive safe integer.",
      };
    }
    return {kind: "needs_reconciliation", version};
  }

  return {
    kind: "corrupt",
    reason: `Unknown expenseBalanceModelState "${String(state)}".`,
  };
}

// ---------------------------------------------------------------------
// Checkpoint 6.7A: the single shared decision every expense-balance-
// affecting trusted callable (recordTripExpenseCore, reverseTripExpenseCore,
// recordTripSettlementCore, reverseTripSettlementCore) makes about a
// Trip's expense-balance-model state, right after its own existing
// authentication/membership/idempotent-replay handling - mirrors
// tripOwnershipModel.ts's own classifyOwnershipMutationGate exactly.
// ---------------------------------------------------------------------

export type ExpenseBalanceMutationGateResult =
  | {kind: "legacy"}
  | {kind: "blocked"}
  | {kind: "initialized"; version: number}
  | {kind: "fail_closed"};

/**
 * Classifies a Trip's expense-balance-model state into the one decision
 * every expense-balance-affecting trusted callable needs: `"legacy"`
 * (today's exact behavior - no aggregate maintained, no rejection),
 * `"blocked"` (`"migrating"` or `"needs_reconciliation"` - reject every
 * genuinely new mutation), `"initialized"` (full aggregate-maintaining
 * behavior, only once the version also matches
 * `CURRENT_TRIP_EXPENSE_BALANCE_MODEL_VERSION`), or `"fail_closed"`
 * (corrupt, or `"initialized"` at an unsupported version - never
 * trusted, never treated as legacy).
 * @param {unknown} state The Trip document's own
 *   `expenseBalanceModelState` field, exactly as read from Firestore
 *   (may be `undefined`).
 * @param {unknown} version The Trip document's own
 *   `expenseBalanceModelVersion` field, exactly as read from Firestore
 *   (may be `undefined`).
 * @return {ExpenseBalanceMutationGateResult} The gate decision.
 */
export function classifyExpenseBalanceMutationGate(
  state: unknown,
  version: unknown
): ExpenseBalanceMutationGateResult {
  const classification = classifyTripExpenseBalanceModelState(state, version);
  switch (classification.kind) {
  case "legacy":
    return {kind: "legacy"};
  case "migrating":
  case "needs_reconciliation":
    return {kind: "blocked"};
  case "corrupt":
    return {kind: "fail_closed"};
  case "initialized":
    if (
      classification.version !== CURRENT_TRIP_EXPENSE_BALANCE_MODEL_VERSION
    ) {
      return {kind: "fail_closed"};
    }
    return {kind: "initialized", version: classification.version};
  }
}
