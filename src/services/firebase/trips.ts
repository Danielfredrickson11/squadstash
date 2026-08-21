// Firestore queries for the trips a user belongs to. Extracted from
// app/(tabs)/trips/index.tsx. Only the query mechanics move here - the
// primary/fallback ordering, error handling, and console logging stay in
// the screen, since fetchMemberTripsOrdered and fetchMemberTrips are
// meant to be thin, error-propagating building blocks for that logic.
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  type DocumentData,
  where,
} from "firebase/firestore";
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

export async function createTrip(input: {
  title: string;
  location: string | null;
  target: number;
  imageUrl: string;
  ownerId: string;
}): Promise<string> {
  const { title, location, target, imageUrl, ownerId } = input;

  const ref = await addDoc(collection(db, "trips"), {
    title,
    location,
    target,
    saved: 0,

    imageUrl,

    createdAt: serverTimestamp(),
    ownerId,
    memberIds: [ownerId],

    lastUpdatedAt: serverTimestamp(),
    lastUpdatedBy: ownerId,
  });

  return ref.id;
}

export async function fetchTripById(
  tripId: string
): Promise<TripRecord | null> {
  const snap = await getDoc(doc(db, "trips", tripId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...(snap.data() as DocumentData) } as TripRecord;
}

export async function deleteTrip(tripId: string): Promise<void> {
  await deleteDoc(doc(db, "trips", tripId));
}
