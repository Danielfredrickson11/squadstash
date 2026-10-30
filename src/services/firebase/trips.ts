// Firestore queries for the trips a user belongs to. Extracted from
// app/(tabs)/trips/index.tsx. Only the query mechanics move here - the
// primary/fallback ordering, error handling, and console logging stay in
// the screen, since fetchMemberTripsOrdered and fetchMemberTrips are
// meant to be thin, error-propagating building blocks for that logic.
import {
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
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../../../firebase";
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

// Generates a clientRequestId locally, with no network call and no
// document actually created - reads the id off a Firestore
// DocumentReference built by the client SDK's own auto-id generator,
// matching generateBucketClientRequestId's (buckets.ts) identical
// convention. This id becomes the Trip's own document id - see
// createTrip below.
export function generateTripClientRequestId(): string {
  return doc(collection(db, "trips")).id;
}

export type CreateTripResult = {
  tripId: string;
};

// Validates the callable's response field-by-field rather than trusting
// a whole-object cast, matching parseCreateBucketResponse's (buckets.ts)
// convention. The frozen response contract is exactly {tripId} - an
// unexpected extra top-level key is rejected rather than silently
// ignored (deployment-skew defense: a response carrying more than this
// one key means the deployed Function disagrees with this client about
// the contract, and that disagreement must fail loudly, not pass
// through unnoticed). Checking tripId === the submitted clientRequestId
// is a second, independent deployment-skew defense: this id scheme ties
// the two together by construction (see createTrip below), so any
// mismatch means the deployed Function did not honor the contract this
// client expects.
function parseCreateTripResponse(
  data: unknown,
  expectedTripId: string
): CreateTripResult {
  if (typeof data !== "object" || data === null) {
    throw new Error(
      "createTrip: invalid response (expected an object)."
    );
  }

  const keys = Object.keys(data as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "tripId") {
    throw new Error(
      "createTrip: invalid response (expected exactly { tripId })."
    );
  }

  const { tripId } = data as Record<string, unknown>;
  if (typeof tripId !== "string" || tripId.length === 0) {
    throw new Error(
      "createTrip: invalid response (tripId must be a non-empty string)."
    );
  }
  if (tripId !== expectedTripId) {
    throw new Error(
      "createTrip: invalid response (tripId did not match the submitted " +
        "clientRequestId - the deployed createTrip function may be out " +
        "of date; this request did not succeed)."
    );
  }

  return { tripId };
}

// Invokes the trusted createTrip Cloud Function via httpsCallable
// (Checkpoint 5B.5A/5B.5B) - no direct Firestore write occurs here.
// ownerId/memberIds/ledger/currency/ownership-model/creation-metadata
// fields are never sent - the backend derives/trusts all of them
// exclusively from the authenticated caller. The request is rebuilt
// field-by-field from `input` (never spread/forwarded as-is) so exactly
// these seven keys are ever sent, regardless of what else `input`'s
// static type might structurally tolerate. Callable errors
// (HttpsError/FirebaseError) are not caught or wrapped - they propagate
// to the caller unchanged, matching every other trusted-callable wrapper
// in this file's sibling services (createBucket, recordSavingsTransaction).
export async function createTrip(
  input: CreateTripInput
): Promise<CreateTripResult> {
  const callable = httpsCallable<CreateTripInput, unknown>(
    functions,
    "createTrip"
  );
  const res = await callable({
    clientRequestId: input.clientRequestId,
    title: input.title,
    location: input.location,
    target: input.target,
    imageUrl: input.imageUrl,
    tripStartDate: input.tripStartDate,
    tripEndDate: input.tripEndDate,
  });

  return parseCreateTripResponse(res.data, input.clientRequestId);
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

// Checkpoint 3F.3B.3: owner-only trip-date edit. Unlike Trip creation
// (now the trusted createTrip Cloud Function - Checkpoint 5B.5A/5B.5B),
// this remains a direct client write - date edits are non-financial
// metadata that firestore.rules' owner-only update allowlist for
// tripStartDate/tripEndDate can fully express and enforce on its own, the
// same reasoning already applied to archiveTrip above. tripStartDate is required
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

// ---------------------------------------------------------------------
// Member departure (Checkpoint 6.7C) - thin httpsCallable wrappers over
// the trusted leaveTrip/removeTripMember Cloud Functions (Checkpoint
// 6.7B1). No direct Firestore write of any kind: memberIds is never
// mutated client-side, and tripMembershipDepartures is never read or
// written from the client at all (it is fully Rules-closed - see
// firestore.rules). Matches createTrip's own convention exactly: the
// request is rebuilt field-by-field (never a spread), the response is
// validated field-by-field rather than trusted via a whole-object cast,
// and callable errors (HttpsError/FirebaseError) are never caught or
// wrapped here - they propagate to the caller unchanged.
// ---------------------------------------------------------------------

export type LeaveTripResult = {
  tripId: string;
  uid: string;
  departureType: "left";
};

function parseLeaveTripResponse(data: unknown): LeaveTripResult {
  if (typeof data !== "object" || data === null) {
    throw new Error("leaveTrip: invalid response (expected an object).");
  }
  const { tripId, uid, departureType } = data as Record<string, unknown>;
  if (typeof tripId !== "string" || tripId.length === 0) {
    throw new Error(
      "leaveTrip: invalid response (tripId must be a non-empty string)."
    );
  }
  if (typeof uid !== "string" || uid.length === 0) {
    throw new Error(
      "leaveTrip: invalid response (uid must be a non-empty string)."
    );
  }
  if (departureType !== "left") {
    throw new Error(
      'leaveTrip: invalid response (departureType must be "left").'
    );
  }
  return { tripId, uid, departureType };
}

export async function leaveTrip(tripId: string): Promise<LeaveTripResult> {
  const callable = httpsCallable<{ tripId: string }, unknown>(
    functions,
    "leaveTrip"
  );
  const res = await callable({ tripId });
  return parseLeaveTripResponse(res.data);
}

export type RemoveTripMemberResult = {
  tripId: string;
  uid: string;
  departureType: "removed";
};

function parseRemoveTripMemberResponse(data: unknown): RemoveTripMemberResult {
  if (typeof data !== "object" || data === null) {
    throw new Error("removeTripMember: invalid response (expected an object).");
  }
  const { tripId, uid, departureType } = data as Record<string, unknown>;
  if (typeof tripId !== "string" || tripId.length === 0) {
    throw new Error(
      "removeTripMember: invalid response (tripId must be a non-empty string)."
    );
  }
  if (typeof uid !== "string" || uid.length === 0) {
    throw new Error(
      "removeTripMember: invalid response (uid must be a non-empty string)."
    );
  }
  if (departureType !== "removed") {
    throw new Error(
      'removeTripMember: invalid response (departureType must be "removed").'
    );
  }
  return { tripId, uid, departureType };
}

export async function removeTripMember(
  tripId: string,
  targetUid: string
): Promise<RemoveTripMemberResult> {
  const callable = httpsCallable<{ tripId: string; targetUid: string }, unknown>(
    functions,
    "removeTripMember"
  );
  const res = await callable({ tripId, targetUid });
  return parseRemoveTripMemberResponse(res.data);
}
