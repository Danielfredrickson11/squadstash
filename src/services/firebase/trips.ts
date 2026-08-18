// Firestore queries for the trips a user belongs to. Extracted from
// app/(tabs)/trips/index.tsx. Only the query mechanics move here - the
// primary/fallback ordering, error handling, and console logging stay in
// the screen, since fetchMemberTripsOrdered and fetchMemberTrips are
// meant to be thin, error-propagating building blocks for that logic.
import { collection, getDocs, orderBy, query, where } from "firebase/firestore";
import type { DocumentData } from "firebase/firestore";
import { db } from "../../../firebase";

export type TripRecord = {
  id: string;
  title?: string;
  location?: string;
  target?: number;
  saved?: number;
  ownerId?: string;
  memberIds?: string[];
  imageUrl?: string;
  createdAt?: unknown;
};

export async function fetchMemberTripsOrdered(
  uid: string
): Promise<TripRecord[]> {
  const q = query(
    collection(db, "trips"),
    where("memberIds", "array-contains", uid),
    orderBy("createdAt", "desc")
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({
    id: d.id,
    ...(d.data() as DocumentData),
  })) as TripRecord[];
}

export async function fetchMemberTrips(uid: string): Promise<TripRecord[]> {
  const q = query(
    collection(db, "trips"),
    where("memberIds", "array-contains", uid)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({
    id: d.id,
    ...(d.data() as DocumentData),
  })) as TripRecord[];
}
