// Checkpoint 6.7A (hardened by the 6.7A Migration Recovery Review and
// the 6.7A Final Financial Parity Review): an admin-only, offline
// migration tool that initializes the tripExpenseBalances social-ledger
// aggregate for a single LEGACY Trip, by recomputing its current net
// balances from the Trip's complete, immutable history - every Expense
// (classified by its own paymentSource; a valid member_out_of_pocket
// Expense also brings in its own persisted tripExpenseSplits) and every
// Settlement.
//
// Two frozen disciplines, both mirroring src/domain/tripSettlement.ts's
// own `computeTripBalances` exactly (never a weaker, migration-only
// rule):
//   - A record's full shape is ALWAYS validated first, UNCONDITIONALLY,
//     before any "status === reversed" skip - a malformed record can
//     never hide behind "reversed." Reversed means economic
//     contribution is zero, never that validation was disabled. An
//     UNRECOGNIZED status value is a data-integrity anomaly and fails
//     the whole migration closed.
//   - A split's own amountMinor may legitimately be exactly 0 (an
//     intentional $0 share) - only a negative or non-safe-integer value
//     is malformed. A valid shared_stash Expense (also explicitly
//     classified, never hidden behind a paymentSource query filter)
//     contributes ZERO to this social aggregate, regardless of its own
//     active/reversed status - Shared Stash spending is never pairwise
//     member debt.
//
// A local, Admin-SDK-only Node.js script - NEVER exported from
// functions/src/index.ts, NEVER wrapped in onCall/HTTP, NEVER reachable
// from app/client code. Single-Trip only. Dry-run is the default/safest
// mode; applying a migration requires an explicit, separate,
// unambiguous invocation.
//
// CRASH RECOVERY (the Migration Recovery Review's own frozen principle):
// an interrupted apply - crashed after acquiring the "migrating" lock,
// after writing some but not all deterministic balance rows, or even
// after writing every row but before the final "migrating" ->
// "initialized" flip - must be safely resumable, never requiring manual
// Firestore surgery. This tool NEVER automatically treats a "migrating"
// Trip as a fresh legacy migration (that would risk silently re-deriving
// over a genuinely different, more complex in-flight state); resuming
// requires the caller to explicitly pass `{resume: true}` (or `--resume`
// on the CLI). Once resuming, recovery always re-derives the ENTIRE
// expected balance map from the Trip's own immutable source history and
// validates every pre-existing tripExpenseBalances row against that
// recomputed truth:
//   - an existing row that EXACTLY matches recomputed truth is safe
//     (harmless to re-write with the identical value).
//   - an expected row that is simply MISSING (never written before the
//     crash) is the ordinary, safe crash-recovery case - it is written.
//   - an existing row with a WRONG value, an UNEXPECTED uid not present
//     in recomputed truth, or a MALFORMED shape is never the same thing
//     as a safe partial-crash state - it is a corruption/anomaly, and
//     this tool fails closed, leaves the Trip "migrating", and never
//     repairs or deletes anything automatically.
// This file performs every Firestore read/write the migration needs;
// the actual delta arithmetic is delegated to tripExpenseBalance.ts's
// own pure helpers - this file never duplicates that math.
import {FieldValue, getFirestore} from "firebase-admin/firestore";
import type {DocumentReference, Firestore} from "firebase-admin/firestore";
import {initializeApp} from "firebase-admin/app";

import {
  classifyTripExpenseBalanceModelState,
  CURRENT_TRIP_EXPENSE_BALANCE_MODEL_VERSION,
} from "../domain/tripExpenseBalanceModel";
import {
  computeExpenseBalanceDeltas,
  computeSettlementBalanceDeltas,
} from "../domain/tripExpenseBalance";
import type {NormalizedBalanceDelta} from "../domain/tripExpenseBalance";
import {
  isValidNetBalanceMinor,
  tripExpenseBalanceId,
} from "../domain/tripExpenseBalanceStore";

// Matches migrateTripOwnership.ts's own OUTPUT_WRITE_CHUNK_SIZE value
// and reasoning exactly - well under Firestore's 500-write batch limit,
// duplicated here rather than imported (this is a distinct tool's own
// constant, not shared state between the two migrations).
export const OUTPUT_WRITE_CHUNK_SIZE = 400;

export type TripExpenseBalanceComputedBalance = {
  uid: string;
  netBalanceMinor: number;
};

export type TripExpenseBalanceMigrationResult = {
  tripId: string;
  mode: "dry_run" | "apply";
  status:
    // dry_run only: every check passed; apply would succeed as-is.
    | "would_initialize"
    // apply only: the aggregate was written (or confirmed already
    // written, on a resumed run) and the Trip is now "initialized".
    | "initialized"
    // the Trip's expense-balance model was not eligible for the
    // requested operation - not "legacy" (fresh run), or "migrating"
    // without an explicit resume request.
    | "not_eligible"
    // a parity/invariant failure, a pre-existing stale row (legacy
    // fresh-run path), a lock-acquisition race, or a resume-time
    // conflicting/extra/malformed row was found - never auto-repaired.
    // If the Trip was already "migrating" when this was found, it is
    // left there intentionally.
    | "blocked";
  computedBalances: TripExpenseBalanceComputedBalance[];
  staleRows: TripExpenseBalanceComputedBalance[];
  anomalies: string[];
  startedAt: string;
  completedAt: string | null;
};

export type TripExpenseBalanceMigrationOptions = {
  // Explicit operator intent required to continue an interrupted
  // migration - see this file's own header comment. Ignored (has no
  // effect, is not an error) when the Trip is not currently "migrating".
  resume?: boolean;
};

// Named so the JSDoc @return tag below can reference it directly,
// rather than an inline union type (which the valid-jsdoc ESLint rule
// cannot parse).
type CombineAcrossHistoryResult =
  | {ok: true; deltas: NormalizedBalanceDelta[]}
  | {ok: false; reason: string};

/**
 * Combines already-computed, individually-zero-summing
 * NormalizedBalanceDelta entries (one set per Expense/Settlement) into
 * exactly one net total per uid across the Trip's ENTIRE history,
 * verifying every intermediate/final value stays a safe integer and
 * that the grand total still sums to exactly zero. A small, local
 * duplicate of tripExpenseBalance.ts's own private accumulateDeltas -
 * not imported, since that helper is deliberately not exported (the
 * callables never need to combine ACROSS multiple Expenses/Settlements
 * the way this migration tool uniquely does).
 * @param {NormalizedBalanceDelta[]} entries Every per-Expense/
 *   Settlement delta entry collected across the Trip's full history.
 * @return {CombineAcrossHistoryResult} The combined, zero-summing grand
 *   totals, or the specific reason they could not be safely combined.
 */
function combineAcrossHistory(
  entries: NormalizedBalanceDelta[]
): CombineAcrossHistoryResult {
  const map = new Map<string, number>();
  for (const entry of entries) {
    const prev = map.get(entry.uid) ?? 0;
    const next = prev + entry.deltaMinor;
    if (!Number.isSafeInteger(next)) {
      return {
        ok: false,
        reason: `Balance overflow combining history for uid "${entry.uid}".`,
      };
    }
    map.set(entry.uid, next);
  }

  const deltas: NormalizedBalanceDelta[] = Array.from(map.entries()).map(
    ([uid, deltaMinor]) => ({uid, deltaMinor})
  );

  let sum = 0;
  for (const d of deltas) {
    sum += d.deltaMinor;
  }
  if (sum !== 0) {
    return {
      ok: false,
      reason: `Combined trip history does not sum to zero (sum=${sum}).`,
    };
  }

  return {ok: true, deltas};
}

type ExpectedBalancesResult = {
  anomalies: string[];
  balances: TripExpenseBalanceComputedBalance[];
};

// Checkpoint 6.7A Final Financial Parity Review: the classification
// this migration tool needs from an Expense's own paymentSource-
// conditional fields. Mirrors src/domain/tripSettlement.ts's own
// `assertValidExpensePaymentShape` exactly (member_out_of_pocket
// requires a non-empty payerUid and an ABSENT sharedStashTransactionId;
// shared_stash requires a null payerUid and a non-empty
// sharedStashTransactionId) - a narrow, Functions-side mirror rather
// than an import of client-only code, per this review's own
// architecture-boundary instruction.
type ExpensePaymentClassification =
  | {kind: "member_out_of_pocket"; payerUid: string}
  | {kind: "shared_stash"}
  | {kind: "unknown"; reason: string};

/**
 * Classifies and shape-validates an Expense document's paymentSource-
 * conditional fields - see this file's own ExpensePaymentClassification
 * comment for exactly which client-domain invariant this mirrors.
 * @param {Record<string, unknown>} data The raw Expense document data.
 * @return {ExpensePaymentClassification} The classification, or the
 *   specific reason the record's payment shape is unknown/malformed.
 */
function classifyExpensePaymentShape(
  data: Record<string, unknown>
): ExpensePaymentClassification {
  if (data.paymentSource === "member_out_of_pocket") {
    if (
      typeof data.payerUid !== "string" ||
      data.payerUid.trim().length === 0
    ) {
      return {
        kind: "unknown",
        reason: "paymentSource \"member_out_of_pocket\" requires a " +
          "non-empty payerUid.",
      };
    }
    if (data.sharedStashTransactionId !== undefined) {
      return {
        kind: "unknown",
        reason: "paymentSource \"member_out_of_pocket\" must not have " +
          "a sharedStashTransactionId.",
      };
    }
    return {kind: "member_out_of_pocket", payerUid: data.payerUid};
  }
  if (data.paymentSource === "shared_stash") {
    if (data.payerUid !== null) {
      return {
        kind: "unknown",
        reason: "paymentSource \"shared_stash\" must have a null " +
          "payerUid.",
      };
    }
    if (
      typeof data.sharedStashTransactionId !== "string" ||
      data.sharedStashTransactionId.trim().length === 0
    ) {
      return {
        kind: "unknown",
        reason: "paymentSource \"shared_stash\" requires a non-empty " +
          "sharedStashTransactionId.",
      };
    }
    return {kind: "shared_stash"};
  }
  return {
    kind: "unknown",
    reason: `unknown paymentSource "${String(data.paymentSource)}".`,
  };
}

// Named so the JSDoc @return tags below can reference it directly,
// rather than an inline union type (which the valid-jsdoc ESLint rule
// cannot parse).
type ShapeValidationResult = {ok: true} | {ok: false; reason: string};

/**
 * Validates a Settlement document's active/reversed reversal-metadata
 * shape AND its status value in one unconditional call - mirrors
 * src/domain/tripSettlement.ts's own
 * `assertValidSettlementReversalShape` exactly (active: reversedAt/
 * reversedBy/reversalReason must all be absent; reversed: reversedAt
 * present, a non-empty reversedBy, and - if present - a string
 * reversalReason; any other status value is unknown). A narrow,
 * Functions-side mirror rather than an import of client-only code.
 * @param {Record<string, unknown>} data The raw Settlement document
 *   data.
 * @return {ShapeValidationResult} Whether the shape is valid, or the
 *   specific reason it is not.
 */
function validateSettlementReversalShape(
  data: Record<string, unknown>
): ShapeValidationResult {
  if (data.status === "active") {
    if (data.reversedAt !== undefined) {
      return {
        ok: false,
        reason: "status \"active\" must not have a reversedAt.",
      };
    }
    if (data.reversedBy !== undefined) {
      return {
        ok: false,
        reason: "status \"active\" must not have a reversedBy.",
      };
    }
    if (data.reversalReason !== undefined) {
      return {
        ok: false,
        reason: "status \"active\" must not have a reversalReason.",
      };
    }
    return {ok: true};
  }
  if (data.status === "reversed") {
    if (data.reversedAt === undefined) {
      return {
        ok: false,
        reason: "status \"reversed\" requires a reversedAt.",
      };
    }
    if (
      typeof data.reversedBy !== "string" ||
      data.reversedBy.trim().length === 0
    ) {
      return {
        ok: false,
        reason: "status \"reversed\" requires a non-empty reversedBy.",
      };
    }
    if (
      data.reversalReason !== undefined &&
      typeof data.reversalReason !== "string"
    ) {
      return {
        ok: false,
        reason: "reversalReason, when present, must be a string.",
      };
    }
    return {ok: true};
  }
  return {
    ok: false,
    reason: `unknown status "${String(data.status)}".`,
  };
}

// Named so the JSDoc @return tag below can reference it directly,
// rather than an inline union type (which the valid-jsdoc ESLint rule
// cannot parse).
type SplitSumResult = {ok: true; total: number} | {ok: false};

/**
 * Sums already-individually-validated safe-integer split amounts,
 * checking the running total after every addition - mirrors
 * src/domain/tripSettlement.ts's own `sumSafeIntegers` discipline.
 * @param {number[]} values The per-split amounts to sum.
 * @return {SplitSumResult} The running total, or failure if the
 *   running sum ever left the safe-integer range.
 */
function sumSplitAmounts(values: number[]): SplitSumResult {
  let total = 0;
  for (const value of values) {
    const next = total + value;
    if (!Number.isSafeInteger(next)) {
      return {ok: false};
    }
    total = next;
  }
  return {ok: true, total};
}

/**
 * Recomputes the COMPLETE expected tripExpenseBalances map for one Trip
 * from its immutable source history alone - every Expense (classified
 * and validated per its own paymentSource) and every Settlement.
 * Never reads tripExpenseBalances itself - this is pure recomputation
 * from source evidence, reused identically by the legacy fresh-run
 * dry-run path and the migrating-Trip resume path, so "what should the
 * aggregate look like" is computed exactly once, never duplicated
 * between the two call sites.
 *
 * Checkpoint 6.7A Final Financial Parity Review - two frozen
 * disciplines, both mirroring src/domain/tripSettlement.ts's own
 * `computeTripBalances` exactly:
 *   1. VALIDATE SHAPE FIRST, ALWAYS - every Expense/Settlement's full
 *      shape (routing, amounts, currency, payment/reversal metadata,
 *      split integrity) is validated UNCONDITIONALLY, before any
 *      "status === reversed" skip is ever consulted. A malformed
 *      reversed record is a migration-blocking anomaly, never silently
 *      excluded the way a genuinely VALID reversed record's zero
 *      economic contribution is.
 *   2. paymentSource is classified, never query-filtered - every
 *      Expense for this Trip is read and explicitly classified into
 *      member_out_of_pocket / shared_stash / unknown, so an unknown/
 *      malformed paymentSource can never hide behind a
 *      `.where("paymentSource", "==", ...)` filter the way it
 *      previously could. A valid shared_stash Expense is validated
 *      enough to confirm it is a legitimate record, then contributes
 *      ZERO to this social aggregate (Shared Stash spending is never
 *      pairwise member debt) - regardless of its own active/reversed
 *      status.
 * @param {Firestore} db Admin SDK Firestore instance.
 * @param {string} tripId The Trip to recompute.
 * @return {Promise<ExpectedBalancesResult>} The recomputed balances, or
 *   the specific anomalies that make recomputation unsafe to trust.
 */
async function computeExpectedBalances(
  db: Firestore,
  tripId: string
): Promise<ExpectedBalancesResult> {
  const anomalies: string[] = [];
  const allDeltaEntries: NormalizedBalanceDelta[] = [];

  // --- Phase 1: Expenses - validate shape, classify paymentSource,
  // index. No paymentSource (or status) filter at the query level - see
  // this function's own header comment. A malformed/unknown-shape
  // Expense is simply never added to `validExpenses` below - any split
  // that later claims to belong to it is therefore caught by Phase 2's
  // own "references nonexistent or invalid expense" check, rather than
  // becoming independently invisible (Final ExpenseSplit Parity Audit
  // item 8).
  const expensesSnap = await db
    .collection("tripExpenses")
    .where("tripId", "==", tripId)
    .get();

  const validExpenses = new Map<
    string,
    {
      amountMinor: number;
      status: "active" | "reversed";
      payment: ExpensePaymentClassification;
    }
  >();

  for (const expenseDoc of expensesSnap.docs) {
    const expenseData = expenseDoc.data();

    if (
      typeof expenseData.amountMinor !== "number" ||
      !Number.isSafeInteger(expenseData.amountMinor) ||
      expenseData.amountMinor <= 0
    ) {
      anomalies.push(
        `Expense "${expenseDoc.id}" has a malformed amountMinor.`
      );
      continue;
    }
    if (expenseData.currency !== "USD") {
      anomalies.push(
        `Expense "${expenseDoc.id}" has an unsupported currency.`
      );
      continue;
    }
    const paymentShape = classifyExpensePaymentShape(expenseData);
    if (paymentShape.kind === "unknown") {
      anomalies.push(`Expense "${expenseDoc.id}": ${paymentShape.reason}`);
      continue;
    }
    if (
      expenseData.status !== "active" &&
      expenseData.status !== "reversed"
    ) {
      anomalies.push(
        `Expense "${expenseDoc.id}" has an unsupported status ` +
          `"${String(expenseData.status)}" and cannot be migrated.`
      );
      continue;
    }
    validExpenses.set(expenseDoc.id, {
      amountMinor: expenseData.amountMinor,
      status: expenseData.status,
      payment: paymentShape,
    });
  }

  // --- Phase 2: Splits - ONE Trip-wide query, validated GLOBALLY
  // against `validExpenses` - mirrors src/domain/tripSettlement.ts's own
  // computeTripBalances two-pass architecture exactly (Final
  // ExpenseSplit Parity Audit §2/§3/§10). A per-Expense query (the
  // prior design) can only ever find splits belonging to an Expense
  // this migration already knows about - it can never discover an
  // ORPHAN split (expenseId referencing a nonexistent/foreign/invalid
  // Expense), nor a split attached to a shared_stash Expense (whose
  // splits a per-Expense design never even queries for). A single
  // Trip-wide scan, cross-checked against every split's own claimed
  // expenseId, closes both gaps.
  const splitsSnap = await db
    .collection("tripExpenseSplits")
    .where("tripId", "==", tripId)
    .get();

  const splitsByExpenseId = new Map<
    string,
    {uid: string; amountMinor: number}[]
  >();
  const seenSplitKeys = new Set<string>(); // `${expenseId}|${userId}`

  for (const splitDoc of splitsSnap.docs) {
    const splitData = splitDoc.data();
    if (
      typeof splitData.expenseId !== "string" ||
      splitData.expenseId.length === 0 ||
      typeof splitData.userId !== "string" ||
      splitData.userId.length === 0
    ) {
      anomalies.push(
        `ExpenseSplit "${splitDoc.id}" has malformed routing fields.`
      );
      continue;
    }
    if (!validExpenses.has(splitData.expenseId)) {
      anomalies.push(
        `ExpenseSplit "${splitDoc.id}" references an expense ` +
          `"${splitData.expenseId}" that does not exist (or is not a ` +
          "validly-shaped expense) on this trip."
      );
      continue;
    }
    const dupKey = `${splitData.expenseId}|${splitData.userId}`;
    if (seenSplitKeys.has(dupKey)) {
      anomalies.push(
        `Duplicate ExpenseSplit for user "${splitData.userId}" on ` +
          `expense "${splitData.expenseId}".`
      );
      continue;
    }
    seenSplitKeys.add(dupKey);
    if (
      typeof splitData.amountMinor !== "number" ||
      !Number.isSafeInteger(splitData.amountMinor) ||
      splitData.amountMinor < 0
    ) {
      anomalies.push(
        `ExpenseSplit "${splitDoc.id}" has a malformed amountMinor.`
      );
      continue;
    }
    const list = splitsByExpenseId.get(splitData.expenseId) ?? [];
    list.push({uid: splitData.userId, amountMinor: splitData.amountMinor});
    splitsByExpenseId.set(splitData.expenseId, list);
  }

  // --- Phase 3: Expense -> economic contribution, consuming the
  // globally-validated splits grouped above. Split-shape/total
  // validation (member_out_of_pocket requires >= 1 split; ANY Expense
  // with splits present - including a shared_stash one - must have
  // them sum exactly to its own amountMinor) runs UNCONDITIONALLY,
  // before the reversed-status economic skip - mirrors
  // computeTripBalances's own identical ordering exactly.
  for (const [expenseId, expense] of validExpenses) {
    const expenseSplits = splitsByExpenseId.get(expenseId) ?? [];

    if (
      expense.payment.kind === "member_out_of_pocket" &&
      expenseSplits.length === 0
    ) {
      anomalies.push(`Expense "${expenseId}" has no split data.`);
      continue;
    }

    if (expenseSplits.length > 0) {
      const splitSum = sumSplitAmounts(
        expenseSplits.map((s) => s.amountMinor)
      );
      if (!splitSum.ok) {
        anomalies.push(
          `Expense "${expenseId}" splits overflowed the safe integer ` +
            "range while summing."
        );
        continue;
      }
      if (splitSum.total !== expense.amountMinor) {
        anomalies.push(
          `Expense "${expenseId}" splits sum to ${splitSum.total}, ` +
            `expected ${expense.amountMinor}.`
        );
        continue;
      }
    }

    if (expense.status === "reversed") {
      // Fully shape-validated above; ONLY NOW is the economic
      // contribution skipped - forward + exact inverse already nets to
      // zero live, so replaying it would be redundant, never incorrect
      // to skip.
      continue;
    }

    if (expense.payment.kind !== "member_out_of_pocket") {
      // shared_stash: validated enough (including any attached splits'
      // own shape/total above) to establish this is a legitimate
      // Expense record - contributes ZERO to this social aggregate
      // regardless (Shared Stash spending is never pairwise member
      // debt).
      continue;
    }

    const deltaResult = computeExpenseBalanceDeltas(
      expense.payment.payerUid,
      expense.amountMinor,
      expenseSplits
    );
    if (!deltaResult.ok) {
      anomalies.push(`Expense "${expenseId}": ${deltaResult.reason}`);
      continue;
    }
    allDeltaEntries.push(...deltaResult.deltas);
  }

  const settlementsSnap = await db
    .collection("tripSettlements")
    .where("tripId", "==", tripId)
    .get();
  for (const settlementDoc of settlementsSnap.docs) {
    const settlementData = settlementDoc.data();

    // --- Shape validation FIRST, unconditionally -----------------------
    if (
      typeof settlementData.fromUid !== "string" ||
      settlementData.fromUid.length === 0 ||
      typeof settlementData.toUid !== "string" ||
      settlementData.toUid.length === 0
    ) {
      anomalies.push(
        `Settlement "${settlementDoc.id}" has malformed fromUid/toUid.`
      );
      continue;
    }
    if (settlementData.fromUid === settlementData.toUid) {
      anomalies.push(
        `Settlement "${settlementDoc.id}" has fromUid === toUid.`
      );
      continue;
    }
    if (
      typeof settlementData.amountMinor !== "number" ||
      !Number.isSafeInteger(settlementData.amountMinor) ||
      settlementData.amountMinor <= 0
    ) {
      anomalies.push(
        `Settlement "${settlementDoc.id}" has a malformed amountMinor.`
      );
      continue;
    }
    if (settlementData.currency !== "USD") {
      anomalies.push(
        `Settlement "${settlementDoc.id}" has an unsupported currency.`
      );
      continue;
    }
    // Validates BOTH the status value itself AND its full reversal-
    // metadata shape in one unconditional call - see this function's
    // own validateSettlementReversalShape.
    const reversalShape = validateSettlementReversalShape(settlementData);
    if (!reversalShape.ok) {
      anomalies.push(
        `Settlement "${settlementDoc.id}": ${reversalShape.reason}`
      );
      continue;
    }

    if (settlementData.status === "reversed") {
      // Fully shape-validated above; ONLY NOW is the economic
      // contribution skipped.
      continue;
    }

    const deltaResult = computeSettlementBalanceDeltas(
      settlementData.fromUid,
      settlementData.toUid,
      settlementData.amountMinor
    );
    if (!deltaResult.ok) {
      anomalies.push(
        `Settlement "${settlementDoc.id}": ${deltaResult.reason}`
      );
      continue;
    }
    allDeltaEntries.push(...deltaResult.deltas);
  }

  const combined = combineAcrossHistory(allDeltaEntries);
  if (!combined.ok) {
    anomalies.push(combined.reason);
    return {anomalies, balances: []};
  }

  const balances: TripExpenseBalanceComputedBalance[] = combined.deltas.map(
    (d) => ({uid: d.uid, netBalanceMinor: d.deltaMinor})
  );

  let sum = 0;
  for (const b of balances) {
    if (b.uid.length === 0 || !isValidNetBalanceMinor(b.netBalanceMinor)) {
      anomalies.push(
        `Computed balance for uid "${b.uid}" is not a valid safe integer.`
      );
      continue;
    }
    sum += b.netBalanceMinor;
  }
  if (anomalies.length === 0 && sum !== 0) {
    anomalies.push(`Computed balances do not sum to zero (sum=${sum}).`);
  }

  return {anomalies, balances};
}

type ExistingRowValidation =
  | {ok: true}
  | {
      ok: false;
      anomalies: string[];
      staleRows: TripExpenseBalanceComputedBalance[];
    };

/**
 * Validates every PRE-EXISTING tripExpenseBalances row for a Trip
 * against the recomputed expected truth - the crash-recovery
 * classification the Migration Recovery Review requires (§6): an
 * existing row that exactly matches recomputed truth is a safe partial-
 * crash state; a MISSING expected row is not flagged here at all (that
 * is the caller's job to simply write); a WRONG value, an unexpected
 * extra uid, or a malformed shape is always an anomaly, regardless of
 * how "close" it looks - never repaired, never deleted.
 * @param {Firestore} db Admin SDK Firestore instance.
 * @param {string} tripId The Trip whose existing rows are being
 *   validated.
 * @param {TripExpenseBalanceComputedBalance[]} expectedBalances The
 *   freshly recomputed expected balances to compare against.
 * @return {Promise<ExistingRowValidation>} Either a clean pass, or the
 *   specific anomalies/stale rows found.
 */
async function validateExistingRowsAgainstExpected(
  db: Firestore,
  tripId: string,
  expectedBalances: TripExpenseBalanceComputedBalance[]
): Promise<ExistingRowValidation> {
  const expectedMap = new Map<string, number>(
    expectedBalances.map((b) => [b.uid, b.netBalanceMinor])
  );
  const existingSnap = await db
    .collection("tripExpenseBalances")
    .where("tripId", "==", tripId)
    .get();

  const anomalies: string[] = [];
  const staleRows: TripExpenseBalanceComputedBalance[] = [];

  for (const doc of existingSnap.docs) {
    const data = doc.data();
    const reportedUid = typeof data.uid === "string" ? data.uid : "(unknown)";
    const reportedBalance = isValidNetBalanceMinor(data.netBalanceMinor) ?
      data.netBalanceMinor :
      NaN;

    const wellFormed =
      typeof data.tripId === "string" &&
      data.tripId === tripId &&
      typeof data.uid === "string" &&
      data.uid.length > 0 &&
      isValidNetBalanceMinor(data.netBalanceMinor) &&
      doc.id === tripExpenseBalanceId(tripId, data.uid);

    if (!wellFormed) {
      staleRows.push({uid: reportedUid, netBalanceMinor: reportedBalance});
      anomalies.push(
        `Existing tripExpenseBalances row "${doc.id}" is malformed ` +
          "(unexpected id/tripId/uid/netBalanceMinor shape) and cannot " +
          "be safely resumed from."
      );
      continue;
    }

    if (!expectedMap.has(data.uid)) {
      staleRows.push({uid: data.uid, netBalanceMinor: data.netBalanceMinor});
      anomalies.push(
        `Existing tripExpenseBalances row for uid "${data.uid}" does ` +
          "not correspond to any uid in the recomputed expected set."
      );
      continue;
    }

    const expectedValue = expectedMap.get(data.uid) as number;
    if (data.netBalanceMinor !== expectedValue) {
      staleRows.push({uid: data.uid, netBalanceMinor: data.netBalanceMinor});
      anomalies.push(
        `Existing tripExpenseBalances row for uid "${data.uid}" is ` +
          `${data.netBalanceMinor}, but recomputed truth expects ` +
          `${expectedValue} - refusing to overwrite a conflicting value.`
      );
    }
  }

  if (anomalies.length > 0) {
    return {ok: false, anomalies, staleRows};
  }
  return {ok: true};
}

// Named so the JSDoc @return tag below can reference it directly,
// rather than an inline union type (which the valid-jsdoc ESLint rule
// cannot parse).
type LockAcquisitionResult = {ok: true} | {ok: false; reason: string};

/**
 * Attempts the race-safe legacy -> migrating lock transition for a
 * fresh (non-resumed) apply. Re-reads the Trip inside the transaction
 * and re-classifies it, rather than trusting the preflight read, so two
 * concurrent first-run attempts can never both believe they acquired
 * the transition - exactly one commits the write; the loser observes
 * the now-changed state and returns a failure instead of retrying or
 * silently proceeding.
 * @param {Firestore} db Admin SDK Firestore instance.
 * @param {DocumentReference} tripRef The Trip document reference.
 * @return {Promise<LockAcquisitionResult>} Whether the lock was
 *   acquired, or the specific reason it was not.
 */
async function acquireLegacyToMigratingLock(
  db: Firestore,
  tripRef: DocumentReference
): Promise<LockAcquisitionResult> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(tripRef);
    if (!snap.exists) {
      throw new Error(`Trip "${tripRef.id}" no longer exists.`);
    }
    const data = snap.data() as Record<string, unknown>;
    const liveClassification = classifyTripExpenseBalanceModelState(
      data.expenseBalanceModelState,
      data.expenseBalanceModelVersion
    );
    if (liveClassification.kind !== "legacy") {
      return {
        ok: false,
        reason: "Trip's expense-balance model changed to " +
          `"${liveClassification.kind}" before migration could start; ` +
          "refusing to proceed. Re-run this tool to re-evaluate.",
      };
    }
    tx.update(tripRef, {expenseBalanceModelState: "migrating"});
    return {ok: true};
  });
}

/**
 * The shared recompute -> validate -> (write) -> finalize procedure for
 * a Trip that is already "migrating" - reached either because this
 * invocation just acquired the lock itself (fresh apply, zero
 * pre-existing rows expected) or because the caller explicitly asked to
 * resume an interrupted prior attempt (pre-existing rows may be
 * present, partially or fully written). The two cases are handled by
 * the EXACT same code path - a fresh lock-then-fill is simply "resume"
 * with nothing yet to resume from.
 * @param {Firestore} db Admin SDK Firestore instance.
 * @param {string} tripId The Trip being migrated.
 * @param {"dry_run" | "apply"} mode Whether to only compute/validate, or
 *   to also write the result and finalize.
 * @param {DocumentReference} tripRef The Trip document reference.
 * @param {string} startedAt The ISO timestamp this invocation began at.
 * @return {Promise<TripExpenseBalanceMigrationResult>} The structured
 *   result.
 */
async function resumeAndFinalize(
  db: Firestore,
  tripId: string,
  mode: "dry_run" | "apply",
  tripRef: DocumentReference,
  startedAt: string
): Promise<TripExpenseBalanceMigrationResult> {
  const computed = await computeExpectedBalances(db, tripId);
  if (computed.anomalies.length > 0) {
    return {
      tripId,
      mode,
      status: "blocked",
      computedBalances: computed.balances,
      staleRows: [],
      anomalies: computed.anomalies,
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  const existingValidation = await validateExistingRowsAgainstExpected(
    db,
    tripId,
    computed.balances
  );
  if (!existingValidation.ok) {
    return {
      tripId,
      mode,
      status: "blocked",
      computedBalances: computed.balances,
      staleRows: existingValidation.staleRows,
      anomalies: existingValidation.anomalies,
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  if (mode === "dry_run") {
    return {
      tripId,
      mode,
      status: "would_initialize",
      computedBalances: computed.balances,
      staleRows: [],
      anomalies: [],
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  // apply: full-overwrite every expected row - idempotent no-op for a
  // row already present with the identical (already-validated) value;
  // fills in exactly the rows a crash left missing. Retains an explicit
  // row even where the final value is exactly zero - mirrors
  // applyTripExpenseBalanceDeltas's own frozen zero-row-retention
  // invariant exactly.
  for (
    let i = 0;
    i < computed.balances.length;
    i += OUTPUT_WRITE_CHUNK_SIZE
  ) {
    const chunk = computed.balances.slice(i, i + OUTPUT_WRITE_CHUNK_SIZE);
    const batch = db.batch();
    for (const balance of chunk) {
      const ref = db
        .collection("tripExpenseBalances")
        .doc(tripExpenseBalanceId(tripId, balance.uid));
      batch.set(ref, {
        tripId,
        uid: balance.uid,
        netBalanceMinor: balance.netBalanceMinor,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
  }

  // Only on success, mark the Trip "initialized"/version 1 - re-checked
  // for "migrating" at write time, so a Trip that was somehow mutated
  // away from "migrating" mid-migration is never silently finalized.
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(tripRef);
    if (!snap.exists) {
      throw new Error(`Trip "${tripId}" no longer exists.`);
    }
    const data = snap.data() as Record<string, unknown>;
    if (data.expenseBalanceModelState !== "migrating") {
      throw new Error(
        "Trip's expense-balance model is no longer \"migrating\" " +
          `(found "${String(data.expenseBalanceModelState)}") - refusing ` +
          "to finalize. The balance rows above have already been " +
          "written; investigate manually before re-running."
      );
    }
    tx.update(tripRef, {
      expenseBalanceModelState: "initialized",
      expenseBalanceModelVersion: CURRENT_TRIP_EXPENSE_BALANCE_MODEL_VERSION,
    });
  });

  return {
    tripId,
    mode,
    status: "initialized",
    computedBalances: computed.balances,
    staleRows: [],
    anomalies: [],
    startedAt,
    completedAt: new Date().toISOString(),
  };
}

/**
 * Runs the tripExpenseBalances migration for one Trip - dry-run (zero
 * writes, under any circumstance) or apply; fresh first-run (a
 * "legacy" Trip) or an explicit resume of an interrupted prior attempt
 * (a "migrating" Trip, with `options.resume: true`). See this file's
 * own header comment for the full crash-recovery algorithm and its
 * rationale.
 * @param {Firestore} db The Firestore instance (emulator or - though
 *   never exercised by this checkpoint's own tests, and never actually
 *   invoked against production during this checkpoint - production).
 * @param {string} tripId The Trip to migrate.
 * @param {"dry_run" | "apply"} mode Whether to only compute/validate, or
 *   to also write the result.
 * @param {TripExpenseBalanceMigrationOptions} options Resume intent.
 * @return {Promise<TripExpenseBalanceMigrationResult>} The structured
 *   migration result.
 */
export async function runTripExpenseBalanceMigration(
  db: Firestore,
  tripId: string,
  mode: "dry_run" | "apply",
  options: TripExpenseBalanceMigrationOptions = {}
): Promise<TripExpenseBalanceMigrationResult> {
  const startedAt = new Date().toISOString();
  const resume = options.resume === true;

  // Step 1: read the Trip, classify its expense-balance model state.
  const tripRef = db.collection("trips").doc(tripId);
  const tripSnap = await tripRef.get();
  if (!tripSnap.exists) {
    throw new Error(`No trip found for tripId "${tripId}".`);
  }
  const tripData = tripSnap.data() as Record<string, unknown>;
  const classification = classifyTripExpenseBalanceModelState(
    tripData.expenseBalanceModelState,
    tripData.expenseBalanceModelVersion
  );

  // An explicit resume request against a currently-"migrating" Trip -
  // the ONLY path that ever re-enters a migration already in progress.
  // Never automatic (Migration Recovery Review §5).
  if (classification.kind === "migrating" && resume) {
    return resumeAndFinalize(db, tripId, mode, tripRef, startedAt);
  }

  if (classification.kind !== "legacy") {
    const reason =
      classification.kind === "migrating" ?
        "Trip's expense-balance model is \"migrating\" - pass " +
          "{resume: true} (or --resume on the CLI) to continue an " +
          "interrupted migration; a fresh invocation never silently " +
          "resumes one." :
        `Trip's expense-balance model is "${classification.kind}", not ` +
          "\"legacy\" - only a legacy trip is eligible for this " +
          "migration tool.";
    return {
      tripId,
      mode,
      status: "not_eligible",
      computedBalances: [],
      staleRows: [],
      anomalies: [reason],
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  // LEGACY fresh-run path (Migration Recovery Review §3): a legacy Trip
  // is NEVER expected to have any pre-existing tripExpenseBalances row
  // at all (no code path ever writes one for a legacy Trip) - finding
  // one here is itself the anomaly, checked BEFORE any state mutation,
  // for BOTH dry_run and apply, so an already-anomalous legacy Trip is
  // never converted into a permanently-locked "migrating" Trip merely
  // because a migration was attempted against it.
  const preexistingSnap = await db
    .collection("tripExpenseBalances")
    .where("tripId", "==", tripId)
    .get();
  if (!preexistingSnap.empty) {
    const staleRows: TripExpenseBalanceComputedBalance[] =
      preexistingSnap.docs.map((doc) => {
        const data = doc.data();
        return {
          uid: typeof data.uid === "string" ? data.uid : "(unknown)",
          netBalanceMinor: isValidNetBalanceMinor(data.netBalanceMinor) ?
            data.netBalanceMinor :
            NaN,
        };
      });
    return {
      tripId,
      mode,
      status: "blocked",
      computedBalances: [],
      staleRows,
      anomalies: [
        `${staleRows.length} pre-existing tripExpenseBalances row(s) ` +
          "found for a trip that has never been migrated - this is " +
          "anomalous for a legacy trip. Refusing to begin migration; " +
          "the Trip's \"legacy\" state is left unchanged.",
      ],
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  if (mode === "dry_run") {
    const computed = await computeExpectedBalances(db, tripId);
    return {
      tripId,
      mode,
      status: computed.anomalies.length > 0 ? "blocked" : "would_initialize",
      computedBalances: computed.balances,
      staleRows: [],
      anomalies: computed.anomalies,
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  // mode === "apply": acquire the legacy -> migrating lock (Migration
  // Recovery Review §4) before ever writing a single balance row.
  const lock = await acquireLegacyToMigratingLock(db, tripRef);
  if (!lock.ok) {
    return {
      tripId,
      mode,
      status: "blocked",
      computedBalances: [],
      staleRows: [],
      anomalies: [lock.reason],
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  // The Trip is now "migrating" with (by construction, just confirmed
  // above) zero pre-existing rows - resumeAndFinalize's own generic
  // "missing row -> write it" handling fills in every row from scratch,
  // exactly as a true resume would for a Trip that crashed immediately
  // after the lock was acquired.
  return resumeAndFinalize(db, tripId, mode, tripRef, startedAt);
}

// ---------------------------------------------------------------------
// CLI wrapper - mirrors migrateTripOwnership.ts's own
// resolveExecutionTarget/parseArgs/main shape exactly, simplified for
// this tool's single-function (no digest/attempt-id) design.
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
 * (for apply mode) an exact `--confirm <tripId>` echo-back. Pure w.r.t.
 * its explicit `input` argument (never reads `process.env` itself) so
 * tests can exercise every branch without touching a real environment.
 * Unaffected by `--resume` - resuming changes WHICH algorithm path runs,
 * never the production-safety gate itself.
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
      projectId:
        input.projectFlag ?? "demo-migrate-trip-expense-balances",
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
  resume: boolean;
} {
  let tripId: string | undefined;
  let mode: "dry_run" | "apply" = "dry_run";
  let projectFlag: string | undefined;
  let confirmFlag: string | undefined;
  let resume = false;
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
    } else if (arg === "--resume") {
      resume = true;
    }
  }
  return {tripId, mode, projectFlag, confirmFlag, resume};
}

/**
 * CLI entry point. Never invoked by any test - tests exercise
 * `resolveExecutionTarget` and `runTripExpenseBalanceMigration` directly
 * against an emulator-backed Firestore instance they construct
 * themselves. Checkpoint 6.7A: this entry point is never actually
 * invoked (not against the emulator, and never against production)
 * during this checkpoint - it exists for a future checkpoint only.
 * @return {Promise<void>} Resolves once the requested run completes.
 */
async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.tripId) {
    throw new Error("Usage: --trip <tripId> [--dry-run|--apply] " +
      "[--resume] [--project <id>] [--confirm <tripId>]");
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

  const result = await runTripExpenseBalanceMigration(
    db,
    parsed.tripId,
    parsed.mode,
    {resume: parsed.resume}
  );

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
