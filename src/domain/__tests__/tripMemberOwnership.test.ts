import {
  TripMemberOwnershipIdError,
  isValidOwnershipMinor,
  tripMemberOwnershipId,
} from "../tripMemberOwnership";
import { TripCompositeIdDelimiterError } from "../tripCompositeId";

describe("tripMemberOwnershipId", () => {
  it("joins tripId and uid with the delimiter", () => {
    expect(tripMemberOwnershipId("trip1", "uid1")).toBe("trip1_uid1");
  });

  it("is deterministic - the same input always produces the same output", () => {
    expect(tripMemberOwnershipId("canada-trip", "daniel-uid")).toBe(
      tripMemberOwnershipId("canada-trip", "daniel-uid")
    );
  });

  it("different uids on the same Trip produce different ids", () => {
    expect(tripMemberOwnershipId("trip1", "uidA")).not.toBe(
      tripMemberOwnershipId("trip1", "uidB")
    );
  });

  it("rejects a tripId containing the delimiter", () => {
    expect(() => tripMemberOwnershipId("trip_1", "uid1")).toThrow(
      TripCompositeIdDelimiterError
    );
  });

  it("rejects a uid containing the delimiter", () => {
    expect(() => tripMemberOwnershipId("trip1", "uid_1")).toThrow(
      TripCompositeIdDelimiterError
    );
  });

  // Checkpoint 5B.1A, item 2: corrected - an empty component must be
  // rejected outright (the 5B.1 original incorrectly allowed
  // tripMemberOwnershipId("", "uid1") to succeed as "_uid1").
  it("rejects an empty tripId", () => {
    expect(() => tripMemberOwnershipId("", "uid1")).toThrow(
      TripMemberOwnershipIdError
    );
  });

  it("rejects an empty uid", () => {
    expect(() => tripMemberOwnershipId("trip1", "")).toThrow(
      TripMemberOwnershipIdError
    );
  });

  it("accepts valid, non-empty, delimiter-free components", () => {
    expect(() => tripMemberOwnershipId("trip1", "uid1")).not.toThrow();
  });
});

describe("isValidOwnershipMinor", () => {
  it("accepts zero (a fully-depleted ownership row is valid)", () => {
    expect(isValidOwnershipMinor(0)).toBe(true);
  });

  it("accepts a positive safe integer", () => {
    expect(isValidOwnershipMinor(90000)).toBe(true);
  });

  it("rejects a negative value", () => {
    expect(isValidOwnershipMinor(-1)).toBe(false);
  });

  it("rejects a fractional value", () => {
    expect(isValidOwnershipMinor(1.5)).toBe(false);
  });

  it("rejects an unsafe-integer value", () => {
    expect(isValidOwnershipMinor(Number.MAX_SAFE_INTEGER + 2)).toBe(false);
  });

  it("rejects a non-number value", () => {
    expect(isValidOwnershipMinor("100")).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isValidOwnershipMinor(undefined)).toBe(false);
  });
});
