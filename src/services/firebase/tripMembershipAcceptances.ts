// Checkpoint 5C.2/5C.3C: this module is READ-ONLY. Direct client
// creation of a tripMembershipAcceptances record was closed permanently
// by Checkpoint 5C.2 (firestore.rules: `allow create, update, delete:
// if false;`) - acceptance evidence is now created EXCLUSIVELY by the
// trusted acceptTripInvitationCore transaction (functions/src/callables/
// acceptTripInvitation.ts, Admin SDK, bypasses these Rules entirely),
// atomically alongside flipping the invitation to "accepted" and adding
// the accepting uid to trips.memberIds. There is no client write path
// left in this file, and none should ever be added back - see
// firestore.rules' own comment on this collection for why the old
// direct-create path became a genuine bypass once acceptance started
// granting real Trip membership (Checkpoint 5C).
//
// FROZEN INVARIANT (unchanged since the 5A/5.0A preflight, restated for
// 5C): an acceptance record is proof of *how* a member joined, never a
// second authorization source. `trips.memberIds` remains the sole
// runtime financial-authorization authority every trusted financial
// callable already consults - reading this collection (below) never
// implies, grants, or substitutes for membership.
import {
  collection,
  getDocs,
  query,
  where,
  type DocumentData,
} from "firebase/firestore";
import { db } from "../../../firebase";
import type { PersistedTimestamp, TripMembershipAcceptance } from "../../types/domain";

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
