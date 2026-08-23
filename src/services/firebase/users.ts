// Firestore user-profile writes (users/{uid} and publicUsers/{uid}).
// Extracted from app/(auth)/register.tsx so the same writes can be
// reused by app/(auth)/login.tsx's self-heal writes later.
import {
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";
import type { DocumentData, Unsubscribe } from "firebase/firestore";
import { db } from "../../../firebase";
import type {
  PublicProfile,
  UpsertPublicProfileInput,
  UpsertUserProfileInput,
} from "../../types/domain";

export async function upsertUserProfile(
  input: UpsertUserProfileInput
): Promise<void> {
  const { uid, displayName, email, photoURL, includeCreatedAt } = input;

  const payload: Record<string, unknown> = {
    uid,
    displayName,
    email,
    photoURL,
    updatedAt: serverTimestamp(),
  };

  if (includeCreatedAt) {
    payload.createdAt = serverTimestamp();
  }

  await setDoc(doc(db, "users", uid), payload, { merge: true });
}

export async function upsertPublicProfile(
  input: UpsertPublicProfileInput
): Promise<void> {
  const { uid, displayName, photoURL } = input;

  await setDoc(
    doc(db, "publicUsers", uid),
    {
      uid,
      displayName,
      photoURL,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

export function subscribeToPublicUsersByIds(
  uids: string[],
  onChange: (users: PublicProfile[]) => void,
  onError?: (error: unknown) => void
): Unsubscribe {
  const qRef = query(
    collection(db, "publicUsers"),
    where("__name__", "in", uids)
  );

  return onSnapshot(
    qRef,
    (snap) => {
      const next: PublicProfile[] = [];
      snap.forEach((docSnap) => {
        const d = docSnap.data() as DocumentData;
        next.push({
          uid: docSnap.id,
          displayName: String(d.displayName ?? ""),
          photoURL: String(d.photoURL ?? ""),
        });
      });
      onChange(next);
    },
    onError
  );
}
