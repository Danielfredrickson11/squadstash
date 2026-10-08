import type { PersistedTimestamp } from "./common";

// Persisted tripMembershipAcceptances/{tripId}_{uid}_{termsDocId}
// document (Checkpoint 5A) - an immutable, append-only proof that `uid`
// affirmatively accepted the EXACT TripTerms document `termsDocId` (and
// its denormalized `acceptedTermsVersion`) at `acceptedAt`. A member may
// accumulate more than one of these over a Trip's lifetime (one per
// terms version they've accepted) - nothing here is ever updated or
// deleted, so a later Trip-terms edit (a new TripTerms version) can never
// retroactively imply a member accepted content they never saw.
//
// FROZEN INVARIANT (preflight §5, amendment 5.0A): this record is proof
// of terms acceptance ONLY. It grants no Trip financial authorization by
// itself and is never consulted by any trusted financial callable in
// Checkpoint 5A. A later checkpoint (5C) may use it as one input to a
// financial-membership decision, alongside an accepted TripInvitation -
// 5A does not wire it to anything.
export type TripMembershipAcceptance = {
  id: string;
  tripId: string;
  uid: string;
  termsDocId: string;
  acceptedTermsVersion: number;
  acceptedAt: PersistedTimestamp;
};
