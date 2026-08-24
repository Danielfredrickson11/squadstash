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
  // legacy trip documents remain valid without them.
  startDate?: PersistedTimestamp | null;
  endDate?: PersistedTimestamp | null;
  currency?: string;
};

export type CreateTripInput = {
  title: string;
  location: string | null;
  target: number;
  imageUrl: string;
  ownerId: string;
};
