// Checkpoint 6.6: the current, frozen SquadStash Trip role model is
// exactly two organizational states - Owner and Member - with Trip.ownerId
// as the sole owner-identity authority (see docs/architecture/
// TRIP_PERMISSIONS.md). This file exists only to eliminate the one real
// duplicated client-side formula found during the 6.6 preflight
// (app/(tabs)/trips/[tripId]/index.tsx and terms.tsx each computed
// "am I the owner" independently, identically). It is deliberately NOT a
// generic permissions framework - no canManageMembers/canSpendMoney/
// getRoleCapabilities-style helpers exist here, because no current
// source requires them; financial authorization remains entirely
// separate (self-only/any-member/creator-or-owner/recipient-only,
// per-transaction-type - see the architecture doc) and is never derived
// from this helper.
//
// SECURITY NOTE: this is UI/domain convenience only, never an
// authorization source. Every privileged action this helper might gate
// in a screen remains independently enforced by Firestore Rules or a
// trusted Cloud Function - this helper has no ability to grant or deny
// anything on its own.

/**
 * True when `uid` is the Trip's current owner. Null/undefined-safe on
 * both sides - a Trip or user that hasn't loaded yet correctly reads as
 * "not the owner," never throws.
 * @param {string | null | undefined} ownerId The Trip's own ownerId field.
 * @param {string | null | undefined} uid The candidate uid (typically
 *   the signed-in user).
 * @return {boolean} True only when both are non-empty and equal.
 */
export function isTripOwner(
  ownerId: string | null | undefined,
  uid: string | null | undefined
): boolean {
  return !!ownerId && !!uid && ownerId === uid;
}
