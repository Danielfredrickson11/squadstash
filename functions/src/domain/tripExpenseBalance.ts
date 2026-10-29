// Checkpoint 6.7A: pure, deterministic signed-delta math for the social
// tripExpenseBalances aggregate - no Firestore/HttpsError imports, no
// side effects, mirroring tripOwnershipAccounting.ts's own "pure math in
// the domain module, Firestore reads/writes stay in the callable or the
// dedicated store helper" convention. This module never decides whether
// it is SAFE to apply a delta (expense-balance-model state, Trip
// archive state, authorization) - it only computes the delta itself.
//
// Sign convention (confirmed against src/domain/tripSettlement.ts's own
// computeTripBalances): positive netBalanceMinor means a member is net
// OWED money; negative means they net OWE money. For an Expense: the
// payer is credited the full amount, then every split participant
// (including the payer, if they are also a participant) is debited
// their own split share - the payer may be one of the split
// participants, and this module collapses that into exactly ONE net
// delta per uid, never two separate entries. For a Settlement: fromUid
// (the payer in real life) is credited (their debt shrinks toward 0);
// toUid (the recipient) is debited (what they were owed shrinks toward
// 0).
export type NormalizedBalanceDelta = {uid: string; deltaMinor: number};

export type BalanceDeltaResult =
  | {ok: true; deltas: NormalizedBalanceDelta[]}
  | {ok: false; reason: string};

// A single signed per-uid amount BEFORE combination (positive = credit,
// negative = debit) - named so JSDoc @param tags below can reference it
// directly, rather than repeating an inline object type (which the
// valid-jsdoc ESLint rule cannot parse).
type BalanceEntry = {uid: string; amountMinor: number};

/**
 * Accumulates a list of signed per-uid entries into exactly one net
 * delta per distinct uid, verifying every intermediate/final value is a
 * safe integer and that the final delta set sums to exactly 0 (the
 * mathematical invariant every well-formed expense/settlement delta set
 * must satisfy - see this file's own header comment). Never silently
 * repairs a malformed entry - any structural problem fails the whole
 * computation closed.
 * @param {BalanceEntry[]} entries Signed per-uid amounts (positive =
 *   credit, negative = debit) - NOT yet combined by uid.
 * @return {BalanceDeltaResult} The combined, zero-summing deltas, or the
 *   specific reason the input could not be safely combined.
 */
function accumulateDeltas(entries: BalanceEntry[]): BalanceDeltaResult {
  const map = new Map<string, number>();
  for (const entry of entries) {
    if (typeof entry.uid !== "string" || entry.uid.length === 0) {
      return {ok: false, reason: "Malformed uid in balance delta input."};
    }
    if (!Number.isSafeInteger(entry.amountMinor)) {
      return {
        ok: false,
        reason: `Non-safe-integer amount for uid "${entry.uid}".`,
      };
    }
    const prev = map.get(entry.uid) ?? 0;
    const next = prev + entry.amountMinor;
    if (!Number.isSafeInteger(next)) {
      return {
        ok: false,
        reason:
          `Balance delta overflow combining entries for uid "${entry.uid}".`,
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
    if (!Number.isSafeInteger(sum)) {
      return {ok: false, reason: "Balance delta sum overflow."};
    }
  }
  if (sum !== 0) {
    return {
      ok: false,
      reason: `Balance deltas do not sum to zero (sum=${sum}).`,
    };
  }

  return {ok: true, deltas};
}

/**
 * Computes the normalized, per-uid-combined social-balance deltas for a
 * new Expense: the payer is credited `amountMinor`; every split
 * participant is debited their own `amountMinor`. The payer may also be
 * one of the split participants - this is collapsed into exactly one
 * net delta per uid (e.g. payer pays 100, split 40/60 between
 * payer/other -> payer +60, other -60 - never {payer: +100, payer: -40,
 * other: -60} as three separate entries).
 *
 * Checkpoint 6.7A Final Financial Parity Review: a split's own
 * `amountMinor` may legitimately be exactly 0 (a custom split's
 * intentional $0 share, a 0% percentage participant, or an equal split
 * where the participant count exceeds the number of available cents -
 * see src/domain/tripExpenseSplits.ts's own `isSafeNonNegativeInteger`
 * convention, and src/domain/tripSettlement.ts's own
 * `isSafeNonNegativeInteger`-gated split check). A zero-share
 * participant is never discarded here - it is still pushed into
 * `entries` and therefore still appears as its own explicit delta
 * (0, unless combined with another entry for the same uid, e.g. the
 * payer also being a zero-share participant), matching this aggregate's
 * own frozen explicit-zero-row policy. Only a NEGATIVE split amount is
 * ever rejected.
 * @param {string} payerUid The Expense's payer.
 * @param {number} amountMinor The Expense's total amount (positive safe
 *   integer).
 * @param {BalanceEntry[]} splits The Expense's own immutable, already-
 *   persisted split allocations (never recomputed from current input -
 *   always the stored evidence).
 * @return {BalanceDeltaResult} The combined, zero-summing deltas.
 */
export function computeExpenseBalanceDeltas(
  payerUid: string,
  amountMinor: number,
  splits: BalanceEntry[]
): BalanceDeltaResult {
  if (typeof payerUid !== "string" || payerUid.length === 0) {
    return {ok: false, reason: "payerUid must be a non-empty string."};
  }
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    return {
      ok: false,
      reason: "amountMinor must be a positive safe integer.",
    };
  }
  if (!Array.isArray(splits) || splits.length === 0) {
    return {ok: false, reason: "splits must be a non-empty array."};
  }

  const entries: BalanceEntry[] = [{uid: payerUid, amountMinor}];
  for (const split of splits) {
    if (typeof split.uid !== "string" || split.uid.length === 0) {
      return {ok: false, reason: "Malformed split uid."};
    }
    if (!Number.isSafeInteger(split.amountMinor) || split.amountMinor < 0) {
      return {
        ok: false,
        reason: `Malformed split amount for uid "${split.uid}".`,
      };
    }
    entries.push({uid: split.uid, amountMinor: -split.amountMinor});
  }

  return accumulateDeltas(entries);
}

/**
 * Computes the normalized social-balance deltas for a new Settlement:
 * fromUid (who paid in real life) is credited `amountMinor` (their debt
 * shrinks); toUid (the recipient) is debited `amountMinor` (what they
 * were owed shrinks).
 * @param {string} fromUid The Settlement's payer.
 * @param {string} toUid The Settlement's recipient.
 * @param {number} amountMinor The Settlement's amount (positive safe
 *   integer).
 * @return {BalanceDeltaResult} The combined, zero-summing deltas
 *   (always exactly two entries, since fromUid !== toUid is already
 *   enforced by the callable's own input validation).
 */
export function computeSettlementBalanceDeltas(
  fromUid: string,
  toUid: string,
  amountMinor: number
): BalanceDeltaResult {
  if (typeof fromUid !== "string" || fromUid.length === 0) {
    return {ok: false, reason: "fromUid must be a non-empty string."};
  }
  if (typeof toUid !== "string" || toUid.length === 0) {
    return {ok: false, reason: "toUid must be a non-empty string."};
  }
  if (fromUid === toUid) {
    return {ok: false, reason: "fromUid and toUid must differ."};
  }
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    return {
      ok: false,
      reason: "amountMinor must be a positive safe integer.",
    };
  }

  return accumulateDeltas([
    {uid: fromUid, amountMinor},
    {uid: toUid, amountMinor: -amountMinor},
  ]);
}

/**
 * Inverts an already-computed delta set for a reversal - never
 * reimplements the forward formula. A reversal's effect on the social
 * ledger is always exactly the negation of whatever the original
 * creation applied.
 * @param {NormalizedBalanceDelta[]} deltas The original, forward deltas.
 * @return {NormalizedBalanceDelta[]} The exact inverse deltas.
 */
export function invertBalanceDeltas(
  deltas: NormalizedBalanceDelta[]
): NormalizedBalanceDelta[] {
  return deltas.map((d) => ({uid: d.uid, deltaMinor: -d.deltaMinor}));
}
