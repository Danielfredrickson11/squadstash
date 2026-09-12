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
  updateDoc,
  type DocumentData,
  where,
} from "firebase/firestore";
import { db } from "../../../firebase";
import type {
  CreateTripInput,
  PersistedTimestamp,
  Trip,
} from "../../types/domain";

// Builds a Trip field-by-field instead of spreading the raw document plus
// a single trailing `as Trip` cast on the whole object. Each field keeps
// exactly the value Firestore returned (or undefined if absent) - no
// defaulting, no runtime validation, so behavior for existing documents
// is unchanged. The difference from before is where the "trust me" is
// applied: per-field casts here are checked against Trip's declared
// shape (a missing/mistyped required field like `id` would fail to
// compile), whereas the old whole-object cast suppressed that check
// entirely.
function mapTripDocument(id: string, data: DocumentData): Trip {
  return {
    id,
    title: data.title as string | undefined,
    location: data.location as string | null | undefined,
    target: data.target as number | undefined,
    saved: data.saved as number | undefined,
    imageUrl: data.imageUrl as string | undefined,
    ownerId: data.ownerId as string | undefined,
    memberIds: data.memberIds as string[] | undefined,
    createdAt: data.createdAt as PersistedTimestamp | undefined,
    lastUpdatedAt: data.lastUpdatedAt as PersistedTimestamp | undefined,
    lastUpdatedBy: data.lastUpdatedBy as string | undefined,
    // Checkpoint 3F.3B.2: canonical "YYYY-MM-DD" strings - absent on any
    // trip created before this checkpoint, which is why both stay
    // optional/undefined here rather than defaulted.
    tripStartDate: data.tripStartDate as string | null | undefined,
    tripEndDate: data.tripEndDate as string | null | undefined,
  };
}

export async function fetchMemberTripsOrdered(uid: string): Promise<Trip[]> {
  const q = query(
    collection(db, "trips"),
    where("memberIds", "array-contains", uid),
    orderBy("createdAt", "desc")
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => mapTripDocument(d.id, d.data() as DocumentData));
}

export async function fetchMemberTrips(uid: string): Promise<Trip[]> {
  const q = query(
    collection(db, "trips"),
    where("memberIds", "array-contains", uid)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => mapTripDocument(d.id, d.data() as DocumentData));
}

export async function createTrip(input: CreateTripInput): Promise<string> {
  const { title, location, target, imageUrl, ownerId, tripStartDate, tripEndDate } = input;

  const ref = await addDoc(collection(db, "trips"), {
    title,
    location,
    target,
    saved: 0,

    imageUrl,
    tripStartDate,
    tripEndDate,

    createdAt: serverTimestamp(),
    ownerId,
    memberIds: [ownerId],

    lastUpdatedAt: serverTimestamp(),
    lastUpdatedBy: ownerId,
  });

  return ref.id;
}

export async function fetchTripById(tripId: string): Promise<Trip | null> {
  const snap = await getDoc(doc(db, "trips", tripId));
  if (!snap.exists()) return null;
  return mapTripDocument(snap.id, snap.data() as DocumentData);
}

export async function deleteTrip(tripId: string): Promise<void> {
  await deleteDoc(doc(db, "trips", tripId));
}

// Checkpoint 3F.3B.3: owner-only trip-date edit. Direct client write
// (matching createTrip/deleteTrip's own pattern - Trip has no trusted
// callable at all today), gated by firestore.rules' owner-only update
// allowlist for tripStartDate/tripEndDate. tripStartDate is required
// (cannot be cleared to null once set - a trip with dates cannot revert
// to dateless); tripEndDate may be explicitly cleared via null.
export type UpdateTripDatesInput = {
  tripStartDate: string;
  tripEndDate: string | null;
  lastUpdatedBy: string;
};

export async function updateTripDates(
  tripId: string,
  input: UpdateTripDatesInput
): Promise<void> {
  await updateDoc(doc(db, "trips", tripId), {
    tripStartDate: input.tripStartDate,
    tripEndDate: input.tripEndDate,
    lastUpdatedAt: serverTimestamp(),
    lastUpdatedBy: input.lastUpdatedBy,
  });
}
