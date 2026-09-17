// Split-math parity coverage for functions/src/domain/tripExpenseSplits.ts
// against the frozen root implementation, src/domain/tripExpenseSplits.ts
// (Checkpoint 4C.2C §9).
//
// APPROACH USED, AND WHY: a single test importing BOTH implementations and
// running a shared vector table through each was considered first, but
// root tsconfig.json explicitly `exclude`s the entire `functions`
// directory, AND the root project has no `@types/node` dependency at all
// - so a root-side test file importing this Functions-side module (which
// itself imports Node's built-in `crypto`) would break `npm run
// typecheck` with "Cannot find module 'crypto' or its corresponding type
// declarations," a real, concrete TS-project-boundary violation, not a
// hypothetical one. Restructuring the repository into a shared package/
// monorepo to fix that is explicitly out of scope for this checkpoint.
//
// FALLBACK (the approach actually used): this dedicated Functions-side
// suite, run via this package's own `node:test` runner (no Firestore
// emulator needed - this is pure, synchronous domain math, zero I/O).
// Every vector below is HAND-MIRRORED from
// src/domain/__tests__/tripExpenseSplits.test.ts's own test numbering and
// assertions, so a drift between the two implementations shows up as a
// mismatched assertion here, in the exact same shape a human reviewer
// would recognize from the root suite. True cross-package IMPORT parity
// (one test literally running both implementations through the same
// vectors) awaits a future shared package/monorepo refactor - this is
// process-level parity protection, not automatic build-time enforcement,
// and is recorded here honestly as such.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeCustomSplit,
  computeEqualSplit,
  computeExpenseSplits,
  computePercentageSplit,
} from "../src/domain/tripExpenseSplits";

describe("computeEqualSplit (parity with src/domain/tripExpenseSplits.ts)", () => {
  it("1. divides evenly with no remainder", () => {
    assert.deepEqual(computeEqualSplit(900, ["a", "b", "c"]), [
      { uid: "a", amountMinor: 300 },
      { uid: "b", amountMinor: 300 },
      { uid: "c", amountMinor: 300 },
    ]);
  });

  it("2. assigns a single remainder cent to the lexicographically-first uid", () => {
    assert.deepEqual(computeEqualSplit(1000, ["c", "a", "b"]), [
      { uid: "a", amountMinor: 334 },
      { uid: "b", amountMinor: 333 },
      { uid: "c", amountMinor: 333 },
    ]);
  });

  it("3. assigns multiple remainder cents to the first N lexicographic uids", () => {
    assert.deepEqual(computeEqualSplit(104, ["c", "a", "b"]), [
      { uid: "a", amountMinor: 35 },
      { uid: "b", amountMinor: 35 },
      { uid: "c", amountMinor: 34 },
    ]);
  });

  it("4. input array order never affects the result", () => {
    const forward = computeEqualSplit(104, ["a", "b", "c"]);
    const shuffled = computeEqualSplit(104, ["c", "b", "a"]);
    assert.deepEqual(shuffled, forward);
  });

  it("4b. equal amount smaller than participant count still distributes exactly (degenerate remainder case)", () => {
    // $0.02 across 5 people -> base 0, remainder 2 -> two people get 1
    // cent, three get 0 - never a negative/fractional share.
    const result = computeEqualSplit(2, ["a", "b", "c", "d", "e"]);
    assert.deepEqual(result, [
      { uid: "a", amountMinor: 1 },
      { uid: "b", amountMinor: 1 },
      { uid: "c", amountMinor: 0 },
      { uid: "d", amountMinor: 0 },
      { uid: "e", amountMinor: 0 },
    ]);
  });

  it("5. rejects a duplicate participant uid", () => {
    assert.throws(
      () => computeEqualSplit(900, ["a", "a", "b"]),
      /duplicate/i
    );
  });

  it("6. rejects zero participants", () => {
    assert.throws(
      () => computeEqualSplit(900, []),
      /at least one participant/i
    );
  });

  it("7. rejects a non-positive-safe-integer amount", () => {
    assert.throws(() => computeEqualSplit(0, ["a"]), /positive safe integer/i);
    assert.throws(
      () => computeEqualSplit(-100, ["a"]),
      /positive safe integer/i
    );
    assert.throws(
      () => computeEqualSplit(150.5, ["a"]),
      /positive safe integer/i
    );
    assert.throws(
      () => computeEqualSplit(Number.NaN, ["a"]),
      /positive safe integer/i
    );
  });

  it("sums exactly to the input amount even with an odd remainder", () => {
    const result = computeEqualSplit(101, ["a", "b", "c", "d", "e", "f", "g"]);
    assert.equal(
      result.reduce((sum, r) => sum + r.amountMinor, 0),
      101
    );
  });
});

describe("computePercentageSplit (parity with src/domain/tripExpenseSplits.ts)", () => {
  it("8. allocates an exact percentage split with no remainder", () => {
    assert.deepEqual(
      computePercentageSplit(10000, [
        { uid: "a", percentageBasisPoints: 5000 },
        { uid: "b", percentageBasisPoints: 5000 },
      ]),
      [
        { uid: "a", amountMinor: 5000, percentageBasisPoints: 5000 },
        { uid: "b", amountMinor: 5000, percentageBasisPoints: 5000 },
      ]
    );
  });

  it("9. accepts basis points totaling exactly 10000", () => {
    assert.doesNotThrow(() =>
      computePercentageSplit(100, [
        { uid: "a", percentageBasisPoints: 3000 },
        { uid: "b", percentageBasisPoints: 7000 },
      ])
    );
  });

  it("10. rejects a basis-point total of 9999", () => {
    assert.throws(
      () =>
        computePercentageSplit(100, [
          { uid: "a", percentageBasisPoints: 4999 },
          { uid: "b", percentageBasisPoints: 5000 },
        ]),
      /exactly 10000/
    );
  });

  it("11. rejects a basis-point total of 10001", () => {
    assert.throws(
      () =>
        computePercentageSplit(100, [
          { uid: "a", percentageBasisPoints: 5001 },
          { uid: "b", percentageBasisPoints: 5000 },
        ]),
      /exactly 10000/
    );
  });

  it("12. gives the leftover cent to the largest remainder, not the earliest uid", () => {
    const result = computePercentageSplit(100, [
      { uid: "a", percentageBasisPoints: 3333 },
      { uid: "b", percentageBasisPoints: 3333 },
      { uid: "c", percentageBasisPoints: 3334 },
    ]);
    assert.deepEqual(result, [
      { uid: "a", amountMinor: 33, percentageBasisPoints: 3333 },
      { uid: "b", amountMinor: 33, percentageBasisPoints: 3333 },
      { uid: "c", amountMinor: 34, percentageBasisPoints: 3334 },
    ]);
  });

  it("13. breaks an equal remainder tie by ascending uid", () => {
    const result = computePercentageSplit(1, [
      { uid: "b", percentageBasisPoints: 5000 },
      { uid: "a", percentageBasisPoints: 5000 },
    ]);
    assert.deepEqual(result, [
      { uid: "a", amountMinor: 1, percentageBasisPoints: 5000 },
      { uid: "b", amountMinor: 0, percentageBasisPoints: 5000 },
    ]);
  });

  it("14. input array order never affects the result", () => {
    const participants = [
      { uid: "a", percentageBasisPoints: 3333 },
      { uid: "b", percentageBasisPoints: 3333 },
      { uid: "c", percentageBasisPoints: 3334 },
    ];
    const forward = computePercentageSplit(100, participants);
    const shuffled = computePercentageSplit(100, [...participants].reverse());
    assert.deepEqual(shuffled, forward);
  });

  it("15. rejects a duplicate participant uid", () => {
    assert.throws(
      () =>
        computePercentageSplit(100, [
          { uid: "a", percentageBasisPoints: 5000 },
          { uid: "a", percentageBasisPoints: 5000 },
        ]),
      /duplicate/i
    );
  });

  it("16. rejects unsafe/malformed basis points - never a floating percentage", () => {
    assert.throws(
      () =>
        computePercentageSplit(100, [
          { uid: "a", percentageBasisPoints: 33.33 as number },
        ]),
      /non-negative safe integer/i
    );
    assert.throws(
      () =>
        computePercentageSplit(100, [
          { uid: "a", percentageBasisPoints: -100 },
        ]),
      /non-negative safe integer/i
    );
    assert.throws(
      () =>
        computePercentageSplit(100, [
          { uid: "a", percentageBasisPoints: Number.NaN },
        ]),
      /non-negative safe integer/i
    );
  });

  it("17. rejects an amountMinor/basisPoints multiplication that would overflow safe-integer range", () => {
    assert.throws(
      () =>
        computePercentageSplit(Number.MAX_SAFE_INTEGER, [
          { uid: "a", percentageBasisPoints: 10000 },
        ]),
      /overflow/i
    );
  });

  it("(4B.1) fails loudly if summing the basis points themselves would overflow", () => {
    assert.throws(
      () =>
        computePercentageSplit(100, [
          { uid: "a", percentageBasisPoints: Number.MAX_SAFE_INTEGER },
          { uid: "b", percentageBasisPoints: Number.MAX_SAFE_INTEGER },
        ]),
      /aggregate sum exceeded the safe integer range/
    );
  });
});

describe("computeCustomSplit (parity with src/domain/tripExpenseSplits.ts)", () => {
  it("18. accepts custom amounts that sum exactly to the expense total", () => {
    assert.deepEqual(
      computeCustomSplit(100, [
        { uid: "b", amountMinor: 40 },
        { uid: "a", amountMinor: 60 },
      ]),
      [
        { uid: "a", amountMinor: 60 },
        { uid: "b", amountMinor: 40 },
      ]
    );
  });

  it("19. rejects a total that is one cent under", () => {
    assert.throws(
      () =>
        computeCustomSplit(100, [
          { uid: "a", amountMinor: 60 },
          { uid: "b", amountMinor: 39 },
        ]),
      /does not exactly match/
    );
  });

  it("20. rejects a total that is one cent over", () => {
    assert.throws(
      () =>
        computeCustomSplit(100, [
          { uid: "a", amountMinor: 60 },
          { uid: "b", amountMinor: 41 },
        ]),
      /does not exactly match/
    );
  });

  it("21. rejects a duplicate participant uid", () => {
    assert.throws(
      () =>
        computeCustomSplit(100, [
          { uid: "a", amountMinor: 50 },
          { uid: "a", amountMinor: 50 },
        ]),
      /duplicate/i
    );
  });

  it("22. permits an intentional zero-share participant, and keeps them in the result", () => {
    const result = computeCustomSplit(100, [
      { uid: "a", amountMinor: 0 },
      { uid: "b", amountMinor: 100 },
    ]);
    assert.deepEqual(result, [
      { uid: "a", amountMinor: 0 },
      { uid: "b", amountMinor: 100 },
    ]);
  });

  it("23. rejects a malformed (negative or fractional) minor-unit amount", () => {
    assert.throws(
      () =>
        computeCustomSplit(100, [
          { uid: "a", amountMinor: -10 },
          { uid: "b", amountMinor: 110 },
        ]),
      /non-negative safe integer/i
    );
    assert.throws(
      () =>
        computeCustomSplit(100, [
          { uid: "a", amountMinor: 50.5 },
          { uid: "b", amountMinor: 49.5 },
        ]),
      /non-negative safe integer/i
    );
  });

  it("(4B.1) fails loudly on aggregate overflow while summing, rather than comparing an unsafe sum", () => {
    assert.throws(
      () =>
        computeCustomSplit(100, [
          { uid: "a", amountMinor: Number.MAX_SAFE_INTEGER },
          { uid: "b", amountMinor: Number.MAX_SAFE_INTEGER },
        ]),
      /aggregate sum exceeded the safe integer range/
    );
  });
});

describe("computeExpenseSplits - canonical entry point (parity with src/domain/tripExpenseSplits.ts)", () => {
  it("dispatches to computeEqualSplit for strategy: 'equal'", () => {
    assert.deepEqual(
      computeExpenseSplits(900, {
        strategy: "equal",
        participantUids: ["a", "b", "c"],
      }),
      computeEqualSplit(900, ["a", "b", "c"])
    );
  });

  it("dispatches to computePercentageSplit for strategy: 'percentage'", () => {
    const participants = [
      { uid: "a", percentageBasisPoints: 5000 },
      { uid: "b", percentageBasisPoints: 5000 },
    ];
    assert.deepEqual(
      computeExpenseSplits(10000, { strategy: "percentage", participants }),
      computePercentageSplit(10000, participants)
    );
  });

  it("dispatches to computeCustomSplit for strategy: 'custom'", () => {
    const participants = [
      { uid: "a", amountMinor: 60 },
      { uid: "b", amountMinor: 40 },
    ];
    assert.deepEqual(
      computeExpenseSplits(100, { strategy: "custom", participants }),
      computeCustomSplit(100, participants)
    );
  });

  it("propagates the underlying strategy's own validation errors", () => {
    assert.throws(
      () =>
        computeExpenseSplits(100, { strategy: "equal", participantUids: [] }),
      /at least one participant/i
    );
  });
});
