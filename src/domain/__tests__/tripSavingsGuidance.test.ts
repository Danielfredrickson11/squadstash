import { computeTripSavingsGuidance, formatTripHorizonText } from "../tripSavingsGuidance";

describe("computeTripSavingsGuidance", () => {
  it("1. no date -> MISSING_DATE", () => {
    const result = computeTripSavingsGuidance({
      tripStartDate: null,
      targetMinor: 100000,
      savedMinor: 0,
      membersCount: 2,
    });
    expect(result).toEqual({ status: "MISSING_DATE" });
  });

  it("2. malformed date -> MISSING_DATE", () => {
    const result = computeTripSavingsGuidance({
      tripStartDate: "not-a-date",
      targetMinor: 100000,
      savedMinor: 0,
      membersCount: 2,
    });
    expect(result).toEqual({ status: "MISSING_DATE" });
  });

  it("3. future date with exact whole weeks (112 days = 16 weeks)", () => {
    const now = new Date(2027, 0, 1); // Jan 1, 2027
    const result = computeTripSavingsGuidance({
      tripStartDate: "2027-04-23", // 112 days after Jan 1
      targetMinor: 500000,
      savedMinor: 100000,
      membersCount: 4,
      now,
    });
    expect(result).toEqual({
      status: "ACTIVE",
      daysUntilStart: 112,
      fullWeeksUntilStart: 16,
      extraDays: 0,
      remainingMinor: 400000,
      pace: "weekly",
      rateTotalMinor: 25000,
      ratePerPersonMinor: 6250,
    });
  });

  it("4. future date with a partial week (109 days = 15 weeks, 4 days)", () => {
    const now = new Date(2027, 0, 1); // Jan 1, 2027
    const result = computeTripSavingsGuidance({
      tripStartDate: "2027-04-20", // 109 days after Jan 1
      targetMinor: 490000,
      savedMinor: 0,
      membersCount: 2,
      now,
    });
    expect(result).toEqual({
      status: "ACTIVE",
      daysUntilStart: 109,
      fullWeeksUntilStart: 15,
      extraDays: 4,
      remainingMinor: 490000,
      pace: "weekly",
      // ceil(490000 * 7 / 109) = ceil(31467.889...) = 31468
      rateTotalMinor: 31468,
      // ceil(490000 * 7 / (109 * 2)) = ceil(15733.944...) = 15734
      ratePerPersonMinor: 15734,
    });
  });

  it("5. 1 day remaining uses daily pace", () => {
    const now = new Date(2027, 0, 1);
    const result = computeTripSavingsGuidance({
      tripStartDate: "2027-01-02",
      targetMinor: 100000,
      savedMinor: 0,
      membersCount: 1,
      now,
    });
    expect(result).toEqual({
      status: "ACTIVE",
      daysUntilStart: 1,
      fullWeeksUntilStart: 0,
      extraDays: 1,
      remainingMinor: 100000,
      pace: "daily",
      rateTotalMinor: 100000,
      ratePerPersonMinor: 100000,
    });
  });

  it("6. 3 days remaining -> daily mode", () => {
    const now = new Date(2027, 0, 1);
    const result = computeTripSavingsGuidance({
      tripStartDate: "2027-01-04",
      targetMinor: 300000,
      savedMinor: 0,
      membersCount: 1,
      now,
    });
    expect(result.status).toBe("ACTIVE");
    expect(result).toMatchObject({ daysUntilStart: 3, pace: "daily" });
  });

  it("7. 6 days remaining -> still daily mode (just under the threshold)", () => {
    const now = new Date(2027, 0, 1);
    const result = computeTripSavingsGuidance({
      tripStartDate: "2027-01-07",
      targetMinor: 100000,
      savedMinor: 0,
      membersCount: 1,
      now,
    });
    expect(result).toMatchObject({ status: "ACTIVE", daysUntilStart: 6, pace: "daily" });
  });

  it("8. 7 days remaining -> weekly mode (right at the threshold)", () => {
    const now = new Date(2027, 0, 1);
    const result = computeTripSavingsGuidance({
      tripStartDate: "2027-01-08",
      targetMinor: 100000,
      savedMinor: 0,
      membersCount: 1,
      now,
    });
    expect(result).toMatchObject({
      status: "ACTIVE",
      daysUntilStart: 7,
      fullWeeksUntilStart: 1,
      extraDays: 0,
      pace: "weekly",
    });
  });

  it("9. goal already reached (saved === target)", () => {
    const now = new Date(2027, 0, 1);
    const result = computeTripSavingsGuidance({
      tripStartDate: "2027-06-12",
      targetMinor: 100000,
      savedMinor: 100000,
      membersCount: 2,
      now,
    });
    expect(result).toEqual({ status: "GOAL_REACHED", savedMinor: 100000, targetMinor: 100000 });
  });

  it("10. saved > target still reports GOAL_REACHED, with the real (unclamped) saved amount", () => {
    const now = new Date(2027, 0, 1);
    const result = computeTripSavingsGuidance({
      tripStartDate: "2027-06-12",
      targetMinor: 100000,
      savedMinor: 150000,
      membersCount: 2,
      now,
    });
    // The real saved/target values are reported unmutated - 150000 is
    // never clamped down to 100000.
    expect(result).toEqual({ status: "GOAL_REACHED", savedMinor: 150000, targetMinor: 100000 });
  });

  it("11. one member: per-person rate equals the total rate exactly", () => {
    const now = new Date(2027, 0, 1);
    const result = computeTripSavingsGuidance({
      tripStartDate: "2027-01-08", // 7 days
      targetMinor: 70000,
      savedMinor: 0,
      membersCount: 1,
      now,
    });
    expect(result.status).toBe("ACTIVE");
    if (result.status === "ACTIVE") {
      expect(result.ratePerPersonMinor).toBe(result.rateTotalMinor);
    }
  });

  it("12. five members divides the rate accordingly", () => {
    const now = new Date(2027, 0, 1);
    const result = computeTripSavingsGuidance({
      tripStartDate: "2027-01-08", // 7 days, weekly pace
      targetMinor: 350000,
      savedMinor: 0,
      membersCount: 5,
      now,
    });
    // ceil(350000 * 7 / 7) = 350000; ceil(350000 * 7 / (7 * 5)) = 70000
    expect(result).toMatchObject({ rateTotalMinor: 350000, ratePerPersonMinor: 70000 });
  });

  it("13. per-person amount is rounded UP to the nearest cent", () => {
    const now = new Date(2027, 0, 1);
    const result = computeTripSavingsGuidance({
      tripStartDate: "2027-01-11", // 10 days, weekly pace
      targetMinor: 100,
      savedMinor: 0,
      membersCount: 3,
      now,
    });
    // ceil(100 * 7 / (10 * 3)) = ceil(23.333...) = 24, never floored to 23
    expect(result).toMatchObject({ ratePerPersonMinor: 24 });
  });

  it("14. total amount is rounded UP to the nearest cent", () => {
    const now = new Date(2027, 0, 1);
    const result = computeTripSavingsGuidance({
      tripStartDate: "2027-01-04", // 3 days, daily pace
      targetMinor: 100,
      savedMinor: 0,
      membersCount: 1,
      now,
    });
    // ceil(100 * 1 / 3) = ceil(33.333...) = 34, never floored to 33
    expect(result).toMatchObject({ rateTotalMinor: 34 });
  });

  it("15. trip starts today -> TRIP_STARTED with startsToday: true", () => {
    const now = new Date(2027, 5, 12);
    const result = computeTripSavingsGuidance({
      tripStartDate: "2027-06-12",
      targetMinor: 100000,
      savedMinor: 0,
      membersCount: 2,
      now,
    });
    expect(result).toEqual({ status: "TRIP_STARTED", startsToday: true });
  });

  it("16. trip already started (past date) -> TRIP_STARTED with startsToday: false", () => {
    const now = new Date(2027, 5, 20);
    const result = computeTripSavingsGuidance({
      tripStartDate: "2027-06-12",
      targetMinor: 100000,
      savedMinor: 0,
      membersCount: 2,
      now,
    });
    expect(result).toEqual({ status: "TRIP_STARTED", startsToday: false });
  });

  it("17. zero target is INVALID_TARGET, never divides by zero and never claims GOAL_REACHED", () => {
    const now = new Date(2027, 0, 1);
    const result = computeTripSavingsGuidance({
      tripStartDate: "2027-06-12",
      targetMinor: 0,
      savedMinor: 0,
      membersCount: 2,
      now,
    });
    expect(result).toEqual({ status: "INVALID_TARGET" });
  });

  it("18. a DST-crossing horizon still uses computeTripHorizon's real (DST-safe) day count", () => {
    // Mirrors tripDates.test.ts's own US spring-forward DST case exactly
    // (2027-03-14 clocks forward) - a naive local-ms diff would compute
    // 13.958 days instead of the true 14-calendar-day gap.
    const now = new Date(2027, 2, 1); // March 1, 2027
    const result = computeTripSavingsGuidance({
      tripStartDate: "2027-03-15",
      targetMinor: 140000,
      savedMinor: 0,
      membersCount: 1,
      now,
    });
    expect(result).toMatchObject({
      status: "ACTIVE",
      daysUntilStart: 14,
      fullWeeksUntilStart: 2,
      extraDays: 0,
      pace: "weekly",
    });
  });
});

// Checkpoint 3F.3D.1: INVALID_TARGET, state precedence, and hardened
// minor-unit input handling.
describe("computeTripSavingsGuidance - invalid target and state precedence", () => {
  it("1. zero target -> INVALID_TARGET", () => {
    const result = computeTripSavingsGuidance({
      tripStartDate: "2027-06-12",
      targetMinor: 0,
      savedMinor: 0,
      membersCount: 1,
      now: new Date(2027, 0, 1),
    });
    expect(result).toEqual({ status: "INVALID_TARGET" });
  });

  it("2. negative target -> INVALID_TARGET", () => {
    const result = computeTripSavingsGuidance({
      tripStartDate: "2027-06-12",
      targetMinor: -500,
      savedMinor: 0,
      membersCount: 1,
      now: new Date(2027, 0, 1),
    });
    expect(result).toEqual({ status: "INVALID_TARGET" });
  });

  it("3. NaN target -> INVALID_TARGET", () => {
    const result = computeTripSavingsGuidance({
      tripStartDate: "2027-06-12",
      targetMinor: NaN,
      savedMinor: 0,
      membersCount: 1,
      now: new Date(2027, 0, 1),
    });
    expect(result).toEqual({ status: "INVALID_TARGET" });
  });

  it("4. goal reached + missing trip date -> GOAL_REACHED, not MISSING_DATE", () => {
    const result = computeTripSavingsGuidance({
      tripStartDate: null,
      targetMinor: 500000,
      savedMinor: 500000,
      membersCount: 1,
    });
    expect(result).toEqual({ status: "GOAL_REACHED", savedMinor: 500000, targetMinor: 500000 });
  });

  it("5. goal reached + trip already started -> GOAL_REACHED, not TRIP_STARTED", () => {
    const now = new Date(2027, 5, 20); // well after the trip's start
    const result = computeTripSavingsGuidance({
      tripStartDate: "2027-06-12",
      targetMinor: 500000,
      savedMinor: 510000,
      membersCount: 1,
      now,
    });
    expect(result).toEqual({ status: "GOAL_REACHED", savedMinor: 510000, targetMinor: 500000 });
  });

  it("6. NOT reached + trip already started -> TRIP_STARTED", () => {
    const now = new Date(2027, 5, 20);
    const result = computeTripSavingsGuidance({
      tripStartDate: "2027-06-12",
      targetMinor: 500000,
      savedMinor: 490000,
      membersCount: 1,
      now,
    });
    expect(result).toEqual({ status: "TRIP_STARTED", startsToday: false });
  });

  it("7. a malformed fractional minor-unit target (half a cent) is rejected as INVALID_TARGET, not rounded", () => {
    const result = computeTripSavingsGuidance({
      tripStartDate: "2027-06-12",
      targetMinor: 199.5,
      savedMinor: 0,
      membersCount: 1,
      now: new Date(2027, 0, 1),
    });
    expect(result).toEqual({ status: "INVALID_TARGET" });
  });

  it("7b. a malformed fractional minor-unit saved value is treated as 0, not rounded or rejected", () => {
    const now = new Date(2027, 0, 1);
    const result = computeTripSavingsGuidance({
      tripStartDate: "2027-01-08", // 7 days, weekly pace
      targetMinor: 70000,
      savedMinor: 33.7,
      membersCount: 1,
      now,
    });
    // savedMinor is malformed (non-integer) -> treated as 0, so the full
    // target is still remaining, not target-minus-33.7.
    expect(result).toEqual({
      status: "ACTIVE",
      daysUntilStart: 7,
      fullWeeksUntilStart: 1,
      extraDays: 0,
      remainingMinor: 70000,
      pace: "weekly",
      rateTotalMinor: 70000,
      ratePerPersonMinor: 70000,
    });
  });

  it("8. existing ACTIVE calculations remain unchanged for well-formed input", () => {
    const now = new Date(2027, 0, 1);
    const result = computeTripSavingsGuidance({
      tripStartDate: "2027-04-23", // 112 days after Jan 1
      targetMinor: 500000,
      savedMinor: 100000,
      membersCount: 4,
      now,
    });
    expect(result).toEqual({
      status: "ACTIVE",
      daysUntilStart: 112,
      fullWeeksUntilStart: 16,
      extraDays: 0,
      remainingMinor: 400000,
      pace: "weekly",
      rateTotalMinor: 25000,
      ratePerPersonMinor: 6250,
    });
  });
});

describe("formatTripHorizonText", () => {
  it("whole weeks, no remainder days -> omits '0 days'", () => {
    expect(formatTripHorizonText(16, 0)).toBe("16 weeks until your trip");
  });

  it("weeks with a partial-week remainder", () => {
    expect(formatTripHorizonText(15, 4)).toBe("15 weeks, 4 days until your trip");
  });

  it("singular week and singular day", () => {
    expect(formatTripHorizonText(1, 1)).toBe("1 week, 1 day until your trip");
  });

  it("sub-week horizon -> days only, no '0 weeks'", () => {
    expect(formatTripHorizonText(0, 3)).toBe("3 days until your trip");
  });

  it("a single day -> singular", () => {
    expect(formatTripHorizonText(0, 1)).toBe("1 day until your trip");
  });
});
