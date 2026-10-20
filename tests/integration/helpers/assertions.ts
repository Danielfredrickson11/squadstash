// Checkpoint 5C.3D-B "Integration Harness Hardening" follow-up - exact,
// not merely-truthy, rejection assertions for Rules-denial and
// callable-rejection proofs. A generic `.rejects.toBeTruthy()` is
// satisfied by ANY thrown value, including an unrelated offline/network
// exception unrelated to Firestore Rules - it can never distinguish "the
// Firestore Emulator's Rules engine denied this operation" from
// "something else failed first". These helpers capture the actual
// thrown error and assert the real SDK-reported code, empirically
// confirmed (not assumed) against the real Firestore/Functions
// Emulators in this environment: the Firestore Web SDK's FirestoreError
// normalizes a Rules denial to the bare code "permission-denied" (never
// a "firestore/"-prefixed form - that prefix convention belongs to
// Functions callable errors, not Firestore client errors).
import {FirebaseError} from "firebase/app";

/**
 * Asserts that `promise` rejects with a Firestore client SDK error whose
 * `.code` is specifically "permission-denied" - proving a Rules denial,
 * not an arbitrary failure.
 * @param {Promise<unknown>} promise The Firestore operation under test.
 * @return {Promise<void>}
 */
export async function expectFirestorePermissionDenied(promise: Promise<unknown>): Promise<void> {
  let caught: unknown;
  await expect(
    promise.catch((e) => {
      caught = e;
      throw e;
    })
  ).rejects.toBeTruthy();
  expect(caught).toBeInstanceOf(FirebaseError);
  expect((caught as FirebaseError).code).toBe("permission-denied");
}

/**
 * Asserts that `promise` (a Functions callable invocation) rejects with
 * the exact given error code, e.g. "functions/permission-denied" or
 * "functions/not-found" - proving the specific, frozen backend contract
 * rather than an arbitrary rejection.
 * @param {Promise<unknown>} promise The callable invocation under test.
 * @param {string} expectedCode The exact expected `.code`.
 * @return {Promise<void>}
 */
export async function expectCallableErrorCode(
  promise: Promise<unknown>,
  expectedCode: string
): Promise<void> {
  let caught: unknown;
  await expect(
    promise.catch((e) => {
      caught = e;
      throw e;
    })
  ).rejects.toBeTruthy();
  expect((caught as {code?: string}).code).toBe(expectedCode);
}
