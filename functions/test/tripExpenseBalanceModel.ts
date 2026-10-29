// Tests for the pure Trip expense-balance-model state classifier
// (Checkpoint 6.7A). No Firestore emulator needed - pure logic only.
// Mirrors tripOwnershipModel.ts's own test file structure exactly (same
// four-state shape), since classifyTripExpenseBalanceModelState mirrors
// classifyTripOwnershipModelState's own behavior precisely - but this
// file tests the independent expenseBalanceModelState/Version fields,
// never the ownership ones.
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  CURRENT_TRIP_EXPENSE_BALANCE_MODEL_VERSION,
  classifyExpenseBalanceMutationGate,
  classifyTripExpenseBalanceModelState,
} from "../src/domain/tripExpenseBalanceModel";

describe("CURRENT_TRIP_EXPENSE_BALANCE_MODEL_VERSION", () => {
  it("is 1", () => {
    assert.equal(CURRENT_TRIP_EXPENSE_BALANCE_MODEL_VERSION, 1);
  });
});

describe("classifyTripExpenseBalanceModelState - valid classifications", () => {
  it("legacy: both state and version absent", () => {
    assert.deepEqual(
      classifyTripExpenseBalanceModelState(undefined, undefined),
      {kind: "legacy"}
    );
  });

  it('legacy: state == "legacy" and version absent', () => {
    assert.deepEqual(
      classifyTripExpenseBalanceModelState("legacy", undefined),
      {kind: "legacy"}
    );
  });

  it("migrating: state present, version absent", () => {
    assert.deepEqual(
      classifyTripExpenseBalanceModelState("migrating", undefined),
      {kind: "migrating"}
    );
  });

  it("initialized v1: state present, version a positive safe integer", () => {
    assert.deepEqual(
      classifyTripExpenseBalanceModelState("initialized", 1),
      {kind: "initialized", version: 1}
    );
  });

  it("needs_reconciliation v1: state present, version retained", () => {
    assert.deepEqual(
      classifyTripExpenseBalanceModelState("needs_reconciliation", 1),
      {kind: "needs_reconciliation", version: 1}
    );
  });

  it("initialized at a later version number", () => {
    assert.deepEqual(
      classifyTripExpenseBalanceModelState("initialized", 7),
      {kind: "initialized", version: 7}
    );
  });
});

describe("classifyTripExpenseBalanceModelState - corrupt/impossible states fail closed", () => {
  it("version present but state absent", () => {
    const result = classifyTripExpenseBalanceModelState(undefined, 1);
    assert.equal(result.kind, "corrupt");
  });

  it("initialized with no version", () => {
    const result = classifyTripExpenseBalanceModelState(
      "initialized",
      undefined
    );
    assert.equal(result.kind, "corrupt");
  });

  it("initialized with version 0", () => {
    const result = classifyTripExpenseBalanceModelState("initialized", 0);
    assert.equal(result.kind, "corrupt");
  });

  it("initialized with a negative version", () => {
    const result = classifyTripExpenseBalanceModelState("initialized", -1);
    assert.equal(result.kind, "corrupt");
  });

  it("initialized with a fractional version", () => {
    const result = classifyTripExpenseBalanceModelState("initialized", 1.5);
    assert.equal(result.kind, "corrupt");
  });

  it("initialized with an unsafe-integer version", () => {
    const result = classifyTripExpenseBalanceModelState(
      "initialized",
      Number.MAX_SAFE_INTEGER + 2
    );
    assert.equal(result.kind, "corrupt");
  });

  it("initialized with a non-number version", () => {
    const result = classifyTripExpenseBalanceModelState("initialized", "1");
    assert.equal(result.kind, "corrupt");
  });

  it("migrating with a version present (forbidden by the frozen design)", () => {
    const result = classifyTripExpenseBalanceModelState("migrating", 1);
    assert.equal(result.kind, "corrupt");
  });

  it("needs_reconciliation with no version", () => {
    const result = classifyTripExpenseBalanceModelState(
      "needs_reconciliation",
      undefined
    );
    assert.equal(result.kind, "corrupt");
  });

  it("an unknown state string", () => {
    const result = classifyTripExpenseBalanceModelState("bogus", undefined);
    assert.equal(result.kind, "corrupt");
  });

  it('"legacy" with a version present is corrupt', () => {
    const result = classifyTripExpenseBalanceModelState("legacy", 1);
    assert.equal(result.kind, "corrupt");
  });

  it("every corrupt result carries a non-empty reason string", () => {
    const result = classifyTripExpenseBalanceModelState("bogus", undefined);
    if (result.kind === "corrupt") {
      assert.ok(result.reason.length > 0);
    } else {
      assert.fail("expected a corrupt classification");
    }
  });
});

describe("classifyExpenseBalanceMutationGate", () => {
  it("absent state classifies as legacy", () => {
    assert.deepEqual(
      classifyExpenseBalanceMutationGate(undefined, undefined),
      {kind: "legacy"}
    );
  });

  it('explicit "legacy" state classifies as legacy', () => {
    assert.deepEqual(
      classifyExpenseBalanceMutationGate("legacy", undefined),
      {kind: "legacy"}
    );
  });

  it('"migrating" classifies as blocked', () => {
    assert.deepEqual(
      classifyExpenseBalanceMutationGate("migrating", undefined),
      {kind: "blocked"}
    );
  });

  it('"needs_reconciliation" at the current version classifies as blocked', () => {
    assert.deepEqual(
      classifyExpenseBalanceMutationGate(
        "needs_reconciliation",
        CURRENT_TRIP_EXPENSE_BALANCE_MODEL_VERSION
      ),
      {kind: "blocked"}
    );
  });

  it('"initialized" at CURRENT_TRIP_EXPENSE_BALANCE_MODEL_VERSION classifies as initialized', () => {
    assert.deepEqual(
      classifyExpenseBalanceMutationGate(
        "initialized",
        CURRENT_TRIP_EXPENSE_BALANCE_MODEL_VERSION
      ),
      {
        kind: "initialized",
        version: CURRENT_TRIP_EXPENSE_BALANCE_MODEL_VERSION,
      }
    );
  });

  it('"initialized" at an unsupported version classifies as fail_closed', () => {
    assert.deepEqual(
      classifyExpenseBalanceMutationGate("initialized", 999),
      {kind: "fail_closed"}
    );
  });

  it("every corrupt combination classifies as fail_closed", () => {
    const corruptCombinations: Array<[unknown, unknown]> = [
      [undefined, 1],
      ["migrating", 1],
      ["initialized", undefined],
      ["needs_reconciliation", undefined],
      ["bogus", undefined],
      ["legacy", 1],
    ];
    for (const [state, version] of corruptCombinations) {
      assert.deepEqual(
        classifyExpenseBalanceMutationGate(state, version),
        {kind: "fail_closed"},
        `expected fail_closed for state=${String(state)}, ` +
          `version=${String(version)}`
      );
    }
  });
});
