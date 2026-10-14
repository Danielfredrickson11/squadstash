// Checkpoint 5B.4B, per the frozen docs/audits/
// TRIP_WALLET_OWNERSHIP_MIGRATION_PREFLIGHT_2026-10-10.md §5/§16/§16A/
// §16B (as hardened by Amendments 5B.4A.1/5B.4A.2). Pure schema/
// validation primitives for the proposed `tripOwnershipMigrationState`
// companion collection - no Firestore reads/writes happen in this file;
// `functions/src/admin/migrateTripOwnership.ts` is the only writer.
//
// Two independent protections, never conflated (§16A): the LOCKED
// FINANCIAL BASIS protects Trip-document ledger/bootstrap/currency
// facts; the source-history/expected-output digests (see
// `tripOwnershipMigrationDigest.ts`) protect the historical
// `savingsTransactions`/`tripExpenses` documents themselves. Neither
// substitutes for the other.
import {Timestamp} from "firebase-admin/firestore";
import {
  classifyLedgerInitialization,
  deriveLegacyLedgerInitialization,
} from "./savingsLedger";
import {classifyTripOwnershipModelState} from "./tripOwnershipModel";

// ---------------------------------------------------------------------
// LEDGER-BOOTSTRAP CLASSIFICATION (§5's full decision table)
// ---------------------------------------------------------------------

export type LedgerBootstrapClassification =
  | {
      kind: "case_a";
      currentBalanceMinor: number;
      openingBalanceMinor: number;
    }
  | {kind: "case_a_equivalent"}
  | {kind: "ambiguous_opening_balance"; openingBalanceMinor: number}
  | {kind: "uninitialized_with_history"}
  | {kind: "invalid_ledger_state"; reason: string};

/**
 * Classifies a Trip's full ledger-bootstrap state per §5's frozen
 * decision table - reusing `classifyLedgerInitialization`/
 * `deriveLegacyLedgerInitialization` verbatim (never a new, parallel
 * conversion scheme). `hasSavingsTransactionHistory` must reflect
 * ONLY the `savingsTransactions` collection for this Trip (mirroring
 * `recordSavingsTransactionCore`'s own `historySnap.empty` guard
 * exactly) - never the combined `savingsTransactions`+`tripExpenses`
 * count used elsewhere for the automatic-migration size bound.
 * @param {Record<string, unknown>} tripData The Trip document's own
 *   data, exactly as read from Firestore.
 * @param {boolean} hasSavingsTransactionHistory Whether any
 *   `savingsTransactions` document already exists for this Trip.
 * @return {LedgerBootstrapClassification} The classified state.
 */
export function classifyLedgerBootstrapForMigration(
  tripData: Record<string, unknown>,
  hasSavingsTransactionHistory: boolean
): LedgerBootstrapClassification {
  const classified = classifyLedgerInitialization(tripData);

  if (classified.kind === "initialized") {
    // classifyLedgerInitialization already proved both ledger fields
    // are valid non-negative safe integers to reach this kind.
    const openingBalanceMinor = tripData.ledgerOpeningBalanceMinor as number;
    if (openingBalanceMinor > 0) {
      return {kind: "ambiguous_opening_balance", openingBalanceMinor};
    }
    return {
      kind: "case_a",
      currentBalanceMinor: classified.currentBalanceMinor,
      openingBalanceMinor,
    };
  }

  if (classified.kind === "invalid_initialized_state") {
    return {
      kind: "invalid_ledger_state",
      reason: "invalid_initialized_state",
    };
  }

  if (classified.kind === "partial_corrupt") {
    return {kind: "invalid_ledger_state", reason: "partial_corrupt_state"};
  }

  // classified.kind === "uninitialized"
  if (hasSavingsTransactionHistory) {
    return {kind: "uninitialized_with_history"};
  }

  const derived = deriveLegacyLedgerInitialization(tripData.saved ?? 0);
  if (!derived.ok) {
    return {kind: "invalid_ledger_state", reason: derived.reason};
  }
  if (derived.initOpeningMinor > 0) {
    return {
      kind: "ambiguous_opening_balance",
      openingBalanceMinor: derived.initOpeningMinor,
    };
  }
  return {kind: "case_a_equivalent"};
}

// ---------------------------------------------------------------------
// MIGRATION ELIGIBILITY (§4's full five-item rule, items 2/3/4/5 - item
// 1 "Trip document exists" is the caller's own responsibility, checked
// before this is ever called)
// ---------------------------------------------------------------------

export type MigrationEligibilityResult =
  | {
      ok: true;
      ledgerBootstrap:
        | {
            kind: "case_a";
            currentBalanceMinor: number;
            openingBalanceMinor: number;
          }
        | {kind: "case_a_equivalent"};
    }
  | {ok: false; reason: string};

/**
 * Evaluates §4's five-item migration-eligibility rule against an
 * already-read Trip document and already-measured history counts -
 * never performs any Firestore I/O itself. Checks are deliberately
 * ordered cheapest-first (the history-size bound is checked before
 * ever classifying the ledger bootstrap, mirroring §16's own
 * pre-lock-step ordering).
 * @param {object} input Every already-read fact §4 requires.
 * @return {MigrationEligibilityResult} `{ok: true}` with the eligible
 *   Case A/A-equivalent classification, or the specific manual-review
 *   reason code (§26) this Trip fails on.
 */
export function evaluateMigrationEligibility(input: {
  ownershipModelState: unknown;
  ownershipModelVersion: unknown;
  memberIds: unknown;
  tripData: Record<string, unknown>;
  savingsTransactionCount: number;
  combinedHistoryCount: number;
  historyLimit: number;
}): MigrationEligibilityResult {
  const classification = classifyTripOwnershipModelState(
    input.ownershipModelState,
    input.ownershipModelVersion
  );
  if (classification.kind === "corrupt") {
    return {ok: false, reason: "corrupt_ownership_state"};
  }
  if (classification.kind !== "legacy") {
    return {ok: false, reason: `not_legacy_state_${classification.kind}`};
  }

  if (input.combinedHistoryCount > input.historyLimit) {
    return {ok: false, reason: "history_exceeds_automatic_migration_limit"};
  }

  if (!Array.isArray(input.memberIds)) {
    return {ok: false, reason: "malformed_memberIds"};
  }

  const ledgerBootstrap = classifyLedgerBootstrapForMigration(
    input.tripData,
    input.savingsTransactionCount > 0
  );
  if (ledgerBootstrap.kind === "case_a") {
    return {ok: true, ledgerBootstrap};
  }
  if (ledgerBootstrap.kind === "case_a_equivalent") {
    return {ok: true, ledgerBootstrap};
  }
  if (ledgerBootstrap.kind === "ambiguous_opening_balance") {
    return {ok: false, reason: "positive_ambiguous_opening_balance"};
  }
  if (ledgerBootstrap.kind === "uninitialized_with_history") {
    return {ok: false, reason: "uninitialized_ledger_with_history"};
  }
  return {ok: false, reason: "invalid_ledger_state"};
}

// ---------------------------------------------------------------------
// LOCKED FINANCIAL BASIS (§16A, hardened by Checkpoint 5B.4A.2 item 1)
// ---------------------------------------------------------------------

export type LockedFinancialBasis =
  | {
      ledgerInitializationKind: "initialized";
      ledgerOpeningBalanceMinor: number;
      ledgerBalanceMinor: number;
      effectiveCurrency: string;
    }
  | {
      ledgerInitializationKind: "uninitialized";
      derivedLegacyOpeningBalanceMinor: number;
      effectiveCurrency: string;
    };

/**
 * Exact, field-for-field equality between two locked financial bases -
 * never a loose/partial comparison. Used both to re-verify at
 * finalization (§22) and in tests proving the digest-free Trip-level
 * protection actually detects a change.
 * @param {LockedFinancialBasis} a The first basis.
 * @param {LockedFinancialBasis} b The second basis.
 * @return {boolean} True if the two are exactly equal.
 */
export function lockedFinancialBasesEqual(
  a: LockedFinancialBasis,
  b: LockedFinancialBasis
): boolean {
  if (a.ledgerInitializationKind !== b.ledgerInitializationKind) {
    return false;
  }
  if (a.effectiveCurrency !== b.effectiveCurrency) {
    return false;
  }
  if (
    a.ledgerInitializationKind === "initialized" &&
    b.ledgerInitializationKind === "initialized"
  ) {
    return (
      a.ledgerOpeningBalanceMinor === b.ledgerOpeningBalanceMinor &&
      a.ledgerBalanceMinor === b.ledgerBalanceMinor
    );
  }
  if (
    a.ledgerInitializationKind === "uninitialized" &&
    b.ledgerInitializationKind === "uninitialized"
  ) {
    return (
      a.derivedLegacyOpeningBalanceMinor === b.derivedLegacyOpeningBalanceMinor
    );
  }
  return false;
}

/**
 * Builds the canonical locked financial basis from an eligible
 * ledger-bootstrap classification - only `"case_a"`/`"case_a_equivalent"`
 * ever reach this (every other classification excludes the Trip from
 * migration before a basis is ever built, §4/§5).
 * @param {LedgerBootstrapClassification} classification The already-
 *   computed classification (§5).
 * @param {string} effectiveCurrency The Trip's resolved effective
 *   currency.
 * @return {LockedFinancialBasis} The canonical basis.
 */
export function buildLockedFinancialBasis(
  classification: LedgerBootstrapClassification,
  effectiveCurrency: string
): LockedFinancialBasis {
  if (classification.kind === "case_a") {
    return {
      ledgerInitializationKind: "initialized",
      ledgerOpeningBalanceMinor: classification.openingBalanceMinor,
      ledgerBalanceMinor: classification.currentBalanceMinor,
      effectiveCurrency,
    };
  }
  // "case_a_equivalent": uninitialized ledger, no history, derived
  // legacy opening balance is exactly 0.
  return {
    ledgerInitializationKind: "uninitialized",
    derivedLegacyOpeningBalanceMinor: 0,
    effectiveCurrency,
  };
}

// ---------------------------------------------------------------------
// MIGRATION-STATE PHASE LIFECYCLE (§16B)
// ---------------------------------------------------------------------

export type MigrationStatePhase = "locked" | "reconstructed" | "completed";

type MigrationStateCommon = {
  tripId: string;
  attemptId: string;
  lockedAt: Timestamp;
  startedAt: Timestamp;
  lockedFinancialBasis: LockedFinancialBasis;
};

type MigrationStateReconstructedFields = {
  sourceHistoryDigest: string;
  sourceHistoryDocumentCount: number;
  expectedOwnershipDigest: string;
  expectedOwnershipCount: number;
  expectedAllocationDigest: string;
  expectedAllocationCount: number;
};

export type TripOwnershipMigrationState =
  | (MigrationStateCommon & {phase: "locked"})
  | (MigrationStateCommon &
      MigrationStateReconstructedFields & {phase: "reconstructed"})
  | (MigrationStateCommon &
      MigrationStateReconstructedFields & {
        phase: "completed";
        completedAt: Timestamp;
      });

/**
 * The canonical `tripOwnershipMigrationState` document id - one
 * document per Trip, keyed solely by the Trip's own id (no composite,
 * no delimiter concern - mirrors `tripOwnershipAllocationId`'s own
 * "single component, not composite" reasoning).
 * @param {string} tripId The Trip's document id.
 * @return {string} The canonical migration-state document id.
 */
export function tripOwnershipMigrationStateId(tripId: string): string {
  return tripId;
}

export type MigrationStateValidationResult =
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
 * Validates a candidate `LockedFinancialBasis` shape at runtime (the
 * exact fields read back from Firestore, pre-narrowing).
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
  "lockedAt",
  "startedAt",
  "lockedFinancialBasis",
];
const RECONSTRUCTED_FIELD_NAMES = [
  "sourceHistoryDigest",
  "sourceHistoryDocumentCount",
  "expectedOwnershipDigest",
  "expectedOwnershipCount",
  "expectedAllocationDigest",
  "expectedAllocationCount",
];
const COMPLETED_ONLY_FIELD_NAMES = ["completedAt"];

/**
 * Checkpoint 5B.4B.1, Section D: every top-level key actually present
 * on the candidate document must belong to the field set that phase
 * is allowed to carry - never silently ignoring a branch-incompatible
 * extra key that isn't one of the specific "forbidden reconstruction/
 * completedAt fields" this function already names explicitly.
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
 * Validates a candidate `tripOwnershipMigrationState` document's full
 * shape, enforcing the exact discriminated per-phase required/forbidden
 * field rules frozen by §16B - never a bare "does this field exist"
 * check without also confirming the OTHER phase's fields are absent.
 * Unknown/malformed phase values fail closed (Checkpoint 5B.4A.2, item
 * 3 - "no guessed recovery"). Hardened by Checkpoint 5B.4B.1, Section D:
 * requires real Firestore `Timestamp` instances (never a `Date`/string/
 * number placeholder) and rejects any branch-incompatible extra key.
 * @param {unknown} value The candidate document data, exactly as read
 *   back from Firestore.
 * @return {MigrationStateValidationResult} Ok, or the specific reason
 *   validation failed.
 */
export function validateMigrationStateShape(
  value: unknown
): MigrationStateValidationResult {
  if (typeof value !== "object" || value === null) {
    return {ok: false, reason: "Migration state must be an object."};
  }
  const v = value as Record<string, unknown>;

  if (!isNonEmptyString(v.tripId)) {
    return {ok: false, reason: "tripId must be a non-empty string."};
  }
  if (!isNonEmptyString(v.attemptId)) {
    return {ok: false, reason: "attemptId must be a non-empty string."};
  }
  if (!isValidLockedFinancialBasis(v.lockedFinancialBasis)) {
    return {
      ok: false,
      reason: "lockedFinancialBasis is missing or malformed.",
    };
  }
  if (!(v.lockedAt instanceof Timestamp)) {
    return {ok: false, reason: "lockedAt must be a valid Timestamp."};
  }
  if (!(v.startedAt instanceof Timestamp)) {
    return {ok: false, reason: "startedAt must be a valid Timestamp."};
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
    if (v.completedAt !== undefined) {
      return {
        ok: false,
        reason: "phase \"locked\" must not carry completedAt.",
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

  if (v.phase === "reconstructed" || v.phase === "completed") {
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
      !isNonEmptyString(v.expectedOwnershipDigest) ||
      !isNonNegativeSafeInteger(v.expectedOwnershipCount) ||
      !isNonEmptyString(v.expectedAllocationDigest) ||
      !isNonNegativeSafeInteger(v.expectedAllocationCount)
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

    // phase === "completed"
    if (!(v.completedAt instanceof Timestamp)) {
      return {
        ok: false,
        reason: "phase \"completed\" must carry a valid completedAt " +
          "Timestamp.",
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

  return {
    ok: false,
    reason: `Unknown migration-state phase "${String(v.phase)}".`,
  };
}
