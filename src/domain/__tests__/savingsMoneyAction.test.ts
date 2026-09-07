import {
  moneyActionFactsEqual,
  normalizeTransactionNote,
  resolveAmountMinor,
  resolveMoneyActionClientRequestId,
  type MoneyActionFacts,
  type PendingMoneyActionRequest,
} from "../savingsMoneyAction";

describe("resolveAmountMinor", () => {
  it("uses the preset directly when set, ignoring amountText entirely", () => {
    expect(resolveAmountMinor("this is not a number", 5000)).toBe(5000);
  });

  it("prefers the preset even when amountText looks like a different valid amount", () => {
    expect(resolveAmountMinor("999.99", 2000)).toBe(2000);
  });

  it("parses amountText via parseDollarsToMinorUnits when no preset is selected", () => {
    expect(resolveAmountMinor("12.34", null)).toBe(1234);
  });

  it("returns null for invalid amountText when no preset is selected", () => {
    expect(resolveAmountMinor("abc", null)).toBeNull();
  });

  it("returns null for a zero amountText when no preset is selected", () => {
    expect(resolveAmountMinor("0", null)).toBeNull();
  });
});

describe("normalizeTransactionNote", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeTransactionNote("  Paycheck  ")).toBe("Paycheck");
  });

  it("returns undefined for an empty string", () => {
    expect(normalizeTransactionNote("")).toBeUndefined();
  });

  it("returns undefined for a whitespace-only string", () => {
    expect(normalizeTransactionNote("   ")).toBeUndefined();
  });

  it("preserves internal whitespace", () => {
    expect(normalizeTransactionNote("  Birthday money  ")).toBe("Birthday money");
  });
});

function makeFacts(overrides: Partial<MoneyActionFacts> = {}): MoneyActionFacts {
  return {
    resourceId: "bucket-1",
    memberUid: "member-1",
    type: "contribution",
    amountMinor: 5000,
    note: undefined,
    ...overrides,
  };
}

describe("moneyActionFactsEqual", () => {
  it("is true for identical facts", () => {
    expect(moneyActionFactsEqual(makeFacts(), makeFacts())).toBe(true);
  });

  it("is false when amountMinor differs", () => {
    expect(
      moneyActionFactsEqual(makeFacts(), makeFacts({ amountMinor: 10000 }))
    ).toBe(false);
  });

  it("is false when type differs", () => {
    expect(
      moneyActionFactsEqual(makeFacts(), makeFacts({ type: "withdrawal" }))
    ).toBe(false);
  });

  it("is false when resourceId (Bucket) differs", () => {
    expect(
      moneyActionFactsEqual(makeFacts(), makeFacts({ resourceId: "bucket-2" }))
    ).toBe(false);
  });

  it("is false when note differs", () => {
    expect(
      moneyActionFactsEqual(makeFacts({ note: "Paycheck" }), makeFacts({ note: "Refund" }))
    ).toBe(false);
  });

  it("is false between a note and no note", () => {
    expect(
      moneyActionFactsEqual(makeFacts({ note: "Paycheck" }), makeFacts({ note: undefined }))
    ).toBe(false);
  });

  it("is true when both have the same note", () => {
    expect(
      moneyActionFactsEqual(makeFacts({ note: "Paycheck" }), makeFacts({ note: "Paycheck" }))
    ).toBe(true);
  });
});

describe("resolveMoneyActionClientRequestId", () => {
  function makeGenerator(ids: string[]) {
    let i = 0;
    return () => ids[i++];
  }

  it("generates a fresh id when no request is pending", () => {
    const pendingRef: { current: PendingMoneyActionRequest | null } = { current: null };
    const id = resolveMoneyActionClientRequestId(pendingRef, makeFacts(), makeGenerator(["id-1"]));
    expect(id).toBe("id-1");
    expect(pendingRef.current).toEqual({ ...makeFacts(), clientRequestId: "id-1" });
  });

  it("reuses the pending id when facts exactly match (a retry)", () => {
    const pendingRef: { current: PendingMoneyActionRequest | null } = {
      current: { ...makeFacts(), clientRequestId: "id-1" },
    };
    const id = resolveMoneyActionClientRequestId(pendingRef, makeFacts(), makeGenerator(["id-2"]));
    expect(id).toBe("id-1");
  });

  it("generates a fresh id when the amount changed since the pending request", () => {
    const pendingRef: { current: PendingMoneyActionRequest | null } = {
      current: { ...makeFacts(), clientRequestId: "id-1" },
    };
    const id = resolveMoneyActionClientRequestId(
      pendingRef,
      makeFacts({ amountMinor: 10000 }),
      makeGenerator(["id-2"])
    );
    expect(id).toBe("id-2");
  });

  it("generates a fresh id when only the note changed since the pending request", () => {
    const pendingRef: { current: PendingMoneyActionRequest | null } = {
      current: { ...makeFacts({ note: "Paycheck" }), clientRequestId: "id-1" },
    };
    const id = resolveMoneyActionClientRequestId(
      pendingRef,
      makeFacts({ note: "Different note" }),
      makeGenerator(["id-2"])
    );
    expect(id).toBe("id-2");
  });

  it("generates a fresh id when the action type changed since the pending request", () => {
    const pendingRef: { current: PendingMoneyActionRequest | null } = {
      current: { ...makeFacts(), clientRequestId: "id-1" },
    };
    const id = resolveMoneyActionClientRequestId(
      pendingRef,
      makeFacts({ type: "withdrawal" }),
      makeGenerator(["id-2"])
    );
    expect(id).toBe("id-2");
  });
});
