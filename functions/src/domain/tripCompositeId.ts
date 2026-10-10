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
