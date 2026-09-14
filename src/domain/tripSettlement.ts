// Pure derived Trip balance engine (Milestone 4, Checkpoint 4B). No
// Firestore, no Cloud Functions, no UI, no I/O - the only imports below
// are `import type` (zero runtime cost, matching this codebase's
// existing convention of importing e.g. `Bucket`/`Trip` types into other
// pure domain files). Consumes already-fetched Expense/ExpenseSplit/
// Settlement records and derives net pairwise balances; it never caches
// or persists a "net balance" anywhere, per the approved architecture
// audit (docs/audits/TRIP_EXPENSES_ARCHITECTURE_AUDIT_2026-09-13.md §8).
//
// Fails loudly on logically malformed input (audit §14) rather than
// silently computing financial nonsense - every check below throws a
// plain, descriptive Error. This is deliberately NOT a general schema-
// validation framework: a later trusted callable (Checkpoint 4C+)
// re-validates everything at the actual write boundary; this engine only
// guards the specific invariants its own math depends on.
import type { Expense, ExpenseSplit, Settlement } from "../types/domain";

export const SUPPORTED_CURRENCY = "USD";

// A single net pairwise obligation - amountMinor is always positive;
// direction is carried entirely by fromUid (owes) / toUid (is owed).
// For any two members, at most one TripBalance is ever returned (never
// two opposing entries for the same pair) - see computeTripBalances.
export type TripBalance = {
  fromUid: string;
  toUid: string;
  amountMinor: number;
};

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// Checkpoint 4B.2 §1/§2: identifiers that affect financial relationships
// (which Expense/Split/Settlement a record belongs to, who owes whom)
// must be real, non-blank strings - an empty or whitespace-only value
// would create a nonsensical balance relationship (e.g. two different
// malformed records both silently keyed under the same "" tripId).
// `.trim().length > 0` decides VALIDITY only - the original untrimmed
// string is never altered, normalized, or written back anywhere; this
// is purely a rejection check, never a silent correction. Ordinary
// Firebase-style uids (alphanumeric, no leading/trailing whitespace) are
// completely unaffected.
function assertNonEmptyId(value: unknown, label: string, context: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `${context}: ${label} must be a non-empty identifier (not blank or whitespace-only).`
    );
  }
}

// Checkpoint 4B.1 §4: sums individually-valid safe integers while
// checking the RUNNING total after every addition, not just the final
// result - a running sum can leave the safe-integer range partway
// through even when every individual addend and the final mathematical
// answer would (in exact arithmetic) both look fine, because the
// intermediate IEEE-754 double has already lost precision by then.
// Fails loudly rather than ever comparing/returning an unsafe sum.
function sumSafeIntegers(values: number[], context: string): number {
  let total = 0;
  for (const value of values) {
    const next = total + value;
    if (!Number.isSafeInteger(next)) {
      throw new Error(`${context}: aggregate sum exceeded the safe integer range.`);
    }
    total = next;
  }
  return total;
}

// MVP currency policy (audit §3/§10, 4A.1): USD only, everywhere. A
// non-USD record is REJECTED outright, never silently ignored or
// converted - computeTripBalances must never net amountMinor values that
// could secretly be in different currencies.
export function assertUsdCurrency(currency: string, context: string): void {
  if (currency !== SUPPORTED_CURRENCY) {
    throw new Error(
      `${context}: currency must be "${SUPPORTED_CURRENCY}" (got "${currency}") - ` +
        "multi-currency is not supported this milestone."
    );
  }
}

// The payerUid/sharedStashTransactionId conditional shape finalized by
// the audit's 4A.1 amendment (audit §1/§3):
//   member_out_of_pocket -> payerUid required, sharedStashTransactionId absent
//   shared_stash         -> payerUid null, sharedStashTransactionId required
// Exported (not just inlined into computeTripBalances) because a later
// trusted callable needs the identical check at the actual write
// boundary - one rule, defined once, reused by both layers.
export function assertValidExpensePaymentShape(
  expense: Pick<Expense, "id" | "payerUid" | "paymentSource" | "sharedStashTransactionId">
): void {
  if (expense.paymentSource === "member_out_of_pocket") {
    // Checkpoint 4B.2 §1/§2: trim-checked, not just length-checked - a
    // whitespace-only payerUid ("   ") is not a meaningful Trip member
    // identifier either.
    if (typeof expense.payerUid !== "string" || expense.payerUid.trim().length === 0) {
      throw new Error(
        `Expense "${expense.id}": paymentSource "member_out_of_pocket" requires a ` +
          "non-empty payerUid."
      );
    }
    // Checkpoint 4B.1 §2: an explicit presence check, not truthiness -
    // `sharedStashTransactionId: ""` is falsy but IS a defined value, and
    // a truthiness check would have silently let it through.
    if (expense.sharedStashTransactionId !== undefined) {
      throw new Error(
        `Expense "${expense.id}": paymentSource "member_out_of_pocket" must not have ` +
          "a sharedStashTransactionId (must be truly absent, not even an empty string)."
      );
    }
    return;
  }
  if (expense.paymentSource === "shared_stash") {
    if (expense.payerUid !== null) {
      throw new Error(
        `Expense "${expense.id}": paymentSource "shared_stash" must have a null ` +
          "payerUid - never fabricate a payer when the fund itself paid."
      );
    }
    // Checkpoint 4B.2 §1/§2: trim-checked - a whitespace-only value is
    // not a real transaction id either.
    if (
      typeof expense.sharedStashTransactionId !== "string" ||
      expense.sharedStashTransactionId.trim().length === 0
    ) {
      throw new Error(
        `Expense "${expense.id}": paymentSource "shared_stash" requires a non-empty ` +
          "sharedStashTransactionId - an Expense may never claim Shared Stash " +
          "funding without a real, already-verified withdrawal behind it."
      );
    }
    return;
  }
  throw new Error(
    `Expense "${expense.id}": unknown paymentSource "${String(
      (expense as { paymentSource: unknown }).paymentSource
    )}".`
  );
}

// Checkpoint 4B §12/§13: derives net pairwise balances directly from
// canonical Expense + ExpenseSplit + Settlement records - never a cached
// "net balance" field anywhere. Scope is DIRECT PAIRWISE netting only
// (audit §8/§13): reciprocal debts between the same two people net down
// to one obligation, but transitive chains (A owes B, B owes C) are
// deliberately NEVER collapsed into "A owes C" - that graph-simplification
// optimization is explicitly out of MVP scope.
//
// Every uid-pair's running net is tracked as one SIGNED number keyed by
// its canonical (lexicographically-ordered) pair, rather than two
// separate non-negative counters - this is what makes "over-settlement
// flips the direction" and "an exact settlement clears the pair down to
// nothing" both fall out of ordinary signed arithmetic, with no special-
// casing and no clamping to zero anywhere.
export function computeTripBalances(
  expenses: Expense[],
  splits: ExpenseSplit[],
  settlements: Settlement[],
  tripId: string
): TripBalance[] {
  assertNonEmptyId(tripId, "tripId", "computeTripBalances");

  // key: "${a}|${b}" with a < b lexicographically.
  // value > 0 -> a owes b; value < 0 -> b owes a; 0 -> fully settled.
  const netByPair = new Map<string, number>();

  function addDebt(ower: string, owedTo: string, amountMinor: number): void {
    if (ower === owedTo) {
      throw new Error(`computeTripBalances: "${ower}" cannot owe themselves.`);
    }
    const [a, b] = ower < owedTo ? [ower, owedTo] : [owedTo, ower];
    const key = `${a}|${b}`;
    const sign = ower === a ? 1 : -1;
    const current = netByPair.get(key) ?? 0;
    const next = current + sign * amountMinor;
    // Checkpoint 4B.1 §4C: each individual debt/settlement amount is
    // already checked safe on its own, but the RUNNING pairwise net
    // (accumulated across every expense and settlement touching this
    // pair) must independently stay a safe integer too - fail loudly
    // rather than ever comparing/returning an unsafe accumulated value.
    if (!Number.isSafeInteger(next)) {
      throw new Error(
        `computeTripBalances: the running balance between "${a}" and "${b}" exceeded ` +
          "the safe integer range."
      );
    }
    netByPair.set(key, next);
  }

  // --- Expenses: validate shape, index by id -------------------------
  const expenseById = new Map<string, Expense>();
  for (const expense of expenses) {
    assertNonEmptyId(expense.id, "id", "computeTripBalances: Expense");
    assertNonEmptyId(expense.tripId, "tripId", `Expense "${expense.id}"`);
    if (expense.tripId !== tripId) {
      throw new Error(
        `computeTripBalances: Expense "${expense.id}" belongs to Trip ` +
          `"${expense.tripId}", not the requested Trip "${tripId}".`
      );
    }
    if (!isSafePositiveInteger(expense.amountMinor)) {
      throw new Error(`computeTripBalances: Expense "${expense.id}" has a malformed amountMinor.`);
    }
    assertUsdCurrency(expense.currency, `Expense "${expense.id}"`);
    assertValidExpensePaymentShape(expense);
    if (expense.status !== "active" && expense.status !== "reversed") {
      throw new Error(`computeTripBalances: Expense "${expense.id}" has an unknown status.`);
    }
    if (expenseById.has(expense.id)) {
      throw new Error(`computeTripBalances: duplicate Expense id "${expense.id}".`);
    }
    expenseById.set(expense.id, expense);
  }

  // --- Splits: validate shape, group by expenseId ---------------------
  const splitsByExpenseId = new Map<string, ExpenseSplit[]>();
  const seenSplitKeys = new Set<string>();
  for (const split of splits) {
    assertNonEmptyId(split.expenseId, "expenseId", "computeTripBalances: ExpenseSplit");
    assertNonEmptyId(split.tripId, "tripId", `ExpenseSplit for expense "${split.expenseId}"`);
    assertNonEmptyId(split.userId, "userId", `ExpenseSplit for expense "${split.expenseId}"`);
    if (split.tripId !== tripId) {
      throw new Error(
        `computeTripBalances: split for user "${split.userId}" on expense ` +
          `"${split.expenseId}" belongs to a different trip.`
      );
    }
    if (!expenseById.has(split.expenseId)) {
      throw new Error(
        `computeTripBalances: split for user "${split.userId}" references nonexistent ` +
          `expense "${split.expenseId}".`
      );
    }
    const dupKey = `${split.expenseId}|${split.userId}`;
    if (seenSplitKeys.has(dupKey)) {
      throw new Error(
        `computeTripBalances: duplicate split for user "${split.userId}" on expense ` +
          `"${split.expenseId}".`
      );
    }
    seenSplitKeys.add(dupKey);
    if (!isSafeNonNegativeInteger(split.amountMinor)) {
      throw new Error(
        `computeTripBalances: split for user "${split.userId}" on expense ` +
          `"${split.expenseId}" has a malformed amountMinor.`
      );
    }
    const list = splitsByExpenseId.get(split.expenseId) ?? [];
    list.push(split);
    splitsByExpenseId.set(split.expenseId, list);
  }

  // --- Expense -> debt accumulation ------------------------------------
  //
  // Checkpoint 4B.1 §1: shape/total validation runs UNCONDITIONALLY,
  // before the reversed-status short-circuit below - a malformed record
  // must never be allowed to hide behind status: "reversed". Only the
  // DEBT CONTRIBUTION step (not validation) is skipped for a reversed
  // Expense.
  for (const expense of expenses) {
    const expenseSplits = splitsByExpenseId.get(expense.id) ?? [];

    // member_out_of_pocket MUST have at least one split - a real payer
    // handed over money and someone owes it back, so a split-less
    // out-of-pocket Expense would silently vanish from the debt graph
    // instead of being the malformed record it actually is.
    // shared_stash MAY have zero splits (the audit leaves reporting-only
    // participant allocations for a Shared-Stash-funded expense
    // unresolved - see docs/audits/.../ §19 item 1) - only validated if
    // present at all.
    if (expense.paymentSource === "member_out_of_pocket" && expenseSplits.length === 0) {
      throw new Error(
        `computeTripBalances: out-of-pocket expense "${expense.id}" has no splits - ` +
          "an out-of-pocket expense must always have at least one ExpenseSplit."
      );
    }

    if (expenseSplits.length > 0) {
      const splitTotal = sumSafeIntegers(
        expenseSplits.map((s) => s.amountMinor),
        `computeTripBalances: splits for expense "${expense.id}"`
      );
      if (splitTotal !== expense.amountMinor) {
        throw new Error(
          `computeTripBalances: splits for expense "${expense.id}" sum to ${splitTotal}, ` +
            `expected ${expense.amountMinor}.`
        );
      }
    }

    if (expense.status === "reversed") continue; // reversed Expenses contribute zero debt

    // shared_stash: the group fund already absorbed the cost - splits
    // may still exist for reporting, but never produce member-to-member
    // debt (there is no payerUid to owe in the first place).
    if (expense.paymentSource !== "member_out_of_pocket") continue;

    const payerUid = expense.payerUid as string; // non-null, guaranteed by assertValidExpensePaymentShape
    for (const split of expenseSplits) {
      if (split.userId === payerUid) continue; // the payer's own share is not self-debt
      if (split.amountMinor === 0) continue; // an intentional $0 share owes nothing
      addDebt(split.userId, payerUid, split.amountMinor);
    }
  }

  // --- Settlements: validate shape, reduce debt ------------------------
  const seenSettlementIds = new Set<string>();
  for (const settlement of settlements) {
    assertNonEmptyId(settlement.id, "id", "computeTripBalances: Settlement");
    assertNonEmptyId(settlement.tripId, "tripId", `Settlement "${settlement.id}"`);
    assertNonEmptyId(settlement.fromUid, "fromUid", `Settlement "${settlement.id}"`);
    assertNonEmptyId(settlement.toUid, "toUid", `Settlement "${settlement.id}"`);
    if (settlement.tripId !== tripId) {
      throw new Error(`computeTripBalances: Settlement "${settlement.id}" belongs to a different trip.`);
    }
    if (seenSettlementIds.has(settlement.id)) {
      throw new Error(`computeTripBalances: duplicate Settlement id "${settlement.id}".`);
    }
    seenSettlementIds.add(settlement.id);
    if (settlement.fromUid === settlement.toUid) {
      throw new Error(`computeTripBalances: Settlement "${settlement.id}" cannot have fromUid === toUid.`);
    }
    if (!isSafePositiveInteger(settlement.amountMinor)) {
      throw new Error(`computeTripBalances: Settlement "${settlement.id}" has a malformed amountMinor.`);
    }
    assertUsdCurrency(settlement.currency, `Settlement "${settlement.id}"`);

    // A settlement REDUCES what fromUid owes toUid - expressed as
    // negative debt in the same direction, so it composes with ordinary
    // expense-derived debt via the identical signed accumulator. If the
    // settlement exceeds the current debt, the net crosses zero and the
    // pair's obligation direction flips - this is never clamped to zero.
    addDebt(settlement.fromUid, settlement.toUid, -settlement.amountMinor);
  }

  // --- Final result: one entry per non-zero pair, deterministically sorted ---
  const nonZeroPairs = [...netByPair.entries()]
    .filter(([, net]) => net !== 0)
    .sort(([keyA], [keyB]) => (keyA < keyB ? -1 : keyA > keyB ? 1 : 0));

  return nonZeroPairs.map(([key, net]) => {
    const [a, b] = key.split("|");
    return net > 0 ? { fromUid: a, toUid: b, amountMinor: net } : { fromUid: b, toUid: a, amountMinor: -net };
  });
}
