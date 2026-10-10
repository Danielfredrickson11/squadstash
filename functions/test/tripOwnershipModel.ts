// Tests for the pure Trip ownership-model state classifier (Checkpoint
// 5B.1). No Firestore emulator needed - pure logic only.
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
  classifyTripOwnershipModelState,
  isValidTripOwnershipModelTransition,
} from "../src/domain/tripOwnershipModel";

describe("CURRENT_TRIP_OWNERSHIP_MODEL_VERSION", () => {
  it("is 1", () => {
    assert.equal(CURRENT_TRIP_OWNERSHIP_MODEL_VERSION, 1);
  });
});

describe("classifyTripOwnershipModelState - valid classifications", () => {
  it("legacy: both state and version absent", () => {
    assert.deepEqual(
      classifyTripOwnershipModelState(undefined, undefined),
      {kind: "legacy"}
    );
  });

  it('legacy: state == "legacy" and version absent (the frozen preflight\'s other legacy representation - corrected by 5B.1A)', () => {
    assert.deepEqual(
      classifyTripOwnershipModelState("legacy", undefined),
      {kind: "legacy"}
    );
  });

  it("migrating: state present, version absent", () => {
    assert.deepEqual(
      classifyTripOwnershipModelState("migrating", undefined),
      {kind: "migrating"}
    );
  });

  it("initialized v1: state present, version a positive safe integer", () => {
    assert.deepEqual(
      classifyTripOwnershipModelState("initialized", 1),
      {kind: "initialized", version: 1}
    );
  });

  it("needs_reconciliation v1: state present, version retained", () => {
    assert.deepEqual(
      classifyTripOwnershipModelState("needs_reconciliation", 1),
      {kind: "needs_reconciliation", version: 1}
    );
  });

  it("initialized at a later version number", () => {
    assert.deepEqual(
      classifyTripOwnershipModelState("initialized", 7),
      {kind: "initialized", version: 7}
    );
  });
});

describe("classifyTripOwnershipModelState - corrupt/impossible states fail closed", () => {
  it("version present but state absent", () => {
    const result = classifyTripOwnershipModelState(undefined, 1);
    assert.equal(result.kind, "corrupt");
  });

  it("initialized with no version", () => {
    const result = classifyTripOwnershipModelState("initialized", undefined);
    assert.equal(result.kind, "corrupt");
  });

  it("initialized with version 0", () => {
    const result = classifyTripOwnershipModelState("initialized", 0);
    assert.equal(result.kind, "corrupt");
  });

  it("initialized with a negative version", () => {
    const result = classifyTripOwnershipModelState("initialized", -1);
    assert.equal(result.kind, "corrupt");
  });

  it("initialized with a fractional version", () => {
    const result = classifyTripOwnershipModelState("initialized", 1.5);
    assert.equal(result.kind, "corrupt");
  });

  it("initialized with an unsafe-integer version", () => {
    const result = classifyTripOwnershipModelState(
      "initialized",
      Number.MAX_SAFE_INTEGER + 2
    );
    assert.equal(result.kind, "corrupt");
  });

  it("initialized with a non-number version", () => {
    const result = classifyTripOwnershipModelState("initialized", "1");
    assert.equal(result.kind, "corrupt");
  });

  it("migrating with a version present (forbidden by the frozen design)", () => {
    const result = classifyTripOwnershipModelState("migrating", 1);
    assert.equal(result.kind, "corrupt");
  });

  it("needs_reconciliation with no version", () => {
    const result = classifyTripOwnershipModelState(
      "needs_reconciliation",
      undefined
    );
    assert.equal(result.kind, "corrupt");
  });

  it("needs_reconciliation with a zero version", () => {
    const result = classifyTripOwnershipModelState("needs_reconciliation", 0);
    assert.equal(result.kind, "corrupt");
  });

  it("an unknown state string", () => {
    const result = classifyTripOwnershipModelState("bogus", undefined);
    assert.equal(result.kind, "corrupt");
  });

  it('"legacy" with a version present is corrupt (version must stay absent for legacy, whichever representation is used)', () => {
    const result = classifyTripOwnershipModelState("legacy", 1);
    assert.equal(result.kind, "corrupt");
  });

  it("every corrupt result carries a non-empty reason string", () => {
    const result = classifyTripOwnershipModelState("bogus", undefined);
    if (result.kind === "corrupt") {
      assert.ok(result.reason.length > 0);
    } else {
      assert.fail("expected a corrupt classification");
    }
  });
});

// Checkpoint 5B.2, item 18: the pure state-TRANSITION validator.
describe("isValidTripOwnershipModelTransition - every allowed transition", () => {
  it("legacy -> migrating", () => {
    assert.equal(
      isValidTripOwnershipModelTransition(
        {kind: "legacy"},
        {kind: "migrating"}
      ),
      true
    );
  });

  it("migrating -> initialized", () => {
    assert.equal(
      isValidTripOwnershipModelTransition(
        {kind: "migrating"},
        {kind: "initialized", version: 1}
      ),
      true
    );
  });

  it("initialized -> needs_reconciliation (same version retained)", () => {
    assert.equal(
      isValidTripOwnershipModelTransition(
        {kind: "initialized", version: 1},
        {kind: "needs_reconciliation", version: 1}
      ),
      true
    );
  });

  it("needs_reconciliation -> initialized (repair complete)", () => {
    assert.equal(
      isValidTripOwnershipModelTransition(
        {kind: "needs_reconciliation", version: 1},
        {kind: "initialized", version: 1}
      ),
      true
    );
  });
});

// Checkpoint 5B.2A, items 3-4: version-retention/version-currency
// hardening for the transition validator.
describe("isValidTripOwnershipModelTransition - reconciliation retains the exact version", () => {
  it("initialized v1 -> needs_reconciliation v1 is allowed", () => {
    assert.equal(
      isValidTripOwnershipModelTransition(
        {kind: "initialized", version: 1},
        {kind: "needs_reconciliation", version: 1}
      ),
      true
    );
  });

  it("initialized v1 -> needs_reconciliation v2 is rejected (version must not change)", () => {
    assert.equal(
      isValidTripOwnershipModelTransition(
        {kind: "initialized", version: 1},
        {kind: "needs_reconciliation", version: 2}
      ),
      false
    );
  });

  it("needs_reconciliation v1 -> initialized v1 is allowed", () => {
    assert.equal(
      isValidTripOwnershipModelTransition(
        {kind: "needs_reconciliation", version: 1},
        {kind: "initialized", version: 1}
      ),
      true
    );
  });

  it("needs_reconciliation v1 -> initialized v2 is rejected (version must not change)", () => {
    assert.equal(
      isValidTripOwnershipModelTransition(
        {kind: "needs_reconciliation", version: 1},
        {kind: "initialized", version: 2}
      ),
      false
    );
  });

  it("the validator is not hardcoded to version 1: v7 -> needs_reconciliation v7 -> initialized v7 is allowed throughout", () => {
    assert.equal(
      isValidTripOwnershipModelTransition(
        {kind: "initialized", version: 7},
        {kind: "needs_reconciliation", version: 7}
      ),
      true
    );
    assert.equal(
      isValidTripOwnershipModelTransition(
        {kind: "needs_reconciliation", version: 7},
        {kind: "initialized", version: 7}
      ),
      true
    );
  });
});

describe("isValidTripOwnershipModelTransition - migrating -> initialized version-currency policy", () => {
  it("migrating -> initialized at CURRENT_TRIP_OWNERSHIP_MODEL_VERSION is allowed", () => {
    assert.equal(
      isValidTripOwnershipModelTransition(
        {kind: "migrating"},
        {kind: "initialized", version: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION}
      ),
      true
    );
  });

  it("migrating -> initialized at an unsupported (CURRENT + 1) version is rejected", () => {
    assert.equal(
      isValidTripOwnershipModelTransition(
        {kind: "migrating"},
        {
          kind: "initialized",
          version: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION + 1,
        }
      ),
      false
    );
  });

  it("migrating -> initialized at an unsupported (version 0-equivalent / too-low) version is rejected", () => {
    // version 2 is not currently supported (CURRENT is 1) even though
    // it is otherwise a well-formed positive safe integer.
    assert.equal(
      isValidTripOwnershipModelTransition(
        {kind: "migrating"},
        {kind: "initialized", version: 2}
      ),
      false
    );
  });

  it("legacy -> migrating remains versionless (no version policy applies)", () => {
    assert.equal(
      isValidTripOwnershipModelTransition(
        {kind: "legacy"},
        {kind: "migrating"}
      ),
      true
    );
  });
});

describe("isValidTripOwnershipModelTransition - every forbidden downgrade/skip", () => {
  it("initialized -> legacy is forbidden", () => {
    assert.equal(
      isValidTripOwnershipModelTransition(
        {kind: "initialized", version: 1},
        {kind: "legacy"}
      ),
      false
    );
  });

  it("needs_reconciliation -> legacy is forbidden", () => {
    assert.equal(
      isValidTripOwnershipModelTransition(
        {kind: "needs_reconciliation", version: 1},
        {kind: "legacy"}
      ),
      false
    );
  });

  it("migrating -> legacy is forbidden", () => {
    assert.equal(
      isValidTripOwnershipModelTransition(
        {kind: "migrating"},
        {kind: "legacy"}
      ),
      false
    );
  });

  it("initialized -> migrating is forbidden (cannot re-enter migration)", () => {
    assert.equal(
      isValidTripOwnershipModelTransition(
        {kind: "initialized", version: 1},
        {kind: "migrating"}
      ),
      false
    );
  });

  it("legacy -> initialized directly is forbidden (must pass through migrating)", () => {
    assert.equal(
      isValidTripOwnershipModelTransition(
        {kind: "legacy"},
        {kind: "initialized", version: 1}
      ),
      false
    );
  });

  it("needs_reconciliation -> migrating is forbidden", () => {
    assert.equal(
      isValidTripOwnershipModelTransition(
        {kind: "needs_reconciliation", version: 1},
        {kind: "migrating"}
      ),
      false
    );
  });

  it("migrating -> needs_reconciliation is forbidden (must become initialized first)", () => {
    assert.equal(
      isValidTripOwnershipModelTransition(
        {kind: "migrating"},
        {kind: "needs_reconciliation", version: 1}
      ),
      false
    );
  });

  it("a state transitioning to itself (no-op) is not a listed legal transition", () => {
    assert.equal(
      isValidTripOwnershipModelTransition(
        {kind: "initialized", version: 1},
        {kind: "initialized", version: 1}
      ),
      false
    );
  });
});

describe("isValidTripOwnershipModelTransition - corrupt states always rejected", () => {
  it("a corrupt FROM state is always rejected, regardless of the TO state", () => {
    assert.equal(
      isValidTripOwnershipModelTransition(
        {kind: "corrupt", reason: "bogus"},
        {kind: "migrating"}
      ),
      false
    );
  });

  it("a corrupt TO state is always rejected, regardless of the FROM state", () => {
    assert.equal(
      isValidTripOwnershipModelTransition(
        {kind: "legacy"},
        {kind: "corrupt", reason: "bogus"}
      ),
      false
    );
  });

  it("corrupt -> corrupt is rejected", () => {
    assert.equal(
      isValidTripOwnershipModelTransition(
        {kind: "corrupt", reason: "a"},
        {kind: "corrupt", reason: "b"}
      ),
      false
    );
  });
});
