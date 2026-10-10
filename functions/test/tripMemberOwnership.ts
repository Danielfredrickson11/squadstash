// Tests for the trusted tripMemberOwnership id helper and value
// validator (Checkpoint 5B.1). No Firestore emulator needed - pure
// logic only.
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {HttpsError} from "firebase-functions/v2/https";
import {
  isValidOwnershipMinor,
  tripMemberOwnershipId,
} from "../src/domain/tripMemberOwnership";

describe("tripMemberOwnershipId", () => {
  it("joins tripId and uid with the delimiter", () => {
    assert.equal(tripMemberOwnershipId("trip1", "uid1"), "trip1_uid1");
  });

  it("is deterministic - the same input always produces the same output", () => {
    assert.equal(
      tripMemberOwnershipId("canada-trip", "daniel-uid"),
      tripMemberOwnershipId("canada-trip", "daniel-uid")
    );
  });

  it("different uids on the same Trip produce different ids", () => {
    assert.notEqual(
      tripMemberOwnershipId("trip1", "uidA"),
      tripMemberOwnershipId("trip1", "uidB")
    );
  });

  it("rejects a tripId containing the delimiter", () => {
    assert.throws(
      () => tripMemberOwnershipId("trip_1", "uid1"),
      (err: unknown) => {
        assert.ok(err instanceof HttpsError);
        assert.equal((err as HttpsError).code, "internal");
        return true;
      }
    );
  });

  it("rejects a uid containing the delimiter", () => {
    assert.throws(
      () => tripMemberOwnershipId("trip1", "uid_1"),
      (err: unknown) => {
        assert.ok(err instanceof HttpsError);
        assert.equal((err as HttpsError).code, "internal");
        return true;
      }
    );
  });

  // Checkpoint 5B.1A, item 2: corrected - an empty component must be
  // rejected outright, never silently accepted into a degenerate id
  // (the 5B.1 original incorrectly allowed `tripMemberOwnershipId("",
  // "uid1")` to succeed as `"_uid1"`).
  it("rejects an empty tripId", () => {
    assert.throws(
      () => tripMemberOwnershipId("", "uid1"),
      (err: unknown) => {
        assert.ok(err instanceof HttpsError);
        assert.equal((err as HttpsError).code, "invalid-argument");
        return true;
      }
    );
  });

  it("rejects an empty uid", () => {
    assert.throws(
      () => tripMemberOwnershipId("trip1", ""),
      (err: unknown) => {
        assert.ok(err instanceof HttpsError);
        assert.equal((err as HttpsError).code, "invalid-argument");
        return true;
      }
    );
  });

  it("accepts valid, non-empty, delimiter-free components", () => {
    assert.doesNotThrow(() => tripMemberOwnershipId("trip1", "uid1"));
  });
});

describe("isValidOwnershipMinor", () => {
  it("accepts zero (a fully-depleted ownership row is valid)", () => {
    assert.equal(isValidOwnershipMinor(0), true);
  });

  it("accepts a positive safe integer", () => {
    assert.equal(isValidOwnershipMinor(90000), true);
  });

  it("rejects a negative value", () => {
    assert.equal(isValidOwnershipMinor(-1), false);
  });

  it("rejects a fractional value", () => {
    assert.equal(isValidOwnershipMinor(1.5), false);
  });

  it("rejects an unsafe-integer value", () => {
    assert.equal(isValidOwnershipMinor(Number.MAX_SAFE_INTEGER + 2), false);
  });

  it("rejects a non-number value", () => {
    assert.equal(isValidOwnershipMinor("100"), false);
  });

  it("rejects undefined", () => {
    assert.equal(isValidOwnershipMinor(undefined), false);
  });
});
