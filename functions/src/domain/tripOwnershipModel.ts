// Checkpoint 5B.1: the trusted, pure classifier for a Trip's ownership-
// model lifecycle state, per the frozen design in docs/audits/
// TRIP_WALLET_OWNERSHIP_WITHDRAWAL_PREFLIGHT_2026-10-08.md §12A (as
// hardened by Amendment 5B.0B). No Firestore/HttpsError/FieldValue in
// this file - mirrors savingsLedger.ts's own "pure interpretation only"
// convention exactly. NOT wired into any trusted financial callable yet
// (that is explicitly 5B.3's job) - this checkpoint only defines the
// classifier so a future callable can use it safely.
//
// Two separate fields, never one overloaded field (§12A.1):
//   - Trip.ownershipModelState: absent, or one of the four persisted
//     string values below. Corrected by Checkpoint 5B.1A: the frozen
//     preflight (§12A.1) explicitly lists state as "One of: *absent*
//     (treated identically to "legacy"), "legacy", "migrating",
//     "initialized", "needs_reconciliation"" - absence and the literal
//     "legacy" string are two DIFFERENT persisted representations of
//     the SAME classification, not "legacy is absence-only." (5B.1's
//     first pass incorrectly narrowed this to absence-only and must be
//     treated as having stated that in error - this comment and the
//     classifier below are the correction.)
//   - Trip.ownershipModelVersion: absent for legacy/migrating; a
//     positive safe integer once "initialized"; retained unchanged
//     (never cleared) through a transition into "needs_reconciliation".
export type TripOwnershipModelState =
  | "legacy"
  | "migrating"
  | "initialized"
  | "needs_reconciliation";

// The current version a brand-new "initialized" Trip is given, and the
// value 5C's own per-Trip gate must check for exactly (preflight §20).
// Checkpoint 5B.1A, item 8: this constant lives ONLY here, on the
// Functions/trusted-backend side - no client-side mirror exists. The
// client makes no authorization decision and has no production consumer
// that needs this value (the 5B.1 original duplicated it into
// src/domain/tripOwnershipModel.ts anyway, "to keep in sync manually" -
// a drift risk for a financial model version with no actual consumer to
// justify it; that file has been removed). If a genuine client-side
// consumer is ever added, prefer an automated parity test over manual
// "keep in sync" duplication.
export const CURRENT_TRIP_OWNERSHIP_MODEL_VERSION = 1;

export type TripOwnershipClassification =
  | {kind: "legacy"}
  | {kind: "migrating"}
  | {kind: "initialized"; version: number}
  | {kind: "needs_reconciliation"; version: number}
  | {kind: "corrupt"; reason: string};

/**
 * True if `value` is a non-negative safe integer (never a float, never
 * unsafe, never anything but a genuine integer `number`).
 * @param {unknown} value The candidate value.
 * @return {boolean} True if value is a valid minor-unit amount.
 */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * True if `value` is a positive (never zero) safe integer - the shape
 * every real `ownershipModelVersion` must have.
 * @param {unknown} value The candidate value.
 * @return {boolean} True if value is a valid version number.
 */
function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

/**
 * Classifies a Trip's ownership-model lifecycle state from its own
 * persisted `ownershipModelState`/`ownershipModelVersion` fields, never
 * inventing or repairing anything - fails closed (returns `"corrupt"`)
 * on every shape this design does not recognize as valid. The caller
 * (a future trusted callable) decides what to do with a `"corrupt"`
 * result (reject the operation) - this function only classifies.
 * @param {unknown} state The Trip document's own `ownershipModelState`
 *   field, exactly as read from Firestore (may be `undefined`).
 * @param {unknown} version The Trip document's own
 *   `ownershipModelVersion` field, exactly as read from Firestore (may
 *   be `undefined`).
 * @return {TripOwnershipClassification} The classified state.
 */
export function classifyTripOwnershipModelState(
  state: unknown,
  version: unknown
): TripOwnershipClassification {
  if (state === undefined || state === "legacy") {
    if (version !== undefined) {
      return {
        kind: "corrupt",
        reason: state === undefined ?
          "ownershipModelVersion is present but ownershipModelState is " +
            "absent." :
          "ownershipModelState is \"legacy\" but ownershipModelVersion " +
            "is present.",
      };
    }
    return {kind: "legacy"};
  }

  if (state === "migrating") {
    if (version !== undefined) {
      return {
        kind: "corrupt",
        reason: "ownershipModelState is \"migrating\" but " +
          "ownershipModelVersion is present - version must stay absent " +
          "while migrating.",
      };
    }
    return {kind: "migrating"};
  }

  if (state === "initialized") {
    if (!isPositiveSafeInteger(version)) {
      return {
        kind: "corrupt",
        reason: "ownershipModelState is \"initialized\" but " +
          "ownershipModelVersion is not a positive safe integer.",
      };
    }
    return {kind: "initialized", version};
  }

  if (state === "needs_reconciliation") {
    if (!isPositiveSafeInteger(version)) {
      return {
        kind: "corrupt",
        reason: "ownershipModelState is \"needs_reconciliation\" but " +
          "ownershipModelVersion is not a positive safe integer.",
      };
    }
    return {kind: "needs_reconciliation", version};
  }

  return {
    kind: "corrupt",
    reason: `Unknown ownershipModelState "${String(state)}".`,
  };
}
