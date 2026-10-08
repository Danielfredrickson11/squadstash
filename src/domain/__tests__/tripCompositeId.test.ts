import {
  TripCompositeIdDelimiterError,
  assertNoTripCompositeIdDelimiter,
} from "../tripCompositeId";

describe("assertNoTripCompositeIdDelimiter", () => {
  it("does not throw for a delimiter-free value", () => {
    expect(() => assertNoTripCompositeIdDelimiter("abc123", "tripId")).not.toThrow();
  });

  it("throws TripCompositeIdDelimiterError when the value contains an underscore", () => {
    expect(() => assertNoTripCompositeIdDelimiter("abc_123", "tripId")).toThrow(
      TripCompositeIdDelimiterError
    );
  });

  it("includes the given label in the thrown error message", () => {
    expect(() => assertNoTripCompositeIdDelimiter("a_b", "inviteeUid")).toThrow(
      /inviteeUid/
    );
  });

  it("does not throw for an empty string", () => {
    expect(() => assertNoTripCompositeIdDelimiter("", "tripId")).not.toThrow();
  });
});
