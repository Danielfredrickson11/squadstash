import {
  CORRECTION_REVERSAL_REASON,
  buildCorrectionPrefill,
  canClaimCorrection,
  formatBasisPointsForInput,
  formatMinorUnitsForInput,
  initialCorrectionPhase,
  nextCorrectionPhase,
  partitionParticipantsByEligibility,
  resolveCorrectionAction,
  type CorrectionSourceExpense,
  type CorrectionSourceSplit,
} from "../expenseCorrection";

describe("CORRECTION_REVERSAL_REASON", () => {
  it("is a fixed, non-empty, deterministic string", () => {
    expect(CORRECTION_REVERSAL_REASON).toBe("Corrected");
  });
});

describe("canClaimCorrection", () => {
  const base = {
    currentUid: "user-a",
    expenseCreatedBy: "user-b",
    expenseReversedBy: undefined as string | undefined,
    tripOwnerId: "owner-1",
    tripMemberIds: ["owner-1", "user-a", "user-b"] as (string | null | undefined)[],
  };

  it("grants the current Trip owner regardless of createdBy/reversedBy", () => {
    expect(canClaimCorrection({ ...base, currentUid: "owner-1" })).toBe(true);
  });

  it("grants the Expense's original creator, while still a current member", () => {
    expect(canClaimCorrection({ ...base, currentUid: "user-b" })).toBe(true);
  });

  it("grants whoever previously reversed the Expense, while still a current member", () => {
    expect(
      canClaimCorrection({ ...base, currentUid: "user-a", expenseReversedBy: "user-a" })
    ).toBe(true);
  });

  it("denies a current member who is neither owner, creator, nor reverser", () => {
    expect(canClaimCorrection({ ...base, currentUid: "user-a" })).toBe(false);
  });

  it("denies the original creator once they are no longer a current member", () => {
    expect(
      canClaimCorrection({ ...base, currentUid: "user-b", tripMemberIds: ["owner-1", "user-a"] })
    ).toBe(false);
  });

  it("denies a former reverser once they are no longer a current member", () => {
    expect(
      canClaimCorrection({
        ...base,
        currentUid: "user-a",
        expenseReversedBy: "user-a",
        tripMemberIds: ["owner-1", "user-b"],
      })
    ).toBe(false);
  });

  it("denies when there is no signed-in uid", () => {
    expect(canClaimCorrection({ ...base, currentUid: null })).toBe(false);
  });

  it("mere participant status (not modeled here) grants nothing on its own", () => {
    // uid is a current member but neither owner/creator/reverser.
    expect(canClaimCorrection({ ...base, currentUid: "user-a", tripMemberIds: ["owner-1", "user-a", "user-b"] })).toBe(
      false
    );
  });
});

describe("resolveCorrectionAction", () => {
  it("offers nothing when not authorized, regardless of state", () => {
    expect(
      resolveCorrectionAction({ expenseStatus: "active", replacedByExpenseId: undefined, canClaim: false })
    ).toEqual({ kind: "none" });
    expect(
      resolveCorrectionAction({ expenseStatus: "reversed", replacedByExpenseId: undefined, canClaim: false })
    ).toEqual({ kind: "none" });
  });

  it('offers "start" for an active, authorized Expense', () => {
    expect(
      resolveCorrectionAction({ expenseStatus: "active", replacedByExpenseId: undefined, canClaim: true })
    ).toEqual({ kind: "start" });
  });

  it('offers "finish" for a reversed, unlinked, authorized Expense', () => {
    expect(
      resolveCorrectionAction({ expenseStatus: "reversed", replacedByExpenseId: undefined, canClaim: true })
    ).toEqual({ kind: "finish" });
  });

  it("offers nothing once a canonical replacement already exists, even if authorized", () => {
    expect(
      resolveCorrectionAction({ expenseStatus: "reversed", replacedByExpenseId: "new-id", canClaim: true })
    ).toEqual({ kind: "none" });
  });

  it("never offers a second correction slot for an active Expense with a stray replacedByExpenseId", () => {
    // Defensive: active + replacedByExpenseId set is not a real persisted
    // shape, but resolveCorrectionAction still fails closed rather than
    // offering "start".
    expect(
      resolveCorrectionAction({ expenseStatus: "active", replacedByExpenseId: "new-id", canClaim: true })
    ).toEqual({ kind: "none" });
  });
});

describe("formatMinorUnitsForInput / formatBasisPointsForInput", () => {
  it.each([
    [0, "0.00"],
    [5, "0.05"],
    [100, "1.00"],
    [1050, "10.50"],
    [999999, "9999.99"],
  ])("formats %i minor units as %s", (amountMinor, expected) => {
    expect(formatMinorUnitsForInput(amountMinor)).toBe(expected);
  });

  it("throws for a negative or non-integer amountMinor", () => {
    expect(() => formatMinorUnitsForInput(-1)).toThrow();
    expect(() => formatMinorUnitsForInput(1.5)).toThrow();
  });

  it.each([
    [0, "0.00"],
    [10000, "100.00"],
    [5025, "50.25"],
    [1, "0.01"],
  ])("formats %i basis points as %s", (bp, expected) => {
    expect(formatBasisPointsForInput(bp)).toBe(expected);
  });

  it("throws for a negative or non-integer percentageBasisPoints", () => {
    expect(() => formatBasisPointsForInput(-1)).toThrow();
    expect(() => formatBasisPointsForInput(1.5)).toThrow();
  });
});

describe("partitionParticipantsByEligibility", () => {
  it("splits participants into eligible (current member) and ineligible (departed) groups", () => {
    const result = partitionParticipantsByEligibility(
      ["a", "b", "c"],
      ["a", "c"]
    );
    expect(result).toEqual({ eligible: ["a", "c"], ineligible: ["b"] });
  });

  it("returns an empty ineligible list when every historical participant is still current", () => {
    expect(partitionParticipantsByEligibility(["a", "b"], ["a", "b", "z"])).toEqual({
      eligible: ["a", "b"],
      ineligible: [],
    });
  });

  it("returns an empty eligible list when nobody historical is still current", () => {
    expect(partitionParticipantsByEligibility(["a", "b"], ["z"])).toEqual({
      eligible: [],
      ineligible: ["a", "b"],
    });
  });
});

describe("buildCorrectionPrefill", () => {
  const equalExpense: CorrectionSourceExpense = {
    paymentSource: "member_out_of_pocket",
    payerUid: "payer-1",
    description: "Cabin rental",
    amountMinor: 10000,
    category: "Lodging",
    splitStrategy: "equal",
    occurredAtInstantMs: 1700000000000,
  };
  const equalSplits: CorrectionSourceSplit[] = [
    { userId: "payer-1", amountMinor: 5000 },
    { userId: "user-2", amountMinor: 5000 },
  ];

  it("prefills an equal-split correction from persisted description/amount/category/participants", () => {
    const result = buildCorrectionPrefill(equalExpense, equalSplits);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      description: "Cabin rental",
      amountMinor: 10000,
      amountText: "100.00",
      category: "Lodging",
      payerUid: "payer-1",
      splitStrategy: "equal",
      participantUids: ["payer-1", "user-2"],
      percentageInputs: {},
      customInputs: {},
      occurredAtInstantMs: 1700000000000,
    });
  });

  it("omits category as an empty string when the original Expense has none", () => {
    const result = buildCorrectionPrefill({ ...equalExpense, category: undefined }, equalSplits);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.category).toBe("");
  });

  it("omits occurredAtInstantMs (null) when the original Expense never recorded one", () => {
    const result = buildCorrectionPrefill({ ...equalExpense, occurredAtInstantMs: null }, equalSplits);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.occurredAtInstantMs).toBeNull();
  });

  it("prefills a percentage-split correction with the EXACT persisted basis points, never reconstructed from dollars", () => {
    const percentageExpense: CorrectionSourceExpense = { ...equalExpense, splitStrategy: "percentage" };
    const splits: CorrectionSourceSplit[] = [
      { userId: "payer-1", amountMinor: 3333, percentageBasisPoints: 3333 },
      { userId: "user-2", amountMinor: 6667, percentageBasisPoints: 6667 },
    ];
    const result = buildCorrectionPrefill(percentageExpense, splits);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.percentageInputs).toEqual({ "payer-1": "33.33", "user-2": "66.67" });
    expect(result.data.customInputs).toEqual({});
  });

  it("rejects a percentage split whose persisted basis points don't total 10000", () => {
    const percentageExpense: CorrectionSourceExpense = { ...equalExpense, splitStrategy: "percentage" };
    const splits: CorrectionSourceSplit[] = [
      { userId: "payer-1", amountMinor: 3000, percentageBasisPoints: 3000 },
      { userId: "user-2", amountMinor: 6000, percentageBasisPoints: 6000 },
    ];
    const result = buildCorrectionPrefill(percentageExpense, splits);
    expect(result.ok).toBe(false);
  });

  it("rejects a percentage split with a missing/malformed percentageBasisPoints value", () => {
    const percentageExpense: CorrectionSourceExpense = { ...equalExpense, splitStrategy: "percentage" };
    const splits: CorrectionSourceSplit[] = [
      { userId: "payer-1", amountMinor: 5000 },
      { userId: "user-2", amountMinor: 5000, percentageBasisPoints: 10000 },
    ];
    const result = buildCorrectionPrefill(percentageExpense, splits);
    expect(result.ok).toBe(false);
  });

  it("prefills a custom-split correction with the EXACT persisted amounts, including a legitimate $0 share", () => {
    const customExpense: CorrectionSourceExpense = { ...equalExpense, splitStrategy: "custom" };
    const splits: CorrectionSourceSplit[] = [
      { userId: "payer-1", amountMinor: 10000 },
      { userId: "user-2", amountMinor: 0 },
    ];
    const result = buildCorrectionPrefill(customExpense, splits);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.customInputs).toEqual({ "payer-1": "100.00", "user-2": "0.00" });
    expect(result.data.percentageInputs).toEqual({});
  });

  it("rejects a custom split whose persisted amounts don't sum to the Expense total", () => {
    const customExpense: CorrectionSourceExpense = { ...equalExpense, splitStrategy: "custom" };
    const splits: CorrectionSourceSplit[] = [
      { userId: "payer-1", amountMinor: 4000 },
      { userId: "user-2", amountMinor: 4000 },
    ];
    const result = buildCorrectionPrefill(customExpense, splits);
    expect(result.ok).toBe(false);
  });

  it("rejects a Shared-Stash-funded original outright, never mis-prefilling it as out-of-pocket", () => {
    const result = buildCorrectionPrefill(
      { ...equalExpense, paymentSource: "shared_stash", payerUid: null },
      equalSplits
    );
    expect(result.ok).toBe(false);
  });

  it("rejects when no Split rows are present at all", () => {
    const result = buildCorrectionPrefill(equalExpense, []);
    expect(result.ok).toBe(false);
  });

  it("rejects Split rows containing a duplicate participant uid", () => {
    const result = buildCorrectionPrefill(equalExpense, [
      { userId: "payer-1", amountMinor: 5000 },
      { userId: "payer-1", amountMinor: 5000 },
    ]);
    expect(result.ok).toBe(false);
  });

  it("sorts participantUids ascending regardless of persisted Split row order", () => {
    const result = buildCorrectionPrefill(equalExpense, [
      { userId: "user-2", amountMinor: 5000 },
      { userId: "payer-1", amountMinor: 5000 },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.participantUids).toEqual(["payer-1", "user-2"]);
  });

  // Checkpoint 4D.7A §3: these previously PASSED prefill (the equal
  // branch validated nothing about amountMinor at all, and the
  // percentage branch only checked that basis points summed to 10000,
  // never that the persisted amounts actually matched those basis
  // points) - this is the exact gap the hardening closes.
  it("rejects an equal split whose persisted amounts don't match the frozen deterministic algorithm", () => {
    // Total (10000) and participant count (2) are both superficially
    // right, but the per-participant split is wrong for an equal share
    // (should be 5000/5000, not 7000/3000).
    const result = buildCorrectionPrefill(equalExpense, [
      { userId: "payer-1", amountMinor: 7000 },
      { userId: "user-2", amountMinor: 3000 },
    ]);
    expect(result.ok).toBe(false);
  });

  it("rejects an equal split with a negative persisted amount", () => {
    const result = buildCorrectionPrefill(equalExpense, [
      { userId: "payer-1", amountMinor: -1 },
      { userId: "user-2", amountMinor: 10001 },
    ]);
    expect(result.ok).toBe(false);
  });

  it("accepts an equal split whose remainder cent lands on the lexicographically-first participant, matching computeEqualSplit exactly", () => {
    const oddExpense: CorrectionSourceExpense = { ...equalExpense, amountMinor: 10001 };
    const result = buildCorrectionPrefill(oddExpense, [
      { userId: "payer-1", amountMinor: 5001 },
      { userId: "user-2", amountMinor: 5000 },
    ]);
    expect(result.ok).toBe(true);
  });

  it("rejects a percentage split whose amounts total correctly but don't match the frozen Percentage algorithm per participant", () => {
    const percentageExpense: CorrectionSourceExpense = { ...equalExpense, splitStrategy: "percentage" };
    // Basis points sum to 10000 and amounts sum to 10000, but the
    // amounts are SWAPPED relative to their basis points (payer-1's 25%
    // share should be 2500, not 7500).
    const result = buildCorrectionPrefill(percentageExpense, [
      { userId: "payer-1", amountMinor: 7500, percentageBasisPoints: 2500 },
      { userId: "user-2", amountMinor: 2500, percentageBasisPoints: 7500 },
    ]);
    expect(result.ok).toBe(false);
  });

  it("accepts a percentage split whose largest-remainder bonus cent matches computePercentageSplit exactly", () => {
    // 10000 * 1/3 basis-point-style split, exercising the largest-
    // remainder rounding path rather than an exact division.
    const percentageExpense: CorrectionSourceExpense = { ...equalExpense, splitStrategy: "percentage" };
    const result = buildCorrectionPrefill(percentageExpense, [
      { userId: "payer-1", amountMinor: 3334, percentageBasisPoints: 3334 },
      { userId: "user-2", amountMinor: 6666, percentageBasisPoints: 6666 },
    ]);
    expect(result.ok).toBe(true);
  });
});

describe("initialCorrectionPhase / nextCorrectionPhase", () => {
  it('starts at "reverse" for an active original', () => {
    expect(initialCorrectionPhase("active")).toBe("reverse");
  });

  it('starts at "create" for an already-reversed, unlinked original (Finish correction)', () => {
    expect(initialCorrectionPhase("reversed")).toBe("create");
  });

  it("advances reverse -> create only on reverse_success", () => {
    expect(nextCorrectionPhase("reverse", { type: "reverse_success" })).toBe("create");
  });

  it("keeps phase at reverse on reverse_failure, so a retry re-attempts ONLY the reversal", () => {
    expect(nextCorrectionPhase("reverse", { type: "reverse_failure" })).toBe("reverse");
  });

  it("advances create -> done only on create_success", () => {
    expect(nextCorrectionPhase("create", { type: "create_success" })).toBe("done");
  });

  it("keeps phase at create on create_failure - THE critical property: a creation failure after a successful reversal never regresses to reverse (no second reversal is ever attempted)", () => {
    expect(nextCorrectionPhase("create", { type: "create_failure" })).toBe("create");
  });

  it("is a no-op once done, regardless of event", () => {
    expect(nextCorrectionPhase("done", { type: "reverse_success" })).toBe("done");
    expect(nextCorrectionPhase("done", { type: "create_failure" })).toBe("done");
  });

  it("end-to-end: active original, ambiguous reversal retried then succeeding, then a failed creation retried without ever revisiting reverse", () => {
    let phase = initialCorrectionPhase("active");
    expect(phase).toBe("reverse");

    // Ambiguous/ any reversal failure - stays on "reverse" for a safe retry.
    phase = nextCorrectionPhase(phase, { type: "reverse_failure" });
    expect(phase).toBe("reverse");

    // Retry succeeds (e.g. an exact-replay verified by the backend).
    phase = nextCorrectionPhase(phase, { type: "reverse_success" });
    expect(phase).toBe("create");

    // Creation fails (ambiguous or otherwise) - must stay on "create",
    // never fall back to "reverse".
    phase = nextCorrectionPhase(phase, { type: "create_failure" });
    expect(phase).toBe("create");

    // Retry of creation succeeds.
    phase = nextCorrectionPhase(phase, { type: "create_success" });
    expect(phase).toBe("done");
  });
});
