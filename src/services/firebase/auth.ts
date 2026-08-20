// Firebase Authentication SDK wrappers used by the login/register screens.
// Thin pass-throughs only - no error handling or profile-write logic here,
// so screens keep their existing try/catch behavior unchanged.
import {
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from "firebase/auth";
import type { Unsubscribe, User, UserCredential } from "firebase/auth";
import { auth } from "../../../firebase";

export type { User };

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

export function getCurrentUser(): User | null {
  return getAuth().currentUser;
}

export function subscribeToAuthState(
  onChange: (user: User | null) => void
): Unsubscribe {
  return onAuthStateChanged(auth, onChange);
}

export function signOutUser(): Promise<void> {
  return signOut(auth);
}
