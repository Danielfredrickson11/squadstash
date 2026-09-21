import {
  canSelectParticipant,
  canonicalizeEqualParticipants,
  defaultParticipantSelection,
  deriveCurrentMemberUids,
  expenseCreationFactsEqual,
  parseExpenseMoneyInput,
  resolveExpenseClientRequestId,
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
