// Checkpoint 5C.6: trusted Trip-ownership reconciliation/repair tool, per
// the frozen docs/audits/
// MULTI_MEMBER_REVERSAL_RECONCILIATION_PREFLIGHT_2026-10-20.md. A local,
// Admin-SDK-only Node.js script - NEVER exported from
// functions/src/index.ts, NEVER wrapped in onCall/HTTP, NEVER reachable
// from app/client code. Single-Trip only. Dry-run is the default/safest
// mode; applying a repair requires an explicit, separate, unambiguous
// invocation. A SEPARATE tool from functions/src/admin/
// migrateTripOwnership.ts - that file is never modified, and this file
// never shares its own execution-target guard or lock/control model with
// it, per the frozen preflight's own §4 FROZEN decision.
//
// This file performs every Firestore read/write reconciliation needs;
// every piece of actual arithmetic/validation is delegated to the
// existing, unchanged pure domain modules (tripOwnershipAccounting.ts,
// tripOwnershipModel.ts, tripOwnershipAllocation.ts,
// tripOwnershipMigrationReplay.ts, tripOwnershipMigrationDigest.ts) plus
// the two new pure domain modules written alongside this checkpoint
// (tripOwnershipReconciliationAttempt.ts,
// tripOwnershipReconciliationControl.ts) - this file never duplicates
// that math. It DOES duplicate migrateTripOwnership.ts's own small,
// file-local raw-Firestore read/parse boundary helpers (never shared
// pure math) - this project's established convention of keeping each
// trusted tool's own I/O boundary independent (see e.g.
// AUTOMATIC_MIGRATION_HISTORY_LIMIT's own "independently declared"
// precedent, reused here as AUTOMATIC_RECONCILIATION_HISTORY_LIMIT).
import {randomUUID} from "crypto";
import {FieldValue, Timestamp, getFirestore} from "firebase-admin/firestore";
import type {Firestore, Query} from "firebase-admin/firestore";
import {initializeApp} from "firebase-admin/app";

import {
  reconcileOwnershipAgainstAggregate,
  sumOwnershipMinor,
} from "../domain/tripOwnershipAccounting";
import type {MemberOwnershipBalance} from "../domain/tripOwnershipAccounting";
import {tripMemberOwnershipId} from "../domain/tripMemberOwnership";
import {
  tripOwnershipAllocationId,
  validateTripOwnershipAllocationShape,
} from "../domain/tripOwnershipAllocation";
import type {
  TripOwnershipAllocationEntry,
} from "../domain/tripOwnershipAllocation";
import {
  classifyTripOwnershipModelState,
  CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
} from "../domain/tripOwnershipModel";
import {resolveEffectiveCurrency} from "../domain/savingsLedger";
import {
  buildLockedFinancialBasis,
  classifyLedgerBootstrapForMigration,
  lockedFinancialBasesEqual,
} from "../domain/tripOwnershipMigrationState";
import type {LockedFinancialBasis} from "../domain/tripOwnershipMigrationState";
import {
  computeAllocationDigest,
  computeOwnershipDigest,
  computeSourceHistoryDigest,
} from "../domain/tripOwnershipMigrationDigest";
import type {
  AllocationEconomicProjection,
  DigestExpenseInput,
  DigestSavingsTransactionInput,
} from "../domain/tripOwnershipMigrationDigest";
import {
  buildLogicalEvents,
  orderLogicalEvents,
  replayAggregateLedgerTotal,
  replayLogicalEvents,
} from "../domain/tripOwnershipMigrationReplay";
import type {
  RawSavingsTransactionRecord,
  RawTripExpenseRecord,
  ReconstructedAllocation,
} from "../domain/tripOwnershipMigrationReplay";
import {
  tripOwnershipReconciliationAttemptId,
  validateReconciliationAttemptShape,
} from "../domain/tripOwnershipReconciliationAttempt";
import type {
  TripOwnershipReconciliationAttempt,
} from "../domain/tripOwnershipReconciliationAttempt";
import {
  tripOwnershipReconciliationControlId,
  validateReconciliationControlShape,
} from "../domain/tripOwnershipReconciliationControl";
import type {
  TripOwnershipReconciliationControl,
} from "../domain/tripOwnershipReconciliationControl";

// ---------------------------------------------------------------------
// CENTRALIZED, NAMED BOUNDS
// ---------------------------------------------------------------------

// Independently declared, same value as migrateTripOwnership.ts's own
// AUTOMATIC_MIGRATION_HISTORY_LIMIT - this tool's own trusted-boundary
// constant, per this project's established per-tool duplication
// convention (never imported from that file).
export const AUTOMATIC_RECONCILIATION_HISTORY_LIMIT = 2000;

// Firestore's own documented 500-write transaction/batch ceiling,
// chunked well under it - identical reasoning to migrateTripOwnership.ts's
// own OUTPUT_WRITE_CHUNK_SIZE, independently declared here.
export const OUTPUT_WRITE_CHUNK_SIZE = 400;

/**
 * Splits a reason string of this codebase's own established
 * `"<reason_code>: <human detail>"` convention into its two parts.
 * @param {string} reason The raw reason string.
 * @return {object} The split {reasonCode, detail} parts.
 */
function splitReasonCode(reason: string): {
  reasonCode: string;
  detail: string;
} {
  const idx = reason.indexOf(": ");
  if (idx === -1) {
    return {reasonCode: reason, detail: reason};
  }
  return {reasonCode: reason.slice(0, idx), detail: reason.slice(idx + 2)};
}

// ---------------------------------------------------------------------
// RAW FIRESTORE READS / PARSING (duplicated boundary code - see file
// header. Logic is IDENTICAL to migrateTripOwnership.ts's own parse
// functions, since both tools parse the exact same two collections into
// the exact same shared replay/digest input shapes.)
// ---------------------------------------------------------------------

type ParsedResult<T> = {ok: true; value: T} | {ok: false; reason: string};

/**
 * The index-free query for every `savingsTransactions` document for one
 * Trip.
 * @param {Firestore} db The Firestore instance.
 * @param {string} tripId The Trip's own id.
 * @return {Query} The query.
 */
function tripSavingsTransactionsQuery(db: Firestore, tripId: string): Query {
  return db
    .collection("savingsTransactions")
    .where("resourceType", "==", "trip")
    .where("resourceId", "==", tripId);
}

/**
 * The index-free query for every `tripExpenses` document for one Trip.
 * @param {Firestore} db The Firestore instance.
 * @param {string} tripId The Trip's own id.
 * @return {Query} The query.
 */
function tripExpensesQuery(db: Firestore, tripId: string): Query {
  return db.collection("tripExpenses").where("tripId", "==", tripId);
}

/**
 * The index-free query for every `tripOwnershipAllocations` record for
 * one Trip.
 * @param {Firestore} db The Firestore instance.
 * @param {string} tripId The Trip's own id.
 * @return {Query} The query.
 */
function tripAllocationsQuery(db: Firestore, tripId: string): Query {
  return db
    .collection("tripOwnershipAllocations")
    .where("tripId", "==", tripId);
}

/**
 * The index-free query for every `tripMemberOwnership` row for one Trip.
 * @param {Firestore} db The Firestore instance.
 * @param {string} tripId The Trip's own id.
 * @return {Query} The query.
 */
function tripOwnershipRowsQuery(db: Firestore, tripId: string): Query {
  return db.collection("tripMemberOwnership").where("tripId", "==", tripId);
}

/**
 * Structurally validates one raw `savingsTransactions` document's field
 * TYPES before anything is passed to a pure primitive - identical to
 * migrateTripOwnership.ts's own `parseSavingsTransactionRecord`.
 * @param {string} id The document's own Firestore id.
 * @param {Record<string, unknown>} d The document's raw field data.
 * @return {ParsedResult<RawSavingsTransactionRecord>} The parsed record,
 *   or the specific reason it is malformed.
 */
function parseSavingsTransactionRecord(
  id: string,
  d: Record<string, unknown>
): ParsedResult<RawSavingsTransactionRecord> {
  if (d.resourceType !== "trip") {
    return {
      ok: false,
      reason: "unexpected_historical_record_type: savingsTransactions/" +
        `${id} has an unexpected resourceType.`,
    };
  }
  if (typeof d.resourceId !== "string" || d.resourceId.length === 0) {
    return {
      ok: false,
      reason: "unexpected_historical_record_type: savingsTransactions/" +
        `${id} has a malformed resourceId.`,
    };
  }
  if (typeof d.memberUid !== "string" || d.memberUid.length === 0) {
    return {
      ok: false,
      reason: "unexpected_historical_record_type: savingsTransactions/" +
        `${id} has a malformed memberUid.`,
    };
  }
  if (d.type !== "contribution" && d.type !== "withdrawal") {
    return {
      ok: false,
      reason: "unexpected_historical_record_type: savingsTransactions/" +
        `${id} has an unrecognized type.`,
    };
  }
  if (
    typeof d.amountMinor !== "number" ||
    !Number.isSafeInteger(d.amountMinor) ||
    d.amountMinor <= 0
  ) {
    return {
      ok: false,
      reason: `malformed_transaction_amount: savingsTransactions/${id}.`,
    };
  }
  if (typeof d.currency !== "string" || d.currency.length === 0) {
    return {
      ok: false,
      reason: "unexpected_historical_record_type: savingsTransactions/" +
        `${id} has a malformed currency.`,
    };
  }
  if (!(d.createdAt instanceof Timestamp)) {
    return {
      ok: false,
      reason: `missing_required_timestamp: savingsTransactions/${id}.`,
    };
  }
  if (d.reversalOf !== null && typeof d.reversalOf !== "string") {
    return {
      ok: false,
      reason: "unexpected_historical_record_type: savingsTransactions/" +
        `${id} has a malformed reversalOf.`,
    };
  }
  if (
    d.linkedExpenseId !== undefined &&
    typeof d.linkedExpenseId !== "string"
  ) {
    return {
      ok: false,
      reason: "unexpected_historical_record_type: savingsTransactions/" +
        `${id} has a malformed linkedExpenseId.`,
    };
  }
  return {
    ok: true,
    value: {
      id,
      resourceType: d.resourceType,
      resourceId: d.resourceId,
      memberUid: d.memberUid,
      type: d.type,
      amountMinor: d.amountMinor,
      currency: d.currency,
      createdAt: d.createdAt,
      reversalOf: d.reversalOf === undefined ? null : d.reversalOf,
      linkedExpenseId:
        d.linkedExpenseId === undefined ? null : d.linkedExpenseId,
    },
  };
}

type ParsedExpenseRecord = RawTripExpenseRecord & DigestExpenseInput;

/**
 * Structurally validates one raw `tripExpenses` document's field TYPES -
 * identical to migrateTripOwnership.ts's own `parseExpenseRecord`.
 * @param {string} id The document's own Firestore id.
 * @param {string} tripId The Trip this document is expected to belong
 *   to.
 * @param {Record<string, unknown>} d The document's raw field data.
 * @return {ParsedResult<ParsedExpenseRecord>} The parsed record, or the
 *   specific reason it is malformed.
 */
function parseExpenseRecord(
  id: string,
  tripId: string,
  d: Record<string, unknown>
): ParsedResult<ParsedExpenseRecord> {
  if (d.tripId !== tripId) {
    return {
      ok: false,
      reason: `unexpected_historical_record_type: tripExpenses/${id} has ` +
        "an unexpected tripId.",
    };
  }
  if (
    d.paymentSource !== "member_out_of_pocket" &&
    d.paymentSource !== "shared_stash"
  ) {
    return {
      ok: false,
      reason: `unexpected_historical_record_type: tripExpenses/${id} has ` +
        "an unrecognized paymentSource.",
    };
  }
  if (
    typeof d.amountMinor !== "number" ||
    !Number.isSafeInteger(d.amountMinor) ||
    d.amountMinor <= 0
  ) {
    return {
      ok: false,
      reason: `malformed_transaction_amount: tripExpenses/${id}.`,
    };
  }
  if (typeof d.currency !== "string" || d.currency.length === 0) {
    return {
      ok: false,
      reason: `unexpected_historical_record_type: tripExpenses/${id} has ` +
        "a malformed currency.",
    };
  }
  if (
    d.sharedStashTransactionId !== undefined &&
    (typeof d.sharedStashTransactionId !== "string" ||
      d.sharedStashTransactionId.length === 0)
  ) {
    return {
      ok: false,
      reason: `unexpected_historical_record_type: tripExpenses/${id} has ` +
        "a malformed sharedStashTransactionId.",
    };
  }
  if (d.status !== "active" && d.status !== "reversed") {
    return {
      ok: false,
      reason: `unexpected_historical_record_type: tripExpenses/${id} has ` +
        "an unrecognized status.",
    };
  }
  if (!(d.createdAt instanceof Timestamp)) {
    return {
      ok: false,
      reason: `missing_required_timestamp: tripExpenses/${id}.`,
    };
  }
  if (d.reversedAt !== undefined && !(d.reversedAt instanceof Timestamp)) {
    return {
      ok: false,
      reason: `missing_required_timestamp: tripExpenses/${id} has a ` +
        "malformed reversedAt.",
    };
  }
  if (
    d.refundTransactionId !== undefined &&
    (typeof d.refundTransactionId !== "string" ||
      d.refundTransactionId.length === 0)
  ) {
    return {
      ok: false,
      reason: `unexpected_historical_record_type: tripExpenses/${id} has ` +
        "a malformed refundTransactionId.",
    };
  }
  if (
    d.replacesExpenseId !== undefined &&
    (typeof d.replacesExpenseId !== "string" ||
      d.replacesExpenseId.length === 0)
  ) {
    return {
      ok: false,
      reason: `unexpected_historical_record_type: tripExpenses/${id} has ` +
        "a malformed replacesExpenseId.",
    };
  }
  if (
    d.replacedByExpenseId !== undefined &&
    (typeof d.replacedByExpenseId !== "string" ||
      d.replacedByExpenseId.length === 0)
  ) {
    return {
      ok: false,
      reason: `unexpected_historical_record_type: tripExpenses/${id} has ` +
        "a malformed replacedByExpenseId.",
    };
  }
  return {
    ok: true,
    value: {
      id,
      tripId: d.tripId,
      paymentSource: d.paymentSource,
      amountMinor: d.amountMinor,
      currency: d.currency,
      sharedStashTransactionId:
        d.sharedStashTransactionId === undefined ?
          null :
          d.sharedStashTransactionId,
      status: d.status,
      createdAt: d.createdAt,
      reversedAt: d.reversedAt === undefined ? null : d.reversedAt,
      refundTransactionId:
        d.refundTransactionId === undefined ? null : d.refundTransactionId,
      replacesExpenseId:
        d.replacesExpenseId === undefined ? null : d.replacesExpenseId,
      replacedByExpenseId:
        d.replacedByExpenseId === undefined ? null : d.replacedByExpenseId,
    },
  };
}

type HistoryCounts = {
  savingsTransactionCount: number;
  tripExpenseCount: number;
  combinedCount: number;
};

/**
 * The cheap, read-only pre-attempt history-size measurement - a count()
 * aggregation query per collection, never a full document load.
 * @param {Firestore} db The Firestore instance.
 * @param {string} tripId The Trip's own id.
 * @return {Promise<HistoryCounts>} The measured counts.
 */
async function measureTripHistoryCounts(
  db: Firestore,
  tripId: string
): Promise<HistoryCounts> {
  const [txCountSnap, expenseCountSnap] = await Promise.all([
    tripSavingsTransactionsQuery(db, tripId).count().get(),
    tripExpensesQuery(db, tripId).count().get(),
  ]);
  const savingsTransactionCount = txCountSnap.data().count;
  const tripExpenseCount = expenseCountSnap.data().count;
  return {
    savingsTransactionCount,
    tripExpenseCount,
    combinedCount: savingsTransactionCount + tripExpenseCount,
  };
}

type LoadedHistory = {
  transactions: RawSavingsTransactionRecord[];
  expenses: ParsedExpenseRecord[];
};

type LoadHistoryResult =
  | {ok: true; history: LoadedHistory}
  | {ok: false; reason: string};

/**
 * Loads and parses the Trip's complete bounded source history - never
 * inside an enclosing transaction, safe only because this is called
 * after the Trip has already been confirmed quiesced via the control
 * document (apply), or is merely read-only/advisory (dry run).
 * @param {Firestore} db The Firestore instance.
 * @param {string} tripId The Trip's own id.
 * @return {Promise<LoadHistoryResult>} The parsed history, or the
 *   specific reason a document failed structural validation.
 */
async function loadTripHistory(
  db: Firestore,
  tripId: string
): Promise<LoadHistoryResult> {
  const [txSnap, expenseSnap] = await Promise.all([
    tripSavingsTransactionsQuery(db, tripId).get(),
    tripExpensesQuery(db, tripId).get(),
  ]);

  const transactions: RawSavingsTransactionRecord[] = [];
  for (const doc of txSnap.docs) {
    const parsed = parseSavingsTransactionRecord(doc.id, doc.data());
    if (!parsed.ok) {
      return {ok: false, reason: parsed.reason};
    }
    transactions.push(parsed.value);
  }

  const expenses: ParsedExpenseRecord[] = [];
  for (const doc of expenseSnap.docs) {
    const parsed = parseExpenseRecord(doc.id, tripId, doc.data());
    if (!parsed.ok) {
      return {ok: false, reason: parsed.reason};
    }
    expenses.push(parsed.value);
  }

  return {ok: true, history: {transactions, expenses}};
}

type ParsedAllocationRecord = AllocationEconomicProjection & {
  provenance: "original" | "migrated";
  migratedAt: Timestamp | null;
};

type LoadAllocationsResult =
  | {ok: true; allocations: ParsedAllocationRecord[]}
  | {ok: false; reason: string};

/**
 * Loads and strictly parses the Trip's COMPLETE persisted
 * `tripOwnershipAllocations` set - both "original" and "migrated"
 * provenance alike (frozen preflight §6/§9). Never rewrites, deletes,
 * recreates, or changes the provenance of any record read here - this
 * is read-only evidence-gathering.
 * @param {Firestore} db The Firestore instance.
 * @param {string} tripId The Trip's own id.
 * @return {Promise<LoadAllocationsResult>} The parsed allocation set, or
 *   the specific reason a record failed structural validation.
 */
async function loadPersistedAllocations(
  db: Firestore,
  tripId: string
): Promise<LoadAllocationsResult> {
  const snap = await tripAllocationsQuery(db, tripId).get();
  const allocations: ParsedAllocationRecord[] = [];
  for (const doc of snap.docs) {
    const d = doc.data() as Record<string, unknown>;
    const shapeResult = validateTripOwnershipAllocationShape({
      tripId: d.tripId,
      expenseId: d.expenseId,
      withdrawalTransactionId: d.withdrawalTransactionId,
      amountMinor: d.amountMinor,
      currency: d.currency,
      allocations: d.allocations,
      provenance: d.provenance,
    });
    if (!shapeResult.ok || !(d.createdAt instanceof Timestamp)) {
      return {
        ok: false,
        reason: "malformed_persisted_allocation: tripOwnershipAllocations/" +
          `${doc.id}.`,
      };
    }
    const expectedId = tripOwnershipAllocationId(
      d.withdrawalTransactionId as string
    );
    if (doc.id !== expectedId) {
      return {
        ok: false,
        reason: "malformed_persisted_allocation: tripOwnershipAllocations/" +
          `${doc.id} is not stored at its own canonical id.`,
      };
    }
    if (d.provenance === "migrated" && !(d.migratedAt instanceof Timestamp)) {
      return {
        ok: false,
        reason: "malformed_persisted_allocation: tripOwnershipAllocations/" +
          `${doc.id} has provenance "migrated" but no valid migratedAt.`,
      };
    }
    if (d.provenance === "original" && d.migratedAt !== undefined) {
      return {
        ok: false,
        reason: "malformed_persisted_allocation: tripOwnershipAllocations/" +
          `${doc.id} has provenance "original" but carries migratedAt.`,
      };
    }
    allocations.push({
      id: doc.id,
      tripId: d.tripId as string,
      expenseId: d.expenseId as string,
      withdrawalTransactionId: d.withdrawalTransactionId as string,
      amountMinor: d.amountMinor as number,
      currency: d.currency as string,
      allocations: d.allocations as TripOwnershipAllocationEntry[],
      provenance: d.provenance as "original" | "migrated",
      createdAt: d.createdAt as Timestamp,
      migratedAt: d.migratedAt instanceof Timestamp ? d.migratedAt : null,
    });
  }
  return {ok: true, allocations};
}

type LoadedOwnershipRows = {
  balances: MemberOwnershipBalance[];
  rowIds: Set<string>;
};

type LoadOwnershipRowsResult =
  | {ok: true; rows: LoadedOwnershipRows}
  | {ok: false; reason: string};

/**
 * Loads and strictly parses the Trip's COMPLETE current
 * `tripMemberOwnership` row set.
 * @param {Firestore} db The Firestore instance.
 * @param {string} tripId The Trip's own id.
 * @return {Promise<LoadOwnershipRowsResult>} The parsed row set, or the
 *   specific reason a row failed structural validation.
 */
async function loadCurrentOwnershipRows(
  db: Firestore,
  tripId: string
): Promise<LoadOwnershipRowsResult> {
  const snap = await tripOwnershipRowsQuery(db, tripId).get();
  const balances: MemberOwnershipBalance[] = [];
  const rowIds = new Set<string>();
  for (const doc of snap.docs) {
    const d = doc.data() as Record<string, unknown>;
    if (
      typeof d.uid !== "string" ||
      d.uid.length === 0 ||
      d.tripId !== tripId ||
      doc.id !== tripMemberOwnershipId(tripId, d.uid) ||
      typeof d.ownershipMinor !== "number" ||
      !Number.isSafeInteger(d.ownershipMinor) ||
      d.ownershipMinor < 0
    ) {
      return {
        ok: false,
        reason: "malformed_current_ownership_row: tripMemberOwnership/" +
          `${doc.id}.`,
      };
    }
    balances.push({uid: d.uid, ownershipMinor: d.ownershipMinor});
    rowIds.add(d.uid);
  }
  return {ok: true, rows: {balances, rowIds}};
}

/**
 * Resolves a Trip's effective currency - identical reuse of
 * `savingsLedger.ts`'s own canonical `resolveEffectiveCurrency` as
 * migrateTripOwnership.ts's own `resolveTripEffectiveCurrency`.
 * @param {Record<string, unknown>} tripData The Trip's own data.
 * @return {object} `{ok: true, effectiveCurrency}`, or `{ok: false}` if
 *   the Trip's own `currency` field is malformed.
 */
function resolveTripEffectiveCurrency(
  tripData: Record<string, unknown>
): {ok: true; effectiveCurrency: string} | {ok: false} {
  const candidate =
    typeof tripData.currency === "string" ? tripData.currency : "USD";
  const result = resolveEffectiveCurrency(tripData, candidate);
  if (!result.ok) {
    return {ok: false};
  }
  return {ok: true, effectiveCurrency: result.effectiveCurrency};
}

/**
 * Derives the two plain `openingBalanceMinor`/`aggregateLedgerBalanceMinor`
 * numbers from a `LockedFinancialBasis` - identical to
 * migrateTripOwnership.ts's own `basisAmounts`.
 * @param {LockedFinancialBasis} basis The locked/frozen financial basis.
 * @return {object} `{openingBalanceMinor, aggregateLedgerBalanceMinor}`.
 */
function basisAmounts(basis: LockedFinancialBasis): {
  openingBalanceMinor: number;
  aggregateLedgerBalanceMinor: number;
} {
  if (basis.ledgerInitializationKind === "initialized") {
    return {
      openingBalanceMinor: basis.ledgerOpeningBalanceMinor,
      aggregateLedgerBalanceMinor: basis.ledgerBalanceMinor,
    };
  }
  return {
    openingBalanceMinor: basis.derivedLegacyOpeningBalanceMinor,
    aggregateLedgerBalanceMinor: basis.derivedLegacyOpeningBalanceMinor,
  };
}

/**
 * Builds a Trip's current locked financial basis directly from its own
 * data (no eligibility gate - unlike migration, a Trip under
 * reconciliation is never required to be Case A/A-equivalent; any
 * well-formed ledger state is acceptable since this tool repairs
 * ownership rows/aggregate, never the ledger-bootstrap shape itself).
 * @param {Record<string, unknown>} tripData The Trip's own data.
 * @param {boolean} hasSavingsTransactionHistory Whether any
 *   `savingsTransactions` document already exists for this Trip.
 * @return {object} `{ok: true, basis}` or the specific reason this
 *   Trip's financial basis could not be built.
 */
function buildCurrentTripFinancialBasis(
  tripData: Record<string, unknown>,
  hasSavingsTransactionHistory: boolean
): {ok: true; basis: LockedFinancialBasis} | {ok: false; reason: string} {
  const bootstrap = classifyLedgerBootstrapForMigration(
    tripData,
    hasSavingsTransactionHistory
  );
  if (bootstrap.kind !== "case_a" && bootstrap.kind !== "case_a_equivalent") {
    return {ok: false, reason: "invalid_ledger_state"};
  }
  const currencyResolution = resolveTripEffectiveCurrency(tripData);
  if (!currencyResolution.ok) {
    return {ok: false, reason: "invalid_ledger_state"};
  }
  return {
    ok: true,
    basis: buildLockedFinancialBasis(
      bootstrap,
      currencyResolution.effectiveCurrency
    ),
  };
}

// ---------------------------------------------------------------------
// RECONSTRUCTION + VALIDATION PIPELINE (shared by dry-run and apply)
// ---------------------------------------------------------------------

type ReconciliationAnomaly = {
  reasonCode: string;
  detail: string;
};

type ReconstructionResult =
  | {
      ok: true;
      ownership: MemberOwnershipBalance[];
      allocations: ReconstructedAllocation[];
      sourceHistoryDigest: {hash: string; count: number};
      expectedOwnershipDigest: {hash: string; count: number};
      replayedAggregateTotalMinor: number;
    }
  | {ok: false; anomaly: ReconciliationAnomaly};

/**
 * Runs the read-only reconstruction half of the pipeline: build logical
 * events, order them, replay ownership/allocations, independently
 * replay the aggregate, and compute the source-history/ownership
 * digests. Never performs any Firestore I/O itself, and never compares
 * against persisted allocations - that is a separate step
 * (`validatePersistedAllocations` below), per the frozen preflight §5's
 * correction that `replayLogicalEvents` must never be asked to accept
 * persisted allocations as fixed inputs.
 * @param {LoadedHistory} history The already-loaded, parsed history.
 * @param {string} tripId The Trip's own id.
 * @param {string} effectiveCurrency The Trip's resolved currency.
 * @param {number} openingBalanceMinor The locked opening balance to
 *   replay the independent aggregate total from.
 * @param {number} currentAggregateLedgerBalanceMinor The Trip's current
 *   `ledgerBalanceMinor` to independently verify the replayed aggregate
 *   against.
 * @return {ReconstructionResult} The full reconstruction, or the
 *   specific anomaly reconstruction failed on.
 */
function runReconciliationReconstruction(
  history: LoadedHistory,
  tripId: string,
  effectiveCurrency: string,
  openingBalanceMinor: number,
  currentAggregateLedgerBalanceMinor: number
): ReconstructionResult {
  const builtEvents = buildLogicalEvents(
    history.transactions,
    history.expenses,
    effectiveCurrency
  );
  if (!builtEvents.ok) {
    const {reasonCode, detail} = splitReasonCode(builtEvents.reason);
    return {ok: false, anomaly: {reasonCode, detail}};
  }

  const ordered = orderLogicalEvents(builtEvents.events);
  if (!ordered.ok) {
    const {reasonCode, detail} = splitReasonCode(ordered.reason);
    return {ok: false, anomaly: {reasonCode, detail}};
  }

  const replayed = replayLogicalEvents(ordered.ordered, tripId);
  if (!replayed.ok) {
    const {reasonCode, detail} = splitReasonCode(replayed.reason);
    return {ok: false, anomaly: {reasonCode, detail}};
  }

  const aggregateReplay = replayAggregateLedgerTotal(
    openingBalanceMinor,
    ordered.ordered
  );
  if (!aggregateReplay.ok) {
    const {reasonCode, detail} = splitReasonCode(aggregateReplay.reason);
    return {ok: false, anomaly: {reasonCode, detail}};
  }

  if (aggregateReplay.totalMinor !== currentAggregateLedgerBalanceMinor) {
    return {
      ok: false,
      anomaly: {
        reasonCode: "aggregate_history_mismatch",
        detail: "Independently-replayed aggregate total " +
          `(${aggregateReplay.totalMinor}) disagrees with the Trip's ` +
          `current ledgerBalanceMinor (${currentAggregateLedgerBalanceMinor}).`,
      },
    };
  }

  const digestTransactions: DigestSavingsTransactionInput[] =
    history.transactions;
  const digestExpenses: DigestExpenseInput[] = history.expenses;
  const sourceHistoryDigest = computeSourceHistoryDigest(
    digestTransactions,
    digestExpenses
  );
  const expectedOwnershipDigest = computeOwnershipDigest(replayed.ownership);

  return {
    ok: true,
    ownership: replayed.ownership,
    allocations: replayed.allocations,
    sourceHistoryDigest,
    expectedOwnershipDigest,
    replayedAggregateTotalMinor: aggregateReplay.totalMinor,
  };
}

type AllocationValidationResult =
  | {
      ok: true;
      validatedAllocationDigest: {hash: string; count: number};
    }
  | {ok: false; anomaly: ReconciliationAnomaly};

/**
 * Validates the Trip's COMPLETE persisted allocation set (both
 * "original" and "migrated" provenance) against the independently
 * reconstructed allocations, as a SEPARATE step from replay itself
 * (frozen preflight §5/§9/§13) - requiring an exact one-to-one economic
 * match (withdrawalTransactionId, tripId, expenseId, amountMinor,
 * currency, allocations array, createdAt). Never rewrites, deletes, or
 * recreates any persisted allocation. A missing, extra, malformed, or
 * economically-mismatched allocation is reported as
 * `requires_manual_review` - never automatically repaired.
 * @param {ReconstructedAllocation[]} reconstructed The independently
 *   replayed allocation set.
 * @param {ParsedAllocationRecord[]} persisted The complete, already-
 *   parsed persisted allocation set.
 * @return {AllocationValidationResult} The validated-allocation digest
 *   (covering the complete persisted set), or the specific anomaly.
 */
function validatePersistedAllocations(
  reconstructed: ReconstructedAllocation[],
  persisted: ParsedAllocationRecord[]
): AllocationValidationResult {
  const persistedById = new Map(persisted.map((a) => [a.id, a]));
  const reconstructedIds = new Set(
    reconstructed.map((a) => a.withdrawalTransactionId)
  );

  for (const r of reconstructed) {
    const p = persistedById.get(r.withdrawalTransactionId);
    if (!p) {
      return {
        ok: false,
        anomaly: {
          reasonCode: "missing_persisted_allocation",
          detail: "Replay reconstructed an allocation for withdrawal " +
            `${r.withdrawalTransactionId}, but no persisted ` +
            "tripOwnershipAllocations record exists for it.",
        },
      };
    }
    const matches =
      p.tripId === r.tripId &&
      p.expenseId === r.expenseId &&
      p.withdrawalTransactionId === r.withdrawalTransactionId &&
      p.amountMinor === r.amountMinor &&
      p.currency === r.currency &&
      JSON.stringify(p.allocations) === JSON.stringify(r.allocations) &&
      p.createdAt.isEqual(r.createdAt);
    if (!matches) {
      return {
        ok: false,
        anomaly: {
          reasonCode: "allocation_economic_mismatch",
          detail: `tripOwnershipAllocations/${p.id} disagrees with the ` +
            "independently reconstructed allocation for this withdrawal.",
        },
      };
    }
  }

  for (const p of persisted) {
    if (!reconstructedIds.has(p.withdrawalTransactionId)) {
      return {
        ok: false,
        anomaly: {
          reasonCode: "extra_persisted_allocation",
          detail: `tripOwnershipAllocations/${p.id} exists but replay ` +
            "reconstructed no corresponding allocation for its " +
            "withdrawal.",
        },
      };
    }
  }

  const projections: AllocationEconomicProjection[] = persisted.map((p) => ({
    id: p.id,
    tripId: p.tripId,
    expenseId: p.expenseId,
    withdrawalTransactionId: p.withdrawalTransactionId,
    amountMinor: p.amountMinor,
    currency: p.currency,
    allocations: p.allocations,
    provenance: p.provenance,
    createdAt: p.createdAt,
  }));
  const validatedAllocationDigest = computeAllocationDigest(projections);
  return {ok: true, validatedAllocationDigest};
}

/**
 * Classifies the complete current `tripMemberOwnership` row set against
 * the replay's final ownership map (frozen preflight §7): every uid
 * replay produced (including a legitimate zero balance) must have a row
 * at the expected value; every CURRENT row whose uid replay never
 * produced at all is a rogue row with no supporting history, deletable
 * during repair. Current `memberIds` is never the criterion.
 * @param {MemberOwnershipBalance[]} expected The replay's final
 *   ownership set.
 * @param {Set<string>} currentRowUids Every uid with a CURRENT
 *   `tripMemberOwnership` row for this Trip.
 * @return {object} `{rowsToWrite, rogueUids}`.
 */
function classifyOwnershipRepair(
  expected: MemberOwnershipBalance[],
  currentRowUids: Set<string>
): {
  rowsToWrite: MemberOwnershipBalance[];
  rogueUids: string[];
} {
  const expectedUids = new Set(expected.map((b) => b.uid));
  const rogueUids = [...currentRowUids].filter((uid) => !expectedUids.has(uid));
  return {rowsToWrite: expected, rogueUids};
}

/**
 * Computes the exact sum of a reconstructed ownership set, for audit-
 * output reporting only - identical to migrateTripOwnership.ts's own
 * `sumReconstructedOwnership`.
 * @param {MemberOwnershipBalance[]} balances The reconstructed ownership
 *   set.
 * @return {number | null} The exact total, or `null` if it could not be
 *   computed (structurally unreachable in practice).
 */
function sumReconstructedOwnership(
  balances: MemberOwnershipBalance[]
): number | null {
  if (balances.length === 0) {
    return 0;
  }
  const result = sumOwnershipMinor(balances);
  return result.ok ? result.totalMinor : null;
}

// ---------------------------------------------------------------------
// AUDIT-OUTPUT SHAPE
// ---------------------------------------------------------------------

export type ReconciliationAuditResult = {
  tripId: string;
  attemptId: string | null;
  mode: "dry_run" | "apply";
  phase: "locked" | "reconstructed" | "completed" | "failed" | null;
  verdict: "repaired" | "requires_manual_review" | "safe_to_reconcile";
  lockedFinancialBasis: LockedFinancialBasis | null;
  openingBalanceMinor: number | null;
  aggregateLedgerBalanceMinor: number | null;
  sourceHistoryDigest: string | null;
  sourceHistoryDocumentCount: number | null;
  expectedOwnership: MemberOwnershipBalance[] | null;
  expectedOwnershipTotalMinor: number | null;
  expectedOwnershipDigest: string | null;
  validatedAllocationDigest: string | null;
  validatedAllocationCount: number | null;
  rogueOwnershipRowUids: string[] | null;
  anomalies: ReconciliationAnomaly[];
  reconciliation: {
    aggregateMatches: boolean | null;
    lockedFinancialBasisMatches: boolean | null;
    sourceHistoryDigestMatches: boolean | null;
    exactOwnershipOutputMatches: boolean | null;
  };
  startedAt: string;
  completedAt: string | null;
};

/**
 * A fresh, all-null reconciliation-evidence block.
 * @return {object} The empty reconciliation block.
 */
function emptyReconciliationEvidence(): (
  ReconciliationAuditResult["reconciliation"]
) {
  return {
    aggregateMatches: null,
    lockedFinancialBasisMatches: null,
    sourceHistoryDigestMatches: null,
    exactOwnershipOutputMatches: null,
  };
}

/**
 * A fresh base audit result - the starting point for both dry-run and
 * apply results, filled in as each step actually runs.
 * @param {string} tripId The Trip's own id.
 * @param {"dry_run" | "apply"} mode The run mode.
 * @param {string} startedAt The ISO-8601 start timestamp.
 * @return {ReconciliationAuditResult} The empty base result.
 */
function emptyAuditResult(
  tripId: string,
  mode: "dry_run" | "apply",
  startedAt: string
): ReconciliationAuditResult {
  return {
    tripId,
    attemptId: null,
    mode,
    phase: null,
    verdict: "requires_manual_review",
    lockedFinancialBasis: null,
    openingBalanceMinor: null,
    aggregateLedgerBalanceMinor: null,
    sourceHistoryDigest: null,
    sourceHistoryDocumentCount: null,
    expectedOwnership: null,
    expectedOwnershipTotalMinor: null,
    expectedOwnershipDigest: null,
    validatedAllocationDigest: null,
    validatedAllocationCount: null,
    rogueOwnershipRowUids: null,
    anomalies: [],
    reconciliation: emptyReconciliationEvidence(),
    startedAt,
    completedAt: null,
  };
}

// ---------------------------------------------------------------------
// DRY RUN - zero writes, under any circumstance.
// ---------------------------------------------------------------------

/**
 * Performs the full read-only dry-run pipeline for one Trip. Never
 * creates or touches any attempt/control document, regardless of
 * outcome.
 * @param {Firestore} db The Firestore instance.
 * @param {string} tripId The Trip to evaluate.
 * @return {Promise<ReconciliationAuditResult>} The structured audit
 *   result.
 */
export async function runDryRun(
  db: Firestore,
  tripId: string
): Promise<ReconciliationAuditResult> {
  const startedAt = new Date().toISOString();
  const result = emptyAuditResult(tripId, "dry_run", startedAt);

  const tripSnap = await db.collection("trips").doc(tripId).get();
  if (!tripSnap.exists) {
    throw new Error(`No trip found for tripId "${tripId}".`);
  }
  const tripData = tripSnap.data() as Record<string, unknown>;

  const classification = classifyTripOwnershipModelState(
    tripData.ownershipModelState,
    tripData.ownershipModelVersion
  );
  if (classification.kind !== "needs_reconciliation") {
    result.anomalies.push({
      reasonCode: "trip_not_eligible",
      detail: `Trip ownership-model state is "${classification.kind}", ` +
        "not \"needs_reconciliation\" - this tool only repairs a Trip " +
        "already flagged for reconciliation.",
    });
    result.completedAt = new Date().toISOString();
    return result;
  }
  if (classification.version !== CURRENT_TRIP_OWNERSHIP_MODEL_VERSION) {
    result.anomalies.push({
      reasonCode: "unsupported_ownership_version",
      detail: `Trip is at ownership version ${classification.version}, ` +
        `not the supported version ${CURRENT_TRIP_OWNERSHIP_MODEL_VERSION}.`,
    });
    result.completedAt = new Date().toISOString();
    return result;
  }

  const counts = await measureTripHistoryCounts(db, tripId);
  if (counts.combinedCount > AUTOMATIC_RECONCILIATION_HISTORY_LIMIT) {
    result.anomalies.push({
      reasonCode: "history_exceeds_automatic_reconciliation_limit",
      detail: `Combined history count ${counts.combinedCount} exceeds ` +
        `the automatic limit of ${AUTOMATIC_RECONCILIATION_HISTORY_LIMIT}.`,
    });
    result.completedAt = new Date().toISOString();
    return result;
  }

  const basisResult = buildCurrentTripFinancialBasis(
    tripData,
    counts.savingsTransactionCount > 0
  );
  if (!basisResult.ok) {
    result.anomalies.push({
      reasonCode: basisResult.reason,
      detail: basisResult.reason,
    });
    result.completedAt = new Date().toISOString();
    return result;
  }
  result.lockedFinancialBasis = basisResult.basis;
  const {openingBalanceMinor, aggregateLedgerBalanceMinor} = basisAmounts(
    basisResult.basis
  );
  result.openingBalanceMinor = openingBalanceMinor;
  result.aggregateLedgerBalanceMinor = aggregateLedgerBalanceMinor;

  const loaded = await loadTripHistory(db, tripId);
  if (!loaded.ok) {
    const {reasonCode, detail} = splitReasonCode(loaded.reason);
    result.anomalies.push({reasonCode, detail});
    result.completedAt = new Date().toISOString();
    return result;
  }

  const reconstruction = runReconciliationReconstruction(
    loaded.history,
    tripId,
    basisResult.basis.effectiveCurrency,
    openingBalanceMinor,
    aggregateLedgerBalanceMinor
  );
  if (!reconstruction.ok) {
    result.anomalies.push(reconstruction.anomaly);
    result.completedAt = new Date().toISOString();
    return result;
  }
  result.reconciliation.aggregateMatches = true;
  result.sourceHistoryDigest = reconstruction.sourceHistoryDigest.hash;
  result.sourceHistoryDocumentCount = reconstruction.sourceHistoryDigest.count;
  result.expectedOwnership = reconstruction.ownership;
  result.expectedOwnershipTotalMinor = sumReconstructedOwnership(
    reconstruction.ownership
  );
  result.expectedOwnershipDigest = reconstruction.expectedOwnershipDigest.hash;

  const persistedResult = await loadPersistedAllocations(db, tripId);
  if (!persistedResult.ok) {
    const {reasonCode, detail} = splitReasonCode(persistedResult.reason);
    result.anomalies.push({reasonCode, detail});
    result.completedAt = new Date().toISOString();
    return result;
  }
  const allocationValidation = validatePersistedAllocations(
    reconstruction.allocations,
    persistedResult.allocations
  );
  if (!allocationValidation.ok) {
    result.anomalies.push(allocationValidation.anomaly);
    result.completedAt = new Date().toISOString();
    return result;
  }
  result.validatedAllocationDigest =
    allocationValidation.validatedAllocationDigest.hash;
  result.validatedAllocationCount =
    allocationValidation.validatedAllocationDigest.count;

  const currentRowsResult = await loadCurrentOwnershipRows(db, tripId);
  if (!currentRowsResult.ok) {
    const {reasonCode, detail} = splitReasonCode(currentRowsResult.reason);
    result.anomalies.push({reasonCode, detail});
    result.completedAt = new Date().toISOString();
    return result;
  }
  const {rogueUids} = classifyOwnershipRepair(
    reconstruction.ownership,
    currentRowsResult.rows.rowIds
  );
  result.rogueOwnershipRowUids = rogueUids;

  result.verdict = "safe_to_reconcile";
  result.completedAt = new Date().toISOString();
  return result;
}

// ---------------------------------------------------------------------
// APPLY MODE - control-document acquisition / phase-aware resume /
// materialization / finalization
// ---------------------------------------------------------------------

type AttemptAcquisitionOutcome =
  | {kind: "acquired"; attemptId: string; phase: "locked" | "reconstructed"}
  | {kind: "anomaly"; reasonCode: string; detail: string};

/**
 * The control-document acquisition transaction (frozen preflight §8/§9).
 * Every concurrent `apply` start is forced to read/write the SAME fixed
 * `tripOwnershipReconciliationControl/{tripId}` document, giving this
 * Trip exactly one deterministic contention point - never a query over
 * the attempt-history collection alone.
 * @param {Firestore} db The Firestore instance.
 * @param {string} tripId The Trip's own id.
 * @return {Promise<AttemptAcquisitionOutcome>} The outcome of this
 *   attempt.
 */
async function acquireOrResumeAttempt(
  db: Firestore,
  tripId: string
): Promise<AttemptAcquisitionOutcome> {
  const tripRef = db.collection("trips").doc(tripId);
  const controlRef = db
    .collection("tripOwnershipReconciliationControl")
    .doc(tripOwnershipReconciliationControlId(tripId));

  return db.runTransaction(async (tx) => {
    const tripSnap = await tx.get(tripRef);
    if (!tripSnap.exists) {
      return {
        kind: "anomaly",
        reasonCode: "trip_not_found",
        detail: `No trip found for tripId "${tripId}".`,
      };
    }
    const tripData = tripSnap.data() as Record<string, unknown>;
    const classification = classifyTripOwnershipModelState(
      tripData.ownershipModelState,
      tripData.ownershipModelVersion
    );
    if (classification.kind !== "needs_reconciliation") {
      return {
        kind: "anomaly",
        reasonCode: "trip_not_eligible",
        detail: `Trip ownership-model state is "${classification.kind}", ` +
          "not \"needs_reconciliation\".",
      };
    }
    if (classification.version !== CURRENT_TRIP_OWNERSHIP_MODEL_VERSION) {
      return {
        kind: "anomaly",
        reasonCode: "unsupported_ownership_version",
        detail: `Trip is at ownership version ${classification.version}.`,
      };
    }

    const controlSnap = await tx.get(controlRef);

    if (!controlSnap.exists) {
      // First-ever case: control absent. Checkpoint 5C.6 cleanup pass:
      // must ALSO prove zero historical attempt documents exist for this
      // Trip - control absence alone is not sufficient, since a missing
      // control alongside existing attempt history means coordination
      // state was deleted/corrupted out-of-band, never a genuine
      // first-ever reconciliation.
      const attemptHistorySnap = await tx.get(
        db
          .collection("tripOwnershipReconciliationAttempts")
          .where("tripId", "==", tripId)
          .limit(1)
      );
      if (!attemptHistorySnap.empty) {
        return {
          kind: "anomaly",
          reasonCode: "missing_reconciliation_control",
          detail: "Control document is absent but attempt-history " +
            "already exists for this Trip - coordination state appears " +
            "corrupted or deleted out-of-band.",
        };
      }

      const basisResult = buildCurrentTripFinancialBasis(
        tripData,
        true // conservatively assumed; verified again at reconstruction.
      );
      if (!basisResult.ok) {
        return {
          kind: "anomaly",
          reasonCode: basisResult.reason,
          detail: basisResult.reason,
        };
      }

      const attemptId = randomUUID();
      const attemptRef = db
        .collection("tripOwnershipReconciliationAttempts")
        .doc(tripOwnershipReconciliationAttemptId(tripId, attemptId));
      tx.create(attemptRef, {
        tripId,
        attemptId,
        phase: "locked",
        startedAt: FieldValue.serverTimestamp(),
        lockedFinancialBasis: basisResult.basis,
      });
      tx.create(controlRef, {
        tripId,
        activeAttemptId: attemptId,
        lastCompletedAttemptId: null,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return {kind: "acquired", attemptId, phase: "locked"};
    }

    const controlShapeResult = validateReconciliationControlShape(
      controlSnap.data()
    );
    if (!controlShapeResult.ok) {
      return {
        kind: "anomaly",
        reasonCode: "malformed_reconciliation_control",
        detail: controlShapeResult.reason,
      };
    }
    const control = controlSnap.data() as TripOwnershipReconciliationControl;
    if (control.tripId !== tripId) {
      return {
        kind: "anomaly",
        reasonCode: "malformed_reconciliation_control",
        detail: "control.tripId does not match the target Trip.",
      };
    }

    // lastCompletedAttemptId referential integrity (checked whenever
    // present) - must resolve to an existing, same-Trip, exact-id, valid
    // "completed" attempt.
    if (control.lastCompletedAttemptId !== null) {
      const lastCompletedRef = db
        .collection("tripOwnershipReconciliationAttempts")
        .doc(
          tripOwnershipReconciliationAttemptId(
            tripId,
            control.lastCompletedAttemptId
          )
        );
      const lastCompletedSnap = await tx.get(lastCompletedRef);
      const lastCompletedValid =
        lastCompletedSnap.exists &&
        validateReconciliationAttemptShape(lastCompletedSnap.data()).ok &&
        (lastCompletedSnap.data() as TripOwnershipReconciliationAttempt)
          .tripId === tripId &&
        (lastCompletedSnap.data() as TripOwnershipReconciliationAttempt)
          .attemptId === control.lastCompletedAttemptId &&
        (lastCompletedSnap.data() as TripOwnershipReconciliationAttempt)
          .phase === "completed";
      if (!lastCompletedValid) {
        return {
          kind: "anomaly",
          reasonCode: "malformed_reconciliation_control",
          detail: "control.lastCompletedAttemptId does not resolve to a " +
            "valid completed attempt.",
        };
      }
    }

    if (control.activeAttemptId === null) {
      // Existing control, no active attempt - create a fresh attempt,
      // updating the SAME control document.
      const basisResult = buildCurrentTripFinancialBasis(tripData, true);
      if (!basisResult.ok) {
        return {
          kind: "anomaly",
          reasonCode: basisResult.reason,
          detail: basisResult.reason,
        };
      }
      const attemptId = randomUUID();
      const attemptRef = db
        .collection("tripOwnershipReconciliationAttempts")
        .doc(tripOwnershipReconciliationAttemptId(tripId, attemptId));
      tx.create(attemptRef, {
        tripId,
        attemptId,
        phase: "locked",
        startedAt: FieldValue.serverTimestamp(),
        lockedFinancialBasis: basisResult.basis,
      });
      tx.update(controlRef, {
        activeAttemptId: attemptId,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return {kind: "acquired", attemptId, phase: "locked"};
    }

    // activeAttemptId !== null && activeAttemptId !== lastCompletedAttemptId
    // (that pairing is already rejected by validateReconciliationControlShape
    // itself) - resolve and resume the exact referenced attempt.
    if (control.activeAttemptId === control.lastCompletedAttemptId) {
      return {
        kind: "anomaly",
        reasonCode: "malformed_reconciliation_control",
        detail: "activeAttemptId equals lastCompletedAttemptId.",
      };
    }
    const activeRef = db
      .collection("tripOwnershipReconciliationAttempts")
      .doc(
        tripOwnershipReconciliationAttemptId(tripId, control.activeAttemptId)
      );
    const activeSnap = await tx.get(activeRef);
    if (!activeSnap.exists) {
      return {
        kind: "anomaly",
        reasonCode: "malformed_reconciliation_control",
        detail: "control.activeAttemptId references a missing attempt.",
      };
    }
    const activeShapeResult = validateReconciliationAttemptShape(
      activeSnap.data()
    );
    if (!activeShapeResult.ok) {
      return {
        kind: "anomaly",
        reasonCode: "malformed_reconciliation_control",
        detail: activeShapeResult.reason,
      };
    }
    const active =
      activeSnap.data() as TripOwnershipReconciliationAttempt;
    if (
      active.tripId !== tripId ||
      active.attemptId !== control.activeAttemptId
    ) {
      return {
        kind: "anomaly",
        reasonCode: "malformed_reconciliation_control",
        detail: "Active attempt tripId/attemptId does not match control.",
      };
    }
    if (active.phase === "completed" || active.phase === "failed") {
      return {
        kind: "anomaly",
        reasonCode: "malformed_reconciliation_control",
        detail: "control.activeAttemptId references an already-terminal " +
          `attempt (phase "${active.phase}").`,
      };
    }
    return {
      kind: "acquired",
      attemptId: active.attemptId,
      phase: active.phase,
    };
  });
}

type TransitionOutcome =
  | {ok: true}
  | {ok: false; reasonCode: string; detail: string};

/**
 * Marks the named attempt `phase: "failed"` and atomically clears
 * `control.activeAttemptId`, per the frozen preflight §11 failure/retry
 * semantics - the Trip remains `needs_reconciliation`, no financial
 * history/allocation/aggregate is rewritten, and a later operator run
 * may create a brand-new attempt once the underlying issue is corrected.
 * @param {Firestore} db The Firestore instance.
 * @param {string} tripId The Trip's own id.
 * @param {string} attemptId This attempt's own id.
 * @param {string} failureReasonCode The non-empty failure reason code.
 * @param {string} failureDetail Optional human-readable detail.
 * @return {Promise<void>} Resolves once the failure is durably recorded.
 */
async function markAttemptFailed(
  db: Firestore,
  tripId: string,
  attemptId: string,
  failureReasonCode: string,
  failureDetail?: string
): Promise<void> {
  const attemptRef = db
    .collection("tripOwnershipReconciliationAttempts")
    .doc(tripOwnershipReconciliationAttemptId(tripId, attemptId));
  const controlRef = db
    .collection("tripOwnershipReconciliationControl")
    .doc(tripOwnershipReconciliationControlId(tripId));

  await db.runTransaction(async (tx) => {
    const [attemptSnap, controlSnap] = await Promise.all([
      tx.get(attemptRef),
      tx.get(controlRef),
    ]);
    if (!attemptSnap.exists || !controlSnap.exists) {
      // Lost coordination state - nothing safe to write; the caller's
      // own anomaly report already captures the underlying failure.
      return;
    }
    const control = controlSnap.data() as Record<string, unknown>;
    if (control.activeAttemptId !== attemptId) {
      // Already superseded/cleared - never overwrite another attempt's
      // outcome.
      return;
    }
    const current = attemptSnap.data() as Record<string, unknown>;
    if (current.phase === "completed" || current.phase === "failed") {
      // Already terminal - never overwritten.
      return;
    }
    const update: Record<string, unknown> = {
      phase: "failed",
      failedAt: FieldValue.serverTimestamp(),
      failureReasonCode,
    };
    if (failureDetail !== undefined) {
      update.failureDetail = failureDetail;
    }
    tx.update(attemptRef, update);
    tx.update(controlRef, {
      activeAttemptId: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

/**
 * True if the named attempt has already reached `phase: "completed"` -
 * used as a benign-race recovery check: whenever an internal step
 * reports a "superseded"/"unexpected phase" anomaly, this distinguishes
 * a genuine problem from a harmless race where a DIFFERENT concurrent
 * caller resuming this SAME attempt simply finished first. The single
 * canonical control document (§8/§9) already guarantees at most one
 * attempt is ever active per Trip; this check handles the narrower,
 * secondary race on that one attempt's own step-by-step progress.
 * @param {Firestore} db The Firestore instance.
 * @param {string} tripId The Trip's own id.
 * @param {string} attemptId This attempt's own id.
 * @return {Promise<boolean>} True if this exact attempt is already
 *   durably completed.
 */
async function isAttemptAlreadyCompleted(
  db: Firestore,
  tripId: string,
  attemptId: string
): Promise<boolean> {
  const snap = await db
    .collection("tripOwnershipReconciliationAttempts")
    .doc(tripOwnershipReconciliationAttemptId(tripId, attemptId))
    .get();
  if (!snap.exists || !validateReconciliationAttemptShape(snap.data()).ok) {
    return false;
  }
  const attempt = snap.data() as TripOwnershipReconciliationAttempt;
  return (
    attempt.tripId === tripId &&
    attempt.attemptId === attemptId &&
    attempt.phase === "completed"
  );
}

/**
 * Builds a "repaired" audit result from an attempt already proven
 * `phase: "completed"` by `isAttemptAlreadyCompleted` - the benign-race
 * recovery path's own result, reported from the attempt's own frozen,
 * already-committed fields rather than this caller's own (possibly
 * superseded) local reconstruction. `expectedOwnership` (the full row
 * list) is not persisted on the attempt document (only its digest/count
 * are) and is left `null` here - a caller needing the full list can
 * read `tripMemberOwnership` directly; this recovery path exists only
 * to report that the repair genuinely succeeded.
 * @param {Firestore} db The Firestore instance.
 * @param {string} tripId The Trip's own id.
 * @param {string} attemptId This attempt's own id.
 * @param {ReconciliationAuditResult} base The in-progress result to
 *   complete.
 * @return {Promise<ReconciliationAuditResult>} The completed, repaired
 *   result.
 */
async function buildRecoveredSuccessResult(
  db: Firestore,
  tripId: string,
  attemptId: string,
  base: ReconciliationAuditResult
): Promise<ReconciliationAuditResult> {
  const snap = await db
    .collection("tripOwnershipReconciliationAttempts")
    .doc(tripOwnershipReconciliationAttemptId(tripId, attemptId))
    .get();
  const attempt = snap.data() as TripOwnershipReconciliationAttempt & {
    phase: "completed";
  };
  base.phase = "completed";
  base.verdict = "repaired";
  base.lockedFinancialBasis = attempt.lockedFinancialBasis;
  const {openingBalanceMinor, aggregateLedgerBalanceMinor} = basisAmounts(
    attempt.lockedFinancialBasis
  );
  base.openingBalanceMinor = openingBalanceMinor;
  base.aggregateLedgerBalanceMinor = aggregateLedgerBalanceMinor;
  base.sourceHistoryDigest = attempt.sourceHistoryDigest;
  base.sourceHistoryDocumentCount = attempt.sourceHistoryDocumentCount;
  base.expectedOwnershipDigest = attempt.expectedOwnershipDigest;
  base.validatedAllocationDigest = attempt.validatedAllocationDigest;
  base.validatedAllocationCount = attempt.validatedAllocationCount;
  base.completedAt = new Date().toISOString();
  return base;
}

/**
 * The `"locked" -> "reconstructed"` transition - re-scans/reconstructs
 * the bounded history OUTSIDE this transaction (read-only, safe while
 * the Trip remains `needs_reconciliation`), validates the complete
 * persisted allocation set, then commits the frozen reconstruction
 * evidence atomically, requiring the attempt/control still match this
 * exact attempt.
 * @param {Firestore} db The Firestore instance.
 * @param {string} tripId The Trip's own id.
 * @param {string} attemptId This attempt's own id.
 * @return {Promise<TransitionOutcome>} Ok, or the specific anomaly.
 */
async function transitionToReconstructed(
  db: Firestore,
  tripId: string,
  attemptId: string
): Promise<TransitionOutcome> {
  const attemptRef = db
    .collection("tripOwnershipReconciliationAttempts")
    .doc(tripOwnershipReconciliationAttemptId(tripId, attemptId));
  const controlRef = db
    .collection("tripOwnershipReconciliationControl")
    .doc(tripOwnershipReconciliationControlId(tripId));

  const attemptSnap = await attemptRef.get();
  if (!attemptSnap.exists) {
    return {ok: false, reasonCode: "lost_attempt_state", detail: "missing"};
  }
  const attempt = attemptSnap.data() as TripOwnershipReconciliationAttempt;
  const lockedFinancialBasis = attempt.lockedFinancialBasis;
  const {openingBalanceMinor, aggregateLedgerBalanceMinor: currentAggregate} =
    basisAmounts(lockedFinancialBasis);

  const loaded = await loadTripHistory(db, tripId);
  if (!loaded.ok) {
    const {reasonCode, detail} = splitReasonCode(loaded.reason);
    return {ok: false, reasonCode, detail};
  }

  const reconstruction = runReconciliationReconstruction(
    loaded.history,
    tripId,
    lockedFinancialBasis.effectiveCurrency,
    openingBalanceMinor,
    currentAggregate
  );
  if (!reconstruction.ok) {
    return {
      ok: false,
      reasonCode: reconstruction.anomaly.reasonCode,
      detail: reconstruction.anomaly.detail,
    };
  }

  const persistedResult = await loadPersistedAllocations(db, tripId);
  if (!persistedResult.ok) {
    const {reasonCode, detail} = splitReasonCode(persistedResult.reason);
    return {ok: false, reasonCode, detail};
  }
  const allocationValidation = validatePersistedAllocations(
    reconstruction.allocations,
    persistedResult.allocations
  );
  if (!allocationValidation.ok) {
    return {
      ok: false,
      reasonCode: allocationValidation.anomaly.reasonCode,
      detail: allocationValidation.anomaly.detail,
    };
  }

  return db.runTransaction(async (tx) => {
    const [currentAttemptSnap, controlSnap] = await Promise.all([
      tx.get(attemptRef),
      tx.get(controlRef),
    ]);
    if (!currentAttemptSnap.exists) {
      return {ok: false, reasonCode: "lost_attempt_state", detail: "missing"};
    }
    const current =
      currentAttemptSnap.data() as Record<string, unknown>;
    if (current.phase === "reconstructed") {
      // Benign concurrent race: a second caller that also observed this
      // SAME attempt at phase "locked" (via acquisition) can reach this
      // transition after a different concurrent caller already
      // completed it - never a failure, since the goal state (this
      // exact attempt, reconstructed) has already been achieved. The
      // canonical control document already guarantees only one attempt
      // is ever active per Trip (§8/§9); this is a second, narrower
      // race on top of that single attempt's own phase transition, and
      // is resolved the same way: idempotent no-op, not an anomaly.
      return {ok: true};
    }
    if (current.phase !== "locked") {
      return {
        ok: false,
        reasonCode: "invalid_reconciliation_attempt_phase",
        detail: `phase is "${String(current.phase)}", not "locked".`,
      };
    }
    if (!controlSnap.exists) {
      return {
        ok: false,
        reasonCode: "lost_reconciliation_control",
        detail: "missing",
      };
    }
    const control = controlSnap.data() as Record<string, unknown>;
    if (control.activeAttemptId !== attemptId) {
      return {
        ok: false,
        reasonCode: "superseded_reconciliation_attempt",
        detail: "control.activeAttemptId no longer matches this attempt.",
      };
    }

    tx.update(attemptRef, {
      phase: "reconstructed",
      sourceHistoryDigest: reconstruction.sourceHistoryDigest.hash,
      sourceHistoryDocumentCount: reconstruction.sourceHistoryDigest.count,
      validatedAllocationDigest:
        allocationValidation.validatedAllocationDigest.hash,
      validatedAllocationCount:
        allocationValidation.validatedAllocationDigest.count,
      expectedOwnershipDigest: reconstruction.expectedOwnershipDigest.hash,
      expectedOwnershipCount: reconstruction.ownership.length,
      expectedAggregateMinor: reconstruction.replayedAggregateTotalMinor,
    });
    return {ok: true};
  });
}

/**
 * Chunked repair of `tripMemberOwnership` rows: every uid in the
 * replay's expected ownership set is written (overwritten) to its
 * proven-correct value, including a legitimate zero row. Each chunk
 * re-proves `control.activeAttemptId === attemptId` immediately before
 * its own commit.
 * @param {Firestore} db The Firestore instance.
 * @param {string} tripId The Trip's own id.
 * @param {string} attemptId This attempt's own id.
 * @param {MemberOwnershipBalance[]} expected The full expected ownership
 *   set.
 * @return {Promise<TransitionOutcome>} Ok, or the specific anomaly.
 */
async function materializeOwnershipRepair(
  db: Firestore,
  tripId: string,
  attemptId: string,
  expected: MemberOwnershipBalance[]
): Promise<TransitionOutcome> {
  const controlRef = db
    .collection("tripOwnershipReconciliationControl")
    .doc(tripOwnershipReconciliationControlId(tripId));

  for (let i = 0; i < expected.length; i += OUTPUT_WRITE_CHUNK_SIZE) {
    const chunk = expected.slice(i, i + OUTPUT_WRITE_CHUNK_SIZE);
    const result = await db.runTransaction(
      async (tx): Promise<TransitionOutcome> => {
        const controlSnap = await tx.get(controlRef);
        if (!controlSnap.exists) {
          return {
            ok: false,
            reasonCode: "lost_reconciliation_control",
            detail: "missing",
          };
        }
        const control = controlSnap.data() as Record<string, unknown>;
        if (control.activeAttemptId !== attemptId) {
          return {
            ok: false,
            reasonCode: "superseded_reconciliation_attempt",
            detail: "control.activeAttemptId no longer matches this " +
              "attempt.",
          };
        }
        for (const b of chunk) {
          tx.set(
            db
              .collection("tripMemberOwnership")
              .doc(tripMemberOwnershipId(tripId, b.uid)),
            {
              tripId,
              uid: b.uid,
              ownershipMinor: b.ownershipMinor,
              lastUpdatedAt: FieldValue.serverTimestamp(),
            }
          );
        }
        return {ok: true};
      }
    );
    if (!result.ok) {
      return result;
    }
  }
  return {ok: true};
}

/**
 * Chunked deletion of rogue `tripMemberOwnership` rows (uids with no
 * supporting replay history whatsoever). Each chunk re-proves
 * `control.activeAttemptId === attemptId` immediately before its own
 * commit.
 * @param {Firestore} db The Firestore instance.
 * @param {string} tripId The Trip's own id.
 * @param {string} attemptId This attempt's own id.
 * @param {string[]} rogueUids The uids to delete.
 * @return {Promise<TransitionOutcome>} Ok, or the specific anomaly.
 */
async function materializeRogueRowDeletion(
  db: Firestore,
  tripId: string,
  attemptId: string,
  rogueUids: string[]
): Promise<TransitionOutcome> {
  const controlRef = db
    .collection("tripOwnershipReconciliationControl")
    .doc(tripOwnershipReconciliationControlId(tripId));

  for (let i = 0; i < rogueUids.length; i += OUTPUT_WRITE_CHUNK_SIZE) {
    const chunk = rogueUids.slice(i, i + OUTPUT_WRITE_CHUNK_SIZE);
    const result = await db.runTransaction(
      async (tx): Promise<TransitionOutcome> => {
        const controlSnap = await tx.get(controlRef);
        if (!controlSnap.exists) {
          return {
            ok: false,
            reasonCode: "lost_reconciliation_control",
            detail: "missing",
          };
        }
        const control = controlSnap.data() as Record<string, unknown>;
        if (control.activeAttemptId !== attemptId) {
          return {
            ok: false,
            reasonCode: "superseded_reconciliation_attempt",
            detail: "control.activeAttemptId no longer matches this " +
              "attempt.",
          };
        }
        for (const uid of chunk) {
          tx.delete(
            db
              .collection("tripMemberOwnership")
              .doc(tripMemberOwnershipId(tripId, uid))
          );
        }
        return {ok: true};
      }
    );
    if (!result.ok) {
      return result;
    }
  }
  return {ok: true};
}

export type FinalizationEvidence = {
  lockedFinancialBasisMatches: boolean | null;
  sourceHistoryDigestMatches: boolean | null;
  validatedAllocationDigestMatches: boolean | null;
  exactOwnershipOutputMatches: boolean | null;
  aggregateMatches: boolean | null;
};

type FinalizationOutcome =
  | {ok: true; evidence: FinalizationEvidence}
  | {
      ok: false;
      reasonCode: string;
      detail: string;
      evidence: FinalizationEvidence;
    };

/**
 * A fresh, all-null finalization-evidence block.
 * @return {FinalizationEvidence} The empty evidence block.
 */
function emptyFinalizationEvidence(): FinalizationEvidence {
  return {
    lockedFinancialBasisMatches: null,
    sourceHistoryDigestMatches: null,
    validatedAllocationDigestMatches: null,
    exactOwnershipOutputMatches: null,
    aggregateMatches: null,
  };
}

/**
 * The final reconciliation gate / final transition transaction. ALL
 * reads before any write; never trusts any value computed earlier in
 * this run. Requires `control.activeAttemptId === attemptId` BEFORE any
 * write (frozen preflight §12), and re-proves `lockedFinancialBasisMatches`
 * before writing the repaired aggregate (§13) - no success is ever
 * inferred for an unreached check. On success, leaves BOTH
 * `Trip.lastUpdatedAt` and `Trip.lastUpdatedBy` completely unchanged
 * (§14), matching `migrateTripOwnership.ts`'s own exact precedent.
 * @param {Firestore} db The Firestore instance.
 * @param {string} tripId The Trip's own id.
 * @param {string} attemptId This attempt's own id.
 * @return {Promise<FinalizationOutcome>} Ok, or the specific anomaly -
 *   either way, with the per-check evidence gathered so far.
 */
async function finalizeReconciliation(
  db: Firestore,
  tripId: string,
  attemptId: string
): Promise<FinalizationOutcome> {
  const tripRef = db.collection("trips").doc(tripId);
  const attemptRef = db
    .collection("tripOwnershipReconciliationAttempts")
    .doc(tripOwnershipReconciliationAttemptId(tripId, attemptId));
  const controlRef = db
    .collection("tripOwnershipReconciliationControl")
    .doc(tripOwnershipReconciliationControlId(tripId));

  return db.runTransaction(async (tx) => {
    const evidence = emptyFinalizationEvidence();

    const [tripSnap, attemptSnap, controlSnap] = await Promise.all([
      tx.get(tripRef),
      tx.get(attemptRef),
      tx.get(controlRef),
    ]);
    if (!tripSnap.exists) {
      return {
        ok: false,
        reasonCode: "trip_not_found",
        detail: "missing",
        evidence,
      };
    }
    const tripData = tripSnap.data() as Record<string, unknown>;
    if (!attemptSnap.exists) {
      return {
        ok: false,
        reasonCode: "lost_attempt_state",
        detail: "missing",
        evidence,
      };
    }
    const attemptShapeResult = validateReconciliationAttemptShape(
      attemptSnap.data()
    );
    if (!attemptShapeResult.ok) {
      return {
        ok: false,
        reasonCode: "invalid_reconciliation_attempt_phase",
        detail: attemptShapeResult.reason,
        evidence,
      };
    }
    const attempt = attemptSnap.data() as TripOwnershipReconciliationAttempt;
    if (attempt.tripId !== tripId || attempt.attemptId !== attemptId) {
      return {
        ok: false,
        reasonCode: "invalid_reconciliation_attempt_phase",
        detail: "attempt tripId/attemptId mismatch.",
        evidence,
      };
    }
    if (attempt.phase === "completed") {
      // Benign concurrent race: a second caller that also reached
      // finalization for this SAME attempt can land here after a
      // different concurrent caller already completed it - never a
      // failure, since the goal state has already been achieved. This
      // run performed no fresh verification of its own, so its own
      // evidence stays empty (the true/false values belong to whichever
      // call actually finalized it).
      return {ok: true, evidence};
    }
    if (attempt.phase !== "reconstructed") {
      return {
        ok: false,
        reasonCode: "invalid_reconciliation_attempt_phase",
        detail: `phase is "${attempt.phase}", not "reconstructed".`,
        evidence,
      };
    }
    if (!controlSnap.exists) {
      return {
        ok: false,
        reasonCode: "lost_reconciliation_control",
        detail: "missing",
        evidence,
      };
    }
    const control = controlSnap.data() as Record<string, unknown>;
    if (control.activeAttemptId !== attemptId) {
      return {
        ok: false,
        reasonCode: "superseded_reconciliation_attempt",
        detail: "control.activeAttemptId no longer matches this attempt.",
        evidence,
      };
    }

    const classification = classifyTripOwnershipModelState(
      tripData.ownershipModelState,
      tripData.ownershipModelVersion
    );
    if (classification.kind !== "needs_reconciliation") {
      return {
        ok: false,
        reasonCode: "unexpected_state_change",
        detail: "Trip is no longer needs_reconciliation (now " +
          `${classification.kind}).`,
        evidence,
      };
    }

    const [txSnap, expenseSnap, ownershipSnap, allocationSnap] =
      await Promise.all([
        tx.get(tripSavingsTransactionsQuery(db, tripId)),
        tx.get(tripExpensesQuery(db, tripId)),
        tx.get(tripOwnershipRowsQuery(db, tripId)),
        tx.get(tripAllocationsQuery(db, tripId)),
      ]);

    // Re-prove the locked financial basis independently (§13).
    const currentBasisResult = buildCurrentTripFinancialBasis(
      tripData,
      txSnap.docs.length > 0
    );
    if (!currentBasisResult.ok) {
      evidence.lockedFinancialBasisMatches = false;
      return {
        ok: false,
        reasonCode: "locked_financial_basis_mismatch",
        detail: currentBasisResult.reason,
        evidence,
      };
    }
    const basisMatches = lockedFinancialBasesEqual(
      currentBasisResult.basis,
      attempt.lockedFinancialBasis
    );
    evidence.lockedFinancialBasisMatches = basisMatches;
    if (!basisMatches) {
      return {
        ok: false,
        reasonCode: "locked_financial_basis_mismatch",
        detail: "Current financial basis disagrees with the locked one.",
        evidence,
      };
    }

    // Re-prove the source-history digest.
    const transactions: RawSavingsTransactionRecord[] = [];
    for (const doc of txSnap.docs) {
      const parsed = parseSavingsTransactionRecord(doc.id, doc.data());
      if (!parsed.ok) {
        evidence.sourceHistoryDigestMatches = false;
        return {
          ok: false,
          reasonCode: "out_of_band_mutation_detected",
          detail: parsed.reason,
          evidence,
        };
      }
      transactions.push(parsed.value);
    }
    const expenses: ParsedExpenseRecord[] = [];
    for (const doc of expenseSnap.docs) {
      const parsed = parseExpenseRecord(doc.id, tripId, doc.data());
      if (!parsed.ok) {
        evidence.sourceHistoryDigestMatches = false;
        return {
          ok: false,
          reasonCode: "out_of_band_mutation_detected",
          detail: parsed.reason,
          evidence,
        };
      }
      expenses.push(parsed.value);
    }
    const currentSourceDigest = computeSourceHistoryDigest(
      transactions,
      expenses
    );
    const sourceDigestMatches =
      currentSourceDigest.hash === attempt.sourceHistoryDigest &&
      currentSourceDigest.count === attempt.sourceHistoryDocumentCount;
    evidence.sourceHistoryDigestMatches = sourceDigestMatches;
    if (!sourceDigestMatches) {
      return {
        ok: false,
        reasonCode: "out_of_band_mutation_detected",
        detail: "Source-history digest/count no longer match the locked " +
          "expectation.",
        evidence,
      };
    }

    // Re-prove the validated-allocation digest over the CURRENT
    // persisted allocation set.
    const allocationProjections: AllocationEconomicProjection[] = [];
    for (const doc of allocationSnap.docs) {
      const d = doc.data() as Record<string, unknown>;
      const shapeResult = validateTripOwnershipAllocationShape({
        tripId: d.tripId,
        expenseId: d.expenseId,
        withdrawalTransactionId: d.withdrawalTransactionId,
        amountMinor: d.amountMinor,
        currency: d.currency,
        allocations: d.allocations,
        provenance: d.provenance,
      });
      if (!shapeResult.ok || !(d.createdAt instanceof Timestamp)) {
        evidence.validatedAllocationDigestMatches = false;
        return {
          ok: false,
          reasonCode: "out_of_band_mutation_detected",
          detail: `tripOwnershipAllocations/${doc.id} is malformed.`,
          evidence,
        };
      }
      allocationProjections.push({
        id: doc.id,
        tripId: d.tripId as string,
        expenseId: d.expenseId as string,
        withdrawalTransactionId: d.withdrawalTransactionId as string,
        amountMinor: d.amountMinor as number,
        currency: d.currency as string,
        allocations: (
          d.allocations as AllocationEconomicProjection["allocations"]
        ),
        provenance: d.provenance as string,
        createdAt: d.createdAt as Timestamp,
      });
    }
    if (allocationProjections.length !== attempt.validatedAllocationCount) {
      evidence.validatedAllocationDigestMatches = false;
      return {
        ok: false,
        reasonCode: "out_of_band_mutation_detected",
        detail: `Found ${allocationProjections.length} allocation ` +
          `records, expected ${attempt.validatedAllocationCount}.`,
        evidence,
      };
    }
    const currentAllocationDigest = computeAllocationDigest(
      allocationProjections
    );
    const allocationDigestMatches =
      currentAllocationDigest.hash === attempt.validatedAllocationDigest;
    evidence.validatedAllocationDigestMatches = allocationDigestMatches;
    if (!allocationDigestMatches) {
      return {
        ok: false,
        reasonCode: "out_of_band_mutation_detected",
        detail: "Validated-allocation digest no longer matches the " +
          "locked expectation.",
        evidence,
      };
    }

    // Exact ownership-output-set verification - every materialized row
    // must exactly match the frozen expected digest/count.
    const balances: MemberOwnershipBalance[] = [];
    for (const doc of ownershipSnap.docs) {
      const d = doc.data() as Record<string, unknown>;
      if (
        typeof d.uid !== "string" ||
        d.uid.length === 0 ||
        d.tripId !== tripId ||
        doc.id !== tripMemberOwnershipId(tripId, d.uid) ||
        typeof d.ownershipMinor !== "number" ||
        !Number.isSafeInteger(d.ownershipMinor) ||
        d.ownershipMinor < 0
      ) {
        evidence.exactOwnershipOutputMatches = false;
        return {
          ok: false,
          reasonCode: "exact_output_mismatch",
          detail: `tripMemberOwnership/${doc.id} is malformed.`,
          evidence,
        };
      }
      balances.push({uid: d.uid, ownershipMinor: d.ownershipMinor});
    }
    if (balances.length !== attempt.expectedOwnershipCount) {
      evidence.exactOwnershipOutputMatches = false;
      return {
        ok: false,
        reasonCode: "exact_output_mismatch",
        detail: `Found ${balances.length} ownership rows, expected ` +
          `${attempt.expectedOwnershipCount}.`,
        evidence,
      };
    }
    const actualOwnershipDigest = computeOwnershipDigest(balances);
    const ownershipOutputMatches =
      actualOwnershipDigest.hash === attempt.expectedOwnershipDigest;
    evidence.exactOwnershipOutputMatches = ownershipOutputMatches;
    if (!ownershipOutputMatches) {
      return {
        ok: false,
        reasonCode: "exact_output_mismatch",
        detail: "Ownership output digest does not match the expected " +
          "value.",
        evidence,
      };
    }

    // Sigma(ownership) == expectedAggregateMinor, independently.
    const expectedAggregate = attempt.expectedAggregateMinor;
    if (balances.length === 0) {
      evidence.aggregateMatches = expectedAggregate === 0;
      if (expectedAggregate !== 0) {
        return {
          ok: false,
          reasonCode: "ownership_drift",
          detail: "No ownership rows exist, but the expected aggregate " +
            `is ${expectedAggregate}, not 0.`,
          evidence,
        };
      }
    } else {
      const reconcile = reconcileOwnershipAgainstAggregate(
        expectedAggregate,
        balances
      );
      evidence.aggregateMatches = reconcile.ok;
      if (!reconcile.ok) {
        return {
          ok: false,
          reasonCode: "ownership_drift",
          detail: reconcile.reason,
          evidence,
        };
      }
    }

    // Only now, write - NEVER touches Trip.lastUpdatedAt/lastUpdatedBy.
    tx.update(tripRef, {
      ledgerBalanceMinor: expectedAggregate,
      saved: expectedAggregate / 100,
      ownershipModelState: "initialized",
    });
    tx.update(attemptRef, {
      phase: "completed",
      completedAt: FieldValue.serverTimestamp(),
    });
    tx.update(controlRef, {
      activeAttemptId: null,
      lastCompletedAttemptId: attemptId,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return {ok: true, evidence};
  });
}

export type ApplyResult = ReconciliationAuditResult;

/**
 * Top-level resume-aware apply orchestration: acquires or resumes the
 * attempt via the canonical control document, drives the
 * `"locked" -> "reconstructed"` transition if needed, repairs ownership
 * rows (including rogue-row deletion), and finalizes. Any terminal
 * failure after an attempt exists is durably recorded via
 * `markAttemptFailed` - the Trip remains `needs_reconciliation` and a
 * later run may create a brand-new attempt.
 * @param {Firestore} db The Firestore instance.
 * @param {string} tripId The Trip to reconcile.
 * @return {Promise<ApplyResult>} The structured audit result.
 */
export async function runApply(
  db: Firestore,
  tripId: string
): Promise<ApplyResult> {
  const startedAt = new Date().toISOString();
  const base = emptyAuditResult(tripId, "apply", startedAt);

  const counts = await measureTripHistoryCounts(db, tripId);
  if (counts.combinedCount > AUTOMATIC_RECONCILIATION_HISTORY_LIMIT) {
    base.anomalies.push({
      reasonCode: "history_exceeds_automatic_reconciliation_limit",
      detail: `Combined history count ${counts.combinedCount} exceeds ` +
        `the automatic limit of ${AUTOMATIC_RECONCILIATION_HISTORY_LIMIT}.`,
    });
    base.completedAt = new Date().toISOString();
    return base;
  }

  const acquisition = await acquireOrResumeAttempt(db, tripId);
  if (acquisition.kind === "anomaly") {
    base.anomalies.push({
      reasonCode: acquisition.reasonCode,
      detail: acquisition.detail,
    });
    base.completedAt = new Date().toISOString();
    return base;
  }

  const attemptId = acquisition.attemptId;
  base.attemptId = attemptId;

  if (acquisition.phase === "locked") {
    const transition = await transitionToReconstructed(db, tripId, attemptId);
    if (!transition.ok) {
      if (await isAttemptAlreadyCompleted(db, tripId, attemptId)) {
        return buildRecoveredSuccessResult(db, tripId, attemptId, base);
      }
      await markAttemptFailed(
        db,
        tripId,
        attemptId,
        transition.reasonCode,
        transition.detail
      );
      base.anomalies.push({
        reasonCode: transition.reasonCode,
        detail: transition.detail,
      });
      base.phase = "failed";
      base.completedAt = new Date().toISOString();
      return base;
    }
  }
  base.phase = "reconstructed";

  const attemptSnap = await db
    .collection("tripOwnershipReconciliationAttempts")
    .doc(tripOwnershipReconciliationAttemptId(tripId, attemptId))
    .get();
  const attempt = attemptSnap.data() as TripOwnershipReconciliationAttempt;
  if (attempt.phase !== "reconstructed") {
    if (attempt.phase === "completed") {
      return buildRecoveredSuccessResult(db, tripId, attemptId, base);
    }
    base.anomalies.push({
      reasonCode: "invalid_reconciliation_attempt_phase",
      detail: `Expected phase "reconstructed", found "${attempt.phase}".`,
    });
    base.completedAt = new Date().toISOString();
    return base;
  }
  base.lockedFinancialBasis = attempt.lockedFinancialBasis;
  const {openingBalanceMinor, aggregateLedgerBalanceMinor: currentAggregate} =
    basisAmounts(attempt.lockedFinancialBasis);
  base.openingBalanceMinor = openingBalanceMinor;
  base.aggregateLedgerBalanceMinor = currentAggregate;

  const loaded = await loadTripHistory(db, tripId);
  if (!loaded.ok) {
    const {reasonCode, detail} = splitReasonCode(loaded.reason);
    await markAttemptFailed(db, tripId, attemptId, reasonCode, detail);
    base.anomalies.push({reasonCode, detail});
    base.phase = "failed";
    base.completedAt = new Date().toISOString();
    return base;
  }

  const currentSourceDigest = computeSourceHistoryDigest(
    loaded.history.transactions,
    loaded.history.expenses
  );
  const sourceHistoryDigestMatches =
    currentSourceDigest.hash === attempt.sourceHistoryDigest &&
    currentSourceDigest.count === attempt.sourceHistoryDocumentCount;
  base.reconciliation.sourceHistoryDigestMatches = sourceHistoryDigestMatches;
  if (!sourceHistoryDigestMatches) {
    await markAttemptFailed(
      db,
      tripId,
      attemptId,
      "out_of_band_mutation_detected",
      "Source-history digest/count no longer match the locked expectation."
    );
    base.anomalies.push({
      reasonCode: "out_of_band_mutation_detected",
      detail: "Source-history digest/count no longer match the locked " +
        "expectation.",
    });
    base.phase = "failed";
    base.completedAt = new Date().toISOString();
    return base;
  }

  const reconstruction = runReconciliationReconstruction(
    loaded.history,
    tripId,
    attempt.lockedFinancialBasis.effectiveCurrency,
    openingBalanceMinor,
    currentAggregate
  );
  if (!reconstruction.ok) {
    await markAttemptFailed(
      db,
      tripId,
      attemptId,
      reconstruction.anomaly.reasonCode,
      reconstruction.anomaly.detail
    );
    base.anomalies.push(reconstruction.anomaly);
    base.phase = "failed";
    base.completedAt = new Date().toISOString();
    return base;
  }
  base.reconciliation.aggregateMatches = true;

  if (
    reconstruction.expectedOwnershipDigest.hash !==
      attempt.expectedOwnershipDigest ||
    reconstruction.expectedOwnershipDigest.count !==
      attempt.expectedOwnershipCount
  ) {
    const detail = "Source history matches the frozen digest, but a " +
      "fresh reconstruction from it no longer reproduces the frozen " +
      "expected ownership output model.";
    await markAttemptFailed(
      db,
      tripId,
      attemptId,
      "frozen_reconstruction_target_mismatch",
      detail
    );
    base.anomalies.push({
      reasonCode: "frozen_reconstruction_target_mismatch",
      detail,
    });
    base.phase = "failed";
    base.completedAt = new Date().toISOString();
    return base;
  }

  const persistedResult = await loadPersistedAllocations(db, tripId);
  if (!persistedResult.ok) {
    const {reasonCode, detail} = splitReasonCode(persistedResult.reason);
    await markAttemptFailed(db, tripId, attemptId, reasonCode, detail);
    base.anomalies.push({reasonCode, detail});
    base.phase = "failed";
    base.completedAt = new Date().toISOString();
    return base;
  }
  const allocationValidation = validatePersistedAllocations(
    reconstruction.allocations,
    persistedResult.allocations
  );
  if (!allocationValidation.ok) {
    await markAttemptFailed(
      db,
      tripId,
      attemptId,
      allocationValidation.anomaly.reasonCode,
      allocationValidation.anomaly.detail
    );
    base.anomalies.push(allocationValidation.anomaly);
    base.phase = "failed";
    base.completedAt = new Date().toISOString();
    return base;
  }
  if (
    allocationValidation.validatedAllocationDigest.hash !==
      attempt.validatedAllocationDigest ||
    allocationValidation.validatedAllocationDigest.count !==
      attempt.validatedAllocationCount
  ) {
    const detail = "Fresh allocation validation no longer reproduces the " +
      "frozen validated-allocation digest.";
    await markAttemptFailed(
      db,
      tripId,
      attemptId,
      "frozen_reconstruction_target_mismatch",
      detail
    );
    base.anomalies.push({
      reasonCode: "frozen_reconstruction_target_mismatch",
      detail,
    });
    base.phase = "failed";
    base.completedAt = new Date().toISOString();
    return base;
  }

  const currentRowsResult = await loadCurrentOwnershipRows(db, tripId);
  if (!currentRowsResult.ok) {
    const {reasonCode, detail} = splitReasonCode(currentRowsResult.reason);
    await markAttemptFailed(db, tripId, attemptId, reasonCode, detail);
    base.anomalies.push({reasonCode, detail});
    base.phase = "failed";
    base.completedAt = new Date().toISOString();
    return base;
  }
  const {rowsToWrite, rogueUids} = classifyOwnershipRepair(
    reconstruction.ownership,
    currentRowsResult.rows.rowIds
  );
  base.rogueOwnershipRowUids = rogueUids;

  const ownershipWrite = await materializeOwnershipRepair(
    db,
    tripId,
    attemptId,
    rowsToWrite
  );
  if (!ownershipWrite.ok) {
    if (await isAttemptAlreadyCompleted(db, tripId, attemptId)) {
      return buildRecoveredSuccessResult(db, tripId, attemptId, base);
    }
    await markAttemptFailed(
      db,
      tripId,
      attemptId,
      ownershipWrite.reasonCode,
      ownershipWrite.detail
    );
    base.anomalies.push({
      reasonCode: ownershipWrite.reasonCode,
      detail: ownershipWrite.detail,
    });
    base.phase = "failed";
    base.completedAt = new Date().toISOString();
    return base;
  }

  const rogueDeletion = await materializeRogueRowDeletion(
    db,
    tripId,
    attemptId,
    rogueUids
  );
  if (!rogueDeletion.ok) {
    if (await isAttemptAlreadyCompleted(db, tripId, attemptId)) {
      return buildRecoveredSuccessResult(db, tripId, attemptId, base);
    }
    await markAttemptFailed(
      db,
      tripId,
      attemptId,
      rogueDeletion.reasonCode,
      rogueDeletion.detail
    );
    base.anomalies.push({
      reasonCode: rogueDeletion.reasonCode,
      detail: rogueDeletion.detail,
    });
    base.phase = "failed";
    base.completedAt = new Date().toISOString();
    return base;
  }

  const finalizeResult = await finalizeReconciliation(db, tripId, attemptId);
  if (finalizeResult.evidence.lockedFinancialBasisMatches !== null) {
    base.reconciliation.lockedFinancialBasisMatches =
      finalizeResult.evidence.lockedFinancialBasisMatches;
  }
  if (finalizeResult.evidence.sourceHistoryDigestMatches !== null) {
    base.reconciliation.sourceHistoryDigestMatches =
      finalizeResult.evidence.sourceHistoryDigestMatches;
  }
  if (finalizeResult.evidence.exactOwnershipOutputMatches !== null) {
    base.reconciliation.exactOwnershipOutputMatches =
      finalizeResult.evidence.exactOwnershipOutputMatches;
  }
  if (finalizeResult.evidence.aggregateMatches !== null) {
    base.reconciliation.aggregateMatches =
      finalizeResult.evidence.aggregateMatches;
  }
  if (!finalizeResult.ok) {
    if (await isAttemptAlreadyCompleted(db, tripId, attemptId)) {
      return buildRecoveredSuccessResult(db, tripId, attemptId, base);
    }
    await markAttemptFailed(
      db,
      tripId,
      attemptId,
      finalizeResult.reasonCode,
      finalizeResult.detail
    );
    base.anomalies.push({
      reasonCode: finalizeResult.reasonCode,
      detail: finalizeResult.detail,
    });
    base.phase = "failed";
    base.completedAt = new Date().toISOString();
    return base;
  }

  base.phase = "completed";
  base.verdict = "repaired";
  base.sourceHistoryDigest = reconstruction.sourceHistoryDigest.hash;
  base.sourceHistoryDocumentCount = reconstruction.sourceHistoryDigest.count;
  base.expectedOwnership = reconstruction.ownership;
  base.expectedOwnershipTotalMinor = sumReconstructedOwnership(
    reconstruction.ownership
  );
  base.expectedOwnershipDigest = reconstruction.expectedOwnershipDigest.hash;
  base.validatedAllocationDigest =
    allocationValidation.validatedAllocationDigest.hash;
  base.validatedAllocationCount =
    allocationValidation.validatedAllocationDigest.count;
  base.completedAt = new Date().toISOString();
  return base;
}

// ---------------------------------------------------------------------
// CLI / EXECUTION-TARGET SAFETY GUARD - this tool's OWN, independent
// guard, never shared with migrateTripOwnership.ts (frozen preflight §4).
// ---------------------------------------------------------------------

export const PRODUCTION_PROJECT_ID = "squadstash-6d0f1";

export type ExecutionTarget =
  | {ok: true; mode: "emulator"; projectId: string}
  | {ok: true; mode: "production"; projectId: string}
  | {ok: false; reason: string};

/**
 * Resolves the safe execution target from the process environment and
 * parsed CLI flags - this tool's own independent guard, structurally
 * identical in spirit to migrateTripOwnership.ts's own
 * `resolveExecutionTarget` but a SEPARATE function with its own
 * constant, per the frozen preflight's own §4/§12 FROZEN decision that
 * this tool shares no execution-target code with that one.
 * @param {object} input The environment/flags this decision depends on.
 * @return {ExecutionTarget} The resolved target, or the specific reason
 *   this invocation is unsafe to run.
 */
export function resolveReconciliationExecutionTarget(input: {
  emulatorHost: string | undefined;
  tripId: string;
  mode: "dry_run" | "apply";
  projectFlag: string | undefined;
  confirmFlag: string | undefined;
}): ExecutionTarget {
  if (input.emulatorHost) {
    return {
      ok: true,
      mode: "emulator",
      projectId: input.projectFlag ?? "demo-reconcile-trip-ownership",
    };
  }
  if (input.projectFlag !== PRODUCTION_PROJECT_ID) {
    return {
      ok: false,
      reason: "No FIRESTORE_EMULATOR_HOST is set, and --project does not " +
        "exactly match the configured production project id " +
        `("${PRODUCTION_PROJECT_ID}"). Refusing to run.`,
    };
  }
  if (input.mode === "apply" && input.confirmFlag !== input.tripId) {
    return {
      ok: false,
      reason: "Production apply requires --confirm <tripId> to exactly " +
        "echo back the --trip value. Refusing to run.",
    };
  }
  return {ok: true, mode: "production", projectId: input.projectFlag};
}

/**
 * Minimal CLI argument parser for this tool's own flags.
 * @param {string[]} argv The raw CLI arguments (excluding node/script).
 * @return {object} The parsed flags.
 */
function parseArgs(argv: string[]): {
  tripId: string | undefined;
  mode: "dry_run" | "apply";
  projectFlag: string | undefined;
  confirmFlag: string | undefined;
} {
  let tripId: string | undefined;
  let mode: "dry_run" | "apply" = "dry_run";
  let projectFlag: string | undefined;
  let confirmFlag: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--trip") {
      tripId = argv[++i];
    } else if (arg === "--apply") {
      mode = "apply";
    } else if (arg === "--dry-run") {
      mode = "dry_run";
    } else if (arg === "--project") {
      projectFlag = argv[++i];
    } else if (arg === "--confirm") {
      confirmFlag = argv[++i];
    }
  }
  return {tripId, mode, projectFlag, confirmFlag};
}

/**
 * CLI entry point. Never invoked by any test - tests exercise
 * `resolveReconciliationExecutionTarget`, `runDryRun`, and `runApply`
 * directly against an emulator-backed Firestore instance they construct
 * themselves.
 * @return {Promise<void>} Resolves once the requested run completes.
 */
async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.tripId) {
    throw new Error("Usage: --trip <tripId> [--dry-run|--apply] " +
      "[--project <id>] [--confirm <tripId>]");
  }
  const target = resolveReconciliationExecutionTarget({
    emulatorHost: process.env.FIRESTORE_EMULATOR_HOST,
    tripId: parsed.tripId,
    mode: parsed.mode,
    projectFlag: parsed.projectFlag,
    confirmFlag: parsed.confirmFlag,
  });
  if (!target.ok) {
    throw new Error(target.reason);
  }

  initializeApp({projectId: target.projectId});
  const db = getFirestore();

  const result =
    parsed.mode === "apply" ?
      await runApply(db, parsed.tripId) :
      await runDryRun(db, parsed.tripId);

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  });
}
