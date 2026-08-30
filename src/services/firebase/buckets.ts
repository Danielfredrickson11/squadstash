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
// financial cache field - see UpdateBucketInput below. createBucket's
// legacy Starting Balance behavior is the one deliberate exception: it is
// temporarily unchanged and intentionally deferred to the upcoming
// starting-balance checkpoint, not an oversight.
import {
  addDoc,
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
import { db } from "../../../firebase";
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

export async function createBucket(input: CreateBucketInput): Promise<string> {
  const { name, target, balance, color, ownerId } = input;

  const ref = await addDoc(collection(db, "buckets"), {
    name,
    target,
    balance,
    color,
    createdAt: serverTimestamp(),
    ownerId,
    memberIds: [ownerId],
    lastUpdatedAt: serverTimestamp(),
    lastUpdatedBy: ownerId,
  });

  return ref.id;
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
