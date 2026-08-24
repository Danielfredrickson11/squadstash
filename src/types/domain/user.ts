import type { PersistedTimestamp } from "./common";

// Persisted users/{uid} document (private profile). No current read path
// exists anywhere in the app - this shape is inferred from
// upsertUserProfile's write payload (src/services/firebase/users.ts),
// the only current source of truth for this collection. createdAt stays
// optional: only writes with includeCreatedAt set it (registration),
// login's self-heal upsert never does.
export type UserProfile = {
  uid: string;
  displayName: string;
  email: string;
  photoURL: string | null;
  createdAt?: PersistedTimestamp;
  updatedAt: PersistedTimestamp;
};

export type UpsertUserProfileInput = {
  uid: string;
  displayName: string;
  email: string;
  photoURL: string | null;
  includeCreatedAt?: boolean;
};

// Persisted publicUsers/{uid} document. displayName/photoURL match the
// exact shape subscribeToPublicUsersByIds has always produced - defaulted
// to "" at the mapping boundary for any legacy/malformed document, never
// left undefined. updatedAt is a real written field (see
// upsertPublicProfile) that the current read mapping does not surface;
// it's included here, optional, so this type honestly represents the
// full persisted document without changing what the mapping returns.
export type PublicProfile = {
  uid: string;
  displayName: string;
  photoURL: string;
  updatedAt?: PersistedTimestamp;
};

export type UpsertPublicProfileInput = {
  uid: string;
  displayName: string;
  photoURL: string;
};
