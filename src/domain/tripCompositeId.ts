// Checkpoint 5A.1 (item 7), corrected by 5A.2 (item 5): the underscore
// delimiter used by tripInvitationId/tripMembershipAcceptanceId is
// accepted only because SquadStash's CURRENT generated-id/auth flow
// happens not to produce a component containing it - never because the
// underlying Firebase APIs themselves guarantee this. See
// functions/src/callables/createTripInvitation.ts's own identical
// comment (duplicated there rather than imported, since it is a
// separate compiled TypeScript project) for the full reasoning:
//   - tripId/termsDocId are Firestore auto-generated document ids -
//     Firestore's own documented auto-id alphabet has no underscore, so
//     this part IS a genuine platform guarantee.
//   - uid is a Firebase Auth uid - Firebase Auth's own API does NOT
//     promise a uid is underscore-free (it is an opaque string of at
//     most 128 characters); this app's uids happen to be underscore-free
//     today only because its registration flow never calls the Admin
//     SDK's createUser() with a caller-chosen uid anywhere, not because
//     Firebase Auth forbids it. If SquadStash ever introduces custom/
//     imported Auth uids, or another identity model whose ids may
//     contain this delimiter, this composite-id scheme must be replaced
//     before those identities are supported - not patched around.
// assertNoTripCompositeIdDelimiter is belt-and-suspenders: it converts a
// violation of this app-specific assumption into a loud, explicit
// rejection instead of a silent id collision.
export const TRIP_COMPOSITE_ID_DELIMITER = "_";

export class TripCompositeIdDelimiterError extends Error {}

/**
 * Throws if `value` contains the composite-id delimiter.
 */
export function assertNoTripCompositeIdDelimiter(
  value: string,
  label: string
): void {
  if (value.includes(TRIP_COMPOSITE_ID_DELIMITER)) {
    throw new TripCompositeIdDelimiterError(
      `${label} unexpectedly contains "${TRIP_COMPOSITE_ID_DELIMITER}" - ` +
        "refusing to build a composite id that could collide."
    );
  }
}
