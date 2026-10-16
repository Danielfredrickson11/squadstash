import {
  tripCreateFactsUnchanged,
  type PreparedTripCreateRequest,
  type TripCreateFacts,
} from "../tripCreateRequest";

function baseFacts(overrides: Partial<TripCreateFacts> = {}): TripCreateFacts {
  return {
    title: "Canada Trip",
    location: "Banff, Canada",
    target: 5000,
    tripStartDate: "2027-06-12",
    tripEndDate: null,
    ...overrides,
  };
}

function basePrepared(
  overrides: Partial<PreparedTripCreateRequest> = {}
): PreparedTripCreateRequest {
  return {
    ...baseFacts(),
    clientRequestId: "req-1",
    imageUrl: "https://example.com/canada.jpg",
    ...overrides,
  };
}

describe("tripCreateFactsUnchanged", () => {
  it("returns false when no attempt has been prepared yet (prior === null)", () => {
    expect(tripCreateFactsUnchanged(null, baseFacts())).toBe(false);
  });

  it("returns true when every canonical fact is identical to the prior attempt", () => {
    expect(tripCreateFactsUnchanged(basePrepared(), baseFacts())).toBe(true);
  });

  it("ignores clientRequestId/imageUrl - only the facts matter", () => {
    const prior = basePrepared({
      clientRequestId: "req-999",
      imageUrl: "https://example.com/different.jpg",
    });
    expect(tripCreateFactsUnchanged(prior, baseFacts())).toBe(true);
  });

  it("returns false when title changed", () => {
    expect(
      tripCreateFactsUnchanged(basePrepared(), baseFacts({ title: "Different Trip" }))
    ).toBe(false);
  });

  it("returns false when location changed", () => {
    expect(
      tripCreateFactsUnchanged(basePrepared(), baseFacts({ location: "Elsewhere" }))
    ).toBe(false);
  });

  it("returns false when location changed from a value to null", () => {
    expect(
      tripCreateFactsUnchanged(basePrepared(), baseFacts({ location: null }))
    ).toBe(false);
  });

  it("returns false when target changed", () => {
    expect(
      tripCreateFactsUnchanged(basePrepared(), baseFacts({ target: 9999 }))
    ).toBe(false);
  });

  it("returns false when tripStartDate changed", () => {
    expect(
      tripCreateFactsUnchanged(
        basePrepared(),
        baseFacts({ tripStartDate: "2030-01-01" })
      )
    ).toBe(false);
  });

  it("returns false when tripEndDate changed from null to a value", () => {
    expect(
      tripCreateFactsUnchanged(
        basePrepared(),
        baseFacts({ tripEndDate: "2027-06-20" })
      )
    ).toBe(false);
  });

  it("returns false when tripEndDate changed between two non-null values", () => {
    const prior = basePrepared({ tripEndDate: "2027-06-20" });
    expect(
      tripCreateFactsUnchanged(
        prior,
        baseFacts({ tripEndDate: "2027-06-21" })
      )
    ).toBe(false);
  });
});
