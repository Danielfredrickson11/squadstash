import {HttpsError} from "firebase-functions/v2/https";

// Checkpoint 5B.1: extracted from createTripInvitation.ts (Checkpoint
// 5A.1, item 7, corrected by 5A.2, item 5) into this shared module so
// every Functions-side composite-id helper (tripInvitationId, and now
// tripMemberOwnershipId) uses the identical guard rather than each
// re-declaring its own copy - a safe, behavior-preserving extraction
// (createTripInvitation.ts's own tripInvitationId now imports this
// instead of defining it locally; its exact prior behavior, including
// the exact thrown HttpsError code/message, is unchanged).
//
// The underscore delimiter used by every composite Trip-scoped id in
// this project (tripInvitationId, tripMembershipAcceptanceId, and now
// tripMemberOwnershipId) is accepted ONLY because SquadStash's CURRENT
// generated-id/auth flow happens not to produce a component containing
// it - this is an observation about this application's existing flow,
// never a guarantee of the underlying Firebase APIs themselves:
//   - A Trip id, a terms document id, and an original Shared-Stash
//     withdrawal transaction id are all Firestore client-SDK/Admin-SDK
//     auto-generated document ids - Firestore's own auto-id generator is
//     documented to draw from a fixed 62-character alphanumeric alphabet
//     with no underscore, so THIS part is a genuine platform guarantee,
//     not an assumption.
//   - A uid, by contrast, is a Firebase Auth uid - and Firebase Auth's
//     own API contract does NOT promise a uid is underscore-free; it is
//     an opaque string of at most 128 characters, and a *custom* uid
//     (e.g. one a future flow assigns via the Admin SDK's
//     createUser({uid: ...}), or a different identity provider/import
//     path) could legally contain "_". This project's CURRENT
//     registration flow never calls createUser() with a caller-chosen
//     uid anywhere (confirmed by reading every functions/src/callables/
//     *.ts file) - every uid it produces today happens to come from
//     Firebase Auth's own default generator, which is alphanumeric - but
//     that is a fact about this app's current flow, not a property
//     Firebase Auth itself enforces or documents as permanent.
// If SquadStash ever introduces custom/imported Auth uids, or any other
// identity model whose ids may contain this delimiter, every composite-
// id scheme built on this guard must be replaced before such identities
// are supported - not patched around. Until then, assertNoDelimiter
// makes any violation of this assumption LOUD (an explicit "internal"
// rejection) instead of a silent id collision.
export const ID_DELIMITER = "_";

/**
 * Throws if `value` contains the composite-id delimiter - see this
 * module's own header comment for exactly which invariant this guards.
 * @param {string} value The component to check.
 * @param {string} label A short name for the component, for the error.
 * @return {void}
 */
export function assertNoDelimiter(value: string, label: string): void {
  if (value.includes(ID_DELIMITER)) {
    throw new HttpsError(
      "internal",
      `${label} unexpectedly contains "${ID_DELIMITER}" - refusing to ` +
        "build a composite id that could collide."
    );
  }
}

/**
 * Deterministic tripInvitations document id - the entire uniqueness
 * mechanism for "at most one invitation record ever exists for a given
 * (tripId, inviteeUid) pair" (mirrors createBucket.ts's own
 * tripPersonalBucketId convention).
 *
 * Checkpoint 5C.1: moved here from createTripInvitation.ts (a
 * behavior-preserving extraction - exact same formula/guard, same
 * thrown HttpsError) so acceptTripInvitation.ts can reuse this exact
 * primitive to verify a persisted invitation document's own id is
 * canonical for its (tripId, inviteeUid), rather than trusting that
 * merely finding a document at a requested id proves its identity.
 *
 * IMPORTANT: this exact formula is duplicated in
 * src/services/firebase/tripInvitations.ts on the client (a separate
 * compiled TypeScript project with no shared import path). Keep both in
 * sync manually if this ever changes.
 * @param {string} tripId The Trip's document id.
 * @param {string} inviteeUid The resolved invitee's uid.
 * @return {string} The deterministic invitation document id.
 */
export function tripInvitationId(tripId: string, inviteeUid: string): string {
  assertNoDelimiter(tripId, "tripId");
  assertNoDelimiter(inviteeUid, "inviteeUid");
  return `${tripId}${ID_DELIMITER}${inviteeUid}`;
}

/**
 * Deterministic tripMembershipAcceptances document id (Checkpoint 5C.1,
 * per the frozen docs/audits/
 * TRIP_FINANCIAL_MEMBERSHIP_ACCEPTANCE_PREFLIGHT_2026-10-16.md §12) -
 * `{tripId}_{uid}_{termsDocId}`, applying the same delimiter guard to
 * every component. The entire uniqueness mechanism for "one historical
 * acceptance per member per terms version" - a later acceptance of a
 * newer terms version naturally produces a different id, never
 * overwriting an earlier one.
 * @param {string} tripId The Trip's document id.
 * @param {string} uid The accepting member's uid.
 * @param {string} termsDocId The exact tripTerms document accepted.
 * @return {string} The deterministic acceptance document id.
 */
export function tripMembershipAcceptanceId(
  tripId: string,
  uid: string,
  termsDocId: string
): string {
  assertNoDelimiter(tripId, "tripId");
  assertNoDelimiter(uid, "uid");
  assertNoDelimiter(termsDocId, "termsDocId");
  return `${tripId}${ID_DELIMITER}${uid}${ID_DELIMITER}${termsDocId}`;
}
