// Real-time subscription to the buckets a user belongs to. Extracted from
// app/(tabs)/buckets.tsx and app/(tabs)/home.tsx, which both queried the
// same buckets collection the same way. Only the query/subscription
// mechanics move here - each screen keeps applying its own field
// defaults (e.g. how a missing bucket name is displayed) and its own
// error-handling behavior, since those differ between the two screens
// today. See Milestone 1D checkpoint 4A notes for the comparison.
//
// createBucket / updateBucket / deleteBucket are thin wrappers around the
// writes previously inline in app/(tabs)/buckets.tsx. Ownership/
// permission decisions and payload construction stay in the screen -
// these only execute what the screen has already decided to write.
//
// Existing Bucket balance changes (after creation) now go through the
// trusted recordSavingsTransaction Cloud Function (see
// src/services/firebase/savingsTransactions.ts), not this file:
// updateBucketBalance was removed (Milestone 2B Checkpoint 4D), and
// updateBucket()'s input type (Checkpoint 4D hardening) cannot accept
// balance/ledgerBalanceMinor/ledgerOpeningBalanceMinor or any other
// financial cache field - see UpdateBucketInput below.
//
// createBucket (Milestone 2B Checkpoint 4G-2) no longer writes directly
// to Firestore either: it invokes the trusted createBucket Cloud
// Function (see functions/src/callables/createBucket.ts), which derives
// ownerId/memberIds and backend-manages balance/ledgerOpeningBalanceMinor/
// ledgerBalanceMinor/currency/bucketType - none of those are client
// inputs any more. Firestore rules still permit a hardened legacy direct
// create (Checkpoint 4F) temporarily, but no app code exercises that path
// after this checkpoint; closing it is a separate future checkpoint.
import {
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import type { DocumentData, Unsubscribe } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../../../firebase";
import { getCurrentUser } from "./auth";
import { tripPersonalBucketId } from "../../domain/tripPersonalFund";
import type { Bucket, BucketType, CreateBucketInput } from "../../types/domain";

// Shared field-by-field mapper (Checkpoint 3F.3B.4) so
// subscribeToUserBuckets/fetchBucketById/subscribeToBucketById all read
// bucketType/linkedTripId identically instead of drifting - previously
// only inlined in subscribeToUserBuckets, which silently dropped both
// fields even though they've existed on the Bucket type since the
// Milestone 2A design freeze.
function mapBucketDocument(id: string, d: DocumentData): Bucket {
  return {
    id,
    name: d.name,
    target: Number(d.target) || 0,
    balance: Number(d.balance) || 0,
    color: d.color ?? null,
    createdAt: d.createdAt,
    ownerId: String(d.ownerId ?? ""),
    memberIds: Array.isArray(d.memberIds) ? d.memberIds : [],
    bucketType: d.bucketType as BucketType | undefined,
    linkedTripId: d.linkedTripId as string | null | undefined,
  };
}

export function subscribeToUserBuckets(
  uid: string,
  onChange: (buckets: Bucket[]) => void,
  onError?: (error: unknown) => void
): Unsubscribe {
  const qRef = query(
    collection(db, "buckets"),
    where("memberIds", "array-contains", uid),
    orderBy("createdAt", "desc")
  );

  return onSnapshot(
    qRef,
    (snap) => {
      const next: Bucket[] = [];
      snap.forEach((docSnap) => {
        next.push(mapBucketDocument(docSnap.id, docSnap.data() as DocumentData));
      });
      onChange(next);
    },
    onError
  );
}

// One-shot lookup by document id (Checkpoint 3F.3B.4) - used by the Trip
// Detail "My Stash" section to check for an existing trip_personal
// Bucket via its DETERMINISTIC id (see src/domain/tripPersonalFund.ts)
// rather than a query, so no new Firestore index is needed. Returns null
// both when the fund hasn't been created yet and when it doesn't exist
// for any other reason - callers never need to distinguish those cases.
export async function fetchBucketById(bucketId: string): Promise<Bucket | null> {
  const snap = await getDoc(doc(db, "buckets", bucketId));
  if (!snap.exists()) return null;
  return mapBucketDocument(snap.id, snap.data() as DocumentData);
}

// Live variant of fetchBucketById (Checkpoint 3F.3B.4) - lets Trip
// Detail's "My Stash" balance update in real time after Add Money/
// Withdraw without a manual refetch, and also naturally picks up the
// document the moment "Create My Stash" succeeds (onSnapshot on a
// not-yet-existing document id keeps listening and fires again once it's
// created - no separate "create then refetch" step is needed).
export function subscribeToBucketById(
  bucketId: string,
  onChange: (bucket: Bucket | null) => void,
  onError?: (error: unknown) => void
): Unsubscribe {
  return onSnapshot(
    doc(db, "buckets", bucketId),
    (snap) => {
      onChange(snap.exists() ? mapBucketDocument(snap.id, snap.data() as DocumentData) : null);
    },
    onError
  );
}

// Generates a clientRequestId locally, with no network call and no
// document actually created - reads the id off a Firestore
// DocumentReference built by the client SDK's own auto-id generator, the
// same mechanism generateSavingsClientRequestId (savingsTransactions.ts)
// already relies on for the identical reason. Kept as its own small,
// domain-file-owned helper rather than a shared cross-domain utility,
// matching that existing precedent for a one-line body.
export function generateBucketClientRequestId(): string {
  return doc(collection(db, "buckets")).id;
}

export type CreateBucketResult = {
  bucketId: string;
  ledgerBalanceMinor: number;
};

// Validates the callable's response field-by-field rather than trusting
// a whole-object cast, matching parseRecordSavingsTransactionResponse's
// convention exactly - a malformed/unexpected shape must fail visibly.
//
// Checkpoint 3F.3B.4: for an ordinary "personal" Bucket, the trusted
// backend deterministically uses clientRequestId as the document id, so
// `expectedBucketId` is passed and checked exactly as before.
//
// Checkpoint 3F.3B.4A production-safety finding: for a trip_personal
// fund, `expectedBucketId` is now ALSO always passed (the client already
// knows the deterministic (linkedTripId, callerUid) formula - see
// src/domain/tripPersonalFund.ts) rather than trusting the response
// blindly. This closes a real compatibility gap: the OLD (currently
// deployed, pre-3F.3B.4) createBucket Cloud Function has no idea
// bucketType/linkedTripId exist - it silently ignores both and creates
// an ORDINARY personal Bucket at `clientRequestId`, returning that id in
// its response. Without this check, a new client talking to that old
// backend would receive a response that "looks successful," and would
// have silently accepted a stray, incorrectly-typed personal Bucket as
// if it were the trip fund. Comparing the returned bucketId against the
// independently-computed expected deterministic id catches exactly that
// mismatch and fails loudly instead - see the checkpoint report for why
// deploying the backend before the client is still the primary fix, and
// this check is deliberate defense-in-depth for that window.
function parseCreateBucketResponse(
  data: unknown,
  expectedBucketId?: string
): CreateBucketResult {
  if (typeof data !== "object" || data === null) {
    throw new Error(
      "createBucket: invalid response (expected an object)."
    );
  }

  const { bucketId, ledgerBalanceMinor } = data as Record<string, unknown>;

  if (typeof bucketId !== "string" || bucketId.length === 0) {
    throw new Error(
      "createBucket: invalid response (bucketId must be a non-empty string)."
    );
  }
  if (expectedBucketId !== undefined && bucketId !== expectedBucketId) {
    throw new Error(
      "createBucket: invalid response (bucketId did not match the expected id - " +
        "the deployed createBucket function may be out of date; this request did not succeed)."
    );
  }
  if (
    typeof ledgerBalanceMinor !== "number" ||
    !Number.isSafeInteger(ledgerBalanceMinor) ||
    ledgerBalanceMinor < 0
  ) {
    throw new Error(
      "createBucket: invalid response (ledgerBalanceMinor must be a non-negative safe integer)."
    );
  }

  return { bucketId, ledgerBalanceMinor };
}

// Invokes the trusted createBucket Cloud Function via httpsCallable - no
// direct Firestore write occurs here. Firestore rules still permit a
// hardened legacy direct create (Checkpoint 4F) temporarily, but this
// function no longer uses it. Callable errors (HttpsError/FirebaseError)
// are not caught or wrapped - they propagate to the caller unchanged,
// matching lookupUserByEmail/recordSavingsTransaction's existing
// convention.
export async function createBucket(
  input: CreateBucketInput
): Promise<CreateBucketResult> {
  const callable = httpsCallable<CreateBucketInput, unknown>(
    functions,
    "createBucket"
  );
  const res = await callable(input);

  // Checkpoint 3F.3B.4A: always compute a real expected id, for BOTH
  // bucket types - see parseCreateBucketResponse's comment for why this
  // now also covers trip_personal (a production-safety guard against an
  // out-of-date deployed Cloud Function). getCurrentUser() is safe to
  // call here: httpsCallable itself already requires an authenticated
  // user for this call to have succeeded at all, so the current user is
  // guaranteed to be signed in by the time this line runs.
  const expectedBucketId =
    input.bucketType === "trip_personal"
      ? tripPersonalBucketId(input.linkedTripId as string, getCurrentUser()?.uid ?? "")
      : input.clientRequestId;
  return parseCreateBucketResponse(res.data, expectedBucketId);
}

// The only fields the current updateBucket() caller (buckets.tsx's
// onSaveEdit) legitimately needs to change: ordinary bucket metadata,
// never a financial cache field. Deliberately NOT Partial<Bucket> or a
// generic Record<string, unknown> - those would compile-allow balance,
// ledgerBalanceMinor, ledgerOpeningBalanceMinor, ownerId, memberIds, etc.
// to be passed through this ordinary metadata-edit path. target stays
// optional since the screen only includes it for the bucket owner.
export type UpdateBucketInput = {
  name: string;
  color: string | null;
  lastUpdatedBy: string;
  target?: number;
};

// Accepts the exact payload the screen has already decided to send (e.g.
// the owner vs. non-owner target branching in buckets.tsx) and performs
// the write. Makes no ownership or permission decisions itself.
export async function updateBucket(
  bucketId: string,
  payload: UpdateBucketInput
): Promise<void> {
  await updateDoc(doc(db, "buckets", bucketId), {
    ...payload,
    lastUpdatedAt: serverTimestamp(),
  });
}

export async function deleteBucket(bucketId: string): Promise<void> {
  await deleteDoc(doc(db, "buckets", bucketId));
}

export async function addBucketMember(
  bucketId: string,
  memberUid: string,
  updatedBy: string
): Promise<void> {
  await updateDoc(doc(db, "buckets", bucketId), {
    memberIds: arrayUnion(memberUid),
    lastUpdatedAt: serverTimestamp(),
    lastUpdatedBy: updatedBy,
  });
}

export async function removeBucketMember(
  bucketId: string,
  memberUid: string,
  updatedBy: string
): Promise<void> {
  await updateDoc(doc(db, "buckets", bucketId), {
    memberIds: arrayRemove(memberUid),
    lastUpdatedAt: serverTimestamp(),
    lastUpdatedBy: updatedBy,
  });
}
