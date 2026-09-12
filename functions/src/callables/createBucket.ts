import {FieldValue, getFirestore} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";

type CallableAuth = CallableRequest["auth"];

type BucketType = "personal" | "trip_personal";

interface CreateBucketInput {
  name: string;
  target: number;
  startingBalanceMinor: number;
  color: string | null;
  clientRequestId: string;
  bucketType: BucketType;
  // Non-null only when bucketType === "trip_personal" - validateInput
  // enforces that pairing (see below).
  linkedTripId: string | null;
}

interface CreateBucketResult {
  bucketId: string;
  ledgerBalanceMinor: number;
}

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Deterministic trip_personal Bucket document id, derived from
 * (linkedTripId, ownerUid) - never the client-chosen clientRequestId
 * ordinary "personal" Buckets use as their document id.
 *
 * This IS the entire uniqueness mechanism for "at most one trip_personal
 * Bucket per (ownerUid, linkedTripId)" (Checkpoint 3F.3B.4): Firestore
 * transactions already guarantee that concurrent attempts to
 * read-then-write the SAME document id serialize correctly - two racing
 * "Create My Stash" submissions for the same trip+user can never produce
 * two documents, because the second one always lands on the
 * read-existing/replay branch below (matchesCreationRequest) instead of
 * a fresh create. No separate claim/uniqueness collection, and no
 * "search first, create if none exists" client-side race, is needed.
 *
 * IMPORTANT: this exact formula is duplicated in
 * src/domain/tripPersonalFund.ts on the client (a separate compiled
 * TypeScript project with no shared import path). Keep both in sync
 * manually if this ever changes.
 * @param {string} tripId The linked Trip's document id.
 * @param {string} uid The owning member's authenticated uid.
 * @return {string} The deterministic Bucket document id.
 */
function tripPersonalBucketId(tripId: string, uid: string): string {
  return `tripfund_${tripId}_${uid}`;
}

/**
 * createBucket
 * Input: {
 *   name: string, target: number, startingBalanceMinor: number,
 *   color: string | null, clientRequestId: string,
 *   bucketType?: "personal" | "trip_personal" (default "personal"),
 *   linkedTripId?: string | null,
 * }
 * Output: { bucketId: string, ledgerBalanceMinor: number }
 *
 * Security:
 * - Requires caller to be signed in
 * - ownerId/memberIds are never accepted from client input - both are
 *   derived exclusively from the authenticated caller (ownerId = authUid,
 *   memberIds = [authUid]) - true for BOTH bucket types, which is exactly
 *   how "caller is creating the fund for THEMSELF" (Checkpoint 3F.3B.4)
 *   is enforced: there is no input field that could ever name a
 *   different owner.
 * - This is the canonical trusted path for NEW Bucket creation of either
 *   type. Direct client Firestore creation remains temporarily available
 *   through the hardened Milestone 2B Checkpoint 4F rules until a later
 *   cutover/closure checkpoint closes it - see createBucketCore's replay
 *   check, which deliberately never treats a legacy/direct-created
 *   document as a valid idempotent replay of this callable.
 * - Checkpoint 3F.3B.4: bucketType: "trip_personal" additionally requires
 *   linkedTripId and is rejected unless the referenced Trip exists and
 *   the authenticated caller is currently one of its members
 *   (memberIds or ownerId) - never trusted from client input, always
 *   read fresh from the Trip document inside the same transaction.
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
  const isTripPersonal = input.bucketType === "trip_personal";
  const bucketId = isTripPersonal ?
    tripPersonalBucketId(input.linkedTripId as string, authUid) :
    input.clientRequestId;
  const bucketRef = db.collection("buckets").doc(bucketId);
  const tripRef = isTripPersonal ?
    db.collection("trips").doc(input.linkedTripId as string) :
    null;

  return db.runTransaction(async (tx) => {
    // All reads must happen before any write - Firestore transactions
    // require this ordering.
    const existingSnap = await tx.get(bucketRef);
    const tripSnap = tripRef ? await tx.get(tripRef) : null;

    if (isTripPersonal) {
      if (!tripSnap || !tripSnap.exists) {
        throw new HttpsError("not-found", "The linked Trip does not exist.");
      }
      const tripData = tripSnap.data() as FirebaseFirestore.DocumentData;
      const tripMemberIds = Array.isArray(tripData.memberIds) ?
        tripData.memberIds :
        [];
      const isTripMember =
        tripMemberIds.includes(authUid) || tripData.ownerId === authUid;
      if (!isTripMember) {
        throw new HttpsError(
          "permission-denied",
          "You must be a member of this Trip to create a personal " +
            "trip fund for it."
        );
      }
    }

    if (existingSnap.exists) {
      const stored = existingSnap.data() as FirebaseFirestore.DocumentData;
      if (!matchesCreationRequest(stored, input, authUid)) {
        throw new HttpsError(
          "already-exists",
          isTripPersonal ?
            "You already have a personal trip fund for this Trip." :
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
        bucketId,
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
      bucketType: input.bucketType,
      // Only present on a trip_personal fund - an ordinary "personal"
      // Bucket's document shape is byte-identical to before this
      // checkpoint (no linkedTripId key at all), preserving existing
      // behavior exactly.
      ...(isTripPersonal ? {linkedTripId: input.linkedTripId} : {}),
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
        bucketType: input.bucketType,
        linkedTripId: input.linkedTripId,
      },
      createdAt: FieldValue.serverTimestamp(),
      lastUpdatedAt: FieldValue.serverTimestamp(),
      lastUpdatedBy: authUid,
    };
    tx.set(bucketRef, bucketData);

    return {
      bucketId,
      ledgerBalanceMinor: input.startingBalanceMinor,
    };
  });
}

/**
 * Validates and narrows a raw callable request body. name is trimmed
 * here and the trimmed value becomes the canonical stored name and the
 * idempotency comparison value - callers never see the untrimmed form
 * again.
 *
 * Checkpoint 3F.3B.4: bucketType defaults to "personal" when omitted
 * (every pre-existing caller keeps working unchanged). "personal"
 * requires linkedTripId to be absent/null; "trip_personal" requires it
 * to be a non-empty string. Trip membership itself is verified later,
 * inside the transaction in createBucketCore, where the Trip document
 * can actually be read - never trusted from client input.
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

  let bucketType: BucketType = "personal";
  if (data.bucketType !== undefined) {
    if (data.bucketType !== "personal" && data.bucketType !== "trip_personal") {
      throw new HttpsError(
        "invalid-argument",
        "bucketType must be \"personal\" or \"trip_personal\"."
      );
    }
    bucketType = data.bucketType;
  }

  let linkedTripId: string | null = null;
  if (bucketType === "trip_personal") {
    if (
      typeof data.linkedTripId !== "string" ||
      data.linkedTripId.trim().length === 0
    ) {
      throw new HttpsError(
        "invalid-argument",
        "linkedTripId is required when bucketType is \"trip_personal\"."
      );
    }
    linkedTripId = data.linkedTripId;
  } else if (data.linkedTripId !== undefined && data.linkedTripId !== null) {
    throw new HttpsError(
      "invalid-argument",
      "linkedTripId must be omitted or null when bucketType is \"personal\"."
    );
  }

  return {
    name,
    target: data.target,
    startingBalanceMinor: data.startingBalanceMinor,
    color: data.color as string | null,
    clientRequestId: data.clientRequestId,
    bucketType,
    linkedTripId,
  };
}

/**
 * True if a previously-stored document at the incoming bucket id is a
 * valid idempotent replay of this exact original creation request.
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
 * Checkpoint 3F.3B.4: bucketType and linkedTripId now join the compared
 * facts (both the immutable creationRequest snapshot and the trusted
 * root invariants) - a clientRequestId/deterministic-id collision
 * against a document of a DIFFERENT bucketType or linkedTripId must
 * produce the same definitive "already-exists" outcome as any other
 * mismatched fact, never a silent misattributed replay. For a
 * trip_personal id, this doubles as the "at most one fund per
 * (owner, trip)" enforcement: a second creation attempt with different
 * facts (e.g. a different target) for the same deterministic id
 * correctly fails here instead of overwriting or duplicating.
 *
 * clientRequestId itself is deliberately EXCLUDED from the comparison
 * for a trip_personal id (see below) - for an ordinary "personal"
 * Bucket, clientRequestId IS the document id, so this document could
 * only ever be reached again by resubmitting that exact same id, making
 * the check a no-op in practice that's kept purely for defense-in-depth.
 * For trip_personal, the document is instead found by the deterministic
 * (linkedTripId, ownerUid) id, so a second "Create My Stash" submission
 * with a genuinely fresh clientRequestId (e.g. the user reopened the
 * create form) but IDENTICAL facts is a legitimate idempotent replay of
 * "you already have this exact fund" - requiring clientRequestId to also
 * match would incorrectly reject that as already-exists even though
 * nothing about the request actually differs.
 *
 * Also deliberately rejects a legacy/direct-created document sharing
 * this id: direct client Bucket creation remains temporarily possible
 * through the hardened Checkpoint 4F rules, but those rules (and the
 * Checkpoint 4E update rules) both exclude the creationRequest key, so
 * only this trusted path can ever produce a document that passes this
 * check - a legacy document has no creationRequest map at all and is
 * correctly rejected as already-exists rather than treated as a replay.
 * @param {FirebaseFirestore.DocumentData} stored The existing persisted
 *   buckets document at the incoming bucket id.
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
  if (
    input.bucketType !== "trip_personal" &&
    creationRequest.clientRequestId !== input.clientRequestId
  ) {
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
  if ((creationRequest.bucketType ?? "personal") !== input.bucketType) {
    return false;
  }
  if ((creationRequest.linkedTripId ?? null) !== input.linkedTripId) {
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
  if (stored.bucketType !== input.bucketType) {
    return false;
  }
  if (input.bucketType === "trip_personal") {
    if (stored.linkedTripId !== input.linkedTripId) {
      return false;
    }
  } else if ("linkedTripId" in stored) {
    return false;
  }

  return true;
}
