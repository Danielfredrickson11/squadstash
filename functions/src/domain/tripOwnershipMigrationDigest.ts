// Checkpoint 5B.4B, per the frozen docs/audits/
// TRIP_WALLET_OWNERSHIP_MIGRATION_PREFLIGHT_2026-10-10.md §16A. Pure,
// deterministic canonical-projection + SHA-256 digest primitives - no
// Firestore I/O in this file. Never hashes a raw Firestore
// DocumentSnapshot/DocumentData object directly; every projection
// object below is built field-by-field, in a fixed, explicit key
// order, specifically so serialization is stable across Node.js
// versions/processes and never depends on whatever order Firestore
// happens to return fields in.
import {createHash} from "crypto";
import type {Timestamp} from "firebase-admin/firestore";
import type {MemberOwnershipBalance} from "./tripOwnershipAccounting";
import type {TripOwnershipAllocationEntry} from "./tripOwnershipAllocation";

export type DigestResult = {hash: string; count: number};

/**
 * Minimal raw `savingsTransactions` shape the digest needs - every
 * replay-relevant identity/economic/linkage field (§16A).
 */
export type DigestSavingsTransactionInput = {
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

/**
 * Minimal raw `tripExpenses` shape the digest needs.
 */
export type DigestExpenseInput = {
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
  replacesExpenseId: string | null;
  replacedByExpenseId: string | null;
};

type CanonicalSavingsTransactionProjection = {
  id: string;
  resourceType: string;
  resourceId: string;
  memberUid: string;
  type: string;
  amountMinor: number;
  currency: string;
  createdAtSeconds: number;
  createdAtNanoseconds: number;
  reversalOf: string | null;
  linkedExpenseId: string | null;
};

type CanonicalExpenseProjection = {
  id: string;
  tripId: string;
  paymentSource: string;
  amountMinor: number;
  currency: string;
  sharedStashTransactionId: string | null;
  status: string;
  createdAtSeconds: number;
  createdAtNanoseconds: number;
  reversedAtSeconds: number | null;
  reversedAtNanoseconds: number | null;
  refundTransactionId: string | null;
  replacesExpenseId: string | null;
  replacedByExpenseId: string | null;
};

/**
 * Builds the canonical, fixed-key-order projection of one
 * `savingsTransactions` document.
 * @param {DigestSavingsTransactionInput} tx The raw transaction.
 * @return {CanonicalSavingsTransactionProjection} The canonical
 *   projection.
 */
function canonicalizeSavingsTransaction(
  tx: DigestSavingsTransactionInput
): CanonicalSavingsTransactionProjection {
  return {
    id: tx.id,
    resourceType: tx.resourceType,
    resourceId: tx.resourceId,
    memberUid: tx.memberUid,
    type: tx.type,
    amountMinor: tx.amountMinor,
    currency: tx.currency,
    createdAtSeconds: tx.createdAt.seconds,
    createdAtNanoseconds: tx.createdAt.nanoseconds,
    reversalOf: tx.reversalOf,
    linkedExpenseId: tx.linkedExpenseId,
  };
}

/**
 * Builds the canonical, fixed-key-order projection of one
 * `tripExpenses` document.
 * @param {DigestExpenseInput} expense The raw Expense.
 * @return {CanonicalExpenseProjection} The canonical projection.
 */
function canonicalizeExpense(
  expense: DigestExpenseInput
): CanonicalExpenseProjection {
  return {
    id: expense.id,
    tripId: expense.tripId,
    paymentSource: expense.paymentSource,
    amountMinor: expense.amountMinor,
    currency: expense.currency,
    sharedStashTransactionId: expense.sharedStashTransactionId,
    status: expense.status,
    createdAtSeconds: expense.createdAt.seconds,
    createdAtNanoseconds: expense.createdAt.nanoseconds,
    reversedAtSeconds: expense.reversedAt?.seconds ?? null,
    reversedAtNanoseconds: expense.reversedAt?.nanoseconds ?? null,
    refundTransactionId: expense.refundTransactionId,
    replacesExpenseId: expense.replacesExpenseId,
    replacedByExpenseId: expense.replacedByExpenseId,
  };
}

/**
 * Ascending lexicographic comparison by `id` - the fixed sort order
 * every digest input is normalized to before hashing, so the digest
 * never depends on the order documents were fetched/iterated in, and
 * deliberately never sorts by `createdAt` (the very field the digest
 * exists to protect).
 * @param {{id: string}} a The first item.
 * @param {{id: string}} b The second item.
 * @return {number} A standard comparator result.
 */
function byIdAscending(a: {id: string}, b: {id: string}): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Computes the canonical source-history digest over the complete,
 * already-loaded `savingsTransactions`/`tripExpenses` set for one Trip
 * (§16A). Deterministic regardless of input array order.
 * @param {DigestSavingsTransactionInput[]} transactions Every
 *   `savingsTransactions` document for the Trip.
 * @param {DigestExpenseInput[]} expenses Every `tripExpenses` document
 *   for the Trip (including `"member_out_of_pocket"` ones, fetched
 *   incidentally - their presence/identity still matters for the
 *   digest/count even though they carry no ownership-arithmetic role).
 * @return {DigestResult} The hex SHA-256 digest and total document
 *   count (both collections combined).
 */
export function computeSourceHistoryDigest(
  transactions: DigestSavingsTransactionInput[],
  expenses: DigestExpenseInput[]
): DigestResult {
  const txProjections = transactions
    .map(canonicalizeSavingsTransaction)
    .sort(byIdAscending);
  const expenseProjections = expenses
    .map(canonicalizeExpense)
    .sort(byIdAscending);
  const serialized =
    JSON.stringify(txProjections) + "|" + JSON.stringify(expenseProjections);
  const hash = createHash("sha256").update(serialized, "utf8").digest("hex");
  return {hash, count: transactions.length + expenses.length};
}

/**
 * Computes the canonical expected-ownership digest (§16A/item 7) -
 * economic identity only (`uid`/`ownershipMinor`), deliberately
 * excluding operational metadata like `lastUpdatedAt` so a legitimate
 * timestamp-only rewrite never changes this digest.
 * @param {MemberOwnershipBalance[]} balances The expected ownership
 *   output set.
 * @return {DigestResult} The hex SHA-256 digest and row count.
 */
export function computeOwnershipDigest(
  balances: MemberOwnershipBalance[]
): DigestResult {
  const sorted = [...balances]
    .map((b) => ({uid: b.uid, ownershipMinor: b.ownershipMinor}))
    .sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
  const hash = createHash("sha256")
    .update(JSON.stringify(sorted), "utf8")
    .digest("hex");
  return {hash, count: sorted.length};
}

/**
 * The immutable economic fields of one expected allocation output -
 * everything the digest covers, deliberately excluding `migratedAt`
 * (always legitimately fresh on every rerun, §19).
 */
export type AllocationEconomicProjection = {
  id: string;
  tripId: string;
  expenseId: string;
  withdrawalTransactionId: string;
  amountMinor: number;
  currency: string;
  allocations: TripOwnershipAllocationEntry[];
  provenance: string;
  createdAt: Timestamp;
};

/**
 * Computes the canonical expected-allocation digest (§16A/item 7) over
 * every allocation record's immutable economic fields only.
 * @param {AllocationEconomicProjection[]} allocations The expected
 *   allocation output set.
 * @return {DigestResult} The hex SHA-256 digest and record count.
 */
export function computeAllocationDigest(
  allocations: AllocationEconomicProjection[]
): DigestResult {
  const sorted = [...allocations]
    .map((a) => ({
      id: a.id,
      tripId: a.tripId,
      expenseId: a.expenseId,
      withdrawalTransactionId: a.withdrawalTransactionId,
      amountMinor: a.amountMinor,
      currency: a.currency,
      allocations: a.allocations,
      provenance: a.provenance,
      createdAtSeconds: a.createdAt.seconds,
      createdAtNanoseconds: a.createdAt.nanoseconds,
    }))
    .sort(byIdAscending);
  const hash = createHash("sha256")
    .update(JSON.stringify(sorted), "utf8")
    .digest("hex");
  return {hash, count: sorted.length};
}
