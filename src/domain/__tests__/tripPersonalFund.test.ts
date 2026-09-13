import { isMatchingTripPersonalBucket, tripPersonalBucketId } from "../tripPersonalFund";

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

describe("isMatchingTripPersonalBucket", () => {
  const valid = {
    bucketType: "trip_personal",
    linkedTripId: "trip-1",
    ownerId: "uid-1",
  };

  it("accepts a bucket whose type/trip/owner all match", () => {
    expect(isMatchingTripPersonalBucket(valid, "trip-1", "uid-1")).toBe(true);
  });

  it("rejects a null bucket (not found)", () => {
    expect(isMatchingTripPersonalBucket(null, "trip-1", "uid-1")).toBe(false);
  });

  it("rejects an undefined bucket (not found)", () => {
    expect(isMatchingTripPersonalBucket(undefined, "trip-1", "uid-1")).toBe(false);
  });

  it("rejects an ordinary personal Bucket (wrong bucketType)", () => {
    expect(
      isMatchingTripPersonalBucket({ ...valid, bucketType: "personal" }, "trip-1", "uid-1")
    ).toBe(false);
  });

  it("rejects a trip_personal fund linked to a different Trip", () => {
    expect(
      isMatchingTripPersonalBucket({ ...valid, linkedTripId: "trip-2" }, "trip-1", "uid-1")
    ).toBe(false);
  });

  it("rejects a trip_personal fund owned by a different member", () => {
    expect(
      isMatchingTripPersonalBucket({ ...valid, ownerId: "uid-2" }, "trip-1", "uid-1")
    ).toBe(false);
  });
});
