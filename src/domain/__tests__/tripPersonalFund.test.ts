import { tripPersonalBucketId } from "../tripPersonalFund";

describe("tripPersonalBucketId", () => {
  it("is deterministic for the same (tripId, uid) pair", () => {
    expect(tripPersonalBucketId("trip-1", "uid-1")).toBe(
      tripPersonalBucketId("trip-1", "uid-1")
    );
  });

  it("differs for a different trip", () => {
    expect(tripPersonalBucketId("trip-1", "uid-1")).not.toBe(
      tripPersonalBucketId("trip-2", "uid-1")
    );
  });

  it("differs for a different uid", () => {
    expect(tripPersonalBucketId("trip-1", "uid-1")).not.toBe(
      tripPersonalBucketId("trip-1", "uid-2")
    );
  });

  it("matches the exact formula the trusted Cloud Function must mirror", () => {
    expect(tripPersonalBucketId("canada-trip", "member-uid")).toBe(
      "tripfund_canada-trip_member-uid"
    );
  });
});
