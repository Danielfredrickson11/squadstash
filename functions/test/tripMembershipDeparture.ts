// Tests for the pure Trip membership-departure domain primitives
// (Checkpoint 6.7B1). No Firestore emulator needed - pure logic only.
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {HttpsError} from "firebase-functions/v2/https";
import {
  isWellFormedDepartureMatchCandidate,
  removeMemberFromCanonicalMemberIds,
  tripMembershipDepartureId,
  validateCanonicalMemberIds,
} from "../src/domain/tripMembershipDeparture";

describe("tripMembershipDepartureId", () => {
  it("builds the deterministic {tripId}_{uid} id", () => {
    assert.equal(tripMembershipDepartureId("trip-1", "uid-1"), "trip-1_uid-1");
  });

  it("rejects an empty tripId", () => {
    assert.throws(
      () => tripMembershipDepartureId("", "uid-1"),
      (err: unknown) => err instanceof HttpsError && err.code === "invalid-argument"
    );
  });

  it("rejects an empty uid", () => {
    assert.throws(
      () => tripMembershipDepartureId("trip-1", ""),
      (err: unknown) => err instanceof HttpsError && err.code === "invalid-argument"
    );
  });

  it("rejects a tripId containing the delimiter", () => {
    assert.throws(
      () => tripMembershipDepartureId("trip_1", "uid-1"),
      (err: unknown) => err instanceof HttpsError && err.code === "internal"
    );
  });

  it("rejects a uid containing the delimiter", () => {
    assert.throws(
      () => tripMembershipDepartureId("trip-1", "uid_1"),
      (err: unknown) => err instanceof HttpsError && err.code === "internal"
    );
  });
});

describe("isWellFormedDepartureMatchCandidate", () => {
  it("accepts a well-formed record", () => {
    assert.equal(
      isWellFormedDepartureMatchCandidate({
        tripId: "trip-1",
        uid: "uid-1",
        departureType: "left",
        departedByUid: "uid-1",
      }),
      true
    );
  });

  it("accepts departureType \"removed\"", () => {
    assert.equal(
      isWellFormedDepartureMatchCandidate({
        tripId: "trip-1",
        uid: "uid-1",
        departureType: "removed",
        departedByUid: "owner-uid",
      }),
      true
    );
  });

  it("rejects null/non-object values", () => {
    assert.equal(isWellFormedDepartureMatchCandidate(null), false);
    assert.equal(isWellFormedDepartureMatchCandidate("string"), false);
    assert.equal(isWellFormedDepartureMatchCandidate(undefined), false);
  });

  it("rejects a missing/empty tripId", () => {
    assert.equal(
      isWellFormedDepartureMatchCandidate({
        tripId: "",
        uid: "uid-1",
        departureType: "left",
        departedByUid: "uid-1",
      }),
      false
    );
  });

  it("rejects a missing/empty uid", () => {
    assert.equal(
      isWellFormedDepartureMatchCandidate({
        tripId: "trip-1",
        uid: "",
        departureType: "left",
        departedByUid: "uid-1",
      }),
      false
    );
  });

  it("rejects an unknown departureType", () => {
    assert.equal(
      isWellFormedDepartureMatchCandidate({
        tripId: "trip-1",
        uid: "uid-1",
        departureType: "bogus",
        departedByUid: "uid-1",
      }),
      false
    );
  });

  it("rejects a missing/empty departedByUid", () => {
    assert.equal(
      isWellFormedDepartureMatchCandidate({
        tripId: "trip-1",
        uid: "uid-1",
        departureType: "left",
        departedByUid: "",
      }),
      false
    );
  });
});

describe("validateCanonicalMemberIds", () => {
  it("accepts a well-formed owner+members set", () => {
    const result = validateCanonicalMemberIds("owner", ["owner", "a", "b"]);
    assert.deepEqual(result, {
      ok: true,
      memberIds: ["owner", "a", "b"],
    });
  });

  it("rejects a non-string/empty ownerId", () => {
    assert.equal(validateCanonicalMemberIds("", ["owner"]).ok, false);
    assert.equal(validateCanonicalMemberIds(undefined, ["owner"]).ok, false);
  });

  it("rejects a non-array memberIds", () => {
    assert.equal(validateCanonicalMemberIds("owner", "not-an-array").ok, false);
    assert.equal(validateCanonicalMemberIds("owner", undefined).ok, false);
  });

  it("rejects a non-string or empty-string entry", () => {
    assert.equal(validateCanonicalMemberIds("owner", ["owner", 123]).ok, false);
    assert.equal(validateCanonicalMemberIds("owner", ["owner", ""]).ok, false);
  });

  it("rejects a duplicate member entry", () => {
    const result = validateCanonicalMemberIds("owner", ["owner", "a", "a"]);
    assert.equal(result.ok, false);
  });

  it("rejects ownerId missing from memberIds", () => {
    const result = validateCanonicalMemberIds("owner", ["a", "b"]);
    assert.equal(result.ok, false);
  });

  it("rejects ownerId appearing more than once", () => {
    const result = validateCanonicalMemberIds("owner", ["owner", "owner", "a"]);
    assert.equal(result.ok, false);
  });

  it("accepts a Trip whose only member is the owner", () => {
    const result = validateCanonicalMemberIds("owner", ["owner"]);
    assert.deepEqual(result, {ok: true, memberIds: ["owner"]});
  });
});

describe("removeMemberFromCanonicalMemberIds", () => {
  it("removes exactly the target, preserving every unrelated member's order", () => {
    const result = removeMemberFromCanonicalMemberIds(
      "owner",
      ["owner", "a", "b", "c"],
      "b"
    );
    assert.deepEqual(result, {
      ok: true,
      newMemberIds: ["owner", "a", "c"],
    });
  });

  it("removes a non-owner member regardless of their position in the array", () => {
    const result = removeMemberFromCanonicalMemberIds(
      "owner",
      ["a", "owner", "b", "c"],
      "a"
    );
    assert.deepEqual(result, {
      ok: true,
      newMemberIds: ["owner", "b", "c"],
    });
  });

  it("rejects a targetUid absent from memberIds", () => {
    const result = removeMemberFromCanonicalMemberIds(
      "owner",
      ["owner", "a"],
      "nonexistent"
    );
    assert.equal(result.ok, false);
  });

  it("rejects removing the owner (owner invariant would be violated)", () => {
    const result = removeMemberFromCanonicalMemberIds(
      "owner",
      ["owner", "a"],
      "owner"
    );
    assert.equal(result.ok, false);
  });

  it("the resulting array never contains the removed uid", () => {
    const result = removeMemberFromCanonicalMemberIds(
      "owner",
      ["owner", "a", "b"],
      "a"
    );
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.newMemberIds.includes("a"), false);
  });
});
