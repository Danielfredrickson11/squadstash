// Tests for the pure Trip Shared-Stash ownership-accounting primitives
// (Checkpoint 5B.2). No Firestore emulator needed - pure logic only.
// Covers: ownership-balance validation/normalization, exact sum,
// contribution/withdrawal transitions, the BigInt-exact proportional
// depletion algorithm (including the checkpoint's own required Examples
// A-D), restoration, the apply/restore composite helpers and their
// round trip, reconciliation, large safe-integer/BigInt boundary cases,
// and property-style table-driven coverage across many small ownership
// combinations.
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  applyMemberContribution,
  applyMemberWithdrawal,
  applySharedStashDepletion,
  computeSharedStashDepletionAllocation,
  reconcileOwnershipAgainstAggregate,
  restoreSharedStashDepletion,
  sumOwnershipMinor,
  validateAndNormalizeMemberOwnershipBalances,
} from "../src/domain/tripOwnershipAccounting";
import {validateTripOwnershipAllocationEntries} from "../src/domain/tripOwnershipAllocation";

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

// ---------------------------------------------------------------------
// validateAndNormalizeMemberOwnershipBalances
// ---------------------------------------------------------------------

describe("validateAndNormalizeMemberOwnershipBalances", () => {
  it("accepts a well-formed multi-member set and sorts it ascending by uid", () => {
    const result = validateAndNormalizeMemberOwnershipBalances([
      {uid: "zed", ownershipMinor: 100},
      {uid: "amy", ownershipMinor: 200},
    ]);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.balances, [
        {uid: "amy", ownershipMinor: 200},
        {uid: "zed", ownershipMinor: 100},
      ]);
    }
  });

  it("accepts a single-member set", () => {
    const result = validateAndNormalizeMemberOwnershipBalances([
      {uid: "solo", ownershipMinor: 50},
    ]);
    assert.equal(result.ok, true);
  });

  it("accepts ownershipMinor == 0 (a legitimately fully-depleted member)", () => {
    const result = validateAndNormalizeMemberOwnershipBalances([
      {uid: "a", ownershipMinor: 0},
    ]);
    assert.equal(result.ok, true);
  });

  it("rejects an empty array", () => {
    assert.equal(validateAndNormalizeMemberOwnershipBalances([]).ok, false);
  });

  it("rejects a non-array value", () => {
    assert.equal(
      validateAndNormalizeMemberOwnershipBalances({a: 100}).ok,
      false
    );
  });

  it("rejects null", () => {
    assert.equal(validateAndNormalizeMemberOwnershipBalances(null).ok, false);
  });

  it("rejects a duplicate uid rather than silently combining the two rows", () => {
    const result = validateAndNormalizeMemberOwnershipBalances([
      {uid: "a", ownershipMinor: 100},
      {uid: "a", ownershipMinor: 50},
    ]);
    assert.equal(result.ok, false);
  });

  it("rejects an empty-string uid", () => {
    const result = validateAndNormalizeMemberOwnershipBalances([
      {uid: "", ownershipMinor: 100},
    ]);
    assert.equal(result.ok, false);
  });

  it("rejects a non-string uid", () => {
    const result = validateAndNormalizeMemberOwnershipBalances([
      {uid: 123, ownershipMinor: 100},
    ]);
    assert.equal(result.ok, false);
  });

  it("rejects a negative ownershipMinor", () => {
    const result = validateAndNormalizeMemberOwnershipBalances([
      {uid: "a", ownershipMinor: -1},
    ]);
    assert.equal(result.ok, false);
  });

  it("rejects a fractional ownershipMinor", () => {
    const result = validateAndNormalizeMemberOwnershipBalances([
      {uid: "a", ownershipMinor: 1.5},
    ]);
    assert.equal(result.ok, false);
  });

  it("rejects an unsafe-integer ownershipMinor", () => {
    const result = validateAndNormalizeMemberOwnershipBalances([
      {uid: "a", ownershipMinor: MAX_SAFE + 2},
    ]);
    assert.equal(result.ok, false);
  });

  it("rejects a non-number ownershipMinor", () => {
    const result = validateAndNormalizeMemberOwnershipBalances([
      {uid: "a", ownershipMinor: "100"},
    ]);
    assert.equal(result.ok, false);
  });

  it("rejects a non-object entry", () => {
    const result = validateAndNormalizeMemberOwnershipBalances(["a"]);
    assert.equal(result.ok, false);
  });

  it("does not require the input to already be sorted - canonicalizes regardless of input order", () => {
    const first = validateAndNormalizeMemberOwnershipBalances([
      {uid: "c", ownershipMinor: 1},
      {uid: "a", ownershipMinor: 2},
      {uid: "b", ownershipMinor: 3},
    ]);
    const second = validateAndNormalizeMemberOwnershipBalances([
      {uid: "a", ownershipMinor: 2},
      {uid: "b", ownershipMinor: 3},
      {uid: "c", ownershipMinor: 1},
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (first.ok && second.ok) {
      assert.deepEqual(first.balances, second.balances);
    }
  });

  it("every failure carries a non-empty reason string", () => {
    const result = validateAndNormalizeMemberOwnershipBalances([]);
    if (!result.ok) {
      assert.ok(result.reason.length > 0);
    } else {
      assert.fail("expected a failure");
    }
  });
});

// ---------------------------------------------------------------------
// sumOwnershipMinor
// ---------------------------------------------------------------------

describe("sumOwnershipMinor", () => {
  it("sums a single member", () => {
    const result = sumOwnershipMinor([{uid: "a", ownershipMinor: 500}]);
    assert.deepEqual(result, {ok: true, totalMinor: 500});
  });

  it("sums multiple members", () => {
    const result = sumOwnershipMinor([
      {uid: "a", ownershipMinor: 900},
      {uid: "b", ownershipMinor: 100},
    ]);
    assert.deepEqual(result, {ok: true, totalMinor: 1000});
  });

  it("a wholly zero-ownership set sums to exactly zero", () => {
    const result = sumOwnershipMinor([{uid: "a", ownershipMinor: 0}]);
    assert.deepEqual(result, {ok: true, totalMinor: 0});
  });

  it("sums large safe-integer values exactly via BigInt, where their sum alone is still safe", () => {
    const result = sumOwnershipMinor([
      {uid: "a", ownershipMinor: 5_000_000_000_000},
      {uid: "b", ownershipMinor: 4_000_000_000_000},
    ]);
    assert.deepEqual(result, {ok: true, totalMinor: 9_000_000_000_000});
  });

  it("rejects when the exact total itself exceeds the safe integer range", () => {
    const result = sumOwnershipMinor([
      {uid: "a", ownershipMinor: MAX_SAFE},
      {uid: "b", ownershipMinor: MAX_SAFE},
    ]);
    assert.equal(result.ok, false);
  });

  it("propagates the underlying validation failure for malformed input", () => {
    const result = sumOwnershipMinor([{uid: "", ownershipMinor: 1}]);
    assert.equal(result.ok, false);
  });

  it("is independent of input order", () => {
    const a = sumOwnershipMinor([
      {uid: "a", ownershipMinor: 1},
      {uid: "b", ownershipMinor: 2},
      {uid: "c", ownershipMinor: 3},
    ]);
    const b = sumOwnershipMinor([
      {uid: "c", ownershipMinor: 3},
      {uid: "a", ownershipMinor: 1},
      {uid: "b", ownershipMinor: 2},
    ]);
    assert.deepEqual(a, b);
  });
});

// ---------------------------------------------------------------------
// Member contribution transition
// ---------------------------------------------------------------------

describe("applyMemberContribution", () => {
  it("adds the contribution to the current ownership", () => {
    assert.deepEqual(applyMemberContribution(100, 50), {
      ok: true,
      newOwnershipMinor: 150,
    });
  });

  it("a brand-new member (current ownership 0) can receive their first contribution", () => {
    assert.deepEqual(applyMemberContribution(0, 100), {
      ok: true,
      newOwnershipMinor: 100,
    });
  });

  it("rejects a negative current ownership", () => {
    const result = applyMemberContribution(-1, 50);
    assert.deepEqual(result, {ok: false, reason: "invalid_current_ownership"});
  });

  it("rejects a fractional current ownership", () => {
    const result = applyMemberContribution(100.5, 50);
    assert.deepEqual(result, {ok: false, reason: "invalid_current_ownership"});
  });

  it("rejects a zero contribution amount", () => {
    const result = applyMemberContribution(100, 0);
    assert.deepEqual(result, {ok: false, reason: "invalid_amount"});
  });

  it("rejects a negative contribution amount", () => {
    const result = applyMemberContribution(100, -50);
    assert.deepEqual(result, {ok: false, reason: "invalid_amount"});
  });

  it("rejects a fractional contribution amount", () => {
    const result = applyMemberContribution(100, 50.5);
    assert.deepEqual(result, {ok: false, reason: "invalid_amount"});
  });

  it("rejects an unsafe-integer contribution amount", () => {
    const result = applyMemberContribution(100, MAX_SAFE + 2);
    assert.deepEqual(result, {ok: false, reason: "invalid_amount"});
  });

  it("rejects when two individually-safe values would sum to an unsafe result", () => {
    const result = applyMemberContribution(MAX_SAFE, MAX_SAFE);
    assert.deepEqual(result, {ok: false, reason: "unsafe_result"});
  });

  it("accepts a contribution landing exactly on the safe-integer boundary", () => {
    const result = applyMemberContribution(MAX_SAFE - 1, 1);
    assert.deepEqual(result, {ok: true, newOwnershipMinor: MAX_SAFE});
  });

  it("never mutates its numeric inputs (nothing to mutate, but the call is side-effect free)", () => {
    const current = 100;
    const amount = 50;
    applyMemberContribution(current, amount);
    assert.equal(current, 100);
    assert.equal(amount, 50);
  });
});

// ---------------------------------------------------------------------
// Member withdrawal ceiling + transition
// ---------------------------------------------------------------------

describe("applyMemberWithdrawal", () => {
  it("Example B (checkpoint 5B.2 §9): ownership 100, withdraw 100 succeeds and becomes 0", () => {
    assert.deepEqual(applyMemberWithdrawal(100, 100), {
      ok: true,
      newOwnershipMinor: 0,
    });
  });

  it("Example B (checkpoint 5B.2 §9): ownership 100, withdraw 101 is rejected", () => {
    const result = applyMemberWithdrawal(100, 101);
    assert.deepEqual(result, {ok: false, reason: "insufficient_ownership"});
  });

  it("a partial withdrawal below the ceiling succeeds", () => {
    assert.deepEqual(applyMemberWithdrawal(100, 40), {
      ok: true,
      newOwnershipMinor: 60,
    });
  });

  it("rejects a zero withdrawal amount", () => {
    const result = applyMemberWithdrawal(100, 0);
    assert.deepEqual(result, {ok: false, reason: "invalid_amount"});
  });

  it("rejects a negative withdrawal amount", () => {
    const result = applyMemberWithdrawal(100, -1);
    assert.deepEqual(result, {ok: false, reason: "invalid_amount"});
  });

  it("rejects a fractional withdrawal amount", () => {
    const result = applyMemberWithdrawal(100, 1.5);
    assert.deepEqual(result, {ok: false, reason: "invalid_amount"});
  });

  it("rejects an unsafe-integer withdrawal amount", () => {
    const result = applyMemberWithdrawal(MAX_SAFE, MAX_SAFE + 2);
    assert.deepEqual(result, {ok: false, reason: "invalid_amount"});
  });

  it("rejects a negative current ownership", () => {
    const result = applyMemberWithdrawal(-1, 1);
    assert.deepEqual(result, {ok: false, reason: "invalid_current_ownership"});
  });

  it("rejects a fractional current ownership", () => {
    const result = applyMemberWithdrawal(100.5, 1);
    assert.deepEqual(result, {ok: false, reason: "invalid_current_ownership"});
  });

  it("a withdrawal from zero ownership is always insufficient", () => {
    const result = applyMemberWithdrawal(0, 1);
    assert.deepEqual(result, {ok: false, reason: "insufficient_ownership"});
  });

  it("does NOT perform the aggregate Trip-balance check - only this one member's own ceiling", () => {
    // This primitive has no parameter for an aggregate balance at all;
    // this test documents that fact by confirming the two-argument
    // signature alone fully determines the result for a member whose
    // own ceiling is satisfied, regardless of any other Trip-level
    // concern - that remains a separate, independent check (5B.3).
    assert.deepEqual(applyMemberWithdrawal(100, 100), {
      ok: true,
      newOwnershipMinor: 0,
    });
  });

  it("succeeds at the safe-integer boundary", () => {
    assert.deepEqual(applyMemberWithdrawal(MAX_SAFE, MAX_SAFE), {
      ok: true,
      newOwnershipMinor: 0,
    });
  });
});

// ---------------------------------------------------------------------
// Shared-Stash proportional depletion - required core examples
// ---------------------------------------------------------------------

describe("computeSharedStashDepletionAllocation - required core examples", () => {
  it("Example A: Daniel=900, Friend=100, expense=200 -> Daniel=180, Friend=20", () => {
    const result = computeSharedStashDepletionAllocation(200, [
      {uid: "daniel", ownershipMinor: 900},
      {uid: "friendA", ownershipMinor: 100},
    ]);
    assert.deepEqual(result, {
      ok: true,
      allocations: [
        {uid: "daniel", amountMinor: 180},
        {uid: "friendA", amountMinor: 20},
      ],
    });
  });

  it("Example C: A=1, B=1, C=1, expense=1 -> all remainders tie, lexicographically smallest uid wins", () => {
    const result = computeSharedStashDepletionAllocation(1, [
      {uid: "a", ownershipMinor: 1},
      {uid: "b", ownershipMinor: 1},
      {uid: "c", ownershipMinor: 1},
    ]);
    assert.deepEqual(result, {
      ok: true,
      allocations: [{uid: "a", amountMinor: 1}],
    });
  });

  it("Example D: A=900, B=100, expense=1000 -> full depletion, A=900, B=100", () => {
    const result = computeSharedStashDepletionAllocation(1000, [
      {uid: "a", ownershipMinor: 900},
      {uid: "b", ownershipMinor: 100},
    ]);
    assert.deepEqual(result, {
      ok: true,
      allocations: [
        {uid: "a", amountMinor: 900},
        {uid: "b", amountMinor: 100},
      ],
    });
  });
});

describe("computeSharedStashDepletionAllocation - validation/rejection", () => {
  it("rejects expenseAmountMinor exceeding total ownership", () => {
    const result = computeSharedStashDepletionAllocation(101, [
      {uid: "a", ownershipMinor: 100},
    ]);
    assert.equal(result.ok, false);
  });

  it("rejects a zero expense amount", () => {
    const result = computeSharedStashDepletionAllocation(0, [
      {uid: "a", ownershipMinor: 100},
    ]);
    assert.equal(result.ok, false);
  });

  it("rejects a negative expense amount", () => {
    const result = computeSharedStashDepletionAllocation(-1, [
      {uid: "a", ownershipMinor: 100},
    ]);
    assert.equal(result.ok, false);
  });

  it("rejects a fractional expense amount", () => {
    const result = computeSharedStashDepletionAllocation(1.5, [
      {uid: "a", ownershipMinor: 100},
    ]);
    assert.equal(result.ok, false);
  });

  it("rejects an all-zero-ownership collection - cannot fund any positive expense", () => {
    const result = computeSharedStashDepletionAllocation(1, [
      {uid: "a", ownershipMinor: 0},
      {uid: "b", ownershipMinor: 0},
    ]);
    assert.equal(result.ok, false);
  });

  it("propagates malformed ownership-balance input", () => {
    const result = computeSharedStashDepletionAllocation(100, [
      {uid: "", ownershipMinor: 100},
    ]);
    assert.equal(result.ok, false);
  });
});

describe("computeSharedStashDepletionAllocation - zero-ownership members", () => {
  it("a zero-ownership member receives no allocation entry at all", () => {
    const result = computeSharedStashDepletionAllocation(50, [
      {uid: "a", ownershipMinor: 0},
      {uid: "b", ownershipMinor: 100},
    ]);
    assert.deepEqual(result, {
      ok: true,
      allocations: [{uid: "b", amountMinor: 50}],
    });
  });

  it("a zero-ownership member can never win a residual-cent tie-break", () => {
    // "a" would be the lexicographically-smallest uid and would win any
    // tie if it participated, but it holds zero ownership, so it must
    // never appear even when ties are otherwise present among the
    // genuine participants.
    const result = computeSharedStashDepletionAllocation(1, [
      {uid: "a", ownershipMinor: 0},
      {uid: "b", ownershipMinor: 1},
      {uid: "c", ownershipMinor: 1},
    ]);
    assert.deepEqual(result, {
      ok: true,
      allocations: [{uid: "b", amountMinor: 1}],
    });
  });
});

describe("computeSharedStashDepletionAllocation - determinism/ordering", () => {
  it("input order does not affect the canonical output", () => {
    const balances1 = [
      {uid: "daniel", ownershipMinor: 900},
      {uid: "friendA", ownershipMinor: 100},
    ];
    const balances2 = [
      {uid: "friendA", ownershipMinor: 100},
      {uid: "daniel", ownershipMinor: 900},
    ];
    assert.deepEqual(
      computeSharedStashDepletionAllocation(200, balances1),
      computeSharedStashDepletionAllocation(200, balances2)
    );
  });

  it("the output is always in strictly ascending uid order", () => {
    const result = computeSharedStashDepletionAllocation(6, [
      {uid: "zed", ownershipMinor: 2},
      {uid: "amy", ownershipMinor: 2},
      {uid: "mid", ownershipMinor: 2},
    ]);
    assert.equal(result.ok, true);
    if (result.ok) {
      const uids = result.allocations.map((a) => a.uid);
      assert.deepEqual(uids, [...uids].sort());
    }
  });

  it("the output is directly accepted by the existing 5B.1 allocation-entries validator with no transformation", () => {
    const result = computeSharedStashDepletionAllocation(200, [
      {uid: "daniel", ownershipMinor: 900},
      {uid: "friendA", ownershipMinor: 100},
    ]);
    assert.equal(result.ok, true);
    if (result.ok) {
      const shapeResult = validateTripOwnershipAllocationEntries(
        result.allocations,
        200
      );
      assert.equal(shapeResult.ok, true);
    }
  });

  it("no member's allocation may ever exceed their own pre-expense ownership", () => {
    const result = computeSharedStashDepletionAllocation(999, [
      {uid: "a", ownershipMinor: 1},
      {uid: "b", ownershipMinor: 999},
    ]);
    assert.equal(result.ok, true);
    if (result.ok) {
      const byUid = new Map(result.allocations.map((a) => [a.uid, a.amountMinor]));
      assert.ok((byUid.get("a") ?? 0) <= 1);
      assert.ok((byUid.get("b") ?? 0) <= 999);
    }
  });
});

describe("computeSharedStashDepletionAllocation - large safe-integer/BigInt boundary cases", () => {
  it("a product far exceeding Number.MAX_SAFE_INTEGER is still computed exactly via BigInt", () => {
    // 9999999999 * 5000000000 ~= 5e19, far beyond
    // Number.MAX_SAFE_INTEGER (~9.007e15) - naive Number multiplication
    // would silently lose precision here.
    const result = computeSharedStashDepletionAllocation(9_999_999_999, [
      {uid: "a", ownershipMinor: 5_000_000_000},
      {uid: "b", ownershipMinor: 5_000_000_000},
    ]);
    // Both remainders tie exactly at 5_000_000_000 - ascending uid "a"
    // wins the one residual cent, landing EXACTLY on its own full
    // ownership (a boundary case, not merely under it).
    assert.deepEqual(result, {
      ok: true,
      allocations: [
        {uid: "a", amountMinor: 5_000_000_000},
        {uid: "b", amountMinor: 4_999_999_999},
      ],
    });
  });

  it("a single owner at exactly Number.MAX_SAFE_INTEGER can be fully depleted exactly", () => {
    const result = computeSharedStashDepletionAllocation(MAX_SAFE, [
      {uid: "a", ownershipMinor: MAX_SAFE},
    ]);
    assert.deepEqual(result, {
      ok: true,
      allocations: [{uid: "a", amountMinor: MAX_SAFE}],
    });
  });

  it("an uneven large-scale split still distributes the residual cent correctly", () => {
    // numerator_a = 3 * 7_000_000_001 = 21_000_000_003
    // numerator_b = 3 * 2_999_999_999 = 8_999_999_997
    // total = 10_000_000_000
    // base_a = 2, remainder_a = 1_000_000_003
    // base_b = 0, remainder_b = 8_999_999_997 (larger - wins the cent)
    const result = computeSharedStashDepletionAllocation(3, [
      {uid: "a", ownershipMinor: 7_000_000_001},
      {uid: "b", ownershipMinor: 2_999_999_999},
    ]);
    assert.deepEqual(result, {
      ok: true,
      allocations: [
        {uid: "a", amountMinor: 2},
        {uid: "b", amountMinor: 1},
      ],
    });
  });
});

// ---------------------------------------------------------------------
// applySharedStashDepletion (composite helper)
// ---------------------------------------------------------------------

describe("applySharedStashDepletion", () => {
  it("returns both the allocation and the full resulting ownership set", () => {
    const result = applySharedStashDepletion(200, [
      {uid: "daniel", ownershipMinor: 900},
      {uid: "friendA", ownershipMinor: 100},
    ]);
    assert.deepEqual(result, {
      ok: true,
      allocations: [
        {uid: "daniel", amountMinor: 180},
        {uid: "friendA", amountMinor: 20},
      ],
      resultingOwnership: [
        {uid: "daniel", ownershipMinor: 720},
        {uid: "friendA", ownershipMinor: 80},
      ],
    });
  });

  it("preserves an untouched zero-ownership member in the resulting set", () => {
    const result = applySharedStashDepletion(50, [
      {uid: "a", ownershipMinor: 0},
      {uid: "b", ownershipMinor: 100},
    ]);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.resultingOwnership, [
        {uid: "a", ownershipMinor: 0},
        {uid: "b", ownershipMinor: 50},
      ]);
    }
  });

  it("old total minus the expense equals the new total exactly", () => {
    const before = [
      {uid: "a", ownershipMinor: 7_000_000_001},
      {uid: "b", ownershipMinor: 2_999_999_999},
    ];
    const result = applySharedStashDepletion(3, before);
    assert.equal(result.ok, true);
    if (result.ok) {
      const newTotal = result.resultingOwnership.reduce(
        (sum, b) => sum + b.ownershipMinor,
        0
      );
      assert.equal(newTotal, 7_000_000_001 + 2_999_999_999 - 3);
    }
  });

  it("propagates a rejection from the underlying allocator", () => {
    const result = applySharedStashDepletion(1000, [
      {uid: "a", ownershipMinor: 100},
    ]);
    assert.equal(result.ok, false);
  });
});

// ---------------------------------------------------------------------
// restoreSharedStashDepletion (exact restoration)
// ---------------------------------------------------------------------

describe("restoreSharedStashDepletion", () => {
  it("restores an allocation exactly by adding it back, never recomputing proportions", () => {
    const result = restoreSharedStashDepletion(
      [
        {uid: "daniel", ownershipMinor: 720},
        {uid: "friendA", ownershipMinor: 80},
      ],
      {
        amountMinor: 200,
        allocations: [
          {uid: "daniel", amountMinor: 180},
          {uid: "friendA", amountMinor: 20},
        ],
      }
    );
    assert.deepEqual(result, {
      ok: true,
      resultingOwnership: [
        {uid: "daniel", ownershipMinor: 900},
        {uid: "friendA", ownershipMinor: 100},
      ],
    });
  });

  it("restores correctly even when current ownership no longer matches the original proportions (expected steady-state behavior)", () => {
    // daniel has since contributed more and friendA has since withdrawn
    // some - restoration must still add back exactly the ORIGINAL
    // allocation amounts, not recompute anything proportionally.
    const result = restoreSharedStashDepletion(
      [
        {uid: "daniel", ownershipMinor: 5000},
        {uid: "friendA", ownershipMinor: 10},
      ],
      {
        amountMinor: 200,
        allocations: [
          {uid: "daniel", amountMinor: 180},
          {uid: "friendA", amountMinor: 20},
        ],
      }
    );
    assert.deepEqual(result, {
      ok: true,
      resultingOwnership: [
        {uid: "daniel", ownershipMinor: 5180},
        {uid: "friendA", ownershipMinor: 30},
      ],
    });
  });

  it("leaves an untouched member (absent from the allocation) exactly as-is", () => {
    const result = restoreSharedStashDepletion(
      [
        {uid: "a", ownershipMinor: 100},
        {uid: "untouched", ownershipMinor: 500},
      ],
      {amountMinor: 50, allocations: [{uid: "a", amountMinor: 50}]}
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      const untouched = result.resultingOwnership.find(
        (b) => b.uid === "untouched"
      );
      assert.deepEqual(untouched, {uid: "untouched", ownershipMinor: 500});
    }
  });

  it("missing-restoration-uid policy: fails closed when the allocation references a uid with no current ownership row", () => {
    const result = restoreSharedStashDepletion(
      [{uid: "daniel", ownershipMinor: 720}],
      {
        amountMinor: 200,
        allocations: [
          {uid: "daniel", amountMinor: 180},
          {uid: "friendA", amountMinor: 20},
        ],
      }
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.reason.includes("friendA"));
    }
  });

  it("rejects when the current ownership input itself is malformed", () => {
    const result = restoreSharedStashDepletion(
      [{uid: "", ownershipMinor: 100}],
      {amountMinor: 50, allocations: [{uid: "a", amountMinor: 50}]}
    );
    assert.equal(result.ok, false);
  });

  it("reuses the existing 5B.1 shape validator - rejects a duplicate uid within the allocation itself", () => {
    const result = restoreSharedStashDepletion(
      [{uid: "a", ownershipMinor: 100}],
      {
        amountMinor: 50,
        allocations: [
          {uid: "a", amountMinor: 25},
          {uid: "a", amountMinor: 25},
        ],
      }
    );
    assert.equal(result.ok, false);
  });

  it("reuses the existing 5B.1 shape validator - rejects a non-ascending allocation order", () => {
    const result = restoreSharedStashDepletion(
      [
        {uid: "a", ownershipMinor: 100},
        {uid: "b", ownershipMinor: 100},
      ],
      {
        amountMinor: 100,
        allocations: [
          {uid: "b", amountMinor: 50},
          {uid: "a", amountMinor: 50},
        ],
      }
    );
    assert.equal(result.ok, false);
  });

  it("rejects an empty originalAllocation.allocations array", () => {
    const result = restoreSharedStashDepletion(
      [{uid: "a", ownershipMinor: 100}],
      {amountMinor: 50, allocations: []}
    );
    assert.equal(result.ok, false);
  });

  it("rejects a non-array originalAllocation.allocations", () => {
    const result = restoreSharedStashDepletion(
      [{uid: "a", ownershipMinor: 100}],
      {amountMinor: 50, allocations: {a: 50}}
    );
    assert.equal(result.ok, false);
  });

  it("rejects a non-object originalAllocation entirely", () => {
    const result = restoreSharedStashDepletion(
      [{uid: "a", ownershipMinor: 100}],
      "not an object"
    );
    assert.equal(result.ok, false);
  });

  it("rejects null as originalAllocation", () => {
    const result = restoreSharedStashDepletion(
      [{uid: "a", ownershipMinor: 100}],
      null
    );
    assert.equal(result.ok, false);
  });

  it("rejects a zero-amountMinor allocation entry (the 5B.1 validator's own rule)", () => {
    const result = restoreSharedStashDepletion(
      [
        {uid: "a", ownershipMinor: 100},
        {uid: "b", ownershipMinor: 100},
      ],
      {
        amountMinor: 100,
        allocations: [
          {uid: "a", amountMinor: 100},
          {uid: "b", amountMinor: 0},
        ],
      }
    );
    assert.equal(result.ok, false);
  });

  it("restores exactly at the safe-integer boundary", () => {
    const result = restoreSharedStashDepletion(
      [{uid: "a", ownershipMinor: MAX_SAFE - 1}],
      {amountMinor: 1, allocations: [{uid: "a", amountMinor: 1}]}
    );
    assert.deepEqual(result, {
      ok: true,
      resultingOwnership: [{uid: "a", ownershipMinor: MAX_SAFE}],
    });
  });

  // Checkpoint 5B.2A, items 1-2: the authoritative persisted amount is
  // now independently validated against the entries - an internally
  // self-consistent (but tampered/malformed) record must still be
  // rejected.
  describe("authoritative amount vs. entries sum", () => {
    it("entries summing to less than the authoritative amountMinor are rejected, even though they are internally self-consistent", () => {
      // The persisted record claims amountMinor=200, but its own
      // entries only sum to 199 (180 + 19) - this must be rejected
      // outright, never accepted merely because 199 == 180 + 19.
      const result = restoreSharedStashDepletion(
        [
          {uid: "a", ownershipMinor: 720},
          {uid: "b", ownershipMinor: 80},
        ],
        {
          amountMinor: 200,
          allocations: [
            {uid: "a", amountMinor: 180},
            {uid: "b", amountMinor: 19},
          ],
        }
      );
      assert.equal(result.ok, false);
    });

    it("entries summing to more than the authoritative amountMinor are rejected", () => {
      const result = restoreSharedStashDepletion(
        [
          {uid: "a", ownershipMinor: 720},
          {uid: "b", ownershipMinor: 80},
        ],
        {
          amountMinor: 199,
          allocations: [
            {uid: "a", amountMinor: 180},
            {uid: "b", amountMinor: 20},
          ],
        }
      );
      assert.equal(result.ok, false);
    });

    it("the same entries ARE accepted once the authoritative amountMinor matches their exact sum", () => {
      const result = restoreSharedStashDepletion(
        [
          {uid: "a", ownershipMinor: 720},
          {uid: "b", ownershipMinor: 80},
        ],
        {
          amountMinor: 199,
          allocations: [
            {uid: "a", amountMinor: 180},
            {uid: "b", amountMinor: 19},
          ],
        }
      );
      assert.deepEqual(result, {
        ok: true,
        resultingOwnership: [
          {uid: "a", ownershipMinor: 900},
          {uid: "b", ownershipMinor: 99},
        ],
      });
    });

    it("rejects a zero amountMinor", () => {
      const result = restoreSharedStashDepletion(
        [{uid: "a", ownershipMinor: 100}],
        {amountMinor: 0, allocations: [{uid: "a", amountMinor: 0}]}
      );
      assert.equal(result.ok, false);
    });

    it("rejects a negative amountMinor", () => {
      const result = restoreSharedStashDepletion(
        [{uid: "a", ownershipMinor: 100}],
        {amountMinor: -50, allocations: [{uid: "a", amountMinor: 50}]}
      );
      assert.equal(result.ok, false);
    });

    it("rejects a fractional amountMinor", () => {
      const result = restoreSharedStashDepletion(
        [{uid: "a", ownershipMinor: 100}],
        {amountMinor: 50.5, allocations: [{uid: "a", amountMinor: 50}]}
      );
      assert.equal(result.ok, false);
    });

    it("rejects an unsafe-integer amountMinor", () => {
      const result = restoreSharedStashDepletion(
        [{uid: "a", ownershipMinor: 100}],
        {amountMinor: MAX_SAFE + 2, allocations: [{uid: "a", amountMinor: 50}]}
      );
      assert.equal(result.ok, false);
    });

    it("rejects a missing amountMinor field entirely", () => {
      const result = restoreSharedStashDepletion(
        [{uid: "a", ownershipMinor: 100}],
        {allocations: [{uid: "a", amountMinor: 50}]}
      );
      assert.equal(result.ok, false);
    });
  });
});

// ---------------------------------------------------------------------
// apply + restore round trip
// ---------------------------------------------------------------------

describe("applySharedStashDepletion + restoreSharedStashDepletion round trip", () => {
  it("restoring immediately after applying returns to the exact original balances", () => {
    const original = [
      {uid: "daniel", ownershipMinor: 900},
      {uid: "friendA", ownershipMinor: 100},
    ];
    const applied = applySharedStashDepletion(200, original);
    assert.equal(applied.ok, true);
    if (!applied.ok) return;

    const restored = restoreSharedStashDepletion(applied.resultingOwnership, {
      amountMinor: 200,
      allocations: applied.allocations,
    });
    assert.deepEqual(restored, {ok: true, resultingOwnership: original});
  });

  it("round trips exactly even at a large BigInt-triggering scale", () => {
    const original = [
      {uid: "a", ownershipMinor: 7_000_000_001},
      {uid: "b", ownershipMinor: 2_999_999_999},
    ];
    const applied = applySharedStashDepletion(3, original);
    assert.equal(applied.ok, true);
    if (!applied.ok) return;

    const restored = restoreSharedStashDepletion(applied.resultingOwnership, {
      amountMinor: 3,
      allocations: applied.allocations,
    });
    assert.deepEqual(restored, {ok: true, resultingOwnership: original});
  });

  it("round trips exactly for a full-depletion expense", () => {
    const original = [
      {uid: "a", ownershipMinor: 900},
      {uid: "b", ownershipMinor: 100},
    ];
    const applied = applySharedStashDepletion(1000, original);
    assert.equal(applied.ok, true);
    if (!applied.ok) return;

    const restored = restoreSharedStashDepletion(applied.resultingOwnership, {
      amountMinor: 1000,
      allocations: applied.allocations,
    });
    assert.deepEqual(restored, {ok: true, resultingOwnership: original});
  });
});

// ---------------------------------------------------------------------
// Reconciliation / invariant check
// ---------------------------------------------------------------------

describe("reconcileOwnershipAgainstAggregate", () => {
  it("ok when the aggregate exactly matches the sum of ownership", () => {
    const result = reconcileOwnershipAgainstAggregate(1000, [
      {uid: "a", ownershipMinor: 900},
      {uid: "b", ownershipMinor: 100},
    ]);
    assert.deepEqual(result, {ok: true});
  });

  it("reports a genuine mismatch with both totals, never throwing", () => {
    const result = reconcileOwnershipAgainstAggregate(1000, [
      {uid: "a", ownershipMinor: 900},
      {uid: "b", ownershipMinor: 50},
    ]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.aggregateBalanceMinor, 1000);
      assert.equal(result.ownershipTotalMinor, 950);
    }
  });

  it("rejects a malformed aggregate balance, distinctly from an ordinary mismatch (no totals attached)", () => {
    const result = reconcileOwnershipAgainstAggregate(-1, [
      {uid: "a", ownershipMinor: 100},
    ]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.aggregateBalanceMinor, undefined);
      assert.equal(result.ownershipTotalMinor, undefined);
    }
  });

  it("rejects malformed ownership balances, distinctly from an ordinary mismatch (no totals attached)", () => {
    const result = reconcileOwnershipAgainstAggregate(100, [
      {uid: "", ownershipMinor: 100},
    ]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.aggregateBalanceMinor, undefined);
      assert.equal(result.ownershipTotalMinor, undefined);
    }
  });

  it("a zero aggregate against a wholly zero ownership set reconciles", () => {
    const result = reconcileOwnershipAgainstAggregate(0, [
      {uid: "a", ownershipMinor: 0},
    ]);
    assert.deepEqual(result, {ok: true});
  });
});

// ---------------------------------------------------------------------
// Property-style/table-driven coverage (Checkpoint 5B.2, item 22):
// every legal expense amount, across many small ownership combinations,
// must satisfy the core invariants - without a heavy property-testing
// dependency, this loops deterministically over a bounded combination
// space.
// ---------------------------------------------------------------------

describe("property-style coverage: every legal expense across small ownership combinations", () => {
  const VALUES = [0, 1, 2, 5];
  const UIDS = ["a", "b", "c"];

  for (const oa of VALUES) {
    for (const ob of VALUES) {
      for (const oc of VALUES) {
        const ownership = [
          {uid: UIDS[0], ownershipMinor: oa},
          {uid: UIDS[1], ownershipMinor: ob},
          {uid: UIDS[2], ownershipMinor: oc},
        ];
        const total = oa + ob + oc;
        if (total === 0) {
          continue;
        }

        it(`ownership=[${oa},${ob},${oc}]: every expense 1..${total} satisfies the core invariants and round-trips exactly`, () => {
          for (let expense = 1; expense <= total; expense++) {
            const applied = applySharedStashDepletion(expense, ownership);
            assert.equal(
              applied.ok,
              true,
              `expected success for expense=${expense}, ownership=${JSON.stringify(ownership)}`
            );
            if (!applied.ok) continue;

            // Sum invariant.
            const allocatedSum = applied.allocations.reduce(
              (sum, a) => sum + a.amountMinor,
              0
            );
            assert.equal(allocatedSum, expense);

            // No-exceed and non-negative invariants.
            const ownershipByUid = new Map(
              ownership.map((b) => [b.uid, b.ownershipMinor])
            );
            for (const allocation of applied.allocations) {
              assert.ok(allocation.amountMinor > 0);
              assert.ok(
                allocation.amountMinor <=
                  (ownershipByUid.get(allocation.uid) ?? 0)
              );
            }
            for (const resulting of applied.resultingOwnership) {
              assert.ok(resulting.ownershipMinor >= 0);
            }

            // Canonical-ordering invariant.
            const uids = applied.allocations.map((a) => a.uid);
            assert.deepEqual(uids, [...uids].sort());

            // Total-preservation invariant.
            const newTotal = applied.resultingOwnership.reduce(
              (sum, b) => sum + b.ownershipMinor,
              0
            );
            assert.equal(newTotal, total - expense);

            // Round-trip invariant.
            const restored = restoreSharedStashDepletion(
              applied.resultingOwnership,
              {amountMinor: expense, allocations: applied.allocations}
            );
            assert.deepEqual(restored, {
              ok: true,
              resultingOwnership: ownership,
            });
          }
        });
      }
    }
  }

  it("an expense exceeding the total is rejected for every non-trivial small combination", () => {
    for (const oa of VALUES) {
      for (const ob of VALUES) {
        const total = oa + ob;
        if (total === 0) continue;
        const result = applySharedStashDepletion(total + 1, [
          {uid: "a", ownershipMinor: oa},
          {uid: "b", ownershipMinor: ob},
        ]);
        assert.equal(result.ok, false);
      }
    }
  });
});
