// Pure Expense-split math (Milestone 4, Checkpoint 4B). No Firestore, no
// Cloud Functions, no UI, no I/O - framework-independent, exactly like
// src/domain/tripSavingsGuidance.ts and src/domain/tripDates.ts. Money is
// always integer MINOR units (cents); every function here either returns
// a normalized, exact allocation or throws a plain Error describing what
// was wrong with the input - it never silently produces financial
// nonsense from malformed input (per the approved architecture audit,
// docs/audits/TRIP_EXPENSES_ARCHITECTURE_AUDIT_2026-09-13.md §7/§14).
//
// This file intentionally has no Firebase/Firestore imports at all, not
// even type-only ones - it operates on plain uid strings and integers,
// leaving the caller (a later checkpoint's trusted callable) responsible
// for attaching expenseId/tripId and persisting the result as real
// ExpenseSplit documents (src/types/domain/expense.ts).
//
// Checkpoint 4C.2A: this file's equal/percentage/custom split math is
// DUPLICATED at functions/src/domain/tripExpenseSplits.ts (a separate
// compiled TypeScript project with no shared import path - the same
// constraint already documented for tripPersonalBucketId in
// src/domain/tripPersonalFund.ts). Keep both in sync manually if this
// ever changes. The trusted recordTripExpense callable
// (functions/src/callables/recordTripExpense.ts) calls its own local
// copy, never this one directly.

// The result of any split calculation - deliberately lighter than the
// persisted ExpenseSplit type (src/types/domain/expense.ts), which also
// carries expenseId/tripId that don't exist yet at calculation time.
// percentageBasisPoints is present only for a percentage split's result.
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

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// Checkpoint 4B.1 §4: sums individually-valid safe integers while
// checking the RUNNING total after every addition, not just the final
// result - a running sum can leave the safe-integer range partway
// through even when every individual addend is independently safe.
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

function assertNoDuplicateUids(uids: string[], context: string): void {
  const seen = new Set<string>();
  for (const uid of uids) {
    if (seen.has(uid)) {
      throw new Error(`${context}: duplicate participant uid "${uid}".`);
    }
    seen.add(uid);
  }
}

function assertNonEmptyUid(uid: unknown, context: string): asserts uid is string {
  if (typeof uid !== "string" || uid.length === 0) {
    throw new Error(`${context}: every participant uid must be a non-empty string.`);
  }
}

// Ascending lexicographic (ordinary JS string) comparison - the same
// "sort by uid, no other tiebreak" convention already established for
// Quick Analysis-adjacent pure helpers in this codebase (e.g. Checkpoint
// 3F.3D's deterministic date/pace formatting). Never input-array order,
// which a caller controls and could vary run-to-run for the same
// logical set of participants.
function byUidAscending(a: { uid: string }, b: { uid: string }): number {
  return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
}

// Equal split (approved architecture audit §7). Divides amountMinor as
// evenly as possible across participantUids, then hands the leftover
// 1-cent-each remainder to the lexicographically-first participants -
// fully deterministic regardless of the input array's own order, since
// the assignment is driven entirely by a fresh sort, not input position.
export function computeEqualSplit(
  amountMinor: number,
  participantUids: string[]
): ExpenseSplitAllocation[] {
  if (!isSafePositiveInteger(amountMinor)) {
    throw new Error("computeEqualSplit: amountMinor must be a positive safe integer.");
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

// Percentage split (approved architecture audit §7, largest-remainder
// correction from the 4A.1 amendment). percentageBasisPoints are integer
// hundredths of a percent (100.00% = 10000) - never a floating-point
// percentage like 33.33, which this function never accepts or produces.
//
// Rounding uses exact integer LARGEST-REMAINDER allocation, not the
// lexicographic-uid rule the equal split above uses: for a percentage
// split, uid order is arbitrary with respect to the percentages
// themselves, so handing the extra cent to whoever has the earliest uid
// (regardless of how close their intended share actually was to earning
// it) would preserve the participants' intended percentages less
// faithfully than crediting whoever's fractional remainder was largest.
// Ties in remainderScore fall back to ascending uid, matching the equal
// split's own tie-break convention.
export function computePercentageSplit(
  amountMinor: number,
  participants: PercentageSplitParticipant[]
): ExpenseSplitAllocation[] {
  if (!isSafePositiveInteger(amountMinor)) {
    throw new Error("computePercentageSplit: amountMinor must be a positive safe integer.");
  }
  if (participants.length === 0) {
    throw new Error("computePercentageSplit: at least one participant is required.");
  }
  participants.forEach((p) => assertNonEmptyUid(p.uid, "computePercentageSplit"));
  assertNoDuplicateUids(
    participants.map((p) => p.uid),
    "computePercentageSplit"
  );

  for (const p of participants) {
    if (!isSafeNonNegativeInteger(p.percentageBasisPoints)) {
      throw new Error(
        `computePercentageSplit: percentageBasisPoints for "${p.uid}" must be a ` +
          "non-negative safe integer (no floating-point percentages)."
      );
    }
  }
  const totalBasisPoints = sumSafeIntegers(
    participants.map((p) => p.percentageBasisPoints),
    "computePercentageSplit"
  );
  if (totalBasisPoints !== 10000) {
    throw new Error(
      `computePercentageSplit: percentageBasisPoints must total exactly 10000 ` +
        `(100.00%), got ${totalBasisPoints}.`
    );
  }

  // Overflow protection (audit §7 / checkpoint 4B §7): amountMinor *
  // percentageBasisPoints must itself stay a safe integer before it's
  // divided - checked per participant, individually, rather than trusting
  // the final baseShare/remainderScore values to "look right." A real
  // expense amount is nowhere near this boundary in practice, but this
  // function never assumes that instead of checking it.
  const computed = participants.map((p) => {
    const numerator = amountMinor * p.percentageBasisPoints;
    if (!Number.isSafeInteger(numerator)) {
      throw new Error(
        `computePercentageSplit: amountMinor * percentageBasisPoints overflowed a ` +
          `safe integer for "${p.uid}" - amountMinor is too large for a percentage split.`
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
    if (a.remainderScore !== b.remainderScore) return b.remainderScore - a.remainderScore;
    return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
  });
  const bonusUids = new Set(byLargestRemainder.slice(0, remainingCents).map((c) => c.uid));

  return computed
    .map((c) => ({
      uid: c.uid,
      amountMinor: c.baseShare + (bonusUids.has(c.uid) ? 1 : 0),
      percentageBasisPoints: c.percentageBasisPoints,
    }))
    .sort(byUidAscending);
}

// Custom split (approved architecture audit §7): the caller supplies an
// exact amountMinor per participant - this is a VALIDATOR/normalizer,
// never a calculator. A mismatched total is always rejected outright,
// even by a single cent - it never silently adjusts any participant's
// amount to force a match, since that would override a value the caller
// explicitly chose.
//
// Zero-share participants are explicitly PERMITTED: a custom split may
// truthfully include a participant at $0 (e.g., someone was part of the
// outing but didn't personally owe anything toward this specific
// expense) - the participant's inclusion itself is the meaningful fact,
// independent of their share being zero. Rejecting a $0 entry would force
// the caller to omit that participant entirely, silently losing the
// "they were included, deliberately, at $0" information.
export function computeCustomSplit(
  amountMinor: number,
  participants: CustomSplitParticipant[]
): ExpenseSplitAllocation[] {
  if (!isSafePositiveInteger(amountMinor)) {
    throw new Error("computeCustomSplit: amountMinor must be a positive safe integer.");
  }
  if (participants.length === 0) {
    throw new Error("computeCustomSplit: at least one participant is required.");
  }
  participants.forEach((p) => assertNonEmptyUid(p.uid, "computeCustomSplit"));
  assertNoDuplicateUids(
    participants.map((p) => p.uid),
    "computeCustomSplit"
  );

  for (const p of participants) {
    if (!isSafeNonNegativeInteger(p.amountMinor)) {
      throw new Error(
        `computeCustomSplit: amountMinor for "${p.uid}" must be a non-negative safe integer.`
      );
    }
  }
  const total = sumSafeIntegers(
    participants.map((p) => p.amountMinor),
    "computeCustomSplit"
  );
  if (total !== amountMinor) {
    throw new Error(
      `computeCustomSplit: custom amounts sum to ${total}, which does not exactly ` +
        `match the expense amountMinor (${amountMinor}). Correct the amounts - a custom ` +
        "split is never auto-adjusted to force a match."
    );
  }

  return participants
    .map((p) => ({ uid: p.uid, amountMinor: p.amountMinor }))
    .sort(byUidAscending);
}

// Checkpoint 4B §9: one canonical entry point so callers never have to
// reproduce the equal/percentage/custom branching themselves. A
// discriminated union on `strategy` makes an invalid strategy/input
// COMBINATION a compile-time error, not just a runtime one - e.g. it is
// simply not expressible to pass `participantUids` alongside
// `strategy: "percentage"`.
export type SplitStrategyInput =
  | { strategy: "equal"; participantUids: string[] }
  | { strategy: "percentage"; participants: PercentageSplitParticipant[] }
  | { strategy: "custom"; participants: CustomSplitParticipant[] };

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
      throw new Error(`computeExpenseSplits: unknown split strategy "${String((exhaustive as { strategy?: unknown }).strategy)}".`);
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
      `computeExpenseSplits: internal invariant violated - allocations summed to ` +
        `${sum}, expected ${amountMinor}.`
    );
  }

  return allocations;
}
