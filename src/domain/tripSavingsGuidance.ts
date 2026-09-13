// Pure, client-side Shared Stash savings-pace guidance (Milestone 3
// Checkpoint 3F.3D). No Firestore, no UI, no framework imports - derived
// display-only math, never persisted, never a second source of truth for
// any stored financial field. Reuses computeTripHorizon (tripDates.ts)
// for all date arithmetic rather than duplicating calendar-date logic.
//
// Money in this file is integer MINOR units (cents), never dollars - the
// caller (Trip Detail) converts trip.saved/trip.target (dollar-
// denominated display caches) to minor units before calling, the same
// Math.round(dollars * 100) conversion submitSharedAction already uses
// for its own non-authoritative balance check.
import { computeTripHorizon } from "./tripDates";

// A trip within this many days is close enough that an average WEEKLY
// pace stops being a useful number (e.g. "$50/week" when the trip is in
// 3 days both understates the real near-term ask and can't actually be
// paced out over a week that doesn't exist before the trip starts) - a
// DAILY pace is shown instead. 7+ days still uses the weekly pace.
const DAILY_PACE_THRESHOLD_DAYS = 7;

// Checkpoint 3F.3D.1: the union is declared in the exact order
// computeTripSavingsGuidance evaluates it (see the function body's own
// section comments) - INVALID_TARGET and GOAL_REACHED are both checked
// BEFORE the trip date is even looked at, since neither depends on it:
// a target that was never usable, or a goal that's already met, stays
// true regardless of whether the trip has a date, starts today, or
// already started. Only once neither of those applies does the date
// itself get inspected (MISSING_DATE, then TRIP_STARTED, then ACTIVE).
export type TripSavingsGuidance =
  // Named INVALID_TARGET rather than MISSING_TARGET - it covers more
  // than an absent target (zero, negative, non-finite, and non-integer-
  // minor-unit values all land here too, see the function body), and
  // from the UI's perspective all of those are equally "there is no
  // usable target to calculate a pace from," with identical copy either
  // way. MISSING_TARGET would undersell that a *present but malformed*
  // target is handled the same way, not merely an absent one.
  | { status: "INVALID_TARGET" }
  | { status: "GOAL_REACHED"; savedMinor: number; targetMinor: number }
  | { status: "MISSING_DATE" }
  // Checkpoint 3F.3D extends computeTripHorizon's `hasStarted` with a
  // `startsToday` distinction (see tripDates.ts) so this state can say
  // "Trip starts today" rather than the less accurate "Trip has
  // started" for a trip that starts later today.
  | { status: "TRIP_STARTED"; startsToday: boolean }
  | {
      status: "ACTIVE";
      daysUntilStart: number;
      fullWeeksUntilStart: number;
      // 0-6, the remainder after fullWeeksUntilStart whole weeks -
      // named distinctly from computeTripHorizon's own floored
      // `weeksUntilStart` so a caller formatting "15 weeks, 4 days"
      // never confuses the two.
      extraDays: number;
      remainingMinor: number;
      // Checkpoint 3F.3D design note: the checkpoint's suggested shape
      // named these `weeklyTotalMinor`/`weeklyPerPersonMinor`, but a
      // short-horizon trip (< DAILY_PACE_THRESHOLD_DAYS) shows a DAILY
      // rate instead (section 6) - keeping a "weekly"-named field that
      // sometimes actually holds a daily rate would be a misleading
      // field name at the exact moments it matters most (very close
      // trips). `pace` names which unit `rateTotalMinor`/
      // `ratePerPersonMinor` are actually denominated in, so a caller
      // can render "$X / week" or "$X / day" correctly without ever
      // needing to re-derive which mode is active.
      pace: "weekly" | "daily";
      rateTotalMinor: number;
      ratePerPersonMinor: number;
    };

export type TripSavingsGuidanceInput = {
  tripStartDate: string | null | undefined;
  targetMinor: number;
  savedMinor: number;
  membersCount: number;
  // Injectable for deterministic tests - defaults to the real current
  // time, matching computeTripHorizon's own `now` parameter.
  now?: Date;
};

export function computeTripSavingsGuidance(
  input: TripSavingsGuidanceInput
): TripSavingsGuidance {
  // Checkpoint 3F.3D.1 section 1/3: a target of 0, negative, non-finite,
  // or a fractional (non-integer) minor-unit value is never treated as
  // "0 remaining" / GOAL_REACHED - that previously produced a misleading
  // "Shared goal reached, $0 saved". There is no usable target at all
  // here, which is a genuinely different truthful state. Prefers
  // Number.isSafeInteger over Number.isFinite: this is a pure helper
  // that CLAIMS integer minor-unit inputs, so a value like 199.5 (half a
  // cent) is exactly as invalid as -1 or NaN, not a value to silently
  // round.
  const isValidTargetMinor = Number.isSafeInteger(input.targetMinor) && input.targetMinor > 0;
  if (!isValidTargetMinor) {
    return { status: "INVALID_TARGET" };
  }
  const targetMinor = input.targetMinor;

  // savedMinor gets the same integer-minor-unit scrutiny, but malformed
  // input here is handled differently on purpose: a target either works
  // as a basis for a pace or it doesn't (hence its own dedicated
  // state), but a bad/missing SAVED figure still has a truthful safe
  // fallback - treat it as "nothing saved yet" (0). That is the
  // direction that can never understate what's left to save (it can
  // only make `remainingMinor` as large as the full target, never
  // smaller than reality), so it can never fabricate an artificially
  // low or already-met pace from bad data.
  const savedMinor =
    Number.isSafeInteger(input.savedMinor) && input.savedMinor > 0 ? input.savedMinor : 0;
  const remainingMinor = Math.max(0, targetMinor - savedMinor);

  // Checked BEFORE the trip date is looked at (see the union's own
  // ordering comment above) - an already-met goal stays met regardless
  // of whether the trip has a date, starts today, or already happened.
  if (remainingMinor <= 0) {
    return { status: "GOAL_REACHED", savedMinor, targetMinor };
  }

  const horizon = computeTripHorizon(input.tripStartDate, input.now);
  if (!horizon) return { status: "MISSING_DATE" };

  if (horizon.hasStarted) {
    return { status: "TRIP_STARTED", startsToday: horizon.startsToday };
  }

  // membersCount must never divide by zero - at least 1, matching Trip
  // Detail's existing `Math.max(1, trip?.memberIds?.length ?? 1)`.
  const safeMembersCount = Math.max(1, Math.floor(input.membersCount) || 1);

  const { daysUntilStart } = horizon;
  const fullWeeksUntilStart = Math.floor(daysUntilStart / 7);
  const extraDays = daysUntilStart % 7;

  const pace: "weekly" | "daily" =
    daysUntilStart < DAILY_PACE_THRESHOLD_DAYS ? "daily" : "weekly";
  // The weekly-equivalent (or daily) rate is derived from EXACT days,
  // never from the floored `weeksUntilStart` - dividing remaining by a
  // floored week count would overstate the pace whenever the horizon
  // has a partial week (e.g. 109 days is 15.57 weeks; dividing by the
  // floored 15 would ask for more per week than actually needed to
  // reach the goal by the real start date). periodDays is 7 for a
  // weekly rate or 1 for a daily rate - both are just
  // `remaining * periodDays / daysUntilStart`, rounded up so the
  // recommended pace never leaves the goal a few cents short.
  const periodDays = pace === "weekly" ? 7 : 1;
  const rateTotalMinor = Math.ceil((remainingMinor * periodDays) / daysUntilStart);
  const ratePerPersonMinor = Math.ceil(
    (remainingMinor * periodDays) / (daysUntilStart * safeMembersCount)
  );

  return {
    status: "ACTIVE",
    daysUntilStart,
    fullWeeksUntilStart,
    extraDays,
    remainingMinor,
    pace,
    rateTotalMinor,
    ratePerPersonMinor,
  };
}

function pluralize(n: number, singular: string): string {
  return `${n} ${singular}${n === 1 ? "" : "s"}`;
}

// Natural-language horizon text for an ACTIVE guidance result - never
// renders an awkward "0 weeks, 3 days" (a whole-week horizon omits the
// "0 days" remainder entirely; a sub-week horizon omits "0 weeks" and
// shows only the day count).
//
//   16 weeks, 0 extra days  -> "16 weeks until your trip"
//   15 weeks, 4 extra days  -> "15 weeks, 4 days until your trip"
//   0 weeks, 1 extra day    -> "1 day until your trip"
export function formatTripHorizonText(fullWeeksUntilStart: number, extraDays: number): string {
  const parts: string[] = [];
  if (fullWeeksUntilStart > 0) parts.push(pluralize(fullWeeksUntilStart, "week"));
  if (extraDays > 0 || fullWeeksUntilStart === 0) parts.push(pluralize(extraDays, "day"));
  return `${parts.join(", ")} until your trip`;
}
