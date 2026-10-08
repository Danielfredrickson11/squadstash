// Checkpoint 5A.1: publishing a new TripTerms version is now the
// trusted publishTripTerms callable (server-authoritative version
// assignment, via a tripTermsCurrent/{tripId} pointer document - see
// that callable's own header comment for why a client-computed "max
// version + 1" could never be authoritative). Reads remain direct
// client Firestore access, gated by firestore.rules.
import { httpsCallable } from "firebase/functions";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  type DocumentData,
} from "firebase/firestore";
import { db, functions } from "../../../firebase";
import type { CreateTripTermsInput, PersistedTimestamp, TripTerms } from "../../types/domain";

function mapTripTermsDocument(id: string, data: DocumentData): TripTerms {
  return {
    id,
    tripId: data.tripId as string,
    version: data.version as number,
    createdAt: data.createdAt as PersistedTimestamp,
    createdBy: data.createdBy as string,
    contributionExpectations: data.contributionExpectations as string,
    expenseAllocationExpectations: data.expenseAllocationExpectations as string,
    sharedStashSpendingAuthority: data.sharedStashSpendingAuthority as string,
    withdrawalExpectations: data.withdrawalExpectations as string,
    settlementExpectations: data.settlementExpectations as string,
  };
}

export async function fetchAllTripTermsVersions(
  tripId: string
): Promise<TripTerms[]> {
  const q = query(collection(db, "tripTerms"), where("tripId", "==", tripId));
  const snap = await getDocs(q);
  return snap.docs.map((d) => mapTripTermsDocument(d.id, d.data()));
}

export async function fetchTripTermsById(
  termsDocId: string
): Promise<TripTerms | null> {
  const snap = await getDoc(doc(db, "tripTerms", termsDocId));
  if (!snap.exists()) {
    return null;
  }
  return mapTripTermsDocument(snap.id, snap.data());
}

// Checkpoint 5A.2: thrown by fetchCurrentTripTerms when
// tripTermsCurrent/{tripId} exists but is internally invalid, or
// disagrees with the tripTerms document it names - distinct from the
// one legitimate "this Trip has never had terms" case (no pointer
// document at all), which returns null instead. This is a plain Error,
// not a security boundary (firestore.rules is) - it exists only so a
// caller can't mistake corrupt authoritative state for "no terms yet."
// No repair is ever attempted here.
export class TripTermsCorruptionError extends Error {}

// Reads the server-authoritative tripTermsCurrent/{tripId} pointer
// document, then fetches the exact TripTerms document it names - never
// a client-computed max over fetchAllTripTermsVersions (Checkpoint
// 5A.1). Returns null ONLY when no pointer document exists at all (the
// Trip has never had terms published). If a pointer DOES exist, it is
// trusted authoritative state and must be internally valid and agree
// with its referenced tripTerms document, or this throws
// TripTermsCorruptionError rather than silently returning null or a
// mismatched document.
export async function fetchCurrentTripTerms(
  tripId: string
): Promise<TripTerms | null> {
  const pointerSnap = await getDoc(doc(db, "tripTermsCurrent", tripId));
  if (!pointerSnap.exists()) {
    return null;
  }
  const pointerData = pointerSnap.data();

  if (pointerData.tripId !== tripId) {
    throw new TripTermsCorruptionError(
      `tripTermsCurrent/${tripId} references a different tripId.`
    );
  }
  if (
    !Number.isSafeInteger(pointerData.currentVersion) ||
    (pointerData.currentVersion as number) <= 0
  ) {
    throw new TripTermsCorruptionError(
      `tripTermsCurrent/${tripId} has an invalid currentVersion.`
    );
  }
  if (
    typeof pointerData.currentTermsDocId !== "string" ||
    pointerData.currentTermsDocId.length === 0
  ) {
    throw new TripTermsCorruptionError(
      `tripTermsCurrent/${tripId} has an invalid currentTermsDocId.`
    );
  }

  const terms = await fetchTripTermsById(pointerData.currentTermsDocId);
  if (terms === null) {
    throw new TripTermsCorruptionError(
      `tripTermsCurrent/${tripId} references tripTerms/` +
        `${pointerData.currentTermsDocId}, which does not exist.`
    );
  }
  if (terms.tripId !== tripId) {
    throw new TripTermsCorruptionError(
      `tripTermsCurrent/${tripId} references a tripTerms document ` +
        "belonging to a different Trip."
    );
  }
  if (terms.version !== pointerData.currentVersion) {
    throw new TripTermsCorruptionError(
      `tripTermsCurrent/${tripId}'s currentVersion disagrees with its ` +
        "referenced tripTerms document's own version."
    );
  }

  return terms;
}

export async function publishTripTerms(
  input: CreateTripTermsInput
): Promise<{ id: string; version: number }> {
  const callable = httpsCallable<
    CreateTripTermsInput,
    { termsDocId: string; version: number }
  >(functions, "publishTripTerms");
  const res = await callable(input);
  return { id: res.data.termsDocId, version: res.data.version };
}
