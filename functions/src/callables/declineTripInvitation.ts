import {FieldValue, Timestamp, getFirestore} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";
import {tripInvitationId} from "../domain/tripCompositeId";
import {
  buildInvitationDeclinedActivity,
} from "../domain/tripMembershipActivity";

type CallableAuth = CallableRequest["auth"];

interface DeclineTripInvitationInput {
  invitationId: string;
}

interface DeclineTripInvitationResult {
  invitationId: string;
  tripId: string;
}

// Mirrors acceptTripInvitation.ts's own identical pattern/comment -
// generous enough for the composite invitationId (tripId + "_" + a
// Firebase Auth uid, up to 128 characters), while still rejecting
// path-like/malformed ids.
const SAFE_INVITATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,300}$/;

const ALLOWED_INPUT_KEYS: ReadonlySet<string> = new Set(["invitationId"]);

const RECOGNIZED_INVITATION_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "accepted",
  "declined",
  "cancelled",
]);

/**
 * declineTripInvitation (Checkpoint 6.8B1, per the frozen 6.8A/6.8A2/
 * 6.8A3/6.8A4 architecture)
 * Input: { invitationId: string }
 * Output: { invitationId: string, tripId: string }
 *
 * Checkpoint 6.8A2 §3/6.8A3 §2 (compatibility window): this trusted
 * callable coexists with the still-open direct-client
 * `pending -> declined` Firestore Rules write during the rollout
 * compatibility window - closing that Rules clause is explicitly NOT
 * part of this checkpoint (6.8B1 scope boundary). Both paths can never
 * produce a duplicate or conflicting tripMembershipActivity document: a
 * direct Rules write never touches that collection at all, so
 * coexistence can only ever produce an absence of an activity row for a
 * legacy-path decline, never a duplicate (6.8A3 §2).
 *
 * Security:
 * - Requires caller to be signed in.
 * - Only the invitation's own named invitee may decline it.
 * - Decline remains allowed regardless of expiry - preserving the
 *   existing direct-write Rules' own documented choice exactly (an
 *   already-expired pending invitation may still be declined; it only
 *   ever narrows what the invitee is recorded as having wanted).
 * - An exact replay (the invitation is already "declined") is a
 *   read-only historical confirmation - no new write is attempted,
 *   including no second activity tx.create.
 * - Any other non-pending status ("accepted"/"cancelled") fails closed
 *   with failed-precondition - this also resolves a race with a
 *   concurrent acceptTripInvitation/cancelTripInvitation call via
 *   ordinary Firestore transaction serialization on the same
 *   invitationRef, never a separate lock.
 * - Successful decline atomically: flips the invitation to "declined";
 *   and creates the immutable, deterministic
 *   `invitation_declined:{tripId}_{inviteeUid}` tripMembershipActivity
 *   event, in the SAME transaction.
 */
export const declineTripInvitation = onCall(async (request) => {
  const authUid = requireAuthenticatedUid(request.auth);

  return declineTripInvitationCore(getFirestore(), authUid, request.data);
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
 * @return {Promise<DeclineTripInvitationResult>} The declined (or
 *   idempotently replayed) invitation's identity.
 */
export async function declineTripInvitationCore(
  db: Firestore,
  authUid: string,
  rawInput: unknown
): Promise<DeclineTripInvitationResult> {
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

    if (authUid !== invitation.inviteeUid) {
      throw new HttpsError(
        "permission-denied",
        "Only the invited member may decline this invitation."
      );
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

    // Replay: already declined by this exact invitee - a read-only
    // historical confirmation. No write is attempted, so the activity
    // tx.create below is never reached a second time.
    if (invitation.status === "declined") {
      return {invitationId: input.invitationId, tripId};
    }

    if (invitation.status !== "pending") {
      // "accepted" or "cancelled" - neither is declinable.
      throw new HttpsError(
        "failed-precondition",
        `Invitation status "${invitation.status}" cannot be declined.`
      );
    }

    // -------- Atomic writes --------
    tx.update(invitationRef, {
      status: "declined",
      respondedAt: FieldValue.serverTimestamp(),
    });

    const activity = buildInvitationDeclinedActivity(tripId, authUid);
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
 * @return {DeclineTripInvitationInput} The validated, narrowed input.
 */
function validateInput(raw: unknown): DeclineTripInvitationInput {
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
