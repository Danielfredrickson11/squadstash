import type { PersistedTimestamp } from "./common";

// Persisted tripTerms/{autoId} document (Checkpoint 5A, versioning
// hardened by 5A.1). One Trip may have many TripTerms documents over its
// lifetime - each is an immutable, append-only version; nothing ever
// updates one in place. "The current version" is never resolved by a
// client-side query/max - see TripTermsCurrentPointer below.
//
// Scope (Checkpoint 5A, per docs/audits/
// TRIP_WALLET_MILESTONE_PREFLIGHT_2026-10-06.md's revised §10): this is
// disclosure/agreement CONTENT only. It grants no financial authorization
// by itself, and nothing here is consulted by any trusted financial
// callable. A later checkpoint (5C) may use a member's accepted version
// as one input to a financial-membership decision - 5A does not wire it
// to anything.
//
// Each expectation field is a short, owner-authored free-text
// description, not a structured rules engine - Master Spec §12.2/§12.3
// requires these topics to be disclosed and accepted, but does not
// require (and this sandbox/test-money product does not yet need) a
// machine-enforceable policy language for any of them. Modeling actual
// enforcement (e.g. real commitment/withdrawal restrictions) is
// deliberately deferred to a future commitment-lifecycle checkpoint, per
// the preflight's own instruction not to model every future disclosure
// now.
export type TripTerms = {
  id: string;
  tripId: string;
  // Monotonically increasing per tripId, starting at 1 - server-assigned
  // and transactionally unambiguous (Checkpoint 5A.1): the trusted
  // publishTripTerms callable is the only writer, and it reads-then-
  // increments a single tripTermsCurrent/{tripId} pointer document
  // inside the same Firestore transaction that creates the new version,
  // so concurrent publish attempts can never produce two competing
  // "version N" documents - see that callable's own header comment.
  version: number;
  createdAt: PersistedTimestamp;
  createdBy: string;
  contributionExpectations: string;
  expenseAllocationExpectations: string;
  sharedStashSpendingAuthority: string;
  withdrawalExpectations: string;
  settlementExpectations: string;
};

// Input for publishing a new TripTerms version via the trusted
// publishTripTerms callable (Checkpoint 5A.1). id/version/createdAt/
// createdBy are all server-assigned (createdBy is always the
// authenticated caller) - never caller-supplied.
export type CreateTripTermsInput = {
  tripId: string;
  contributionExpectations: string;
  expenseAllocationExpectations: string;
  sharedStashSpendingAuthority: string;
  withdrawalExpectations: string;
  settlementExpectations: string;
};

// Persisted tripTermsCurrent/{tripId} document (Checkpoint 5A.1) - the
// Trip's own id IS this document's id, never a field inside it. The
// single source of truth for "which exact TripTerms document is
// currently authoritative for this Trip," written only by
// publishTripTerms.ts inside the same transaction that creates the
// TripTerms document it names. firestore.rules' tripMembershipAcceptances
// create rule reads this directly to reject acceptance of anything but
// the current version - never a client-trusted computation.
export type TripTermsCurrentPointer = {
  tripId: string;
  currentVersion: number;
  currentTermsDocId: string;
  updatedAt: PersistedTimestamp;
};
