import {FieldValue, getFirestore} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";

type CallableAuth = CallableRequest["auth"];

interface ReverseTripExpenseResult {
  expenseId: string;
}

// The server-normalized reversalRequest snapshot compared on replay
// (preflight §8.2). reversalReason is always present as string | null,
// never omitted - mirrors creationRequest.category's own convention in
// recordTripExpense.ts exactly.
interface NormalizedReversalRequest {
  clientRequestId: string;
  reversalReason: string | null;
}

// validateInput's return shape - the callable's raw wire input is
// { expenseId: string, reversalReason?: string, clientRequestId: string }.
// Deliberately does NOT include tripId - the Expense's own tripId (read
// from the trusted, already-persisted document) is the only source of
// truth for which Trip governs this reversal (preflight §4.1).
// reversalReason is narrowed to its normalized string | null form here.
interface ValidatedInput {
  expenseId: string;
  reversalReason: string | null;
  clientRequestId: string;
}

// Duplicated verbatim from recordTripExpense.ts rather than imported - the
// established, deliberate per-file duplication convention already used for
// this exact pattern (see recordTripExpense.ts's own isTripArchived
// comment) - each callable file owns its own tiny, well-justified copy of
// these primitives rather than sharing a module across trusted callables.
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
// Reuses the existing MAX_DESCRIPTION_LENGTH/MAX_NOTE_LENGTH precedent
// value (500) - reversalReason plays the same "free text explaining what
// this record is for" role recordTripExpense.ts's own description does
// (preflight §14).
const MAX_REVERSAL_REASON_LENGTH = 500;
const MAX_FIRESTORE_DOCUMENT_ID_BYTES = 1500;

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "expenseId",
  "reversalReason",
  "clientRequestId",
]);

/**
 * True if id satisfies Firestore's own document-id constraints (never
 * empty, never exactly "." or "..", never containing "/", and never
 * exceeding Firestore's maximum document-id byte length) - the exact set
 * of shapes that would otherwise make `.doc(id)` throw synchronously.
 * Duplicated verbatim from recordTripExpense.ts (4C.2C §8) - see this
 * file's own top-of-file duplication note.
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
 * reverseTripExpense
 * Input: {
 *   expenseId: string, reversalReason?: string, clientRequestId: string,
 * }
 * Output: { expenseId: string }
 *
 * Security (docs/audits/TRIP_EXPENSE_REVERSAL_CORRECTION_PREFLIGHT_
 * 2026-09-17.md, as hardened by 4C.3A.1/4C.3A.2):
 * - Requires caller to be signed in.
 * - tripId is never client input - always read from the trusted,
 *   already-persisted Expense document (§4.1).
 * - An exact replay of the caller's OWN already-committed reversal is
 *   resolved immediately after reading the Expense, BEFORE any Trip
 *   document is ever read - historical reconciliation, not a fresh
 *   authorization decision (§4.4 step B).
 * - Pre-authorization validation is narrowed to the ONE routing fact
 *   required to identify the governing Trip (tripId) - Expense.status
 *   itself is never inspected/disclosed until AFTER authorization
 *   succeeds (§4.4 steps C/E/G, §15).
 * - Authorization: the Trip's CURRENT owner, OR the Expense's original
 *   createdBy provided they are STILL a current Trip member. payerUid and
 *   participant status grant no reversal authority (§5).
 * - Reversal is NOT gated on Trip archive state - correcting historical
 *   activity is deliberately allowed on an archived Trip (§6).
 * - This callable never reads or writes tripExpenseSplits (§12/§14).
 */
export const reverseTripExpense = onCall(async (request) => {
  const authUid = requireAuthenticatedUid(request.auth);

  return reverseTripExpenseCore(getFirestore(), authUid, request.data);
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
 * @return {Promise<ReverseTripExpenseResult>} The reversed (or
 *   idempotently replayed) Expense's document id.
 */
export async function reverseTripExpenseCore(
  db: Firestore,
  authUid: string,
  rawInput: unknown
): Promise<ReverseTripExpenseResult> {
  const input = validateInput(rawInput);

  const incomingReversalRequest: NormalizedReversalRequest = {
    clientRequestId: input.clientRequestId,
    reversalReason: input.reversalReason,
  };

  const expenseRef = db.collection("tripExpenses").doc(input.expenseId);

  return db.runTransaction(async (tx) => {
    // A. Read the Expense first, unconditionally. No other document is
    // read yet (preflight §4.3/§4.4 step A).
    const expenseSnap = await tx.get(expenseRef);
    if (!expenseSnap.exists) {
      throw new HttpsError(
        "not-found",
        "No expense found for the given expenseId."
      );
    }
    const expenseData = expenseSnap.data() as FirebaseFirestore.DocumentData;

    // B. Idempotent replay of MY OWN prior reversal, FIRST - before ANY
    // Trip lookup, before any authorization requirement of any kind,
    // before even validating expenseData.status's own well-formedness
    // beyond the equality check itself (preflight §4.4 step B). This
    // comparison can only ever evaluate to false, never throw - a
    // malformed stored reversedBy/reversalRequest safely falls through to
    // C exactly like a well-formed mismatch does.
    if (
      expenseData.status === "reversed" &&
      expenseData.reversedBy === authUid &&
      reversalRequestsMatch(
        expenseData.reversalRequest,
        incomingReversalRequest
      )
    ) {
      return {expenseId: input.expenseId};
    }

    // C. Checkpoint 4C.3A.2: validate ONLY expenseData.tripId - the single
    // routing fact actually required to identify which Trip governs
    // authorization. expenseData.status is deliberately NOT inspected
    // here (preflight §4.4 step C/§15).
    if (
      typeof expenseData.tripId !== "string" ||
      !isValidFirestoreDocumentId(expenseData.tripId)
    ) {
      throw new HttpsError(
        "failed-precondition",
        "This expense has a malformed tripId and cannot be reversed."
      );
    }
    const tripId = expenseData.tripId;

    // D. Read the Trip - the first and only point in this transaction a
    // Trip document is ever read (preflight §4.4 step D).
    const tripRef = db.collection("trips").doc(tripId);
    const tripSnap = await tx.get(tripRef);
    if (!tripSnap.exists) {
      throw new HttpsError(
        "failed-precondition",
        "No trip found for this expense."
      );
    }
    const tripData = tripSnap.data() as FirebaseFirestore.DocumentData;

    // E. Authorization (preflight §5). Reached WITHOUT ever having
    // inspected expenseData.status at all - an unauthorized caller's
    // outcome is identical regardless of whether the Expense is active,
    // already reversed, or has a corrupted status value (§15).
    const isOwner = tripData.ownerId === authUid;
    const isOriginalCreatorStillMember =
      expenseData.createdBy === authUid &&
      isCurrentTripMember(tripData, authUid);
    if (!isOwner && !isOriginalCreatorStillMember) {
      throw new HttpsError(
        "permission-denied",
        "You are not authorized to reverse this expense."
      );
    }

    // F. Nothing to check here - reversal is deliberately NOT gated on
    // Trip archive status at all (preflight §6).

    // G. NOW, for an authorized caller only: validate expenseData.status
    // is a supported value, and, for "reversed", validate the trusted
    // reversal metadata needed to reason safely. The FIRST point in this
    // transaction status is ever inspected at all (preflight §4.4 step G).
    if (expenseData.status !== "active" && expenseData.status !== "reversed") {
      throw new HttpsError(
        "failed-precondition",
        "This expense has a malformed status and cannot be reversed."
      );
    }
    if (expenseData.status === "reversed") {
      // B already established this is NOT the caller's own prior
      // reversal (otherwise it would have returned already) - so this is
      // either someone/something else's already-committed reversal, or
      // (defensively) malformed reversal metadata. Checkpoint 4C.3A.2:
      // no trusted reversal writer has ever existed before this
      // checkpoint, so no legitimate legacy reversed Expense with
      // malformed metadata can actually exist in production today - this
      // branch is purely forward-looking defensive robustness against a
      // hypothetical future bug in this callable itself, not a
      // legacy-migration concern, and no migration logic is built for it.
      if (
        typeof expenseData.reversedBy !== "string" ||
        expenseData.reversedBy.length === 0 ||
        !isWellFormedReversalRequestSnapshot(expenseData.reversalRequest)
      ) {
        throw new HttpsError(
          "failed-precondition",
          "This expense has malformed reversal metadata."
        );
      }
      throw new HttpsError(
        "failed-precondition",
        "This expense has already been reversed."
      );
    }

    // H. Compute the reversal write. Checkpoint 4C.3B.1: the resulting
    // reversed document must be canonical regardless of any pre-existing
    // top-level reversalReason a malformed/stale ACTIVE record happened
    // to carry - so a null normalized reason explicitly DELETES any
    // existing top-level reversalReason as part of this same trusted
    // update, rather than merely omitting it from the written map (which
    // would leave a stale value untouched). This is reversal metadata
    // only; no financial fact is modified.
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

    // I. A SINGLE-document write. No ExpenseSplit document is read or
    // written at all (preflight §12/§14).
    tx.update(expenseRef, updateData);

    return {expenseId: input.expenseId};
  });
}

/**
 * True if uid is a current member of the Trip (memberIds or ownerId).
 * Never trusts client-supplied membership - always reads from the Trip
 * data loaded fresh inside the transaction. Malformed-safe: a non-array
 * memberIds is treated as empty, so only the independent ownerId fallback
 * can authorize in that case. Duplicated verbatim from
 * recordTripExpense.ts (not exported there) - see this file's own
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
 * a blind JSON.stringify equality), mirroring creationRequestsMatch's own
 * style precisely (preflight §8.2). Never throws - a malformed stored
 * value simply fails to match.
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
 * (§4.4 step B) and to detect malformed reversal metadata on an
 * already-reversed Expense (§4.4 step G/§11). Checkpoint 4C.3B.1
 * hardening: this must enforce the EXACT trusted, normalized shape this
 * callable itself ever writes (§8/§14 of the preflight) - not merely
 * "roughly the right types" - because a malformed stored snapshot must
 * NEVER accidentally count as this caller's own exact replay:
 * - EXACTLY the keys {clientRequestId, reversalReason}, no more, no
 *   fewer.
 * - clientRequestId matches the SAME CLIENT_REQUEST_ID_PATTERN incoming
 *   input is validated against - this callable never stores anything
 *   looser than what it would ever accept as input.
 * - reversalReason is either exactly `null`, or a string that is
 *   non-empty, already trimmed (no leading/trailing whitespace), and at
 *   most MAX_REVERSAL_REASON_LENGTH characters - the exact canonical
 *   shape validateInput() ever produces (never "", never whitespace-only,
 *   never untrimmed, never oversized).
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
 * reversalRequest/amountMinor/payerUid is caught before ever reaching
 * Firestore (preflight §2 checkpoint instructions).
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
    typeof data.expenseId !== "string" ||
    !isValidFirestoreDocumentId(data.expenseId)
  ) {
    throw new HttpsError(
      "invalid-argument",
      "expenseId must be a non-empty, valid Firestore document id."
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
    // Checkpoint 4C.3A.1: omitted OR whitespace-only both normalize to
    // null - never treated as two different facts (preflight §8.2/§14).
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
    expenseId: data.expenseId,
    reversalReason,
    clientRequestId: data.clientRequestId,
  };
}
