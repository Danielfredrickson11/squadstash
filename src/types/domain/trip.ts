import type { PersistedTimestamp } from "./common";

// Persisted trips/{tripId} document. Every field but id stays optional,
// matching the current read mapping (mapTripDocument, used by
// fetchMemberTripsOrdered/fetchMemberTrips/fetchTripById in
// src/services/firebase/trips.ts), which picks each field individually
// from the raw Firestore document without defaulting or validating it -
// so nothing beyond `id` is actually guaranteed present by the mapping
// itself. location is normalized to `string | null` (not just `string`)
// since createTrip legitimately writes null for an empty location.
export type Trip = {
  id: string;
  title?: string;
  location?: string | null;
  target?: number;
  saved?: number;
  imageUrl?: string;
  ownerId?: string;
  memberIds?: string[];
  createdAt?: PersistedTimestamp;
  lastUpdatedAt?: PersistedTimestamp;
  lastUpdatedBy?: string;

  // Frozen Milestone 2A additive fields (see docs/architecture design
  // freeze). Optional only - no service writes these yet, and existing/
  // legacy trip documents remain valid without them. Superseded by
  // tripStartDate/tripEndDate below for actual calendar-date use
  // (Checkpoint 3F.3B.2) - left in place, still unused/unwired, rather
  // than removed, since no code depends on them either way.
  startDate?: PersistedTimestamp | null;
  endDate?: PersistedTimestamp | null;
  currency?: string;

  // Checkpoint 3F.3B.2: canonical calendar-date-ONLY strings
  // ("YYYY-MM-DD", e.g. "2027-06-12") - deliberately NOT the
  // PersistedTimestamp fields above. A Timestamp encodes a specific
  // instant and requires picking a timezone to convert to/from a
  // calendar date, which is exactly the class of bug ("was it still
  // June 12 where the user was, or had it already rolled to June 13
  // UTC?") a date-only string avoids by construction - see
  // src/domain/tripDates.ts for the parsing/formatting/horizon helpers
  // built on this representation. tripStartDate is the date travel
  // begins - also the intended future savings-planning deadline.
  // tripEndDate is optional. Both remain optional/nullable: existing
  // trip documents have neither, and neither is ever backfilled with a
  // fabricated value - the UI shows truthful "Add trip dates" copy
  // instead. Set by the client at trip-creation time (Trip creation is
  // a direct client write gated by firestore.rules, not a trusted
  // Cloud Function - see createTrip in src/services/firebase/trips.ts);
  // not yet part of any update/edit path.
  tripStartDate?: string | null;
  tripEndDate?: string | null;

  // Frozen Milestone 2B additive fields. A neutral, resource-level
  // starting balance (integer minor units) representing money the
  // Trip's shared fund already held before savingsTransactions ledger
  // tracking began - e.g. a legacy trip.saved of $750 becomes
  // ledgerOpeningBalanceMinor: 75000 once migrated. It is NEVER
  // attributable to any specific Trip member, and is therefore excluded
  // from any per-member savings calculation. Optional for backward
  // compatibility; newly-created trips under full ledger adoption are
  // intended to start at 0. Set only by trusted backend operations
  // (never a client-write input). (bucketType/linkedTripId are
  // Bucket-only concepts and do not apply to Trip - a Trip is itself the
  // shared fund, not a container for a separate Bucket.)
  ledgerOpeningBalanceMinor?: number;
  // ledgerBalanceMinor: the trusted, materialized current shared-fund
  // savings total in integer minor units - conceptually
  // ledgerOpeningBalanceMinor + contributions - withdrawals, maintained
  // only by trusted backend operations so a write never has to re-sum
  // the full savingsTransactions history. The full opening balance plus
  // transaction history remains the auditable financial truth; this
  // field is a cache of that truth, not a second source of it.
  // Trip.saved stays the separate, dollar-denominated display/
  // compatibility cache, derived from this field only at the final
  // boundary (saved = ledgerBalanceMinor / 100) - never the other way
  // around once ledger tracking has begun. Optional for backward
  // compatibility; never a client-write input.
  ledgerBalanceMinor?: number;

  // Checkpoint 4B.5B, per the approved docs/audits/
  // TRIP_ARCHIVE_DELETE_SAFETY_PREFLIGHT_2026-09-13.md (as hardened by
  // its 4B.5A.1 amendment): a Trip is never client-hard-deletable -
  // "Delete Trip" is archiving instead, a one-way, owner-only Firestore
  // Rules-enforced transition (firestore.rules). archivedAt's own
  // presence/absence IS the archive status - there is deliberately NO
  // separate `status: "active" | "archived"` field, which would just be
  // a second, independently-settable source of truth for the exact same
  // fact and could disagree with archivedAt from a bug or partial write.
  // Both fields are optional/nullable: a legacy Trip has neither key at
  // all and must be treated as active everywhere (mapTripDocument does
  // not fabricate a value for either - see src/services/firebase/trips.ts).
  archivedAt?: PersistedTimestamp | null;
  archivedBy?: string | null;
};

export type CreateTripInput = {
  title: string;
  location: string | null;
  target: number;
  imageUrl: string;
  ownerId: string;
  // Checkpoint 3F.3B.2: canonical "YYYY-MM-DD" strings (see the Trip
  // type comment above). tripStartDate is required for trips created
  // from this checkpoint forward - app/(tabs)/trips/create.tsx validates
  // this client-side before calling createTrip. tripEndDate stays
  // optional/nullable.
  tripStartDate: string;
  tripEndDate: string | null;
};
