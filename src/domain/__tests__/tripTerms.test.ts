import {
  hasAcceptedCurrentTripTermsVersion,
  tripTermsFieldsAreComplete,
} from "../tripTerms";

function validFields() {
  return {
    contributionExpectations: "Each member contributes $200 by June 1.",
    expenseAllocationExpectations: "Shared expenses split evenly.",
    sharedStashSpendingAuthority: "Any member may record a Shared Stash expense.",
    withdrawalExpectations: "Uncommitted funds may be withdrawn at any time.",
    settlementExpectations: "Debts settle within 7 days of trip end.",
  };
}

describe("tripTermsFieldsAreComplete", () => {
  it("accepts a fully-populated set of fields", () => {
    expect(tripTermsFieldsAreComplete(validFields())).toBe(true);
  });

  it("rejects when any field is empty", () => {
    expect(
      tripTermsFieldsAreComplete({ ...validFields(), contributionExpectations: "" })
    ).toBe(false);
  });

  it("rejects when any field is only whitespace", () => {
    expect(
      tripTermsFieldsAreComplete({ ...validFields(), withdrawalExpectations: "   " })
    ).toBe(false);
  });

  it("rejects when any field exceeds the max length", () => {
    expect(
      tripTermsFieldsAreComplete({
        ...validFields(),
        settlementExpectations: "x".repeat(2001),
      })
    ).toBe(false);
  });

  it("accepts a field at exactly the max length", () => {
    expect(
      tripTermsFieldsAreComplete({
        ...validFields(),
        settlementExpectations: "x".repeat(2000),
      })
    ).toBe(true);
  });
});

describe("hasAcceptedCurrentTripTermsVersion", () => {
  it("returns false for a member with no acceptance history", () => {
    expect(hasAcceptedCurrentTripTermsVersion([], 3)).toBe(false);
  });

  it("returns true when the member's highest accepted version matches current", () => {
    expect(hasAcceptedCurrentTripTermsVersion([1, 2, 3], 3)).toBe(true);
  });

  it("returns false when the member's highest accepted version is stale", () => {
    expect(hasAcceptedCurrentTripTermsVersion([1, 2], 3)).toBe(false);
  });

  it("is not fooled by accepted versions out of order", () => {
    expect(hasAcceptedCurrentTripTermsVersion([3, 1, 2], 3)).toBe(true);
  });
});
