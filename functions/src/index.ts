import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { HttpsError, onCall } from "firebase-functions/v2/https";

initializeApp();

/**
 * lookupUserByEmail
 * Input: { email: string }
 * Output: { uid: string, email: string }
 *
 * Security:
 * - Requires caller to be signed in
 */
export const lookupUserByEmail = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }

  const emailRaw = String(request.data?.email ?? "");
  const email = emailRaw.trim().toLowerCase();

  if (!email) {
    throw new HttpsError("invalid-argument", "Email is required.");
  }

  try {
    const userRecord = await getAuth().getUserByEmail(email);
    return { uid: userRecord.uid, email: userRecord.email ?? email };
  } catch (err: unknown) {
    // If you want, you can detect auth/user-not-found specifically
    throw new HttpsError("not-found", "No user found with that email.");
  }
});
