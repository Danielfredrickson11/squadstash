// Pure helper for the "My Stash" personal-trip-fund identity (Milestone
// 3 Checkpoint 3F.3B.4). No Firestore, no framework imports.
//
// A trip_personal Bucket's Firestore document id is DETERMINISTIC -
// derived from (linkedTripId, ownerUid) rather than a client-chosen
// random clientRequestId (the scheme ordinary "personal" Buckets use).
// This is the entire uniqueness mechanism for "at most one trip_personal
// Bucket per (ownerUid, linkedTripId)": Firestore transactions already
// guarantee that concurrent attempts to read-then-write the SAME
// document id serialize correctly (the trusted createBucket callable's
// existing read-before-write transaction pattern), so two racing
// "Create My Stash" submissions for the same trip+user can never produce
// two documents - the second one always lands on the read-existing/
// replay branch instead. No separate claim/uniqueness collection is
// needed.
//
// IMPORTANT: this exact formula is duplicated in
// functions/src/callables/createBucket.ts (a separate compiled
// TypeScript project with no shared import path - the same constraint
// documented for MAX_TRANSACTION_NOTE_LENGTH in
// src/services/firebase/savingsTransactions.ts). Keep both in sync
// manually if this ever changes. The client uses this only to look up
// its OWN existing fund by direct document id (no query, no new
// Firestore index) - it never needs to guess another user's fund id for
// any legitimate purpose, and Firestore rules deny read access to a
// trip_personal Bucket's document regardless of whether its id is known.
export function tripPersonalBucketId(tripId: string, uid: string): string {
  return `tripfund_${tripId}_${uid}`;
}

// Checkpoint 3F.3B.4C: the predicate the client uses to verify a Bucket
// document read back after "Create My Stash" (or discovered via an
// already-exists retry) is actually the caller's OWN trip_personal fund
// for THIS trip - not a coincidentally-shaped document, and not another
// member's fund. This is a read-time sanity check, not a security
// boundary (Firestore rules are the actual boundary - a caller can never
// even fetch another member's fund document by id). Deliberately takes a
// minimal structural shape rather than importing the full Bucket domain
// type, keeping this file free of any outside dependency.
export type MinimalTripPersonalBucketFields = {
  bucketType?: string | null;
  linkedTripId?: string | null;
  ownerId?: string | null;
};

export function isMatchingTripPersonalBucket(
  bucket: MinimalTripPersonalBucketFields | null | undefined,
  tripId: string,
  ownerUid: string
): boolean {
  return (
    !!bucket &&
    bucket.bucketType === "trip_personal" &&
    bucket.linkedTripId === tripId &&
    bucket.ownerId === ownerUid
  );
}
