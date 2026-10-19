import {HttpsError} from "firebase-functions/v2/https";

// Checkpoint 5C.1: extracted from publishTripTerms.ts's own private
// assertValidExistingPointer/assertPointerTargetValid functions - a
// behavior-preserving extraction (exact same checks, exact same thrown
// HttpsError code/message in every case) so this authoritative
// tripTermsCurrent/{tripId} pointer validation lives in exactly one
// place, per the frozen docs/audits/
// TRIP_FINANCIAL_MEMBERSHIP_ACCEPTANCE_PREFLIGHT_2026-10-16.md §9a:
// "the acceptance backend must NOT create a subtly different second
// implementation." Both publishTripTermsCore and the new
// acceptTripInvitationCore import and call these two functions; neither
// ever re-derives its own notion of "is this pointer/terms pair
// internally consistent." Client-side validation
// (fetchCurrentTripTerms's own corruption checks) remains advisory/
// display-only and is never treated as authoritative here.

/**
 * Validates an EXISTING tripTermsCurrent/{tripId} pointer's own fields,
 * following this project's established corruption/server-state error
 * convention (see recordSavingsTransaction.ts's identical
 * failed-precondition pattern for a malformed ledger state) - never
 * silently treating a malformed pointer as equivalent to "no pointer."
 * @param {FirebaseFirestore.DocumentData} pointerData The pointer
 *   document's data.
 * @param {string} tripId The Trip id this call is for.
 * @return {number} The pointer's validated currentVersion.
 */
export function assertValidExistingPointer(
  pointerData: FirebaseFirestore.DocumentData,
  tripId: string
): number {
  if (pointerData.tripId !== tripId) {
    throw new HttpsError(
      "failed-precondition",
      "Trip terms pointer references a different tripId."
    );
  }
  if (
    !Number.isSafeInteger(pointerData.currentVersion) ||
    (pointerData.currentVersion as number) <= 0
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Trip terms pointer has an invalid currentVersion."
    );
  }
  if (
    typeof pointerData.currentTermsDocId !== "string" ||
    pointerData.currentTermsDocId.length === 0
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Trip terms pointer has an invalid currentTermsDocId."
    );
  }
  return pointerData.currentVersion as number;
}

/**
 * Validates that the EXACT tripTerms document a pointer names actually
 * agrees with it, inside the same transaction - a malformed or manually
 * corrupted pointer must never become the basis of subsequent
 * authoritative history.
 * @param {FirebaseFirestore.DocumentSnapshot} targetSnap The pointer's
 *   named tripTerms document snapshot.
 * @param {string} tripId The Trip id this call is for.
 * @param {number} expectedVersion The pointer's own currentVersion.
 * @return {void}
 */
export function assertPointerTargetValid(
  targetSnap: FirebaseFirestore.DocumentSnapshot,
  tripId: string,
  expectedVersion: number
): void {
  if (!targetSnap.exists) {
    throw new HttpsError(
      "failed-precondition",
      "Trip terms pointer references a terms document that does not exist."
    );
  }
  const targetData = targetSnap.data() as FirebaseFirestore.DocumentData;
  if (targetData.tripId !== tripId) {
    throw new HttpsError(
      "failed-precondition",
      "Trip terms pointer's referenced document belongs to a different Trip."
    );
  }
  if (targetData.version !== expectedVersion) {
    throw new HttpsError(
      "failed-precondition",
      "Trip terms pointer's version disagrees with its referenced document."
    );
  }
}
