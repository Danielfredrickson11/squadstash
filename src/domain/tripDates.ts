// Pure, client-side calendar-date helpers for Trip start/end dates
// (Milestone 3 Checkpoint 3F.3B.2). No Firestore, no UI, no framework
// imports.
//
// Trip.tripStartDate / Trip.tripEndDate are canonical DATE-ONLY strings
// ("YYYY-MM-DD", e.g. "2027-06-12") - never a Firestore Timestamp and
// never a locale-formatted string like "06/12/2027". This is the same
// representation this checkpoint's report explains choosing over the
// existing (frozen, never-wired-up) Trip.startDate/endDate
// PersistedTimestamp fields: a Timestamp encodes a specific instant, and
// converting a calendar date to/from one requires picking a timezone,
// which is exactly the class of bug ("was it still June 12 where the
// user was, or had it already rolled over to June 13 UTC?") a pure
// calendar-date string sidesteps entirely by never having a time
// component to begin with.
//
// Every date computation below is done via Date.UTC(year, month, day)
// using the same (year, month, day) triple for every date involved -
// deliberately never a straight `(dateA - dateB) / 86_400_000` on
// ordinary local-timezone Date objects, which drifts by the DST offset
// whenever the two dates straddle a spring-forward/fall-back transition
// (a "day" is not always exactly 86,400,000ms in local time). Anchoring
// both sides to UTC noon-free midnight for the same calendar fields
// keeps the arithmetic pure calendar math, immune to the local
// timezone's own DST rules.

const CANONICAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

type CalendarDate = { year: number; month: number; day: number };

function parseCanonicalDate(value: string): CalendarDate | null {
  const match = CANONICAL_DATE_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  // Rejects impossible calendar dates (e.g. "2027-02-30") by round-
  // tripping through Date.UTC and checking every field survives
  // unchanged - Date.UTC silently rolls an out-of-range day/month
  // forward rather than throwing.
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

// Exported for reuse by form validation (Trip Create) - a single source
// of truth for "is this a real YYYY-MM-DD calendar date" rather than
// duplicating the regex/round-trip check at each call site.
export function isValidCanonicalDate(value: string): boolean {
  return parseCanonicalDate(value) !== null;
}

function calendarDateFromLocalDate(date: Date): CalendarDate {
  // .getFullYear()/.getMonth()/.getDate() are LOCAL-timezone getters -
  // this reads "today" as the user's own local calendar date, not UTC's.
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}

function utcMillisFor(calendarDate: CalendarDate): number {
  return Date.UTC(calendarDate.year, calendarDate.month - 1, calendarDate.day);
}

// Today's local calendar date as a canonical string - used by Trip
// Create's "start date cannot be before today" validation and as a
// truthful default lower bound, never as a stored value.
export function todayCanonicalDate(now: Date = new Date()): string {
  const { year, month, day } = calendarDateFromLocalDate(now);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export type TripHorizon = {
  daysUntilStart: number;
  weeksUntilStart: number;
  hasStarted: boolean;
  // Checkpoint 3F.3D: true only when the start date IS today (rawDays
  // === 0) - false for a genuinely past start date, even though both
  // cases report hasStarted: true/daysUntilStart: 0 identically. Added
  // for callers (trip savings guidance) that need to say "Trip starts
  // today" rather than the less accurate "Trip has started" for a trip
  // that hasn't actually started yet today.
  startsToday: boolean;
};

// Days/weeks until a trip's start date, in local calendar-day terms
// (see the module comment above for why UTC-anchored arithmetic is used
// even though the inputs are local calendar dates). Returns null when
// there is no real start date to compute from, or when the stored value
// isn't a valid canonical date - never a fabricated/guessed horizon.
// A trip whose start date is today or already in the past reports
// hasStarted: true and daysUntilStart/weeksUntilStart: 0, rather than a
// negative count.
export function computeTripHorizon(
  tripStartDate: string | null | undefined,
  now: Date = new Date()
): TripHorizon | null {
  if (!tripStartDate) return null;

  const start = parseCanonicalDate(tripStartDate);
  if (!start) return null;

  const startUtcMillis = utcMillisFor(start);
  const todayUtcMillis = utcMillisFor(calendarDateFromLocalDate(now));

  const rawDays = Math.round((startUtcMillis - todayUtcMillis) / 86_400_000);
  const hasStarted = rawDays <= 0;
  const daysUntilStart = hasStarted ? 0 : rawDays;

  return {
    daysUntilStart,
    weeksUntilStart: Math.floor(daysUntilStart / 7),
    hasStarted,
    startsToday: rawDays === 0,
  };
}

const MONTH_ABBREVIATIONS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

function formatCalendarDate(calendarDate: CalendarDate): string {
  return `${MONTH_ABBREVIATIONS[calendarDate.month - 1]} ${calendarDate.day}, ${calendarDate.year}`;
}

// Checkpoint 3F.3D: a single formatted date with no "Starts "/range
// prefix (unlike formatTripDates below), for callers that need to embed
// just the trip's start date inline in a sentence (e.g. trip savings
// guidance's "...reach the shared goal by Dec 31, 2026."). Returns null
// for a missing/invalid date, same contract as formatTripDates.
export function formatCanonicalDateShort(value: string | null | undefined): string | null {
  const parsed = value ? parseCanonicalDate(value) : null;
  return parsed ? formatCalendarDate(parsed) : null;
}

// Truthful display formatting for a trip's real dates - never invents a
// date that isn't present. Returns null when there is no valid start
// date at all, so callers (Active Trip hero, Other Stashes, Trip Detail)
// can render their own "Add trip dates" fallback copy instead.
//
//   both dates, same year  -> "Jun 12 – Jun 18, 2027"
//   both dates, diff years -> "Jun 12, 2027 – Jan 3, 2028"
//   start only             -> "Starts Jun 12, 2027"
//   neither / invalid      -> null
export function formatTripDates(
  startDate: string | null | undefined,
  endDate: string | null | undefined
): string | null {
  const start = startDate ? parseCanonicalDate(startDate) : null;
  if (!start) return null;

  const end = endDate ? parseCanonicalDate(endDate) : null;
  if (!end) return `Starts ${formatCalendarDate(start)}`;

  if (start.year === end.year) {
    return `${MONTH_ABBREVIATIONS[start.month - 1]} ${start.day} – ${formatCalendarDate(end)}`;
  }
  return `${formatCalendarDate(start)} – ${formatCalendarDate(end)}`;
}
