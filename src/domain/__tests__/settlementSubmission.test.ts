// Tests for src/domain/settlementSubmission.ts (Checkpoint 4E.4). Mirrors
// src/domain/__tests__/expenseSubmission.test.ts's exact-facts-equality
// discipline and src/hooks/__tests__/useSavingsMoneyAction.test.tsx's
// resolve-client-request-id proof shape.
import {
  assessSettlementAgainstDebt,
  isDefinitiveSettlementDifferentRequestFailure,
  normalizeSettlementNote,
  reduceSettlementReversalOutcome,
  resolveSettlementClientRequestId,
  resolveSettlementReversalClientRequestId,
  settlementCreationFactsEqual,
  settlementReversalFactsEqual,
  type PendingSettlementCreationRequest,
  type PendingSettlementReversalRequest,
  type SettlementCreationFacts,
} from "../settlementSubmission";
import {
  isDefinitiveDifferentRequestFailure,
  reduceReversalOutcome,
} from "../expenseReversal";

function baseFacts(overrides: Partial<SettlementCreationFacts> = {}): SettlementCreationFacts {
  return {
    tripId: "trip-1",
    fromUid: "debtor-1",
    toUid: "recipient-1",
    amountMinor: 4000,
    currency: "USD",
    method: "venmo",
    note: null,
    occurredAtInstantMs: null,
    ...overrides,
  };
}

// =======================================================================
// NOTE NORMALIZATION
// =======================================================================

describe("normalizeSettlementNote", () => {
  it("trims an ordinary note", () => {
    expect(normalizeSettlementNote("  Paid via Venmo  ")).toEqual({
      ok: true,
      value: "Paid via Venmo",
    });
  });

  it("whitespace-only note normalizes to null", () => {
    expect(normalizeSettlementNote("   ")).toEqual({ ok: true, value: null });
  });

  it("empty note normalizes to null", () => {
    expect(normalizeSettlementNote("")).toEqual({ ok: true, value: null });
  });

  it("exactly 500 chars (after trim) succeeds", () => {
    const value = "x".repeat(500);
    expect(normalizeSettlementNote(`  ${value}  `)).toEqual({
      ok: true,
      value,
    });
  });

  it("501 chars (after trim) rejects", () => {
    const result = normalizeSettlementNote("x".repeat(501));
    expect(result.ok).toBe(false);
  });

  it("surrounding whitespace is removed before the cap is checked", () => {
    const value = "x".repeat(500);
    const padded = `   ${value}   `; // would be over 500 if not trimmed first
    expect(normalizeSettlementNote(padded)).toEqual({ ok: true, value });
  });
});

// =======================================================================
// CREATION FACT EQUALITY
// =======================================================================

describe("settlementCreationFactsEqual", () => {
  it("identical facts are equal", () => {
    expect(settlementCreationFactsEqual(baseFacts(), baseFacts())).toBe(true);
  });

  it("tripId difference is not equal", () => {
    expect(
      settlementCreationFactsEqual(baseFacts(), baseFacts({ tripId: "trip-2" }))
    ).toBe(false);
  });

  it("fromUid difference is not equal", () => {
    expect(
      settlementCreationFactsEqual(baseFacts(), baseFacts({ fromUid: "other" }))
    ).toBe(false);
  });

  it("toUid difference is not equal", () => {
    expect(
      settlementCreationFactsEqual(baseFacts(), baseFacts({ toUid: "other" }))
    ).toBe(false);
  });

  it("amountMinor difference is not equal", () => {
    expect(
      settlementCreationFactsEqual(baseFacts(), baseFacts({ amountMinor: 4001 }))
    ).toBe(false);
  });

  it("currency difference is not equal", () => {
    expect(
      settlementCreationFactsEqual(
        baseFacts(),
        // Force a differing currency for the equality check itself -
        // the type only allows "USD", so this exercises the comparison
        // logic directly rather than real-world reachability.
        { ...baseFacts(), currency: "EUR" as "USD" }
      )
    ).toBe(false);
  });

  it("method difference is not equal", () => {
    expect(
      settlementCreationFactsEqual(baseFacts(), baseFacts({ method: "cash" }))
    ).toBe(false);
  });

  it("note difference is not equal", () => {
    expect(
      settlementCreationFactsEqual(baseFacts({ note: "a" }), baseFacts({ note: "b" }))
    ).toBe(false);
  });

  it("occurredAtInstantMs difference is not equal", () => {
    expect(
      settlementCreationFactsEqual(
        baseFacts({ occurredAtInstantMs: 1000 }),
        baseFacts({ occurredAtInstantMs: 2000 })
      )
    ).toBe(false);
  });

  it("occurredAtInstantMs === null on both sides is equal (4E.6 UI's own facts)", () => {
    expect(
      settlementCreationFactsEqual(
        baseFacts({ occurredAtInstantMs: null }),
        baseFacts({ occurredAtInstantMs: null })
      )
    ).toBe(true);
  });
});

// =======================================================================
// CREATION REQUEST-ID
// =======================================================================

describe("resolveSettlementClientRequestId", () => {
  function makeRef(): { current: PendingSettlementCreationRequest | null } {
    return { current: null };
  }

  it("first request mints an id", () => {
    const ref = makeRef();
    const generate = jest.fn().mockReturnValue("id-1");
    const id = resolveSettlementClientRequestId(ref, baseFacts(), generate);
    expect(id).toBe("id-1");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("an exact retry reuses the id, and the generator is not called twice", () => {
    const ref = makeRef();
    const generate = jest.fn().mockReturnValue("id-1");
    resolveSettlementClientRequestId(ref, baseFacts(), generate);
    const id2 = resolveSettlementClientRequestId(ref, baseFacts(), generate);
    expect(id2).toBe("id-1");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("a changed tripId mints a fresh id", () => {
    const ref = makeRef();
    const generate = jest.fn().mockReturnValueOnce("id-1").mockReturnValueOnce("id-2");
    resolveSettlementClientRequestId(ref, baseFacts(), generate);
    const id2 = resolveSettlementClientRequestId(
      ref,
      baseFacts({ tripId: "trip-2" }),
      generate
    );
    expect(id2).toBe("id-2");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("a changed fromUid/toUid pair mints a fresh id", () => {
    const ref = makeRef();
    const generate = jest.fn().mockReturnValueOnce("id-1").mockReturnValueOnce("id-2");
    resolveSettlementClientRequestId(ref, baseFacts(), generate);
    const id2 = resolveSettlementClientRequestId(
      ref,
      baseFacts({ fromUid: "someone-else" }),
      generate
    );
    expect(id2).toBe("id-2");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("a changed amount mints a fresh id", () => {
    const ref = makeRef();
    const generate = jest.fn().mockReturnValueOnce("id-1").mockReturnValueOnce("id-2");
    resolveSettlementClientRequestId(ref, baseFacts(), generate);
    const id2 = resolveSettlementClientRequestId(
      ref,
      baseFacts({ amountMinor: 5000 }),
      generate
    );
    expect(id2).toBe("id-2");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("a changed method mints a fresh id", () => {
    const ref = makeRef();
    const generate = jest.fn().mockReturnValueOnce("id-1").mockReturnValueOnce("id-2");
    resolveSettlementClientRequestId(ref, baseFacts(), generate);
    const id2 = resolveSettlementClientRequestId(
      ref,
      baseFacts({ method: "cash" }),
      generate
    );
    expect(id2).toBe("id-2");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("a changed note mints a fresh id", () => {
    const ref = makeRef();
    const generate = jest.fn().mockReturnValueOnce("id-1").mockReturnValueOnce("id-2");
    resolveSettlementClientRequestId(ref, baseFacts({ note: "a" }), generate);
    const id2 = resolveSettlementClientRequestId(
      ref,
      baseFacts({ note: "b" }),
      generate
    );
    expect(id2).toBe("id-2");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("a changed occurredAtInstantMs mints a fresh id", () => {
    const ref = makeRef();
    const generate = jest.fn().mockReturnValueOnce("id-1").mockReturnValueOnce("id-2");
    resolveSettlementClientRequestId(
      ref,
      baseFacts({ occurredAtInstantMs: 1000 }),
      generate
    );
    const id2 = resolveSettlementClientRequestId(
      ref,
      baseFacts({ occurredAtInstantMs: 2000 }),
      generate
    );
    expect(id2).toBe("id-2");
    expect(generate).toHaveBeenCalledTimes(2);
  });
});

// =======================================================================
// REVERSAL FACTS
// =======================================================================

describe("settlementReversalFactsEqual", () => {
  it("equal facts are equal", () => {
    expect(
      settlementReversalFactsEqual(
        { settlementId: "s-1", reversalReason: "Wrong amount" },
        { settlementId: "s-1", reversalReason: "Wrong amount" }
      )
    ).toBe(true);
  });

  it("settlementId difference is not equal", () => {
    expect(
      settlementReversalFactsEqual(
        { settlementId: "s-1", reversalReason: undefined },
        { settlementId: "s-2", reversalReason: undefined }
      )
    ).toBe(false);
  });

  it("normalized reason difference is not equal", () => {
    expect(
      settlementReversalFactsEqual(
        { settlementId: "s-1", reversalReason: "a" },
        { settlementId: "s-1", reversalReason: "b" }
      )
    ).toBe(false);
  });
});

describe("resolveSettlementReversalClientRequestId", () => {
  function makeRef(): { current: PendingSettlementReversalRequest | null } {
    return { current: null };
  }

  it("an exact retry reuses the id", () => {
    const ref = makeRef();
    const generate = jest.fn().mockReturnValue("id-1");
    const facts = { settlementId: "s-1", reversalReason: undefined };
    resolveSettlementReversalClientRequestId(ref, facts, generate);
    const id2 = resolveSettlementReversalClientRequestId(ref, facts, generate);
    expect(id2).toBe("id-1");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("a changed reason mints a fresh id", () => {
    const ref = makeRef();
    const generate = jest.fn().mockReturnValueOnce("id-1").mockReturnValueOnce("id-2");
    resolveSettlementReversalClientRequestId(
      ref,
      { settlementId: "s-1", reversalReason: "a" },
      generate
    );
    const id2 = resolveSettlementReversalClientRequestId(
      ref,
      { settlementId: "s-1", reversalReason: "b" },
      generate
    );
    expect(id2).toBe("id-2");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("a changed settlementId mints a fresh id", () => {
    const ref = makeRef();
    const generate = jest.fn().mockReturnValueOnce("id-1").mockReturnValueOnce("id-2");
    resolveSettlementReversalClientRequestId(
      ref,
      { settlementId: "s-1", reversalReason: undefined },
      generate
    );
    const id2 = resolveSettlementReversalClientRequestId(
      ref,
      { settlementId: "s-2", reversalReason: undefined },
      generate
    );
    expect(id2).toBe("id-2");
    expect(generate).toHaveBeenCalledTimes(2);
  });
});

// =======================================================================
// REVERSAL REDUCER REUSE - proves the imported/re-exported existing
// reducer still gives the key Settlement-relevant behavior WITHOUT
// duplicating its implementation (Checkpoint 4E.4 §10/§12).
// =======================================================================

describe("reduceSettlementReversalOutcome (re-exported, not duplicated)", () => {
  it("is the exact same function reference as expenseReversal's reduceReversalOutcome", () => {
    expect(reduceSettlementReversalOutcome).toBe(reduceReversalOutcome);
  });

  it("callable success + pending => success", () => {
    expect(reduceSettlementReversalOutcome({ type: "callable_success" }, true)).toEqual({
      action: "success",
    });
  });

  it("live reversed by a DIFFERENT uid => reversed_by_other", () => {
    expect(
      reduceSettlementReversalOutcome(
        {
          type: "live_update",
          expenseStatus: "reversed",
          expenseReversedBy: "someone-else",
          currentUid: "me",
        },
        true
      )
    ).toEqual({ action: "reversed_by_other" });
  });

  it("live reversed by the SAME uid => none (not treated as proof)", () => {
    expect(
      reduceSettlementReversalOutcome(
        {
          type: "live_update",
          expenseStatus: "reversed",
          expenseReversedBy: "me",
          currentUid: "me",
        },
        true
      )
    ).toEqual({ action: "none" });
  });

  it("an ambiguous callable failure => show_error", () => {
    expect(
      reduceSettlementReversalOutcome(
        {
          type: "callable_failure",
          definitelyDifferentRequest: false,
          errorMessage: "We couldn't reach the server.",
        },
        true
      )
    ).toEqual({ action: "show_error", message: "We couldn't reach the server." });
  });

  it("a definitive failed-precondition + independently-known reversed state is classified as definitely-different", () => {
    const definitelyDifferentRequest = isDefinitiveSettlementDifferentRequestFailure({
      errorCode: "functions/failed-precondition",
      liveStatusIsReversed: true,
    });
    expect(definitelyDifferentRequest).toBe(true);
    expect(
      reduceSettlementReversalOutcome(
        { type: "callable_failure", definitelyDifferentRequest, errorMessage: "n/a" },
        true
      )
    ).toEqual({ action: "reversed_by_other" });
  });

  it("no pending request => none, regardless of event", () => {
    expect(reduceSettlementReversalOutcome({ type: "callable_success" }, false)).toEqual({
      action: "none",
    });
  });

  it("isDefinitiveSettlementDifferentRequestFailure is the exact same function reference as isDefinitiveDifferentRequestFailure", () => {
    expect(isDefinitiveSettlementDifferentRequestFailure).toBe(
      isDefinitiveDifferentRequestFailure
    );
  });
});

// =======================================================================
// OVER-SETTLEMENT ADVISORY
// =======================================================================

describe("assessSettlementAgainstDebt", () => {
  it("requested less than current debt: does not exceed", () => {
    expect(assessSettlementAgainstDebt(5000, 3000)).toEqual({
      exceeds: false,
      excessMinor: 0,
    });
  });

  it("requested equal to current debt: does not exceed", () => {
    expect(assessSettlementAgainstDebt(5000, 5000)).toEqual({
      exceeds: false,
      excessMinor: 0,
    });
  });

  it("requested one cent over current debt: exceeds by 1", () => {
    expect(assessSettlementAgainstDebt(5000, 5001)).toEqual({
      exceeds: true,
      excessMinor: 1,
    });
  });

  it("requested substantially over current debt: exceeds by the full difference", () => {
    expect(assessSettlementAgainstDebt(1000, 9000)).toEqual({
      exceeds: true,
      excessMinor: 8000,
    });
  });

  it("current debt is zero and requested is positive: exceeds", () => {
    expect(assessSettlementAgainstDebt(0, 100)).toEqual({
      exceeds: true,
      excessMinor: 100,
    });
  });

  it("malformed negative currentDebtMinor throws", () => {
    expect(() => assessSettlementAgainstDebt(-1, 100)).toThrow();
  });

  it("malformed zero requestedAmountMinor throws", () => {
    expect(() => assessSettlementAgainstDebt(0, 0)).toThrow();
  });

  it("malformed float throws", () => {
    expect(() => assessSettlementAgainstDebt(5000.5, 3000)).toThrow();
  });

  it("malformed unsafe integer throws", () => {
    expect(() =>
      assessSettlementAgainstDebt(0, Number.MAX_SAFE_INTEGER + 10)
    ).toThrow();
  });
});
