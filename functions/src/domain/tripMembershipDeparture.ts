// Checkpoint 6.7B1: pure domain primitives for trusted Trip membership
// departure (leaveTrip / removeTripMember) - the deterministic
// departure-event id, the departure event's own persisted shape, and
// canonical memberIds validation/reconstruction. No Firestore access in
// this file (the one narrow exception being tripMembershipDepartureId's
// own HttpsError throw, mirroring tripMemberOwnershipId/
// tripExpenseBalanceId's own identical established convention for a
// deterministic-id helper) - the trusted callable core
// (functions/src/callables/tripMembershipDepartureCore.ts) performs
// every Firestore read/write and maps a validation failure here onto
// its own exact HttpsError code/message.
//
// A departure event is audit evidence and future former-member residual
// authorization evidence (6.7B2) - it is NEVER current membership
// authority (that remains Trip.ownerId/Trip.memberIds exclusively).
// There is at most one departure event per (tripId, uid) pair - the
// current invitation architecture is terminal, so rejoin is not
// possible yet; this is a known, disclosed limitation (6.7C UI), not a
// defect to work around here.
import {HttpsError} from "firebase-functions/v2/https";
import {ID_DELIMITER, assertNoDelimiter} from "./tripCompositeId";

export type DepartureType = "left" | "removed";

// The full PERSISTED document shape, once read back from Firestore -
// `departedAt` is always a real Timestamp by the time anything reads it
// back (the trusted callable always sets it via
// FieldValue.serverTimestamp() at write time), matching every other
// `PersistedTimestamp`-shaped type in this project. currencySnapshot is
// optional - included only because the Trip's own `currency` field was
// present and well-formed at departure time; never fabricated.
export type TripMembershipDeparture = {
  id: string;
  tripId: string;
  uid: string;
  departureType: DepartureType;
  departedByUid: string;
  departedAt: unknown;
  tripTitleSnapshot: string;
  currencySnapshot?: string;
};

/**
 * Deterministic tripMembershipDepartures document id - the entire
 * uniqueness mechanism for "at most one departure event ever, per
 * (tripId, uid) pair." Mirrors tripMemberOwnershipId/
 * tripExpenseBalanceId's own identical convention exactly (an empty
 * tripId/uid is rejected outright, before the shared delimiter guard
 * even runs).
 * @param {string} tripId The Trip's document id.
 * @param {string} uid The departing member's uid.
 * @return {string} The deterministic departure document id.
 */
export function tripMembershipDepartureId(tripId: string, uid: string): string {
  if (tripId.length === 0) {
    throw new HttpsError(
      "invalid-argument",
      "tripId must be a non-empty string."
    );
  }
  if (uid.length === 0) {
    throw new HttpsError(
      "invalid-argument",
      "uid must be a non-empty string."
    );
  }
  assertNoDelimiter(tripId, "tripId");
  assertNoDelimiter(uid, "uid");
  return `${tripId}${ID_DELIMITER}${uid}`;
}

// The exact fields an exact-replay match compares (Checkpoint 6.7B1
// §7) - deliberately NOT departedAt/tripTitleSnapshot/currencySnapshot,
// which are informational snapshot evidence, never part of the replay
// identity itself.
export type DepartureMatchCandidate = {
  tripId: string;
  uid: string;
  departureType: DepartureType;
  departedByUid: string;
};

/**
 * True if `value` has the minimum well-formed shape of a persisted
 * departure record needed to safely evaluate an exact-replay match -
 * never trusts a document's mere existence at the canonical id as proof
 * of its own content (the same "canonical document identity" discipline
 * already established by e.g. recordSharedStashExpense.ts's own
 * allocation-identity checks).
 * @param {unknown} value The candidate value, as read back from
 *   Firestore.
 * @return {boolean} True if value is well-formed enough to compare.
 */
export function isWellFormedDepartureMatchCandidate(
  value: unknown
): value is DepartureMatchCandidate {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.tripId === "string" &&
    v.tripId.length > 0 &&
    typeof v.uid === "string" &&
    v.uid.length > 0 &&
    (v.departureType === "left" || v.departureType === "removed") &&
    typeof v.departedByUid === "string" &&
    v.departedByUid.length > 0
  );
}

export type MemberIdsValidationResult =
  | {ok: true; memberIds: string[]}
  | {ok: false; reason: string};

/**
 * Validates `Trip.memberIds` as a canonical SET-like authorization
 * list, together with `Trip.ownerId` - Checkpoint 6.7B1 §8. Never
 * repaired, never deduplicated, never normalized, never sorted - any
 * violation fails closed. Mirrors acceptTripInvitation.ts's own
 * `assertCanonicalMemberIds` invariant exactly, as a deliberate,
 * independent, pure duplicate (per this checkpoint's own explicit
 * instruction not to refactor that callable merely for symmetry) -
 * returning a result union here instead of throwing, so this helper
 * stays isolated-unit-testable without an HttpsError dependency.
 * @param {unknown} ownerId The Trip document's own ownerId field.
 * @param {unknown} memberIds The Trip document's own memberIds field.
 * @return {MemberIdsValidationResult} The validated, canonical
 *   memberIds array, or the specific reason validation failed.
 */
export function validateCanonicalMemberIds(
  ownerId: unknown,
  memberIds: unknown
): MemberIdsValidationResult {
  if (typeof ownerId !== "string" || ownerId.length === 0) {
    return {ok: false, reason: "Trip.ownerId must be a non-empty string."};
  }
  if (!Array.isArray(memberIds)) {
    return {ok: false, reason: "Trip.memberIds must be an array."};
  }
  const seen = new Set<string>();
  for (const entry of memberIds) {
    if (typeof entry !== "string" || entry.length === 0) {
      return {
        ok: false,
        reason: "Trip.memberIds contains a non-string or empty-string entry.",
      };
    }
    if (seen.has(entry)) {
      return {ok: false, reason: "Trip.memberIds contains a duplicate uid."};
    }
    seen.add(entry);
  }
  const ownerOccurrences = memberIds.filter((uid) => uid === ownerId).length;
  if (ownerOccurrences !== 1) {
    return {
      ok: false,
      reason: "Trip.ownerId must appear in memberIds exactly once.",
    };
  }
  return {ok: true, memberIds: memberIds as string[]};
}

export type MemberRemovalResult =
  | {ok: true; newMemberIds: string[]}
  | {ok: false; reason: string};

/**
 * Reconstructs `Trip.memberIds` with exactly `targetUid` removed -
 * Checkpoint 6.7B1 §9. Never a blind `arrayRemove(targetUid)`: the
 * caller must already have validated `memberIds` as canonical (via
 * `validateCanonicalMemberIds`) before calling this. Preserves every
 * unrelated member's relative order exactly (`Array.prototype.filter`),
 * requires `targetUid` to appear exactly once before removal, and
 * re-verifies `ownerId` still appears exactly once in the RESULT -
 * never trusting that removing one specific uid couldn't somehow also
 * disturb the owner invariant.
 * @param {string} ownerId The Trip's own, already-validated ownerId.
 * @param {string[]} memberIds The already-validated, canonical
 *   memberIds array.
 * @param {string} targetUid The uid to remove.
 * @return {MemberRemovalResult} The reconstructed memberIds array, or
 *   the specific reason removal could not be performed safely.
 */
export function removeMemberFromCanonicalMemberIds(
  ownerId: string,
  memberIds: string[],
  targetUid: string
): MemberRemovalResult {
  const targetOccurrences = memberIds.filter((uid) => uid === targetUid).length;
  if (targetOccurrences !== 1) {
    return {
      ok: false,
      reason: `targetUid "${targetUid}" must appear in memberIds exactly once.`,
    };
  }
  const newMemberIds = memberIds.filter((uid) => uid !== targetUid);
  const ownerOccurrences = newMemberIds.filter((uid) => uid === ownerId).length;
  if (ownerOccurrences !== 1) {
    return {
      ok: false,
      reason: "Trip.ownerId must still appear in memberIds exactly once " +
        "after removal.",
    };
  }
  return {ok: true, newMemberIds};
}
