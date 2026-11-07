// Checkpoint 6.8D (per the frozen 6.8A4 "Phase G" cutover contract): an
// admin-only, offline tool that writes the ONE-TIME
// `history_tracking_started:{tripId}` boundary marker for a single
// PRE-CUTOVER Trip - a Trip that was created by the OLD (pre-6.8B1)
// createTrip, before that Function started atomically writing a genuine
// `trip_created` activity event. The marker's meaning is exactly:
// "Complete membership activity is tracked from this point forward" -
// never "history starts here" (6.8A4's own corrected semantics; a
// pre-cutover Trip may already have real, genuine activity events from
// rollout Phases D/E/F sitting BEFORE this marker, and that is expected,
// not anomalous).
//
// A local, Admin-SDK-only Node.js script - NEVER exported from
// functions/src/index.ts, NEVER wrapped in onCall/HTTP, NEVER reachable
// from app/client code, mirroring migrateTripOwnership.ts/
// reconcileTripOwnership.ts/migrateTripExpenseBalances.ts's identical
// posture exactly. Single-Trip only - this tool never discovers or
// mutates Trips on its own; the explicit target list for a real rollout
// comes from a SEPARATE, independent, read-only inventory step (6.8A4
// Phase C), never from this tool. Dry-run is the default/safest mode.
//
// ELIGIBILITY (6.8A4 Phase G, corrected): a Trip is eligible for this
// marker if and only if it has NO existing `trip_created:{tripId}`
// activity event (proof it is pre-cutover) and NO existing
// `history_tracking_started:{tripId}` marker (idempotency). The
// presence of any OTHER genuine activity event
// (invitation_created/accepted/declined/cancelled, member_left/removed)
// is NEVER a blocker - a legitimate pre-cutover Trip is expected to
// accumulate exactly this activity during rollout Phases D-F, before
// this tool ever runs. This tool never attempts to manufacture a
// trip_created, invitation, acceptance, or departure event from
// historical state - the ONLY event it is ever capable of writing is
// `history_tracking_started`.
import {FieldValue, getFirestore} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";
import {initializeApp} from "firebase-admin/app";

import {
  buildHistoryTrackingStartedActivity,
  historyTrackingStartedActivityId,
  isWellFormedTripMembershipActivityDocumentData,
  tripCreatedActivityId,
} from "../domain/tripMembershipActivity";

export type BackfillTripMembershipActivityStatus =
  // dry_run only: every eligibility check passed; apply would write.
  | "would_initialize"
  // apply only: the marker was newly written this run.
  | "initialized"
  // the marker already exists and is well-formed - idempotent replay,
  // no write attempted (dry_run or apply alike).
  | "already_completed"
  // a genuine `trip_created:{tripId}` activity event already exists -
  // this Trip was created under the new activity-aware createTrip and
  // is NOT pre-cutover. No backfill is ever appropriate.
  | "not_eligible_post_cutover"
  // the Trip document itself, or an existing marker document at the
  // deterministic id, is malformed - fails closed, never repaired or
  // overwritten.
  | "blocked_malformed"
  // no Trip document exists for the requested tripId.
  | "missing_trip";

export type BackfillTripMembershipActivityResult = {
  tripId: string;
  mode: "dry_run" | "apply";
  status: BackfillTripMembershipActivityStatus;
  // Never exposes anything beyond the Trip's own title - no member
  // uids, no email, no financial state.
  tripTitle: string | null;
  tripCreatedActivityExists: boolean;
  existingMarkerExists: boolean;
  wouldWrite: boolean;
  anomalies: string[];
  startedAt: string;
  completedAt: string | null;
};

/**
 * Safely reads a Trip's own `title` field for an operator-facing report -
 * never trusts an unexpected type, never throws.
 * @param {Record<string, unknown>} tripData The Trip document data.
 * @return {string | null} The title, or null if absent/malformed.
 */
function safeTripTitle(tripData: Record<string, unknown>): string | null {
  return typeof tripData.title === "string" ? tripData.title : null;
}

/**
 * Minimal structural validation of the Trip document - this tool never
 * mutates membership and needs no canonical memberIds validation; it
 * only needs enough confidence the document is a real, sane Trip
 * before reporting on or writing alongside it. Mirrors every other
 * admin tool's own "validate before trusting" discipline.
 * @param {Record<string, unknown>} tripData The Trip document data.
 * @return {string | null} A specific malformation reason, or null if
 *   the Trip passes this minimal check.
 */
function findTripMalformation(
  tripData: Record<string, unknown>
): string | null {
  if (typeof tripData.ownerId !== "string" || tripData.ownerId.length === 0) {
    return "Trip.ownerId is missing or not a non-empty string.";
  }
  if (tripData.memberIds !== undefined) {
    if (!Array.isArray(tripData.memberIds)) {
      return "Trip.memberIds is present but not an array.";
    }
    // 6.8D1 §2: modestly strengthened - every entry must be a
    // non-empty string. Deliberately NOT a canonical-membership check
    // (no owner-presence/no-duplicate requirement, unlike
    // validateCanonicalMemberIds elsewhere in this codebase) - this
    // tool never mutates membership and must not require historical
    // facts a legacy Trip may not have; it only needs enough
    // confidence the field is structurally sane before writing an
    // audit boundary alongside it.
    for (const entry of tripData.memberIds) {
      if (typeof entry !== "string" || entry.length === 0) {
        return "Trip.memberIds contains a non-string or empty-string entry.";
      }
    }
  }
  return null;
}

/**
 * Runs the backfill for exactly one Trip, in the requested mode. Never
 * discovers or mutates any other Trip.
 * @param {Firestore} db Admin SDK Firestore instance (emulator or
 *   prod).
 * @param {string} tripId The single Trip to evaluate/backfill.
 * @param {"dry_run" | "apply"} mode `"dry_run"` (default/safe) never
 *   writes; `"apply"` writes only when eligible.
 * @return {Promise<BackfillTripMembershipActivityResult>} The result.
 */
export async function runTripMembershipActivityBackfill(
  db: Firestore,
  tripId: string,
  mode: "dry_run" | "apply"
): Promise<BackfillTripMembershipActivityResult> {
  const startedAt = new Date().toISOString();
  const done = (
    partial: Omit<
      BackfillTripMembershipActivityResult,
      "tripId" | "mode" | "startedAt" | "completedAt"
    >
  ): BackfillTripMembershipActivityResult => ({
    tripId,
    mode,
    startedAt,
    completedAt: new Date().toISOString(),
    ...partial,
  });

  const tripRef = db.collection("trips").doc(tripId);
  const tripSnap = await tripRef.get();
  if (!tripSnap.exists) {
    return done({
      status: "missing_trip",
      tripTitle: null,
      tripCreatedActivityExists: false,
      existingMarkerExists: false,
      wouldWrite: false,
      anomalies: [`No trip found for tripId "${tripId}".`],
    });
  }
  const tripData = tripSnap.data() as Record<string, unknown>;
  const tripTitle = safeTripTitle(tripData);

  const tripMalformation = findTripMalformation(tripData);
  if (tripMalformation !== null) {
    return done({
      status: "blocked_malformed",
      tripTitle,
      tripCreatedActivityExists: false,
      existingMarkerExists: false,
      wouldWrite: false,
      anomalies: [tripMalformation],
    });
  }

  const tripCreatedRef = db
    .collection("tripMembershipActivity")
    .doc(tripCreatedActivityId(tripId));
  const tripCreatedSnap = await tripCreatedRef.get();
  if (tripCreatedSnap.exists) {
    return done({
      status: "not_eligible_post_cutover",
      tripTitle,
      tripCreatedActivityExists: true,
      existingMarkerExists: false,
      wouldWrite: false,
      anomalies: [
        "This Trip already has a genuine trip_created activity event " +
          "- it was created under the new activity-aware createTrip " +
          "and is not a pre-cutover Trip. No backfill is appropriate.",
      ],
    });
  }

  const markerId = historyTrackingStartedActivityId(tripId);
  const markerRef = db.collection("tripMembershipActivity").doc(markerId);
  const markerSnap = await markerRef.get();
  if (markerSnap.exists) {
    const markerData = markerSnap.data();
    const wellFormed =
      isWellFormedTripMembershipActivityDocumentData(markerData) &&
      markerData.type === "history_tracking_started";
    if (!wellFormed) {
      return done({
        status: "blocked_malformed",
        tripTitle,
        tripCreatedActivityExists: false,
        existingMarkerExists: true,
        wouldWrite: false,
        anomalies: [
          "An existing history_tracking_started marker document at " +
            `"${markerId}" is malformed - refusing to overwrite it.`,
        ],
      });
    }
    return done({
      status: "already_completed",
      tripTitle,
      tripCreatedActivityExists: false,
      existingMarkerExists: true,
      wouldWrite: false,
      anomalies: [],
    });
  }

  // Eligible: pre-cutover Trip, no existing marker.
  if (mode === "dry_run") {
    return done({
      status: "would_initialize",
      tripTitle,
      tripCreatedActivityExists: false,
      existingMarkerExists: false,
      wouldWrite: true,
      anomalies: [],
    });
  }

  // apply: re-derive COMPLETE eligibility FRESH inside a single
  // transaction - including the Trip document itself (6.8D1 §1: the
  // preflight reads above are NEVER trusted for write safety; between
  // that preflight and this transaction, the Trip could in principle
  // have been deleted or become malformed, and this transaction must
  // independently refuse to write in either case) - and use tx.create
  // (never tx.set) for the marker itself. This is the entire
  // concurrency-safety mechanism (6.8D §5/§7): two simultaneous
  // `--apply` invocations for the same Trip each re-read everything
  // fresh inside their own transaction; Firestore's transaction
  // conflict/retry semantics (never a separate lock document) ensure
  // whichever commits second sees the first's already-written marker
  // on retry and reports "already_completed" rather than attempting a
  // conflicting second create.
  const applyResult = await db.runTransaction(async (tx) => {
    const freshTripSnap = await tx.get(tripRef);
    if (!freshTripSnap.exists) {
      return {
        status: "missing_trip" as const,
        tripCreatedActivityExists: false,
        existingMarkerExists: false,
        wouldWrite: false,
        anomalies: [`No trip found for tripId "${tripId}".`],
      };
    }
    const freshTripData = freshTripSnap.data() as Record<string, unknown>;
    const freshTripMalformation = findTripMalformation(freshTripData);
    if (freshTripMalformation !== null) {
      return {
        status: "blocked_malformed" as const,
        tripCreatedActivityExists: false,
        existingMarkerExists: false,
        wouldWrite: false,
        anomalies: [freshTripMalformation],
      };
    }

    const freshTripCreatedSnap = await tx.get(tripCreatedRef);
    if (freshTripCreatedSnap.exists) {
      return {
        status: "not_eligible_post_cutover" as const,
        tripCreatedActivityExists: true,
        existingMarkerExists: false,
        wouldWrite: false,
        anomalies: [
          "This Trip already has a genuine trip_created activity " +
            "event - no backfill is appropriate.",
        ],
      };
    }
    const freshMarkerSnap = await tx.get(markerRef);
    if (freshMarkerSnap.exists) {
      const markerData = freshMarkerSnap.data();
      const wellFormed =
        isWellFormedTripMembershipActivityDocumentData(markerData) &&
        markerData.type === "history_tracking_started";
      if (!wellFormed) {
        return {
          status: "blocked_malformed" as const,
          tripCreatedActivityExists: false,
          existingMarkerExists: true,
          wouldWrite: false,
          anomalies: [
            "An existing history_tracking_started marker document at " +
              `"${markerId}" is malformed - refusing to overwrite it.`,
          ],
        };
      }
      return {
        status: "already_completed" as const,
        tripCreatedActivityExists: false,
        existingMarkerExists: true,
        wouldWrite: false,
        anomalies: [],
      };
    }

    // Uses the existing 6.8 domain builder (never a hand-rolled second
    // formula for this marker's shape/id) - the actual Phase G
    // timestamp is the ONLY timestamp this tool ever writes; there is
    // no CLI argument that can override it.
    const activity = buildHistoryTrackingStartedActivity(tripId);
    tx.create(
      markerRef,
      {...activity.data, createdAt: FieldValue.serverTimestamp()}
    );
    return {
      status: "initialized" as const,
      tripCreatedActivityExists: false,
      existingMarkerExists: false,
      wouldWrite: true,
      anomalies: [],
    };
  });

  return done({tripTitle, ...applyResult});
}

// ---------------------------------------------------------------------
// CLI wrapper - mirrors migrateTripExpenseBalances.ts's own
// resolveExecutionTarget/parseArgs/main shape exactly.
// ---------------------------------------------------------------------

export const PRODUCTION_PROJECT_ID = "squadstash-6d0f1";

export type ExecutionTarget =
  | {ok: true; mode: "emulator"; projectId: string}
  | {ok: true; mode: "production"; projectId: string}
  | {ok: false; reason: string};

/**
 * Resolves the safe execution target from the process environment and
 * parsed CLI flags - the emulator is always safe and requires no extra
 * confirmation; production requires an exact `--project` match AND
 * (for apply mode) an exact `--confirm <tripId>` echo-back. Pure w.r.t.
 * its explicit `input` argument (never reads `process.env` itself) so
 * tests can exercise every branch without touching a real environment.
 * @param {object} input The environment/flags this decision depends on.
 * @return {ExecutionTarget} The resolved target, or the specific reason
 *   this invocation is unsafe to run.
 */
export function resolveExecutionTarget(input: {
  emulatorHost: string | undefined;
  tripId: string;
  mode: "dry_run" | "apply";
  projectFlag: string | undefined;
  confirmFlag: string | undefined;
}): ExecutionTarget {
  if (input.emulatorHost) {
    return {
      ok: true,
      mode: "emulator",
      projectId: input.projectFlag ?? "demo-backfill-trip-membership-activity",
    };
  }
  if (input.projectFlag !== PRODUCTION_PROJECT_ID) {
    return {
      ok: false,
      reason: "No FIRESTORE_EMULATOR_HOST is set, and --project does not " +
        "exactly match the configured production project id " +
        `("${PRODUCTION_PROJECT_ID}"). Refusing to run.`,
    };
  }
  if (input.mode === "apply" && input.confirmFlag !== input.tripId) {
    return {
      ok: false,
      reason: "Production apply requires --confirm <tripId> to exactly " +
        "echo back the --trip value. Refusing to run.",
    };
  }
  return {ok: true, mode: "production", projectId: input.projectFlag};
}

/**
 * Minimal CLI argument parser for this tool's own flags.
 * @param {string[]} argv The raw CLI arguments (excluding node/script).
 * @return {object} The parsed flags.
 */
function parseArgs(argv: string[]): {
  tripId: string | undefined;
  mode: "dry_run" | "apply";
  projectFlag: string | undefined;
  confirmFlag: string | undefined;
} {
  let tripId: string | undefined;
  let mode: "dry_run" | "apply" = "dry_run";
  let projectFlag: string | undefined;
  let confirmFlag: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--trip") {
      tripId = argv[++i];
    } else if (arg === "--apply") {
      mode = "apply";
    } else if (arg === "--dry-run") {
      mode = "dry_run";
    } else if (arg === "--project") {
      projectFlag = argv[++i];
    } else if (arg === "--confirm") {
      confirmFlag = argv[++i];
    }
  }
  return {tripId, mode, projectFlag, confirmFlag};
}

/**
 * CLI entry point. Never invoked by any test - tests exercise
 * `resolveExecutionTarget` and `runTripMembershipActivityBackfill`
 * directly against an emulator-backed Firestore instance they
 * construct themselves. Never invoked against production during this
 * checkpoint.
 * @return {Promise<void>} Resolves once the requested run completes.
 */
async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.tripId) {
    throw new Error(
      "Usage: --trip <tripId> [--dry-run|--apply] [--project <id>] " +
        "[--confirm <tripId>]"
    );
  }
  const target = resolveExecutionTarget({
    emulatorHost: process.env.FIRESTORE_EMULATOR_HOST,
    tripId: parsed.tripId,
    mode: parsed.mode,
    projectFlag: parsed.projectFlag,
    confirmFlag: parsed.confirmFlag,
  });
  if (!target.ok) {
    throw new Error(target.reason);
  }

  initializeApp({projectId: target.projectId});
  const db = getFirestore();

  const result = await runTripMembershipActivityBackfill(
    db,
    parsed.tripId,
    parsed.mode
  );

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  });
}
