import {Timestamp, getFirestore} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";
import {tripInvitationId} from "../domain/tripCompositeId";

type CallableAuth = CallableRequest["auth"];

interface GetTripInvitationPreviewInput {
  invitationId: string;
}

interface GetTripInvitationPreviewResult {
  tripId: string;
  title: string;
  location: string | null;
  imageUrl: string;
  tripStartDate: string | null;
  tripEndDate: string | null;
}

// Mirrors acceptTripInvitation.ts's own SAFE_INVITATION_ID_PATTERN
// exactly (not imported - that file deliberately keeps this as a
// private constant, and this is a separate trusted boundary that should
// not depend on acceptTripInvitation.ts's internals merely to share one
// regex). Generous enough to hold the composite invitationId
// (tripId + "_" + a Firebase Auth uid, which can be up to 128 characters
// per the Auth API contract) while still rejecting path-like/malformed
// ids. Underscore is deliberately ALLOWED - invitationId is itself
// composite (tripId + "_" + uid).
const SAFE_INVITATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,300}$/;

const ALLOWED_INPUT_KEYS: ReadonlySet<string> = new Set(["invitationId"]);

const RECOGNIZED_INVITATION_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "accepted",
  "declined",
  "cancelled",
]);

/**
 * getTripInvitationPreview (Checkpoint 5C.3B, per the frozen docs/audits/
 * TRIP_INVITATION_CLIENT_UX_PREFLIGHT_2026-10-18.md)
 * Input: { invitationId: string }
 * Output: { tripId, title, location, imageUrl, tripStartDate, tripEndDate }
 *
 * Security:
 * - Requires caller to be signed in.
 * - Only the invitation's own named invitee may preview it - never the
 *   Trip owner, never any other current member, never an outsider.
 * - Pre-join preview ONLY: the invitation must be currently "pending"
 *   and unexpired (server time, never a client-supplied clock) - an
 *   accepted/declined/cancelled/expired invitation cannot use this
 *   endpoint.
 * - An archived Trip is rejected outright - no metadata is exposed for
 *   a Trip that no longer accepts new members.
 * - Returns EXACTLY six fields, built field-by-field - never a spread
 *   of Trip data. No financial field (saved/target/ledgerBalanceMinor/
 *   ledgerOpeningBalanceMinor/currency/ownershipModelState/Version/
 *   creationRequest/memberIds/ownerId/lastUpdatedBy) is ever read for
 *   the purpose of returning it, and none appears in the response.
 * - Pure read: no writes, no transaction. This preview is informational
 *   only and is never treated as an authorization reservation -
 *   acceptTripInvitation independently re-derives and re-validates
 *   every one of these facts fresh at acceptance time (preflight §12).
 */
export const getTripInvitationPreview = onCall(async (request) => {
  const authUid = requireAuthenticatedUid(request.auth);

  return getTripInvitationPreviewCore(getFirestore(), authUid, request.data);
});

/**
 * Requires an authenticated caller, matching the guard every callable in
 * this project uses. A local copy of acceptTripInvitation.ts's own
 * helper of the identical name/behavior - deliberately not imported
 * from that file, which should not be altered merely to share this
 * one-line guard (per this checkpoint's own scope instruction).
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
 * Testable trusted core. Pure read - no transaction, no writes, no
 * mutation of any kind. Mirrors acceptTripInvitationCore's own Core-
 * function convention (an already-resolved Firestore instance plus the
 * authenticated uid, never pulled from the onCall request context
 * directly) and reuses several of its Step-0-style corruption checks,
 * since this preview reads the exact same tripInvitations/trips shape -
 * but this function never writes anything and never opens a
 * transaction, since a pure read needs neither.
 * @param {Firestore} db Admin SDK Firestore instance (emulator or prod).
 * @param {string} authUid The authenticated caller's uid.
 * @param {unknown} rawInput The callable request body, validated inside.
 * @return {Promise<GetTripInvitationPreviewResult>} The safe preview.
 */
export async function getTripInvitationPreviewCore(
  db: Firestore,
  authUid: string,
  rawInput: unknown
): Promise<GetTripInvitationPreviewResult> {
  const input = validateInput(rawInput);

  // ---------------------------------------------------------------
  // Invitation read + fail-closed shape validation.
  // ---------------------------------------------------------------
  const invitationRef = db
    .collection("tripInvitations")
    .doc(input.invitationId);
  const invitationSnap = await invitationRef.get();
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
  if (typeof invitation.inviteeEmail !== "string") {
    throw new HttpsError(
      "failed-precondition",
      "invitation.inviteeEmail must be a string."
    );
  }
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

  // ---------------------------------------------------------------
  // Caller / canonical-id authorization.
  // ---------------------------------------------------------------
  if (authUid !== invitation.inviteeUid) {
    throw new HttpsError(
      "permission-denied",
      "Only the invited member may preview this invitation."
    );
  }

  // Do not trust that merely finding a document at the requested id
  // proves its identity - verify its persisted tripId/inviteeUid
  // actually produce this exact deterministic id (mirrors
  // acceptTripInvitationCore's own identical check).
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

  // ---------------------------------------------------------------
  // Trip read + owner consistency.
  // ---------------------------------------------------------------
  const tripRef = db.collection("trips").doc(invitation.tripId as string);
  const tripSnap = await tripRef.get();
  if (!tripSnap.exists) {
    throw new HttpsError("not-found", "No Trip found for this invitation.");
  }
  const trip = tripSnap.data() as FirebaseFirestore.DocumentData;

  assertNonEmptyString(trip.ownerId, "Trip.ownerId");
  if (invitation.inviterUid !== trip.ownerId) {
    throw new HttpsError(
      "failed-precondition",
      "This invitation's inviter is no longer this Trip's current " +
        "authoritative owner."
    );
  }
  if (authUid === trip.ownerId) {
    throw new HttpsError(
      "failed-precondition",
      "The Trip owner already has full Trip access and is not a " +
        "legitimate pre-join invitee."
    );
  }

  // ---------------------------------------------------------------
  // Preview eligibility - pre-join only, pending + unexpired.
  // ---------------------------------------------------------------
  if (invitation.status !== "pending") {
    throw new HttpsError(
      "failed-precondition",
      `Invitation status "${invitation.status}" is no longer previewable.`
    );
  }
  const now = Timestamp.now();
  const expiresAt = invitation.expiresAt as Timestamp;
  if (expiresAt.toMillis() <= now.toMillis()) {
    throw new HttpsError("failed-precondition", "This invitation has expired.");
  }

  // ---------------------------------------------------------------
  // Archived Trip.
  // ---------------------------------------------------------------
  if (isTripArchived(trip)) {
    throw new HttpsError(
      "failed-precondition",
      "This trip is archived and no longer accepts new members."
    );
  }

  // ---------------------------------------------------------------
  // Safe Trip metadata - exactly six fields, built field-by-field.
  // Never a spread of Trip data; no financial field is ever read.
  // ---------------------------------------------------------------
  return {
    tripId: invitation.tripId as string,
    title: assertSafeStringField(trip.title, "Trip.title"),
    imageUrl: assertSafeStringField(trip.imageUrl, "Trip.imageUrl"),
    location: assertSafeNullableStringField(trip.location, "Trip.location"),
    tripStartDate: assertSafeNullableStringField(
      trip.tripStartDate,
      "Trip.tripStartDate"
    ),
    tripEndDate: assertSafeNullableStringField(
      trip.tripEndDate,
      "Trip.tripEndDate"
    ),
  };
}

/**
 * Trusted-backend mirror of firestore.rules' own missing-safe
 * tripIsActive() check - deliberately duplicated the same way every
 * other callable that needs this already duplicates it (including
 * acceptTripInvitation.ts's own identical helper).
 * @param {FirebaseFirestore.DocumentData} tripData The Trip document data.
 * @return {boolean} True if the Trip is archived.
 */
function isTripArchived(tripData: FirebaseFirestore.DocumentData): boolean {
  return tripData.archivedAt !== undefined && tripData.archivedAt !== null;
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
 * Required-string response field (title/imageUrl): must be a string, or
 * this fails closed - per the frozen preflight §10, this endpoint never
 * invents a value for a required display field.
 * @param {unknown} value The candidate Trip field value.
 * @param {string} label A short name for the value, for the error.
 * @return {string} The validated string.
 */
function assertSafeStringField(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new HttpsError(
      "failed-precondition",
      `${label} must be a string.`
    );
  }
  return value;
}

/**
 * Nullable-string response field (location/tripStartDate/tripEndDate):
 * a string returns as-is; an absent (undefined) or explicit null value
 * normalizes to null (a legacy Trip predating these fields reads the
 * same as one that explicitly cleared them); any other type fails
 * closed. This endpoint deliberately does NOT re-validate calendar-date
 * format - these are display metadata only, and the authoritative
 * create/update paths already own that validation (frozen preflight
 * §10's explicit instruction not to make this a second canonical-date
 * validator).
 * @param {unknown} value The candidate Trip field value.
 * @param {string} label A short name for the value, for the error.
 * @return {string | null} The validated string, or null.
 */
function assertSafeNullableStringField(
  value: unknown,
  label: string
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  throw new HttpsError(
    "failed-precondition",
    `${label} must be a string or null.`
  );
}

/**
 * Validates and narrows a raw callable request body against the exact
 * one-key allowlist - any other key present fails the whole request
 * closed with invalid-argument, before any Firestore read.
 * @param {unknown} raw The unvalidated callable request body.
 * @return {GetTripInvitationPreviewInput} The validated, narrowed input.
 */
function validateInput(raw: unknown): GetTripInvitationPreviewInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
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
