import {
  canReverseExpense,
  expenseReversalFactsEqual,
  isDefinitiveDifferentRequestFailure,
  normalizeReversalReason,
  reduceReversalOutcome,
  resolveExpenseReversalClientRequestId,
  type ExpenseReversalFacts,
  type PendingExpenseReversalRequest,
} from "../expenseReversal";

// =======================================================================
// REASON NORMALIZATION
// =======================================================================

describe("normalizeReversalReason", () => {
  it("normalizes an absent (empty) reason to undefined", () => {
    expect(normalizeReversalReason("")).toEqual({ ok: true, value: undefined });
  });

  it("normalizes a whitespace-only reason to undefined", () => {
    expect(normalizeReversalReason("   ")).toEqual({ ok: true, value: undefined });
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeReversalReason("  Wrong amount  ")).toEqual({ ok: true, value: "Wrong amount" });
  });

  it("accepts exactly 500 trimmed characters", () => {
    const value = "x".repeat(500);
    expect(normalizeReversalReason(value)).toEqual({ ok: true, value });
  });

  it("rejects 501 trimmed characters", () => {
    expect(normalizeReversalReason("x".repeat(501))).toEqual({
      ok: false,
      error: "Reason must be 500 characters or fewer.",
    });
  });

  it("applies the 500-character cap to the TRIMMED value, not the raw input", () => {
    // 500 real characters plus surrounding whitespace that trim() removes -
    // must still be accepted, since the cap applies after trimming.
    const padded = `  ${"x".repeat(500)}  `;
    expect(normalizeReversalReason(padded)).toEqual({ ok: true, value: "x".repeat(500) });
  });

  it("never silently truncates an over-length reason", () => {
    const result = normalizeReversalReason("x".repeat(600));
    expect(result.ok).toBe(false);
  });
});

// =======================================================================
// REVERSAL FACTS / IDEMPOTENCY
// =======================================================================

describe("expenseReversalFactsEqual", () => {
  it("is true for identical facts", () => {
    const a: ExpenseReversalFacts = { expenseId: "expense-1", reversalReason: "Wrong amount" };
    const b: ExpenseReversalFacts = { expenseId: "expense-1", reversalReason: "Wrong amount" };
    expect(expenseReversalFactsEqual(a, b)).toBe(true);
  });

  it("is true when both reasons are normalized-absent (undefined)", () => {
    const a: ExpenseReversalFacts = { expenseId: "expense-1", reversalReason: undefined };
    const b: ExpenseReversalFacts = { expenseId: "expense-1", reversalReason: undefined };
    expect(expenseReversalFactsEqual(a, b)).toBe(true);
  });

  it("is false when expenseId differs", () => {
    const a: ExpenseReversalFacts = { expenseId: "expense-1", reversalReason: undefined };
    const b: ExpenseReversalFacts = { expenseId: "expense-2", reversalReason: undefined };
    expect(expenseReversalFactsEqual(a, b)).toBe(false);
  });

  it("is false when reversalReason differs", () => {
    const a: ExpenseReversalFacts = { expenseId: "expense-1", reversalReason: "Wrong amount" };
    const b: ExpenseReversalFacts = { expenseId: "expense-1", reversalReason: "Typo" };
    expect(expenseReversalFactsEqual(a, b)).toBe(false);
  });

  it("is false when one reason is present and the other is absent", () => {
    const a: ExpenseReversalFacts = { expenseId: "expense-1", reversalReason: "Wrong amount" };
    const b: ExpenseReversalFacts = { expenseId: "expense-1", reversalReason: undefined };
    expect(expenseReversalFactsEqual(a, b)).toBe(false);
  });
});

describe("resolveExpenseReversalClientRequestId", () => {
  function makeGenerator() {
    let counter = 0;
    return () => `reversal-generated-${++counter}`;
  }

  it("generates a fresh id when no pending request exists", () => {
    const pendingRef: { current: PendingExpenseReversalRequest | null } = { current: null };
    const facts: ExpenseReversalFacts = { expenseId: "expense-1", reversalReason: undefined };
    const id = resolveExpenseReversalClientRequestId(pendingRef, facts, makeGenerator());
    expect(id).toBe("reversal-generated-1");
    expect(pendingRef.current?.clientRequestId).toBe("reversal-generated-1");
  });

  it("reuses the same id when the facts are unchanged (retry)", () => {
    const generator = makeGenerator();
    const pendingRef: { current: PendingExpenseReversalRequest | null } = { current: null };
    const facts: ExpenseReversalFacts = { expenseId: "expense-1", reversalReason: "Wrong amount" };
    const first = resolveExpenseReversalClientRequestId(pendingRef, facts, generator);
    const second = resolveExpenseReversalClientRequestId(pendingRef, { ...facts }, generator);
    expect(second).toBe(first);
  });

  it("mints a fresh id when the reason changes", () => {
    const generator = makeGenerator();
    const pendingRef: { current: PendingExpenseReversalRequest | null } = { current: null };
    const first = resolveExpenseReversalClientRequestId(
      pendingRef,
      { expenseId: "expense-1", reversalReason: "Wrong amount" },
      generator
    );
    const second = resolveExpenseReversalClientRequestId(
      pendingRef,
      { expenseId: "expense-1", reversalReason: "Typo" },
      generator
    );
    expect(second).not.toBe(first);
  });

  it("mints a fresh id when the expenseId changes", () => {
    const generator = makeGenerator();
    const pendingRef: { current: PendingExpenseReversalRequest | null } = { current: null };
    const first = resolveExpenseReversalClientRequestId(
      pendingRef,
      { expenseId: "expense-1", reversalReason: undefined },
      generator
    );
    const second = resolveExpenseReversalClientRequestId(
      pendingRef,
      { expenseId: "expense-2", reversalReason: undefined },
      generator
    );
    expect(second).not.toBe(first);
  });

  it("already-exists conflict: discarding the pending id (simulated by the caller) forces the next attempt to mint fresh", () => {
    const generator = makeGenerator();
    const pendingRef: { current: PendingExpenseReversalRequest | null } = { current: null };
    const facts: ExpenseReversalFacts = { expenseId: "expense-1", reversalReason: undefined };
    const first = resolveExpenseReversalClientRequestId(pendingRef, facts, generator);
    // Simulates the controller's own already-exists handling: the
    // conflicting pending request id is discarded outright.
    pendingRef.current = null;
    const second = resolveExpenseReversalClientRequestId(pendingRef, facts, generator);
    expect(second).not.toBe(first);
  });

  it("ambiguous failure: a preserved pendingRef reuses the same id on the next same-facts attempt", () => {
    const generator = makeGenerator();
    const pendingRef: { current: PendingExpenseReversalRequest | null } = { current: null };
    const facts: ExpenseReversalFacts = { expenseId: "expense-1", reversalReason: "Wrong amount" };
    const first = resolveExpenseReversalClientRequestId(pendingRef, facts, generator);
    // Simulates the controller's own ambiguous-failure handling: pendingRef
    // is deliberately left untouched (never cleared).
    expect(pendingRef.current).not.toBeNull();
    const second = resolveExpenseReversalClientRequestId(pendingRef, { ...facts }, generator);
    expect(second).toBe(first);
  });
});

// =======================================================================
// AUTHORIZATION (advisory only)
// =======================================================================

describe("canReverseExpense", () => {
  const baseParams = {
    currentUid: "owner-1",
    expenseStatus: "active" as const,
    expenseCreatedBy: "member-1",
    tripOwnerId: "owner-1",
    tripMemberIds: ["owner-1", "member-1", "member-2"],
  };

  it("allows the Trip owner", () => {
    expect(canReverseExpense(baseParams)).toBe(true);
  });

  it("allows the original creator, still a current Trip member", () => {
    expect(
      canReverseExpense({ ...baseParams, currentUid: "member-1" })
    ).toBe(true);
  });

  it("denies the original creator once removed from the Trip", () => {
    expect(
      canReverseExpense({
        ...baseParams,
        currentUid: "member-1",
        tripMemberIds: ["owner-1", "member-2"],
      })
    ).toBe(false);
  });

  it("denies a payer-only member (payer grants no independent authority)", () => {
    // "member-2" is neither the owner nor the createdBy - a payer-only
    // relationship (not modeled as a param here on purpose, since
    // payerUid is never consulted at all) must still be denied.
    expect(
      canReverseExpense({ ...baseParams, currentUid: "member-2" })
    ).toBe(false);
  });

  it("denies a participant-only member", () => {
    expect(
      canReverseExpense({
        ...baseParams,
        currentUid: "member-3",
        tripMemberIds: ["owner-1", "member-1", "member-2", "member-3"],
      })
    ).toBe(false);
  });

  it("denies an unrelated member entirely", () => {
    expect(
      canReverseExpense({ ...baseParams, currentUid: "unrelated-uid" })
    ).toBe(false);
  });

  it("denies when the Expense is already reversed, even for the owner", () => {
    expect(
      canReverseExpense({ ...baseParams, expenseStatus: "reversed" })
    ).toBe(false);
  });

  it("fails closed when Trip data is missing/unavailable (loading or read failure)", () => {
    expect(
      canReverseExpense({
        ...baseParams,
        currentUid: "member-1",
        tripOwnerId: undefined,
        tripMemberIds: undefined,
      })
    ).toBe(false);
  });

  it("fails closed when currentUid is not yet known", () => {
    expect(
      canReverseExpense({ ...baseParams, currentUid: undefined })
    ).toBe(false);
  });
});

// =======================================================================
// AMBIGUOUS-OUTCOME RECONCILIATION (Checkpoint 4D.6A)
// =======================================================================
//
// THE BUG: reversedBy === currentUid alone was previously treated as
// proof that a pending request had succeeded. It is not - the same
// account can independently reverse the same Expense from a different
// device/session with a different clientRequestId. These tests prove
// the fixed reducer never draws that conclusion from a live update
// alone, and only ever confirms genuine success from an actual
// successful callable response (the backend's own exact-replay check).

describe("reduceReversalOutcome", () => {
  const CURRENT_UID = "member-1";
  const OTHER_UID = "member-2";

  it("direct callable success (no prior ambiguity) resolves to success", () => {
    expect(reduceReversalOutcome({ type: "callable_success" }, true)).toEqual({
      action: "success",
    });
  });

  it("a live update showing the Expense still active, with a pending request, resolves to none", () => {
    expect(
      reduceReversalOutcome(
        { type: "live_update", expenseStatus: "active", expenseReversedBy: undefined, currentUid: CURRENT_UID },
        true
      )
    ).toEqual({ action: "none" });
  });

  it("THE FIX: a live update showing reversedBy === currentUid does NOT resolve to success - it stays unresolved", () => {
    expect(
      reduceReversalOutcome(
        {
          type: "live_update",
          expenseStatus: "reversed",
          expenseReversedBy: CURRENT_UID,
          currentUid: CURRENT_UID,
        },
        true
      )
    ).toEqual({ action: "none" });
  });

  it("an explicit verified exact-request retry that succeeds resolves to success, settling the same-uid ambiguity", () => {
    // Simulates: ambiguous failure -> live update shows reversedBy ===
    // currentUid (stays "none", per the fix above) -> user explicitly
    // triggers a same-facts verification retry -> the callable itself
    // returns success (the backend's own exact-replay step B matched).
    const stillAmbiguous = reduceReversalOutcome(
      { type: "live_update", expenseStatus: "reversed", expenseReversedBy: CURRENT_UID, currentUid: CURRENT_UID },
      true
    );
    expect(stillAmbiguous).toEqual({ action: "none" });

    const verified = reduceReversalOutcome({ type: "callable_success" }, true);
    expect(verified).toEqual({ action: "success" });
  });

  it("a live update showing reversedBy as a DIFFERENT uid resolves to reversed_by_other immediately", () => {
    expect(
      reduceReversalOutcome(
        {
          type: "live_update",
          expenseStatus: "reversed",
          expenseReversedBy: OTHER_UID,
          currentUid: CURRENT_UID,
        },
        true
      )
    ).toEqual({ action: "reversed_by_other" });
  });

  it("same-UID reversal from a DIFFERENT request: a verification retry that fails, with live-confirmed reversed status, resolves to reversed_by_other (never success)", () => {
    // The exact-replay verification itself failed (facts didn't match
    // what actually committed), and the live listener independently
    // confirms the Expense is reversed - this is "reversed by someone
    // else's request", even though reversedBy happens to equal
    // currentUid (a different session/device of the SAME account).
    const result = reduceReversalOutcome(
      { type: "callable_failure", definitelyDifferentRequest: true, errorMessage: "This expense has already been reversed." },
      true
    );
    expect(result).toEqual({ action: "reversed_by_other" });
  });

  it("an ambiguous/definitive callable failure with NO live-confirmed reversal preserves the pending request and shows the error", () => {
    const result = reduceReversalOutcome(
      {
        type: "callable_failure",
        definitelyDifferentRequest: false,
        errorMessage: "We couldn't reach the server, so we can't confirm this went through — it's safe to try again.",
      },
      true
    );
    expect(result).toEqual({
      action: "show_error",
      message: "We couldn't reach the server, so we can't confirm this went through — it's safe to try again.",
    });
  });

  it("FOLLOW-UP FIX: an ambiguous verification failure (unavailable) does NOT resolve to reversed_by_other, even though the live listener already shows this Expense reversed by the same uid - the pending request must be preserved", () => {
    // Step 1: original request ambiguous, live listener shows reversed
    // by the SAME uid - stays unresolved (the original 4D.6A fix).
    const afterLiveUpdate = reduceReversalOutcome(
      { type: "live_update", expenseStatus: "reversed", expenseReversedBy: CURRENT_UID, currentUid: CURRENT_UID },
      true
    );
    expect(afterLiveUpdate).toEqual({ action: "none" });

    // Step 2: the user taps "Check reversal status" - the verification
    // retry ALSO fails, but with an AMBIGUOUS transport error
    // (unavailable), not the backend's specific "already reversed"
    // failed-precondition code. The caller's own classification (never
    // the reducer inferring this from live status alone) must mark this
    // as NOT a definitive different-request outcome.
    const classification = isDefinitiveDifferentRequestFailure({
      errorCode: "functions/unavailable",
      liveStatusIsReversed: true,
    });
    expect(classification).toBe(false);

    const afterAmbiguousVerify = reduceReversalOutcome(
      {
        type: "callable_failure",
        definitelyDifferentRequest: classification,
        errorMessage:
          "This expense shows as reversed, but we couldn’t confirm whether your request was the one that went through. It’s safe to check again.",
      },
      true // the pending request is STILL present - never discarded here
    );
    expect(afterAmbiguousVerify).toEqual({
      action: "show_error",
      message:
        "This expense shows as reversed, but we couldn’t confirm whether your request was the one that went through. It’s safe to check again.",
    });

    // Step 3: the user explicitly retries "Check reversal status" once
    // more, and THIS time the exact-replay verification succeeds -
    // genuine, verified proof. hasPendingRequest is still true, since
    // the ambiguous failure in step 2 never cleared it.
    const afterVerifiedRetry = reduceReversalOutcome({ type: "callable_success" }, true);
    expect(afterVerifiedRetry).toEqual({ action: "success" });
  });

  it("live-update/callable-response race: success-then-live-update never re-fires once resolved (no duplicate action)", () => {
    // First event: the callable itself resolves successfully - the
    // caller is expected to flip hasPendingRequest to false immediately
    // afterward, exactly as it would in the real controller.
    const first = reduceReversalOutcome({ type: "callable_success" }, true);
    expect(first).toEqual({ action: "success" });

    // Second event: a live update arrives afterward (or was already in
    // flight) - hasPendingRequest is now false, so this must be a no-op,
    // never a second "success" or any other action.
    const second = reduceReversalOutcome(
      { type: "live_update", expenseStatus: "reversed", expenseReversedBy: CURRENT_UID, currentUid: CURRENT_UID },
      false
    );
    expect(second).toEqual({ action: "none" });
  });

  it("live-update/callable-response race: live-update-then-callable-response also never duplicates the action", () => {
    // First event: a live update arrives first, showing a DIFFERENT
    // uid's reversal - resolves definitively to reversed_by_other. The
    // caller is expected to flip hasPendingRequest to false immediately.
    const first = reduceReversalOutcome(
      { type: "live_update", expenseStatus: "reversed", expenseReversedBy: OTHER_UID, currentUid: CURRENT_UID },
      true
    );
    expect(first).toEqual({ action: "reversed_by_other" });

    // Second event: the original callable's own (now-stale) response
    // arrives afterward - hasPendingRequest is already false, so this
    // must be a no-op regardless of what the stale response says.
    const second = reduceReversalOutcome({ type: "callable_success" }, false);
    expect(second).toEqual({ action: "none" });
  });

  it("no duplicate success announcement: two consecutive callable_success events only produce one actionable result", () => {
    const first = reduceReversalOutcome({ type: "callable_success" }, true);
    expect(first).toEqual({ action: "success" });
    // Once resolved, the caller's own hasPendingRequest flips false -
    // a hypothetical duplicate/late-arriving success event must not
    // produce a second "success" action.
    const second = reduceReversalOutcome({ type: "callable_success" }, false);
    expect(second).toEqual({ action: "none" });
  });

  it("every event type is a no-op when there is no pending request at all", () => {
    expect(reduceReversalOutcome({ type: "callable_success" }, false)).toEqual({ action: "none" });
    expect(
      reduceReversalOutcome({ type: "callable_failure", definitelyDifferentRequest: true, errorMessage: "x" }, false)
    ).toEqual({ action: "none" });
    expect(
      reduceReversalOutcome(
        { type: "live_update", expenseStatus: "reversed", expenseReversedBy: OTHER_UID, currentUid: CURRENT_UID },
        false
      )
    ).toEqual({ action: "none" });
  });
});

describe("isDefinitiveDifferentRequestFailure", () => {
  it("is true for a failed-precondition error WITH live-confirmed reversed status", () => {
    expect(
      isDefinitiveDifferentRequestFailure({
        errorCode: "functions/failed-precondition",
        liveStatusIsReversed: true,
      })
    ).toBe(true);
  });

  it("is false for a failed-precondition error WITHOUT live-confirmed reversed status", () => {
    expect(
      isDefinitiveDifferentRequestFailure({
        errorCode: "functions/failed-precondition",
        liveStatusIsReversed: false,
      })
    ).toBe(false);
  });

  it("THE FIX: is false for an ambiguous 'unavailable' error even WITH live-confirmed reversed status", () => {
    expect(
      isDefinitiveDifferentRequestFailure({ errorCode: "functions/unavailable", liveStatusIsReversed: true })
    ).toBe(false);
  });

  it("is false for an ambiguous 'deadline-exceeded' error even WITH live-confirmed reversed status", () => {
    expect(
      isDefinitiveDifferentRequestFailure({ errorCode: "functions/deadline-exceeded", liveStatusIsReversed: true })
    ).toBe(false);
  });

  it("is false for an unknown/unrecognized error code even WITH live-confirmed reversed status", () => {
    expect(isDefinitiveDifferentRequestFailure({ errorCode: undefined, liveStatusIsReversed: true })).toBe(false);
  });

  it("is false for any error code when there is no live-confirmed reversed status", () => {
    expect(
      isDefinitiveDifferentRequestFailure({
        errorCode: "functions/permission-denied",
        liveStatusIsReversed: false,
      })
    ).toBe(false);
  });
});
