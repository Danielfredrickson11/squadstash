import type { PersistedTimestamp } from "./common";

// Persisted tripInvitations/{tripId}_{inviteeUid} document (Checkpoint
// 5A). The deterministic id is the entire uniqueness mechanism: at most
// one invitation record may ever exist for a given (tripId, inviteeUid)
// pair - see functions/src/callables/createTripInvitation.ts. Checkpoint
// 5A deliberately does NOT support re-inviting after a decline/
// cancellation; each (tripId, inviteeUid) pair's invitation history is
// terminal once it leaves "pending" (per the preflight's instruction not
// to add lifecycle states speculatively - a reset-to-pending transition
// can be added later if this becomes a real product need).
//
// FROZEN INVARIANT (preflight §5, amendment 5.0A): an invitation record
// alone grants NO Trip financial authorization and is never consulted by
// any trusted financial callable. It is never added to, and never
// interpreted as part of, a Trip's `memberIds`.
//
// "expired" is deliberately NOT a persisted status value - expiry is
// represented by the plain `expiresAt` timestamp field instead (checked
// by whoever reads an invitation), never a separate enum state that
// could desync from the timestamp it would otherwise duplicate.
export type TripInvitationStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "cancelled";

export type TripInvitation = {
  id: string;
  tripId: string;
  inviterUid: string;
  // Normalized (trimmed, lowercased) - the email the inviter used to
  // look up inviteeUid, kept only for display; never queried against.
  inviteeEmail: string;
  inviteeUid: string;
  status: TripInvitationStatus;
  createdAt: PersistedTimestamp;
  expiresAt: PersistedTimestamp;
  respondedAt: PersistedTimestamp | null;
};

// Checkpoint 5C.3C: the parsed client-side shape of the trusted
// getTripInvitationPreview callable's response (functions/src/callables/
// getTripInvitationPreview.ts) - EXACTLY the six safe, non-financial
// fields that callable returns, and nothing else. Deliberately does NOT
// include target/saved/currency/ledger*/ownerId/memberIds/
// ownershipModel*/creationRequest/inviterUid/inviteeUid/inviteeEmail, or
// any other root Trip/invitation field - a pending invitee must never
// see Trip financial or membership state before joining (frozen
// docs/audits/TRIP_INVITATION_CLIENT_UX_PREFLIGHT_2026-10-18.md §5).
export type TripInvitationPreview = {
  tripId: string;
  title: string;
  location: string | null;
  imageUrl: string;
  tripStartDate: string | null;
  tripEndDate: string | null;
};
