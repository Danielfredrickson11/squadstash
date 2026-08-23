import type { PersistedTimestamp } from "./common";

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
};

export type CreateBucketInput = {
  name: string;
  target: number;
  balance: number;
  color: string | null;
  ownerId: string;
};
