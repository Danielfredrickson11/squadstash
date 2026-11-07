import {FieldValue, Timestamp, getFirestore} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";
import {tripInvitationId} from "../domain/tripCompositeId";
import {
  buildInvitationCancelledActivity,
} from "../domain/tripMembershipActivity";

type CallableAuth = CallableRequest["auth"];

interface CancelTripInvitationInput {
  invitationId: string;
}

interface CancelTripInvitationResult {
  invitationId: string;
  tripId: string;
}

// Mirrors acceptTripInvitation.ts's/declineTripInvitation.ts's own
// identical pattern - generous enough for the composite invitationId,
// while still rejecting path-like/malformed ids.
const SAFE_INVITATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,300}$/;

const ALLOWED_INPUT_KEYS: ReadonlySet<string> = new Set(["invitationId"]);

const RECOGNIZED_INVITATION_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "accepted",
  "declined",
  "cancelled",
]);

/**
 * cancelTripInvitation (Checkpoint 6.8B1, per the frozen 6.8A/6.8A2/
 * 6.8A3/6.8A4 architecture)
 * Input: { invitationId: string }
 * Output: { invitationId: string, tripId: string }
 *
 * Checkpoint 6.8A2 §3/6.8A3 §2 (compatibility window): this trusted
 * callable coexists with the still-open direct-client
 * `pending -> cancelled` Firestore Rules write during the rollout
 * compatibility window - closing that Rules clause is explicitly NOT
 * part of this checkpoint (6.8B1 scope boundary).
 *
 * Security:
 * - Requires caller to be signed in.
 * - Only the Trip's CURRENT owner (read fresh inside this transaction,
 *   never trusted from the invitation's own stale inviterUid) may
 *   cancel - mirrors createTripInvitationCore's/acceptTripInvitationCore's
 *   own "re-read and re-validate the Trip from scratch" discipline,
 *   since the client write path previously got this check for free from
 *   firestore.rules' live isTripOwnerById, which this callable no
 *   longer has once the direct-write Rules close (6.8A3 Phase F).
 * - Cancellation remains allowed regardless of expiry - preserving the
 *   existing direct-write Rules' own documented choice exactly.
 * - An exact replay (the invitation is already "cancelled") is a
 *   read-only historical confirmation - no new write is attempted.
 * - Any other non-pending status ("accepted"/"declined") fails closed
 *   with failed-precondition - this also resolves a race with a
 *   concurrent acceptTripInvitation/declineTripInvitation call via
 *   ordinary Firestore transaction serialization on the same
 *   invitationRef.
 * - Successful cancellation atomically: flips the invitation to
 *   "cancelled"; and creates the immutable, deterministic
 *   `invitation_cancelled:{tripId}_{inviteeUid}` tripMembershipActivity
 *   event, in the SAME transaction.
 */
export const cancelTripInvitation = onCall(async (request) => {
  const authUid = requireAuthenticatedUid(request.auth);

  return cancelTripInvitationCore(getFirestore(), authUid, request.data);
});

/**
 * Requires an authenticated caller, matching the guard every callable in
 * this project duplicates locally.
 * @param {CallableAuth} auth The callable request's auth data.
 * @return {string} The authenticated caller's uid.
 */
export function requireAuthenticatedUid(auth: CallableAuth): string {
  if (!auth) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }
  return auth.uid;
}

/**
 * Testable trusted core - receives an already-resolved Firestore instance
 * and the authenticated caller's uid, matching every other callable's own
 * Core-function convention in this project.
 * @param {Firestore} db Admin SDK Firestore instance (emulator or prod).
 * @param {string} authUid The authenticated caller's uid.
 * @param {unknown} rawInput The callable request body, validated inside.
 * @return {Promise<CancelTripInvitationResult>} The cancelled (or
 *   idempotently replayed) invitation's identity.
 */
export async function cancelTripInvitationCore(
  db: Firestore,
  authUid: string,
  rawInput: unknown
): Promise<CancelTripInvitationResult> {
  const input = validateInput(rawInput);
  const invitationRef = db
    .collection("tripInvitations")
    .doc(input.invitationId);

  return db.runTransaction(async (tx) => {
    const invitationSnap = await tx.get(invitationRef);
    if (!invitationSnap.exists) {
      throw new HttpsError(
        "not-found",
        "No invitation found for the given invitationId."
      );
    }
    const invitation = invitationSnap.data() as FirebaseFirestore.DocumentData;

    assertNonEmptyString(invitation.inviterUid, "invitation.inviterUid");
    assertNonEmptyString(invitation.inviteeUid, "invitation.inviteeUid");
    assertNonEmptyString(invitation.tripId, "invitation.tripId");
    assertValidTimestamp(invitation.createdAt, "invitation.createdAt");
    assertValidTimestamp(invitation.expiresAt, "invitation.expiresAt");
    if (!RECOGNIZED_INVITATION_STATUSES.has(invitation.status)) {
      throw new HttpsError(
        "failed-precondition",
        `Unrecognized invitation status "${String(invitation.status)}".`
      );
    }
    if (invitation.status === "pending") {
      if (invitation.respondedAt !== null) {
        throw new HttpsError(
          "failed-precondition",
          "Pending invitation unexpectedly has a non-null respondedAt."
        );
      }
    } else {
      assertValidTimestamp(invitation.respondedAt, "invitation.respondedAt");
    }

    const expectedInvitationId = tripInvitationId(
      invitation.tripId,
      invitation.inviteeUid
    );
    if (input.invitationId !== expectedInvitationId) {
      throw new HttpsError(
        "failed-precondition",
        "Invitation document id is not canonical for its own tripId/" +
          "inviteeUid."
      );
    }

    const tripId = invitation.tripId as string;
    const tripRef = db.collection("trips").doc(tripId);
    const tripSnap = await tx.get(tripRef);
    if (!tripSnap.exists) {
      throw new HttpsError("not-found", "No Trip found for this invitation.");
    }
    const trip = tripSnap.data() as FirebaseFirestore.DocumentData;
    assertNonEmptyString(trip.ownerId, "Trip.ownerId");

    if (authUid !== trip.ownerId) {
      throw new HttpsError(
        "permission-denied",
        "Only the Trip owner may cancel this invitation."
      );
    }

    // Replay: already cancelled by this Trip's current owner - a
    // read-only historical confirmation. No write is attempted.
    if (invitation.status === "cancelled") {
      return {invitationId: input.invitationId, tripId};
    }

    if (invitation.status !== "pending") {
      // "accepted" or "declined" - neither is cancellable.
      throw new HttpsError(
        "failed-precondition",
        `Invitation status "${invitation.status}" cannot be cancelled.`
      );
    }

    // -------- Atomic writes --------
    tx.update(invitationRef, {
      status: "cancelled",
      respondedAt: FieldValue.serverTimestamp(),
    });

    const activity = buildInvitationCancelledActivity(
      tripId,
      authUid,
      invitation.inviteeUid as string
    );
    tx.create(
      db.collection("tripMembershipActivity").doc(activity.id),
      {...activity.data, createdAt: FieldValue.serverTimestamp()}
    );

    return {invitationId: input.invitationId, tripId};
  });
}

/**
 * Fails closed unless `value` is a non-empty string.
 * @param {unknown} value The candidate value.
 * @param {string} label A short name for the value, for the error.
 * @return {void}
 */
function assertNonEmptyString(value: unknown, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpsError(
      "failed-precondition",
      `${label} must be a non-empty string.`
    );
  }
}

/**
 * Fails closed unless `value` is a real Firestore Timestamp instance.
 * @param {unknown} value The candidate value.
 * @param {string} label A short name for the value, for the error.
 * @return {void}
 */
function assertValidTimestamp(value: unknown, label: string): void {
  if (!(value instanceof Timestamp)) {
    throw new HttpsError(
      "failed-precondition",
      `${label} must be a valid Firestore Timestamp.`
    );
  }
}

/**
 * Validates and narrows a raw callable request body against the exact
 * one-key allowlist - any other key present fails the whole request
 * closed with invalid-argument.
 * @param {unknown} raw The unvalidated callable request body.
 * @return {CancelTripInvitationInput} The validated, narrowed input.
 */
function validateInput(raw: unknown): CancelTripInvitationInput {
  if (typeof raw !== "object" || raw === null) {
    throw new HttpsError("invalid-argument", "Request body is required.");
  }
  const data = raw as Record<string, unknown>;

  for (const key of Object.keys(data)) {
    if (!ALLOWED_INPUT_KEYS.has(key)) {
      throw new HttpsError(
        "invalid-argument",
        `Unexpected field "${key}" is not allowed.`
      );
    }
  }

  if (
    typeof data.invitationId !== "string" ||
    !SAFE_INVITATION_ID_PATTERN.test(data.invitationId)
  ) {
    throw new HttpsError(
      "invalid-argument",
      "invitationId must be a non-empty, safely-shaped document id."
    );
  }

  return {invitationId: data.invitationId};
}
