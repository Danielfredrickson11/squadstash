// Checkpoint 5B.2: pure Trip Shared-Stash ownership accounting
// primitives, per docs/audits/
// TRIP_WALLET_OWNERSHIP_WITHDRAWAL_PREFLIGHT_2026-10-08.md §9-§13 (the
// frozen Model A: contribution ownership with proportional, exact,
// current-ownership pooled-spend depletion, and exact-allocation
// restoration on reversal). No Firestore/FieldValue/Admin-SDK access in
// this file - mirrors savingsLedger.ts's own "pure interpretation only"
// convention exactly, and (like that file) prefers structured result
// objects over throwing, so a future trusted callable (5B.3) can map
// each failure onto its own exact HttpsError code/message rather than
// trusting this module's own wording.
//
// NOT wired into any trusted financial callable yet (that is explicitly
// 5B.3's job). This checkpoint creates/mutates nothing in Firestore,
// enforces nothing in production, and does not implement migration
// (5B.4) - it only proves the math is correct in isolation.
//
// All multiplication/division/remainder arithmetic that could plausibly
// overflow a safe-integer `Number` (specifically, the proportional
// depletion's `expenseAmountMinor * ownershipMinor` numerator) is
// performed in `BigInt`, exactly as the preflight's §9 (as hardened by
// Amendment 5B.0A, item 6) requires - converting back to `Number` only
// for a final, individually-bounded value, with an explicit safe-
// integer re-assertion at that boundary. No floating point appears
// anywhere in this file.
import type {TripOwnershipAllocationEntry} from "./tripOwnershipAllocation";
import {
  validateTripOwnershipAllocationEntries,
} from "./tripOwnershipAllocation";

// ---------------------------------------------------------------------
// SHARED PRIMITIVES
// ---------------------------------------------------------------------

export type MemberOwnershipBalance = {
  uid: string;
  ownershipMinor: number;
};

const MAX_SAFE_INTEGER_BIG = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * True if `value` is a non-negative safe integer.
 * @param {unknown} value The candidate value.
 * @return {boolean} True if value is a non-negative safe integer.
 */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * True if `value` is a positive (never zero) safe integer.
 * @param {unknown} value The candidate value.
 * @return {boolean} True if value is a positive safe integer.
 */
function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

/**
 * Ascending lexicographic (ordinary JS string) comparison - the same
 * "sort by uid, no other tiebreak" convention already established
 * throughout this project (e.g. tripExpenseSplits.ts's byUidAscending).
 * @param {string} a The first uid.
 * @param {string} b The second uid.
 * @return {number} A standard comparator result.
 */
function byUidAscending(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export type ValidateMemberOwnershipBalancesResult =
  | {ok: true; balances: MemberOwnershipBalance[]}
  | {ok: false; reason: string};

/**
 * Validates and canonically normalizes an ownership-balance set: a
 * non-empty array, every entry a well-formed {uid, ownershipMinor} pair
 * (uid non-empty, ownershipMinor a non-negative safe integer), no
 * duplicate uid (fails closed rather than silently combining
 * duplicates), with the RETURNED array always sorted ascending by uid -
 * deterministic and independent of the caller's own input order.
 *
 * Deliberately does NOT require the caller's input to already be
 * sorted (item 2's own instruction) - this is an in-memory, ephemeral
 * input to a pure function, not the persisted, append-only
 * `tripOwnershipAllocations` record 5B.1A's canonical-ordering
 * requirement governs; normalizing here, rather than rejecting
 * unsorted input, is the correct choice for this different context.
 * @param {unknown} input The candidate ownership-balance array.
 * @return {ValidateMemberOwnershipBalancesResult} The canonically
 *   sorted, validated balances, or the specific reason validation
 *   failed.
 */
export function validateAndNormalizeMemberOwnershipBalances(
  input: unknown
): ValidateMemberOwnershipBalancesResult {
  if (!Array.isArray(input) || input.length === 0) {
    return {ok: false, reason: "ownership balances must be a non-empty array."};
  }

  const seenUids = new Set<string>();
  const normalized: MemberOwnershipBalance[] = [];
  for (const entry of input) {
    if (typeof entry !== "object" || entry === null) {
      return {ok: false, reason: "Every ownership balance must be an object."};
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.uid !== "string" || e.uid.length === 0) {
      return {
        ok: false,
        reason: "Every ownership balance must have a non-empty uid.",
      };
    }
    if (seenUids.has(e.uid)) {
      return {ok: false, reason: `Duplicate ownership uid "${e.uid}".`};
    }
    seenUids.add(e.uid);

    if (!isNonNegativeSafeInteger(e.ownershipMinor)) {
      return {
        ok: false,
        reason: `Ownership balance for "${e.uid}" must be a non-negative ` +
          "safe integer.",
      };
    }
    normalized.push({uid: e.uid, ownershipMinor: e.ownershipMinor});
  }

  normalized.sort((a, b) => byUidAscending(a.uid, b.uid));
  return {ok: true, balances: normalized};
}

// ---------------------------------------------------------------------
// OWNERSHIP SUM
// ---------------------------------------------------------------------

export type OwnershipSumResult =
  | {ok: true; totalMinor: number}
  | {ok: false; reason: string};

/**
 * Computes the exact sum of a validated ownership-balance set's
 * `ownershipMinor` values, in `BigInt` throughout (no overflow possible
 * regardless of how many members or how large any individual balance
 * is), converting back to `Number` only after confirming the total
 * itself is still a safe integer.
 * @param {unknown} input The candidate ownership-balance array.
 * @return {OwnershipSumResult} The exact total, or the specific reason
 *   the input was invalid or the total itself unsafe.
 */
export function sumOwnershipMinor(input: unknown): OwnershipSumResult {
  const validated = validateAndNormalizeMemberOwnershipBalances(input);
  if (!validated.ok) {
    return {ok: false, reason: validated.reason};
  }

  let totalBig = BigInt(0);
  for (const balance of validated.balances) {
    totalBig += BigInt(balance.ownershipMinor);
  }

  if (totalBig > MAX_SAFE_INTEGER_BIG) {
    return {
      ok: false,
      reason: "Total ownership exceeded the safe integer range.",
    };
  }

  return {ok: true, totalMinor: Number(totalBig)};
}

// ---------------------------------------------------------------------
// MEMBER CONTRIBUTION TRANSITION
// ---------------------------------------------------------------------

export type MemberContributionTransitionResult =
  | {ok: true; newOwnershipMinor: number}
  | {
      ok: false;
      reason: "invalid_current_ownership" | "invalid_amount" |
        "unsafe_result";
    };

/**
 * Applies a single member's contribution to their own current
 * ownership: `newOwnership = currentOwnership + amountMinor`. Pure,
 * single-member, no aggregate/cross-member effect whatsoever (item 4) -
 * never mutates its inputs (both are primitive numbers, so there is
 * nothing to mutate in practice, but the function never relies on or
 * produces any shared mutable state either way). Addition is performed
 * in `BigInt` since two large safe integers can sum to an unsafe
 * result - a real overflow risk this function must catch, unlike
 * withdrawal's subtraction (see applyMemberWithdrawal's own comment).
 * @param {unknown} currentOwnershipMinor The member's ownership before
 *   this contribution.
 * @param {unknown} amountMinor The contribution amount.
 * @return {MemberContributionTransitionResult} The new ownership, or
 *   the specific reason the transition was rejected.
 */
export function applyMemberContribution(
  currentOwnershipMinor: unknown,
  amountMinor: unknown
): MemberContributionTransitionResult {
  if (!isNonNegativeSafeInteger(currentOwnershipMinor)) {
    return {ok: false, reason: "invalid_current_ownership"};
  }
  if (!isPositiveSafeInteger(amountMinor)) {
    return {ok: false, reason: "invalid_amount"};
  }

  const newBig = BigInt(currentOwnershipMinor) + BigInt(amountMinor);
  if (newBig > MAX_SAFE_INTEGER_BIG) {
    return {ok: false, reason: "unsafe_result"};
  }

  return {ok: true, newOwnershipMinor: Number(newBig)};
}

// ---------------------------------------------------------------------
// MEMBER WITHDRAWAL CEILING + TRANSITION
// ---------------------------------------------------------------------

export type MemberWithdrawalTransitionResult =
  | {ok: true; newOwnershipMinor: number}
  | {
      ok: false;
      reason: "invalid_current_ownership" | "invalid_amount" |
        "insufficient_ownership";
    };

/**
 * Applies a single member's personal withdrawal against their OWN
 * current ownership only - the frozen ceiling invariant: `amountMinor
 * <= currentOwnershipMinor`. A member may never withdraw another
 * member's ownership; this primitive has no visibility into any other
 * member's balance at all, structurally (it only ever receives one
 * member's own number). Deliberately does NOT perform the existing
 * aggregate Trip-balance check - that remains a separate, independent
 * defense-in-depth check 5B.3 applies on top of this (preflight §11).
 * Subtraction is plain `Number` arithmetic, not `BigInt` - safe by
 * construction, since the ceiling check already guarantees the result
 * is between `0` and `currentOwnershipMinor` (itself already a
 * validated safe integer), so no overflow is possible.
 * @param {unknown} currentOwnershipMinor The member's ownership before
 *   this withdrawal.
 * @param {unknown} amountMinor The requested withdrawal amount.
 * @return {MemberWithdrawalTransitionResult} The new ownership, or the
 *   specific reason the withdrawal was rejected.
 */
export function applyMemberWithdrawal(
  currentOwnershipMinor: unknown,
  amountMinor: unknown
): MemberWithdrawalTransitionResult {
  if (!isNonNegativeSafeInteger(currentOwnershipMinor)) {
    return {ok: false, reason: "invalid_current_ownership"};
  }
  if (!isPositiveSafeInteger(amountMinor)) {
    return {ok: false, reason: "invalid_amount"};
  }
  if (amountMinor > currentOwnershipMinor) {
    return {ok: false, reason: "insufficient_ownership"};
  }

  return {ok: true, newOwnershipMinor: currentOwnershipMinor - amountMinor};
}

// ---------------------------------------------------------------------
// SHARED-STASH PROPORTIONAL DEPLETION (the frozen Model A algorithm)
// ---------------------------------------------------------------------

export type SharedStashDepletionResult =
  | {ok: true; allocations: TripOwnershipAllocationEntry[]}
  | {ok: false; reason: string};

type ComputedParticipant = {
  uid: string;
  ownershipMinor: number;
  baseShareBig: bigint;
  remainderBig: bigint;
};

/**
 * Computes the exact, deterministic proportional-depletion allocation
 * for a Shared-Stash Expense, per the preflight's §9 algorithm -
 * directly generalizing `computePercentageSplit`'s own proven
 * largest-remainder method (ownership balance stands in for percentage
 * basis points). Every multiplication/division/remainder is computed
 * in `BigInt` - `expenseAmountMinor * ownershipMinor` can exceed
 * `Number.MAX_SAFE_INTEGER` even when both operands are individually
 * safe (Checkpoint 5B.2, item 16), so this can never be plain `Number`
 * arithmetic.
 *
 * Only members with POSITIVE current ownership participate (preflight
 * §9/§11) - a zero-ownership member receives no allocation entry and
 * can never win a residual-cent tie-break. The returned array contains
 * ONLY non-zero entries, in canonical STRICTLY ASCENDING uid order
 * (5B.1A's own frozen persisted-record requirement) - this output is
 * directly acceptable to `validateTripOwnershipAllocationEntries`
 * without any further transformation.
 * @param {unknown} expenseAmountMinor The Shared-Stash Expense's own
 *   amount.
 * @param {unknown} ownershipBalances The ownership-balance set
 *   immediately before this expense.
 * @return {SharedStashDepletionResult} The canonical allocation, or the
 *   specific reason the expense could not be allocated.
 */
export function computeSharedStashDepletionAllocation(
  expenseAmountMinor: unknown,
  ownershipBalances: unknown
): SharedStashDepletionResult {
  if (!isPositiveSafeInteger(expenseAmountMinor)) {
    return {
      ok: false,
      reason: "expenseAmountMinor must be a positive safe integer.",
    };
  }

  const validated = validateAndNormalizeMemberOwnershipBalances(
    ownershipBalances
  );
  if (!validated.ok) {
    return {ok: false, reason: validated.reason};
  }

  const participants = validated.balances.filter(
    (b) => b.ownershipMinor > 0
  );
  if (participants.length === 0) {
    return {
      ok: false,
      reason: "No member has positive ownership - a Shared-Stash expense " +
        "cannot be funded.",
    };
  }

  const amountBig = BigInt(expenseAmountMinor);
  let totalOwnershipBig = BigInt(0);
  for (const p of participants) {
    totalOwnershipBig += BigInt(p.ownershipMinor);
  }

  if (amountBig > totalOwnershipBig) {
    return {
      ok: false,
      reason: "expenseAmountMinor exceeds total ownership - insufficient " +
        "Shared Stash ownership to fund this expense.",
    };
  }

  const computed: ComputedParticipant[] = participants.map((p) => {
    const ownershipBig = BigInt(p.ownershipMinor);
    // Exact BigInt multiplication - no overflow possible at any
    // magnitude, unlike the equivalent Number multiplication.
    const numeratorBig = amountBig * ownershipBig;
    return {
      uid: p.uid,
      ownershipMinor: p.ownershipMinor,
      baseShareBig: numeratorBig / totalOwnershipBig,
      remainderBig: numeratorBig % totalOwnershipBig,
    };
  });

  let totalBaseBig = BigInt(0);
  for (const c of computed) {
    totalBaseBig += c.baseShareBig;
  }
  // Provably 0 <= remainingCentsBig < participants.length, by the same
  // reasoning computePercentageSplit's own remainder logic relies on.
  const remainingCentsBig = amountBig - totalBaseBig;

  const byLargestRemainder = [...computed].sort((a, b) => {
    if (a.remainderBig !== b.remainderBig) {
      return a.remainderBig > b.remainderBig ? -1 : 1;
    }
    return byUidAscending(a.uid, b.uid);
  });
  const remainingCentsCount = Number(remainingCentsBig);
  const bonusUids = new Set(
    byLargestRemainder.slice(0, remainingCentsCount).map((c) => c.uid)
  );

  const allocations: TripOwnershipAllocationEntry[] = [];
  for (const c of computed) {
    const deltaBig =
      c.baseShareBig + (bonusUids.has(c.uid) ? BigInt(1) : BigInt(0));
    if (deltaBig === BigInt(0)) {
      // Never emit a zero-valued entry (item 8) - a participant whose
      // own proportional share rounds all the way down to zero and did
      // not win a residual cent simply has no allocation this time.
      continue;
    }
    // Defense-in-depth only: provably unreachable (a participant's own
    // delta can never exceed their own ownershipMinor - see this
    // module's own test suite for the worked proof), kept exactly per
    // this project's established "never assume, always verify at the
    // boundary" discipline (e.g. computeExpenseSplits's own final
    // invariant re-check).
    if (deltaBig > BigInt(c.ownershipMinor)) {
      return {
        ok: false,
        reason: `Internal invariant violated - allocation for "${c.uid}" ` +
          "would exceed their own ownership.",
      };
    }
    allocations.push({uid: c.uid, amountMinor: Number(deltaBig)});
  }

  // Checkpoint 5B.2A, item 5: final allocation invariant re-check -
  // never rely solely on the math above having been correct. Reusing
  // the existing 5B.1 shape validator here proves canonical ascending
  // order, strictly-positive entries, no duplicates, and an exact sum
  // match against the authoritative expenseAmountMinor, all in one
  // call - exactly the same validator this allocation must already
  // pass once persisted, so proving it here too costs nothing extra.
  // It cannot prove the per-member `amount <= ownership` invariant
  // (the shape validator has no knowledge of member balances), which
  // is why that check remains, individually, in the loop above.
  const finalShapeCheck = validateTripOwnershipAllocationEntries(
    allocations,
    expenseAmountMinor
  );
  if (!finalShapeCheck.ok) {
    return {
      ok: false,
      reason: "Internal invariant violated - the generated allocation " +
        `failed its own final shape check: ${finalShapeCheck.reason}`,
    };
  }

  return {ok: true, allocations};
}

// ---------------------------------------------------------------------
// APPLY / RESTORE (composing the primitives above into full
// before/after ownership sets)
// ---------------------------------------------------------------------

export type ApplySharedStashDepletionResult =
  | {
      ok: true;
      allocations: TripOwnershipAllocationEntry[];
      resultingOwnership: MemberOwnershipBalance[];
    }
  | {ok: false; reason: string};

/**
 * Computes a Shared-Stash Expense's depletion allocation AND the full
 * resulting ownership set (every member, including untouched
 * zero-ownership members) - composing
 * `computeSharedStashDepletionAllocation` rather than duplicating its
 * logic (item 14). `Σ resultingOwnership == Σ ownershipBalances -
 * expenseAmountMinor` exactly, with no negative ownership and no
 * residual cents, by construction (the allocator itself already
 * guarantees this - see its own proof in this module's test suite).
 * @param {unknown} expenseAmountMinor The Shared-Stash Expense's own
 *   amount.
 * @param {unknown} ownershipBalances The ownership-balance set
 *   immediately before this expense.
 * @return {ApplySharedStashDepletionResult} The allocation and the
 *   resulting full ownership set, or the specific reason this could
 *   not be computed.
 */
export function applySharedStashDepletion(
  expenseAmountMinor: unknown,
  ownershipBalances: unknown
): ApplySharedStashDepletionResult {
  const validated = validateAndNormalizeMemberOwnershipBalances(
    ownershipBalances
  );
  if (!validated.ok) {
    return {ok: false, reason: validated.reason};
  }

  const allocationResult = computeSharedStashDepletionAllocation(
    expenseAmountMinor,
    validated.balances
  );
  if (!allocationResult.ok) {
    return {ok: false, reason: allocationResult.reason};
  }

  const deltaByUid = new Map(
    allocationResult.allocations.map((a) => [a.uid, a.amountMinor])
  );
  const resultingOwnership: MemberOwnershipBalance[] = validated.balances.map(
    (b) => ({
      uid: b.uid,
      ownershipMinor: b.ownershipMinor - (deltaByUid.get(b.uid) ?? 0),
    })
  );

  // Checkpoint 5B.2A, item 6: apply-depletion global invariant re-check
  // - defense-in-depth only (unreachable if the allocator above is
  // correct), but explicitly verified rather than trusted, exactly
  // mirroring computeExpenseSplits's own established "re-assert the
  // one invariant every caller actually depends on" discipline. Uses
  // the allocation's own exact BigInt sum (itself already proven equal
  // to expenseAmountMinor by the allocator's own final shape check) so
  // this function never needs to re-narrow its own unknown-typed
  // expenseAmountMinor parameter.
  let oldTotalBig = BigInt(0);
  for (const b of validated.balances) {
    oldTotalBig += BigInt(b.ownershipMinor);
  }
  let allocatedBig = BigInt(0);
  for (const a of allocationResult.allocations) {
    allocatedBig += BigInt(a.amountMinor);
  }
  let newTotalBig = BigInt(0);
  for (const b of resultingOwnership) {
    if (b.ownershipMinor < 0) {
      return {
        ok: false,
        reason: "Internal invariant violated - resulting ownership for " +
          `"${b.uid}" is negative.`,
      };
    }
    newTotalBig += BigInt(b.ownershipMinor);
  }
  if (oldTotalBig - allocatedBig !== newTotalBig) {
    return {
      ok: false,
      reason: "Internal invariant violated - the resulting ownership " +
        "total does not equal the original total minus the allocated " +
        "expense amount.",
    };
  }

  return {
    ok: true,
    allocations: allocationResult.allocations,
    resultingOwnership,
  };
}

export type RestoreSharedStashDepletionResult =
  | {ok: true; resultingOwnership: MemberOwnershipBalance[]}
  | {ok: false; reason: string};

// Checkpoint 5B.2A, item 1: the authoritative, already-persisted
// Shared-Stash allocation record a reversal restores - NOT merely a
// bag of entries. A restoration primitive is the LAST line of defense
// before a financial reversal; it must never trust that a candidate
// entries array is internally self-consistent as a substitute for
// checking it against the record's own independently-persisted
// `amountMinor`. Concretely: entries summing to 199 must be REJECTED
// if the record's own persisted amountMinor says 200, even though 199
// is an internally "valid" sum for those entries alone - a malformed
// or tampered companion record must never be silently accepted merely
// because its own parts agree with each other.
//
// Deliberately omits the persisted record's other fields (tripId,
// expenseId, withdrawalTransactionId, currency, provenance,
// timestamps) - this primitive performs only arithmetic and has no use
// for them; a caller already holding the full persisted
// `TripOwnershipAllocation` passes just the two fields this needs.
export type AuthoritativeSharedStashAllocation = {
  amountMinor: number;
  allocations: TripOwnershipAllocationEntry[];
};

/**
 * Restores an EXISTING, already-persisted allocation exactly - never
 * recomputing proportions (preflight §10/§12: a reversal always
 * restores the original allocation, which may no longer match current
 * proportions, and that is correct, not a bug). For every `(uid,
 * amountMinor)` entry in `originalAllocation.allocations`:
 * `restoredOwnership_uid = currentOwnership_uid + amountMinor`.
 *
 * Validates the entries against the record's own AUTHORITATIVE,
 * independently-supplied `amountMinor` (Checkpoint 5B.2A, item 1) -
 * never against a total merely derived from the entries themselves.
 * Reuses the existing 5B.1 `validateTripOwnershipAllocationEntries`
 * shape validator (item 12's own instruction) to prove canonical
 * ordering, positive entries, no duplicates, and an exact sum match
 * against that authoritative amount, in one call, rather than
 * re-deriving duplicate validation logic.
 *
 * Missing-uid policy (item 13, decided and documented here): FAILS
 * CLOSED. If `originalAllocation.allocations` names a uid absent from
 * the supplied `ownershipBalances`, this is rejected outright - never
 * silently inventing a new zero-then-restored row. The frozen 5B
 * lifecycle model (preflight §19, as resolved by Amendment 5B.0A item
 * 7) already guarantees a uid can never be removed from financial
 * membership while holding positive ownership, so a genuine
 * steady-state reversal should always find its row already present; a
 * missing row indicates something has already gone wrong upstream,
 * which this primitive refuses to paper over. If a future
 * migration/reconciliation primitive genuinely needs to recreate a row
 * from scratch, that must be an explicitly separate, differently-named
 * primitive - never blurred with ordinary reversal.
 * @param {unknown} ownershipBalances The CURRENT ownership-balance set
 *   (not necessarily the one at the time of the original expense).
 * @param {unknown} originalAllocation The authoritative, already-
 *   persisted `{amountMinor, allocations}` to restore exactly.
 * @return {RestoreSharedStashDepletionResult} The full resulting
 *   ownership set, or the specific reason restoration was rejected.
 */
export function restoreSharedStashDepletion(
  ownershipBalances: unknown,
  originalAllocation: unknown
): RestoreSharedStashDepletionResult {
  const validatedOwnership = validateAndNormalizeMemberOwnershipBalances(
    ownershipBalances
  );
  if (!validatedOwnership.ok) {
    return {ok: false, reason: validatedOwnership.reason};
  }

  if (typeof originalAllocation !== "object" || originalAllocation === null) {
    return {
      ok: false,
      reason: "originalAllocation must be an object with amountMinor and " +
        "allocations.",
    };
  }
  const candidate = originalAllocation as Record<string, unknown>;
  if (!isPositiveSafeInteger(candidate.amountMinor)) {
    return {
      ok: false,
      reason: "originalAllocation.amountMinor must be a positive safe " +
        "integer.",
    };
  }
  const amountMinor = candidate.amountMinor;

  // The authoritative amount is supplied independently - never derived
  // from the entries - so this call rejects any entries array that
  // does not sum EXACTLY to it, even if the entries are otherwise
  // internally self-consistent.
  const shapeResult = validateTripOwnershipAllocationEntries(
    candidate.allocations,
    amountMinor
  );
  if (!shapeResult.ok) {
    return {ok: false, reason: shapeResult.reason};
  }
  const entries = candidate.allocations as TripOwnershipAllocationEntry[];

  const ownershipByUid = new Map(
    validatedOwnership.balances.map((b) => [b.uid, b.ownershipMinor])
  );
  for (const entry of entries) {
    if (!ownershipByUid.has(entry.uid)) {
      return {
        ok: false,
        reason: `originalAllocation references uid "${entry.uid}", which ` +
          "has no current ownership row - refusing to restore.",
      };
    }
  }

  const deltaByUid = new Map(entries.map((e) => [e.uid, e.amountMinor]));
  const resultingOwnership: MemberOwnershipBalance[] = [];
  for (const b of validatedOwnership.balances) {
    const deltaMinor = deltaByUid.get(b.uid) ?? 0;
    const restoredBig = BigInt(b.ownershipMinor) + BigInt(deltaMinor);
    if (restoredBig > MAX_SAFE_INTEGER_BIG) {
      return {
        ok: false,
        reason: `Restored ownership for "${b.uid}" exceeded the safe ` +
          "integer range.",
      };
    }
    resultingOwnership.push({uid: b.uid, ownershipMinor: Number(restoredBig)});
  }

  // Checkpoint 5B.2A, item 7: global restoration invariant re-check -
  // defense-in-depth only (unreachable given the per-row checks
  // above), but explicitly verified rather than trusted. Rejects an
  // unsafe TOTAL even where every individual row was independently
  // safe, before comparing against the authoritative amount.
  let currentTotalBig = BigInt(0);
  for (const b of validatedOwnership.balances) {
    currentTotalBig += BigInt(b.ownershipMinor);
  }
  let restoredTotalBig = BigInt(0);
  for (const b of resultingOwnership) {
    restoredTotalBig += BigInt(b.ownershipMinor);
  }
  if (restoredTotalBig > MAX_SAFE_INTEGER_BIG) {
    return {
      ok: false,
      reason: "Internal invariant violated - the restored ownership " +
        "total exceeded the safe integer range.",
    };
  }
  if (currentTotalBig + BigInt(amountMinor) !== restoredTotalBig) {
    return {
      ok: false,
      reason: "Internal invariant violated - the restored ownership " +
        "total does not equal the current total plus the authoritative " +
        "allocation amount.",
    };
  }

  return {ok: true, resultingOwnership};
}

// ---------------------------------------------------------------------
// RECONCILIATION / INVARIANT CHECK
// ---------------------------------------------------------------------

export type OwnershipReconciliationResult =
  | {ok: true}
  | {
      ok: false;
      reason: string;
      aggregateBalanceMinor?: number;
      ownershipTotalMinor?: number;
    };

/**
 * Checks the preflight's own §7 invariant: `aggregateLedgerBalanceMinor
 * == Σ ownershipMinor`. Never throws for an ordinary mismatch - that is
 * exactly the condition this function exists to detect and report
 * (destined for 5B.4/5B.5's migration-completion and drift-reconciliation
 * checks). A malformed/unsafe input is reported distinctly (no
 * `aggregateBalanceMinor`/`ownershipTotalMinor` in the result) from a
 * genuine accounting mismatch between two otherwise-valid numbers
 * (both fields present) - so a caller can tell "the data itself is
 * corrupt" apart from "the data is well-formed but doesn't balance."
 * @param {unknown} aggregateLedgerBalanceMinor The Trip's own trusted
 *   aggregate `ledgerBalanceMinor`.
 * @param {unknown} ownershipBalances The full ownership-balance set to
 *   reconcile against it.
 * @return {OwnershipReconciliationResult} Ok if they match exactly, or
 *   the specific reason (and, where applicable, both compared totals)
 *   if they do not.
 */
export function reconcileOwnershipAgainstAggregate(
  aggregateLedgerBalanceMinor: unknown,
  ownershipBalances: unknown
): OwnershipReconciliationResult {
  if (!isNonNegativeSafeInteger(aggregateLedgerBalanceMinor)) {
    return {
      ok: false,
      reason: "aggregateLedgerBalanceMinor must be a non-negative safe " +
        "integer.",
    };
  }

  const sumResult = sumOwnershipMinor(ownershipBalances);
  if (!sumResult.ok) {
    return {
      ok: false,
      reason: `Ownership balances are invalid: ${sumResult.reason}`,
    };
  }

  if (sumResult.totalMinor !== aggregateLedgerBalanceMinor) {
    return {
      ok: false,
      reason: "aggregateLedgerBalanceMinor does not equal the sum of " +
        "ownership balances.",
      aggregateBalanceMinor: aggregateLedgerBalanceMinor,
      ownershipTotalMinor: sumResult.totalMinor,
    };
  }

  return {ok: true};
}
