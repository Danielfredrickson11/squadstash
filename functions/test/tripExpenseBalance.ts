// Tests for the pure, Firebase-free social-balance delta math
// (Checkpoint 6.7A). No Firestore emulator needed - pure logic only.
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  computeExpenseBalanceDeltas,
  computeSettlementBalanceDeltas,
  invertBalanceDeltas,
} from "../src/domain/tripExpenseBalance";
import type {NormalizedBalanceDelta} from "../src/domain/tripExpenseBalance";

function sortByUid(
  deltas: NormalizedBalanceDelta[]
): NormalizedBalanceDelta[] {
  return [...deltas].sort((a, b) => a.uid.localeCompare(b.uid));
}

describe("computeExpenseBalanceDeltas - payer-as-participant collapse", () => {
  it("payer pays 100, split 40/60 between payer/other -> payer +60, other -60 (never three separate entries)", () => {
    const result = computeExpenseBalanceDeltas("payer", 100, [
      {uid: "payer", amountMinor: 40},
      {uid: "other", amountMinor: 60},
    ]);
    assert.ok(result.ok, "expected a successful computation");
    if (!result.ok) return;
    assert.equal(result.deltas.length, 2);
    assert.deepEqual(sortByUid(result.deltas), [
      {uid: "other", deltaMinor: -60},
      {uid: "payer", deltaMinor: 60},
    ]);
  });

  it("payer not a participant at all: payer +amount, every split participant -their share", () => {
    const result = computeExpenseBalanceDeltas("payer", 90, [
      {uid: "a", amountMinor: 30},
      {uid: "b", amountMinor: 30},
      {uid: "c", amountMinor: 30},
    ]);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(sortByUid(result.deltas), [
      {uid: "a", deltaMinor: -30},
      {uid: "b", deltaMinor: -30},
      {uid: "c", deltaMinor: -30},
      {uid: "payer", deltaMinor: 90},
    ]);
  });

  it("every delta set sums to exactly zero", () => {
    const result = computeExpenseBalanceDeltas("payer", 100, [
      {uid: "payer", amountMinor: 33},
      {uid: "a", amountMinor: 33},
      {uid: "b", amountMinor: 34},
    ]);
    assert.ok(result.ok);
    if (!result.ok) return;
    const sum = result.deltas.reduce((acc, d) => acc + d.deltaMinor, 0);
    assert.equal(sum, 0);
  });

  it("the payer being the ONLY participant collapses to a single zero-net uid, with an explicit zero delta present", () => {
    const result = computeExpenseBalanceDeltas("payer", 50, [
      {uid: "payer", amountMinor: 50},
    ]);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.deltas, [{uid: "payer", deltaMinor: 0}]);
  });
});

describe("computeExpenseBalanceDeltas - zero-share splits remain valid (Checkpoint 6.7A Final Financial Parity Review)", () => {
  it("custom-style persisted allocation: payer A=0, B=100 -> A +100, B -100, no validation failure", () => {
    const result = computeExpenseBalanceDeltas("A", 100, [
      {uid: "A", amountMinor: 0},
      {uid: "B", amountMinor: 100},
    ]);
    assert.ok(result.ok, "expected a successful computation");
    if (!result.ok) return;
    assert.deepEqual(sortByUid(result.deltas), [
      {uid: "A", deltaMinor: 100},
      {uid: "B", deltaMinor: -100},
    ]);
  });

  it("zero-share NON-payer: payer A, B=100, C=0 -> A +100, B -100, C explicitly 0 (never discarded)", () => {
    const result = computeExpenseBalanceDeltas("A", 100, [
      {uid: "B", amountMinor: 100},
      {uid: "C", amountMinor: 0},
    ]);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(sortByUid(result.deltas), [
      {uid: "A", deltaMinor: 100},
      {uid: "B", deltaMinor: -100},
      {uid: "C", deltaMinor: 0},
    ]);
    // C remains represented, not silently discarded, matching the
    // frozen explicit-zero-row policy.
    assert.equal(result.deltas.length, 3);
  });

  it("small equal-split evidence: amountMinor=1, splits A=1/B=0/C=0 (payer A) is valid", () => {
    const result = computeExpenseBalanceDeltas("A", 1, [
      {uid: "A", amountMinor: 1},
      {uid: "B", amountMinor: 0},
      {uid: "C", amountMinor: 0},
    ]);
    assert.ok(result.ok, "expected a successful computation");
    if (!result.ok) return;
    const sum = result.deltas.reduce((acc, d) => acc + d.deltaMinor, 0);
    assert.equal(sum, 0);
  });

  it("payer IS the zero-share participant: collapses to a single zero-net uid, same as the pre-existing payer-only test", () => {
    const result = computeExpenseBalanceDeltas("A", 50, [
      {uid: "A", amountMinor: 0},
      {uid: "B", amountMinor: 50},
    ]);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(sortByUid(result.deltas), [
      {uid: "A", deltaMinor: 50},
      {uid: "B", deltaMinor: -50},
    ]);
  });
});

describe("computeExpenseBalanceDeltas - input validation", () => {
  it("rejects an empty payerUid", () => {
    const result = computeExpenseBalanceDeltas("", 100, [
      {uid: "a", amountMinor: 100},
    ]);
    assert.equal(result.ok, false);
  });

  it("rejects a non-positive amountMinor", () => {
    const result = computeExpenseBalanceDeltas("payer", 0, [
      {uid: "a", amountMinor: 0},
    ]);
    assert.equal(result.ok, false);
  });

  it("rejects an empty splits array", () => {
    const result = computeExpenseBalanceDeltas("payer", 100, []);
    assert.equal(result.ok, false);
  });

  it("rejects a malformed split uid", () => {
    const result = computeExpenseBalanceDeltas("payer", 100, [
      {uid: "", amountMinor: 100},
    ]);
    assert.equal(result.ok, false);
  });

  it("rejects a NEGATIVE split amountMinor (Checkpoint 6.7A Final Financial Parity Review: zero is valid, negative is not)", () => {
    const result = computeExpenseBalanceDeltas("payer", 100, [
      {uid: "a", amountMinor: -1},
      {uid: "b", amountMinor: 101},
    ]);
    assert.equal(result.ok, false);
  });

  it("rejects a non-safe-integer split amountMinor", () => {
    const result = computeExpenseBalanceDeltas("payer", 100, [
      {uid: "a", amountMinor: 1.5},
    ]);
    assert.equal(result.ok, false);
  });

  it("rejects a per-uid accumulation overflow when combining repeated entries for the same uid", () => {
    // Two split rows for the SAME uid "payer" (a real caller/upstream
    // split-sum validation would never produce this, but this pure
    // function has no such cross-check of its own - it must still fail
    // SAFE rather than silently overflow): crediting 1, then debiting
    // MAX_SAFE_INTEGER twice drives the running total for "payer" past
    // Number.MIN_SAFE_INTEGER.
    const huge = Number.MAX_SAFE_INTEGER;
    const result = computeExpenseBalanceDeltas("payer", 1, [
      {uid: "payer", amountMinor: huge},
      {uid: "payer", amountMinor: huge},
    ]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /overflow/i);
  });
});

describe("computeSettlementBalanceDeltas", () => {
  it("fromUid credited, toUid debited, exactly two entries", () => {
    const result = computeSettlementBalanceDeltas("from", "to", 500);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(sortByUid(result.deltas), [
      {uid: "from", deltaMinor: 500},
      {uid: "to", deltaMinor: -500},
    ]);
  });

  it("rejects fromUid === toUid", () => {
    const result = computeSettlementBalanceDeltas("same", "same", 100);
    assert.equal(result.ok, false);
  });

  it("rejects a non-positive amountMinor", () => {
    const result = computeSettlementBalanceDeltas("from", "to", 0);
    assert.equal(result.ok, false);
  });

  it("rejects an empty fromUid/toUid", () => {
    assert.equal(computeSettlementBalanceDeltas("", "to", 100).ok, false);
    assert.equal(computeSettlementBalanceDeltas("from", "", 100).ok, false);
  });
});

describe("invertBalanceDeltas", () => {
  it("negates every deltaMinor, keeping the same uids", () => {
    const original: NormalizedBalanceDelta[] = [
      {uid: "a", deltaMinor: 60},
      {uid: "b", deltaMinor: -60},
    ];
    assert.deepEqual(invertBalanceDeltas(original), [
      {uid: "a", deltaMinor: -60},
      {uid: "b", deltaMinor: 60},
    ]);
  });

  it("inverting twice returns the original deltas", () => {
    const original: NormalizedBalanceDelta[] = [
      {uid: "a", deltaMinor: 42},
      {uid: "b", deltaMinor: -42},
    ];
    assert.deepEqual(invertBalanceDeltas(invertBalanceDeltas(original)), original);
  });

  it("an explicit zero delta inverts to zero (-0 and 0 are the same value for every arithmetic/persistence purpose)", () => {
    const result = invertBalanceDeltas([{uid: "a", deltaMinor: 0}]);
    assert.equal(result.length, 1);
    assert.equal(result[0].uid, "a");
    // Deliberately `===`, not assert.strict's Object.is-based equal() -
    // JS's -0 === 0 is true, and that is the only guarantee this test
    // needs (Firestore/JSON both persist -0 identically to 0 anyway).
    assert.ok(result[0].deltaMinor === 0);
  });

  it("round-tripping computeExpenseBalanceDeltas through invertBalanceDeltas still sums to zero", () => {
    const forward = computeExpenseBalanceDeltas("payer", 100, [
      {uid: "payer", amountMinor: 40},
      {uid: "other", amountMinor: 60},
    ]);
    assert.ok(forward.ok);
    if (!forward.ok) return;
    const inverse = invertBalanceDeltas(forward.deltas);
    const sum = inverse.reduce((acc, d) => acc + d.deltaMinor, 0);
    assert.equal(sum, 0);
    assert.deepEqual(sortByUid(inverse), [
      {uid: "other", deltaMinor: 60},
      {uid: "payer", deltaMinor: -60},
    ]);
  });
});
