import {
  computeCustomSplit,
  computeEqualSplit,
  computeExpenseSplits,
  computePercentageSplit,
} from "../tripExpenseSplits";

describe("computeEqualSplit", () => {
  it("1. divides evenly with no remainder", () => {
    expect(computeEqualSplit(900, ["a", "b", "c"])).toEqual([
      { uid: "a", amountMinor: 300 },
      { uid: "b", amountMinor: 300 },
      { uid: "c", amountMinor: 300 },
    ]);
  });

  it("2. assigns a single remainder cent to the lexicographically-first uid", () => {
    // $10.00 / 3 people -> 334, 333, 333, extra cent to "a".
    expect(computeEqualSplit(1000, ["c", "a", "b"])).toEqual([
      { uid: "a", amountMinor: 334 },
      { uid: "b", amountMinor: 333 },
      { uid: "c", amountMinor: 333 },
    ]);
  });

  it("3. assigns multiple remainder cents to the first N lexicographic uids", () => {
    // 104 / 3 -> base 34, remainder 2 -> a and b get 35, c gets 34.
    expect(computeEqualSplit(104, ["c", "a", "b"])).toEqual([
      { uid: "a", amountMinor: 35 },
      { uid: "b", amountMinor: 35 },
      { uid: "c", amountMinor: 34 },
    ]);
  });

  it("4. input array order never affects the result", () => {
    const forward = computeEqualSplit(104, ["a", "b", "c"]);
    const shuffled = computeEqualSplit(104, ["c", "b", "a"]);
    expect(shuffled).toEqual(forward);
  });

  it("5. rejects a duplicate participant uid", () => {
    expect(() => computeEqualSplit(900, ["a", "a", "b"])).toThrow(/duplicate/i);
  });

  it("6. rejects zero participants", () => {
    expect(() => computeEqualSplit(900, [])).toThrow(/at least one participant/i);
  });

  it("7. rejects a non-positive-safe-integer amount", () => {
    expect(() => computeEqualSplit(0, ["a"])).toThrow(/positive safe integer/i);
    expect(() => computeEqualSplit(-100, ["a"])).toThrow(/positive safe integer/i);
    expect(() => computeEqualSplit(150.5, ["a"])).toThrow(/positive safe integer/i);
    expect(() => computeEqualSplit(Number.NaN, ["a"])).toThrow(/positive safe integer/i);
  });

  it("sums exactly to the input amount even with an odd remainder", () => {
    const result = computeEqualSplit(101, ["a", "b", "c", "d", "e", "f", "g"]);
    expect(result.reduce((sum, r) => sum + r.amountMinor, 0)).toBe(101);
  });
});

describe("computePercentageSplit", () => {
  it("8. allocates an exact percentage split with no remainder", () => {
    expect(
      computePercentageSplit(10000, [
        { uid: "a", percentageBasisPoints: 5000 },
        { uid: "b", percentageBasisPoints: 5000 },
      ])
    ).toEqual([
      { uid: "a", amountMinor: 5000, percentageBasisPoints: 5000 },
      { uid: "b", amountMinor: 5000, percentageBasisPoints: 5000 },
    ]);
  });

  it("9. accepts basis points totaling exactly 10000", () => {
    expect(() =>
      computePercentageSplit(100, [
        { uid: "a", percentageBasisPoints: 3000 },
        { uid: "b", percentageBasisPoints: 7000 },
      ])
    ).not.toThrow();
  });

  it("10. rejects a basis-point total of 9999", () => {
    expect(() =>
      computePercentageSplit(100, [
        { uid: "a", percentageBasisPoints: 4999 },
        { uid: "b", percentageBasisPoints: 5000 },
      ])
    ).toThrow(/exactly 10000/);
  });

  it("11. rejects a basis-point total of 10001", () => {
    expect(() =>
      computePercentageSplit(100, [
        { uid: "a", percentageBasisPoints: 5001 },
        { uid: "b", percentageBasisPoints: 5000 },
      ])
    ).toThrow(/exactly 10000/);
  });

  it("12. gives the leftover cent to the largest remainder, not the earliest uid", () => {
    // a: floor(333300/10000)=33 rem 3300; b: same as a; c: floor(333400/10000)=33 rem 3400.
    // sum(base)=99, 1 cent left over -> goes to c (largest remainder), not "a".
    const result = computePercentageSplit(100, [
      { uid: "a", percentageBasisPoints: 3333 },
      { uid: "b", percentageBasisPoints: 3333 },
      { uid: "c", percentageBasisPoints: 3334 },
    ]);
    expect(result).toEqual([
      { uid: "a", amountMinor: 33, percentageBasisPoints: 3333 },
      { uid: "b", amountMinor: 33, percentageBasisPoints: 3333 },
      { uid: "c", amountMinor: 34, percentageBasisPoints: 3334 },
    ]);
  });

  it("13. breaks an equal remainder tie by ascending uid", () => {
    // Both at 5000bp of $1.00 (100 minor units) -> base 0, remainder 5000 each (tied).
    // The 1 leftover cent goes to "a" (earlier uid), not "b".
    const result = computePercentageSplit(1, [
      { uid: "b", percentageBasisPoints: 5000 },
      { uid: "a", percentageBasisPoints: 5000 },
    ]);
    expect(result).toEqual([
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
    expect(shuffled).toEqual(forward);
  });

  it("15. rejects a duplicate participant uid", () => {
    expect(() =>
      computePercentageSplit(100, [
        { uid: "a", percentageBasisPoints: 5000 },
        { uid: "a", percentageBasisPoints: 5000 },
      ])
    ).toThrow(/duplicate/i);
  });

  it("16. rejects unsafe/malformed basis points - never a floating percentage", () => {
    expect(() =>
      computePercentageSplit(100, [{ uid: "a", percentageBasisPoints: 33.33 as number }])
    ).toThrow(/non-negative safe integer/i);
    expect(() =>
      computePercentageSplit(100, [{ uid: "a", percentageBasisPoints: -100 }])
    ).toThrow(/non-negative safe integer/i);
    expect(() =>
      computePercentageSplit(100, [{ uid: "a", percentageBasisPoints: Number.NaN }])
    ).toThrow(/non-negative safe integer/i);
  });

  it("17. rejects an amountMinor/basisPoints multiplication that would overflow safe-integer range", () => {
    expect(() =>
      computePercentageSplit(Number.MAX_SAFE_INTEGER, [
        { uid: "a", percentageBasisPoints: 10000 },
      ])
    ).toThrow(/overflow/i);
  });

  it("(4B.1) fails loudly if summing the basis points themselves would overflow", () => {
    // Each individual percentageBasisPoints value is independently a
    // valid safe non-negative integer, but their sum overflows before
    // it can ever be compared to the required total of 10000.
    expect(() =>
      computePercentageSplit(100, [
        { uid: "a", percentageBasisPoints: Number.MAX_SAFE_INTEGER },
        { uid: "b", percentageBasisPoints: Number.MAX_SAFE_INTEGER },
      ])
    ).toThrow(/aggregate sum exceeded the safe integer range/);
  });
});

describe("computeCustomSplit", () => {
  it("18. accepts custom amounts that sum exactly to the expense total", () => {
    expect(
      computeCustomSplit(100, [
        { uid: "b", amountMinor: 40 },
        { uid: "a", amountMinor: 60 },
      ])
    ).toEqual([
      { uid: "a", amountMinor: 60 },
      { uid: "b", amountMinor: 40 },
    ]);
  });

  it("19. rejects a total that is one cent under", () => {
    expect(() =>
      computeCustomSplit(100, [
        { uid: "a", amountMinor: 60 },
        { uid: "b", amountMinor: 39 },
      ])
    ).toThrow(/does not exactly match/);
  });

  it("20. rejects a total that is one cent over", () => {
    expect(() =>
      computeCustomSplit(100, [
        { uid: "a", amountMinor: 60 },
        { uid: "b", amountMinor: 41 },
      ])
    ).toThrow(/does not exactly match/);
  });

  it("21. rejects a duplicate participant uid", () => {
    expect(() =>
      computeCustomSplit(100, [
        { uid: "a", amountMinor: 50 },
        { uid: "a", amountMinor: 50 },
      ])
    ).toThrow(/duplicate/i);
  });

  it("22. permits an intentional zero-share participant, and keeps them in the result", () => {
    const result = computeCustomSplit(100, [
      { uid: "a", amountMinor: 0 },
      { uid: "b", amountMinor: 100 },
    ]);
    expect(result).toEqual([
      { uid: "a", amountMinor: 0 },
      { uid: "b", amountMinor: 100 },
    ]);
  });

  it("23. rejects a malformed (negative or fractional) minor-unit amount", () => {
    expect(() =>
      computeCustomSplit(100, [{ uid: "a", amountMinor: -10 }, { uid: "b", amountMinor: 110 }])
    ).toThrow(/non-negative safe integer/i);
    expect(() =>
      computeCustomSplit(100, [{ uid: "a", amountMinor: 50.5 }, { uid: "b", amountMinor: 49.5 }])
    ).toThrow(/non-negative safe integer/i);
  });

  it("(4B.1) fails loudly on aggregate overflow while summing, rather than comparing an unsafe sum", () => {
    // Each individual amount is itself a safe integer, but their sum
    // overflows before it can ever be compared to the (mismatched,
    // deliberately small) total - the overflow error must fire first.
    expect(() =>
      computeCustomSplit(100, [
        { uid: "a", amountMinor: Number.MAX_SAFE_INTEGER },
        { uid: "b", amountMinor: Number.MAX_SAFE_INTEGER },
      ])
    ).toThrow(/aggregate sum exceeded the safe integer range/);
  });
});

describe("computeExpenseSplits (canonical entry point)", () => {
  it("dispatches to computeEqualSplit for strategy: 'equal'", () => {
    expect(
      computeExpenseSplits(900, { strategy: "equal", participantUids: ["a", "b", "c"] })
    ).toEqual(computeEqualSplit(900, ["a", "b", "c"]));
  });

  it("dispatches to computePercentageSplit for strategy: 'percentage'", () => {
    const participants = [
      { uid: "a", percentageBasisPoints: 5000 },
      { uid: "b", percentageBasisPoints: 5000 },
    ];
    expect(computeExpenseSplits(10000, { strategy: "percentage", participants })).toEqual(
      computePercentageSplit(10000, participants)
    );
  });

  it("dispatches to computeCustomSplit for strategy: 'custom'", () => {
    const participants = [
      { uid: "a", amountMinor: 60 },
      { uid: "b", amountMinor: 40 },
    ];
    expect(computeExpenseSplits(100, { strategy: "custom", participants })).toEqual(
      computeCustomSplit(100, participants)
    );
  });

  it("propagates the underlying strategy's own validation errors", () => {
    expect(() =>
      computeExpenseSplits(100, { strategy: "equal", participantUids: [] })
    ).toThrow(/at least one participant/i);
  });
});
