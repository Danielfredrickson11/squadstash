import {
  computeTripHorizon,
  formatTripDates,
  isValidCanonicalDate,
  todayCanonicalDate,
} from "../tripDates";

describe("isValidCanonicalDate", () => {
  it("accepts a well-formed calendar date", () => {
    expect(isValidCanonicalDate("2027-06-12")).toBe(true);
  });

  it("rejects an impossible calendar date (Feb 30)", () => {
    expect(isValidCanonicalDate("2027-02-30")).toBe(false);
  });

  it("rejects a locale-formatted string", () => {
    expect(isValidCanonicalDate("06/12/2027")).toBe(false);
  });

  it("rejects a date with a time component", () => {
    expect(isValidCanonicalDate("2027-06-12T00:00:00Z")).toBe(false);
  });

  it("rejects garbage input", () => {
    expect(isValidCanonicalDate("not a date")).toBe(false);
    expect(isValidCanonicalDate("")).toBe(false);
  });

  it("accepts a real Feb 29 on a leap year and rejects it on a non-leap year", () => {
    expect(isValidCanonicalDate("2028-02-29")).toBe(true);
    expect(isValidCanonicalDate("2027-02-29")).toBe(false);
  });
});

describe("todayCanonicalDate", () => {
  it("formats a given local date as YYYY-MM-DD", () => {
    expect(todayCanonicalDate(new Date(2027, 5, 12))).toBe("2027-06-12");
  });

  it("zero-pads single-digit months and days", () => {
    expect(todayCanonicalDate(new Date(2027, 0, 5))).toBe("2027-01-05");
  });
});

describe("computeTripHorizon", () => {
  it("returns null when there is no start date", () => {
    expect(computeTripHorizon(null)).toBeNull();
    expect(computeTripHorizon(undefined)).toBeNull();
  });

  it("returns null for an invalid/malformed stored date rather than guessing", () => {
    expect(computeTripHorizon("06/12/2027")).toBeNull();
    expect(computeTripHorizon("not-a-date")).toBeNull();
  });

  it("computes days/weeks until a future start date", () => {
    const now = new Date(2027, 0, 1); // Jan 1, 2027
    const result = computeTripHorizon("2027-01-29", now); // 28 days later
    expect(result).toEqual({ daysUntilStart: 28, weeksUntilStart: 4, hasStarted: false });
  });

  it("a trip starting today reports hasStarted: true and 0, not a negative", () => {
    const now = new Date(2027, 5, 12);
    const result = computeTripHorizon("2027-06-12", now);
    expect(result).toEqual({ daysUntilStart: 0, weeksUntilStart: 0, hasStarted: true });
  });

  it("a trip that already started (past date) reports hasStarted: true and 0, never negative", () => {
    const now = new Date(2027, 5, 20);
    const result = computeTripHorizon("2027-06-12", now);
    expect(result).toEqual({ daysUntilStart: 0, weeksUntilStart: 0, hasStarted: true });
  });

  it("floors partial weeks rather than rounding", () => {
    const now = new Date(2027, 0, 1);
    const result = computeTripHorizon("2027-01-14", now); // 13 days later
    expect(result?.daysUntilStart).toBe(13);
    expect(result?.weeksUntilStart).toBe(1);
  });

  // The specific DST case that plain (msA - msB) / 86_400_000 division on
  // ordinary local Date objects gets wrong: US clocks spring forward on
  // 2027-03-14, so a naive local-time diff between March 1 and March 15
  // (a real 14-calendar-day gap) would compute 13.958 days (one hour
  // short) and could floor/round to the wrong day count. UTC-anchored
  // calendar-field arithmetic must still report exactly 14.
  it("is not thrown off by a US DST spring-forward transition between the two dates", () => {
    const now = new Date(2027, 2, 1); // March 1, 2027 (before the change)
    const result = computeTripHorizon("2027-03-15", now); // March 15, 2027 (after)
    expect(result?.daysUntilStart).toBe(14);
  });

  it("is not thrown off by a US DST fall-back transition between the two dates", () => {
    const now = new Date(2027, 10, 1); // Nov 1, 2027 (before the change)
    const result = computeTripHorizon("2027-11-15", now); // Nov 15, 2027 (after)
    expect(result?.daysUntilStart).toBe(14);
  });
});

describe("formatTripDates", () => {
  it("both dates present, same year -> compact range", () => {
    expect(formatTripDates("2027-06-12", "2027-06-18")).toBe("Jun 12 – Jun 18, 2027");
  });

  it("both dates present, different years -> full range", () => {
    expect(formatTripDates("2027-12-28", "2028-01-03")).toBe("Dec 28, 2027 – Jan 3, 2028");
  });

  it("start only -> Starts <date>", () => {
    expect(formatTripDates("2027-06-12", null)).toBe("Starts Jun 12, 2027");
    expect(formatTripDates("2027-06-12", undefined)).toBe("Starts Jun 12, 2027");
  });

  it("neither date -> null (caller renders its own truthful fallback)", () => {
    expect(formatTripDates(null, null)).toBeNull();
    expect(formatTripDates(undefined, undefined)).toBeNull();
  });

  it("end date present but invalid is treated as absent, not thrown", () => {
    expect(formatTripDates("2027-06-12", "not-a-date")).toBe("Starts Jun 12, 2027");
  });

  it("invalid start date with a valid end date still returns null (never fabricates a start)", () => {
    expect(formatTripDates("not-a-date", "2027-06-18")).toBeNull();
  });
});
