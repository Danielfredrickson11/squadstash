// Checkpoint 5B.4B, per the frozen docs/audits/
// TRIP_WALLET_OWNERSHIP_MIGRATION_PREFLIGHT_2026-10-10.md §6-§11 (as
// hardened by Amendments 5B.4A.1/5B.4A.2). Pure logical-event
// construction, deterministic ordering, and chronological replay - no
// Firestore I/O in this file. Every arithmetic step reuses the
// existing 5B.2 pure primitives (`applyMemberContribution`,
// `applyMemberWithdrawal`, `applySharedStashDepletion`,
// `restoreSharedStashDepletion`) - this module duplicates none of
// their math, per this project's own "do not duplicate pure math"
// convention.
import type {Timestamp} from "firebase-admin/firestore";
import {
  applyMemberContribution,
  applyMemberWithdrawal,
  applySharedStashDepletion,
  restoreSharedStashDepletion,
} from "./tripOwnershipAccounting";
import type {MemberOwnershipBalance} from "./tripOwnershipAccounting";
import type {TripOwnershipAllocationEntry} from "./tripOwnershipAllocation";

// ---------------------------------------------------------------------
// RAW INPUT SHAPES (already-validated-enough-to-read fields only - full
// safe-integer/non-empty-string validation happens in the admin tool
// before these are ever constructed, so this module can trust its own
// inputs are well-typed and focus purely on REPLAY-SPECIFIC validation:
// linkage, timestamp agreement, and ordering).
// ---------------------------------------------------------------------

export type RawSavingsTransactionRecord = {
  id: string;
  resourceType: string;
  resourceId: string;
  memberUid: string;
  type: string;
  amountMinor: number;
  currency: string;
  createdAt: Timestamp;
  reversalOf: string | null;
  linkedExpenseId: string | null;
};

export type RawTripExpenseRecord = {
  id: string;
  tripId: string;
  paymentSource: string;
  amountMinor: number;
  currency: string;
  sharedStashTransactionId: string | null;
  status: string;
  createdAt: Timestamp;
  reversedAt: Timestamp | null;
  refundTransactionId: string | null;
};

// ---------------------------------------------------------------------
// LOGICAL EVENTS (§7) - migration never iterates raw documents, only
// these already-validated, already-paired logical events.
// ---------------------------------------------------------------------

export type LogicalEvent =
  | {
      kind: "contribution";
      uid: string;
      amountMinor: number;
      timestamp: Timestamp;
      sourceId: string;
    }
  | {
      kind: "withdrawal";
      uid: string;
      amountMinor: number;
      timestamp: Timestamp;
      sourceId: string;
    }
  | {
      kind: "shared_stash_expense";
      expenseId: string;
      withdrawalId: string;
      amountMinor: number;
      currency: string;
      timestamp: Timestamp;
      sourceId: string;
    }
  | {
      kind: "shared_stash_reversal";
      expenseId: string;
      withdrawalId: string;
      refundId: string;
      // Always exactly equal to the original Expense's/withdrawal's own
      // amountMinor (buildLogicalEvents already validates this equality
      // before ever constructing this event) - carried here, rather
      // than requiring every consumer to re-look it up via the original
      // withdrawal's own allocation, specifically so
      // `replayAggregateLedgerTotal` below can replay the signed
      // aggregate history from this event list ALONE, independently of
      // `replayLogicalEvents`'s own in-memory allocation bookkeeping
      // (§15's "independently replaying the full historical ledger"
      // requirement - two genuinely separate computations, not one
      // computation read twice).
      amountMinor: number;
      timestamp: Timestamp;
      sourceId: string;
    };

export type BuildLogicalEventsResult =
  | {ok: true; events: LogicalEvent[]}
  | {ok: false; reason: string};

/**
 * True if two Timestamps represent the exact same instant (seconds AND
 * nanoseconds) - never a tolerance/rounding comparison.
 * @param {Timestamp} a The first timestamp.
 * @param {Timestamp} b The second timestamp.
 * @return {boolean} True if they are exactly equal.
 */
function timestampsEqual(a: Timestamp, b: Timestamp): boolean {
  return a.seconds === b.seconds && a.nanoseconds === b.nanoseconds;
}

/**
 * Builds the full logical-event list for one Trip from its raw,
 * already-loaded `savingsTransactions`/`tripExpenses` sets (§6/§9/§10).
 * Validates every linkage/timestamp/currency rule the frozen
 * classification table requires; fails closed (never silently skips or
 * guesses) on any unrecognized shape, orphaned linkage, or disagreement
 * between a Shared-Stash Expense and its own withdrawal/refund.
 * @param {RawSavingsTransactionRecord[]} transactions Every
 *   `savingsTransactions` document for the Trip.
 * @param {RawTripExpenseRecord[]} expenses Every `tripExpenses`
 *   document for the Trip, including `"member_out_of_pocket"` ones
 *   (fetched incidentally, classified and discarded here - §3/§12 of
 *   the preflight).
 * @param {string} effectiveCurrency The Trip's resolved effective
 *   currency - every record's own `currency` must match exactly.
 * @return {BuildLogicalEventsResult} The full logical-event list, or
 *   the specific reason construction failed.
 */
export function buildLogicalEvents(
  transactions: RawSavingsTransactionRecord[],
  expenses: RawTripExpenseRecord[],
  effectiveCurrency: string
): BuildLogicalEventsResult {
  const events: LogicalEvent[] = [];
  const consumedTransactionIds = new Set<string>();
  const transactionsById = new Map(transactions.map((t) => [t.id, t]));

  // Pass 1: every ordinary (non-Shared-Stash-linked) transaction.
  for (const tx of transactions) {
    if (tx.linkedExpenseId !== null) {
      continue; // handled in pass 2, driven by its own Expense.
    }
    if (tx.reversalOf !== null) {
      // Frozen classification table (§6): reversalOf present with
      // linkedExpenseId absent is impossible under every current
      // trusted callable - no generic reversal exists for ordinary
      // transactions.
      return {
        ok: false,
        reason: "unexpected_historical_record_type: savingsTransactions/" +
          `${tx.id} has reversalOf set with no linkedExpenseId.`,
      };
    }
    if (tx.currency !== effectiveCurrency) {
      return {
        ok: false,
        reason: `currency_mismatch: savingsTransactions/${tx.id}.`,
      };
    }
    if (tx.type !== "contribution" && tx.type !== "withdrawal") {
      return {
        ok: false,
        reason: "unexpected_historical_record_type: savingsTransactions/" +
          `${tx.id} has an unrecognized type "${tx.type}".`,
      };
    }
    events.push({
      kind: tx.type,
      uid: tx.memberUid,
      amountMinor: tx.amountMinor,
      timestamp: tx.createdAt,
      sourceId: tx.id,
    });
    consumedTransactionIds.add(tx.id);
  }

  // Pass 2: every Shared-Stash Expense drives its own withdrawal
  // (required) and, if reversed, its own refund (required).
  for (const expense of expenses) {
    if (expense.paymentSource !== "shared_stash") {
      // "member_out_of_pocket" - fetched, classified, ignored (§3/§12).
      continue;
    }
    if (expense.sharedStashTransactionId === null) {
      return {
        ok: false,
        reason: `orphan_expense_linkage: tripExpenses/${expense.id} has ` +
          "no sharedStashTransactionId.",
      };
    }
    const withdrawal = transactionsById.get(expense.sharedStashTransactionId);
    if (!withdrawal) {
      return {
        ok: false,
        reason: `missing_original_withdrawal: tripExpenses/${expense.id} ` +
          `references ${expense.sharedStashTransactionId}.`,
      };
    }
    if (
      withdrawal.linkedExpenseId !== expense.id ||
      withdrawal.reversalOf !== null ||
      withdrawal.type !== "withdrawal"
    ) {
      return {
        ok: false,
        reason: "orphan_expense_linkage: savingsTransactions/" +
          `${withdrawal.id} does not correctly link back to ` +
          `tripExpenses/${expense.id}.`,
      };
    }
    if (!timestampsEqual(withdrawal.createdAt, expense.createdAt)) {
      return {
        ok: false,
        reason: "unexpected_historical_record_type: tripExpenses/" +
          `${expense.id}.createdAt does not equal its own withdrawal's ` +
          "createdAt (must be written in the same transaction).",
      };
    }
    if (
      withdrawal.amountMinor !== expense.amountMinor ||
      withdrawal.currency !== expense.currency
    ) {
      return {
        ok: false,
        reason: `orphan_expense_linkage: tripExpenses/${expense.id} and ` +
          "its withdrawal disagree on amountMinor/currency.",
      };
    }
    if (expense.currency !== effectiveCurrency) {
      return {
        ok: false,
        reason: `currency_mismatch: tripExpenses/${expense.id}.`,
      };
    }
    events.push({
      kind: "shared_stash_expense",
      expenseId: expense.id,
      withdrawalId: withdrawal.id,
      amountMinor: expense.amountMinor,
      currency: expense.currency,
      timestamp: expense.createdAt,
      sourceId: withdrawal.id,
    });
    consumedTransactionIds.add(withdrawal.id);

    if (expense.status === "active") {
      continue;
    }
    if (expense.status !== "reversed") {
      return {
        ok: false,
        reason: "unexpected_historical_record_type: tripExpenses/" +
          `${expense.id} has an unrecognized status "${expense.status}".`,
      };
    }
    if (expense.reversedAt === null || expense.refundTransactionId === null) {
      return {
        ok: false,
        reason: `reversal_timestamp_mismatch: tripExpenses/${expense.id} ` +
          "is reversed but missing reversedAt/refundTransactionId.",
      };
    }
    const refund = transactionsById.get(expense.refundTransactionId);
    if (!refund) {
      return {
        ok: false,
        reason: "duplicate_or_conflicting_reversal: tripExpenses/" +
          `${expense.id} references a missing refund ` +
          `${expense.refundTransactionId}.`,
      };
    }
    if (
      refund.linkedExpenseId !== expense.id ||
      refund.reversalOf !== withdrawal.id ||
      refund.type !== "contribution"
    ) {
      return {
        ok: false,
        reason: "duplicate_or_conflicting_reversal: savingsTransactions/" +
          `${refund.id} does not correctly link back to ` +
          `tripExpenses/${expense.id}.`,
      };
    }
    if (!timestampsEqual(refund.createdAt, expense.reversedAt)) {
      return {
        ok: false,
        reason: `reversal_timestamp_mismatch: tripExpenses/${expense.id}` +
          ".reversedAt does not equal its own refund's createdAt.",
      };
    }
    if (
      refund.amountMinor !== expense.amountMinor ||
      refund.currency !== expense.currency
    ) {
      return {
        ok: false,
        reason: "duplicate_or_conflicting_reversal: tripExpenses/" +
          `${expense.id} and its refund disagree on amountMinor/currency.`,
      };
    }
    events.push({
      kind: "shared_stash_reversal",
      expenseId: expense.id,
      withdrawalId: withdrawal.id,
      refundId: refund.id,
      amountMinor: expense.amountMinor,
      timestamp: expense.reversedAt,
      sourceId: refund.id,
    });
    consumedTransactionIds.add(refund.id);
  }

  // Pass 3: every transaction must have been consumed by pass 1 or 2 -
  // any leftover (linkedExpenseId set but never matched to a
  // shared_stash Expense) is orphaned.
  for (const tx of transactions) {
    if (!consumedTransactionIds.has(tx.id)) {
      return {
        ok: false,
        reason: `orphan_expense_linkage: savingsTransactions/${tx.id} is ` +
          "linked to an Expense that never resolved it.",
      };
    }
  }

  return {ok: true, events};
}

// ---------------------------------------------------------------------
// DETERMINISTIC ORDERING (§7) - structural tie-safety check, then a
// single deterministic sort. Order-insensitive ties are proven safe
// mathematically (same-sign deltas - see this module's own test suite
// for the worked proof) and resolved by sourceId; every other tie
// fails closed.
// ---------------------------------------------------------------------

export type OrderLogicalEventsResult =
  | {ok: true; ordered: LogicalEvent[]}
  | {ok: false; reason: string};

/**
 * Orders a Trip's full logical-event list chronologically, failing
 * closed on any ambiguous same-timestamp tie (§7) rather than guessing.
 * @param {LogicalEvent[]} events The unordered logical-event list.
 * @return {OrderLogicalEventsResult} The deterministically-ordered
 *   list, or the specific reason an ambiguous tie was found.
 */
export function orderLogicalEvents(
  events: LogicalEvent[]
): OrderLogicalEventsResult {
  const groups = new Map<string, LogicalEvent[]>();
  for (const event of events) {
    const key = `${event.timestamp.seconds}.${event.timestamp.nanoseconds}`;
    const group = groups.get(key);
    if (group) {
      group.push(event);
    } else {
      groups.set(key, [event]);
    }
  }

  for (const group of groups.values()) {
    if (group.length <= 1) {
      continue;
    }
    if (
      group.some(
        (e) =>
          e.kind === "shared_stash_expense" ||
          e.kind === "shared_stash_reversal"
      )
    ) {
      return {
        ok: false,
        reason: "ambiguous_event_ordering: a Shared-Stash Expense " +
          "creation/reversal shares an identical timestamp with another " +
          "logical event.",
      };
    }
    // All ordinary (contribution/withdrawal) - safe only if, per uid,
    // every tied event is the SAME kind (same-sign deltas commute and
    // their joint validity does not depend on order); a mixed
    // contribution+withdrawal tie for the same uid is ambiguous,
    // because order can change whether an intermediate balance ever
    // goes negative (the frozen worked example: 0 -> +100 -> -100 is
    // valid; 0 -> -100 is not, even though the net effect is the same).
    const byUid = new Map<string, LogicalEvent[]>();
    for (const event of group) {
      if (event.kind !== "contribution" && event.kind !== "withdrawal") {
        continue;
      }
      const sub = byUid.get(event.uid);
      if (sub) {
        sub.push(event);
      } else {
        byUid.set(event.uid, [event]);
      }
    }
    for (const [uid, sub] of byUid) {
      if (sub.length <= 1) {
        continue;
      }
      const kinds = new Set(sub.map((e) => e.kind));
      if (kinds.size > 1) {
        return {
          ok: false,
          reason: `ambiguous_event_ordering: uid "${uid}" has both a ` +
            "contribution and a withdrawal at the identical timestamp.",
        };
      }
    }
  }

  const ordered = [...events].sort((a, b) => {
    if (a.timestamp.seconds !== b.timestamp.seconds) {
      return a.timestamp.seconds - b.timestamp.seconds;
    }
    if (a.timestamp.nanoseconds !== b.timestamp.nanoseconds) {
      return a.timestamp.nanoseconds - b.timestamp.nanoseconds;
    }
    return a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0;
  });
  return {ok: true, ordered};
}

// ---------------------------------------------------------------------
// CHRONOLOGICAL REPLAY (§8/§9/§10)
// ---------------------------------------------------------------------

export type ReconstructedAllocation = {
  tripId: string;
  expenseId: string;
  withdrawalTransactionId: string;
  amountMinor: number;
  currency: string;
  allocations: TripOwnershipAllocationEntry[];
  createdAt: Timestamp;
};

export type ReplayLogicalEventsResult =
  | {
      ok: true;
      ownership: MemberOwnershipBalance[];
      allocations: ReconstructedAllocation[];
    }
  | {ok: false; reason: string};

/**
 * Replays an already-ordered logical-event list, reusing the existing
 * 5B.2 pure primitives for every arithmetic step - this function
 * contains no proportional/BigInt math of its own. Ordinary
 * withdrawal underflow, Shared-Stash depletion insufficiency, and
 * restoration failures all fail closed with the frozen reason codes
 * (§8/§26) rather than clamping, borrowing, or guessing.
 * @param {LogicalEvent[]} ordered The deterministically-ordered
 *   logical-event list (`orderLogicalEvents`'s own output).
 * @param {string} tripId The Trip's own id (threaded into every
 *   reconstructed allocation record).
 * @return {ReplayLogicalEventsResult} The final ownership set and every
 *   reconstructed allocation, or the specific reason replay failed.
 */
export function replayLogicalEvents(
  ordered: LogicalEvent[],
  tripId: string
): ReplayLogicalEventsResult {
  let ownership = new Map<string, number>();
  const allocationsByWithdrawalId = new Map<string, ReconstructedAllocation>();

  for (const event of ordered) {
    if (event.kind === "contribution") {
      const current = ownership.get(event.uid) ?? 0;
      const result = applyMemberContribution(current, event.amountMinor);
      if (!result.ok) {
        return {
          ok: false,
          reason: `safe_integer_overflow: contribution ${event.sourceId} ` +
            `(${result.reason}).`,
        };
      }
      ownership.set(event.uid, result.newOwnershipMinor);
      continue;
    }

    if (event.kind === "withdrawal") {
      const current = ownership.get(event.uid) ?? 0;
      const result = applyMemberWithdrawal(current, event.amountMinor);
      if (!result.ok) {
        if (result.reason === "insufficient_ownership") {
          return {
            ok: false,
            reason: "ownership_underflow_during_replay: withdrawal " +
              `${event.sourceId} exceeds uid "${event.uid}"'s ` +
              "reconstructed-so-far ownership.",
          };
        }
        return {
          ok: false,
          reason: "malformed_transaction_amount: withdrawal " +
            `${event.sourceId} (${result.reason}).`,
        };
      }
      ownership.set(event.uid, result.newOwnershipMinor);
      continue;
    }

    if (event.kind === "shared_stash_expense") {
      if (ownership.size === 0) {
        return {
          ok: false,
          reason: "ownership_underflow_during_replay: Shared-Stash " +
            `Expense ${event.expenseId} occurs before any ownership ` +
            "exists to fund it.",
        };
      }
      const balances: MemberOwnershipBalance[] = [...ownership.entries()].map(
        ([uid, ownershipMinor]) => ({uid, ownershipMinor})
      );
      const applied = applySharedStashDepletion(event.amountMinor, balances);
      if (!applied.ok) {
        return {
          ok: false,
          reason: "ownership_underflow_during_replay: Shared-Stash " +
            `Expense ${event.expenseId} (${applied.reason}).`,
        };
      }
      ownership = new Map(
        applied.resultingOwnership.map((b) => [b.uid, b.ownershipMinor])
      );
      allocationsByWithdrawalId.set(event.withdrawalId, {
        tripId,
        expenseId: event.expenseId,
        withdrawalTransactionId: event.withdrawalId,
        amountMinor: event.amountMinor,
        currency: event.currency,
        allocations: applied.allocations,
        createdAt: event.timestamp,
      });
      continue;
    }

    // event.kind === "shared_stash_reversal"
    const original = allocationsByWithdrawalId.get(event.withdrawalId);
    if (!original) {
      return {
        ok: false,
        reason: "missing_original_withdrawal: reversal of " +
          `${event.withdrawalId} has no recorded original allocation ` +
          "earlier in this same replay.",
      };
    }
    const balances: MemberOwnershipBalance[] = [...ownership.entries()].map(
      ([uid, ownershipMinor]) => ({uid, ownershipMinor})
    );
    if (balances.length === 0) {
      return {
        ok: false,
        reason: "ownership_underflow_during_replay: reversal of " +
          `${event.withdrawalId} has no current ownership rows to ` +
          "restore against.",
      };
    }
    const restored = restoreSharedStashDepletion(balances, {
      amountMinor: original.amountMinor,
      allocations: original.allocations,
    });
    if (!restored.ok) {
      return {
        ok: false,
        reason: `safe_integer_overflow: restoring ${event.withdrawalId} ` +
          `(${restored.reason}).`,
      };
    }
    ownership = new Map(
      restored.resultingOwnership.map((b) => [b.uid, b.ownershipMinor])
    );
    // The original allocation record is NEVER deleted or mutated - it
    // remains the one-and-only companion record for this withdrawal id.
  }

  return {
    ok: true,
    ownership: [...ownership.entries()].map(([uid, ownershipMinor]) => ({
      uid,
      ownershipMinor,
    })),
    allocations: [...allocationsByWithdrawalId.values()],
  };
}

// ---------------------------------------------------------------------
// INDEPENDENT AGGREGATE-LEDGER REPLAY (§15, condition 2) - a second,
// genuinely separate computation from `replayLogicalEvents` above:
// a bare signed running sum over the exact same ordered event list,
// starting from the Trip's own opening balance. This proves the
// *cached* `Trip.ledgerBalanceMinor` itself agrees with the *immutable
// history* it claims to summarize - distinct from, and not a
// substitute for, proving the ownership model's own sum agrees with
// that cached aggregate (`reconcileOwnershipAgainstAggregate`, called
// by the admin tool directly against `replayLogicalEvents`'s output).
// ---------------------------------------------------------------------

export type ReplayAggregateLedgerTotalResult =
  | {ok: true; totalMinor: number}
  | {ok: false; reason: string};

/**
 * Independently replays the Trip's full signed aggregate history -
 * opening balance plus every ordered logical event's own signed
 * amountMinor - using no primitive from `tripOwnershipAccounting.ts`
 * and no data from `replayLogicalEvents`'s own per-member bookkeeping.
 * @param {number} openingBalanceMinor The Trip's own locked opening
 *   balance (already validated as a non-negative safe integer by the
 *   caller's own ledger-bootstrap classification).
 * @param {LogicalEvent[]} ordered The deterministically-ordered
 *   logical-event list (the same list `replayLogicalEvents` consumes).
 * @return {ReplayAggregateLedgerTotalResult} The final aggregate total,
 *   or the specific reason the running sum became unsafe.
 */
export function replayAggregateLedgerTotal(
  openingBalanceMinor: number,
  ordered: LogicalEvent[]
): ReplayAggregateLedgerTotalResult {
  const MAX_SAFE_INTEGER_BIG = BigInt(Number.MAX_SAFE_INTEGER);
  let totalBig = BigInt(openingBalanceMinor);

  for (const event of ordered) {
    let deltaBig: bigint;
    if (
      event.kind === "contribution" ||
      event.kind === "shared_stash_reversal"
    ) {
      deltaBig = BigInt(event.amountMinor);
    } else {
      // "withdrawal" | "shared_stash_expense"
      deltaBig = -BigInt(event.amountMinor);
    }
    totalBig += deltaBig;
    if (totalBig < BigInt(0) || totalBig > MAX_SAFE_INTEGER_BIG) {
      return {
        ok: false,
        reason: "safe_integer_overflow: independent aggregate-ledger " +
          "replay produced an out-of-range running total.",
      };
    }
  }

  return {ok: true, totalMinor: Number(totalBig)};
}
