// Checkpoint 5B.1: the trusted per-member Shared-Stash ownership CACHE
// schema primitives, per docs/audits/
// TRIP_WALLET_OWNERSHIP_WITHDRAWAL_PREFLIGHT_2026-10-08.md §12 (Option
// C: "an immutable allocation record plus a cached, atomically-
// maintained per-member balance"). This module defines only the
// deterministic id and the value-shape validator - NOT wired into any
// trusted financial callable yet (that is explicitly 5B.2/5B.3's job).
//
// `tripMemberOwnership/{tripId}_{uid}` is a CACHE, never the immutable
// source of truth - the full `savingsTransactions`/`tripExpenses`/
// `tripOwnershipAllocations` history remains that. Write authority is
// backend-only (firestore.rules closes every client create/update/
// delete unconditionally).
import type {Timestamp} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {ID_DELIMITER, assertNoDelimiter} from "./tripCompositeId";

// The full PERSISTED document shape, once read back from Firestore -
// `lastUpdatedAt` is always a real Timestamp by the time anything reads
// it back (a future writer always sets it via FieldValue.
// serverTimestamp() at write time; this type describes the READ side
// only, exactly matching every other `PersistedTimestamp`-shaped type
// in this project - see SavingsTransactionBase's own identical
// convention). No separate "write candidate" type exists yet for this
// collection, because no callable writes it yet (5B.2/5B.3's job) - one
// will be introduced alongside that first writer, not invented
// speculatively here.
export type TripMemberOwnership = {
  id: string;
  tripId: string;
  uid: string;
  ownershipMinor: number;
  lastUpdatedAt: Timestamp;
};

/**
 * Deterministic tripMemberOwnership document id - the entire uniqueness
 * mechanism for "at most one ownership cache row per (tripId, uid)
 * pair." See domain/tripCompositeId.ts's own header comment for why
 * this concatenation is accepted today, and what would have to change
 * before it no longer is.
 *
 * Corrected by Checkpoint 5B.1A, item 2: an empty `tripId` or `uid` is
 * rejected outright, BEFORE the shared delimiter guard even runs - the
 * shared guard (assertNoDelimiter, used identically by
 * tripInvitationId/tripMembershipAcceptanceId) is deliberately left
 * unchanged, since widening ITS semantics would also affect those
 * already-shipped 5A ids; this non-empty check is local to this
 * ownership-specific helper only.
 *
 * IMPORTANT: this exact formula is duplicated in
 * src/domain/tripMemberOwnership.ts on the client (a separate compiled
 * TypeScript project with no shared import path). Keep both in sync
 * manually if this ever changes.
 * @param {string} tripId The Trip's document id.
 * @param {string} uid The member's uid.
 * @return {string} The deterministic ownership-cache document id.
 */
export function tripMemberOwnershipId(tripId: string, uid: string): string {
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

/**
 * True if `value` is a valid `ownershipMinor` - a non-negative (zero IS
 * valid - an ownership row may legitimately be fully depleted) safe
 * integer, never a float, never unsafe. Pure minor-unit integer
 * arithmetic throughout this project's financial model - no exception
 * here.
 * @param {unknown} value The candidate value.
 * @return {boolean} True if value is a valid ownershipMinor.
 */
export function isValidOwnershipMinor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
