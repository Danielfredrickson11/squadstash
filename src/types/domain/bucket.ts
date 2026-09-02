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
  // adoption are intended to start at 0. Set only by trusted backend
  // operations (never a client-write input).
  ledgerOpeningBalanceMinor?: number;
  // ledgerBalanceMinor: the trusted, materialized current savings total
  // in integer minor units - conceptually
  // ledgerOpeningBalanceMinor + contributions - withdrawals, maintained
  // only by trusted backend operations so that a write never has to
  // re-sum the full savingsTransactions history. The full opening
  // balance plus transaction history remains the auditable financial
  // truth; this field is a cache of that truth, not a second source of
  // it. Bucket.balance stays the separate, dollar-denominated display/
  // compatibility cache, derived from this field only at the final
  // boundary (balance = ledgerBalanceMinor / 100) - never the other way
  // around once ledger tracking has begun. Optional for backward
  // compatibility; never a client-write input.
  ledgerBalanceMinor?: number;
};

// Input for the trusted createBucket Cloud Function (Milestone 2B
// Checkpoint 4G-2). ownerId/memberIds/balance/ledger fields/currency/
// bucketType are all backend-derived - none may be sent from here, and
// none appear in this type (see functions/src/callables/createBucket.ts).
// startingBalanceMinor is integer minor units, not dollars, matching
// RecordSavingsTransactionInput's amountMinor convention - deliberately
// distinct from `target`, which stays dollar-number for this checkpoint.
export type CreateBucketInput = {
  name: string;
  target: number;
  startingBalanceMinor: number;
  color: string | null;
  clientRequestId: string;
};
