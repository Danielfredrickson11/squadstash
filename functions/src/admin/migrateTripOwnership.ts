// Checkpoint 5B.4B: trusted Trip-ownership migration/backfill tool, per
// the frozen docs/audits/
// TRIP_WALLET_OWNERSHIP_MIGRATION_PREFLIGHT_2026-10-10.md
// (as hardened by Amendments 5B.4A.1/5B.4A.2). A local, Admin-SDK-only
// Node.js script - NEVER exported from functions/src/index.ts, NEVER
// wrapped in onCall/HTTP, NEVER reachable from app/client code (§24).
// Single-Trip only. Dry-run is the default/safest mode; applying a
// migration requires an explicit, separate, unambiguous invocation
// (§23).
//
// This file performs every Firestore read/write the migration needs;
// every piece of actual arithmetic/validation is delegated to the pure
// domain modules written alongside this checkpoint
// (tripOwnershipMigrationState.ts, tripOwnershipMigrationDigest.ts,
// tripOwnershipMigrationReplay.ts) plus the existing 5B.1/5B.2/5B.3
// primitives - this file never duplicates that math.
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
import {
  classifyTripOwnershipModelState,
  CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
} from "../domain/tripOwnershipModel";
import type {TripOwnershipClassification} from "../domain/tripOwnershipModel";
import {resolveEffectiveCurrency} from "../domain/savingsLedger";
import {
  buildLockedFinancialBasis,
  classifyLedgerBootstrapForMigration,
  evaluateMigrationEligibility,
  lockedFinancialBasesEqual,
  tripOwnershipMigrationStateId,
  validateMigrationStateShape,
} from "../domain/tripOwnershipMigrationState";
import type {
  LockedFinancialBasis,
  TripOwnershipMigrationState,
} from "../domain/tripOwnershipMigrationState";
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

// ---------------------------------------------------------------------
// CENTRALIZED, NAMED BOUNDS (Checkpoint 5B.4B, item 14/§16A)
// ---------------------------------------------------------------------

// A single, named, centralized automatic-migration history-size bound -
// never a scattered/ad-hoc check. §16A deliberately leaves the EXACT
// number unfrozen ("an architectural rule, not an exact number"); this
// is this implementation's own conservative choice, justified here:
// this product's own established scale assumption throughout 5B is
// small friend/family Trips. 2000 combined savingsTransactions +
// tripExpenses documents is already an order of magnitude beyond any
// real usage this product has approached, remains comfortably cheap to
// fully read (a handful of Firestore list queries) and to hash (one
// in-memory JSON.stringify/SHA-256 pass) around the finalization
// window, and still leaves the eventual OUTPUT row count (distinct
// contributors + distinct Shared-Stash Expenses, always bounded by this
// same limit) with ample headroom under OUTPUT_WRITE_CHUNK_SIZE below.
// A Trip exceeding this is REQUIRES_MANUAL_REVIEW
// (`history_exceeds_automatic_migration_limit`) and the lock is never
// attempted for it (§16) - never a partially-scanned, partially-locked
// attempt, and never a weakened/sampled integrity check for a large
// Trip (§16A/§21's own "chunking applies to output writes only" rule).
export const AUTOMATIC_MIGRATION_HISTORY_LIMIT = 2000;

// Firestore's own documented 500-write transaction/batch ceiling
// (§21, already relied upon elsewhere in this architecture) - chunked
// well under it, leaving headroom for every other write a single
// materialization transaction also performs.
export const OUTPUT_WRITE_CHUNK_SIZE = 400;

/**
 * Splits a reason string of this codebase's own established
 * `"<reason_code>: <human detail>"` convention (used consistently by
 * every pure validation/replay function this tool calls) into its two
 * parts, for the structured audit output's own `anomalies` array.
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
// RAW FIRESTORE READS / PARSING (§6/§14 - structural validation of raw
// field values BEFORE anything is passed to a pure primitive)
// ---------------------------------------------------------------------

type ParsedResult<T> = {ok: true; value: T} | {ok: false; reason: string};

/**
 * The index-free query for every `savingsTransactions` document for
 * one Trip (§21, item 1 - the same equality-only shape this project's
 * own existing client code already uses).
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
 * Structurally validates one raw `savingsTransactions` document's field
 * TYPES (§14) before anything is passed to a pure primitive - never the
 * semantic/cross-document validation `buildLogicalEvents` itself
 * performs.
 * @param {string} id The document's own Firestore id.
 * @param {Record<string, unknown>} d The document's raw field data.
 * @return {ParsedResult<RawSavingsTransactionRecord>} The parsed
 *   record, or the specific reason it is malformed.
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

// The full parsed Expense shape - a strict superset of
// RawTripExpenseRecord (replay) AND DigestExpenseInput (digest); one
// parse serves both consumers structurally, never two separate passes.
type ParsedExpenseRecord = RawTripExpenseRecord & DigestExpenseInput;

/**
 * Structurally validates one raw `tripExpenses` document's field TYPES
 * (§14), for BOTH `"shared_stash"` and `"member_out_of_pocket"`
 * payment sources alike - the shared-stash-specific semantic rules
 * (linkage/reversal agreement) are applied only by `buildLogicalEvents`
 * itself, never here.
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
 * The cheap, read-only pre-lock history-size measurement (§16) - a
 * count() aggregation query per collection, never a full document load.
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
 * Loads and parses the Trip's complete bounded source history, via the
 * same index-free query shape already used by this project's own
 * existing client code (§21, item 1) - never inside an enclosing
 * transaction, safe only because this is called after the Trip has
 * already been confirmed quiesced (locked, or - for a dry run - merely
 * read-only and advisory).
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

// ---------------------------------------------------------------------
// RECONSTRUCTION PIPELINE (shared by dry-run and apply)
// ---------------------------------------------------------------------

type ReconstructionAnomaly = {
  reasonCode: string;
  detail: string;
  relatedDocumentIds: string[];
};

type ReconstructionResult =
  | {
      ok: true;
      ownership: MemberOwnershipBalance[];
      allocations: ReconstructedAllocation[];
      sourceHistoryDigest: {hash: string; count: number};
      expectedOwnershipDigest: {hash: string; count: number};
      expectedAllocationDigest: {hash: string; count: number};
      historyReplayMatches: boolean;
      aggregateMatches: boolean;
      replayedAggregateTotalMinor: number;
      historyCounts: {
        ordinaryContributions: number;
        ordinaryWithdrawals: number;
        sharedStashExpenses: number;
        sharedStashReversals: number;
        memberOutOfPocketExpensesFetchedAndIgnored: number;
      };
    }
  | {ok: false; anomaly: ReconstructionAnomaly};

/**
 * Runs the full read-only reconstruction pipeline (§6-§10/§13-§15) over
 * already-loaded, already-parsed history: build logical events, order
 * them, replay ownership, independently replay the aggregate total,
 * reconcile against the Trip's current aggregate, and compute every
 * digest §16A requires. Never performs any Firestore I/O itself.
 * @param {LoadedHistory} history The already-loaded, parsed history.
 * @param {string} tripId The Trip's own id.
 * @param {string} effectiveCurrency The Trip's resolved currency.
 * @param {number} openingBalanceMinor The locked/classified opening
 *   balance to replay the independent aggregate total from.
 * @param {number} currentAggregateLedgerBalanceMinor The Trip's current
 *   `ledgerBalanceMinor` (or derived legacy equivalent) to reconcile
 *   against.
 * @return {ReconstructionResult} The full reconstruction, or the
 *   specific anomaly reconstruction failed on.
 */
function runReconstructionPipeline(
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
    return {ok: false, anomaly: {reasonCode, detail, relatedDocumentIds: []}};
  }

  const ordered = orderLogicalEvents(builtEvents.events);
  if (!ordered.ok) {
    const {reasonCode, detail} = splitReasonCode(ordered.reason);
    return {ok: false, anomaly: {reasonCode, detail, relatedDocumentIds: []}};
  }

  const replayed = replayLogicalEvents(ordered.ordered, tripId);
  if (!replayed.ok) {
    const {reasonCode, detail} = splitReasonCode(replayed.reason);
    return {ok: false, anomaly: {reasonCode, detail, relatedDocumentIds: []}};
  }

  const aggregateReplay = replayAggregateLedgerTotal(
    openingBalanceMinor,
    ordered.ordered
  );
  if (!aggregateReplay.ok) {
    const {reasonCode, detail} = splitReasonCode(aggregateReplay.reason);
    return {ok: false, anomaly: {reasonCode, detail, relatedDocumentIds: []}};
  }

  const historyReplayMatches =
    aggregateReplay.totalMinor === currentAggregateLedgerBalanceMinor;
  if (!historyReplayMatches) {
    return {
      ok: false,
      anomaly: {
        reasonCode: "aggregate_history_mismatch",
        detail: "Independently-replayed aggregate total " +
          `(${aggregateReplay.totalMinor}) disagrees with the Trip's ` +
          `current ledgerBalanceMinor (${currentAggregateLedgerBalanceMinor}).`,
        relatedDocumentIds: [],
      },
    };
  }

  // reconcileOwnershipAgainstAggregate requires a non-empty balance
  // array (it is designed for the live-callable context, where at
  // least one row always exists) - a genuinely zero-history Trip has
  // no reconstructed ownership rows at all, which is trivially
  // reconciled (sum of nothing == 0) without calling that primitive.
  if (replayed.ownership.length === 0) {
    if (currentAggregateLedgerBalanceMinor !== 0) {
      return {
        ok: false,
        anomaly: {
          reasonCode: "ownership_drift",
          detail: "No historical ownership participants were found, " +
            "but the Trip's current aggregate is " +
            `${currentAggregateLedgerBalanceMinor}, not 0.`,
          relatedDocumentIds: [],
        },
      };
    }
  } else {
    const reconciliation = reconcileOwnershipAgainstAggregate(
      currentAggregateLedgerBalanceMinor,
      replayed.ownership
    );
    if (!reconciliation.ok) {
      return {
        ok: false,
        anomaly: {
          reasonCode: "ownership_drift",
          detail: reconciliation.reason,
          relatedDocumentIds: [],
        },
      };
    }
  }

  const digestTransactions: DigestSavingsTransactionInput[] =
    history.transactions;
  const digestExpenses: DigestExpenseInput[] = history.expenses;
  const sourceHistoryDigest = computeSourceHistoryDigest(
    digestTransactions,
    digestExpenses
  );
  const expectedOwnershipDigest = computeOwnershipDigest(replayed.ownership);

  const allocationProjections: AllocationEconomicProjection[] =
    replayed.allocations.map((a) => ({
      id: a.withdrawalTransactionId,
      tripId: a.tripId,
      expenseId: a.expenseId,
      withdrawalTransactionId: a.withdrawalTransactionId,
      amountMinor: a.amountMinor,
      currency: a.currency,
      allocations: a.allocations,
      provenance: "migrated",
      createdAt: a.createdAt,
    }));
  const expectedAllocationDigest = computeAllocationDigest(
    allocationProjections
  );

  let ordinaryContributions = 0;
  let ordinaryWithdrawals = 0;
  let sharedStashExpenses = 0;
  let sharedStashReversals = 0;
  for (const event of ordered.ordered) {
    if (event.kind === "contribution") ordinaryContributions++;
    else if (event.kind === "withdrawal") ordinaryWithdrawals++;
    else if (event.kind === "shared_stash_expense") sharedStashExpenses++;
    else sharedStashReversals++;
  }
  const memberOutOfPocketExpensesFetchedAndIgnored = history.expenses.filter(
    (e) => e.paymentSource === "member_out_of_pocket"
  ).length;

  return {
    ok: true,
    ownership: replayed.ownership,
    allocations: replayed.allocations,
    sourceHistoryDigest,
    expectedOwnershipDigest,
    expectedAllocationDigest,
    historyReplayMatches,
    aggregateMatches: true,
    replayedAggregateTotalMinor: aggregateReplay.totalMinor,
    historyCounts: {
      ordinaryContributions,
      ordinaryWithdrawals,
      sharedStashExpenses,
      sharedStashReversals,
      memberOutOfPocketExpensesFetchedAndIgnored,
    },
  };
}

/**
 * Resolves a Trip's effective currency by directly reusing
 * `savingsLedger.ts`'s own canonical `resolveEffectiveCurrency` -
 * never a second, parallel implementation (Checkpoint 5B.4B.1,
 * Section K). Probes it with the Trip's own candidate currency (its
 * own `currency` field if a non-empty string, else the same `"USD"`
 * default `resolveEffectiveCurrency` itself falls back to) so the
 * `requestCurrency` comparison - meaningless in a migration context,
 * which has no "request" - always trivially agrees whenever the
 * field is well-formed; a malformed field is still correctly
 * surfaced by the real function's own type check.
 * @param {Record<string, unknown>} tripData The Trip's own data.
 * @return {object} `{ok: true, effectiveCurrency}`, or `{ok: false}`
 *   if the Trip's own `currency` field is malformed.
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

// Checkpoint 5B.4B.4: the exact sum of a reconstructed ownership set,
// for audit-output reporting only - reuses the existing BigInt-safe
// `sumOwnershipMinor` primitive rather than duplicating arithmetic.
// `sumOwnershipMinor` itself requires a non-empty array (it is designed
// for the live-callable context, where at least one row always
// exists); a genuinely zero-participant reconstruction has no rows at
// all, which sums to exactly 0 without needing that primitive. A
// non-null, non-zero failure is structurally unreachable here (the
// array has already been proven well-formed by
// `reconcileOwnershipAgainstAggregate`/the materialization checks by
// the time this is ever called) - returning `null` rather than a
// silently-wrong number in that unreachable case, per this
// checkpoint's own "null means not evaluated/unavailable" convention.
/**
 * Computes the exact sum of a reconstructed ownership set, for
 * audit-output reporting only.
 * @param {MemberOwnershipBalance[]} balances The reconstructed
 *   ownership set.
 * @return {number | null} The exact total, or `null` if it could not
 *   be computed (structurally unreachable in practice).
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

/**
 * Derives the two plain `openingBalanceMinor`/`aggregateLedgerBalanceMinor`
 * numbers from a `LockedFinancialBasis` - the same discriminated
 * ternary this file previously repeated at every call site; factored
 * out once here (Checkpoint 5B.4C) rather than duplicated again by the
 * already_completed report.
 * @param {LockedFinancialBasis} basis The locked/frozen financial
 *   basis.
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

// ---------------------------------------------------------------------
// STRICT already_completed / needs_reconciliation CLASSIFICATION
// (Checkpoint 5B.4B.1, Sections B/C) - shared by both runDryRun and
// acquireOrResumeLock so the two can never silently drift apart.
// ---------------------------------------------------------------------

type CompletionCheckResult =
  | {kind: "already_completed"}
  | {kind: "anomaly"; reasonCode: string; detail: string};

/**
 * Classifies a Trip already classified as `"initialized"` or
 * `"needs_reconciliation"` into either the one narrow, strictly-proven
 * `already_completed` outcome, or an explicit anomaly - NEVER inferred
 * from the Trip's ownership state alone (Checkpoint 5B.4B.1, Section
 * C). `"needs_reconciliation"` is unconditionally BLOCKED/fail-closed
 * (Section B) - it is never equivalent to a completed migration,
 * regardless of what any migration-state document claims.
 * `"initialized"` is `already_completed` only when ALL of: version is
 * exactly `CURRENT_TRIP_OWNERSHIP_MODEL_VERSION`; a migration-state
 * document exists; it validates strictly (including real Timestamp
 * instances, Section D); its own `tripId` matches the Trip actually
 * being asked about; and its `phase` is exactly `"completed"` (which,
 * once validated, already guarantees a real `completedAt` Timestamp
 * and every required completed-phase field - §16B's own discriminated
 * shape makes "completed" a strict superset of "reconstructed").
 * @param {object} classification The Trip's own already-classified
 *   ownership-model state - must be `"initialized"` or
 *   `"needs_reconciliation"` (any other kind is a caller error).
 * @param {string} tripId The Trip actually being asked about.
 * @param {FirebaseFirestore.DocumentSnapshot} migrationStateSnap The
 *   already-read `tripOwnershipMigrationState/{tripId}` snapshot.
 * @return {CompletionCheckResult} The one allowed completion outcome,
 *   or the specific anomaly this Trip/migration-state pairing fails on.
 */
function evaluateAlreadyCompleted(
  classification: Extract<
    TripOwnershipClassification,
    {kind: "initialized" | "needs_reconciliation"}
  >,
  tripId: string,
  migrationStateSnap: FirebaseFirestore.DocumentSnapshot
): CompletionCheckResult {
  if (classification.kind === "needs_reconciliation") {
    return {
      kind: "anomaly",
      reasonCode: "needs_reconciliation_blocked",
      detail: "Trip ownership model requires reconciliation - this is " +
        "a blocked, fail-closed state, never a completed migration.",
    };
  }

  // classification.kind === "initialized"
  if (classification.version !== CURRENT_TRIP_OWNERSHIP_MODEL_VERSION) {
    return {
      kind: "anomaly",
      reasonCode: "unsupported_ownership_version",
      detail: `Trip is initialized at version ${classification.version}, ` +
        "not the current supported version " +
        `${CURRENT_TRIP_OWNERSHIP_MODEL_VERSION}.`,
    };
  }
  if (!migrationStateSnap.exists) {
    return {
      kind: "anomaly",
      reasonCode: "invalid_migration_state_phase",
      detail: "Trip is initialized but has no migration-state document.",
    };
  }
  const shapeResult = validateMigrationStateShape(migrationStateSnap.data());
  if (!shapeResult.ok) {
    return {
      kind: "anomaly",
      reasonCode: "invalid_migration_state_phase",
      detail: shapeResult.reason,
    };
  }
  const ms = migrationStateSnap.data() as TripOwnershipMigrationState;
  if (ms.tripId !== tripId) {
    return {
      kind: "anomaly",
      reasonCode: "invalid_migration_state_phase",
      detail: "migrationState.tripId does not match the requested Trip.",
    };
  }
  if (ms.phase !== "completed") {
    return {
      kind: "anomaly",
      reasonCode: "invalid_migration_state_phase",
      detail: `migrationState.phase is "${ms.phase}", not "completed".`,
    };
  }
  return {kind: "already_completed"};
}

// Checkpoint 5B.4B.4, Section B (hardened by Checkpoint 5B.4C, Section
// A): the safe, read-only already_completed audit-report enrichment.
// Called ONLY after `evaluateAlreadyCompleted` has already strictly
// confirmed `already_completed` - this function never influences that
// classification and performs no new economic verification of any
// kind; it purely reports data that is either already FROZEN/
// PERSISTED on the migration-state document itself, or - for the
// three HISTORICAL-RECONSTRUCTION fields specifically
// (`reconstructedOwnership`/`reconstructedOwnershipTotalMinor`/
// `allocationsToCreate`) - read fresh and PROVEN still identical to
// the frozen migration output before ever being reported as such.
//
// Checkpoint 5B.4C, Section A: legitimate post-migration financial
// activity (a lazy-initialized contribution/withdrawal, a brand-new
// Shared-Stash Expense) can change `tripMemberOwnership` rows or add
// new `tripOwnershipAllocations` records at ANY time after
// `"initialized"` - current rows are therefore NOT automatically the
// historical migration output. The three historical fields above are
// populated from the current rows ONLY when BOTH the exact digest AND
// the exact count of the current set equal the frozen
// `expectedOwnershipDigest`/`expectedOwnershipCount` (ownership) or
// `expectedAllocationDigest`/`expectedAllocationCount` (allocations) -
// reusing the exact same canonical digest primitives every other
// exact-output check in this file already uses, never a new
// comparison scheme. A mismatch is NOT reported as an anomaly and
// NEVER changes `already_completed` - it only means these three
// fields stay at their default `null` ("not provably the original
// migration output"), since legitimate evolution is an expected,
// healthy outcome this function must never mistake for drift.
//
// Deliberately NOT populated here, and why:
//   - `historyCounts`: the per-category breakdown (ordinary
//     contributions vs withdrawals vs Shared-Stash events) was only
//     ever computed in-memory during the original reconstruction - it
//     was never persisted individually (only the combined
//     `sourceHistoryDocumentCount` was frozen). Reconstructing it here
//     would require re-reading and re-replaying the Trip's full
//     history, which is a materially larger, re-verification-shaped
//     operation this narrow audit-completeness patch deliberately
//     does not perform.
//   - `reconciliation.*`: already_completed performs no new
//     verification. The individual per-check booleans this type
//     exists to report were only ever computed at runtime by the
//     ORIGINAL completing run's own finalization transaction, and were
//     never persisted anywhere - there is no trustworthy source to
//     honestly reconstruct them from after the fact, so they remain
//     `null` ("not evaluated this run") rather than being guessed.
/**
 * Builds the safe, read-only already_completed audit-report fields.
 * @param {Firestore} db The Firestore instance.
 * @param {string} tripId The Trip's own id.
 * @param {TripOwnershipMigrationState} ms The already-validated,
 *   `phase === "completed"` migration-state document.
 * @return {Promise<Partial<MigrationAuditResult>>} The safe fields to
 *   merge onto the audit result - never touches `verdict`/`phase`.
 */
async function buildAlreadyCompletedReport(
  db: Firestore,
  tripId: string,
  ms: TripOwnershipMigrationState
): Promise<Partial<MigrationAuditResult>> {
  if (ms.phase !== "completed") {
    // Structurally unreachable given this function's own contract
    // (the caller only calls this once `already_completed` is
    // confirmed) - fail closed to an empty enrichment rather than
    // assuming, if that contract is ever violated.
    return {};
  }

  const lockedFinancialBasis = ms.lockedFinancialBasis;
  const {openingBalanceMinor, aggregateLedgerBalanceMinor} =
    basisAmounts(lockedFinancialBasis);

  const [ownershipSnap, allocationSnap] = await Promise.all([
    db.collection("tripMemberOwnership").where("tripId", "==", tripId).get(),
    db
      .collection("tripOwnershipAllocations")
      .where("tripId", "==", tripId)
      .get(),
  ]);

  // Best-effort structural parse only - a single malformed row makes
  // the whole current set impossible to honestly prove equal to the
  // frozen digest (the digest primitive requires well-typed input),
  // so the corresponding historical field below simply stays null
  // rather than comparing a partial/guessed set.
  const currentOwnership: MemberOwnershipBalance[] = [];
  let ownershipRowsWellFormed = true;
  for (const doc of ownershipSnap.docs) {
    const d = doc.data() as Record<string, unknown>;
    if (
      typeof d.uid === "string" &&
      d.uid.length > 0 &&
      typeof d.ownershipMinor === "number" &&
      Number.isSafeInteger(d.ownershipMinor) &&
      d.ownershipMinor >= 0
    ) {
      currentOwnership.push({uid: d.uid, ownershipMinor: d.ownershipMinor});
    } else {
      ownershipRowsWellFormed = false;
    }
  }

  const currentAllocations: AllocationEconomicProjection[] = [];
  let allocationRowsWellFormed = true;
  for (const doc of allocationSnap.docs) {
    const d = doc.data() as Record<string, unknown>;
    if (
      typeof d.tripId === "string" &&
      typeof d.expenseId === "string" &&
      typeof d.withdrawalTransactionId === "string" &&
      typeof d.amountMinor === "number" &&
      typeof d.currency === "string" &&
      Array.isArray(d.allocations) &&
      typeof d.provenance === "string" &&
      d.createdAt instanceof Timestamp
    ) {
      currentAllocations.push({
        id: doc.id,
        tripId: d.tripId,
        expenseId: d.expenseId,
        withdrawalTransactionId: d.withdrawalTransactionId,
        amountMinor: d.amountMinor,
        currency: d.currency,
        allocations: d.allocations as AllocationEconomicProjection[
          "allocations"
        ],
        provenance: d.provenance,
        createdAt: d.createdAt,
      });
    } else {
      allocationRowsWellFormed = false;
    }
  }

  const report: Partial<MigrationAuditResult> = {
    attemptId: ms.attemptId,
    lockedFinancialBasis,
    openingBalanceMinor,
    aggregateLedgerBalanceMinor,
    sourceHistoryDigest: ms.sourceHistoryDigest,
    sourceHistoryDocumentCount: ms.sourceHistoryDocumentCount,
    expectedOwnershipDigest: ms.expectedOwnershipDigest,
    expectedAllocationDigest: ms.expectedAllocationDigest,
  };

  // Checkpoint 5B.4C, Section A: exact digest AND exact count, both
  // required - never count/aggregate alone - reusing the canonical
  // `computeOwnershipDigest` primitive, exactly as finalization's own
  // exact-output check does.
  if (ownershipRowsWellFormed) {
    const currentOwnershipDigest = computeOwnershipDigest(currentOwnership);
    if (
      currentOwnershipDigest.hash === ms.expectedOwnershipDigest &&
      currentOwnershipDigest.count === ms.expectedOwnershipCount
    ) {
      report.reconstructedOwnership = currentOwnership;
      report.reconstructedOwnershipTotalMinor =
        sumReconstructedOwnership(currentOwnership);
    }
  }

  if (allocationRowsWellFormed) {
    const currentAllocationDigest = computeAllocationDigest(
      currentAllocations
    );
    if (
      currentAllocationDigest.hash === ms.expectedAllocationDigest &&
      currentAllocationDigest.count === ms.expectedAllocationCount
    ) {
      report.allocationsToCreate = currentAllocations.map((a) => ({
        withdrawalTransactionId: a.withdrawalTransactionId,
        expenseId: a.expenseId,
        amountMinor: a.amountMinor,
        allocations: a.allocations,
      }));
    }
  }

  return report;
}

// ---------------------------------------------------------------------
// AUDIT-OUTPUT SHAPE (§28, structurally - field names/grouping follow
// the frozen schema; this implementation's own exact TypeScript shape)
// ---------------------------------------------------------------------

export type MigrationAuditResult = {
  tripId: string;
  attemptId: string | null;
  mode: "dry_run" | "apply";
  phase: "locked" | "reconstructed" | "completed" | null;
  verdict: "safe_to_migrate" | "requires_manual_review" | "already_completed";
  lockedFinancialBasis: LockedFinancialBasis | null;
  openingBalanceMinor: number | null;
  aggregateLedgerBalanceMinor: number | null;
  historyCounts: {
    ordinaryContributions: number;
    ordinaryWithdrawals: number;
    sharedStashExpenses: number;
    sharedStashReversals: number;
    memberOutOfPocketExpensesFetchedAndIgnored: number;
    totalHistoryDocumentCount: number;
  } | null;
  sourceHistoryDigest: string | null;
  sourceHistoryDocumentCount: number | null;
  reconstructedOwnership: MemberOwnershipBalance[] | null;
  reconstructedOwnershipTotalMinor: number | null;
  expectedOwnershipDigest: string | null;
  allocationsToCreate: Array<{
    withdrawalTransactionId: string;
    expenseId: string;
    amountMinor: number;
    allocations: ReconstructedAllocation["allocations"];
  }> | null;
  expectedAllocationDigest: string | null;
  anomalies: ReconstructionAnomaly[];
  reconciliation: {
    aggregateMatches: boolean | null;
    historyReplayMatches: boolean | null;
    lockedFinancialBasisMatches: boolean | null;
    sourceHistoryDigestMatches: boolean | null;
    exactOwnershipOutputMatches: boolean | null;
    exactAllocationOutputMatches: boolean | null;
  };
  startedAt: string;
  completedAt: string | null;
};

/**
 * A fresh, all-null reconciliation block - the starting point for both
 * dry-run and apply results, filled in as each check actually runs.
 * @return {object} The empty reconciliation block.
 */
function emptyReconciliation(): MigrationAuditResult["reconciliation"] {
  return {
    aggregateMatches: null,
    historyReplayMatches: null,
    lockedFinancialBasisMatches: null,
    sourceHistoryDigestMatches: null,
    exactOwnershipOutputMatches: null,
    exactAllocationOutputMatches: null,
  };
}

// ---------------------------------------------------------------------
// DRY RUN (§23) - zero writes, under any circumstance.
// ---------------------------------------------------------------------

/**
 * Performs the full read-only dry-run pipeline for one Trip: read Trip,
 * classify ownership state, measure history, classify ledger bootstrap,
 * evaluate eligibility, and - only if eligible - load the full bounded
 * history, reconstruct, reconcile, and compute every digest. Never
 * acquires the migration lock, never writes anything, regardless of
 * outcome.
 * @param {Firestore} db The Firestore instance (emulator or - though
 *   never exercised by this checkpoint's own tests - production).
 * @param {string} tripId The Trip to evaluate.
 * @return {Promise<MigrationAuditResult>} The structured audit result.
 */
export async function runDryRun(
  db: Firestore,
  tripId: string
): Promise<MigrationAuditResult> {
  const startedAt = new Date().toISOString();
  const tripRef = db.collection("trips").doc(tripId);
  const tripSnap = await tripRef.get();
  if (!tripSnap.exists) {
    throw new Error(`No trip found for tripId "${tripId}".`);
  }
  const tripData = tripSnap.data() as Record<string, unknown>;

  const result: MigrationAuditResult = {
    tripId,
    attemptId: null,
    mode: "dry_run",
    phase: null,
    verdict: "requires_manual_review",
    lockedFinancialBasis: null,
    openingBalanceMinor: null,
    aggregateLedgerBalanceMinor: null,
    historyCounts: null,
    sourceHistoryDigest: null,
    sourceHistoryDocumentCount: null,
    reconstructedOwnership: null,
    reconstructedOwnershipTotalMinor: null,
    expectedOwnershipDigest: null,
    allocationsToCreate: null,
    expectedAllocationDigest: null,
    anomalies: [],
    reconciliation: emptyReconciliation(),
    startedAt,
    completedAt: null,
  };

  const classification = classifyTripOwnershipModelState(
    tripData.ownershipModelState,
    tripData.ownershipModelVersion
  );
  if (
    classification.kind === "initialized" ||
    classification.kind === "needs_reconciliation"
  ) {
    // Checkpoint 5B.4B.1, Sections B/C: strict proof required - never
    // inferred from the Trip's ownership state alone, and
    // "needs_reconciliation" is unconditionally blocked, never
    // reported as completed.
    const migrationStateSnap = await db
      .collection("tripOwnershipMigrationState")
      .doc(tripOwnershipMigrationStateId(tripId))
      .get();
    const completion = evaluateAlreadyCompleted(
      classification,
      tripId,
      migrationStateSnap
    );
    if (completion.kind === "already_completed") {
      result.verdict = "already_completed";
      result.phase = "completed";
      // Checkpoint 5B.4B.4, Section B: safe, read-only report
      // enrichment - never influences the already_completed
      // classification itself, which is already final by this point.
      const ms = migrationStateSnap.data() as TripOwnershipMigrationState;
      Object.assign(result, await buildAlreadyCompletedReport(db, tripId, ms));
    } else {
      result.verdict = "requires_manual_review";
      result.anomalies.push({
        reasonCode: completion.reasonCode,
        detail: completion.detail,
        relatedDocumentIds: [],
      });
    }
    result.completedAt = new Date().toISOString();
    return result;
  }

  const counts = await measureTripHistoryCounts(db, tripId);
  result.historyCounts = {
    ordinaryContributions: 0,
    ordinaryWithdrawals: 0,
    sharedStashExpenses: 0,
    sharedStashReversals: 0,
    memberOutOfPocketExpensesFetchedAndIgnored: 0,
    totalHistoryDocumentCount: counts.combinedCount,
  };

  const eligibility = evaluateMigrationEligibility({
    ownershipModelState: tripData.ownershipModelState,
    ownershipModelVersion: tripData.ownershipModelVersion,
    memberIds: tripData.memberIds,
    tripData,
    savingsTransactionCount: counts.savingsTransactionCount,
    combinedHistoryCount: counts.combinedCount,
    historyLimit: AUTOMATIC_MIGRATION_HISTORY_LIMIT,
  });
  if (!eligibility.ok) {
    result.anomalies.push({
      reasonCode: eligibility.reason,
      detail: eligibility.reason,
      relatedDocumentIds: [],
    });
    result.completedAt = new Date().toISOString();
    return result;
  }

  const currencyResolution = resolveTripEffectiveCurrency(tripData);
  if (!currencyResolution.ok) {
    result.anomalies.push({
      reasonCode: "invalid_ledger_state",
      detail: "Trip has a malformed currency field.",
      relatedDocumentIds: [],
    });
    result.completedAt = new Date().toISOString();
    return result;
  }
  const {effectiveCurrency} = currencyResolution;

  const lockedFinancialBasis = buildLockedFinancialBasis(
    eligibility.ledgerBootstrap,
    effectiveCurrency
  );
  result.lockedFinancialBasis = lockedFinancialBasis;
  const {
    openingBalanceMinor,
    aggregateLedgerBalanceMinor: currentAggregateLedgerBalanceMinor,
  } = basisAmounts(lockedFinancialBasis);
  result.openingBalanceMinor = openingBalanceMinor;
  result.aggregateLedgerBalanceMinor = currentAggregateLedgerBalanceMinor;

  const loaded = await loadTripHistory(db, tripId);
  if (!loaded.ok) {
    const {reasonCode, detail} = splitReasonCode(loaded.reason);
    result.anomalies.push({reasonCode, detail, relatedDocumentIds: []});
    result.completedAt = new Date().toISOString();
    return result;
  }

  const reconstruction = runReconstructionPipeline(
    loaded.history,
    tripId,
    effectiveCurrency,
    openingBalanceMinor,
    currentAggregateLedgerBalanceMinor
  );
  if (!reconstruction.ok) {
    result.anomalies.push(reconstruction.anomaly);
    result.completedAt = new Date().toISOString();
    return result;
  }

  result.historyCounts = {
    ...reconstruction.historyCounts,
    totalHistoryDocumentCount: counts.combinedCount,
  };
  result.sourceHistoryDigest = reconstruction.sourceHistoryDigest.hash;
  result.sourceHistoryDocumentCount = reconstruction.sourceHistoryDigest.count;
  result.reconstructedOwnership = reconstruction.ownership;
  result.reconstructedOwnershipTotalMinor = sumReconstructedOwnership(
    reconstruction.ownership
  );
  result.expectedOwnershipDigest = reconstruction.expectedOwnershipDigest.hash;
  result.expectedAllocationDigest =
    reconstruction.expectedAllocationDigest.hash;
  result.allocationsToCreate = reconstruction.allocations.map((a) => ({
    withdrawalTransactionId: a.withdrawalTransactionId,
    expenseId: a.expenseId,
    amountMinor: a.amountMinor,
    allocations: a.allocations,
  }));
  result.reconciliation.aggregateMatches = reconstruction.aggregateMatches;
  result.reconciliation.historyReplayMatches =
    reconstruction.historyReplayMatches;
  result.verdict = "safe_to_migrate";
  result.completedAt = new Date().toISOString();
  return result;
}

// ---------------------------------------------------------------------
// APPLY MODE - fresh lock / phase-aware resume / materialization /
// finalization (§16/§16B/§19/§20/§22)
// ---------------------------------------------------------------------

type LockOutcome =
  | {kind: "locked"; attemptId: string}
  | {kind: "resumed"; attemptId: string; phase: "locked" | "reconstructed"}
  | {kind: "already_completed"}
  | {kind: "anomaly"; reasonCode: string; detail: string};

/**
 * The fresh lock-acquisition transaction, OR (if the Trip is already
 * `"migrating"`) the phase-aware resume classification (§16/§16B/§19) -
 * both handled inside one transaction, since both need a consistent
 * read of the Trip plus (if present) the migration-state document.
 * @param {Firestore} db The Firestore instance.
 * @param {string} tripId The Trip's own id.
 * @return {Promise<LockOutcome>} The outcome of this attempt.
 */
async function acquireOrResumeLock(
  db: Firestore,
  tripId: string
): Promise<LockOutcome> {
  const tripRef = db.collection("trips").doc(tripId);
  const migrationStateRef = db
    .collection("tripOwnershipMigrationState")
    .doc(tripOwnershipMigrationStateId(tripId));

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
    const migrationStateSnap = await tx.get(migrationStateRef);

    const classification = classifyTripOwnershipModelState(
      tripData.ownershipModelState,
      tripData.ownershipModelVersion
    );

    if (classification.kind === "corrupt") {
      return {
        kind: "anomaly",
        reasonCode: "corrupt_ownership_state",
        detail: classification.reason,
      };
    }

    if (
      classification.kind === "initialized" ||
      classification.kind === "needs_reconciliation"
    ) {
      // Checkpoint 5B.4B.1, Sections B/C: the same strict proof
      // runDryRun uses - "needs_reconciliation" is unconditionally
      // blocked, and "initialized" requires the full checklist, never
      // a bare `phase === "completed"` glance.
      const completion = evaluateAlreadyCompleted(
        classification,
        tripId,
        migrationStateSnap
      );
      if (completion.kind === "already_completed") {
        return {kind: "already_completed"};
      }
      return {
        kind: "anomaly",
        reasonCode: completion.reasonCode,
        detail: completion.detail,
      };
    }

    if (classification.kind === "migrating") {
      if (!migrationStateSnap.exists) {
        return {
          kind: "anomaly",
          reasonCode: "unexplained_migrating_state",
          detail: "Trip is migrating but has no migrationStateRef " +
            "document - this mechanism never created this lock.",
        };
      }
      const shapeResult = validateMigrationStateShape(
        migrationStateSnap.data()
      );
      if (!shapeResult.ok) {
        return {
          kind: "anomaly",
          reasonCode: "invalid_migration_state_phase",
          detail: shapeResult.reason,
        };
      }
      const ms = migrationStateSnap.data() as TripOwnershipMigrationState;
      if (ms.phase === "completed") {
        return {
          kind: "anomaly",
          reasonCode: "invalid_migration_state_phase",
          detail: "migrationStateRef.phase is \"completed\" while the " +
            "Trip is still \"migrating\" - impossible pairing.",
        };
      }
      return {kind: "resumed", attemptId: ms.attemptId, phase: ms.phase};
    }

    // classification.kind === "legacy"
    if (migrationStateSnap.exists) {
      return {
        kind: "anomaly",
        reasonCode: "invalid_migration_state_phase",
        detail: "Trip is legacy but a migrationStateRef document " +
          "already exists for it - impossible pairing.",
      };
    }

    // Checkpoint 5B.4A.1, item 8: a fresh lock requires NO pre-existing
    // tripMemberOwnership/tripOwnershipAllocations output for this Trip.
    const [existingOwnership, existingAllocations] = await Promise.all([
      tx.get(
        db
          .collection("tripMemberOwnership")
          .where("tripId", "==", tripId)
          .limit(1)
      ),
      tx.get(
        db
          .collection("tripOwnershipAllocations")
          .where("tripId", "==", tripId)
          .limit(1)
      ),
    ]);
    if (!existingOwnership.empty || !existingAllocations.empty) {
      return {
        kind: "anomaly",
        reasonCode: "pre_existing_output_on_fresh_lock",
        detail: "Found a pre-existing tripMemberOwnership/" +
          "tripOwnershipAllocations document for this Trip before any " +
          "fresh lock has written anything.",
      };
    }

    const counts = await measureCountsInTransaction(tx, db, tripId);
    const eligibility = evaluateMigrationEligibility({
      ownershipModelState: tripData.ownershipModelState,
      ownershipModelVersion: tripData.ownershipModelVersion,
      memberIds: tripData.memberIds,
      tripData,
      savingsTransactionCount: counts.savingsTransactionCount,
      combinedHistoryCount: counts.combinedCount,
      historyLimit: AUTOMATIC_MIGRATION_HISTORY_LIMIT,
    });
    if (!eligibility.ok) {
      return {
        kind: "anomaly",
        reasonCode: eligibility.reason,
        detail: eligibility.reason,
      };
    }

    const currencyResolution = resolveTripEffectiveCurrency(tripData);
    if (!currencyResolution.ok) {
      return {
        kind: "anomaly",
        reasonCode: "invalid_ledger_state",
        detail: "Trip has a malformed currency field.",
      };
    }

    const lockedFinancialBasis = buildLockedFinancialBasis(
      eligibility.ledgerBootstrap,
      currencyResolution.effectiveCurrency
    );
    const attemptId = randomUUID();

    tx.update(tripRef, {ownershipModelState: "migrating"});
    tx.create(migrationStateRef, {
      tripId,
      attemptId,
      phase: "locked",
      lockedAt: FieldValue.serverTimestamp(),
      lockedFinancialBasis,
      startedAt: FieldValue.serverTimestamp(),
    });

    return {kind: "locked", attemptId};
  });
}

/**
 * A count() measurement performed INSIDE an already-open transaction -
 * Firestore's aggregation queries are transaction-consistent reads,
 * identical in spirit to `measureTripHistoryCounts`, duplicated here
 * only because the lock transaction needs it inside its own `tx`.
 * @param {FirebaseFirestore.Transaction} tx The open transaction.
 * @param {Firestore} db The Firestore instance.
 * @param {string} tripId The Trip's own id.
 * @return {Promise<HistoryCounts>} The measured counts.
 */
async function measureCountsInTransaction(
  tx: FirebaseFirestore.Transaction,
  db: Firestore,
  tripId: string
): Promise<HistoryCounts> {
  const [txCountSnap, expenseCountSnap] = await Promise.all([
    tx.get(tripSavingsTransactionsQuery(db, tripId).count()),
    tx.get(tripExpensesQuery(db, tripId).count()),
  ]);
  const savingsTransactionCount = txCountSnap.data().count;
  const tripExpenseCount = expenseCountSnap.data().count;
  return {
    savingsTransactionCount,
    tripExpenseCount,
    combinedCount: savingsTransactionCount + tripExpenseCount,
  };
}

export type TransitionOutcome =
  | {ok: true}
  | {ok: false; reasonCode: string; detail: string};

// Checkpoint 5B.4B.4: per-check evidence from the finalization
// transaction's own 13-step gate (§22) - each field mirrors EXACTLY
// one check that transaction itself performed, set at the moment that
// specific check ran, never inferred afterward from "finalization
// succeeded." `null` means that specific check was never reached this
// attempt (an earlier check already failed closed, or finalization was
// never called at all); `true`/`false` mean it was reached and its
// exact boolean outcome.
export type FinalizationEvidence = {
  lockedFinancialBasisMatches: boolean | null;
  sourceHistoryDigestMatches: boolean | null;
  exactOwnershipOutputMatches: boolean | null;
  exactAllocationOutputMatches: boolean | null;
  aggregateMatches: boolean | null;
};

export type FinalizationOutcome =
  | {ok: true; evidence: FinalizationEvidence}
  | {
      ok: false;
      reasonCode: string;
      detail: string;
      evidence: FinalizationEvidence;
    };

/**
 * A fresh, all-null finalization-evidence block - every check starts
 * unreached; each is set to `true`/`false` only at the exact point in
 * `finalizeMigration` where that specific check actually runs.
 * @return {FinalizationEvidence} The empty evidence block.
 */
function emptyFinalizationEvidence(): FinalizationEvidence {
  return {
    lockedFinancialBasisMatches: null,
    sourceHistoryDigestMatches: null,
    exactOwnershipOutputMatches: null,
    exactAllocationOutputMatches: null,
    aggregateMatches: null,
  };
}

/**
 * Copies every non-null field of finalization's own evidence onto the
 * audit result's `reconciliation` block, overwriting only the fields
 * finalization actually reached - a field finalization never reached
 * (still `null` on its evidence) leaves whatever the caller already
 * had there untouched (e.g. `aggregateMatches`/`historyReplayMatches`
 * already populated from the reconstruction step itself).
 * @param {object} reconciliation The audit result's own reconciliation
 *   block, mutated in place.
 * @param {FinalizationEvidence} evidence Finalization's own evidence,
 *   from either its success or failure outcome.
 * @return {void}
 */
function mergeFinalizationEvidence(
  reconciliation: MigrationAuditResult["reconciliation"],
  evidence: FinalizationEvidence
): void {
  if (evidence.lockedFinancialBasisMatches !== null) {
    reconciliation.lockedFinancialBasisMatches =
      evidence.lockedFinancialBasisMatches;
  }
  if (evidence.sourceHistoryDigestMatches !== null) {
    reconciliation.sourceHistoryDigestMatches =
      evidence.sourceHistoryDigestMatches;
  }
  if (evidence.exactOwnershipOutputMatches !== null) {
    reconciliation.exactOwnershipOutputMatches =
      evidence.exactOwnershipOutputMatches;
  }
  if (evidence.exactAllocationOutputMatches !== null) {
    reconciliation.exactAllocationOutputMatches =
      evidence.exactAllocationOutputMatches;
  }
  if (evidence.aggregateMatches !== null) {
    reconciliation.aggregateMatches = evidence.aggregateMatches;
  }
}

/**
 * The `"locked" -> "reconstructed"` transition (§16B) - its own atomic
 * step. Re-scans/reconstructs the bounded history OUTSIDE this
 * transaction (read-only, safe while quiesced), then commits the three
 * frozen digest/count pairs atomically, requiring the Trip is still
 * migrating and this exact attemptId/phase still hold.
 * @param {Firestore} db The Firestore instance.
 * @param {string} tripId The Trip's own id.
 * @param {string} attemptId This resumed/fresh attempt's own id.
 * @return {Promise<TransitionOutcome>} Ok, or the specific anomaly.
 */
async function transitionToReconstructed(
  db: Firestore,
  tripId: string,
  attemptId: string
): Promise<TransitionOutcome> {
  const tripRef = db.collection("trips").doc(tripId);
  const migrationStateRef = db
    .collection("tripOwnershipMigrationState")
    .doc(tripOwnershipMigrationStateId(tripId));

  const migrationStateSnap = await migrationStateRef.get();
  if (!migrationStateSnap.exists) {
    return {ok: false, reasonCode: "lost_lock_state", detail: "missing"};
  }
  const ms = migrationStateSnap.data() as TripOwnershipMigrationState;
  const lockedFinancialBasis = ms.lockedFinancialBasis;
  const {
    openingBalanceMinor,
    aggregateLedgerBalanceMinor: currentAggregate,
  } = basisAmounts(lockedFinancialBasis);

  const loaded = await loadTripHistory(db, tripId);
  if (!loaded.ok) {
    const {reasonCode, detail} = splitReasonCode(loaded.reason);
    return {ok: false, reasonCode, detail};
  }

  const reconstruction = runReconstructionPipeline(
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

  return db.runTransaction(async (tx) => {
    // ALL READS FIRST.
    const [
      msSnap,
      tripSnap,
      historySnap,
      existingOwnership,
      existingAllocations,
    ] = await Promise.all([
      tx.get(migrationStateRef),
      tx.get(tripRef),
      tx.get(tripSavingsTransactionsQuery(db, tripId).limit(1)),
      tx.get(
        db
          .collection("tripMemberOwnership")
          .where("tripId", "==", tripId)
          .limit(1)
      ),
      tx.get(
        db
          .collection("tripOwnershipAllocations")
          .where("tripId", "==", tripId)
          .limit(1)
      ),
    ]);
    if (!msSnap.exists) {
      return {ok: false, reasonCode: "lost_lock_state", detail: "missing"};
    }
    const current = msSnap.data() as Record<string, unknown>;
    if (current.phase !== "locked" || current.attemptId !== attemptId) {
      return {
        ok: false,
        reasonCode: "invalid_migration_state_phase",
        detail: "phase/attemptId no longer match this attempt.",
      };
    }
    const tripData = tripSnap.data() as Record<string, unknown>;
    const classification = classifyTripOwnershipModelState(
      tripData.ownershipModelState,
      tripData.ownershipModelVersion
    );
    if (classification.kind !== "migrating") {
      return {
        ok: false,
        reasonCode: "unexpected_state_change",
        detail: `Trip is no longer migrating (now ${classification.kind}).`,
      };
    }

    // Checkpoint 5B.4B.1, Section E: re-read the CURRENT Trip and
    // rebuild its financial basis from THIS fresh read (never the
    // basis computed before this transaction opened) - exact-compare
    // against the locked value field-for-field. Catches ledger fields
    // appearing/disappearing, an opening/balance/currency change (even
    // one that nets to the same numeric total), or a changed legacy
    // `saved` value, between lock and this transition.
    const currentLedgerBootstrap = classifyLedgerBootstrapForMigration(
      tripData,
      !historySnap.empty
    );
    if (
      currentLedgerBootstrap.kind !== "case_a" &&
      currentLedgerBootstrap.kind !== "case_a_equivalent"
    ) {
      return {
        ok: false,
        reasonCode: "locked_financial_basis_mismatch",
        detail: "Trip's current ledger-bootstrap classification is no " +
          "longer Case A / Case A-equivalent.",
      };
    }
    const currencyResolution = resolveTripEffectiveCurrency(tripData);
    if (!currencyResolution.ok) {
      return {
        ok: false,
        reasonCode: "locked_financial_basis_mismatch",
        detail: "Trip has a malformed currency field.",
      };
    }
    const currentFinancialBasis = buildLockedFinancialBasis(
      currentLedgerBootstrap,
      currencyResolution.effectiveCurrency
    );
    const stillMatches = lockedFinancialBasesEqual(
      currentFinancialBasis,
      lockedFinancialBasis
    );
    if (!stillMatches) {
      return {
        ok: false,
        reasonCode: "locked_financial_basis_mismatch",
        detail: "Current financial basis disagrees with the locked one.",
      };
    }

    // Checkpoint 5B.4B.1, Section F: phase "locked" must never
    // coexist with any migration output - re-proven here, immediately
    // before the transition, not only at the original fresh-lock
    // check (§19/§16B's own frozen invariant).
    if (!existingOwnership.empty || !existingAllocations.empty) {
      return {
        ok: false,
        reasonCode: "invalid_migration_state_phase",
        detail: "Migration outputs already exist while phase is still " +
          "\"locked\" - impossible under the frozen lifecycle.",
      };
    }

    tx.update(migrationStateRef, {
      phase: "reconstructed",
      sourceHistoryDigest: reconstruction.sourceHistoryDigest.hash,
      sourceHistoryDocumentCount: reconstruction.sourceHistoryDigest.count,
      expectedOwnershipDigest: reconstruction.expectedOwnershipDigest.hash,
      expectedOwnershipCount: reconstruction.ownership.length,
      expectedAllocationDigest: reconstruction.expectedAllocationDigest.hash,
      expectedAllocationCount: reconstruction.allocations.length,
    });
    return {ok: true};
  });
}

/**
 * Checkpoint 5B.4B.1, Section H: the shared write-boundary lifecycle
 * recheck every output-materialization chunk transaction must perform
 * BEFORE writing anything - re-reads the Trip and migration-state
 * documents from scratch inside THIS transaction (never trusting a
 * value read by an earlier chunk or by the orchestration layer),
 * closing the TOCTOU window between reconstruction and each
 * individual chunk's own commit.
 * @param {FirebaseFirestore.Transaction} tx The open transaction.
 * @param {FirebaseFirestore.DocumentReference} tripRef The Trip ref.
 * @param {FirebaseFirestore.DocumentReference} migrationStateRef The
 *   migration-state document ref.
 * @param {string} tripId The Trip's own id.
 * @param {string} attemptId This run's own attempt id.
 * @return {Promise<TransitionOutcome>} Ok, or the specific anomaly.
 */
async function assertStillMigratingAndReconstructed(
  tx: FirebaseFirestore.Transaction,
  tripRef: FirebaseFirestore.DocumentReference,
  migrationStateRef: FirebaseFirestore.DocumentReference,
  tripId: string,
  attemptId: string
): Promise<TransitionOutcome> {
  const [tripSnap, msSnap] = await Promise.all([
    tx.get(tripRef),
    tx.get(migrationStateRef),
  ]);
  if (!tripSnap.exists) {
    return {ok: false, reasonCode: "trip_not_found", detail: "missing"};
  }
  const tripData = tripSnap.data() as Record<string, unknown>;
  const classification = classifyTripOwnershipModelState(
    tripData.ownershipModelState,
    tripData.ownershipModelVersion
  );
  if (classification.kind !== "migrating") {
    return {
      ok: false,
      reasonCode: "unexpected_state_change",
      detail: `Trip is no longer migrating (now ${classification.kind}).`,
    };
  }
  if (!msSnap.exists) {
    return {ok: false, reasonCode: "lost_lock_state", detail: "missing"};
  }
  const shapeResult = validateMigrationStateShape(msSnap.data());
  if (!shapeResult.ok) {
    return {
      ok: false,
      reasonCode: "invalid_migration_state_phase",
      detail: shapeResult.reason,
    };
  }
  const ms = msSnap.data() as TripOwnershipMigrationState;
  if (ms.tripId !== tripId) {
    return {
      ok: false,
      reasonCode: "invalid_migration_state_phase",
      detail: "migrationState.tripId does not match the target Trip.",
    };
  }
  if (ms.attemptId !== attemptId) {
    return {
      ok: false,
      reasonCode: "invalid_migration_state_phase",
      detail: "migrationState.attemptId no longer matches this attempt.",
    };
  }
  if (ms.phase !== "reconstructed") {
    return {
      ok: false,
      reasonCode: "invalid_migration_state_phase",
      detail: `migrationState.phase is "${ms.phase}", not ` +
        "\"reconstructed\".",
    };
  }
  return {ok: true};
}

/**
 * Chunked materialization of `tripMemberOwnership` rows (§17/§19/§21) -
 * unconditional overwrite of every row this run computes, while
 * `"migrating"`, since this run's computation never depends on what
 * was already there. A malformed pre-existing row at the canonical
 * location fails closed for that one row rather than being silently
 * overwritten. Hardened by Checkpoint 5B.4B.1, Section H: each chunk
 * is its own transaction, re-proving the full lifecycle (migrating,
 * version absent, migration state valid/matching tripId/attemptId,
 * phase reconstructed) immediately before that chunk's own commit -
 * no chunk is written once any of this has changed.
 * @param {Firestore} db The Firestore instance.
 * @param {string} tripId The Trip's own id.
 * @param {string} attemptId This run's own attempt id.
 * @param {MemberOwnershipBalance[]} ownership The full reconstructed
 *   ownership set.
 * @return {Promise<TransitionOutcome>} Ok, or the specific anomaly.
 */
export async function materializeOwnershipOutputs(
  db: Firestore,
  tripId: string,
  attemptId: string,
  ownership: MemberOwnershipBalance[]
): Promise<TransitionOutcome> {
  const tripRef = db.collection("trips").doc(tripId);
  const migrationStateRef = db
    .collection("tripOwnershipMigrationState")
    .doc(tripOwnershipMigrationStateId(tripId));

  for (let i = 0; i < ownership.length; i += OUTPUT_WRITE_CHUNK_SIZE) {
    const chunk = ownership.slice(i, i + OUTPUT_WRITE_CHUNK_SIZE);
    const refs = chunk.map((b) =>
      db
        .collection("tripMemberOwnership")
        .doc(tripMemberOwnershipId(tripId, b.uid))
    );
    const result = await db.runTransaction(
      async (tx): Promise<TransitionOutcome> => {
        const lifecycle = await assertStillMigratingAndReconstructed(
          tx,
          tripRef,
          migrationStateRef,
          tripId,
          attemptId
        );
        if (!lifecycle.ok) {
          return lifecycle;
        }

        const snaps = await Promise.all(refs.map((r) => tx.get(r)));
        for (let j = 0; j < chunk.length; j++) {
          const snap = snaps[j];
          if (snap.exists) {
            const d = snap.data() as Record<string, unknown>;
            if (
              d.tripId !== tripId ||
              d.uid !== chunk[j].uid ||
              typeof d.ownershipMinor !== "number" ||
              !Number.isSafeInteger(d.ownershipMinor) ||
              d.ownershipMinor < 0
            ) {
              return {
                ok: false,
                reasonCode: "malformed_pre_existing_ownership_row",
                detail: `tripMemberOwnership/${refs[j].id} is malformed.`,
              };
            }
          }
        }
        for (let j = 0; j < chunk.length; j++) {
          tx.set(refs[j], {
            tripId,
            uid: chunk[j].uid,
            ownershipMinor: chunk[j].ownershipMinor,
            lastUpdatedAt: FieldValue.serverTimestamp(),
          });
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
 * Chunked materialization of `tripOwnershipAllocations` records
 * (§9/§19/§21) - these are immutable once written: absent -> create;
 * exact-matching `"migrated"` -> skip (idempotent); any other existing
 * record (wrong content, `"original"` provenance, or malformed) fails
 * closed. Hardened by Checkpoint 5B.4B.1, Sections H/J: each chunk is
 * its own transaction re-proving the full lifecycle immediately before
 * commit, and an existing `"migrated"` record is only ever treated as
 * an exact match once its `createdAt` equals the original historical
 * event Timestamp EXACTLY and its `migratedAt` is itself a valid
 * Timestamp - never ignoring either.
 * @param {Firestore} db The Firestore instance.
 * @param {string} tripId The Trip's own id.
 * @param {string} attemptId This run's own attempt id.
 * @param {ReconstructedAllocation[]} allocations The full reconstructed
 *   allocation set.
 * @return {Promise<TransitionOutcome>} Ok, or the specific anomaly.
 */
export async function materializeAllocationOutputs(
  db: Firestore,
  tripId: string,
  attemptId: string,
  allocations: ReconstructedAllocation[]
): Promise<TransitionOutcome> {
  const tripRef = db.collection("trips").doc(tripId);
  const migrationStateRef = db
    .collection("tripOwnershipMigrationState")
    .doc(tripOwnershipMigrationStateId(tripId));

  for (let i = 0; i < allocations.length; i += OUTPUT_WRITE_CHUNK_SIZE) {
    const chunk = allocations.slice(i, i + OUTPUT_WRITE_CHUNK_SIZE);
    const refs = chunk.map((a) =>
      db
        .collection("tripOwnershipAllocations")
        .doc(tripOwnershipAllocationId(a.withdrawalTransactionId))
    );
    const result = await db.runTransaction(
      async (tx): Promise<TransitionOutcome> => {
        const lifecycle = await assertStillMigratingAndReconstructed(
          tx,
          tripRef,
          migrationStateRef,
          tripId,
          attemptId
        );
        if (!lifecycle.ok) {
          return lifecycle;
        }

        const snaps = await Promise.all(refs.map((r) => tx.get(r)));
        const toCreate: Array<{
          ref: FirebaseFirestore.DocumentReference;
          a: ReconstructedAllocation;
        }> = [];
        for (let j = 0; j < chunk.length; j++) {
          const snap = snaps[j];
          const a = chunk[j];
          if (!snap.exists) {
            toCreate.push({ref: refs[j], a});
            continue;
          }
          const d = snap.data() as Record<string, unknown>;
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
              reasonCode: "malformed_existing_allocation_record",
              detail: `tripOwnershipAllocations/${refs[j].id}: ` +
                (shapeResult.ok ? "malformed createdAt." : shapeResult.reason),
            };
          }
          // "original" provenance is checked BEFORE the migratedAt
          // check below - an "original" record legitimately never
          // carries migratedAt at all (frozen 5B.1A discriminated
          // schema), so requiring it unconditionally would misreport
          // a genuine "original" record as merely malformed rather
          // than correctly as the impossible-on-a-legacy-Trip conflict
          // it actually is.
          if (d.provenance === "original") {
            return {
              ok: false,
              reasonCode: "conflicting_existing_allocation",
              detail: `tripOwnershipAllocations/${refs[j].id} has ` +
                "provenance \"original\" on a legacy Trip - impossible.",
            };
          }
          if (!(d.migratedAt instanceof Timestamp)) {
            return {
              ok: false,
              reasonCode: "malformed_existing_allocation_record",
              detail: `tripOwnershipAllocations/${refs[j].id} has a ` +
                "missing or invalid migratedAt.",
            };
          }
          const matches =
            d.tripId === a.tripId &&
            d.expenseId === a.expenseId &&
            d.withdrawalTransactionId === a.withdrawalTransactionId &&
            d.amountMinor === a.amountMinor &&
            d.currency === a.currency &&
            JSON.stringify(d.allocations) === JSON.stringify(a.allocations) &&
            (d.createdAt as Timestamp).isEqual(a.createdAt);
          if (!matches) {
            return {
              ok: false,
              reasonCode: "conflicting_existing_allocation",
              detail: `tripOwnershipAllocations/${refs[j].id} disagrees ` +
                "with this run's freshly-computed value.",
            };
          }
          // Exact match - idempotent skip, never re-written.
        }
        for (const {ref, a} of toCreate) {
          tx.create(ref, {
            tripId: a.tripId,
            expenseId: a.expenseId,
            withdrawalTransactionId: a.withdrawalTransactionId,
            amountMinor: a.amountMinor,
            currency: a.currency,
            allocations: a.allocations,
            provenance: "migrated",
            createdAt: a.createdAt,
            migratedAt: FieldValue.serverTimestamp(),
          });
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
 * The final reconciliation gate / final initialization transaction
 * (§22) - the single most important transaction in this design. ALL
 * reads before any write; never trusts any value computed earlier in
 * this run. Hardened by Checkpoint 5B.4B.1, Section M: additionally
 * proves the migration-state document itself validates strictly, and
 * that it belongs to this exact Trip/attempt - never assumed merely
 * from reading it at the expected location. Hardened by Checkpoint
 * 5B.4B.4: returns `FinalizationEvidence` alongside the outcome -
 * each evidence field is set at the EXACT point its own corresponding
 * check runs (never inferred afterward from "the transaction
 * succeeded"), so a caller can report genuinely-verified audit
 * booleans rather than fabricating them from the final result alone.
 * @param {Firestore} db The Firestore instance.
 * @param {string} tripId The Trip's own id.
 * @param {string} attemptId This run's own attempt id.
 * @return {Promise<FinalizationOutcome>} Ok, or the specific anomaly -
 *   either way, with the per-check evidence gathered so far.
 */
async function finalizeMigration(
  db: Firestore,
  tripId: string,
  attemptId: string
): Promise<FinalizationOutcome> {
  const tripRef = db.collection("trips").doc(tripId);
  const migrationStateRef = db
    .collection("tripOwnershipMigrationState")
    .doc(tripOwnershipMigrationStateId(tripId));

  return db.runTransaction(async (tx) => {
    const evidence = emptyFinalizationEvidence();

    const tripSnap = await tx.get(tripRef);
    if (!tripSnap.exists) {
      return {
        ok: false,
        reasonCode: "trip_not_found",
        detail: "missing",
        evidence,
      };
    }
    const tripData = tripSnap.data() as Record<string, unknown>;

    const msSnap = await tx.get(migrationStateRef);
    if (!msSnap.exists) {
      return {
        ok: false,
        reasonCode: "lost_lock_state",
        detail: "missing",
        evidence,
      };
    }
    const msShapeResult = validateMigrationStateShape(msSnap.data());
    if (!msShapeResult.ok) {
      return {
        ok: false,
        reasonCode: "invalid_migration_state_phase",
        detail: msShapeResult.reason,
        evidence,
      };
    }
    const ms = msSnap.data() as TripOwnershipMigrationState;
    if (ms.tripId !== tripId) {
      return {
        ok: false,
        reasonCode: "invalid_migration_state_phase",
        detail: "migrationState.tripId does not match the target Trip.",
        evidence,
      };
    }
    if (ms.attemptId !== attemptId) {
      return {
        ok: false,
        reasonCode: "invalid_migration_state_phase",
        detail: "migrationState.attemptId no longer matches this attempt.",
        evidence,
      };
    }

    const [txSnap, expenseSnap, ownershipSnap, allocationSnap] =
      await Promise.all([
        tx.get(tripSavingsTransactionsQuery(db, tripId)),
        tx.get(tripExpensesQuery(db, tripId)),
        tx.get(
          db.collection("tripMemberOwnership").where("tripId", "==", tripId)
        ),
        tx.get(
          db
            .collection("tripOwnershipAllocations")
            .where("tripId", "==", tripId)
        ),
      ]);

    // 1/2. Still migrating, version absent.
    const classification = classifyTripOwnershipModelState(
      tripData.ownershipModelState,
      tripData.ownershipModelVersion
    );
    if (classification.kind !== "migrating") {
      return {
        ok: false,
        reasonCode: "unexpected_state_change",
        detail: `Trip is no longer migrating (now ${classification.kind}).`,
        evidence,
      };
    }

    // 2a. phase must be "reconstructed".
    if (ms.phase !== "reconstructed") {
      return {
        ok: false,
        reasonCode: "invalid_migration_state_phase",
        detail: `migrationStateRef.phase is "${ms.phase}", not ` +
          "\"reconstructed\".",
        evidence,
      };
    }

    // 2b. Re-verify the locked financial basis independently.
    const hasSavingsTransactionHistory = txSnap.docs.length > 0;
    const currentLedgerBootstrap = classifyLedgerBootstrapForMigration(
      tripData,
      hasSavingsTransactionHistory
    );
    if (
      currentLedgerBootstrap.kind !== "case_a" &&
      currentLedgerBootstrap.kind !== "case_a_equivalent"
    ) {
      evidence.lockedFinancialBasisMatches = false;
      return {
        ok: false,
        reasonCode: "locked_financial_basis_mismatch",
        detail: "Trip's current ledger-bootstrap classification is no " +
          "longer Case A / Case A-equivalent.",
        evidence,
      };
    }
    const currencyResolution = resolveTripEffectiveCurrency(tripData);
    if (!currencyResolution.ok) {
      evidence.lockedFinancialBasisMatches = false;
      return {
        ok: false,
        reasonCode: "locked_financial_basis_mismatch",
        detail: "Trip has a malformed currency field.",
        evidence,
      };
    }
    const currentFinancialBasis = buildLockedFinancialBasis(
      currentLedgerBootstrap,
      currencyResolution.effectiveCurrency
    );
    const basisMatches = lockedFinancialBasesEqual(
      currentFinancialBasis,
      ms.lockedFinancialBasis
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

    // 3. Recompute and exactly match the source-history digest.
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
      currentSourceDigest.hash === ms.sourceHistoryDigest &&
      currentSourceDigest.count === ms.sourceHistoryDocumentCount;
    evidence.sourceHistoryDigestMatches = sourceDigestMatches;
    if (!sourceDigestMatches) {
      return {
        ok: false,
        reasonCode: "out_of_band_mutation_detected",
        detail: "Source-history digest/count no longer match the " +
          "locked expectation.",
        evidence,
      };
    }

    // 5. Exact ownership-output-set verification.
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
    if (balances.length !== ms.expectedOwnershipCount) {
      evidence.exactOwnershipOutputMatches = false;
      return {
        ok: false,
        reasonCode: "exact_output_mismatch",
        detail: `Found ${balances.length} ownership rows, expected ` +
          `${ms.expectedOwnershipCount}.`,
        evidence,
      };
    }
    const actualOwnershipDigest = computeOwnershipDigest(balances);
    const ownershipOutputMatches =
      actualOwnershipDigest.hash === ms.expectedOwnershipDigest;
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

    // 6. Sigma(ownership) == Trip.ledgerBalanceMinor, as an INDEPENDENT
    // invariant.
    const aggregate =
      currentLedgerBootstrap.kind === "case_a" ?
        currentLedgerBootstrap.currentBalanceMinor :
        0;
    if (balances.length === 0) {
      if (aggregate !== 0) {
        evidence.aggregateMatches = false;
        return {
          ok: false,
          reasonCode: "ownership_drift",
          detail: "No ownership rows exist, but the Trip's current " +
            `aggregate is ${aggregate}, not 0.`,
          evidence,
        };
      }
      evidence.aggregateMatches = true;
    } else {
      const reconcile = reconcileOwnershipAgainstAggregate(aggregate, balances);
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

    // 7. Exact allocation-output-set verification.
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
        evidence.exactAllocationOutputMatches = false;
        return {
          ok: false,
          reasonCode: "exact_allocation_output_mismatch",
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
        allocations: d.allocations as AllocationEconomicProjection[
          "allocations"
        ],
        provenance: d.provenance as string,
        createdAt: d.createdAt as Timestamp,
      });
    }
    if (allocationProjections.length !== ms.expectedAllocationCount) {
      evidence.exactAllocationOutputMatches = false;
      return {
        ok: false,
        reasonCode: "exact_allocation_output_mismatch",
        detail: `Found ${allocationProjections.length} allocation ` +
          `records, expected ${ms.expectedAllocationCount}.`,
        evidence,
      };
    }
    const actualAllocationDigest = computeAllocationDigest(
      allocationProjections
    );
    const allocationOutputMatches =
      actualAllocationDigest.hash === ms.expectedAllocationDigest;
    evidence.exactAllocationOutputMatches = allocationOutputMatches;
    if (!allocationOutputMatches) {
      return {
        ok: false,
        reasonCode: "exact_allocation_output_mismatch",
        detail: "Allocation output digest does not match the expected " +
          "value.",
        evidence,
      };
    }

    // Only now, write.
    tx.update(tripRef, {
      ownershipModelState: "initialized",
      ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
    });
    tx.update(migrationStateRef, {
      phase: "completed",
      completedAt: FieldValue.serverTimestamp(),
    });
    return {ok: true, evidence};
  });
}

export type ApplyResult = MigrationAuditResult;

/**
 * Top-level resume-aware apply orchestration (§19/§20) - acquires or
 * resumes the lock, drives the `"locked" -> "reconstructed"`
 * transition if needed, materializes outputs, and finalizes. Every
 * intermediate step leaves the Trip safely `"migrating"` if interrupted
 * - a rerun of this same function always makes forward progress or
 * reports an explicit, named anomaly; it never guesses.
 * @param {Firestore} db The Firestore instance.
 * @param {string} tripId The Trip to migrate.
 * @return {Promise<ApplyResult>} The structured audit result.
 */
export async function runApply(
  db: Firestore,
  tripId: string
): Promise<ApplyResult> {
  const startedAt = new Date().toISOString();
  const base: MigrationAuditResult = {
    tripId,
    attemptId: null,
    mode: "apply",
    phase: null,
    verdict: "requires_manual_review",
    lockedFinancialBasis: null,
    openingBalanceMinor: null,
    aggregateLedgerBalanceMinor: null,
    historyCounts: null,
    sourceHistoryDigest: null,
    sourceHistoryDocumentCount: null,
    reconstructedOwnership: null,
    reconstructedOwnershipTotalMinor: null,
    expectedOwnershipDigest: null,
    allocationsToCreate: null,
    expectedAllocationDigest: null,
    anomalies: [],
    reconciliation: emptyReconciliation(),
    startedAt,
    completedAt: null,
  };

  const lockOutcome = await acquireOrResumeLock(db, tripId);

  if (lockOutcome.kind === "anomaly") {
    base.anomalies.push({
      reasonCode: lockOutcome.reasonCode,
      detail: lockOutcome.detail,
      relatedDocumentIds: [],
    });
    base.completedAt = new Date().toISOString();
    return base;
  }

  if (lockOutcome.kind === "already_completed") {
    base.verdict = "already_completed";
    base.phase = "completed";
    // Checkpoint 5B.4B.4, Section B: the same safe, read-only report
    // enrichment as runDryRun's already_completed path.
    // `acquireOrResumeLock` already strictly proved this outcome
    // inside its own transaction but does not return the
    // migration-state document it read - re-read it fresh here
    // (cheap, read-only; the document is terminal/immutable once
    // `phase === "completed"`) purely to build the report.
    const msSnap = await db
      .collection("tripOwnershipMigrationState")
      .doc(tripOwnershipMigrationStateId(tripId))
      .get();
    if (msSnap.exists && validateMigrationStateShape(msSnap.data()).ok) {
      const ms = msSnap.data() as TripOwnershipMigrationState;
      if (ms.phase === "completed") {
        Object.assign(
          base,
          await buildAlreadyCompletedReport(db, tripId, ms)
        );
      }
    }
    base.completedAt = new Date().toISOString();
    return base;
  }

  const attemptId = lockOutcome.attemptId;
  base.attemptId = attemptId;

  if (lockOutcome.kind === "locked" || lockOutcome.phase === "locked") {
    const transition = await transitionToReconstructed(db, tripId, attemptId);
    if (!transition.ok) {
      base.anomalies.push({
        reasonCode: transition.reasonCode,
        detail: transition.detail,
        relatedDocumentIds: [],
      });
      base.phase = "locked";
      base.completedAt = new Date().toISOString();
      return base;
    }
  }
  base.phase = "reconstructed";

  const migrationStateSnap = await db
    .collection("tripOwnershipMigrationState")
    .doc(tripOwnershipMigrationStateId(tripId))
    .get();
  const msRaw = migrationStateSnap.data() as TripOwnershipMigrationState;
  if (msRaw.phase !== "reconstructed") {
    base.anomalies.push({
      reasonCode: "invalid_migration_state_phase",
      detail: `Expected phase "reconstructed", found "${msRaw.phase}".`,
      relatedDocumentIds: [],
    });
    base.completedAt = new Date().toISOString();
    return base;
  }
  const ms = msRaw;
  base.lockedFinancialBasis = ms.lockedFinancialBasis;

  const {
    openingBalanceMinor,
    aggregateLedgerBalanceMinor: currentAggregate,
  } = basisAmounts(ms.lockedFinancialBasis);
  base.openingBalanceMinor = openingBalanceMinor;
  base.aggregateLedgerBalanceMinor = currentAggregate;

  const loaded = await loadTripHistory(db, tripId);
  if (!loaded.ok) {
    const {reasonCode, detail} = splitReasonCode(loaded.reason);
    base.anomalies.push({reasonCode, detail, relatedDocumentIds: []});
    base.completedAt = new Date().toISOString();
    return base;
  }

  // §19/§20's own resumed-"reconstructed" row: re-verify the CURRENT
  // source history still matches the already-FROZEN sourceHistoryDigest
  // before trusting anything recomputed from it - the same mechanism
  // §22 performs at finalization, run again here so a genuinely
  // corrupted/tampered history is caught immediately, rather than
  // silently re-deriving a brand-new "expected" target from
  // out-of-band-mutated data (which would defeat the entire purpose of
  // freezing digests at reconstruction time).
  const currentSourceDigest = computeSourceHistoryDigest(
    loaded.history.transactions,
    loaded.history.expenses
  );
  const sourceHistoryDigestMatches =
    currentSourceDigest.hash === ms.sourceHistoryDigest &&
    currentSourceDigest.count === ms.sourceHistoryDocumentCount;
  // Checkpoint 5B.4C follow-up: this comparison's boolean result is
  // already directly available here - report it immediately rather
  // than leaving it null, per the true/false/null audit convention.
  // If finalization later reaches its own fresher source-history
  // check, its FinalizationEvidence overwrites this baseline exactly
  // as aggregateMatches already does above.
  base.reconciliation.sourceHistoryDigestMatches = sourceHistoryDigestMatches;
  if (!sourceHistoryDigestMatches) {
    base.anomalies.push({
      reasonCode: "out_of_band_mutation_detected",
      detail: "Source-history digest/count no longer match the " +
        "locked expectation.",
      relatedDocumentIds: [],
    });
    base.completedAt = new Date().toISOString();
    return base;
  }

  const reconstruction = runReconstructionPipeline(
    loaded.history,
    tripId,
    ms.lockedFinancialBasis.effectiveCurrency,
    openingBalanceMinor,
    currentAggregate
  );
  if (!reconstruction.ok) {
    base.anomalies.push(reconstruction.anomaly);
    base.completedAt = new Date().toISOString();
    return base;
  }

  // Checkpoint 5B.4B.4: these two were genuinely established the
  // moment reconstruction itself succeeded - real evidence, not
  // inferred from the eventual outcome - so they are populated here,
  // immediately, rather than only on the final success path. Finalization
  // re-verifies `aggregateMatches` independently and fresher below; if
  // reached, its own evidence overwrites this baseline.
  base.reconciliation.historyReplayMatches =
    reconstruction.historyReplayMatches;
  base.reconciliation.aggregateMatches = reconstruction.aggregateMatches;

  // Checkpoint 5B.4B.1, Section G: pin the resumed reconstruction to
  // the EXACT expected-output model already frozen at
  // "locked" -> "reconstructed" time - a fresh deterministic
  // reconstruction from source history already proven identical
  // (the digest check above) must still reproduce EXACTLY the same
  // expected ownership/allocation digest+count, or this run's own
  // migration code/accounting behavior has drifted since that
  // attempt's reconstruction. Never silently re-target the frozen
  // expectation - fail closed before any output write.
  if (
    reconstruction.expectedOwnershipDigest.hash !==
      ms.expectedOwnershipDigest ||
    reconstruction.expectedOwnershipDigest.count !==
      ms.expectedOwnershipCount ||
    reconstruction.expectedAllocationDigest.hash !==
      ms.expectedAllocationDigest ||
    reconstruction.expectedAllocationDigest.count !==
      ms.expectedAllocationCount
  ) {
    base.anomalies.push({
      reasonCode: "frozen_reconstruction_target_mismatch",
      detail: "Source history matches the frozen digest, but a fresh " +
        "reconstruction from it no longer reproduces the frozen " +
        "expected ownership/allocation output model.",
      relatedDocumentIds: [],
    });
    base.completedAt = new Date().toISOString();
    return base;
  }

  const ownershipWrite = await materializeOwnershipOutputs(
    db,
    tripId,
    attemptId,
    reconstruction.ownership
  );
  if (!ownershipWrite.ok) {
    base.anomalies.push({
      reasonCode: ownershipWrite.reasonCode,
      detail: ownershipWrite.detail,
      relatedDocumentIds: [],
    });
    base.completedAt = new Date().toISOString();
    return base;
  }

  const allocationWrite = await materializeAllocationOutputs(
    db,
    tripId,
    attemptId,
    reconstruction.allocations
  );
  if (!allocationWrite.ok) {
    base.anomalies.push({
      reasonCode: allocationWrite.reasonCode,
      detail: allocationWrite.detail,
      relatedDocumentIds: [],
    });
    base.completedAt = new Date().toISOString();
    return base;
  }

  const finalizeResult = await finalizeMigration(db, tripId, attemptId);
  mergeFinalizationEvidence(base.reconciliation, finalizeResult.evidence);
  if (!finalizeResult.ok) {
    base.anomalies.push({
      reasonCode: finalizeResult.reasonCode,
      detail: finalizeResult.detail,
      relatedDocumentIds: [],
    });
    base.completedAt = new Date().toISOString();
    return base;
  }

  base.phase = "completed";
  base.verdict = "safe_to_migrate";
  base.sourceHistoryDigest = reconstruction.sourceHistoryDigest.hash;
  base.sourceHistoryDocumentCount = reconstruction.sourceHistoryDigest.count;
  base.reconstructedOwnership = reconstruction.ownership;
  base.reconstructedOwnershipTotalMinor = sumReconstructedOwnership(
    reconstruction.ownership
  );
  base.expectedOwnershipDigest = reconstruction.expectedOwnershipDigest.hash;
  base.allocationsToCreate = reconstruction.allocations.map((a) => ({
    withdrawalTransactionId: a.withdrawalTransactionId,
    expenseId: a.expenseId,
    amountMinor: a.amountMinor,
    allocations: a.allocations,
  }));
  base.expectedAllocationDigest = reconstruction.expectedAllocationDigest.hash;
  base.historyCounts = {
    ...reconstruction.historyCounts,
    totalHistoryDocumentCount:
      loaded.history.transactions.length + loaded.history.expenses.length,
  };
  base.completedAt = new Date().toISOString();
  return base;
}

// ---------------------------------------------------------------------
// CLI / EXECUTION-TARGET SAFETY GUARD (§2/§24) - pure decision logic,
// fully testable without ever touching a real Firestore connection.
// ---------------------------------------------------------------------

export const PRODUCTION_PROJECT_ID = "squadstash-6d0f1";

export type ExecutionTarget =
  | {ok: true; mode: "emulator"; projectId: string}
  | {ok: true; mode: "production"; projectId: string}
  | {ok: false; reason: string};

/**
 * Resolves the safe execution target from the process environment and
 * parsed CLI flags - the emulator is always safe and requires no extra
 * confirmation; production requires an exact `--project` match AND
 * (for apply mode) an exact `--confirm <tripId>` echo-back, matched
 * against the trip id this invocation targets. Pure w.r.t. its explicit
 * `env`/`flags` arguments (never reads `process.env` itself) so tests
 * can exercise every branch without touching a real environment.
 * @param {object} input The environment/flags this decision depends on.
 * @return {ExecutionTarget} The resolved target, or the specific reason
 *   this invocation is unsafe to run.
 */
export function resolveExecutionTarget(input: {
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
      projectId: input.projectFlag ?? "demo-migrate-trip-ownership",
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
 * `resolveExecutionTarget`, `runDryRun`, and `runApply` directly against
 * an emulator-backed Firestore instance they construct themselves.
 * @return {Promise<void>} Resolves once the requested run completes.
 */
async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.tripId) {
    throw new Error("Usage: --trip <tripId> [--dry-run|--apply] " +
      "[--project <id>] [--confirm <tripId>]");
  }
  const target = resolveExecutionTarget({
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
