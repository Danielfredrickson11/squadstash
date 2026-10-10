import type { PersistedTimestamp } from "./common";

// Persisted tripMemberOwnership/{tripId}_{uid} document (Checkpoint
// 5B.1), per docs/audits/
// TRIP_WALLET_OWNERSHIP_WITHDRAWAL_PREFLIGHT_2026-10-08.md §12 (Option
// C). A trusted-backend-maintained CACHE of a single member's current
// economic ownership of a Trip's Shared Stash, in integer minor units -
// never the immutable source of truth (the full `savingsTransactions`/
// `tripExpenses`/`tripOwnershipAllocations` history remains that).
//
// Not yet consulted by any trusted financial callable (that is
// explicitly 5B.2/5B.3's job) - this checkpoint defines the schema and
// its Firestore Rules only. No UI reads this yet either.
export type TripMemberOwnership = {
  id: string;
  tripId: string;
  uid: string;
  ownershipMinor: number;
  lastUpdatedAt: PersistedTimestamp;
};
