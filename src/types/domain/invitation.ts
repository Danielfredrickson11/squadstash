import type { PersistedTimestamp, ResourceType } from "./common";
import type { Role } from "./membership";

export type InvitationStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "cancelled"
  | "expired";

// A normal invitation can never grant ownership: each bucket/trip has
// exactly one owner, tied to the parent document's ownerId, and an
// invitation-driven role grant must not create or transfer that.
// Ownership transfer, if ever supported, is a separate future trusted
// operation - not something a regular invitation can produce. Derived
// from Role rather than redeclared, so the invitable set can never drift
// out of sync with the canonical role vocabulary.
export type InvitableRole = Exclude<Role, "owner">;

// Persisted invitations/{invitationId} document. id is a plain Firestore
// auto-ID - inviteeEmail is a normalized field, never encoded into the
// document ID or any ID-shaped type (frozen Milestone 2A design freeze:
// raw emails must not appear in Firestore paths; duplicate/idempotency
// enforcement is deferred to a trusted Cloud Function in Milestone 2C).
//
// Invitee access is architecture documentation only at this stage - no
// security rules exist yet. The eventual authorization rule is
// `inviteeUid == auth uid` OR a VERIFIED Firebase Auth email matching
// inviteeEmail; an unverified email claim must never be sufficient.
export type Invitation = {
  id: string;
  resourceType: ResourceType;
  resourceId: string;
  inviterUid: string;
  inviteeEmail: string;
  inviteeUid: string | null;
  role: InvitableRole;
  status: InvitationStatus;
  createdAt: PersistedTimestamp;
  expiresAt: PersistedTimestamp;
  respondedAt: PersistedTimestamp | null;
};

// Input for creating a new invitation. createdAt/expiresAt are
// server-generated, never caller-supplied. status/respondedAt/inviteeUid
// start at their initial values ("pending", null, null) and aren't part
// of the create input either.
export type CreateInvitationInput = {
  resourceType: ResourceType;
  resourceId: string;
  inviterUid: string;
  inviteeEmail: string;
  role: InvitableRole;
};
