// Checkpoint 5A: direct client reads/writes for the TripMembershipAcceptance
// architecture, gated entirely by firestore.rules (self-only create,
// requires an existing tripInvitations record plus a real tripTerms
// document to reference; unconditional update/delete: if false). No
// trusted callable is needed - see firestore.rules' own comment on this
// collection.
//
// FROZEN INVARIANT (preflight §5, amendment 5.0A): creating one of these
// records proves terms acceptance only - it has zero effect on
// `trips.memberIds` or any trusted financial callable's authorization
// decision. Nothing in this file writes to, or reads for the purpose of
// granting, Trip financial authorization.
import {
  collection,
  doc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
  type DocumentData,
} from "firebase/firestore";
import { db } from "../../../firebase";
import { assertNoTripCompositeIdDelimiter } from "../../domain/tripCompositeId";
import type { PersistedTimestamp, TripMembershipAcceptance } from "../../types/domain";

// Mirrors firestore.rules' own `acceptanceId ==` check exactly - the
// entire uniqueness mechanism for "at most one acceptance record per
// (tripId, uid, termsDocId) tuple." See src/domain/tripCompositeId.ts
// for why this concatenation is safe.
export function tripMembershipAcceptanceId(
  tripId: string,
  uid: string,
  termsDocId: string
): string {
  assertNoTripCompositeIdDelimiter(tripId, "tripId");
  assertNoTripCompositeIdDelimiter(uid, "uid");
  assertNoTripCompositeIdDelimiter(termsDocId, "termsDocId");
  return `${tripId}_${uid}_${termsDocId}`;
}

function mapTripMembershipAcceptanceDocument(
  id: string,
  data: DocumentData
): TripMembershipAcceptance {
  return {
    id,
    tripId: data.tripId as string,
    uid: data.uid as string,
    termsDocId: data.termsDocId as string,
    acceptedTermsVersion: data.acceptedTermsVersion as number,
    acceptedAt: data.acceptedAt as PersistedTimestamp,
  };
}

export async function acceptTripTerms(
  tripId: string,
  uid: string,
  termsDocId: string,
  acceptedTermsVersion: number
): Promise<void> {
  const id = tripMembershipAcceptanceId(tripId, uid, termsDocId);
  await setDoc(doc(db, "tripMembershipAcceptances", id), {
    tripId,
    uid,
    termsDocId,
    acceptedTermsVersion,
    acceptedAt: serverTimestamp(),
  });
}

export async function fetchTripMembershipAcceptances(
  tripId: string,
  uid: string
): Promise<TripMembershipAcceptance[]> {
  const q = query(
    collection(db, "tripMembershipAcceptances"),
    where("tripId", "==", tripId),
    where("uid", "==", uid)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) =>
    mapTripMembershipAcceptanceDocument(d.id, d.data())
  );
}
