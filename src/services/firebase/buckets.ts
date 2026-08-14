// Real-time subscription to the buckets a user belongs to. Extracted from
// app/(tabs)/buckets.tsx and app/(tabs)/home.tsx, which both queried the
// same buckets collection the same way. Only the query/subscription
// mechanics move here - each screen keeps applying its own field
// defaults (e.g. how a missing bucket name is displayed) and its own
// error-handling behavior, since those differ between the two screens
// today. See Milestone 1D checkpoint 4A notes for the comparison.
//
// createBucket / updateBucket / deleteBucket / updateBucketBalance
// (checkpoint 4B) are thin wrappers around the writes previously inline
// in app/(tabs)/buckets.tsx. Ownership/permission decisions and payload
// construction stay in the screen - these only execute what the screen
// has already decided to write.
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

export type BucketRecord = {
  id: string;
  name?: string;
  target: number;
  balance: number;
  color?: string | null;
  createdAt?: unknown;
  ownerId: string;
  memberIds: string[];
};

export function subscribeToUserBuckets(
  uid: string,
  onChange: (buckets: BucketRecord[]) => void,
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
      const next: BucketRecord[] = [];
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

export async function createBucket(input: {
  name: string;
  target: number;
  balance: number;
  color: string | null;
  ownerId: string;
}): Promise<string> {
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

// Accepts the exact payload the screen has already decided to send (e.g.
// the owner vs. non-owner field branching in buckets.tsx) and performs
// the write. Makes no ownership or permission decisions itself.
export async function updateBucket(
  bucketId: string,
  payload: Record<string, unknown>
): Promise<void> {
  await updateDoc(doc(db, "buckets", bucketId), payload);
}

export async function deleteBucket(bucketId: string): Promise<void> {
  await deleteDoc(doc(db, "buckets", bucketId));
}

export async function updateBucketBalance(
  bucketId: string,
  balance: number,
  updatedBy: string
): Promise<void> {
  await updateDoc(doc(db, "buckets", bucketId), {
    balance,
    lastUpdatedAt: serverTimestamp(),
    lastUpdatedBy: updatedBy,
  });
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
