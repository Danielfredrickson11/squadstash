// Checkpoint 5A/5C.3C: TripInvitation reads are direct client Firestore
// access (gated by firestore.rules); creation is a trusted callable
// (server-side email-to-uid resolution, mirroring lookupUserByEmail's
// own pattern - never a public Firestore email-query surface).
// Responding to an already-issued invitation is now a MIX, not uniform:
// accepting is the trusted acceptTripInvitation Cloud Function (it now
// grants real Trip membership/financial authority - Checkpoint 5C - so
// firestore.rules permanently closed the old direct-write path, see
// Checkpoint 5C.2); declining and owner-cancellation remain direct
// client writes, unchanged, since each is still a one-way terminal
// status transition with zero financial or membership consequence (see
// firestore.rules' own comment on this collection for why neither needs
// a trusted callable).
import { httpsCallable } from "firebase/functions";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
  type DocumentData,
} from "firebase/firestore";
import { db, functions } from "../../../firebase";
import {
  isPendingTripInvitation,
  isTripInvitationExpired,
} from "../../domain/tripInvitation";
import { assertNoTripCompositeIdDelimiter } from "../../domain/tripCompositeId";
import type {
  PersistedTimestamp,
  TripInvitation,
  TripInvitationPreview,
} from "../../types/domain";

// The entire uniqueness mechanism for "at most one invitation record ever
// exists for a given (tripId, inviteeUid) pair" - mirrors
// functions/src/callables/createTripInvitation.ts's own derivation
// exactly. Kept duplicated (not imported across the client/Functions
// project boundary) the same way createBucket.ts's tripPersonalBucketId
// formula is duplicated on the client - see that file's comment. See
// src/domain/tripCompositeId.ts for why this concatenation is safe.
export function tripInvitationId(tripId: string, inviteeUid: string): string {
  assertNoTripCompositeIdDelimiter(tripId, "tripId");
  assertNoTripCompositeIdDelimiter(inviteeUid, "inviteeUid");
  return `${tripId}_${inviteeUid}`;
}

function mapTripInvitationDocument(
  id: string,
  data: DocumentData
): TripInvitation {
  return {
    id,
    tripId: data.tripId as string,
    inviterUid: data.inviterUid as string,
    inviteeEmail: data.inviteeEmail as string,
    inviteeUid: data.inviteeUid as string,
    status: data.status as TripInvitation["status"],
    createdAt: data.createdAt as PersistedTimestamp,
    expiresAt: data.expiresAt as PersistedTimestamp,
    respondedAt: (data.respondedAt as PersistedTimestamp | null) ?? null,
  };
}

export async function createTripInvitation(
  tripId: string,
  inviteeEmail: string
): Promise<{ invitationId: string; inviteeUid: string }> {
  const callable = httpsCallable<
    { tripId: string; inviteeEmail: string },
    { invitationId: string; inviteeUid: string }
  >(functions, "createTripInvitation");
  const res = await callable({ tripId, inviteeEmail });
  return res.data;
}

export async function fetchInvitationForTrip(
  tripId: string,
  inviteeUid: string
): Promise<TripInvitation | null> {
  const snap = await getDoc(
    doc(db, "tripInvitations", tripInvitationId(tripId, inviteeUid))
  );
  if (!snap.exists()) {
    return null;
  }
  return mapTripInvitationDocument(snap.id, snap.data());
}

// Owner-facing: every invitation record for a given Trip, any status.
export async function fetchInvitationsForTrip(
  tripId: string
): Promise<TripInvitation[]> {
  const q = query(collection(db, "tripInvitations"), where("tripId", "==", tripId));
  const snap = await getDocs(q);
  return snap.docs.map((d) => mapTripInvitationDocument(d.id, d.data()));
}

// Invitee-facing: every invitation addressed to this uid, across all
// Trips, that is still genuinely actionable - "pending" AND not yet
// expired (Checkpoint 5A.1, item 2: an expired "pending" record must
// never be returned here, since firestore.rules itself now refuses to
// let it become "accepted" - returning it as if it were still
// actionable would make this function's name a lie). Filters in JS
// rather than adding a second equality clause to the query, so this
// never needs a new composite index (see the Checkpoint 5A report).
export async function fetchPendingInvitationsForUser(
  inviteeUid: string
): Promise<TripInvitation[]> {
  const q = query(
    collection(db, "tripInvitations"),
    where("inviteeUid", "==", inviteeUid)
  );
  const snap = await getDocs(q);
  const now = new Date();
  return snap.docs
    .map((d) => mapTripInvitationDocument(d.id, d.data()))
    .filter(
      (invitation) =>
        isPendingTripInvitation(invitation) &&
        !isTripInvitationExpired(invitation, now)
    );
}

export type AcceptTripInvitationResult = {
  tripId: string;
};

// Validates the callable's response field-by-field rather than trusting
// a whole-object cast, matching parseCreateTripResponse's (trips.ts) own
// convention. The frozen response contract is exactly {tripId} - an
// unexpected extra top-level key is rejected rather than silently
// ignored (deployment-skew defense: a response carrying more than this
// one key means the deployed Function disagrees with this client about
// the contract, and that disagreement must fail loudly, not pass
// through unnoticed). Unlike parseCreateTripResponse, there is no
// "matches an expected value" cross-check here - this client has no
// independently-known expected tripId to compare the response against
// until the response itself supplies it (frozen docs/audits/
// TRIP_INVITATION_CLIENT_UX_PREFLIGHT_2026-10-18.md §7).
function parseAcceptTripInvitationResponse(
  data: unknown
): AcceptTripInvitationResult {
  if (typeof data !== "object" || data === null) {
    throw new Error(
      "acceptTripInvitation: invalid response (expected an object)."
    );
  }

  const keys = Object.keys(data as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "tripId") {
    throw new Error(
      "acceptTripInvitation: invalid response (expected exactly { tripId })."
    );
  }

  const { tripId } = data as Record<string, unknown>;
  if (typeof tripId !== "string" || tripId.length === 0) {
    throw new Error(
      "acceptTripInvitation: invalid response (tripId must be a non-empty string)."
    );
  }

  return { tripId };
}

// Checkpoint 5C.3C: replaces the former direct-write implementation in
// place (same exported name, same module - never left alongside it
// under a different name, mirroring exactly how createTrip's own client
// wrapper was swapped from a direct write to a trusted callable during
// this same session's 5B.5B checkpoint). Accepting now grants real Trip
// membership/financial authority (Checkpoint 5C), so the request is
// rebuilt field-by-field from exactly these two parameters - never a
// forwarded/spread object - and NEVER includes uid/inviteeUid/tripId/
// ownerId/memberIds/acceptedTermsVersion or any other trusted field; the
// backend derives/trusts all of those exclusively from the authenticated
// caller and its own fresh reads. `acceptedTermsDocId` must be the exact
// id of the TripTerms document the caller actually displayed and
// reviewed before pressing Accept - this is the client half of the
// anti-TOCTOU design (frozen docs/audits/
// TRIP_FINANCIAL_MEMBERSHIP_ACCEPTANCE_PREFLIGHT_2026-10-16.md §10).
// Callable errors (HttpsError/FirebaseError) are NOT caught or wrapped
// here - they propagate to the caller unchanged, matching every other
// trusted-callable wrapper in this file's sibling services (createTrip,
// createBucket). This is required so a caller can inspect
// `error.details.reason === "terms_changed"` intact.
export async function acceptTripInvitation(
  invitationId: string,
  acceptedTermsDocId: string
): Promise<AcceptTripInvitationResult> {
  const callable = httpsCallable<
    { invitationId: string; acceptedTermsDocId: string },
    unknown
  >(functions, "acceptTripInvitation");
  const res = await callable({ invitationId, acceptedTermsDocId });
  return parseAcceptTripInvitationResponse(res.data);
}

const TRIP_INVITATION_PREVIEW_KEYS = [
  "tripId",
  "title",
  "location",
  "imageUrl",
  "tripStartDate",
  "tripEndDate",
] as const;

// Validates the trusted getTripInvitationPreview callable's response
// field-by-field - exactly the six keys the frozen contract allows (see
// src/types/domain/tripInvitation.ts's own TripInvitationPreview
// comment), never a whole-object cast. Malformed callable output is
// never silently defaulted - an unexpected key, a missing key, or a
// wrong-typed field all fail loudly, the same deployment-skew defense
// parseAcceptTripInvitationResponse above uses.
function parseTripInvitationPreviewResponse(
  data: unknown
): TripInvitationPreview {
  if (typeof data !== "object" || data === null) {
    throw new Error(
      "getTripInvitationPreview: invalid response (expected an object)."
    );
  }
  const record = data as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== TRIP_INVITATION_PREVIEW_KEYS.length ||
    !TRIP_INVITATION_PREVIEW_KEYS.every((key) => keys.includes(key))
  ) {
    throw new Error(
      "getTripInvitationPreview: invalid response (unexpected field shape)."
    );
  }

  const { tripId, title, location, imageUrl, tripStartDate, tripEndDate } =
    record;

  if (typeof tripId !== "string" || tripId.length === 0) {
    throw new Error(
      "getTripInvitationPreview: invalid response (tripId must be a " +
        "non-empty string)."
    );
  }
  if (typeof title !== "string") {
    throw new Error(
      "getTripInvitationPreview: invalid response (title must be a string)."
    );
  }
  if (typeof imageUrl !== "string") {
    throw new Error(
      "getTripInvitationPreview: invalid response (imageUrl must be a " +
        "string)."
    );
  }
  if (location !== null && typeof location !== "string") {
    throw new Error(
      "getTripInvitationPreview: invalid response (location must be a " +
        "string or null)."
    );
  }
  if (tripStartDate !== null && typeof tripStartDate !== "string") {
    throw new Error(
      "getTripInvitationPreview: invalid response (tripStartDate must " +
        "be a string or null)."
    );
  }
  if (tripEndDate !== null && typeof tripEndDate !== "string") {
    throw new Error(
      "getTripInvitationPreview: invalid response (tripEndDate must be " +
        "a string or null)."
    );
  }

  return {
    tripId,
    title,
    location: location as string | null,
    imageUrl,
    tripStartDate: tripStartDate as string | null,
    tripEndDate: tripEndDate as string | null,
  };
}

// Checkpoint 5C.3C (new, per the frozen docs/audits/
// TRIP_INVITATION_CLIENT_UX_PREFLIGHT_2026-10-18.md §5): the sole way a
// pending invitee may see ANY Trip context before joining - never a
// direct `trips/{tripId}` read, which firestore.rules correctly denies a
// non-member/non-owner and which would risk exposing financial state
// even if it didn't. The trusted backend derives the safe six-field
// subset fresh on every call; this wrapper never spreads or widens it.
export async function getTripInvitationPreview(
  invitationId: string
): Promise<TripInvitationPreview> {
  const callable = httpsCallable<{ invitationId: string }, unknown>(
    functions,
    "getTripInvitationPreview"
  );
  const res = await callable({ invitationId });
  return parseTripInvitationPreviewResponse(res.data);
}

// Checkpoint 5C.2/5C.3C: declining and owner-cancellation remain direct
// client writes, unchanged - firestore.rules' own `pending -> declined`/
// `pending -> cancelled` clauses were never closed, since neither
// transition ever grants anything (only narrows). Only the
// `pending -> accepted` transition above was moved to the trusted
// callable.
export async function declineTripInvitation(
  tripId: string,
  inviteeUid: string
): Promise<void> {
  await updateDoc(doc(db, "tripInvitations", tripInvitationId(tripId, inviteeUid)), {
    status: "declined",
    respondedAt: serverTimestamp(),
  });
}

export async function cancelTripInvitation(
  tripId: string,
  inviteeUid: string
): Promise<void> {
  await updateDoc(doc(db, "tripInvitations", tripInvitationId(tripId, inviteeUid)), {
    status: "cancelled",
    respondedAt: serverTimestamp(),
  });
}
