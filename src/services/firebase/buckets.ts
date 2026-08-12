// Real-time subscription to the buckets a user belongs to. Extracted from
// app/(tabs)/buckets.tsx and app/(tabs)/home.tsx, which both queried the
// same buckets collection the same way. Only the query/subscription
// mechanics move here - each screen keeps applying its own field
// defaults (e.g. how a missing bucket name is displayed) and its own
// error-handling behavior, since those differ between the two screens
// today. See Milestone 1D checkpoint 4A notes for the comparison.
import {
  collection,
  onSnapshot,
  orderBy,
  query,
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
