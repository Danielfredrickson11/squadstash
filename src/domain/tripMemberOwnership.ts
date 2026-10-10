// Checkpoint 5B.1: client-side id helper + value validator for the
// trusted tripMemberOwnership cache, mirroring
// functions/src/domain/tripMemberOwnership.ts's own identical formula
// (a separate compiled TypeScript project with no shared import path -
// keep both in sync manually if this ever changes). Reuses this
// project's existing shared composite-id delimiter guard
// (src/domain/tripCompositeId.ts, established in Checkpoints 5A.1/5A.2)
// rather than declaring a third copy of it.
import {
  TRIP_COMPOSITE_ID_DELIMITER,
  assertNoTripCompositeIdDelimiter,
} from "./tripCompositeId";

// Checkpoint 5B.1A, item 2: a dedicated error for an empty id component -
// deliberately separate from TripCompositeIdDelimiterError, since this
// is a different failure category (a missing value, not a delimiter
// collision risk) local to this ownership-specific helper only. The
// shared delimiter guard itself is left unchanged, so this never affects
// tripInvitationId/tripMembershipAcceptanceId's own behavior.
export class TripMemberOwnershipIdError extends Error {}

/**
 * Deterministic tripMemberOwnership document id - the entire uniqueness
 * mechanism for "at most one ownership cache row per (tripId, uid)
 * pair." See tripCompositeId.ts's own header comment for why this
 * concatenation is accepted today. Rejects an empty tripId/uid outright,
 * before the shared delimiter guard even runs.
 */
export function tripMemberOwnershipId(tripId: string, uid: string): string {
  if (tripId.length === 0) {
    throw new TripMemberOwnershipIdError("tripId must be a non-empty string.");
  }
  if (uid.length === 0) {
    throw new TripMemberOwnershipIdError("uid must be a non-empty string.");
  }
  assertNoTripCompositeIdDelimiter(tripId, "tripId");
  assertNoTripCompositeIdDelimiter(uid, "uid");
  return `${tripId}${TRIP_COMPOSITE_ID_DELIMITER}${uid}`;
}

/**
 * True if `value` is a valid `ownershipMinor` - a non-negative (zero IS
 * valid) safe integer, never a float, never unsafe.
 */
export function isValidOwnershipMinor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
