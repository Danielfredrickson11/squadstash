// Checkpoint 6.8B1: pure domain primitives for Trip membership activity
// history - the discriminated-union event shape, the deterministic
// per-event-type activity-document id, and a pure write-payload builder
// per event type. No Firestore access in this file (mirrors
// tripMembershipDeparture.ts's own identical convention) - the trusted
// callable that performs each write (createTripCore,
// createTripInvitationCore, acceptTripInvitationCore,
// tripMembershipDepartureCore, declineTripInvitationCore,
// cancelTripInvitationCore) attaches `createdAt: FieldValue.
// serverTimestamp()` itself at the actual `tx.create` call site - this
// file never calls FieldValue directly.
//
// Frozen architecture (6.8A through 6.8A4): a dedicated top-level
// `tripMembershipActivity` collection, immutable (append-only,
// `tx.create`-enforced by every caller), written atomically inside the
// SAME transaction as the authoritative mutation it twins - never by a
// separate trigger. Every activity-document id is DETERMINISTIC,
// "{eventType}:{authoritativeId}", where authoritativeId reuses the
// EXISTING authoritative composite-id formula for whichever record the
// event twins (tripInvitationId/tripMembershipAcceptanceId/
// tripMembershipDepartureId) rather than independently rebuilding it -
// this file never invents a new id formula where an existing one
// already exists, and inherits each one's own delimiter-safety
// (assertNoDelimiter) for free. No event id is ever random. Across the
// eight event-type prefixes below, no prefix is ever a prefix of
// another - so two different event types can never collide on the same
// activity id regardless of what their own authoritativeId happens to
// contain; a collision within the SAME event type is exactly what each
// reused composite-id formula's own existing delimiter guard already
// prevents.
import {HttpsError} from "firebase-functions/v2/https";
import {
  tripInvitationId,
  tripMembershipAcceptanceId,
} from "./tripCompositeId";
import {tripMembershipDepartureId} from "./tripMembershipDeparture";
import type {DepartureType} from "./tripMembershipDeparture";

export type TripMembershipActivityEventType =
  | "trip_created"
  | "invitation_created"
  | "invitation_accepted"
  | "invitation_declined"
  | "invitation_cancelled"
  | "member_left"
  | "member_removed"
  | "history_tracking_started";

const REAL_EVENT_TYPES: ReadonlySet<TripMembershipActivityEventType> =
  new Set([
    "trip_created",
    "invitation_created",
    "invitation_accepted",
    "invitation_declined",
    "invitation_cancelled",
    "member_left",
    "member_removed",
  ]);

const INVITATION_EVENT_TYPES: ReadonlySet<TripMembershipActivityEventType> =
  new Set([
    "invitation_created",
    "invitation_accepted",
    "invitation_declined",
    "invitation_cancelled",
  ]);

// Base fields every PERSISTED activity document carries, regardless of
// type - deliberately NO `id` here. The Firestore document id is never
// duplicated as a field inside the document's own data (the deterministic
// id lives solely as the DocumentReference's id, "{eventType}:
// {authoritativeId}" - see the builders below) - a prior version of this
// file incorrectly included `id` in the persisted shape, which this
// checkpoint (6.8B1R) corrects. `createdAt` is always a real Timestamp by
// the time anything reads a genuine document back (the trusted writer
// always sets it via FieldValue.serverTimestamp() at write time) - typed
// `unknown` here, matching TripMembershipDeparture's own identical
// `departedAt` convention, so this file never needs to import the Admin
// SDK's Timestamp type merely to describe the shape.
type TripMembershipActivityDataBase = {
  tripId: string;
  createdAt: unknown;
  schemaVersion: 1;
};

// The approved discriminated union (6.8A2 §5/6.8A4/6.8B1R), describing
// EXACTLY the persisted Firestore document data - required/optional
// fields are expressed structurally per variant, never as one shared
// shape with loosely-optional properties. `invitationId` exists ONLY on
// the four invitation-related variants; `actorUid`/`targetUid` are
// required non-null strings on every real event, and exactly `null` on
// the system/backfill marker - never a human uid standing in for it.
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

// Distributes `& {id: string}` over each union member individually
// (see DistributiveOmit below for why a naive intersection with a union
// does NOT do this safely on its own - the same distribution hazard,
// mirrored in the opposite direction). This is how a HYDRATED
// application-level event (this module's `TripMembershipActivityEvent`)
// is derived from the persisted shape: the Firestore document id,
// attached by whatever reads the document back, never stored as a field.
type WithId<T> = T extends unknown ? T & {id: string} : never;

// The HYDRATED application-level event - everything a persisted
// TripMembershipActivityDocumentData document has, PLUS the Firestore
// document id the client-read layer attaches once it reads the document
// back (6.8B2, not yet implemented). Never write this shape directly to
// Firestore - only `TripMembershipActivityDocumentData` (via
// TripMembershipActivityWrite, below) is ever persisted.
export type TripMembershipActivityEvent =
  WithId<TripMembershipActivityDocumentData>;

/**
 * Fails closed unless `tripId` is a non-empty string - the shared guard
 * for the two activity-id builders below that key off a bare tripId
 * with no other composite-id helper to delegate to.
 * @param {string} tripId The candidate Trip document id.
 * @return {void}
 */
function assertNonEmptyTripId(tripId: string): void {
  if (tripId.length === 0) {
    throw new HttpsError(
      "invalid-argument",
      "tripId must be a non-empty string."
    );
  }
}

/**
 * Deterministic `trip_created` activity document id.
 * @param {string} tripId The Trip's document id.
 * @return {string} The deterministic activity document id.
 */
export function tripCreatedActivityId(tripId: string): string {
  assertNonEmptyTripId(tripId);
  return `trip_created:${tripId}`;
}

/**
 * Deterministic `invitation_created` activity document id - reuses
 * tripInvitationId verbatim rather than rebuilding its formula.
 * @param {string} tripId The Trip's document id.
 * @param {string} inviteeUid The invited uid.
 * @return {string} The deterministic activity document id.
 */
export function invitationCreatedActivityId(
  tripId: string,
  inviteeUid: string
): string {
  return `invitation_created:${tripInvitationId(tripId, inviteeUid)}`;
}

/**
 * Deterministic `invitation_accepted` activity document id - reuses
 * tripMembershipAcceptanceId verbatim (keyed by the exact terms version
 * accepted, matching tripMembershipAcceptances' own id scheme) rather
 * than rebuilding its formula.
 * @param {string} tripId The Trip's document id.
 * @param {string} uid The accepting uid.
 * @param {string} termsDocId The exact tripTerms document accepted.
 * @return {string} The deterministic activity document id.
 */
export function invitationAcceptedActivityId(
  tripId: string,
  uid: string,
  termsDocId: string
): string {
  return (
    `invitation_accepted:${tripMembershipAcceptanceId(tripId, uid, termsDocId)}`
  );
}

/**
 * Deterministic `invitation_declined` activity document id - reuses
 * tripInvitationId verbatim. At most one decline can ever occur per
 * (tripId, inviteeUid) pair (invitations are terminal once resolved and
 * re-invite is not supported - 6.8A2 §2), so this id is safe as a
 * lifetime-unique key under the current invitation model.
 * @param {string} tripId The Trip's document id.
 * @param {string} inviteeUid The declining uid.
 * @return {string} The deterministic activity document id.
 */
export function invitationDeclinedActivityId(
  tripId: string,
  inviteeUid: string
): string {
  return `invitation_declined:${tripInvitationId(tripId, inviteeUid)}`;
}

/**
 * Deterministic `invitation_cancelled` activity document id - reuses
 * tripInvitationId verbatim. Same lifetime-uniqueness reasoning as
 * invitationDeclinedActivityId above.
 * @param {string} tripId The Trip's document id.
 * @param {string} inviteeUid The invitee whose invitation was cancelled.
 * @return {string} The deterministic activity document id.
 */
export function invitationCancelledActivityId(
  tripId: string,
  inviteeUid: string
): string {
  return `invitation_cancelled:${tripInvitationId(tripId, inviteeUid)}`;
}

/**
 * Deterministic `member_left` activity document id - reuses
 * tripMembershipDepartureId verbatim.
 * @param {string} tripId The Trip's document id.
 * @param {string} uid The departing uid.
 * @return {string} The deterministic activity document id.
 */
export function memberLeftActivityId(tripId: string, uid: string): string {
  return `member_left:${tripMembershipDepartureId(tripId, uid)}`;
}

/**
 * Deterministic `member_removed` activity document id - reuses
 * tripMembershipDepartureId verbatim.
 * @param {string} tripId The Trip's document id.
 * @param {string} uid The removed uid.
 * @return {string} The deterministic activity document id.
 */
export function memberRemovedActivityId(tripId: string, uid: string): string {
  return `member_removed:${tripMembershipDepartureId(tripId, uid)}`;
}

/**
 * Deterministic `history_tracking_started` activity document id - the
 * backfill-only system marker (6.8A4). Not written by anything in this
 * checkpoint (backfill execution is explicitly out of scope), but
 * implemented alongside the other seven for completeness per the
 * approved schema.
 * @param {string} tripId The Trip's document id.
 * @return {string} The deterministic activity document id.
 */
export function historyTrackingStartedActivityId(tripId: string): string {
  assertNonEmptyTripId(tripId);
  return `history_tracking_started:${tripId}`;
}

// Plain `Omit` collapses a discriminated union down to only its common
// keys (keyof a union is the INTERSECTION of each member's keys) - that
// would silently erase `invitationId`'s own per-variant presence below.
// This distributes Omit over each union member individually instead,
// preserving the exact per-variant shape.
type DistributiveOmit<T, K extends keyof never> = T extends unknown ?
  Omit<T, K> :
  never;

// A write-ready {id, data} pair, derived from the PERSISTED
// TripMembershipActivityDocumentData shape (never from the hydrated
// TripMembershipActivityEvent, which carries an `id` field that must
// never appear inside Firestore's own document data - 6.8B1R). `data`
// excludes only `createdAt` (the caller attaches
// FieldValue.serverTimestamp() itself at the tx.create call site,
// keeping this file Firestore-free); `id` is split out separately, since
// the caller needs it to build the DocumentReference, never to write it
// as a field.
export type TripMembershipActivityWrite = {
  id: string;
  data: DistributiveOmit<TripMembershipActivityDocumentData, "createdAt">;
};

/**
 * Builds the write-ready `trip_created` activity event.
 * @param {string} tripId The Trip's document id.
 * @param {string} ownerId The Trip's owner uid.
 * @return {TripMembershipActivityWrite} The write-ready activity event.
 */
export function buildTripCreatedActivity(
  tripId: string,
  ownerId: string
): TripMembershipActivityWrite {
  return {
    id: tripCreatedActivityId(tripId),
    data: {
      tripId,
      type: "trip_created",
      actorUid: ownerId,
      targetUid: ownerId,
      schemaVersion: 1,
    },
  };
}

/**
 * Builds the write-ready `invitation_created` activity event.
 * @param {string} tripId The Trip's document id.
 * @param {string} inviterUid The inviting uid (the Trip owner).
 * @param {string} inviteeUid The invited uid.
 * @return {TripMembershipActivityWrite} The write-ready activity event.
 */
export function buildInvitationCreatedActivity(
  tripId: string,
  inviterUid: string,
  inviteeUid: string
): TripMembershipActivityWrite {
  return {
    id: invitationCreatedActivityId(tripId, inviteeUid),
    data: {
      tripId,
      type: "invitation_created",
      actorUid: inviterUid,
      targetUid: inviteeUid,
      invitationId: tripInvitationId(tripId, inviteeUid),
      schemaVersion: 1,
    },
  };
}

/**
 * Builds the write-ready `invitation_accepted` activity event.
 * @param {string} tripId The Trip's document id.
 * @param {string} uid The accepting uid.
 * @param {string} termsDocId The exact tripTerms document accepted.
 * @return {TripMembershipActivityWrite} The write-ready activity event.
 */
export function buildInvitationAcceptedActivity(
  tripId: string,
  uid: string,
  termsDocId: string
): TripMembershipActivityWrite {
  return {
    id: invitationAcceptedActivityId(tripId, uid, termsDocId),
    data: {
      tripId,
      type: "invitation_accepted",
      actorUid: uid,
      targetUid: uid,
      invitationId: tripInvitationId(tripId, uid),
      schemaVersion: 1,
    },
  };
}

/**
 * Builds the write-ready `invitation_declined` activity event.
 * @param {string} tripId The Trip's document id.
 * @param {string} inviteeUid The declining uid.
 * @return {TripMembershipActivityWrite} The write-ready activity event.
 */
export function buildInvitationDeclinedActivity(
  tripId: string,
  inviteeUid: string
): TripMembershipActivityWrite {
  return {
    id: invitationDeclinedActivityId(tripId, inviteeUid),
    data: {
      tripId,
      type: "invitation_declined",
      actorUid: inviteeUid,
      targetUid: inviteeUid,
      invitationId: tripInvitationId(tripId, inviteeUid),
      schemaVersion: 1,
    },
  };
}

/**
 * Builds the write-ready `invitation_cancelled` activity event.
 * @param {string} tripId The Trip's document id.
 * @param {string} ownerUid The Trip owner cancelling the invitation.
 * @param {string} inviteeUid The invitee whose invitation is cancelled.
 * @return {TripMembershipActivityWrite} The write-ready activity event.
 */
export function buildInvitationCancelledActivity(
  tripId: string,
  ownerUid: string,
  inviteeUid: string
): TripMembershipActivityWrite {
  return {
    id: invitationCancelledActivityId(tripId, inviteeUid),
    data: {
      tripId,
      type: "invitation_cancelled",
      actorUid: ownerUid,
      targetUid: inviteeUid,
      invitationId: tripInvitationId(tripId, inviteeUid),
      schemaVersion: 1,
    },
  };
}

/**
 * Builds the write-ready `member_left`/`member_removed` activity
 * event - a single shared builder for both, mirroring
 * tripMembershipDepartureCore.ts's own shared-transaction-core
 * convention for leave/remove. `departedByUid`/`uid` are exactly the
 * same two facts executeTripMembershipDeparture already derives before
 * writing its own tripMembershipDepartures record - never
 * re-authorized or re-derived here.
 * @param {string} tripId The Trip's document id.
 * @param {DepartureType} departureType `"left"` or `"removed"`.
 * @param {string} departedByUid Who performed the departure (the
 *   departing uid itself for "left"; the Trip owner for "removed").
 * @param {string} uid The departing/removed uid (the subject).
 * @return {TripMembershipActivityWrite} The write-ready activity event.
 */
export function buildMemberDepartureActivity(
  tripId: string,
  departureType: DepartureType,
  departedByUid: string,
  uid: string
): TripMembershipActivityWrite {
  // 6.8B1R defensive review: `DepartureType` is a closed two-value
  // union, and this function's only caller
  // (tripMembershipDepartureCore.ts) derives departureType from its own
  // request.kind discriminant - never from untrusted/Firestore-read
  // data - so TypeScript's own type checker already rejects any value
  // outside "left"/"removed" at every call site, without an unsafe
  // cast. Even so, an explicit else-if + fail-closed branch (rather than
  // a silent `else` defaulting to "removed") costs nothing and removes
  // any reliance on that invariant holding forever - matching this
  // codebase's own pervasive "never assume, fail closed" discipline
  // (e.g. isWellFormedDepartureMatchCandidate's own explicit
  // departureType check against Firestore-read data).
  if (departureType === "left") {
    return {
      id: memberLeftActivityId(tripId, uid),
      data: {
        tripId,
        type: "member_left",
        actorUid: uid,
        targetUid: uid,
        schemaVersion: 1,
      },
    };
  }
  if (departureType === "removed") {
    return {
      id: memberRemovedActivityId(tripId, uid),
      data: {
        tripId,
        type: "member_removed",
        actorUid: departedByUid,
        targetUid: uid,
        schemaVersion: 1,
      },
    };
  }
  throw new HttpsError(
    "internal",
    `Unrecognized departureType "${String(departureType)}" - refusing to ` +
      "build an ambiguous membership-activity event."
  );
}

/**
 * Builds the write-ready `history_tracking_started` activity event -
 * the backfill-only system marker. Never attributes a system event to
 * a human uid merely to satisfy a required field (6.8A2 §4):
 * actorUid/targetUid are exactly `null`. Not invoked by anything in
 * this checkpoint.
 * @param {string} tripId The Trip's document id.
 * @return {TripMembershipActivityWrite} The write-ready activity event.
 */
export function buildHistoryTrackingStartedActivity(
  tripId: string
): TripMembershipActivityWrite {
  return {
    id: historyTrackingStartedActivityId(tripId),
    data: {
      tripId,
      type: "history_tracking_started",
      actorUid: null,
      targetUid: null,
      schemaVersion: 1,
    },
  };
}

/**
 * True if `value` has the well-formed shape of a PERSISTED
 * TripMembershipActivityDocumentData document, as `snapshot.data()`
 * actually returns it - mirrors isWellFormedDepartureMatchCandidate's
 * own "never trust a document's mere existence as proof of its content"
 * discipline. Deliberately does NOT require (or even look for) an `id`
 * field - a persisted document never has one (6.8B1R; the Firestore
 * document id lives solely as the DocumentReference's id, never
 * duplicated inside the data). Requires `createdAt` to be PRESENT (a
 * genuine write always sets it), but does not validate its own type -
 * kept Firestore-Timestamp-free, matching this file's no-Admin-SDK-
 * import convention.
 * @param {unknown} value The candidate value, as read back from
 *   Firestore via `snapshot.data()`.
 * @return {boolean} True if value is a well-formed persisted document.
 */
export function isWellFormedTripMembershipActivityDocumentData(
  value: unknown
): value is TripMembershipActivityDocumentData {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;

  if (typeof v.tripId !== "string" || v.tripId.length === 0) {
    return false;
  }
  const isKnownType =
    typeof v.type === "string" &&
    (REAL_EVENT_TYPES.has(v.type as TripMembershipActivityEventType) ||
      v.type === "history_tracking_started");
  if (!isKnownType) {
    return false;
  }
  if (v.schemaVersion !== 1) {
    return false;
  }
  if (!("createdAt" in v)) {
    return false;
  }

  const type = v.type as TripMembershipActivityEventType;
  const hasInvitationId =
    typeof v.invitationId === "string" && v.invitationId.length > 0;
  if (INVITATION_EVENT_TYPES.has(type)) {
    if (!hasInvitationId) {
      return false;
    }
  } else if ("invitationId" in v) {
    return false;
  }

  if (type === "history_tracking_started") {
    return v.actorUid === null && v.targetUid === null;
  }
  return (
    typeof v.actorUid === "string" &&
    v.actorUid.length > 0 &&
    typeof v.targetUid === "string" &&
    v.targetUid.length > 0
  );
}

/**
 * True if `value` has the well-formed shape of a HYDRATED
 * TripMembershipActivityEvent - everything
 * isWellFormedTripMembershipActivityDocumentData requires, PLUS a
 * non-empty `id` (the Firestore document id, attached by whichever
 * client-read layer hydrates the persisted document - 6.8B2, not yet
 * implemented). Never satisfied by raw `snapshot.data()` alone, which
 * never carries `id` as a field.
 * @param {unknown} value The candidate hydrated value.
 * @return {boolean} True if value is a well-formed hydrated event.
 */
export function isWellFormedTripMembershipActivityEvent(
  value: unknown
): value is TripMembershipActivityEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || v.id.length === 0) {
    return false;
  }
  return isWellFormedTripMembershipActivityDocumentData(value);
}
