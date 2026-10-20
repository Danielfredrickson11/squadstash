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
 * ADVISORY, client-side only - a "pending + unexpired self" predicate,
 * never an authorization source. Checkpoint 5C.2 permanently closed the
 * direct Firestore `pending -> accepted` write path (accepting is now
 * the trusted acceptTripInvitation Cloud Function, which independently
 * re-derives and re-validates this exact condition - and more - fresh
 * at call time); this helper's name predates that change and still
 * describes "self, pending, unexpired," which remains true for BOTH
 * accept and decline, but it must never be read as modeling direct
 * Firestore acceptance permission, and must never be used as the
 * security gate for an Accept action. For decline specifically, do not
 * use this helper to decide whether firestore.rules would permit the
 * write either - Rules intentionally allow the invitee to decline even
 * after expiry (a decline only ever narrows, never grants), which this
 * predicate's `!isTripInvitationExpired` term does not reflect. Safe
 * uses: deciding whether to show an invitation as "awaiting your
 * response" in a list (e.g. the Trips screen's own
 * fetchPendingInvitationsForUser, which already filters to this exact
 * condition before this helper would ever be consulted).
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

// Checkpoint 5C.3C: a pure classifier for the trusted acceptTripInvitation
// callable's own distinguishable anti-TOCTOU rejection signal (frozen
// docs/audits/TRIP_FINANCIAL_MEMBERSHIP_ACCEPTANCE_PREFLIGHT_2026-10-16.md
// §8/§10: `HttpsError("failed-precondition", ..., {reason:
// "terms_changed"})`). Checks ONLY the structured `details.reason`
// field a Firebase Functions client SDK error carries - never raw
// message text, which is free-form and not a stable contract. Never
// mutates or rewraps the error; the caller is expected to inspect the
// original error object for its own `code`/`message` as needed.
export function isTripInvitationTermsChangedError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const details = (error as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) {
    return false;
  }
  return (details as { reason?: unknown }).reason === "terms_changed";
}

/** Owner-only: a Trip owner may cancel their own still-pending invitation. */
export function canCancelTripInvitation(
  invitation: TripInvitation,
  tripOwnerId: string,
  requestingUid: string
): boolean {
  return tripOwnerId === requestingUid && isPendingTripInvitation(invitation);
}
