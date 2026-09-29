import {FieldValue, getFirestore} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";

type CallableAuth = CallableRequest["auth"];

interface ReverseTripSettlementResult {
  settlementId: string;
}

// The server-normalized reversalRequest snapshot compared on replay.
// reversalReason is always present as string | null, never omitted -
// mirrors reverseTripExpense.ts's own NormalizedReversalRequest exactly.
interface NormalizedReversalRequest {
  clientRequestId: string;
  reversalReason: string | null;
}

// validateInput's return shape - the callable's raw wire input is
// { settlementId: string, reversalReason?: string, clientRequestId: string }.
// Deliberately does NOT include tripId - the Settlement's own tripId
// (read from the trusted, already-persisted document) is the only source
// of truth for which Trip governs this reversal, exactly mirroring
// reverseTripExpense.ts's own contract.
interface ValidatedInput {
  settlementId: string;
  reversalReason: string | null;
  clientRequestId: string;
}

// Duplicated verbatim from reverseTripExpense.ts rather than imported -
// the established, deliberate per-file duplication convention already
// used throughout this package.
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_REVERSAL_REASON_LENGTH = 500;
const MAX_FIRESTORE_DOCUMENT_ID_BYTES = 1500;

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "settlementId",
  "reversalReason",
  "clientRequestId",
]);

/**
 * True if id satisfies Firestore's own document-id constraints - the
 * exact set of shapes that would otherwise make `.doc(id)` throw
 * synchronously. Duplicated verbatim from recordTripExpense.ts/
 * reverseTripExpense.ts - see this file's own top-of-file duplication
 * note.
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
 * reverseTripSettlement
 * Input: {
 *   settlementId: string, reversalReason?: string, clientRequestId: string,
 * }
 * Output: { settlementId: string }
 *
 * Security (docs/audits/TRIP_BALANCES_SETTLEMENTS_PREFLIGHT_2026-09-28.md
 * §11/§13, as hardened by 4E.0A):
 * - Requires caller to be signed in.
 * - tripId is never client input - always read from the trusted,
 *   already-persisted Settlement document.
 * - An exact replay of the caller's OWN already-committed reversal is
 *   resolved immediately after reading the Settlement, BEFORE any Trip
 *   document is ever read - historical reconciliation, not a fresh
 *   authorization decision.
 * - Pre-authorization validation is narrowed to the ONE routing fact
 *   required to identify the governing Trip (tripId) - Settlement.status
 *   itself is never inspected/disclosed until AFTER authorization
 *   succeeds.
 * - Authorization is NARROWER than Expense reversal: ONLY the
 *   Settlement's own toUid, while STILL a current Trip member, may
 *   reverse it. The Trip owner gets NO override merely for being owner -
 *   they were never a party to the transaction being confirmed. fromUid
 *   gets no reversal authority. An unrelated member gets none either.
 * - Reversal is NOT gated on Trip archive state - correcting historical
 *   activity is deliberately allowed on an archived Trip.
 * - This callable never reads or writes any other collection - no
 *   compensating record, no replaces/replacedBy linkage, no delete.
 */
export const reverseTripSettlement = onCall(async (request) => {
  const authUid = requireAuthenticatedUid(request.auth);

  return reverseTripSettlementCore(getFirestore(), authUid, request.data);
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
 * Firestore emulator without the heavier Functions-emulator/HTTPS
 * callable machinery. The onCall wrapper above only resolves auth and
 * forwards - no business logic is duplicated between the two.
 * @param {Firestore} db Admin SDK Firestore instance (emulator or prod).
 * @param {string} authUid The authenticated caller's uid.
 * @param {unknown} rawInput The callable request body, validated inside.
 * @return {Promise<ReverseTripSettlementResult>} The reversed (or
 *   idempotently replayed) Settlement's document id.
 */
export async function reverseTripSettlementCore(
  db: Firestore,
  authUid: string,
  rawInput: unknown
): Promise<ReverseTripSettlementResult> {
  const input = validateInput(rawInput);

  const incomingReversalRequest: NormalizedReversalRequest = {
    clientRequestId: input.clientRequestId,
    reversalReason: input.reversalReason,
  };

  const settlementRef = db
    .collection("tripSettlements")
    .doc(input.settlementId);

  return db.runTransaction(async (tx) => {
    // A. Read the Settlement first, unconditionally. No other document is
    // read yet.
    const settlementSnap = await tx.get(settlementRef);
    if (!settlementSnap.exists) {
      throw new HttpsError(
        "not-found",
        "No settlement found for the given settlementId."
      );
    }
    const settlementData =
      settlementSnap.data() as FirebaseFirestore.DocumentData;

    // B. Idempotent replay of MY OWN prior reversal, FIRST - before ANY
    // Trip lookup, before any authorization requirement of any kind,
    // before even validating settlementData.status's own well-formedness
    // beyond the equality check itself. This comparison can only ever
    // evaluate to false, never throw - a malformed stored reversedBy/
    // reversalRequest safely falls through to C exactly like a
    // well-formed mismatch does.
    if (
      settlementData.status === "reversed" &&
      settlementData.reversedBy === authUid &&
      reversalRequestsMatch(
        settlementData.reversalRequest,
        incomingReversalRequest
      )
    ) {
      return {settlementId: input.settlementId};
    }

    // C. Validate ONLY settlementData.tripId - the single routing fact
    // actually required to identify which Trip governs authorization.
    // settlementData.status is deliberately NOT inspected here.
    if (
      typeof settlementData.tripId !== "string" ||
      !isValidFirestoreDocumentId(settlementData.tripId)
    ) {
      throw new HttpsError(
        "failed-precondition",
        "This settlement has a malformed tripId and cannot be reversed."
      );
    }
    const tripId = settlementData.tripId;

    // D. Read the Trip - the first and only point in this transaction a
    // Trip document is ever read.
    const tripRef = db.collection("trips").doc(tripId);
    const tripSnap = await tx.get(tripRef);
    if (!tripSnap.exists) {
      throw new HttpsError(
        "failed-precondition",
        "No trip found for this settlement."
      );
    }
    const tripData = tripSnap.data() as FirebaseFirestore.DocumentData;

    // E. Authorization - deliberately NARROWER than Expense reversal
    // (Checkpoint 4E preflight §11): ONLY the Settlement's own toUid,
    // while STILL a current Trip member, may reverse it. No Trip-owner
    // override, no fromUid authority, no unrelated-member authority.
    // Reached WITHOUT ever having inspected settlementData.status at all
    // - an unauthorized caller's outcome is identical regardless of
    // whether the Settlement is active, already reversed, or has a
    // corrupted status value.
    const isAuthorizedReverser =
      settlementData.toUid === authUid &&
      isCurrentTripMember(tripData, authUid);
    if (!isAuthorizedReverser) {
      throw new HttpsError(
        "permission-denied",
        "You are not authorized to reverse this settlement."
      );
    }

    // F. Nothing to check here - reversal is deliberately NOT gated on
    // Trip archive status at all.

    // G. NOW, for an authorized caller only: validate settlementData.status
    // is a supported value, and, for "reversed", validate the trusted
    // reversal metadata needed to reason safely. The FIRST point in this
    // transaction status is ever inspected at all.
    if (
      settlementData.status !== "active" &&
      settlementData.status !== "reversed"
    ) {
      throw new HttpsError(
        "failed-precondition",
        "This settlement has a malformed status and cannot be reversed."
      );
    }
    if (settlementData.status === "reversed") {
      // B already established this is NOT the caller's own prior
      // reversal (otherwise it would have returned already) - so this is
      // either someone/something else's already-committed reversal, or
      // (defensively) malformed reversal metadata. Never let a different
      // clientRequestId masquerade as the caller's own replay merely
      // because reversedBy matches authUid - the same ambiguity lesson
      // already hardened in Expense reversal (4D.6A).
      if (
        typeof settlementData.reversedBy !== "string" ||
        settlementData.reversedBy.length === 0 ||
        !isWellFormedReversalRequestSnapshot(settlementData.reversalRequest)
      ) {
        throw new HttpsError(
          "failed-precondition",
          "This settlement has malformed reversal metadata."
        );
      }
      throw new HttpsError(
        "failed-precondition",
        "This settlement has already been reversed."
      );
    }

    // H. Compute the reversal write. A null normalized reason explicitly
    // DELETES any existing top-level reversalReason as part of this same
    // trusted update, rather than merely omitting it from the written map
    // (which would leave a stale value untouched) - this is reversal
    // metadata only; no financial fact is modified.
    const updateData: Record<string, unknown> = {
      status: "reversed",
      reversedAt: FieldValue.serverTimestamp(),
      reversedBy: authUid,
      reversalRequest: incomingReversalRequest,
      reversalReason:
        input.reversalReason !== null ?
          input.reversalReason :
          FieldValue.delete(),
    };

    // I. A SINGLE-document write. No other collection is read or written
    // at all - no compensating record, no replaces/replacedBy linkage.
    tx.update(settlementRef, updateData);

    return {settlementId: input.settlementId};
  });
}

/**
 * True if uid is a current member of the Trip (memberIds or ownerId).
 * Never trusts client-supplied membership - always reads from the Trip
 * data loaded fresh inside the transaction. Malformed-safe: a non-array
 * memberIds is treated as empty, so only the independent ownerId
 * fallback can authorize in that case. Duplicated verbatim from
 * recordTripExpense.ts/reverseTripExpense.ts - see this file's own
 * top-of-file duplication note.
 * @param {FirebaseFirestore.DocumentData} tripData The Trip document data.
 * @param {string} uid The uid to check.
 * @return {boolean} True if uid is a current Trip member.
 */
function isCurrentTripMember(
  tripData: FirebaseFirestore.DocumentData,
  uid: string
): boolean {
  const memberIds = Array.isArray(tripData.memberIds) ? tripData.memberIds : [];
  return memberIds.includes(uid) || tripData.ownerId === uid;
}

/**
 * True if a previously-stored reversalRequest snapshot exactly matches an
 * incoming normalized snapshot. Explicit field-by-field comparison (never
 * a blind JSON.stringify equality), mirroring reverseTripExpense.ts's own
 * reversalRequestsMatch style precisely. Never throws - a malformed
 * stored value simply fails to match.
 * @param {unknown} stored The persisted reversalRequest map, as read back
 *   from Firestore.
 * @param {NormalizedReversalRequest} incoming The incoming normalized
 *   snapshot.
 * @return {boolean} True if every compared fact matches exactly.
 */
function reversalRequestsMatch(
  stored: unknown,
  incoming: NormalizedReversalRequest
): boolean {
  if (!isWellFormedReversalRequestSnapshot(stored)) {
    return false;
  }
  return (
    stored.clientRequestId === incoming.clientRequestId &&
    stored.reversalReason === incoming.reversalReason
  );
}

/**
 * True if value has the EXACT expected NormalizedReversalRequest shape -
 * used both to reject a malformed stored snapshot on replay comparison
 * and to detect malformed reversal metadata on an already-reversed
 * Settlement. Must enforce the EXACT trusted, normalized shape this
 * callable itself ever writes - not merely "roughly the right types" -
 * because a malformed stored snapshot must NEVER accidentally count as
 * this caller's own exact replay. Mirrors
 * reverseTripExpense.ts's own isWellFormedReversalRequestSnapshot
 * precisely.
 * @param {unknown} value The candidate value.
 * @return {boolean} True if value is an exact, canonical, well-formed
 *   reversalRequest.
 */
function isWellFormedReversalRequestSnapshot(
  value: unknown
): value is NormalizedReversalRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  if (
    keys.length !== 2 ||
    !keys.includes("clientRequestId") ||
    !keys.includes("reversalReason")
  ) {
    return false;
  }
  if (
    typeof v.clientRequestId !== "string" ||
    !CLIENT_REQUEST_ID_PATTERN.test(v.clientRequestId)
  ) {
    return false;
  }
  if (v.reversalReason === null) {
    return true;
  }
  return (
    typeof v.reversalReason === "string" &&
    v.reversalReason.length > 0 &&
    v.reversalReason.length <= MAX_REVERSAL_REASON_LENGTH &&
    v.reversalReason.trim() === v.reversalReason
  );
}

/**
 * Validates and narrows a raw callable request body. Strict top-level
 * field validation: any key not in ALLOWED_TOP_LEVEL_KEYS is rejected
 * outright (invalid-argument) rather than silently ignored - this is how
 * an attempt to inject status/reversedAt/reversedBy/createdBy/tripId/
 * reversalRequest/amountMinor/fromUid/toUid is caught before ever
 * reaching Firestore.
 * @param {unknown} raw The unvalidated callable request body.
 * @return {ValidatedInput} The validated, narrowed input.
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
    typeof data.settlementId !== "string" ||
    !isValidFirestoreDocumentId(data.settlementId)
  ) {
    throw new HttpsError(
      "invalid-argument",
      "settlementId must be a non-empty, valid Firestore document id."
    );
  }

  let reversalReason: string | null = null;
  if (data.reversalReason !== undefined) {
    if (typeof data.reversalReason !== "string") {
      throw new HttpsError(
        "invalid-argument",
        "reversalReason must be a string."
      );
    }
    const trimmed = data.reversalReason.trim();
    if (trimmed.length > MAX_REVERSAL_REASON_LENGTH) {
      throw new HttpsError(
        "invalid-argument",
        "reversalReason must be at most " +
          `${MAX_REVERSAL_REASON_LENGTH} characters.`
      );
    }
    // Omitted OR whitespace-only both normalize to null - never treated
    // as two different facts.
    reversalReason = trimmed.length > 0 ? trimmed : null;
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
    settlementId: data.settlementId,
    reversalReason,
    clientRequestId: data.clientRequestId,
  };
}
