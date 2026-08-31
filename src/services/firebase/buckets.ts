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
import type { Bucket, CreateBucketInput } from "../../types/domain";

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
        const d = docSnap.data() as DocumentData;
        next.push({
          id: docSnap.id,
          name: d.name,
          target: Number(d.target) || 0,
          balance: Number(d.balance) || 0,
          color: d.color ?? null,
          createdAt: d.createdAt,
          ownerId: String(d.ownerId ?? ""),
          memberIds: Array.isArray(d.memberIds) ? d.memberIds : [],
        });
      });
      onChange(next);
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
function parseCreateBucketResponse(
  data: unknown,
  clientRequestId: string
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
  // The trusted backend deterministically uses clientRequestId as the
  // Bucket document id - a mismatch here means the response cannot be
  // trusted to describe the Bucket this call actually asked for, and
  // must never be silently accepted.
  if (bucketId !== clientRequestId) {
    throw new Error(
      "createBucket: invalid response (bucketId did not match the request's clientRequestId)."
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
  return parseCreateBucketResponse(res.data, input.clientRequestId);
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
