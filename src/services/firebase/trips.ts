// Firestore queries for the trips a user belongs to. Extracted from
// app/(tabs)/trips/index.tsx. Only the query mechanics move here - the
// primary/fallback ordering, error handling, and console logging stay in
// the screen, since fetchMemberTripsOrdered and fetchMemberTrips are
// meant to be thin, error-propagating building blocks for that logic.
import {
  addDoc,
  collection,
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
    // Checkpoint 4B.5B: no fabricated default - a legacy document with
    // no archivedAt/archivedBy key maps to undefined for each, exactly
    // matching every other optional field this mapper already handles.
    // This is the ONE place a raw Firestore document becomes a Trip
    // object for fetchMemberTripsOrdered/fetchMemberTrips/fetchTripById -
    // without mapping these two fields here, nothing built on top of
    // them (active/archived partitioning, the archived Trip Detail
    // state) would ever see real persisted data.
    archivedAt: data.archivedAt as PersistedTimestamp | null | undefined,
    archivedBy: data.archivedBy as string | null | undefined,
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

// Checkpoint 4B.5B: replaces the removed deleteTrip - per the approved
// archive-delete-safety preflight, a Trip is never client-hard-deletable
// (firestore.rules' `allow delete` is now unconditionally `false`).
// "Delete Trip" is archiving instead: a one-way, owner-only field update.
// A direct client write (not a Cloud Function - archive metadata is
// non-financial and fully expressible/enforceable by Firestore Rules
// alone, the same reasoning already applied to updateTripDates below).
// There is no corresponding "unarchive" - the Rules design makes that
// transition structurally impossible until a future checkpoint
// deliberately adds it.
export async function archiveTrip(tripId: string, uid: string): Promise<void> {
  await updateDoc(doc(db, "trips", tripId), {
    archivedAt: serverTimestamp(),
    archivedBy: uid,
  });
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
