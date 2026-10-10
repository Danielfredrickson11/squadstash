// Tests for the pure Trip ownership-model state classifier (Checkpoint
// 5B.1). No Firestore emulator needed - pure logic only.
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
  classifyTripOwnershipModelState,
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
