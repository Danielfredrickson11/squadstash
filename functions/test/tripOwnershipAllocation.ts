// Tests for the trusted tripOwnershipAllocations shape validators
// (Checkpoint 5B.1). No Firestore emulator needed - pure logic only.
// Does NOT test the depletion algorithm itself (not implemented until
// 5B.2) - only that a GIVEN candidate shape is correctly accepted or
// rejected.
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {HttpsError} from "firebase-functions/v2/https";
import {
  assertValidTripOwnershipAllocationShape,
  isValidTripOwnershipAllocationIdentity,
  isValidTripOwnershipAllocationProvenance,
  tripOwnershipAllocationId,
  validateTripOwnershipAllocationEntries,
  validateTripOwnershipAllocationShape,
} from "../src/domain/tripOwnershipAllocation";

function validShape(overrides: Record<string, unknown> = {}) {
  return {
    tripId: "trip1",
    expenseId: "expense1",
    withdrawalTransactionId: "withdrawal1",
    amountMinor: 1000,
    currency: "USD",
    provenance: "original",
    allocations: [
      {uid: "daniel", amountMinor: 900},
      {uid: "friendA", amountMinor: 100},
    ],
    ...overrides,
  };
}

describe("isValidTripOwnershipAllocationProvenance", () => {
  it("accepts \"original\"", () => {
    assert.equal(isValidTripOwnershipAllocationProvenance("original"), true);
  });

  it("accepts \"migrated\"", () => {
    assert.equal(isValidTripOwnershipAllocationProvenance("migrated"), true);
  });

  it("rejects \"migration\" (gerund form was considered and rejected)", () => {
    assert.equal(isValidTripOwnershipAllocationProvenance("migration"), false);
  });

  it("rejects an arbitrary string", () => {
    assert.equal(isValidTripOwnershipAllocationProvenance("bogus"), false);
  });

  it("rejects undefined", () => {
    assert.equal(isValidTripOwnershipAllocationProvenance(undefined), false);
  });
});

describe("validateTripOwnershipAllocationEntries", () => {
  it("accepts a valid multi-member allocation summing exactly to amountMinor", () => {
    const result = validateTripOwnershipAllocationEntries(
      [
        {uid: "daniel", amountMinor: 900},
        {uid: "friendA", amountMinor: 100},
      ],
      1000
    );
    assert.equal(result.ok, true);
  });

  it("rejects a sum mismatch", () => {
    const result = validateTripOwnershipAllocationEntries(
      [
        {uid: "daniel", amountMinor: 900},
        {uid: "friendA", amountMinor: 99},
      ],
      1000
    );
    assert.equal(result.ok, false);
  });

  it("rejects a duplicate uid", () => {
    const result = validateTripOwnershipAllocationEntries(
      [
        {uid: "daniel", amountMinor: 500},
        {uid: "daniel", amountMinor: 500},
      ],
      1000
    );
    assert.equal(result.ok, false);
  });

  it("rejects a zero allocation entry", () => {
    const result = validateTripOwnershipAllocationEntries(
      [
        {uid: "daniel", amountMinor: 1000},
        {uid: "friendA", amountMinor: 0},
      ],
      1000
    );
    assert.equal(result.ok, false);
  });

  it("rejects a negative allocation entry", () => {
    const result = validateTripOwnershipAllocationEntries(
      [{uid: "daniel", amountMinor: -100}],
      -100
    );
    assert.equal(result.ok, false);
  });

  it("rejects a fractional allocation entry", () => {
    const result = validateTripOwnershipAllocationEntries(
      [{uid: "daniel", amountMinor: 100.5}],
      100.5
    );
    assert.equal(result.ok, false);
  });

  it("rejects an unsafe-integer allocation entry", () => {
    const huge = Number.MAX_SAFE_INTEGER + 2;
    const result = validateTripOwnershipAllocationEntries(
      [{uid: "daniel", amountMinor: huge}],
      huge
    );
    assert.equal(result.ok, false);
  });

  it("rejects an empty allocations array", () => {
    const result = validateTripOwnershipAllocationEntries([], 1000);
    assert.equal(result.ok, false);
  });

  it("rejects a non-array value", () => {
    const result = validateTripOwnershipAllocationEntries(
      {daniel: 1000},
      1000
    );
    assert.equal(result.ok, false);
  });

  it("rejects an entry with a non-empty-string uid missing", () => {
    const result = validateTripOwnershipAllocationEntries(
      [{uid: "", amountMinor: 1000}],
      1000
    );
    assert.equal(result.ok, false);
  });

  it("every failure carries a non-empty reason string", () => {
    const result = validateTripOwnershipAllocationEntries([], 1000);
    if (!result.ok) {
      assert.ok(result.reason.length > 0);
    } else {
      assert.fail("expected a failure");
    }
  });
});

// Checkpoint 5B.1A, item 6: canonical strictly-ascending-uid ordering.
describe("validateTripOwnershipAllocationEntries - canonical ordering", () => {
  it("accepts allocations already in strictly ascending uid order", () => {
    const result = validateTripOwnershipAllocationEntries(
      [
        {uid: "alpha", amountMinor: 400},
        {uid: "bravo", amountMinor: 300},
        {uid: "charlie", amountMinor: 300},
      ],
      1000
    );
    assert.equal(result.ok, true);
  });

  it("rejects the exact same entries given out of order", () => {
    const result = validateTripOwnershipAllocationEntries(
      [
        {uid: "bravo", amountMinor: 300},
        {uid: "alpha", amountMinor: 400},
        {uid: "charlie", amountMinor: 300},
      ],
      1000
    );
    assert.equal(result.ok, false);
  });

  it("rejects a reverse-sorted array", () => {
    const result = validateTripOwnershipAllocationEntries(
      [
        {uid: "charlie", amountMinor: 300},
        {uid: "bravo", amountMinor: 300},
        {uid: "alpha", amountMinor: 400},
      ],
      1000
    );
    assert.equal(result.ok, false);
  });

  it("a single-entry allocation has no ordering to violate", () => {
    const result = validateTripOwnershipAllocationEntries(
      [{uid: "solo", amountMinor: 1000}],
      1000
    );
    assert.equal(result.ok, true);
  });

  it("duplicate-uid rejection still fires with its own specific message, not the ordering message", () => {
    const result = validateTripOwnershipAllocationEntries(
      [
        {uid: "alpha", amountMinor: 500},
        {uid: "alpha", amountMinor: 500},
      ],
      1000
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.reason.toLowerCase().includes("duplicate"));
    }
  });

  it("odd/normal valid multi-member allocations remain accepted", () => {
    const result = validateTripOwnershipAllocationEntries(
      [
        {uid: "a", amountMinor: 1},
        {uid: "b", amountMinor: 1},
        {uid: "c", amountMinor: 1},
      ],
      3
    );
    assert.equal(result.ok, true);
  });
});

describe("validateTripOwnershipAllocationShape", () => {
  it("accepts a fully well-formed allocation record", () => {
    assert.equal(validateTripOwnershipAllocationShape(validShape()).ok, true);
  });

  it("rejects a malformed tripId", () => {
    assert.equal(
      validateTripOwnershipAllocationShape(validShape({tripId: ""})).ok,
      false
    );
  });

  it("rejects a malformed expenseId", () => {
    assert.equal(
      validateTripOwnershipAllocationShape(validShape({expenseId: 123})).ok,
      false
    );
  });

  it("rejects a malformed withdrawalTransactionId", () => {
    assert.equal(
      validateTripOwnershipAllocationShape(
        validShape({withdrawalTransactionId: null})
      ).ok,
      false
    );
  });

  it("rejects a malformed currency", () => {
    assert.equal(
      validateTripOwnershipAllocationShape(validShape({currency: ""})).ok,
      false
    );
  });

  it("rejects a non-positive amountMinor", () => {
    assert.equal(
      validateTripOwnershipAllocationShape(validShape({amountMinor: 0})).ok,
      false
    );
  });

  it("rejects an invalid provenance", () => {
    assert.equal(
      validateTripOwnershipAllocationShape(validShape({provenance: "bogus"})).ok,
      false
    );
  });

  it("rejects when the allocations themselves don't sum to amountMinor", () => {
    assert.equal(
      validateTripOwnershipAllocationShape(
        validShape({
          allocations: [{uid: "daniel", amountMinor: 1}],
        })
      ).ok,
      false
    );
  });
});

describe("assertValidTripOwnershipAllocationShape", () => {
  it("does not throw for a valid shape", () => {
    assert.doesNotThrow(() =>
      assertValidTripOwnershipAllocationShape(validShape())
    );
  });

  it("throws HttpsError(\"failed-precondition\") for an invalid shape", () => {
    assert.throws(
      () =>
        assertValidTripOwnershipAllocationShape(validShape({currency: ""})),
      (err: unknown) => {
        assert.ok(err instanceof HttpsError);
        assert.equal((err as HttpsError).code, "failed-precondition");
        return true;
      }
    );
  });
});

// Checkpoint 5B.1A, item 7: the canonical (non-composite) allocation
// document id.
describe("tripOwnershipAllocationId", () => {
  it("returns the withdrawal transaction id unchanged", () => {
    assert.equal(tripOwnershipAllocationId("withdrawal-123"), "withdrawal-123");
  });

  it("is deterministic - the same input always produces the same output", () => {
    assert.equal(
      tripOwnershipAllocationId("withdrawal-abc"),
      tripOwnershipAllocationId("withdrawal-abc")
    );
  });

  it("rejects an empty id", () => {
    assert.throws(
      () => tripOwnershipAllocationId(""),
      (err: unknown) => {
        assert.ok(err instanceof HttpsError);
        assert.equal((err as HttpsError).code, "invalid-argument");
        return true;
      }
    );
  });

  it("does NOT apply the composite-id underscore restriction - an id containing an underscore is accepted unchanged", () => {
    // This is not a composite id (only one component), so the `_`
    // delimiter guard governing tripInvitationId/tripMemberOwnershipId
    // does not apply here at all.
    assert.equal(
      tripOwnershipAllocationId("withdrawal_with_underscores"),
      "withdrawal_with_underscores"
    );
  });
});

describe("isValidTripOwnershipAllocationIdentity", () => {
  it("accepts a matching documentId/withdrawalTransactionId pair", () => {
    assert.equal(
      isValidTripOwnershipAllocationIdentity("withdrawal-1", "withdrawal-1"),
      true
    );
  });

  it("rejects a mismatched pair", () => {
    assert.equal(
      isValidTripOwnershipAllocationIdentity("withdrawal-1", "withdrawal-2"),
      false
    );
  });
});
