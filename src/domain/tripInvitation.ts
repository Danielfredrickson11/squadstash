import type { TripInvitation } from "../types/domain/tripInvitation";

/** True while an invitation is still awaiting the invitee's response. */
export function isPendingTripInvitation(invitation: TripInvitation): boolean {
  return invitation.status === "pending";
}

/**
 * True if `invitation` is past its expiresAt as of `now`. Expiry is a
 * derived fact (Checkpoint 5A deliberately has no persisted "expired"
 * status) - checking it never implies a Firestore write by itself.
 */
export function isTripInvitationExpired(
  invitation: TripInvitation,
  now: Date
): boolean {
  return invitation.expiresAt.toDate().getTime() <= now.getTime();
}

/**
 * Self-only: an invitee may accept or decline their own pending,
 * not-yet-expired invitation.
 */
export function canRespondToTripInvitation(
  invitation: TripInvitation,
  uid: string,
  now: Date
): boolean {
  return (
    invitation.inviteeUid === uid &&
    isPendingTripInvitation(invitation) &&
    !isTripInvitationExpired(invitation, now)
  );
}

/** Owner-only: a Trip owner may cancel their own still-pending invitation. */
export function canCancelTripInvitation(
  invitation: TripInvitation,
  tripOwnerId: string,
  requestingUid: string
): boolean {
  return tripOwnerId === requestingUid && isPendingTripInvitation(invitation);
}
