// Checkpoint 5A: TripInvitation reads are direct client Firestore access
// (gated by firestore.rules); creation is a trusted callable (server-side
// email-to-uid resolution, mirroring lookupUserByEmail's own pattern -
// never a public Firestore email-query surface); responding to an
// already-issued invitation (accept/decline/cancel) is a direct client
// write, since each is a one-way terminal status transition with zero
// financial consequence (see firestore.rules' own comment on this
// collection for why no callable is needed for that half).
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
import type { PersistedTimestamp, TripInvitation } from "../../types/domain";

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

export async function acceptTripInvitation(
  tripId: string,
  inviteeUid: string
): Promise<void> {
  await updateDoc(doc(db, "tripInvitations", tripInvitationId(tripId, inviteeUid)), {
    status: "accepted",
    respondedAt: serverTimestamp(),
  });
}

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
