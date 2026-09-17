// Checkpoint 4C.2A, per the approved docs/audits/
// TRIP_OUT_OF_POCKET_EXPENSE_PERSISTENCE_PREFLIGHT_2026-09-15.md (as
// hardened by its 4C.1A/4C.1B amendments, §9): a DELIBERATE DUPLICATE of
// the already-frozen, already-tested pure split math in
// src/domain/tripExpenseSplits.ts - not an import. functions/tsconfig.json
// scopes `include` to `functions/src` only, and this repository is not an
// npm/yarn workspace, so there is no path by which this package can import
// application source without either breaking the Cloud Functions build's
// rootDir boundary or restructuring the whole repo into a monorepo. This
// is the identical problem already solved once in this exact codebase for
// `tripPersonalBucketId` (src/domain/tripPersonalFund.ts vs.
// functions/src/callables/createBucket.ts) - same fix, same convention.
//
// IMPORTANT: this file is duplicated at src/domain/tripExpenseSplits.ts
// (a separate compiled TypeScript project with no shared import path).
// Keep both in sync manually if this ever changes. Every behavior below
// must match that file exactly: equal/percentage/custom split math, safe-
// integer validation, duplicate-participant rejection, uid validation,
// equal-split deterministic leftover assignment (lexicographic-uid),
// percentage largest-remainder allocation with uid tie-break, custom
// zero-share permission, exact total validation, and aggregate-overflow
// validation.
import {createHash} from "crypto";

export type ExpenseSplitAllocation = {
  uid: string;
  amountMinor: number;
  percentageBasisPoints?: number;
};

export type PercentageSplitParticipant = {
  uid: string;
  percentageBasisPoints: number;
};

export type CustomSplitParticipant = {
  uid: string;
  amountMinor: number;
};

/**
 * True if value is a positive safe integer.
 * @param {unknown} value The value to check.
 * @return {boolean} True if value is a positive safe integer.
 */
function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * True if value is a non-negative safe integer.
 * @param {unknown} value The value to check.
 * @return {boolean} True if value is a non-negative safe integer.
 */
function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Sums individually-valid safe integers while checking the RUNNING total
 * after every addition, not just the final result - a running sum can
 * leave the safe-integer range partway through even when every individual
 * addend is independently safe. Fails loudly rather than ever comparing/
 * returning an unsafe sum.
 * @param {number[]} values The values to sum.
 * @param {string} context Context string for the thrown error message.
 * @return {number} The exact sum, guaranteed to be a safe integer.
 */
function sumSafeIntegers(values: number[], context: string): number {
  let total = 0;
  for (const value of values) {
    const next = total + value;
    if (!Number.isSafeInteger(next)) {
      throw new Error(
        `${context}: aggregate sum exceeded the safe integer range.`
      );
    }
    total = next;
  }
  return total;
}

/**
 * Throws if any uid appears more than once.
 * @param {string[]} uids The uids to check.
 * @param {string} context Context string for the thrown error message.
 * @return {void}
 */
function assertNoDuplicateUids(uids: string[], context: string): void {
  const seen = new Set<string>();
  for (const uid of uids) {
    if (seen.has(uid)) {
      throw new Error(`${context}: duplicate participant uid "${uid}".`);
    }
    seen.add(uid);
  }
}

/**
 * Throws unless uid is a non-empty string.
 * @param {unknown} uid The value to check.
 * @param {string} context Context string for the thrown error message.
 * @return {void}
 */
function assertNonEmptyUid(
  uid: unknown,
  context: string
): asserts uid is string {
  if (typeof uid !== "string" || uid.length === 0) {
    throw new Error(
      `${context}: every participant uid must be a non-empty string.`
    );
  }
}

/**
 * Ascending lexicographic (ordinary JS string) comparison - the same
 * "sort by uid, no other tiebreak" convention as the root domain module.
 * @param {{uid: string}} a The first participant.
 * @param {{uid: string}} b The second participant.
 * @return {number} A negative, zero, or positive comparison result.
 */
function byUidAscending(a: { uid: string }, b: { uid: string }): number {
  return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
}

/**
 * Equal split. Divides amountMinor as evenly as possible across
 * participantUids, then hands the leftover 1-cent-each remainder to the
 * lexicographically-first participants - fully deterministic regardless
 * of the input array's own order.
 * @param {number} amountMinor The total amount, in integer minor units.
 * @param {string[]} participantUids The participant uids.
 * @return {ExpenseSplitAllocation[]} The computed allocations.
 */
export function computeEqualSplit(
  amountMinor: number,
  participantUids: string[]
): ExpenseSplitAllocation[] {
  if (!isSafePositiveInteger(amountMinor)) {
    throw new Error(
      "computeEqualSplit: amountMinor must be a positive safe integer."
    );
  }
  if (participantUids.length === 0) {
    throw new Error("computeEqualSplit: at least one participant is required.");
  }
  participantUids.forEach((uid) => assertNonEmptyUid(uid, "computeEqualSplit"));
  assertNoDuplicateUids(participantUids, "computeEqualSplit");

  const n = participantUids.length;
  const base = Math.floor(amountMinor / n);
  const remainder = amountMinor - base * n; // 0 <= remainder < n

  const sortedUids = [...participantUids].sort();
  return sortedUids.map((uid, i) => ({
    uid,
    amountMinor: base + (i < remainder ? 1 : 0),
  }));
}

/**
 * Percentage split. percentageBasisPoints are integer hundredths of a
 * percent (100.00% = 10000) - never a floating-point percentage. Rounding
 * uses exact integer LARGEST-REMAINDER allocation, with ties broken by
 * ascending uid.
 * @param {number} amountMinor The total amount, in integer minor units.
 * @param {PercentageSplitParticipant[]} participants The participants.
 * @return {ExpenseSplitAllocation[]} The computed allocations.
 */
export function computePercentageSplit(
  amountMinor: number,
  participants: PercentageSplitParticipant[]
): ExpenseSplitAllocation[] {
  if (!isSafePositiveInteger(amountMinor)) {
    throw new Error(
      "computePercentageSplit: amountMinor must be a positive safe integer."
    );
  }
  if (participants.length === 0) {
    throw new Error(
      "computePercentageSplit: at least one participant is required."
    );
  }
  participants.forEach((p) =>
    assertNonEmptyUid(p.uid, "computePercentageSplit")
  );
  assertNoDuplicateUids(
    participants.map((p) => p.uid),
    "computePercentageSplit"
  );

  for (const p of participants) {
    if (!isSafeNonNegativeInteger(p.percentageBasisPoints)) {
      throw new Error(
        `computePercentageSplit: percentageBasisPoints for "${p.uid}" ` +
          "must be a non-negative safe integer (no floating-point " +
          "percentages)."
      );
    }
  }
  const totalBasisPoints = sumSafeIntegers(
    participants.map((p) => p.percentageBasisPoints),
    "computePercentageSplit"
  );
  if (totalBasisPoints !== 10000) {
    throw new Error(
      "computePercentageSplit: percentageBasisPoints must total " +
        `exactly 10000 (100.00%), got ${totalBasisPoints}.`
    );
  }

  const computed = participants.map((p) => {
    const numerator = amountMinor * p.percentageBasisPoints;
    if (!Number.isSafeInteger(numerator)) {
      throw new Error(
        "computePercentageSplit: amountMinor * percentageBasisPoints " +
          `overflowed a safe integer for "${p.uid}" - amountMinor is ` +
          "too large for a percentage split."
      );
    }
    return {
      uid: p.uid,
      percentageBasisPoints: p.percentageBasisPoints,
      baseShare: Math.floor(numerator / 10000),
      remainderScore: numerator % 10000,
    };
  });

  const totalBaseShare = sumSafeIntegers(
    computed.map((c) => c.baseShare),
    "computePercentageSplit"
  );
  const remainingCents = amountMinor - totalBaseShare;

  const byLargestRemainder = [...computed].sort((a, b) => {
    if (a.remainderScore !== b.remainderScore) {
      return b.remainderScore - a.remainderScore;
    }
    return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
  });
  const bonusUids = new Set(
    byLargestRemainder.slice(0, remainingCents).map((c) => c.uid)
  );

  return computed
    .map((c) => ({
      uid: c.uid,
      amountMinor: c.baseShare + (bonusUids.has(c.uid) ? 1 : 0),
      percentageBasisPoints: c.percentageBasisPoints,
    }))
    .sort(byUidAscending);
}

/**
 * Custom split. The caller supplies an exact amountMinor per participant -
 * this is a validator/normalizer, never a calculator. A mismatched total
 * is always rejected outright, even by a single cent - it never silently
 * adjusts any participant's amount to force a match. Zero-share
 * participants are explicitly permitted.
 * @param {number} amountMinor The total amount, in integer minor units.
 * @param {CustomSplitParticipant[]} participants The participants.
 * @return {ExpenseSplitAllocation[]} The computed allocations.
 */
export function computeCustomSplit(
  amountMinor: number,
  participants: CustomSplitParticipant[]
): ExpenseSplitAllocation[] {
  if (!isSafePositiveInteger(amountMinor)) {
    throw new Error(
      "computeCustomSplit: amountMinor must be a positive safe integer."
    );
  }
  if (participants.length === 0) {
    throw new Error(
      "computeCustomSplit: at least one participant is required."
    );
  }
  participants.forEach((p) =>
    assertNonEmptyUid(p.uid, "computeCustomSplit")
  );
  assertNoDuplicateUids(
    participants.map((p) => p.uid),
    "computeCustomSplit"
  );

  for (const p of participants) {
    if (!isSafeNonNegativeInteger(p.amountMinor)) {
      throw new Error(
        `computeCustomSplit: amountMinor for "${p.uid}" must be a ` +
          "non-negative safe integer."
      );
    }
  }
  const total = sumSafeIntegers(
    participants.map((p) => p.amountMinor),
    "computeCustomSplit"
  );
  if (total !== amountMinor) {
    throw new Error(
      `computeCustomSplit: custom amounts sum to ${total}, which does ` +
        `not exactly match the expense amountMinor (${amountMinor}). ` +
        "Correct the amounts - a custom split is never auto-adjusted " +
        "to force a match."
    );
  }

  return participants
    .map((p) => ({uid: p.uid, amountMinor: p.amountMinor}))
    .sort(byUidAscending);
}

export type SplitStrategyInput =
  | { strategy: "equal"; participantUids: string[] }
  | { strategy: "percentage"; participants: PercentageSplitParticipant[] }
  | { strategy: "custom"; participants: CustomSplitParticipant[] };

/**
 * One canonical entry point so callers never have to reproduce the
 * equal/percentage/custom branching themselves.
 * @param {number} amountMinor The total amount, in integer minor units.
 * @param {SplitStrategyInput} input The split strategy and its inputs.
 * @return {ExpenseSplitAllocation[]} The computed, exactly-summing
 *   allocations.
 */
export function computeExpenseSplits(
  amountMinor: number,
  input: SplitStrategyInput
): ExpenseSplitAllocation[] {
  let allocations: ExpenseSplitAllocation[];
  switch (input.strategy) {
  case "equal":
    allocations = computeEqualSplit(amountMinor, input.participantUids);
    break;
  case "percentage":
    allocations = computePercentageSplit(amountMinor, input.participants);
    break;
  case "custom":
    allocations = computeCustomSplit(amountMinor, input.participants);
    break;
  default: {
    const exhaustive: never = input;
    const badStrategy = (exhaustive as {strategy?: unknown}).strategy;
    throw new Error(
      `computeExpenseSplits: unknown split strategy "${String(badStrategy)}".`
    );
  }
  }

  // Defense-in-depth: every branch above already guarantees this by
  // construction, but the entry point re-asserts the one invariant every
  // caller actually depends on, once, in a single place.
  const sum = sumSafeIntegers(
    allocations.map((a) => a.amountMinor),
    "computeExpenseSplits"
  );
  if (sum !== amountMinor) {
    throw new Error(
      "computeExpenseSplits: internal invariant violated - " +
        `allocations summed to ${sum}, expected ${amountMinor}.`
    );
  }

  return allocations;
}

// Checkpoint 4C.1B (docs/audits/TRIP_OUT_OF_POCKET_EXPENSE_PERSISTENCE_
// PREFLIGHT_2026-09-15.md §5.3): collision-safe deterministic identity for
// a (expenseId, participantUid) pair. This is NOT a second idempotency
// key - tripExpenses/{clientRequestId} plus the creator-bound
// creationRequest comparison (recordTripExpense.ts) remains the sole
// idempotency mechanism. This is only the storage identity used to write
// each ExpenseSplit document.
//
// A raw `${expenseId}_${participantUid}` concatenation is NOT collision-
// safe: expenseId is `clientRequestId`, matched only by
// `[A-Za-z0-9_-]{1,128}` (underscores permitted), so
// expenseId="abc_def"+participantUid="ghi" and
// expenseId="abc"+participantUid="def_ghi" would both concatenate to
// "abc_def_ghi". Hashing the JSON-array-serialized pair instead removes
// the ambiguity by construction: JSON array serialization unambiguously
// delimits each element with quoting and a comma that the two raw strings
// can never spoof into a matching byte sequence for two distinct pairs.
/**
 * Deterministic, collision-safe document id for a single ExpenseSplit,
 * derived from the (expenseId, participantUid) pair. Pure and stateless -
 * no randomness, no counter - so it is safe to compute multiple times
 * (including across Firestore's own automatic transaction retries) and
 * always land on the same write target.
 * @param {string} expenseId The parent Expense's document id
 *   (== clientRequestId).
 * @param {string} participantUid The split participant's uid.
 * @return {string} A lowercase-hex SHA-256 digest, safe to use as a
 *   Firestore document id.
 */
export function splitDocumentId(
  expenseId: string,
  participantUid: string
): string {
  return createHash("sha256")
    .update(JSON.stringify([expenseId, participantUid]), "utf8")
    .digest("hex");
}
