import {getFirestore} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";
import {executeTripMembershipDeparture} from "./tripMembershipDepartureCore";
import type {
  TripMembershipDepartureResult,
} from "./tripMembershipDepartureCore";

type CallableAuth = CallableRequest["auth"];

const MAX_FIRESTORE_DOCUMENT_ID_BYTES = 1500;

const ALLOWED_TOP_LEVEL_KEYS = new Set(["tripId", "targetUid"]);

/**
 * True if id satisfies Firestore's own document-id constraints - the
 * exact set of shapes that would otherwise make `.doc(id)` throw
 * synchronously. Duplicated verbatim from the established per-file
 * convention (see recordTripExpense.ts/leaveTrip.ts's own identical
 * helper and its own top-of-file duplication note).
 * @param {string} id The candidate document id.
 * @return {boolean} True if id is safe to pass to `.doc(id)`.
 */
function isValidFirestoreDocumentId(id: string): boolean {
  if (id.length === 0 || id === "." || id === "..") {
    return false;
  }
  if (id.includes("/")) {
    return false;
  }
  return Buffer.byteLength(id, "utf8") <= MAX_FIRESTORE_DOCUMENT_ID_BYTES;
}

/**
 * removeTripMember
 * Input: { tripId: string, targetUid: string }
 * Output: { tripId: string, uid: string, departureType: "removed" }
 *
 * Checkpoint 6.7B1 (trusted membership departure backend):
 * - Requires caller to be signed in.
 * - Only the Trip owner may remove a member; the owner can never remove
 *   themselves, and the owner can never be removed (no ownership
 *   transfer exists yet).
 * - `targetUid` must be a current member - a validity constraint on the
 *   fact being acted on (failed-precondition), never the caller's own
 *   authorization boundary.
 * - Removal requires the IDENTICAL financial readiness this checkpoint
 *   requires for a voluntary leave (ownership/expense-balance models
 *   initialized, trusted ledger valid, target's complete Shared Stash
 *   ownership and social expense-balance position each proven exactly
 *   zero against the COMPLETE, reconciled aggregate set) - the owner
 *   may never seize or redistribute a departing member's funds merely
 *   by removing them.
 * - NOT gated on Trip archive state - a wind-down operation.
 * - ownerId/memberIds/financial balances/departure timestamps/the
 *   departure actor uid are never accepted as client input - every fact
 *   is derived from `request.auth.uid` and trusted Firestore state.
 * - See functions/src/callables/tripMembershipDepartureCore.ts for the
 *   full shared transaction this delegates to.
 */
export const removeTripMember = onCall(async (request) => {
  const authUid = requireAuthenticatedUid(request.auth);
  return removeTripMemberCore(getFirestore(), authUid, request.data);
});

/**
 * Requires an authenticated caller, matching the guard every callable in
 * this project uses. Extracted so the production auth boundary itself can
 * be tested directly - the onCall wrapper above calls this exact function,
 * not a separate/duplicated check.
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
 * Firestore emulator without the heavier Functions-emulator/HTTPS callable
 * machinery. The onCall wrapper above only resolves auth and forwards - no
 * business logic is duplicated between the two.
 * @param {Firestore} db Admin SDK Firestore instance (emulator or prod).
 * @param {string} authUid The authenticated caller's uid.
 * @param {unknown} rawInput The callable request body, validated inside.
 * @return {Promise<TripMembershipDepartureResult>} The resulting (or
 *   idempotently replayed) departure.
 */
export async function removeTripMemberCore(
  db: Firestore,
  authUid: string,
  rawInput: unknown
): Promise<TripMembershipDepartureResult> {
  const input = validateInput(rawInput);
  return executeTripMembershipDeparture(db, authUid, {
    kind: "remove",
    tripId: input.tripId,
    targetUid: input.targetUid,
  });
}

// Named so the JSDoc @return tag below can reference it directly,
// rather than an inline object type (which the valid-jsdoc ESLint rule
// cannot parse).
type ValidatedInput = {tripId: string; targetUid: string};

/**
 * Validates and narrows a raw callable request body. Strict top-level
 * field validation: any key not in ALLOWED_TOP_LEVEL_KEYS is rejected
 * outright (invalid-argument) rather than silently ignored - this is how
 * an attempt to inject ownerId/memberIds/departedByUid/departedAt is
 * caught before ever reaching Firestore.
 * @param {unknown} raw The unvalidated callable request body.
 * @return {ValidatedInput} The validated input.
 */
function validateInput(raw: unknown): ValidatedInput {
  if (typeof raw !== "object" || raw === null) {
    throw new HttpsError("invalid-argument", "Request body is required.");
  }
  const data = raw as Record<string, unknown>;

  for (const key of Object.keys(data)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      throw new HttpsError(
        "invalid-argument",
        `Unsupported field "${key}" is not accepted by this checkpoint.`
      );
    }
  }

  if (
    typeof data.tripId !== "string" ||
    !isValidFirestoreDocumentId(data.tripId)
  ) {
    throw new HttpsError(
      "invalid-argument",
      "tripId must be a non-empty, valid Firestore document id."
    );
  }
  if (typeof data.targetUid !== "string" || data.targetUid.length === 0) {
    throw new HttpsError(
      "invalid-argument",
      "targetUid must be a non-empty string."
    );
  }

  return {tripId: data.tripId, targetUid: data.targetUid};
}
