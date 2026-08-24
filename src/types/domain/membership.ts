import type { PersistedTimestamp } from "./common";

export type Role = "owner" | "admin" | "member";

// Persisted buckets/{bucketId}/members/{uid} or trips/{tripId}/members/{uid}
// document (frozen Milestone 2A hybrid membership model: parent
// memberIds[] stays the query-friendly index, this subcollection carries
// role/join metadata an array can't hold).
//
// joinedAt is nullable, not just optional: a legacy/implicit membership
// (no document was ever written for it) or a lazily-backfilled document
// created for a reason unrelated to actually joining must never fabricate
// a historical join date. null is the honest, permanent representation
// for those cases - not a placeholder waiting to be filled in.
export type Membership = {
  uid: string;
  role: Role;
  joinedAt: PersistedTimestamp | null;
  invitedBy?: string | null;
};

// Input for creating a genuinely new membership record. joinedAt is not
// accepted here - the service/backend that eventually writes this
// decides it (a real join sets it via serverTimestamp(); a lazily
// created legacy-backfill doc that isn't a real join event sets it to
// null instead). No Firestore server-timestamp sentinel appears in this
// type.
export type CreateMembershipInput = {
  uid: string;
  role: Role;
  invitedBy?: string | null;
};
