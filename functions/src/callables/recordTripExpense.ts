import {FieldValue, Timestamp, getFirestore} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";

import {
  computeExpenseSplits,
  splitDocumentId,
  type SplitStrategyInput,
} from "../domain/tripExpenseSplits";

type CallableAuth = CallableRequest["auth"];
type SplitStrategy = "equal" | "percentage" | "custom";

// Checkpoint 4C.2A, per the approved docs/audits/
// TRIP_OUT_OF_POCKET_EXPENSE_PERSISTENCE_PREFLIGHT_2026-09-15.md (as
// hardened by its 4C.1A/4C.1B amendments): 4C supports ONLY
// paymentSource === "member_out_of_pocket" - "shared_stash" is rejected
// outright (§6/§7 Phase 1 step 6), never accepted or silently coerced.
type RawParticipant = {
  uid: unknown;
  percentageBasisPoints?: unknown;
  amountMinor?: unknown;
};

// The callable's own wire-input shape - a locally-defined interface, never
// imported from src/types/domain, matching the established precedent that
// neither recordSavingsTransaction.ts nor createBucket.ts imports its
// input shape from there either (preflight §1/§6). Documents the RAW
// contract a client sends; validateInput below narrows this into
// ValidatedInput, never returning this interface directly (participants
// need their own, differently-shaped, post-validation type - see
// NormalizedParticipant).
interface RecordTripExpenseInput {
  tripId: string;
  payerUid: string;
  amountMinor: number;
  currency: string;
  description: string;
  category?: string;
  splitStrategy: SplitStrategy;
  participants: RawParticipant[];
  // ISO 8601 date-time WITH AN EXPLICIT TIMEZONE - see
  // ISO_INSTANT_PATTERN/parseOccurredAt below for the exact accepted
  // shape and why plain Date.parse alone is looser than this contract.
  occurredAt?: string;
  clientRequestId: string;
}

// A single participant, narrowed and shape-validated against its
// splitStrategy, but not yet math-validated (duplicates/sums/overflow are
// the job of computeExpenseSplits itself, §7 Phase 2 step 8).
type NormalizedParticipant = {
  uid: string;
  percentageBasisPoints?: number;
  amountMinor?: number;
};

// validateInput's actual return shape - RecordTripExpenseInput with
// `participants` narrowed to the post-shape-validation type, rather than
// an intersection of the two (which would require every value to satisfy
// both the raw and normalized participant shapes at once - unnecessary
// fragility for no benefit over a dedicated type). `occurredAt` (the raw
// string) is replaced by its already-parsed forms - occurredAtInstantMs/
// occurredAtTimestamp are computed once, in validateInput, per Checkpoint
// 4C.2A.1 (§4) - never re-parsed downstream.
interface ValidatedInput
  extends Omit<RecordTripExpenseInput, "participants" | "occurredAt"> {
  participants: NormalizedParticipant[];
  occurredAtInstantMs: number | null;
  occurredAtTimestamp: Timestamp | undefined;
}

// The server-normalized creationRequest snapshot compared on replay
// (preflight §5.2). Deliberately does NOT include createdBy - that stays
// a separate, top-level persisted field compared independently (§5.1).
interface NormalizedCreationRequest {
  tripId: string;
  payerUid: string;
  amountMinor: number;
  currency: string;
  description: string;
  category: string | null;
  splitStrategy: SplitStrategy;
  participants: NormalizedParticipant[];
  paymentSource: "member_out_of_pocket";
  occurredAtInstantMs: number | null;
}

interface RecordTripExpenseResult {
  expenseId: string;
}

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
// Reuses the existing MAX_NOTE_LENGTH precedent value from
// recordSavingsTransaction.ts exactly (500) - description plays the same
// "free text explaining what this record is for" role a savings
// transaction's note does.
const MAX_DESCRIPTION_LENGTH = 500;
// category is a short free-form label (e.g. "Food", "Lodging"), not a
// note - capped shorter than description/note's own precedent since no
// realistic category name approaches even a fraction of that length; this
// is a defensive upper bound, not a meaningful UX constraint.
const MAX_CATEGORY_LENGTH = 100;

// Checkpoint 4C.2A.1 (§4): the documented contract is "an ISO 8601 date-
// time string", but bare Date.parse accepts many non-ISO/locale formats
// too ("01/01/2027", "January 1, 2027") - looser than what's documented.
// This regex requires the full extended date-time form WITH AN EXPLICIT
// TIMEZONE designator (a trailing Z, or a numeric +HH:MM/-HH:MM offset) -
// a date-only string ("2027-01-01") is deliberately rejected, since it
// names a calendar day, not an instant, and this field's whole purpose is
// "when did this expense actually happen" as a specific moment in time.
// Fractional seconds are capped at 1-3 digits (millisecond precision) -
// the same precision `Date`/`Timestamp` actually carry, so a caller can
// never supply sub-millisecond precision that would silently be dropped.
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "tripId",
  "payerUid",
  "amountMinor",
  "currency",
  "description",
  "category",
  "splitStrategy",
  "participants",
  "paymentSource",
  "occurredAt",
  "clientRequestId",
]);

/**
 * recordTripExpense
 * Input: {
 *   tripId: string, payerUid: string, amountMinor: number,
 *   currency: string, description: string, category?: string,
 *   splitStrategy: "equal" | "percentage" | "custom",
 *   participants:
 *     ({uid} | {uid, percentageBasisPoints} | {uid, amountMinor})[],
 *   paymentSource?: "member_out_of_pocket" (only accepted value - absent
 *   is normalized to it, anything else including "shared_stash" is
 *   invalid-argument), occurredAt?: string, clientRequestId: string,
 * }
 * Output: { expenseId: string }
 *
 * Security (docs/audits/TRIP_OUT_OF_POCKET_EXPENSE_PERSISTENCE_PREFLIGHT_
 * 2026-09-15.md, as hardened by 4C.1A/4C.1B):
 * - Requires caller to be signed in.
 * - Caller must be a current Trip member (memberIds or ownerId) - any
 *   member may record an expense paid by ANOTHER member (createdBy !=
 *   payerUid is an intended, everyday case, §2/§7) - this is NOT a self-
 *   only rule like recordSavingsTransaction's.
 * - payerUid and every participant uid must independently be a current
 *   Trip member, verified fresh inside the transaction.
 * - New Expense creation is rejected on an archived Trip
 *   (failed-precondition), checked only AFTER caller authorization so an
 *   unauthorized caller never learns the Trip's archive state.
 * - Idempotent replay is bound to BOTH the original creator (stored
 *   createdBy === authUid) AND an exact normalized creationRequest match
 *   - a different authenticated caller can never inherit another
 *     creator's already-committed Expense (§5.1).
 * - 4C supports ONLY paymentSource "member_out_of_pocket" - "shared_stash"
 *   is rejected outright.
 * - This is the sole trusted write path for tripExpenses/
 *   tripExpenseSplits; direct client creation is closed by Firestore
 *   Rules in a later checkpoint (4C.2B).
 */
export const recordTripExpense = onCall(async (request) => {
  const authUid = requireAuthenticatedUid(request.auth);

  return recordTripExpenseCore(getFirestore(), authUid, request.data);
});

/**
 * Requires an authenticated caller, matching the guard every callable in
 * this project uses (see recordSavingsTransaction.ts/createBucket.ts).
 * Extracted so the production auth boundary itself can be tested directly
 * - the onCall wrapper above calls this exact function, not a separate/
 * duplicated check.
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
 * @return {Promise<RecordTripExpenseResult>} The new/idempotently
 *   replayed Expense's document id.
 */
export async function recordTripExpenseCore(
  db: Firestore,
  authUid: string,
  rawInput: unknown
): Promise<RecordTripExpenseResult> {
  const input = validateInput(rawInput);

  // Checkpoint 4C.2A.1 (§4): occurredAt is fully parsed/validated exactly
  // once, in validateInput - no re-parsing here, and no risk of a second
  // place where a malformed/out-of-range date could throw uncaught.
  const occurredAtTimestamp = input.occurredAtTimestamp;
  const occurredAtInstantMs = input.occurredAtInstantMs;

  // Checkpoint 4C.1A (preflight §5.2): participants are canonicalized by
  // ascending uid BEFORE the snapshot is stored or compared, so harmless
  // client-side array ordering can never change a request's identity.
  const normalizedParticipants = [...input.participants].sort((a, b) =>
    a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0
  );

  const creationRequest: NormalizedCreationRequest = {
    tripId: input.tripId,
    payerUid: input.payerUid,
    amountMinor: input.amountMinor,
    currency: input.currency,
    description: input.description,
    category: input.category ?? null,
    splitStrategy: input.splitStrategy,
    participants: normalizedParticipants,
    paymentSource: "member_out_of_pocket",
    occurredAtInstantMs,
  };

  const expenseRef = db.collection("tripExpenses").doc(input.clientRequestId);
  const tripRef = db.collection("trips").doc(input.tripId);

  return db.runTransaction(async (tx) => {
    // All reads happen before any write - Firestore transactions require
    // this ordering.
    const existingExpenseSnap = await tx.get(expenseRef);
    const tripSnap = await tx.get(tripRef);

    // A. Trip existence handling.
    if (!tripSnap.exists) {
      throw new HttpsError("not-found", "No trip found for the given tripId.");
    }
    const tripData = tripSnap.data() as FirebaseFirestore.DocumentData;

    // B. Existing Expense / idempotent replay FIRST (preflight §5.1/§7
    // step 3) - evaluated entirely from data already loaded above, no
    // additional read. Bound to BOTH the original creator and an exact
    // normalized-facts match; a mismatch on either produces the identical
    // already-exists outcome (no way for a caller to distinguish "someone
    // else already used this id" from "you used this id for something
    // different" - a deliberate anti-enumeration property). This branch
    // deliberately runs BEFORE any membership/archive check: the original
    // creator must be able to reconcile their own already-committed
    // request even if the Trip was later archived or they were later
    // removed from Trip membership - that is historical reconciliation,
    // not a fresh authorization decision.
    if (existingExpenseSnap.exists) {
      const stored =
        existingExpenseSnap.data() as FirebaseFirestore.DocumentData;
      if (
        stored.createdBy !== authUid ||
        !creationRequestsMatch(stored.creationRequest, creationRequest)
      ) {
        throw new HttpsError(
          "already-exists",
          "clientRequestId was already used for a different request."
        );
      }
      return {expenseId: input.clientRequestId};
    }

    // C. For a NEW Expense: validate caller is a current Trip member.
    // This is the real authorization boundary and must resolve before any
    // Trip-state fact (e.g. archive status) is ever revealed to the
    // caller (preflight §7 step 4/§15 information-leakage analysis).
    if (!Array.isArray(tripData.memberIds)) {
      throw new HttpsError(
        "failed-precondition",
        "Trip has malformed memberIds."
      );
    }
    if (!isCurrentTripMember(tripData, authUid)) {
      throw new HttpsError(
        "permission-denied",
        "You must be a current member of this Trip to record an expense."
      );
    }

    // D. ONLY after caller authorization: check Trip archived state.
    if (isTripArchived(tripData)) {
      throw new HttpsError(
        "failed-precondition",
        "This trip is archived and no longer accepts new expenses."
      );
    }

    // E. Validate payerUid is a current Trip member. Not permission-
    // denied - the CALLER is authorized; it is the referenced payer that
    // fails a data-integrity condition (mirrors the failed-precondition/
    // permission-denied code-family split recordSavingsTransactionCore
    // already draws).
    if (!isCurrentTripMember(tripData, input.payerUid)) {
      throw new HttpsError(
        "failed-precondition",
        "payerUid is not a current member of this Trip."
      );
    }

    // F. Validate every split participant uid is a current Trip member.
    for (const participant of normalizedParticipants) {
      if (!isCurrentTripMember(tripData, participant.uid)) {
        throw new HttpsError(
          "failed-precondition",
          `Participant "${participant.uid}" is not a current member ` +
            "of this Trip."
        );
      }
    }

    // G. Compute trusted splits - never reproduce the split formulas
    // here; a thrown domain Error is a caller-input problem, always
    // invalid-argument, never masked as an unexpected infrastructure
    // error.
    let allocations;
    try {
      allocations = computeExpenseSplits(
        input.amountMinor,
        buildSplitStrategyInput(input.splitStrategy, normalizedParticipants)
      );
    } catch (e) {
      throw new HttpsError(
        "invalid-argument",
        e instanceof Error ? e.message : "Invalid split input."
      );
    }

    // H. Persist all documents atomically - the Expense and every
    // ExpenseSplit either all commit or none do.
    const expenseData: Record<string, unknown> = {
      tripId: input.tripId,
      payerUid: input.payerUid,
      createdBy: authUid,
      amountMinor: input.amountMinor,
      currency: "USD",
      description: input.description,
      splitStrategy: input.splitStrategy,
      paymentSource: "member_out_of_pocket",
      status: "active",
      createdAt: FieldValue.serverTimestamp(),
      creationRequest,
    };
    if (input.category !== undefined) {
      expenseData.category = input.category;
    }
    if (occurredAtTimestamp !== undefined) {
      expenseData.occurredAt = occurredAtTimestamp;
    }
    tx.set(expenseRef, expenseData);

    for (const allocation of allocations) {
      const splitRef = db
        .collection("tripExpenseSplits")
        .doc(splitDocumentId(input.clientRequestId, allocation.uid));
      const splitData: Record<string, unknown> = {
        expenseId: input.clientRequestId,
        tripId: input.tripId,
        userId: allocation.uid,
        amountMinor: allocation.amountMinor,
        createdAt: FieldValue.serverTimestamp(),
      };
      if (allocation.percentageBasisPoints !== undefined) {
        splitData.percentageBasisPoints = allocation.percentageBasisPoints;
      }
      tx.set(splitRef, splitData);
    }

    return {expenseId: input.clientRequestId};
  });
}

/**
 * True if uid is a current member of the Trip (memberIds or ownerId).
 * Never trusts client-supplied membership - always reads from the Trip
 * data loaded fresh inside the transaction.
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
 * Checkpoint 4C.2A: trusted-backend mirror of firestore.rules'
 * `tripIsActive()` missing-safe check and of
 * recordSavingsTransaction.ts's own local `isTripArchived` (that function
 * is not exported, so this is a deliberate, tiny, well-justified
 * duplication of a two-line predicate - the same within-package
 * duplication convention already used for CLIENT_REQUEST_ID_PATTERN
 * across every callable file in this package). A legacy Trip with no
 * `archivedAt` key, or one explicitly `null`, reads as active; only a
 * real archivedAt value reads as archived.
 * @param {FirebaseFirestore.DocumentData} tripData The Trip document data.
 * @return {boolean} True if the Trip is archived.
 */
function isTripArchived(tripData: FirebaseFirestore.DocumentData): boolean {
  return tripData.archivedAt !== undefined && tripData.archivedAt !== null;
}

/**
 * Builds the discriminated SplitStrategyInput the duplicated domain
 * module expects, from the already shape-validated, uid-sorted
 * participants.
 * @param {SplitStrategy} splitStrategy The requested split strategy.
 * @param {NormalizedParticipant[]} participants The normalized, uid-sorted
 *   participants.
 * @return {SplitStrategyInput} The discriminated split input.
 */
function buildSplitStrategyInput(
  splitStrategy: SplitStrategy,
  participants: NormalizedParticipant[]
): SplitStrategyInput {
  if (splitStrategy === "equal") {
    return {
      strategy: "equal",
      participantUids: participants.map((p) => p.uid),
    };
  }
  if (splitStrategy === "percentage") {
    return {
      strategy: "percentage",
      participants: participants.map((p) => ({
        uid: p.uid,
        percentageBasisPoints: p.percentageBasisPoints as number,
      })),
    };
  }
  return {
    strategy: "custom",
    participants: participants.map((p) => ({
      uid: p.uid,
      amountMinor: p.amountMinor as number,
    })),
  };
}

/**
 * True if a previously-stored creationRequest snapshot exactly matches an
 * incoming normalized snapshot. Explicit field-by-field comparison (never
 * a blind JSON.stringify equality), mirroring the existing
 * storedFactsMatch/matchesCreationRequest convention in this package.
 * createdBy is deliberately NOT compared here - it is checked separately,
 * one level up, against the Expense document's own top-level field
 * (preflight §5.1/§5.2).
 * @param {unknown} stored The persisted creationRequest map, as read back
 *   from Firestore.
 * @param {NormalizedCreationRequest} incoming The incoming normalized
 *   snapshot.
 * @return {boolean} True if every compared fact matches exactly.
 */
function creationRequestsMatch(
  stored: unknown,
  incoming: NormalizedCreationRequest
): boolean {
  if (typeof stored !== "object" || stored === null) {
    return false;
  }
  const s = stored as Record<string, unknown>;
  return (
    s.tripId === incoming.tripId &&
    s.payerUid === incoming.payerUid &&
    s.amountMinor === incoming.amountMinor &&
    s.currency === incoming.currency &&
    s.description === incoming.description &&
    (s.category ?? null) === incoming.category &&
    s.splitStrategy === incoming.splitStrategy &&
    s.paymentSource === incoming.paymentSource &&
    (typeof s.occurredAtInstantMs === "number" ?
      s.occurredAtInstantMs :
      null) === incoming.occurredAtInstantMs &&
    participantsMatch(s.participants, incoming.participants)
  );
}

/**
 * True if a previously-stored participants array exactly matches an
 * incoming normalized (already uid-sorted) participants array,
 * element-by-element.
 * @param {unknown} stored The persisted participants array, as read back
 *   from Firestore.
 * @param {NormalizedParticipant[]} incoming The incoming normalized,
 *   uid-sorted participants.
 * @return {boolean} True if every participant matches exactly, in order.
 */
function participantsMatch(
  stored: unknown,
  incoming: NormalizedParticipant[]
): boolean {
  if (!Array.isArray(stored) || stored.length !== incoming.length) {
    return false;
  }
  for (let i = 0; i < incoming.length; i++) {
    const s = stored[i];
    const want = incoming[i];
    if (typeof s !== "object" || s === null) {
      return false;
    }
    const sObj = s as Record<string, unknown>;
    if (sObj.uid !== want.uid) {
      return false;
    }
    const sPercentage = typeof sObj.percentageBasisPoints === "number" ?
      sObj.percentageBasisPoints :
      undefined;
    if ((sPercentage ?? null) !== (want.percentageBasisPoints ?? null)) {
      return false;
    }
    const sAmount =
      typeof sObj.amountMinor === "number" ? sObj.amountMinor : undefined;
    if ((sAmount ?? null) !== (want.amountMinor ?? null)) {
      return false;
    }
  }
  return true;
}

/**
 * Validates and narrows a raw callable request body. Strict top-level
 * field validation: any key not in ALLOWED_TOP_LEVEL_KEYS is rejected
 * outright (invalid-argument) rather than silently ignored - this is how
 * an attempt to inject createdBy/status/sharedStashTransactionId/
 * reversedAt/reversedBy/reversalReason/receiptImageUrl/id is caught
 * before ever reaching Firestore (preflight §6/§6.1/§7 Phase 1 step 7).
 * @param {unknown} raw The unvalidated callable request body.
 * @return {ValidatedInput} The validated, narrowed input (participants
 *   shape-validated per strategy, not yet math-validated).
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

  if (typeof data.tripId !== "string" || data.tripId.length === 0) {
    throw new HttpsError("invalid-argument", "tripId is required.");
  }
  if (typeof data.payerUid !== "string" || data.payerUid.length === 0) {
    throw new HttpsError("invalid-argument", "payerUid is required.");
  }
  if (
    typeof data.amountMinor !== "number" ||
    !Number.isSafeInteger(data.amountMinor) ||
    data.amountMinor <= 0
  ) {
    throw new HttpsError(
      "invalid-argument",
      "amountMinor must be a positive safe integer."
    );
  }
  if (typeof data.currency !== "string" || data.currency !== "USD") {
    throw new HttpsError("invalid-argument", "currency must be \"USD\".");
  }
  if (typeof data.description !== "string") {
    throw new HttpsError("invalid-argument", "description is required.");
  }
  const description = data.description.trim();
  if (
    description.length === 0 ||
    description.length > MAX_DESCRIPTION_LENGTH
  ) {
    throw new HttpsError(
      "invalid-argument",
      "description must be a non-empty string of at most " +
        `${MAX_DESCRIPTION_LENGTH} characters.`
    );
  }

  let category: string | undefined;
  if (data.category !== undefined) {
    if (
      typeof data.category !== "string" ||
      data.category.length > MAX_CATEGORY_LENGTH
    ) {
      throw new HttpsError(
        "invalid-argument",
        `category must be a string of at most ${MAX_CATEGORY_LENGTH} ` +
          "characters."
      );
    }
    category = data.category;
  }

  if (
    data.splitStrategy !== "equal" &&
    data.splitStrategy !== "percentage" &&
    data.splitStrategy !== "custom"
  ) {
    throw new HttpsError(
      "invalid-argument",
      "splitStrategy must be \"equal\", \"percentage\", or \"custom\"."
    );
  }
  const splitStrategy = data.splitStrategy;

  if (!Array.isArray(data.participants) || data.participants.length === 0) {
    throw new HttpsError(
      "invalid-argument",
      "participants must be a non-empty array."
    );
  }
  const participants = data.participants.map((raw, index) =>
    validateParticipantShape(splitStrategy, raw, index)
  );

  // 4C accepts only paymentSource absent or exactly
  // "member_out_of_pocket" - absence is normalized to it; anything else
  // (including "shared_stash") is rejected right here, before ever
  // touching Firestore (preflight §6/§7 Phase 1 step 6).
  if (
    data.paymentSource !== undefined &&
    data.paymentSource !== "member_out_of_pocket"
  ) {
    throw new HttpsError(
      "invalid-argument",
      "paymentSource must be \"member_out_of_pocket\" - " +
        "Shared-Stash-funded expenses are not supported by this checkpoint."
    );
  }

  let occurredAtInstantMs: number | null = null;
  let occurredAtTimestamp: Timestamp | undefined;
  if (data.occurredAt !== undefined) {
    if (typeof data.occurredAt !== "string") {
      throw new HttpsError(
        "invalid-argument",
        "occurredAt must be a string."
      );
    }
    const parsed = parseOccurredAt(data.occurredAt);
    occurredAtInstantMs = parsed.instantMs;
    occurredAtTimestamp = parsed.timestamp;
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
    tripId: data.tripId,
    payerUid: data.payerUid,
    amountMinor: data.amountMinor,
    currency: data.currency,
    description,
    category,
    splitStrategy,
    participants,
    occurredAtInstantMs,
    occurredAtTimestamp,
    clientRequestId: data.clientRequestId,
  };
}

/**
 * Parses and validates an occurredAt string against the documented
 * contract: an ISO 8601 date-time string WITH AN EXPLICIT TIMEZONE (a
 * trailing Z, or a numeric +HH:MM/-HH:MM offset) - never a date-only or
 * locale-formatted string, and never anything JS's permissive
 * `Date.parse` would otherwise accept on its own (e.g. "01/01/2027",
 * "January 1, 2027"). Checkpoint 4C.2A.1: `Date.parse` alone was looser
 * than the documented "ISO date/time string" contract - this regex
 * closes that gap before `Date.parse` ever runs. Equivalent instants
 * under different (but still valid) textual representations - "...Z" vs
 * "...+00:00", or a different but equivalent offset - are unaffected:
 * replay normalization always compares the PARSED instant (§10 of the
 * preflight), never the original string. Also converts to a Firestore
 * `Timestamp` here, inside a try/catch, so a syntactically valid but
 * out-of-Firestore's-representable-range instant (e.g. year 0000, before
 * Firestore's minimum) is surfaced as an ordinary invalid-argument
 * rather than an uncaught internal exception.
 * @param {string} raw The raw occurredAt string from client input.
 * @return {{instantMs: number, timestamp: Timestamp}} The parsed instant
 *   (milliseconds since epoch) and its Firestore Timestamp form.
 */
function parseOccurredAt(raw: string): {
  instantMs: number;
  timestamp: Timestamp;
} {
  if (!ISO_INSTANT_PATTERN.test(raw)) {
    throw new HttpsError(
      "invalid-argument",
      "occurredAt must be an ISO 8601 date-time string with an " +
        "explicit timezone (e.g. \"2027-01-01T00:00:00Z\" or " +
        "\"2027-01-01T00:00:00+01:00\")."
    );
  }
  const instantMs = Date.parse(raw);
  if (Number.isNaN(instantMs)) {
    throw new HttpsError(
      "invalid-argument",
      "occurredAt must name a valid calendar date/time."
    );
  }
  try {
    return {instantMs, timestamp: Timestamp.fromDate(new Date(instantMs))};
  } catch {
    throw new HttpsError(
      "invalid-argument",
      "occurredAt cannot be represented as a Firestore timestamp."
    );
  }
}

/**
 * Validates a single raw participant entry's STRUCTURE against the
 * requested splitStrategy (does this entry carry exactly the right
 * shape?) - not its math (duplicates, sums, and overflow are validated by
 * computeExpenseSplits itself, §7 Phase 2 step 8). Strict key checking:
 * an entry carrying a field not appropriate for the strategy (e.g.
 * amountMinor on an "equal" participant) is rejected, never silently
 * dropped.
 * @param {SplitStrategy} splitStrategy The requested split strategy.
 * @param {unknown} raw The raw participant entry.
 * @param {number} index The entry's index, for error messages.
 * @return {NormalizedParticipant} The shape-validated participant.
 */
function validateParticipantShape(
  splitStrategy: SplitStrategy,
  raw: unknown,
  index: number
): NormalizedParticipant {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HttpsError(
      "invalid-argument",
      `participants[${index}] must be an object.`
    );
  }
  const p = raw as RawParticipant;
  if (typeof p.uid !== "string" || p.uid.length === 0) {
    throw new HttpsError(
      "invalid-argument",
      `participants[${index}].uid must be a non-empty string.`
    );
  }

  const keys = Object.keys(p);
  if (splitStrategy === "equal") {
    if (!keys.every((k) => k === "uid")) {
      throw new HttpsError(
        "invalid-argument",
        `participants[${index}] must contain only "uid" for an equal split.`
      );
    }
    return {uid: p.uid};
  }

  if (splitStrategy === "percentage") {
    if (!keys.every((k) => k === "uid" || k === "percentageBasisPoints")) {
      throw new HttpsError(
        "invalid-argument",
        `participants[${index}] must contain only "uid" and ` +
          "\"percentageBasisPoints\" for a percentage split."
      );
    }
    if (typeof p.percentageBasisPoints !== "number") {
      throw new HttpsError(
        "invalid-argument",
        `participants[${index}].percentageBasisPoints is required for ` +
          "a percentage split."
      );
    }
    return {uid: p.uid, percentageBasisPoints: p.percentageBasisPoints};
  }

  // custom
  if (!keys.every((k) => k === "uid" || k === "amountMinor")) {
    throw new HttpsError(
      "invalid-argument",
      `participants[${index}] must contain only "uid" and "amountMinor" ` +
        "for a custom split."
    );
  }
  if (typeof p.amountMinor !== "number") {
    throw new HttpsError(
      "invalid-argument",
      `participants[${index}].amountMinor is required for a custom split.`
    );
  }
  return {uid: p.uid, amountMinor: p.amountMinor};
}
