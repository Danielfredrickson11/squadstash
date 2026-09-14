import {
  assertUsdCurrency,
  assertValidExpensePaymentShape,
  computeTripBalances,
} from "../tripSettlement";
import type { Expense, ExpenseSplit, Settlement } from "../../types/domain";

const TRIP_ID = "trip-1";
const FAKE_TIMESTAMP = {} as Expense["createdAt"];

let nextId = 0;
function freshId(prefix: string): string {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

function makeExpense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: freshId("expense"),
    tripId: TRIP_ID,
    payerUid: "payer",
    createdBy: "payer",
    amountMinor: 1000,
    currency: "USD",
    description: "Test expense",
    splitStrategy: "equal",
    paymentSource: "member_out_of_pocket",
    createdAt: FAKE_TIMESTAMP,
    status: "active",
    ...overrides,
  };
}

function makeSplit(expenseId: string, overrides: Partial<ExpenseSplit> = {}): ExpenseSplit {
  return {
    expenseId,
    tripId: TRIP_ID,
    userId: "participant",
    amountMinor: 500,
    createdAt: FAKE_TIMESTAMP,
    ...overrides,
  };
}

function makeSettlement(overrides: Partial<Settlement> = {}): Settlement {
  return {
    id: freshId("settlement"),
    tripId: TRIP_ID,
    fromUid: "a",
    toUid: "b",
    amountMinor: 100,
    currency: "USD",
    method: "cash",
    createdAt: FAKE_TIMESTAMP,
    createdBy: "a",
    ...overrides,
  };
}

describe("assertValidExpensePaymentShape", () => {
  it("accepts a well-formed member_out_of_pocket expense", () => {
    expect(() =>
      assertValidExpensePaymentShape(
        makeExpense({ paymentSource: "member_out_of_pocket", payerUid: "payer" })
      )
    ).not.toThrow();
  });

  it("accepts a well-formed shared_stash expense", () => {
    expect(() =>
      assertValidExpensePaymentShape(
        makeExpense({
          paymentSource: "shared_stash",
          payerUid: null,
          sharedStashTransactionId: "txn-1",
        })
      )
    ).not.toThrow();
  });

  it("37. rejects member_out_of_pocket with a missing payerUid", () => {
    expect(() =>
      assertValidExpensePaymentShape(
        makeExpense({ paymentSource: "member_out_of_pocket", payerUid: null })
      )
    ).toThrow(/requires a non-empty payerUid/);
  });

  it("38. rejects shared_stash with a non-null payerUid", () => {
    expect(() =>
      assertValidExpensePaymentShape(
        makeExpense({
          paymentSource: "shared_stash",
          payerUid: "someone",
          sharedStashTransactionId: "txn-1",
        })
      )
    ).toThrow(/must have a null payerUid/);
  });

  it("rejects member_out_of_pocket carrying a sharedStashTransactionId", () => {
    expect(() =>
      assertValidExpensePaymentShape(
        makeExpense({
          paymentSource: "member_out_of_pocket",
          payerUid: "payer",
          sharedStashTransactionId: "txn-1",
        })
      )
    ).toThrow(/must not have a sharedStashTransactionId/);
  });

  it("rejects shared_stash missing a sharedStashTransactionId", () => {
    expect(() =>
      assertValidExpensePaymentShape(
        makeExpense({ paymentSource: "shared_stash", payerUid: null })
      )
    ).toThrow(/requires a non-empty sharedStashTransactionId/);
  });
});

describe("assertUsdCurrency", () => {
  it("accepts USD", () => {
    expect(() => assertUsdCurrency("USD", "test")).not.toThrow();
  });

  it("rejects any non-USD currency", () => {
    expect(() => assertUsdCurrency("EUR", "test")).toThrow(/must be "USD"/);
    expect(() => assertUsdCurrency("usd", "test")).toThrow(/must be "USD"/);
    expect(() => assertUsdCurrency("", "test")).toThrow(/must be "USD"/);
  });
});

describe("computeTripBalances", () => {
  it("24. payer included in the split produces no self-debt, only non-payer debt", () => {
    const expense = makeExpense({ amountMinor: 300, payerUid: "payer" });
    const splits = [
      makeSplit(expense.id, { userId: "payer", amountMinor: 100 }),
      makeSplit(expense.id, { userId: "alice", amountMinor: 100 }),
      makeSplit(expense.id, { userId: "bob", amountMinor: 100 }),
    ];
    expect(computeTripBalances([expense], splits, [], TRIP_ID)).toEqual([
      { fromUid: "alice", toUid: "payer", amountMinor: 100 },
      { fromUid: "bob", toUid: "payer", amountMinor: 100 },
    ]);
  });

  it("25. payer excluded from the participant list still produces correct debt", () => {
    const expense = makeExpense({ amountMinor: 200, payerUid: "payer" });
    const splits = [
      makeSplit(expense.id, { userId: "alice", amountMinor: 100 }),
      makeSplit(expense.id, { userId: "bob", amountMinor: 100 }),
    ];
    expect(computeTripBalances([expense], splits, [], TRIP_ID)).toEqual([
      { fromUid: "alice", toUid: "payer", amountMinor: 100 },
      { fromUid: "bob", toUid: "payer", amountMinor: 100 },
    ]);
  });

  it("26. a one-member trip (payer is the sole participant) creates no debt", () => {
    const expense = makeExpense({ amountMinor: 50, payerUid: "solo" });
    const splits = [makeSplit(expense.id, { userId: "solo", amountMinor: 50 })];
    expect(computeTripBalances([expense], splits, [], TRIP_ID)).toEqual([]);
  });

  it("27. multiple non-payer participants all owe the payer", () => {
    const expense = makeExpense({ amountMinor: 300, payerUid: "payer" });
    const splits = [
      makeSplit(expense.id, { userId: "a", amountMinor: 100 }),
      makeSplit(expense.id, { userId: "b", amountMinor: 100 }),
      makeSplit(expense.id, { userId: "c", amountMinor: 100 }),
    ];
    expect(computeTripBalances([expense], splits, [], TRIP_ID)).toEqual([
      { fromUid: "a", toUid: "payer", amountMinor: 100 },
      { fromUid: "b", toUid: "payer", amountMinor: 100 },
      { fromUid: "c", toUid: "payer", amountMinor: 100 },
    ]);
  });

  it("28. multiple expenses accumulate into a single net debt", () => {
    const e1 = makeExpense({ amountMinor: 100, payerUid: "p" });
    const e2 = makeExpense({ amountMinor: 60, payerUid: "p" });
    const splits = [
      makeSplit(e1.id, { userId: "p", amountMinor: 50 }),
      makeSplit(e1.id, { userId: "x", amountMinor: 50 }),
      makeSplit(e2.id, { userId: "p", amountMinor: 30 }),
      makeSplit(e2.id, { userId: "x", amountMinor: 30 }),
    ];
    expect(computeTripBalances([e1, e2], splits, [], TRIP_ID)).toEqual([
      { fromUid: "x", toUid: "p", amountMinor: 80 },
    ]);
  });

  it("29. reciprocal pairwise debts from different expenses net down to one obligation", () => {
    // B owes A $100 from expense 1; A owes B $40 from expense 2 -> B owes A $60 net.
    const e1 = makeExpense({ amountMinor: 200, payerUid: "A" });
    const e2 = makeExpense({ amountMinor: 80, payerUid: "B" });
    const splits = [
      makeSplit(e1.id, { userId: "A", amountMinor: 100 }),
      makeSplit(e1.id, { userId: "B", amountMinor: 100 }),
      makeSplit(e2.id, { userId: "B", amountMinor: 40 }),
      makeSplit(e2.id, { userId: "A", amountMinor: 40 }),
    ];
    expect(computeTripBalances([e1, e2], splits, [], TRIP_ID)).toEqual([
      { fromUid: "B", toUid: "A", amountMinor: 60 },
    ]);
  });

  it("30. transitive debts are never simplified (A owes B, B owes C stay separate)", () => {
    const e1 = makeExpense({ amountMinor: 100, payerUid: "B" });
    const e2 = makeExpense({ amountMinor: 100, payerUid: "C" });
    const splits = [
      makeSplit(e1.id, { userId: "B", amountMinor: 50 }),
      makeSplit(e1.id, { userId: "A", amountMinor: 50 }),
      makeSplit(e2.id, { userId: "C", amountMinor: 50 }),
      makeSplit(e2.id, { userId: "B", amountMinor: 50 }),
    ];
    const balances = computeTripBalances([e1, e2], splits, [], TRIP_ID);
    expect(balances).toEqual([
      { fromUid: "A", toUid: "B", amountMinor: 50 },
      { fromUid: "B", toUid: "C", amountMinor: 50 },
    ]);
    // Explicitly never collapsed into a direct A -> C obligation.
    expect(balances.find((b) => b.fromUid === "A" && b.toUid === "C")).toBeUndefined();
  });

  it("31. a settlement reduces (but does not clear) the direct debt it applies to", () => {
    const expense = makeExpense({ amountMinor: 200, payerUid: "B" });
    const splits = [
      makeSplit(expense.id, { userId: "B", amountMinor: 100 }),
      makeSplit(expense.id, { userId: "A", amountMinor: 100 }),
    ];
    const settlement = makeSettlement({ fromUid: "A", toUid: "B", amountMinor: 40 });
    expect(computeTripBalances([expense], splits, [settlement], TRIP_ID)).toEqual([
      { fromUid: "A", toUid: "B", amountMinor: 60 },
    ]);
  });

  it("32. an exact settlement clears the pair entirely (no zero-amount entry)", () => {
    const expense = makeExpense({ amountMinor: 200, payerUid: "B" });
    const splits = [
      makeSplit(expense.id, { userId: "B", amountMinor: 100 }),
      makeSplit(expense.id, { userId: "A", amountMinor: 100 }),
    ];
    const settlement = makeSettlement({ fromUid: "A", toUid: "B", amountMinor: 100 });
    expect(computeTripBalances([expense], splits, [settlement], TRIP_ID)).toEqual([]);
  });

  it("33. an over-settlement reverses the pair's direction, never clamped at zero", () => {
    const expense = makeExpense({ amountMinor: 200, payerUid: "B" });
    const splits = [
      makeSplit(expense.id, { userId: "B", amountMinor: 100 }),
      makeSplit(expense.id, { userId: "A", amountMinor: 100 }),
    ];
    const settlement = makeSettlement({ fromUid: "A", toUid: "B", amountMinor: 150 });
    expect(computeTripBalances([expense], splits, [settlement], TRIP_ID)).toEqual([
      { fromUid: "B", toUid: "A", amountMinor: 50 },
    ]);
  });

  it("34. a settlement only affects its own pair, never an unrelated pair", () => {
    const e1 = makeExpense({ amountMinor: 200, payerUid: "B" });
    const e2 = makeExpense({ amountMinor: 100, payerUid: "B" });
    const splits = [
      makeSplit(e1.id, { userId: "B", amountMinor: 100 }),
      makeSplit(e1.id, { userId: "A", amountMinor: 100 }),
      makeSplit(e2.id, { userId: "B", amountMinor: 50 }),
      makeSplit(e2.id, { userId: "C", amountMinor: 50 }),
    ];
    const settlement = makeSettlement({ fromUid: "A", toUid: "B", amountMinor: 40 });
    expect(computeTripBalances([e1, e2], splits, [settlement], TRIP_ID)).toEqual([
      { fromUid: "A", toUid: "B", amountMinor: 60 },
      { fromUid: "C", toUid: "B", amountMinor: 50 },
    ]);
  });

  it("35. a reversed expense contributes zero debt", () => {
    const expense = makeExpense({ amountMinor: 200, payerUid: "B", status: "reversed" });
    const splits = [
      makeSplit(expense.id, { userId: "B", amountMinor: 100 }),
      makeSplit(expense.id, { userId: "A", amountMinor: 100 }),
    ];
    expect(computeTripBalances([expense], splits, [], TRIP_ID)).toEqual([]);
  });

  it("36. a shared_stash expense contributes zero member-to-member debt, even with splits", () => {
    const expense = makeExpense({
      amountMinor: 200,
      payerUid: null,
      paymentSource: "shared_stash",
      sharedStashTransactionId: "txn-1",
    });
    const splits = [
      makeSplit(expense.id, { userId: "A", amountMinor: 100 }),
      makeSplit(expense.id, { userId: "B", amountMinor: 100 }),
    ];
    expect(computeTripBalances([expense], splits, [], TRIP_ID)).toEqual([]);
  });

  it("37. rejects an out-of-pocket expense with a missing payerUid", () => {
    const expense = makeExpense({ paymentSource: "member_out_of_pocket", payerUid: null });
    expect(() => computeTripBalances([expense], [], [], TRIP_ID)).toThrow(
      /requires a non-empty payerUid/
    );
  });

  it("38. rejects a shared_stash expense with a non-null payerUid", () => {
    const expense = makeExpense({
      paymentSource: "shared_stash",
      payerUid: "someone",
      sharedStashTransactionId: "txn-1",
    });
    expect(() => computeTripBalances([expense], [], [], TRIP_ID)).toThrow(
      /must have a null payerUid/
    );
  });

  it("39. rejects a malformed split total that does not match the expense amount", () => {
    const expense = makeExpense({ amountMinor: 200, payerUid: "B" });
    const splits = [
      makeSplit(expense.id, { userId: "B", amountMinor: 100 }),
      makeSplit(expense.id, { userId: "A", amountMinor: 90 }), // sums to 190, not 200
    ];
    expect(() => computeTripBalances([expense], splits, [], TRIP_ID)).toThrow(
      /sum to 190, expected 200/
    );
  });

  it("40. rejects an orphan split referencing a nonexistent expense", () => {
    const split = makeSplit("does-not-exist", { userId: "A", amountMinor: 100 });
    expect(() => computeTripBalances([], [split], [], TRIP_ID)).toThrow(
      /references nonexistent expense/
    );
  });

  it("41. rejects an expense/split/settlement whose tripId does not match", () => {
    const wrongTripExpense = makeExpense({ tripId: "other-trip" });
    expect(() => computeTripBalances([wrongTripExpense], [], [], TRIP_ID)).toThrow(
      /belongs to Trip/
    );

    const expense = makeExpense();
    const wrongTripSplit = makeSplit(expense.id, { tripId: "other-trip" });
    expect(() => computeTripBalances([expense], [wrongTripSplit], [], TRIP_ID)).toThrow(
      /belongs to a different trip/
    );

    const wrongTripSettlement = makeSettlement({ tripId: "other-trip" });
    expect(() => computeTripBalances([], [], [wrongTripSettlement], TRIP_ID)).toThrow(
      /belongs to a different trip/
    );
  });

  it("42. rejects a non-USD expense", () => {
    const expense = makeExpense({ currency: "EUR" });
    expect(() => computeTripBalances([expense], [], [], TRIP_ID)).toThrow(/must be "USD"/);
  });

  it("43. rejects a non-USD settlement", () => {
    const settlement = makeSettlement({ currency: "EUR" });
    expect(() => computeTripBalances([], [], [settlement], TRIP_ID)).toThrow(/must be "USD"/);
  });

  it("44. rejects a self-settlement (fromUid === toUid)", () => {
    const settlement = makeSettlement({ fromUid: "a", toUid: "a" });
    expect(() => computeTripBalances([], [], [settlement], TRIP_ID)).toThrow(
      /cannot have fromUid === toUid/
    );
  });

  it("45. produces a deterministically ordered result regardless of input order", () => {
    const e1 = makeExpense({ amountMinor: 100, payerUid: "z" });
    const e2 = makeExpense({ amountMinor: 100, payerUid: "m" });
    const e3 = makeExpense({ amountMinor: 100, payerUid: "b" });
    const splits = [
      makeSplit(e1.id, { userId: "z", amountMinor: 50 }),
      makeSplit(e1.id, { userId: "a", amountMinor: 50 }),
      makeSplit(e2.id, { userId: "m", amountMinor: 50 }),
      makeSplit(e2.id, { userId: "k", amountMinor: 50 }),
      makeSplit(e3.id, { userId: "b", amountMinor: 50 }),
      makeSplit(e3.id, { userId: "c", amountMinor: 50 }),
    ];

    const forward = computeTripBalances([e1, e2, e3], splits, [], TRIP_ID);
    const shuffled = computeTripBalances(
      [e3, e1, e2],
      [...splits].reverse(),
      [],
      TRIP_ID
    );

    expect(shuffled).toEqual(forward);
    expect(forward).toEqual([
      { fromUid: "a", toUid: "z", amountMinor: 50 },
      { fromUid: "c", toUid: "b", amountMinor: 50 },
      { fromUid: "k", toUid: "m", amountMinor: 50 },
    ]);
  });

  it("rejects a duplicate split for the same expense/user pair", () => {
    const expense = makeExpense({ amountMinor: 200, payerUid: "B" });
    const splits = [
      makeSplit(expense.id, { userId: "A", amountMinor: 100 }),
      makeSplit(expense.id, { userId: "A", amountMinor: 100 }),
    ];
    expect(() => computeTripBalances([expense], splits, [], TRIP_ID)).toThrow(/duplicate split/);
  });

  it("rejects a malformed (non-integer) settlement amount", () => {
    const settlement = makeSettlement({ amountMinor: 10.5 });
    expect(() => computeTripBalances([], [], [settlement], TRIP_ID)).toThrow(
      /malformed amountMinor/
    );
  });

  it("returns an empty array for a trip with no financial activity at all", () => {
    expect(computeTripBalances([], [], [], TRIP_ID)).toEqual([]);
  });

  // Checkpoint 4B.1 §1: an out-of-pocket expense must always have splits.
  describe("4B.1: out-of-pocket expenses must have splits", () => {
    it("rejects an ACTIVE out-of-pocket expense with zero splits", () => {
      const expense = makeExpense({
        amountMinor: 100,
        payerUid: "payer",
        paymentSource: "member_out_of_pocket",
        status: "active",
      });
      expect(() => computeTripBalances([expense], [], [], TRIP_ID)).toThrow(
        /out-of-pocket expense "expense-\d+" has no splits/
      );
    });

    it("rejects a REVERSED out-of-pocket expense with zero splits - validation is not skipped", () => {
      const expense = makeExpense({
        amountMinor: 100,
        payerUid: "payer",
        paymentSource: "member_out_of_pocket",
        status: "reversed",
      });
      expect(() => computeTripBalances([expense], [], [], TRIP_ID)).toThrow(
        /out-of-pocket expense "expense-\d+" has no splits/
      );
    });

    it("accepts a shared_stash expense with zero splits, producing zero debt", () => {
      const expense = makeExpense({
        amountMinor: 100,
        payerUid: null,
        paymentSource: "shared_stash",
        sharedStashTransactionId: "txn-1",
      });
      expect(computeTripBalances([expense], [], [], TRIP_ID)).toEqual([]);
    });

    it("rejects a shared_stash expense whose (present) splits don't sum to the expense amount", () => {
      const expense = makeExpense({
        amountMinor: 100,
        payerUid: null,
        paymentSource: "shared_stash",
        sharedStashTransactionId: "txn-1",
      });
      const splits = [makeSplit(expense.id, { userId: "A", amountMinor: 40 })]; // should be 100
      expect(() => computeTripBalances([expense], splits, [], TRIP_ID)).toThrow(
        /sum to 40, expected 100/
      );
    });
  });

  // Checkpoint 4B.1 §2: sharedStashTransactionId must be checked for
  // presence, not truthiness - an empty string is a defined value.
  describe("4B.1: sharedStashTransactionId empty-string edge case", () => {
    it("rejects member_out_of_pocket with sharedStashTransactionId: \"\" (falsy but defined)", () => {
      const expense = makeExpense({
        paymentSource: "member_out_of_pocket",
        payerUid: "payer",
        sharedStashTransactionId: "",
      });
      expect(() => assertValidExpensePaymentShape(expense)).toThrow(
        /must not have a sharedStashTransactionId/
      );
    });

    it("still rejects shared_stash with sharedStashTransactionId: \"\" (empty, not truly present)", () => {
      const expense = makeExpense({
        paymentSource: "shared_stash",
        payerUid: null,
        sharedStashTransactionId: "",
      });
      expect(() => assertValidExpensePaymentShape(expense)).toThrow(
        /requires a non-empty sharedStashTransactionId/
      );
    });
  });

  // Checkpoint 4B.1 §4: aggregate arithmetic must independently stay a
  // safe integer, even when every individual addend is safe on its own.
  describe("4B.1: safe-integer aggregate arithmetic", () => {
    it("fails loudly when a per-expense split total would overflow while summing", () => {
      const expense = makeExpense({ amountMinor: 100, payerUid: "payer" });
      const splits = [
        makeSplit(expense.id, { userId: "payer", amountMinor: Number.MAX_SAFE_INTEGER }),
        makeSplit(expense.id, { userId: "A", amountMinor: Number.MAX_SAFE_INTEGER }),
      ];
      expect(() => computeTripBalances([expense], splits, [], TRIP_ID)).toThrow(
        /aggregate sum exceeded the safe integer range/
      );
    });

    it("fails loudly when the running pairwise balance would overflow across multiple expenses", () => {
      // Two separate out-of-pocket expenses, each individually valid and
      // individually safe, both creating debt from "x" to "p" - the
      // ACCUMULATED net between that one pair overflows even though
      // neither expense's own amount or split total does.
      const e1 = makeExpense({ amountMinor: Number.MAX_SAFE_INTEGER, payerUid: "p" });
      const e2 = makeExpense({ amountMinor: Number.MAX_SAFE_INTEGER, payerUid: "p" });
      const splits = [
        makeSplit(e1.id, { userId: "x", amountMinor: Number.MAX_SAFE_INTEGER }),
        makeSplit(e2.id, { userId: "x", amountMinor: Number.MAX_SAFE_INTEGER }),
      ];
      expect(() => computeTripBalances([e1, e2], splits, [], TRIP_ID)).toThrow(
        /running balance between "p" and "x" exceeded the safe integer range/
      );
    });
  });

  // Checkpoint 4B.2: identifiers that affect financial relationships must
  // be real, non-blank strings - never silently normalized/trimmed and
  // persisted, only rejected when invalid.
  describe("4B.2: identifier validation", () => {
    it("1. rejects an empty requested tripId", () => {
      expect(() => computeTripBalances([], [], [], "")).toThrow(
        /computeTripBalances: tripId must be a non-empty identifier/
      );
    });

    it("2. rejects an empty Expense id", () => {
      const expense = makeExpense({ id: "" });
      expect(() => computeTripBalances([expense], [], [], TRIP_ID)).toThrow(
        /computeTripBalances: Expense: id must be a non-empty identifier/
      );
    });

    it("3. rejects a whitespace-only Expense id", () => {
      const expense = makeExpense({ id: "   " });
      expect(() => computeTripBalances([expense], [], [], TRIP_ID)).toThrow(
        /computeTripBalances: Expense: id must be a non-empty identifier/
      );
    });

    it("4. rejects an empty split userId", () => {
      const expense = makeExpense();
      const split = makeSplit(expense.id, { userId: "" });
      expect(() => computeTripBalances([expense], [split], [], TRIP_ID)).toThrow(
        /userId must be a non-empty identifier/
      );
    });

    it("5. rejects a whitespace-only split userId", () => {
      const expense = makeExpense();
      const split = makeSplit(expense.id, { userId: "  \t " });
      expect(() => computeTripBalances([expense], [split], [], TRIP_ID)).toThrow(
        /userId must be a non-empty identifier/
      );
    });

    it("6. rejects an empty Settlement fromUid", () => {
      const settlement = makeSettlement({ fromUid: "" });
      expect(() => computeTripBalances([], [], [settlement], TRIP_ID)).toThrow(
        /fromUid must be a non-empty identifier/
      );
    });

    it("7. rejects an empty Settlement toUid", () => {
      const settlement = makeSettlement({ toUid: "" });
      expect(() => computeTripBalances([], [], [settlement], TRIP_ID)).toThrow(
        /toUid must be a non-empty identifier/
      );
    });

    it("8. rejects a whitespace-only Settlement participant uid", () => {
      const settlement = makeSettlement({ fromUid: "   " });
      expect(() => computeTripBalances([], [], [settlement], TRIP_ID)).toThrow(
        /fromUid must be a non-empty identifier/
      );
    });

    it("9. rejects a whitespace-only payerUid", () => {
      const expense = makeExpense({ payerUid: "   " });
      expect(() => assertValidExpensePaymentShape(expense)).toThrow(
        /requires a non-empty payerUid/
      );
    });

    it("10. rejects a whitespace-only sharedStashTransactionId", () => {
      const expense = makeExpense({
        paymentSource: "shared_stash",
        payerUid: null,
        sharedStashTransactionId: "   ",
      });
      expect(() => assertValidExpensePaymentShape(expense)).toThrow(
        /requires a non-empty sharedStashTransactionId/
      );
    });

    it("11. accepts valid ordinary Firebase-style ids untouched", () => {
      // Realistic Firestore auto-id shape (20 mixed-case alphanumeric
      // characters) - must never be rejected or altered by the new checks.
      const payerUid = "aBcD1234EfGh5678IjKl";
      const otherUid = "zZyY9876XxWw5432VvUu";
      const expense = makeExpense({
        id: "mNoP1234QrSt5678UvWx",
        tripId: TRIP_ID,
        payerUid,
        amountMinor: 200,
      });
      const splits = [
        makeSplit(expense.id, { userId: payerUid, amountMinor: 100 }),
        makeSplit(expense.id, { userId: otherUid, amountMinor: 100 }),
      ];
      expect(computeTripBalances([expense], splits, [], TRIP_ID)).toEqual([
        { fromUid: otherUid, toUid: payerUid, amountMinor: 100 },
      ]);
    });
  });
});
