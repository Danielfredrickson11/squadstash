// Firestore user-profile writes (users/{uid} and publicUsers/{uid}).
// Extracted from app/(auth)/register.tsx so the same writes can be
// reused by app/(auth)/login.tsx's self-heal writes later.
import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "../../../firebase";

export async function upsertUserProfile(input: {
  uid: string;
  displayName: string;
  email: string;
  photoURL: string | null;
  includeCreatedAt?: boolean;
}): Promise<void> {
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

export async function upsertPublicProfile(input: {
  uid: string;
  displayName: string;
  photoURL: string;
}): Promise<void> {
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
