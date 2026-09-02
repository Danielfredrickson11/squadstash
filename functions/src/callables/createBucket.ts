import {FieldValue, getFirestore} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";

type CallableAuth = CallableRequest["auth"];

interface CreateBucketInput {
  name: string;
  target: number;
  startingBalanceMinor: number;
  color: string | null;
  clientRequestId: string;
}

interface CreateBucketResult {
  bucketId: string;
  ledgerBalanceMinor: number;
}

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * createBucket
 * Input: {
 *   name: string, target: number, startingBalanceMinor: number,
 *   color: string | null, clientRequestId: string,
 * }
 * Output: { bucketId: string, ledgerBalanceMinor: number }
 *
 * Security:
 * - Requires caller to be signed in
 * - ownerId/memberIds are never accepted from client input - both are
 *   derived exclusively from the authenticated caller (ownerId = authUid,
 *   memberIds = [authUid])
 * - This is the canonical trusted path for NEW normal Bucket creation.
 *   Direct client Firestore creation remains temporarily available
 *   through the hardened Milestone 2B Checkpoint 4F rules until a later
 *   cutover/closure checkpoint closes it - see createBucketCore's replay
 *   check, which deliberately never treats a legacy/direct-created
 *   document as a valid idempotent replay of this callable.
 * - Does NOT create a buckets/{bucketId}/members/{uid} membership
 *   subdocument - hybrid membership materialization is deferred to a
 *   dedicated follow-up checkpoint covering creation + add + remove
 *   consistently (Milestone 2B Checkpoint 4G-1 preflight).
 */
export const createBucket = onCall(async (request) => {
  const authUid = requireAuthenticatedUid(request.auth);

  return createBucketCore(getFirestore(), authUid, request.data);
});

/**
 * Requires an authenticated caller, matching the guard every callable in
 * this project uses (see lookupUserByEmail, recordSavingsTransaction).
 * Extracted so the production auth boundary itself can be tested
 * directly - the onCall wrapper above calls this exact function, not a
 * separate/duplicated check.
 * @param {CallableAuth} auth The callable request's auth data.
 * @return {string} The authenticated caller's uid.
 */
export function requireAuthenticatedUid(auth: CallableAuth): string {
  if (!auth) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }
  return auth.uid;
}

/**
 * Testable trusted core. Receives an already-resolved Firestore instance
 * and the authenticated caller's uid rather than pulling either from the
 * onCall request context directly, so tests can invoke this against the
 * Firestore emulator without the heavier Functions-emulator/HTTPS
 * callable machinery. The onCall wrapper above only resolves auth and
 * forwards - no business logic is duplicated between the two.
 * @param {Firestore} db Admin SDK Firestore instance (emulator or prod).
 * @param {string} authUid The authenticated caller's uid.
 * @param {unknown} rawInput The callable request body, validated inside.
 * @return {Promise<CreateBucketResult>} The new/idempotently replayed
 *   bucket id and its resulting trusted ledger balance.
 */
export async function createBucketCore(
  db: Firestore,
  authUid: string,
  rawInput: unknown
): Promise<CreateBucketResult> {
  const input = validateInput(rawInput);
  const bucketRef = db.collection("buckets").doc(input.clientRequestId);

  return db.runTransaction(async (tx) => {
    // The read must happen before any write - Firestore transactions
    // require this ordering.
    const existingSnap = await tx.get(bucketRef);

    if (existingSnap.exists) {
      const stored = existingSnap.data() as FirebaseFirestore.DocumentData;
      if (!matchesCreationRequest(stored, input, authUid)) {
        throw new HttpsError(
          "already-exists",
          "clientRequestId was already used for a different request."
        );
      }
      // The identity check above only proves this document IS the
      // trusted result of this exact original creation request - it
      // deliberately says nothing about the Bucket's CURRENT state,
      // which legitimately changes after creation (renames, target/
      // color edits, member additions, and - critically - every
      // subsequent trusted contribution/withdrawal). A replay therefore
      // always returns the CURRENT ledgerBalanceMinor, never the
      // original starting balance, validated fresh here rather than
      // trusted blindly.
      const currentBalance = stored.ledgerBalanceMinor;
      if (!Number.isSafeInteger(currentBalance) || currentBalance < 0) {
        throw new HttpsError(
          "failed-precondition",
          "Bucket has no valid current trusted ledger balance."
        );
      }
      // The balance compatibility cache must agree with the CURRENT
      // trusted ledger, not with the original starting balance -
      // comparing against the original would reintroduce the exact
      // durable-idempotency bug this design fixed, since balance
      // legitimately moves with every subsequent trusted contribution/
      // withdrawal. A create replay is read-only: unexpected corruption
      // here fails loudly rather than repairing the cache mid-replay.
      if (
        typeof stored.balance !== "number" ||
        !Number.isFinite(stored.balance) ||
        stored.balance !== currentBalance / 100
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Bucket financial cache is inconsistent with its trusted ledger."
        );
      }
      return {
        bucketId: input.clientRequestId,
        ledgerBalanceMinor: currentBalance,
      };
    }

    const bucketData: Record<string, unknown> = {
      ownerId: authUid,
      memberIds: [authUid],
      name: input.name,
      target: input.target,
      color: input.color,
      balance: input.startingBalanceMinor / 100,
      ledgerOpeningBalanceMinor: input.startingBalanceMinor,
      ledgerBalanceMinor: input.startingBalanceMinor,
      currency: "USD",
      bucketType: "personal",
      // Immutable trusted creation metadata, distinct from the mutable
      // display fields above (which may all legitimately diverge from
      // these original values over the Bucket's lifetime). This is the
      // sole source of truth idempotent replay compares against - see
      // matchesCreationRequest. Never client-writable: the 4F create
      // allowlist and 4E update allowlist both exclude this key, so only
      // this trusted Admin SDK path can ever create or read-and-trust it.
      creationRequest: {
        clientRequestId: input.clientRequestId,
        ownerId: authUid,
        name: input.name,
        target: input.target,
        startingBalanceMinor: input.startingBalanceMinor,
        color: input.color,
      },
      createdAt: FieldValue.serverTimestamp(),
      lastUpdatedAt: FieldValue.serverTimestamp(),
      lastUpdatedBy: authUid,
    };
    tx.set(bucketRef, bucketData);

    return {
      bucketId: input.clientRequestId,
      ledgerBalanceMinor: input.startingBalanceMinor,
    };
  });
}

/**
 * Validates and narrows a raw callable request body. name is trimmed
 * here and the trimmed value becomes the canonical stored name and the
 * idempotency comparison value - callers never see the untrimmed form
 * again.
 * @param {unknown} raw The unvalidated callable request body.
 * @return {CreateBucketInput} The validated, narrowed input.
 */
function validateInput(raw: unknown): CreateBucketInput {
  if (typeof raw !== "object" || raw === null) {
    throw new HttpsError("invalid-argument", "Request body is required.");
  }
  const data = raw as Record<string, unknown>;

  if (typeof data.name !== "string") {
    throw new HttpsError("invalid-argument", "name must be a string.");
  }
  const name = data.name.trim();
  if (name.length === 0) {
    throw new HttpsError("invalid-argument", "name must not be empty.");
  }

  if (
    typeof data.target !== "number" ||
    !Number.isFinite(data.target) ||
    data.target <= 0
  ) {
    throw new HttpsError(
      "invalid-argument",
      "target must be a positive finite number."
    );
  }

  if (
    typeof data.startingBalanceMinor !== "number" ||
    !Number.isSafeInteger(data.startingBalanceMinor) ||
    data.startingBalanceMinor < 0
  ) {
    throw new HttpsError(
      "invalid-argument",
      "startingBalanceMinor must be a non-negative safe integer."
    );
  }

  if (data.color !== null && typeof data.color !== "string") {
    throw new HttpsError(
      "invalid-argument",
      "color must be a string or null."
    );
  }

  if (
    typeof data.clientRequestId !== "string" ||
    !CLIENT_REQUEST_ID_PATTERN.test(data.clientRequestId)
  ) {
    throw new HttpsError(
      "invalid-argument",
      "clientRequestId must be a non-empty string of letters, " +
        "numbers, \"_\", or \"-\" (max 128 characters)."
    );
  }

  return {
    name,
    target: data.target,
    startingBalanceMinor: data.startingBalanceMinor,
    color: data.color as string | null,
    clientRequestId: data.clientRequestId,
  };
}

/**
 * True if a previously-stored document at the incoming clientRequestId
 * is a valid idempotent replay of this exact original creation request.
 * Compares the incoming request against the document's IMMUTABLE
 * creationRequest metadata (the original request facts, frozen at
 * creation time) plus a small set of trusted root invariants that also
 * never change after a canonical creation - never against the document's
 * CURRENT mutable display state (name/target/color/memberIds may be
 * edited later; ledgerBalanceMinor/balance change with every subsequent
 * trusted contribution/withdrawal). Requiring current state to still
 * equal creation-time state would make a legitimate retry of an old
 * create request incorrectly fail once the Bucket had evolved at all -
 * exactly the bug this design avoids.
 *
 * Also deliberately rejects a legacy/direct-created document sharing
 * this id: direct client Bucket creation remains temporarily possible
 * through the hardened Checkpoint 4F rules, but those rules (and the
 * Checkpoint 4E update rules) both exclude the creationRequest key, so
 * only this trusted path can ever produce a document that passes this
 * check - a legacy document has no creationRequest map at all and is
 * correctly rejected as already-exists rather than treated as a replay.
 * @param {FirebaseFirestore.DocumentData} stored The existing persisted
 *   buckets document at the incoming clientRequestId.
 * @param {CreateBucketInput} input The incoming validated request.
 * @param {string} authUid The incoming request's authenticated caller.
 * @return {boolean} True if this is the trusted result of the exact same
 *   original creation request.
 */
function matchesCreationRequest(
  stored: FirebaseFirestore.DocumentData,
  input: CreateBucketInput,
  authUid: string
): boolean {
  const creationRequest = stored.creationRequest;
  if (typeof creationRequest !== "object" || creationRequest === null) {
    return false;
  }
  if (creationRequest.clientRequestId !== input.clientRequestId) {
    return false;
  }
  if (creationRequest.ownerId !== authUid) {
    return false;
  }
  if (creationRequest.name !== input.name) {
    return false;
  }
  if (creationRequest.target !== input.target) {
    return false;
  }
  if (creationRequest.startingBalanceMinor !== input.startingBalanceMinor) {
    return false;
  }
  if (creationRequest.color !== input.color) {
    return false;
  }

  // Trusted root invariants proving this was a canonical creation -
  // deliberately excludes every field that legitimately mutates after
  // creation (name/target/color/memberIds/ledgerBalanceMinor/balance/
  // lastUpdatedAt/lastUpdatedBy).
  if (stored.ownerId !== authUid) {
    return false;
  }
  if (stored.ledgerOpeningBalanceMinor !== input.startingBalanceMinor) {
    return false;
  }
  if (stored.currency !== "USD") {
    return false;
  }
  if (stored.bucketType !== "personal") {
    return false;
  }
  if ("linkedTripId" in stored) {
    return false;
  }

  return true;
}
