// Checkpoint 6.8B2: the client-side mirror of the approved
// tripMembershipActivity persisted/hydrated distinction
// (functions/src/domain/tripMembershipActivity.ts, Checkpoint
// 6.8B1/6.8B1R) - deliberately a SEPARATE, independently-maintained
// file, never an import of the Functions-side module (this is a
// separate compiled TypeScript project with no shared import path into
// React Native - the same reason tripInvitationId's own formula is
// duplicated between src/services/firebase/tripInvitations.ts and
// functions/src/callables/createTripInvitation.ts).
//
// This collection is fully client-write-closed (every real event is
// written exclusively by a trusted backend transaction) - these types
// exist for READING only.
import type { PersistedTimestamp } from "./common";

export type TripMembershipActivityEventType =
  | "trip_created"
  | "invitation_created"
  | "invitation_accepted"
  | "invitation_declined"
  | "invitation_cancelled"
  | "member_left"
  | "member_removed"
  | "history_tracking_started";

// Base fields every PERSISTED activity document carries, regardless of
// type - deliberately NO `id` here. The Firestore document id is never
// duplicated as a field inside the document's own data; it exists only
// as the DocumentReference/QueryDocumentSnapshot's own `id`, attached
// during hydration (see TripMembershipActivityEvent below).
type TripMembershipActivityDataBase = {
  tripId: string;
  createdAt: PersistedTimestamp;
  schemaVersion: 1;
};

// The approved discriminated union, describing EXACTLY the persisted
// Firestore document data (mirrors the Functions-side
// TripMembershipActivityDocumentData shape field-for-field).
// `invitationId` exists ONLY on the four invitation-related variants;
// `actorUid`/`targetUid` are required non-null strings on every real
// event, and exactly `null` on the system/backfill marker - never a
// human uid standing in for it.
export type TripMembershipActivityDocumentData =
  | (TripMembershipActivityDataBase & {
      type: "trip_created";
      actorUid: string;
      targetUid: string;
    })
  | (TripMembershipActivityDataBase & {
      type: "invitation_created";
      actorUid: string;
      targetUid: string;
      invitationId: string;
    })
  | (TripMembershipActivityDataBase & {
      type: "invitation_accepted";
      actorUid: string;
      targetUid: string;
      invitationId: string;
    })
  | (TripMembershipActivityDataBase & {
      type: "invitation_declined";
      actorUid: string;
      targetUid: string;
      invitationId: string;
    })
  | (TripMembershipActivityDataBase & {
      type: "invitation_cancelled";
      actorUid: string;
      targetUid: string;
      invitationId: string;
    })
  | (TripMembershipActivityDataBase & {
      type: "member_left";
      actorUid: string;
      targetUid: string;
    })
  | (TripMembershipActivityDataBase & {
      type: "member_removed";
      actorUid: string;
      targetUid: string;
    })
  | (TripMembershipActivityDataBase & {
      type: "history_tracking_started";
      actorUid: null;
      targetUid: null;
    });

// Distributes `& {id: string}` over each union member individually - a
// plain intersection with a union type does not do this safely (see
// DistributiveOmit's identical concern on the Functions side); this is
// the mirror-image fix, adding a field instead of removing one.
type WithId<T> = T extends unknown ? T & { id: string } : never;

// The HYDRATED application-level event - everything a persisted
// TripMembershipActivityDocumentData document has, PLUS the Firestore
// document id (`snapshot.id`), attached once by the read service below.
// Never write this shape to Firestore.
export type TripMembershipActivityEvent =
  WithId<TripMembershipActivityDocumentData>;
