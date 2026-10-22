// Checkpoint 5C.6, per the frozen docs/audits/
// MULTI_MEMBER_REVERSAL_RECONCILIATION_PREFLIGHT_2026-10-20.md §8/§10/§11.
// Pure schema/validation primitives for the proposed
// `tripOwnershipReconciliationAttempts` permanent audit-history
// collection - no Firestore reads/writes happen in this file;
// `functions/src/admin/reconcileTripOwnership.ts` is the only writer.
//
// This is the permanent, append-only, multi-attempt AUDIT HISTORY for a
// Trip's reconciliation episodes - distinct from, and never a substitute
// for, the mutable coordination state in
// tripOwnershipReconciliationControl.ts (that file says which attempt, if
// any, is currently active; this file says everything about one
// particular attempt, terminal or not). An attempt's own `attemptId` is
// a fresh random id per episode (unlike migration's single-attempt-per-
// Trip `tripOwnershipMigrationState`), because reconciliation can recur
// for the same Trip across its lifetime.
//
// Phase model intentionally mirrors tripOwnershipMigrationState.ts's own
// `"locked" -> "reconstructed" -> "completed"` discriminated shape
// exactly, with one addition: a terminal `"failed"` phase, required
// because reconciliation (unlike one-time migration) must be able to
// record a failed episode without blocking every future repair attempt
// for the same Trip. `"completed"` and `"failed"` are both strict
// supersets of `"reconstructed"` (they always carry its reconstruction
// evidence fields, plus their own terminal-only fields) - a failure can
// only occur once an attempt has reconstructed (the automatic history
// limit and every other pre-attempt gate rejects a Trip before any
// attempt document is ever created).
import {Timestamp} from "firebase-admin/firestore";
import type {LockedFinancialBasis} from "./tripOwnershipMigrationState";

export type ReconciliationAttemptPhase =
  | "locked"
  | "reconstructed"
  | "completed"
  | "failed";

type ReconciliationAttemptCommon = {
  tripId: string;
  attemptId: string;
  startedAt: Timestamp;
  lockedFinancialBasis: LockedFinancialBasis;
};

// Checkpoint 5C.6, §9/§13: validates the COMPLETE persisted allocation
// set (both "original" and "migrated" provenance) against independently
// reconstructed allocations - "validated", not "expected", since this
// tool never creates allocation records the way migration does; it only
// proves the existing ones are correct.
type ReconciliationAttemptReconstructedFields = {
  sourceHistoryDigest: string;
  sourceHistoryDocumentCount: number;
  validatedAllocationDigest: string;
  validatedAllocationCount: number;
  expectedOwnershipDigest: string;
  expectedOwnershipCount: number;
  expectedAggregateMinor: number;
};

export type TripOwnershipReconciliationAttempt =
  | (ReconciliationAttemptCommon & {phase: "locked"})
  | (ReconciliationAttemptCommon &
      ReconciliationAttemptReconstructedFields & {phase: "reconstructed"})
  | (ReconciliationAttemptCommon &
      ReconciliationAttemptReconstructedFields & {
        phase: "completed";
        completedAt: Timestamp;
      })
  | (ReconciliationAttemptCommon &
      ReconciliationAttemptReconstructedFields & {
        phase: "failed";
        failedAt: Timestamp;
        failureReasonCode: string;
        failureDetail?: string;
      });

/**
 * The canonical `tripOwnershipReconciliationAttempts` document id -
 * `{tripId}_{attemptId}`, mirroring every other composite id in this
 * project (e.g. `tripMemberOwnershipId`). Unlike migration's single
 * per-Trip id, reconciliation needs a fresh id per episode, so the
 * attemptId component is required here - never omittable.
 * @param {string} tripId The Trip's own id.
 * @param {string} attemptId This episode's own fresh random attempt id.
 * @return {string} The canonical attempt document id.
 */
export function tripOwnershipReconciliationAttemptId(
  tripId: string,
  attemptId: string
): string {
  return `${tripId}_${attemptId}`;
}

export type ReconciliationAttemptValidationResult =
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
 * True if `value` is a non-negative safe integer.
 * @param {unknown} value The candidate value.
 * @return {boolean} True if value is a non-negative safe integer.
 */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validates a candidate `LockedFinancialBasis` shape at runtime - the
 * exact same check `tripOwnershipMigrationState.ts`'s own internal
 * validator performs, duplicated here (that function is not exported)
 * rather than widening that file's own module boundary for this one
 * reuse.
 * @param {unknown} value The candidate value.
 * @return {boolean} True if value is a well-formed LockedFinancialBasis.
 */
function isValidLockedFinancialBasis(
  value: unknown
): value is LockedFinancialBasis {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (!isNonEmptyString(v.effectiveCurrency)) {
    return false;
  }
  if (v.ledgerInitializationKind === "initialized") {
    return (
      isNonNegativeSafeInteger(v.ledgerOpeningBalanceMinor) &&
      isNonNegativeSafeInteger(v.ledgerBalanceMinor)
    );
  }
  if (v.ledgerInitializationKind === "uninitialized") {
    return isNonNegativeSafeInteger(v.derivedLegacyOpeningBalanceMinor);
  }
  return false;
}

const COMMON_FIELD_NAMES = [
  "tripId",
  "attemptId",
  "phase",
  "startedAt",
  "lockedFinancialBasis",
];
const RECONSTRUCTED_FIELD_NAMES = [
  "sourceHistoryDigest",
  "sourceHistoryDocumentCount",
  "validatedAllocationDigest",
  "validatedAllocationCount",
  "expectedOwnershipDigest",
  "expectedOwnershipCount",
  "expectedAggregateMinor",
];
const COMPLETED_ONLY_FIELD_NAMES = ["completedAt"];
const FAILED_ONLY_FIELD_NAMES = [
  "failedAt",
  "failureReasonCode",
  "failureDetail",
];

/**
 * Every top-level key actually present on the candidate document must
 * belong to the field set that phase is allowed to carry - mirrors
 * `tripOwnershipMigrationState.ts`'s own `findUnexpectedKeys` exactly.
 * @param {Record<string, unknown>} v The candidate document data.
 * @param {string[]} allowedNames Every field name this phase permits.
 * @return {string[]} Any present key not in `allowedNames`.
 */
function findUnexpectedKeys(
  v: Record<string, unknown>,
  allowedNames: string[]
): string[] {
  const allowed = new Set(allowedNames);
  return Object.keys(v).filter((key) => !allowed.has(key));
}

/**
 * Validates a candidate `tripOwnershipReconciliationAttempts` document's
 * full shape, enforcing the exact discriminated per-phase required/
 * forbidden field rules frozen by §8/§10/§11 of the preflight - never a
 * bare "does this field exist" check without also confirming every
 * OTHER phase's fields are absent. Unknown/malformed phase values fail
 * closed. `"completed"`/`"failed"` are both required to carry every
 * reconstruction field (strict supersets of `"reconstructed"`) - a
 * terminal outcome without evidence of having reached reconstruction is
 * rejected as malformed, never silently accepted.
 * @param {unknown} value The candidate document data, exactly as read
 *   back from Firestore.
 * @return {ReconciliationAttemptValidationResult} Ok, or the specific
 *   reason validation failed.
 */
export function validateReconciliationAttemptShape(
  value: unknown
): ReconciliationAttemptValidationResult {
  if (typeof value !== "object" || value === null) {
    return {ok: false, reason: "Reconciliation attempt must be an object."};
  }
  const v = value as Record<string, unknown>;

  if (!isNonEmptyString(v.tripId)) {
    return {ok: false, reason: "tripId must be a non-empty string."};
  }
  if (!isNonEmptyString(v.attemptId)) {
    return {ok: false, reason: "attemptId must be a non-empty string."};
  }
  if (!(v.startedAt instanceof Timestamp)) {
    return {ok: false, reason: "startedAt must be a valid Timestamp."};
  }
  if (!isValidLockedFinancialBasis(v.lockedFinancialBasis)) {
    return {
      ok: false,
      reason: "lockedFinancialBasis is missing or malformed.",
    };
  }

  const presentReconstructedFields = RECONSTRUCTED_FIELD_NAMES.filter(
    (name) => v[name] !== undefined
  );

  if (v.phase === "locked") {
    if (presentReconstructedFields.length > 0) {
      return {
        ok: false,
        reason: "phase \"locked\" must not carry reconstruction fields " +
          `(found: ${presentReconstructedFields.join(", ")}).`,
      };
    }
    const unexpected = findUnexpectedKeys(v, COMMON_FIELD_NAMES);
    if (unexpected.length > 0) {
      return {
        ok: false,
        reason: "phase \"locked\" carries unexpected field(s): " +
          `${unexpected.join(", ")}.`,
      };
    }
    return {ok: true};
  }

  if (
    v.phase === "reconstructed" ||
    v.phase === "completed" ||
    v.phase === "failed"
  ) {
    const missing = RECONSTRUCTED_FIELD_NAMES.filter(
      (name) => v[name] === undefined
    );
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `phase "${v.phase}" is missing required reconstruction ` +
          `fields: ${missing.join(", ")}.`,
      };
    }
    if (
      !isNonEmptyString(v.sourceHistoryDigest) ||
      !isNonNegativeSafeInteger(v.sourceHistoryDocumentCount) ||
      !isNonEmptyString(v.validatedAllocationDigest) ||
      !isNonNegativeSafeInteger(v.validatedAllocationCount) ||
      !isNonEmptyString(v.expectedOwnershipDigest) ||
      !isNonNegativeSafeInteger(v.expectedOwnershipCount) ||
      !isNonNegativeSafeInteger(v.expectedAggregateMinor)
    ) {
      return {
        ok: false,
        reason: "one or more reconstruction fields are malformed.",
      };
    }

    if (v.phase === "reconstructed") {
      if (v.completedAt !== undefined) {
        return {
          ok: false,
          reason: "phase \"reconstructed\" must not carry completedAt.",
        };
      }
      if (
        v.failedAt !== undefined ||
        v.failureReasonCode !== undefined ||
        v.failureDetail !== undefined
      ) {
        return {
          ok: false,
          reason: "phase \"reconstructed\" must not carry failure fields.",
        };
      }
      const unexpected = findUnexpectedKeys(v, [
        ...COMMON_FIELD_NAMES,
        ...RECONSTRUCTED_FIELD_NAMES,
      ]);
      if (unexpected.length > 0) {
        return {
          ok: false,
          reason: "phase \"reconstructed\" carries unexpected field(s): " +
            `${unexpected.join(", ")}.`,
        };
      }
      return {ok: true};
    }

    if (v.phase === "completed") {
      if (!(v.completedAt instanceof Timestamp)) {
        return {
          ok: false,
          reason: "phase \"completed\" must carry a valid completedAt " +
            "Timestamp.",
        };
      }
      if (
        v.failedAt !== undefined ||
        v.failureReasonCode !== undefined ||
        v.failureDetail !== undefined
      ) {
        return {
          ok: false,
          reason: "phase \"completed\" must not carry failure fields.",
        };
      }
      const unexpected = findUnexpectedKeys(v, [
        ...COMMON_FIELD_NAMES,
        ...RECONSTRUCTED_FIELD_NAMES,
        ...COMPLETED_ONLY_FIELD_NAMES,
      ]);
      if (unexpected.length > 0) {
        return {
          ok: false,
          reason: "phase \"completed\" carries unexpected field(s): " +
            `${unexpected.join(", ")}.`,
        };
      }
      return {ok: true};
    }

    // phase === "failed"
    if (v.completedAt !== undefined) {
      return {
        ok: false,
        reason: "phase \"failed\" must not carry completedAt.",
      };
    }
    if (!(v.failedAt instanceof Timestamp)) {
      return {
        ok: false,
        reason: "phase \"failed\" must carry a valid failedAt Timestamp.",
      };
    }
    if (!isNonEmptyString(v.failureReasonCode)) {
      return {
        ok: false,
        reason: "phase \"failed\" must carry a non-empty failureReasonCode.",
      };
    }
    if (v.failureDetail !== undefined && typeof v.failureDetail !== "string") {
      return {
        ok: false,
        reason: "phase \"failed\" failureDetail, if present, must be a " +
          "string.",
      };
    }
    const unexpected = findUnexpectedKeys(v, [
      ...COMMON_FIELD_NAMES,
      ...RECONSTRUCTED_FIELD_NAMES,
      ...FAILED_ONLY_FIELD_NAMES,
    ]);
    if (unexpected.length > 0) {
      return {
        ok: false,
        reason: "phase \"failed\" carries unexpected field(s): " +
          `${unexpected.join(", ")}.`,
      };
    }
    return {ok: true};
  }

  return {
    ok: false,
    reason: `Unknown reconciliation-attempt phase "${String(v.phase)}".`,
  };
}
