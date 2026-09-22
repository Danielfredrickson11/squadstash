import {
  canSelectParticipant,
  canonicalizeCustomParticipants,
  canonicalizeEqualParticipants,
  canonicalizePercentageParticipants,
  defaultParticipantSelection,
  deriveCurrentMemberUids,
  expenseCreationFactsEqual,
  parseExpenseMoneyInput,
  parseExpenseShareMoneyInput,
  parsePercentageToBasisPoints,
  resolveExpenseClientRequestId,
  sumSafeIntegers,
  validateExpenseCategory,
  validateExpenseDescription,
  type ExpenseCreationFacts,
  type PendingExpenseCreationRequest,
} from "../expenseSubmission";

// =======================================================================
// STRICT MONEY INPUT (§13/§14/§15)
// =======================================================================

describe("parseExpenseMoneyInput", () => {
  it.each([
    ["12", 1200],
    ["12.5", 1250],
    ["12.50", 1250],
    ["$12", 1200],
    ["$12.50", 1250],
    ["1,234.56", 123456],
    ["$1,234.56", 123456],
  ])("parses %s -> %i minor units", (input, expected) => {
    const result = parseExpenseMoneyInput(input);
    expect(result).toEqual({ ok: true, amountMinor: expected });
  });

  it("trims leading/trailing whitespace around a valid amount", () => {
    expect(parseExpenseMoneyInput("  12.50  ")).toEqual({ ok: true, amountMinor: 1250 });
  });

  it.each(["-12", "-$12"])("rejects a negative amount (%s)", (input) => {
    expect(parseExpenseMoneyInput(input)).toEqual({ ok: false, error: "Enter a positive amount." });
  });

  it.each(["abc12", "12abc", "abc12.50", "1..2", "12,34", "$$12"])(
    "rejects malformed/unsupported input (%s)",
    (input) => {
      expect(parseExpenseMoneyInput(input)).toEqual({ ok: false, error: "Enter a valid amount." });
    }
  );

  it("rejects an empty string", () => {
    expect(parseExpenseMoneyInput("")).toEqual({ ok: false, error: "Enter a valid amount." });
  });

  it("rejects a whitespace-only string", () => {
    expect(parseExpenseMoneyInput("   ")).toEqual({ ok: false, error: "Enter a valid amount." });
  });

  it("rejects more than 2 decimal places", () => {
    expect(parseExpenseMoneyInput("12.555")).toEqual({
      ok: false,
      error: "Enter an amount with at most 2 decimal places.",
    });
  });

  it.each(["0", "0.00", "$0", "$0.00"])("rejects a zero amount (%s)", (input) => {
    expect(parseExpenseMoneyInput(input)).toEqual({
      ok: false,
      error: "Enter an amount greater than $0.",
    });
  });

  it("rejects a shape-valid amount whose minor-unit result is unsafe", () => {
    const result = parseExpenseMoneyInput("99999999999999999");
    expect(result).toEqual({ ok: false, error: "Enter a smaller amount." });
  });

  it("never produces a positive amount from garbage text via character stripping", () => {
    // Regression guard for the exact hole the frozen preflight (§12)
    // withdrew: "abc12.50" must never silently become $12.50.
    expect(parseExpenseMoneyInput("abc12.50")).toEqual({ ok: false, error: "Enter a valid amount." });
  });
});

// =======================================================================
// DESCRIPTION / CATEGORY (§11/§12)
// =======================================================================

describe("validateExpenseDescription", () => {
  it("trims and accepts a valid description", () => {
    expect(validateExpenseDescription("  Cabin rental  ")).toEqual({ ok: true, value: "Cabin rental" });
  });

  it("rejects an empty description", () => {
    expect(validateExpenseDescription("")).toEqual({ ok: false, error: "Enter a description." });
  });

  it("rejects a whitespace-only description", () => {
    expect(validateExpenseDescription("   ")).toEqual({ ok: false, error: "Enter a description." });
  });

  it("accepts exactly 500 characters", () => {
    const value = "x".repeat(500);
    expect(validateExpenseDescription(value)).toEqual({ ok: true, value });
  });

  it("rejects 501 characters", () => {
    expect(validateExpenseDescription("x".repeat(501))).toEqual({
      ok: false,
      error: "Description must be 500 characters or fewer.",
    });
  });
});

describe("validateExpenseCategory", () => {
  it("omits an empty category (value: null), not a validation failure", () => {
    expect(validateExpenseCategory("")).toEqual({ ok: true, value: null });
  });

  it("omits a whitespace-only category", () => {
    expect(validateExpenseCategory("   ")).toEqual({ ok: true, value: null });
  });

  it("trims and accepts a valid category", () => {
    expect(validateExpenseCategory("  Food  ")).toEqual({ ok: true, value: "Food" });
  });

  it("accepts exactly 100 characters", () => {
    const value = "x".repeat(100);
    expect(validateExpenseCategory(value)).toEqual({ ok: true, value });
  });

  it("rejects 101 characters", () => {
    expect(validateExpenseCategory("x".repeat(101))).toEqual({
      ok: false,
      error: "Category must be 100 characters or fewer.",
    });
  });
});

// =======================================================================
// CURRENT-MEMBER SET + PARTICIPANT CAP (§8/§18/§19)
// =======================================================================

describe("deriveCurrentMemberUids", () => {
  it("dedupes owner appearing in both ownerId and memberIds", () => {
    expect(deriveCurrentMemberUids("owner-1", ["owner-1", "member-2"])).toEqual(
      expect.arrayContaining(["owner-1", "member-2"])
    );
    expect(deriveCurrentMemberUids("owner-1", ["owner-1", "member-2"]).length).toBe(2);
  });

  it("ignores malformed/empty entries", () => {
    const uids = deriveCurrentMemberUids("owner-1", ["", null, undefined, "member-2"]);
    expect(uids.sort()).toEqual(["member-2", "owner-1"]);
  });

  it("ignores a malformed/empty ownerId", () => {
    expect(deriveCurrentMemberUids("", ["member-1"])).toEqual(["member-1"]);
    expect(deriveCurrentMemberUids(null, ["member-1"])).toEqual(["member-1"]);
  });

  it("handles a missing memberIds array", () => {
    expect(deriveCurrentMemberUids("owner-1", null)).toEqual(["owner-1"]);
    expect(deriveCurrentMemberUids("owner-1", undefined)).toEqual(["owner-1"]);
  });
});

describe("defaultParticipantSelection", () => {
  it("selects all 99 members by default when count is 99", () => {
    const uids = Array.from({ length: 99 }, (_, i) => `uid-${i}`);
    const selected = defaultParticipantSelection(uids, "uid-0");
    expect(selected.size).toBe(99);
    uids.forEach((uid) => expect(selected.has(uid)).toBe(true));
  });

  it("selects all 100 members by default when count is exactly 100", () => {
    const uids = Array.from({ length: 100 }, (_, i) => `uid-${i}`);
    const selected = defaultParticipantSelection(uids, "uid-0");
    expect(selected.size).toBe(100);
  });

  it("selects ONLY the current user by default when count is 101", () => {
    const uids = Array.from({ length: 101 }, (_, i) => `uid-${i}`);
    const selected = defaultParticipantSelection(uids, "uid-42");
    expect(selected.size).toBe(1);
    expect(selected.has("uid-42")).toBe(true);
  });
});

describe("canSelectParticipant", () => {
  it("blocks adding a 101st participant once 100 are already selected", () => {
    const selected = new Set(Array.from({ length: 100 }, (_, i) => `uid-${i}`));
    expect(canSelectParticipant(selected, "uid-100")).toBe(false);
  });

  it("always allows a uid that is already selected (deselection is never blocked)", () => {
    const selected = new Set(Array.from({ length: 100 }, (_, i) => `uid-${i}`));
    expect(canSelectParticipant(selected, "uid-0")).toBe(true);
  });

  it("allows selecting another member after deselecting below the cap", () => {
    const selected = new Set(Array.from({ length: 100 }, (_, i) => `uid-${i}`));
    selected.delete("uid-0");
    expect(selected.size).toBe(99);
    expect(canSelectParticipant(selected, "uid-100")).toBe(true);
  });

  it("allows adding when well under the cap", () => {
    const selected = new Set(["uid-0", "uid-1"]);
    expect(canSelectParticipant(selected, "uid-2")).toBe(true);
  });
});

describe("canonicalizeEqualParticipants", () => {
  it("sorts uids ascending", () => {
    expect(canonicalizeEqualParticipants(["c", "a", "b"])).toEqual([
      { uid: "a" },
      { uid: "b" },
      { uid: "c" },
    ]);
  });

  it("dedupes duplicate uids", () => {
    expect(canonicalizeEqualParticipants(["a", "b", "a"])).toEqual([{ uid: "a" }, { uid: "b" }]);
  });
});

// =======================================================================
// EXPENSE CREATION FACTS / IDEMPOTENCY (§22/§23/§24)
// =======================================================================

function baseFacts(overrides: Partial<ExpenseCreationFacts> = {}): ExpenseCreationFacts {
  return {
    tripId: "trip-1",
    payerUid: "member-1",
    amountMinor: 9000,
    currency: "USD",
    description: "Cabin rental",
    category: null,
    paymentSource: "member_out_of_pocket",
    occurredAtInstantMs: null,
    replacesExpenseId: null,
    splitStrategy: "equal",
    participants: canonicalizeEqualParticipants(["member-1", "member-2"]),
    ...overrides,
  } as ExpenseCreationFacts;
}

describe("expenseCreationFactsEqual", () => {
  it("is true for identical facts", () => {
    expect(expenseCreationFactsEqual(baseFacts(), baseFacts())).toBe(true);
  });

  it("is true when canonicalized participant order is the same regardless of pre-canonicalization input order", () => {
    const a = baseFacts({ participants: canonicalizeEqualParticipants(["member-2", "member-1"]) });
    const b = baseFacts({ participants: canonicalizeEqualParticipants(["member-1", "member-2"]) });
    expect(expenseCreationFactsEqual(a, b)).toBe(true);
  });

  it("is false when tripId changes", () => {
    expect(expenseCreationFactsEqual(baseFacts(), baseFacts({ tripId: "trip-2" }))).toBe(false);
  });

  it("is false when payerUid changes", () => {
    expect(expenseCreationFactsEqual(baseFacts(), baseFacts({ payerUid: "member-3" }))).toBe(false);
  });

  it("is false when amountMinor changes", () => {
    expect(expenseCreationFactsEqual(baseFacts(), baseFacts({ amountMinor: 9001 }))).toBe(false);
  });

  it("is false when description changes", () => {
    expect(expenseCreationFactsEqual(baseFacts(), baseFacts({ description: "Taxi" }))).toBe(false);
  });

  it("is false when category changes", () => {
    expect(expenseCreationFactsEqual(baseFacts(), baseFacts({ category: "Food" }))).toBe(false);
  });

  it("is false when occurredAtInstantMs changes", () => {
    expect(
      expenseCreationFactsEqual(baseFacts(), baseFacts({ occurredAtInstantMs: 1700000000000 }))
    ).toBe(false);
  });

  it("is false when replacesExpenseId changes", () => {
    expect(
      expenseCreationFactsEqual(baseFacts(), baseFacts({ replacesExpenseId: "old-expense-1" }))
    ).toBe(false);
  });

  it("is false when the participant membership changes (a genuinely different participant set)", () => {
    const a = baseFacts({ participants: canonicalizeEqualParticipants(["member-1", "member-2"]) });
    const b = baseFacts({ participants: canonicalizeEqualParticipants(["member-1", "member-3"]) });
    expect(expenseCreationFactsEqual(a, b)).toBe(false);
  });

  it("is false when the participant count changes", () => {
    const a = baseFacts({ participants: canonicalizeEqualParticipants(["member-1", "member-2"]) });
    const b = baseFacts({
      participants: canonicalizeEqualParticipants(["member-1", "member-2", "member-3"]),
    });
    expect(expenseCreationFactsEqual(a, b)).toBe(false);
  });

  it("is false when splitStrategy differs (future-discriminant safety)", () => {
    const a = baseFacts();
    const b: ExpenseCreationFacts = {
      ...baseFacts(),
      splitStrategy: "percentage",
      participants: [{ uid: "member-1", percentageBasisPoints: 5000 }, { uid: "member-2", percentageBasisPoints: 5000 }],
    };
    expect(expenseCreationFactsEqual(a, b)).toBe(false);
  });
});

describe("resolveExpenseClientRequestId", () => {
  function makeGenerator() {
    let counter = 0;
    return () => `generated-${++counter}`;
  }

  it("generates a fresh id when no pending request exists", () => {
    const pendingRef: { current: PendingExpenseCreationRequest | null } = { current: null };
    const id = resolveExpenseClientRequestId(pendingRef, baseFacts(), makeGenerator());
    expect(id).toBe("generated-1");
    expect(pendingRef.current?.clientRequestId).toBe("generated-1");
  });

  it("reuses the same id when the facts are unchanged (retry)", () => {
    const generator = makeGenerator();
    const pendingRef: { current: PendingExpenseCreationRequest | null } = { current: null };
    const first = resolveExpenseClientRequestId(pendingRef, baseFacts(), generator);
    const second = resolveExpenseClientRequestId(pendingRef, baseFacts(), generator);
    expect(second).toBe(first);
  });

  it("mints a fresh id when amountMinor changes", () => {
    const generator = makeGenerator();
    const pendingRef: { current: PendingExpenseCreationRequest | null } = { current: null };
    const first = resolveExpenseClientRequestId(pendingRef, baseFacts(), generator);
    const second = resolveExpenseClientRequestId(pendingRef, baseFacts({ amountMinor: 5000 }), generator);
    expect(second).not.toBe(first);
  });

  it("mints a fresh id when the participant set genuinely changes", () => {
    const generator = makeGenerator();
    const pendingRef: { current: PendingExpenseCreationRequest | null } = { current: null };
    const first = resolveExpenseClientRequestId(
      pendingRef,
      baseFacts({ participants: canonicalizeEqualParticipants(["member-1", "member-2"]) }),
      generator
    );
    const second = resolveExpenseClientRequestId(
      pendingRef,
      baseFacts({ participants: canonicalizeEqualParticipants(["member-1", "member-3"]) }),
      generator
    );
    expect(second).not.toBe(first);
  });

  it("reuses the same id when participant input order differs but canonicalizes identically", () => {
    const generator = makeGenerator();
    const pendingRef: { current: PendingExpenseCreationRequest | null } = { current: null };
    const first = resolveExpenseClientRequestId(
      pendingRef,
      baseFacts({ participants: canonicalizeEqualParticipants(["member-2", "member-1"]) }),
      generator
    );
    const second = resolveExpenseClientRequestId(
      pendingRef,
      baseFacts({ participants: canonicalizeEqualParticipants(["member-1", "member-2"]) }),
      generator
    );
    expect(second).toBe(first);
  });

  it("mints a fresh id when occurredAtInstantMs changes", () => {
    const generator = makeGenerator();
    const pendingRef: { current: PendingExpenseCreationRequest | null } = { current: null };
    const first = resolveExpenseClientRequestId(pendingRef, baseFacts(), generator);
    const second = resolveExpenseClientRequestId(
      pendingRef,
      baseFacts({ occurredAtInstantMs: 1700000000000 }),
      generator
    );
    expect(second).not.toBe(first);
  });

  it("mints a fresh id when replacesExpenseId changes", () => {
    const generator = makeGenerator();
    const pendingRef: { current: PendingExpenseCreationRequest | null } = { current: null };
    const first = resolveExpenseClientRequestId(pendingRef, baseFacts(), generator);
    const second = resolveExpenseClientRequestId(
      pendingRef,
      baseFacts({ replacesExpenseId: "old-expense-1" }),
      generator
    );
    expect(second).not.toBe(first);
  });

  it("mints a fresh id when tripId changes", () => {
    const generator = makeGenerator();
    const pendingRef: { current: PendingExpenseCreationRequest | null } = { current: null };
    const first = resolveExpenseClientRequestId(pendingRef, baseFacts(), generator);
    const second = resolveExpenseClientRequestId(pendingRef, baseFacts({ tripId: "trip-2" }), generator);
    expect(second).not.toBe(first);
  });

  it("mints a fresh id when payerUid changes", () => {
    const generator = makeGenerator();
    const pendingRef: { current: PendingExpenseCreationRequest | null } = { current: null };
    const first = resolveExpenseClientRequestId(pendingRef, baseFacts(), generator);
    const second = resolveExpenseClientRequestId(
      pendingRef,
      baseFacts({ payerUid: "member-9" }),
      generator
    );
    expect(second).not.toBe(first);
  });

  it("mints a fresh id when description changes", () => {
    const generator = makeGenerator();
    const pendingRef: { current: PendingExpenseCreationRequest | null } = { current: null };
    const first = resolveExpenseClientRequestId(pendingRef, baseFacts(), generator);
    const second = resolveExpenseClientRequestId(
      pendingRef,
      baseFacts({ description: "Taxi" }),
      generator
    );
    expect(second).not.toBe(first);
  });

  it("mints a fresh id when category changes", () => {
    const generator = makeGenerator();
    const pendingRef: { current: PendingExpenseCreationRequest | null } = { current: null };
    const first = resolveExpenseClientRequestId(pendingRef, baseFacts(), generator);
    const second = resolveExpenseClientRequestId(pendingRef, baseFacts({ category: "Food" }), generator);
    expect(second).not.toBe(first);
  });
});

// =======================================================================
// PERCENTAGE PARSER (Checkpoint 4D.4 §7/§8/§9/§36)
// =======================================================================

describe("parsePercentageToBasisPoints", () => {
  it.each([
    ["0", 0],
    ["0.5", 50],
    ["0.50", 50],
    ["1", 100],
    ["25", 2500],
    ["33.33", 3333],
    ["50", 5000],
    ["100", 10000],
    ["100.00", 10000],
  ])("parses %s -> %i basis points", (input, expected) => {
    expect(parsePercentageToBasisPoints(input)).toEqual({ ok: true, percentageBasisPoints: expected });
  });

  it("accepts surrounding whitespace", () => {
    expect(parsePercentageToBasisPoints("  50  ")).toEqual({ ok: true, percentageBasisPoints: 5000 });
  });

  it.each(["", " ", ".5", "50%", "abc", "1..2"])(
    "rejects malformed/unsupported input (%s) with a valid-percentage error",
    (input) => {
      expect(parsePercentageToBasisPoints(input)).toEqual({
        ok: false,
        error: "Enter a valid percentage.",
      });
    }
  );

  it("rejects a negative percentage", () => {
    expect(parsePercentageToBasisPoints("-1")).toEqual({
      ok: false,
      error: "Enter a percentage from 0 to 100.",
    });
  });

  it("rejects a percentage over 100", () => {
    expect(parsePercentageToBasisPoints("100.01")).toEqual({
      ok: false,
      error: "Enter a percentage from 0 to 100.",
    });
  });

  it("rejects more than 2 decimal places", () => {
    expect(parsePercentageToBasisPoints("33.333")).toEqual({
      ok: false,
      error: "Use at most 2 decimal places.",
    });
  });

  it("never accepts a literal % suffix", () => {
    expect(parsePercentageToBasisPoints("50%").ok).toBe(false);
  });
});

// =======================================================================
// CUSTOM SHARE MONEY (Checkpoint 4D.4 §13/§14/§37)
// =======================================================================

describe("parseExpenseShareMoneyInput", () => {
  it.each([
    ["0", 0],
    ["0.00", 0],
    ["$0", 0],
    ["12", 1200],
    ["12.50", 1250],
    ["$12.50", 1250],
    ["1,234.56", 123456],
  ])("parses %s -> %i minor units (zero is a valid share)", (input, expected) => {
    expect(parseExpenseShareMoneyInput(input)).toEqual({ ok: true, amountMinor: expected });
  });

  it("rejects a blank share", () => {
    expect(parseExpenseShareMoneyInput("")).toEqual({ ok: false, error: "Enter a valid amount." });
  });

  it("rejects a negative share with the custom-specific message", () => {
    expect(parseExpenseShareMoneyInput("-12")).toEqual({
      ok: false,
      error: "Enter a non-negative amount.",
    });
  });

  it("rejects letters", () => {
    expect(parseExpenseShareMoneyInput("abc12")).toEqual({ ok: false, error: "Enter a valid amount." });
  });

  it("rejects malformed comma grouping", () => {
    expect(parseExpenseShareMoneyInput("12,34")).toEqual({ ok: false, error: "Enter a valid amount." });
  });

  it("rejects more than 2 decimal places", () => {
    expect(parseExpenseShareMoneyInput("12.555")).toEqual({
      ok: false,
      error: "Enter an amount with at most 2 decimal places.",
    });
  });

  it("rejects an unsafe-large share", () => {
    expect(parseExpenseShareMoneyInput("99999999999999999")).toEqual({
      ok: false,
      error: "Enter a smaller amount.",
    });
  });
});

describe("parseExpenseMoneyInput still rejects zero for the total Expense amount", () => {
  it.each(["0", "0.00", "$0"])("rejects %s", (input) => {
    expect(parseExpenseMoneyInput(input)).toEqual({
      ok: false,
      error: "Enter an amount greater than $0.",
    });
  });
});

// =======================================================================
// PERCENTAGE / CUSTOM CANONICALIZATION (Checkpoint 4D.4 §23/§24/§38)
// =======================================================================

describe("canonicalizePercentageParticipants", () => {
  it("sorts by ascending uid", () => {
    expect(
      canonicalizePercentageParticipants([
        { uid: "b", percentageBasisPoints: 4000 },
        { uid: "a", percentageBasisPoints: 6000 },
      ])
    ).toEqual([
      { uid: "a", percentageBasisPoints: 6000 },
      { uid: "b", percentageBasisPoints: 4000 },
    ]);
  });

  it("retains exact integer basis points (no float conversion)", () => {
    const result = canonicalizePercentageParticipants([{ uid: "a", percentageBasisPoints: 3333 }]);
    expect(result[0].percentageBasisPoints).toBe(3333);
  });

  it("throws on a duplicate uid rather than silently picking one value", () => {
    expect(() =>
      canonicalizePercentageParticipants([
        { uid: "a", percentageBasisPoints: 5000 },
        { uid: "a", percentageBasisPoints: 6000 },
      ])
    ).toThrow(/duplicate participant uid/);
  });
});

describe("canonicalizeCustomParticipants", () => {
  it("sorts by ascending uid", () => {
    expect(
      canonicalizeCustomParticipants([
        { uid: "b", amountMinor: 400 },
        { uid: "a", amountMinor: 600 },
      ])
    ).toEqual([
      { uid: "a", amountMinor: 600 },
      { uid: "b", amountMinor: 400 },
    ]);
  });

  it("retains exact integer minor units", () => {
    const result = canonicalizeCustomParticipants([{ uid: "a", amountMinor: 0 }]);
    expect(result[0].amountMinor).toBe(0);
  });

  it("throws on a duplicate uid rather than silently picking one value", () => {
    expect(() =>
      canonicalizeCustomParticipants([
        { uid: "a", amountMinor: 500 },
        { uid: "a", amountMinor: 600 },
      ])
    ).toThrow(/duplicate participant uid/);
  });
});

// =======================================================================
// AGGREGATES (Checkpoint 4D.4 §10/§16/§39)
// =======================================================================

describe("sumSafeIntegers (percentage/custom aggregate arithmetic)", () => {
  it("sums an exact percentage total (5000 + 5000 = 10000)", () => {
    expect(sumSafeIntegers([5000, 5000])).toBe(10000);
  });

  it("sums a 3-way split with a remainder (3333 + 3333 + 3334 = 10000)", () => {
    expect(sumSafeIntegers([3333, 3333, 3334])).toBe(10000);
  });

  it("returns a total that is NOT 10000 for an under-total percentage split (9999)", () => {
    expect(sumSafeIntegers([4999, 5000])).toBe(9999);
  });

  it("returns a total that is NOT 10000 for an over-total percentage split (10001)", () => {
    expect(sumSafeIntegers([5001, 5000])).toBe(10001);
  });

  it("sums a matching custom split (500 + 500 = 1000)", () => {
    expect(sumSafeIntegers([500, 500])).toBe(1000);
  });

  it("sums a $0 + full-amount custom split (0 + 1000 = 1000)", () => {
    expect(sumSafeIntegers([0, 1000])).toBe(1000);
  });

  it("returns an under-total for a short custom split (499 + 500 = 999, not 1000)", () => {
    expect(sumSafeIntegers([499, 500])).toBe(999);
  });

  it("returns an over-total for an excess custom split (600 + 500 = 1100, not 1000)", () => {
    expect(sumSafeIntegers([600, 500])).toBe(1100);
  });

  it("fails closed (returns null) when the running total overflows the safe-integer range", () => {
    expect(sumSafeIntegers([Number.MAX_SAFE_INTEGER, 1])).toBeNull();
  });
});

// =======================================================================
// STRATEGY IDEMPOTENCY SAFETY (Checkpoint 4D.4 §26/§40)
// =======================================================================

describe("expenseCreationFactsEqual across split strategies", () => {
  function percentageFacts(overrides: Partial<ExpenseCreationFacts> = {}): ExpenseCreationFacts {
    return {
      ...baseFacts(),
      splitStrategy: "percentage",
      participants: canonicalizePercentageParticipants([
        { uid: "member-1", percentageBasisPoints: 5000 },
        { uid: "member-2", percentageBasisPoints: 5000 },
      ]),
      ...overrides,
    } as ExpenseCreationFacts;
  }

  function customFacts(overrides: Partial<ExpenseCreationFacts> = {}): ExpenseCreationFacts {
    return {
      ...baseFacts(),
      splitStrategy: "custom",
      participants: canonicalizeCustomParticipants([
        { uid: "member-1", amountMinor: 4500 },
        { uid: "member-2", amountMinor: 4500 },
      ]),
      ...overrides,
    } as ExpenseCreationFacts;
  }

  it("equal facts are NOT equal to percentage facts, even with the same amount/participants", () => {
    expect(expenseCreationFactsEqual(baseFacts(), percentageFacts())).toBe(false);
  });

  it("equal facts are NOT equal to custom facts", () => {
    expect(expenseCreationFactsEqual(baseFacts(), customFacts())).toBe(false);
  });

  it("percentage facts are NOT equal to custom facts", () => {
    expect(expenseCreationFactsEqual(percentageFacts(), customFacts())).toBe(false);
  });

  it("percentage facts change when one participant's percentage changes", () => {
    const a = percentageFacts();
    const b = percentageFacts({
      participants: canonicalizePercentageParticipants([
        { uid: "member-1", percentageBasisPoints: 6000 },
        { uid: "member-2", percentageBasisPoints: 4000 },
      ]),
    });
    expect(expenseCreationFactsEqual(a, b)).toBe(false);
  });

  it("percentage facts change when participant membership changes", () => {
    const a = percentageFacts();
    const b = percentageFacts({
      participants: canonicalizePercentageParticipants([
        { uid: "member-1", percentageBasisPoints: 5000 },
        { uid: "member-3", percentageBasisPoints: 5000 },
      ]),
    });
    expect(expenseCreationFactsEqual(a, b)).toBe(false);
  });

  it("custom facts change when one participant's amount changes", () => {
    const a = customFacts();
    const b = customFacts({
      participants: canonicalizeCustomParticipants([
        { uid: "member-1", amountMinor: 9000 },
        { uid: "member-2", amountMinor: 0 },
      ]),
    });
    expect(expenseCreationFactsEqual(a, b)).toBe(false);
  });

  it("custom facts change when participant membership changes", () => {
    const a = customFacts();
    const b = customFacts({
      participants: canonicalizeCustomParticipants([
        { uid: "member-1", amountMinor: 4500 },
        { uid: "member-3", amountMinor: 4500 },
      ]),
    });
    expect(expenseCreationFactsEqual(a, b)).toBe(false);
  });

  it("canonical input order differences representing the same logical percentage split compare equal", () => {
    const a = percentageFacts({
      participants: canonicalizePercentageParticipants([
        { uid: "member-2", percentageBasisPoints: 5000 },
        { uid: "member-1", percentageBasisPoints: 5000 },
      ]),
    });
    const b = percentageFacts({
      participants: canonicalizePercentageParticipants([
        { uid: "member-1", percentageBasisPoints: 5000 },
        { uid: "member-2", percentageBasisPoints: 5000 },
      ]),
    });
    expect(expenseCreationFactsEqual(a, b)).toBe(true);
  });

  it("canonical input order differences representing the same logical custom split compare equal", () => {
    const a = customFacts({
      participants: canonicalizeCustomParticipants([
        { uid: "member-2", amountMinor: 4500 },
        { uid: "member-1", amountMinor: 4500 },
      ]),
    });
    const b = customFacts({
      participants: canonicalizeCustomParticipants([
        { uid: "member-1", amountMinor: 4500 },
        { uid: "member-2", amountMinor: 4500 },
      ]),
    });
    expect(expenseCreationFactsEqual(a, b)).toBe(true);
  });
});

describe("resolveExpenseClientRequestId across split strategies", () => {
  function makeGenerator() {
    let counter = 0;
    return () => `strategy-generated-${++counter}`;
  }

  it("a strategy switch (equal -> percentage) always mints a fresh id", () => {
    const generator = makeGenerator();
    const pendingRef: { current: PendingExpenseCreationRequest | null } = { current: null };
    const first = resolveExpenseClientRequestId(pendingRef, baseFacts(), generator);
    const second = resolveExpenseClientRequestId(
      pendingRef,
      {
        ...baseFacts(),
        splitStrategy: "percentage",
        participants: canonicalizePercentageParticipants([
          { uid: "member-1", percentageBasisPoints: 5000 },
          { uid: "member-2", percentageBasisPoints: 5000 },
        ]),
      } as ExpenseCreationFacts,
      generator
    );
    expect(second).not.toBe(first);
  });

  it("a strategy switch (percentage -> custom) always mints a fresh id", () => {
    const generator = makeGenerator();
    const pendingRef: { current: PendingExpenseCreationRequest | null } = { current: null };
    const percentage: ExpenseCreationFacts = {
      ...baseFacts(),
      splitStrategy: "percentage",
      participants: canonicalizePercentageParticipants([
        { uid: "member-1", percentageBasisPoints: 5000 },
        { uid: "member-2", percentageBasisPoints: 5000 },
      ]),
    } as ExpenseCreationFacts;
    const custom: ExpenseCreationFacts = {
      ...baseFacts(),
      splitStrategy: "custom",
      participants: canonicalizeCustomParticipants([
        { uid: "member-1", amountMinor: 4500 },
        { uid: "member-2", amountMinor: 4500 },
      ]),
    } as ExpenseCreationFacts;
    const first = resolveExpenseClientRequestId(pendingRef, percentage, generator);
    const second = resolveExpenseClientRequestId(pendingRef, custom, generator);
    expect(second).not.toBe(first);
  });

  it("percentage: exact-same logical facts reuse the pending id", () => {
    const generator = makeGenerator();
    const pendingRef: { current: PendingExpenseCreationRequest | null } = { current: null };
    const facts: ExpenseCreationFacts = {
      ...baseFacts(),
      splitStrategy: "percentage",
      participants: canonicalizePercentageParticipants([
        { uid: "member-1", percentageBasisPoints: 5000 },
        { uid: "member-2", percentageBasisPoints: 5000 },
      ]),
    } as ExpenseCreationFacts;
    const first = resolveExpenseClientRequestId(pendingRef, facts, generator);
    const second = resolveExpenseClientRequestId(pendingRef, { ...facts }, generator);
    expect(second).toBe(first);
  });

  it("percentage: a value change mints a fresh id", () => {
    const generator = makeGenerator();
    const pendingRef: { current: PendingExpenseCreationRequest | null } = { current: null };
    const facts: ExpenseCreationFacts = {
      ...baseFacts(),
      splitStrategy: "percentage",
      participants: canonicalizePercentageParticipants([
        { uid: "member-1", percentageBasisPoints: 5000 },
        { uid: "member-2", percentageBasisPoints: 5000 },
      ]),
    } as ExpenseCreationFacts;
    const changed: ExpenseCreationFacts = {
      ...baseFacts(),
      splitStrategy: "percentage",
      participants: canonicalizePercentageParticipants([
        { uid: "member-1", percentageBasisPoints: 6000 },
        { uid: "member-2", percentageBasisPoints: 4000 },
      ]),
    } as ExpenseCreationFacts;
    const first = resolveExpenseClientRequestId(pendingRef, facts, generator);
    const second = resolveExpenseClientRequestId(pendingRef, changed, generator);
    expect(second).not.toBe(first);
  });

  it("custom: exact-same logical facts reuse the pending id", () => {
    const generator = makeGenerator();
    const pendingRef: { current: PendingExpenseCreationRequest | null } = { current: null };
    const facts: ExpenseCreationFacts = {
      ...baseFacts(),
      splitStrategy: "custom",
      participants: canonicalizeCustomParticipants([
        { uid: "member-1", amountMinor: 4500 },
        { uid: "member-2", amountMinor: 4500 },
      ]),
    } as ExpenseCreationFacts;
    const first = resolveExpenseClientRequestId(pendingRef, facts, generator);
    const second = resolveExpenseClientRequestId(pendingRef, { ...facts }, generator);
    expect(second).toBe(first);
  });

  it("custom: an amount change mints a fresh id", () => {
    const generator = makeGenerator();
    const pendingRef: { current: PendingExpenseCreationRequest | null } = { current: null };
    const facts: ExpenseCreationFacts = {
      ...baseFacts(),
      splitStrategy: "custom",
      participants: canonicalizeCustomParticipants([
        { uid: "member-1", amountMinor: 4500 },
        { uid: "member-2", amountMinor: 4500 },
      ]),
    } as ExpenseCreationFacts;
    const changed: ExpenseCreationFacts = {
      ...baseFacts(),
      splitStrategy: "custom",
      participants: canonicalizeCustomParticipants([
        { uid: "member-1", amountMinor: 9000 },
        { uid: "member-2", amountMinor: 0 },
      ]),
    } as ExpenseCreationFacts;
    const first = resolveExpenseClientRequestId(pendingRef, facts, generator);
    const second = resolveExpenseClientRequestId(pendingRef, changed, generator);
    expect(second).not.toBe(first);
  });
});
