// Firebase Authentication SDK wrappers used by the login/register screens.
// Thin pass-throughs only - no error handling or profile-write logic here,
// so screens keep their existing try/catch behavior unchanged.
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updateProfile,
} from "firebase/auth";
import type { User, UserCredential } from "firebase/auth";
import { auth } from "../../../firebase";

export function signIn(
  email: string,
  password: string
): Promise<UserCredential> {
  return signInWithEmailAndPassword(auth, email, password);
}

export function signUp(
  email: string,
  password: string
): Promise<UserCredential> {
  return createUserWithEmailAndPassword(auth, email, password);
}

export function updateAuthProfile(
  user: User,
  profile: { displayName?: string | null; photoURL?: string | null }
): Promise<void> {
  return updateProfile(user, profile);
}
