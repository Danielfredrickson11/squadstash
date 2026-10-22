// Checkpoint 5C.6, per the frozen docs/audits/
// MULTI_MEMBER_REVERSAL_RECONCILIATION_PREFLIGHT_2026-10-20.md §8/§9.
// Pure schema/validation primitives for the proposed
// `tripOwnershipReconciliationControl` canonical, fixed-id-per-Trip
// coordination document - no Firestore reads/writes happen in this
// file; `functions/src/admin/reconcileTripOwnership.ts` is the only
// writer.
//
// This is MUTABLE COORDINATION STATE, never the permanent audit history
// (that is `tripOwnershipReconciliationAttempt.ts`'s own, separate
// responsibility) - this document exists purely to give every
// concurrent `apply` start a single, deterministic, fixed-id-per-Trip
// contention point to transact against, mirroring
// `tripOwnershipMigrationState/{tripId}`'s own fixed-id role for
// migration exactly. A query over the attempt-history collection alone
// can never serve this purpose (two concurrent callers could each
// independently observe zero active attempts and each create their own)
// - only a fixed document two concurrent transactions are FORCED to
// read/write together gives Firestore's own transaction semantics
// something to resolve the race against.
//
// This file validates only this document's OWN shape, including the one
// pure, no-external-read invariant the preflight freezes
// (`activeAttemptId` can never equal `lastCompletedAttemptId`) -
// referential integrity against the attempt documents those two fields
// NAME (missing/terminal/wrong-Trip/wrong-phase) requires reading those
// other documents, which only the admin tool itself can do; that check
// lives there, not here.
import {Timestamp} from "firebase-admin/firestore";

export type TripOwnershipReconciliationControl = {
  tripId: string;
  activeAttemptId: string | null;
  lastCompletedAttemptId: string | null;
  updatedAt: Timestamp;
};

/**
 * The canonical `tripOwnershipReconciliationControl` document id - one
 * document per Trip, keyed solely by the Trip's own id (no composite,
 * mirroring `tripOwnershipMigrationStateId`'s own "single component"
 * reasoning exactly).
 * @param {string} tripId The Trip's document id.
 * @return {string} The canonical control document id.
 */
export function tripOwnershipReconciliationControlId(tripId: string): string {
  return tripId;
}

export type ReconciliationControlValidationResult =
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
 * True if `value` is `null` or a non-empty string - the shape both
 * `activeAttemptId` and `lastCompletedAttemptId` must have.
 * @param {unknown} value The candidate value.
 * @return {boolean} True if value is a valid nullable-attemptId field.
 */
function isValidNullableAttemptId(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value);
}

const CONTROL_FIELD_NAMES = [
  "tripId",
  "activeAttemptId",
  "lastCompletedAttemptId",
  "updatedAt",
];

/**
 * Validates a candidate `tripOwnershipReconciliationControl` document's
 * full shape - strict field presence/typing, no unexpected keys, and
 * the one pure cross-field invariant that never requires reading
 * another document: `activeAttemptId` and `lastCompletedAttemptId` can
 * never be equal (an attempt cannot simultaneously be the currently-
 * active one and the most-recently-completed one). Fails closed on any
 * malformed shape - never silently repaired.
 * @param {unknown} value The candidate document data, exactly as read
 *   back from Firestore.
 * @return {ReconciliationControlValidationResult} Ok, or the specific
 *   reason validation failed.
 */
export function validateReconciliationControlShape(
  value: unknown
): ReconciliationControlValidationResult {
  if (typeof value !== "object" || value === null) {
    return {ok: false, reason: "Reconciliation control must be an object."};
  }
  const v = value as Record<string, unknown>;

  if (!isNonEmptyString(v.tripId)) {
    return {ok: false, reason: "tripId must be a non-empty string."};
  }
  if (!isValidNullableAttemptId(v.activeAttemptId)) {
    return {
      ok: false,
      reason: "activeAttemptId must be null or a non-empty string.",
    };
  }
  if (!isValidNullableAttemptId(v.lastCompletedAttemptId)) {
    return {
      ok: false,
      reason: "lastCompletedAttemptId must be null or a non-empty string.",
    };
  }
  if (!(v.updatedAt instanceof Timestamp)) {
    return {ok: false, reason: "updatedAt must be a valid Timestamp."};
  }

  const unexpected = Object.keys(v).filter(
    (key) => !CONTROL_FIELD_NAMES.includes(key)
  );
  if (unexpected.length > 0) {
    return {
      ok: false,
      reason: "Reconciliation control carries unexpected field(s): " +
        `${unexpected.join(", ")}.`,
    };
  }

  if (
    v.activeAttemptId !== null &&
    v.lastCompletedAttemptId !== null &&
    v.activeAttemptId === v.lastCompletedAttemptId
  ) {
    return {
      ok: false,
      reason: "activeAttemptId must never equal lastCompletedAttemptId.",
    };
  }

  return {ok: true};
}
