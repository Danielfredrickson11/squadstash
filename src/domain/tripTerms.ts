// Checkpoint 5A/5A.1 pure helpers for the TripTerms model. No
// Firestore/Firebase import here - see
// src/services/firebase/tripTerms.ts for the actual read/write service.
// Version assignment itself is server-authoritative (the trusted
// publishTripTerms callable) as of Checkpoint 5A.1 - no version-math
// helper lives in this file.

export const MAX_TRIP_TERMS_FIELD_LENGTH = 2000;

export type TripTermsDisclosureFields = {
  contributionExpectations: string;
  expenseAllocationExpectations: string;
  sharedStashSpendingAuthority: string;
  withdrawalExpectations: string;
  settlementExpectations: string;
};

/**
 * True if every disclosure field a new TripTerms version requires is a
 * non-empty, reasonably-sized string. Mirrors (but does not replace)
 * publishTripTerms.ts's own create-time validation - this exists only so
 * the UI/service layer can reject an incomplete draft before even
 * attempting a call, never as the actual security boundary.
 */
export function tripTermsFieldsAreComplete(
  fields: TripTermsDisclosureFields
): boolean {
  return Object.values(fields).every(
    (value) =>
      typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= MAX_TRIP_TERMS_FIELD_LENGTH
  );
}

/**
 * True if a member's most-recently-accepted terms version (the highest
 * value in `acceptedVersions`) is still the Trip's current version.
 * Returns false for an empty list rather than throwing.
 */
export function hasAcceptedCurrentTripTermsVersion(
  acceptedVersions: readonly number[],
  currentVersion: number
): boolean {
  if (acceptedVersions.length === 0) {
    return false;
  }
  return Math.max(...acceptedVersions) === currentVersion;
}
