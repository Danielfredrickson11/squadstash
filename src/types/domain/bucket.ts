import type { PersistedTimestamp } from "./common";

// A Bucket document serves two frozen Milestone 2B product concepts:
// - "personal": an ordinary Buckets-tab savings goal (may be owned solo
//   or shared with explicitly-added members - sharing does not make it
//   a Trip).
// - "trip_personal": one member's own private spending fund inside a
//   Trip (meals, souvenirs, etc.) - separate from the Trip's shared
//   contribution fund, which lives on the Trip document itself, not on
//   a second Bucket.
export type BucketType = "personal" | "trip_personal";

// Persisted buckets/{bucketId} document. name/createdAt/lastUpdatedAt/
// lastUpdatedBy stay optional to honestly reflect that the current read
// mapping (subscribeToUserBuckets) does not coerce/default them - see
// that function for where legacy-document handling actually happens.
export type Bucket = {
  id: string;
  name?: string;
  target: number;
  balance: number;
  color?: string | null;
  ownerId: string;
  memberIds: string[];
  createdAt?: PersistedTimestamp;
  lastUpdatedAt?: PersistedTimestamp;
  lastUpdatedBy?: string;

  // Frozen Milestone 2A additive fields (see docs/architecture design
  // freeze). Optional only - no service writes these yet, and existing/
  // legacy bucket documents remain valid without them.
  targetDate?: PersistedTimestamp | null;
  imageUrl?: string | null;
  archivedAt?: PersistedTimestamp | null;
  currency?: string;

  // Frozen Milestone 2B additive fields. All optional - no service
  // writes these yet, and existing/legacy bucket documents remain valid
  // without them.
  //
  // bucketType: "personal" for a normal Buckets-tab bucket, or
  // "trip_personal" for a member's own fund linked to a Trip. Optional
  // for legacy compatibility - every bucket created before this field
  // existed has none. The intended legacy fallback is conceptually
  // `bucket.bucketType ?? "personal"`, but that fallback is not
  // implemented anywhere yet (no runtime code reads this field).
  bucketType?: BucketType;
  // linkedTripId: the Trip this bucket's personal fund belongs to, only
  // meaningful when bucketType is "trip_personal". null/absent for
  // every normal personal bucket. No invariant (e.g. "must be set when
  // bucketType is trip_personal") is enforced by this type or anywhere
  // else yet.
  linkedTripId?: string | null;
  // ledgerOpeningBalanceMinor: a neutral, resource-level starting
  // balance (integer minor units) representing money this bucket already
  // held before savingsTransactions ledger tracking began - e.g. a
  // legacy bucket.balance of $750 becomes ledgerOpeningBalanceMinor:
  // 75000 once migrated. It is NEVER attributable to any specific
  // member (we don't know who historically contributed it), and is
  // therefore excluded from any per-member savings calculation. Optional
  // for backward compatibility; newly-created buckets under full ledger
  // adoption are intended to start at 0. Not migrated or read by any
  // runtime code yet.
  ledgerOpeningBalanceMinor?: number;
};

export type CreateBucketInput = {
  name: string;
  target: number;
  balance: number;
  color: string | null;
  ownerId: string;
};
