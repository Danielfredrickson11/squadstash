import {FieldValue, Timestamp, getFirestore} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";

type CallableAuth = CallableRequest["auth"];

// Checkpoint 4E.2, per the frozen docs/audits/
// TRIP_BALANCES_SETTLEMENTS_PREFLIGHT_2026-09-28.md §10/§12 (as hardened
// by 4E.0A/4E.0A.1). Mirrors SettlementMethod (src/types/domain/
// settlement.ts) - a local, duplicated literal union, never imported
// from src/types/domain, matching the established precedent that no
// trusted callable in this package imports its wire-input shape from the
// client-facing domain types (see recordTripExpense.ts's own note).
type SettlementMethod = "venmo" | "paypal" | "zelle" | "cash" | "other";

// The callable's own raw wire-input shape.
interface RecordTripSettlementInput {
  tripId: string;
  fromUid: string;
  toUid: string;
  amountMinor: number;
  currency: string;
  method: SettlementMethod;
  note?: string;
  // ISO 8601 date-time WITH AN EXPLICIT TIMEZONE - identical contract to
  // recordTripExpense.ts's own occurredAt (§5 of the preflight). Accepted
  // for a future/internal caller (e.g. a bulk import); the 4E MVP manual
  // Settlement UI never sends this field at all.
  occurredAt?: string;
  clientRequestId: string;
}

// validateInput's actual return shape - RecordTripSettlementInput with
// `occurredAt` (the raw string) replaced by its already-parsed forms,
// computed once here, never re-parsed downstream (mirrors
// recordTripExpense.ts's own ValidatedInput precisely). note is
// normalized (trimmed) but keeps the same string|undefined shape
// category has in recordTripExpense.ts - the creationRequest snapshot
// below is what always carries the string|null form.
interface ValidatedInput extends Omit<RecordTripSettlementInput, "occurredAt"> {
  occurredAtInstantMs: number | null;
  occurredAtTimestamp: Timestamp | undefined;
}

// The server-normalized creationRequest snapshot compared on replay
// (preflight §6/§7 of the checkpoint prompt). Deliberately does NOT
// include createdBy - that stays a separate, top-level persisted field
// compared independently, exactly mirroring recordTripExpense.ts's own
// NormalizedCreationRequest/creationRequest split.
interface NormalizedCreationRequest {
  tripId: string;
  fromUid: string;
  toUid: string;
  amountMinor: number;
  currency: string;
  method: SettlementMethod;
  note: string | null;
  occurredAtInstantMs: number | null;
}

interface RecordTripSettlementResult {
  settlementId: string;
}

// Duplicated per-file (not shared) - the established, deliberate
// per-callable-file duplication convention already used throughout this
// package (see recordTripExpense.ts's own isTripArchived comment).
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
// Reuses the existing MAX_DESCRIPTION_LENGTH/MAX_REVERSAL_REASON_LENGTH
// precedent value (500) - note plays the same "free text explaining what
// this record is for" role.
const MAX_NOTE_LENGTH = 500;
const MAX_FIRESTORE_DOCUMENT_ID_BYTES = 1500;

// Identical pattern/reasoning to recordTripExpense.ts's own
// ISO_INSTANT_PATTERN - requires the full extended date-time form WITH
// AN EXPLICIT TIMEZONE designator; a date-only string is rejected, since
// this field names a specific instant, never a calendar day. Fractional
// seconds capped at 1-3 digits (millisecond precision), matching what
// Date/Timestamp actually carry.
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

const SETTLEMENT_METHODS: ReadonlySet<string> = new Set([
  "venmo",
  "paypal",
  "zelle",
  "cash",
  "other",
]);

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "tripId",
  "fromUid",
  "toUid",
  "amountMinor",
  "currency",
  "method",
  "note",
  "occurredAt",
  "clientRequestId",
]);

/**
 * True if id satisfies Firestore's own document-id constraints (never
 * empty, never exactly "." or "..", never containing "/", and never
 * exceeding Firestore's maximum document-id byte length) - the exact set
 * of shapes that would otherwise make `.doc(id)` throw synchronously.
 * Duplicated verbatim from recordTripExpense.ts - see this file's own
 * top-of-file duplication note.
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
 * recordTripSettlement
 * Input: {
 *   tripId: string, fromUid: string, toUid: string, amountMinor: number,
 *   currency: string, method: "venmo"|"paypal"|"zelle"|"cash"|"other",
 *   note?: string, occurredAt?: string, clientRequestId: string,
 * }
 * Output: { settlementId: string }
 *
 * Security (docs/audits/TRIP_BALANCES_SETTLEMENTS_PREFLIGHT_2026-09-28.md
 * §6/§7/§8/§9/§10/§12, as hardened by 4E.0A/4E.0A.1):
 * - Requires caller to be signed in.
 * - A Settlement means "the recipient confirms they received an external
 *   payment" - SquadStash never moves money itself. The debtor cannot
 *   unilaterally clear their own debt.
 * - Idempotent replay is bound to BOTH the original creator (stored
 *   createdBy === authUid) AND an exact normalized creationRequest match
 *   against a CANONICAL stored snapshot (§2 of the 4E.2A hardening) -
 *   evaluated from ONLY the Settlement document itself, never reading the
 *   parent Trip at all in either the exact-replay or collision outcome.
 *   This is historical reconciliation, never a fresh authorization
 *   decision, and is genuinely independent of the Trip's existence AND
 *   of this transaction's own read-set/version.
 * - Authorization for a NEW Settlement: authUid MUST equal toUid (the
 *   recipient, and only the recipient, may confirm receipt), AND authUid
 *   must be a CURRENT Trip member. The Trip owner gets no special
 *   authority merely by being owner - only by also being toUid.
 * - fromUid must ALSO be a current Trip member (checked independently,
 *   after caller authorization succeeds) - failed-precondition, not
 *   permission-denied, since this is a validity constraint on the
 *   financial fact being created, not the caller's own authorization.
 *   4E MVP deliberately does not support a departed fromUid - there is no
 *   trusted historical-membership registry yet (§7 of the preflight).
 * - Settlement creation is NEVER gated on Trip archive state - resolving
 *   a pre-existing debt must remain possible after a Trip wraps up (§9).
 * - This is the sole trusted write path for tripSettlements; direct
 *   client creation is closed by Firestore Rules (§13/§18).
 * - Never reads or writes tripExpenses/tripExpenseSplits/buckets/
 *   savingsTransactions - no cached balance is computed or persisted
 *   anywhere, and over-settlement is never hard-capped server-side
 *   (§8 - a future client-side advisory only).
 */
export const recordTripSettlement = onCall(async (request) => {
  const authUid = requireAuthenticatedUid(request.auth);

  return recordTripSettlementCore(getFirestore(), authUid, request.data);
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
 * @return {Promise<RecordTripSettlementResult>} The new/idempotently
 *   replayed Settlement's document id.
 */
export async function recordTripSettlementCore(
  db: Firestore,
  authUid: string,
  rawInput: unknown
): Promise<RecordTripSettlementResult> {
  const input = validateInput(rawInput);

  const creationRequest: NormalizedCreationRequest = {
    tripId: input.tripId,
    fromUid: input.fromUid,
    toUid: input.toUid,
    amountMinor: input.amountMinor,
    currency: input.currency,
    method: input.method,
    note: input.note ?? null,
    occurredAtInstantMs: input.occurredAtInstantMs,
  };

  const settlementRef = db
    .collection("tripSettlements")
    .doc(input.clientRequestId);
  const tripRef = db.collection("trips").doc(input.tripId);

  return db.runTransaction(async (tx) => {
    // A. Read ONLY the Settlement doc first - Checkpoint 4E.2A hardening:
    // the Trip is deliberately NOT read yet. This makes exact replay
    // genuinely independent of the parent Trip's existence AND of this
    // transaction's own read-set/version, not merely independent in
    // effect - a concurrent write to the Trip document can never force
    // this transaction to retry when the caller is only reconciling
    // their own already-committed request.
    const existingSettlementSnap = await tx.get(settlementRef);

    // B. Existing Settlement / idempotent replay - evaluated entirely
    // from data already loaded above, no additional read of any kind.
    // Bound to BOTH the original creator and an exact normalized-facts
    // match against a CANONICAL stored snapshot; a mismatch on either
    // (including a malformed/non-canonical stored creationRequest)
    // produces the identical already-exists outcome (anti-enumeration -
    // a caller can never distinguish "someone else already used this id"
    // from "you used this id for something different"). This branch
    // never reads the Trip, in either outcome - the original creator can
    // always reconcile their own already-committed request even if the
    // Trip was later archived, they were later removed from Trip
    // membership, or the parent Trip document itself is unexpectedly
    // missing.
    if (existingSettlementSnap.exists) {
      const stored =
        existingSettlementSnap.data() as FirebaseFirestore.DocumentData;
      if (
        stored.createdBy !== authUid ||
        !creationRequestsMatch(stored.creationRequest, creationRequest)
      ) {
        throw new HttpsError(
          "already-exists",
          "clientRequestId was already used for a different request."
        );
      }
      return {settlementId: input.clientRequestId};
    }

    // C. Only for a GENUINELY NEW Settlement (no existing document for
    // this clientRequestId): read and require the parent Trip. This is
    // the FIRST point in this transaction the Trip is ever read - still
    // strictly before any write, satisfying Firestore's own
    // reads-before-writes transaction requirement.
    const tripSnap = await tx.get(tripRef);
    if (!tripSnap.exists) {
      throw new HttpsError("not-found", "No trip found for the given tripId.");
    }
    const tripData = tripSnap.data() as FirebaseFirestore.DocumentData;

    // D. Authorization - the recipient, and only the recipient, may
    // confirm a Settlement (preflight §6). Combined into one boolean and
    // one throw (never distinguishing which half failed), matching
    // reverseTripExpense.ts's own isOwner/isOriginalCreatorStillMember
    // combined-check style - an unauthorized caller learns nothing about
    // which specific condition they failed.
    const isAuthorizedRecipient =
      authUid === input.toUid && isCurrentTripMember(tripData, authUid);
    if (!isAuthorizedRecipient) {
      throw new HttpsError(
        "permission-denied",
        "You may only record a settlement you personally received, " +
          "as a current member of this trip."
      );
    }

    // D2. Only for an AUTHORIZED caller: now it's safe to disclose that
    // the Trip's own data is structurally corrupt.
    if (!Array.isArray(tripData.memberIds)) {
      throw new HttpsError(
        "failed-precondition",
        "Trip has malformed memberIds."
      );
    }

    // D3 (Checkpoint 4E.0A §6/§7): fromUid must ALSO be a current Trip
    // member - a validity constraint on the financial fact being
    // created, not the caller's own authorization boundary, so
    // failed-precondition rather than permission-denied. 4E MVP
    // deliberately does not support a departed fromUid.
    if (!isCurrentTripMember(tripData, input.fromUid)) {
      throw new HttpsError(
        "failed-precondition",
        "fromUid is not a current member of this trip."
      );
    }

    // E. No archive check - deliberately omitted (preflight §9/§10).
    // Resolving a pre-existing debt must remain possible on an archived
    // Trip.

    // F. Persist the new Settlement.
    const settlementData: Record<string, unknown> = {
      tripId: input.tripId,
      fromUid: input.fromUid,
      toUid: input.toUid,
      amountMinor: input.amountMinor,
      currency: "USD",
      method: input.method,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: authUid,
      status: "active",
      creationRequest,
    };
    if (input.note !== undefined) {
      settlementData.note = input.note;
    }
    if (input.occurredAtTimestamp !== undefined) {
      settlementData.occurredAt = input.occurredAtTimestamp;
    }
    tx.set(settlementRef, settlementData);

    return {settlementId: input.clientRequestId};
  });
}

/**
 * True if uid is a current member of the Trip (memberIds or ownerId).
 * Never trusts client-supplied membership - always reads from the Trip
 * data loaded fresh inside the transaction. Malformed-safe: a non-array
 * memberIds is treated as empty, so only the independent ownerId
 * fallback can authorize in that case. Duplicated verbatim from
 * recordTripExpense.ts - see this file's own top-of-file duplication
 * note.
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

// Checkpoint 4E.2A hardening: the exact, canonical key set this callable
// ever writes into creationRequest - no more, no fewer.
const CREATION_REQUEST_KEYS = new Set([
  "tripId",
  "fromUid",
  "toUid",
  "amountMinor",
  "currency",
  "method",
  "note",
  "occurredAtInstantMs",
]);

/**
 * True if value has the EXACT canonical NormalizedCreationRequest shape
 * this callable itself ever writes - not merely "roughly the right
 * types" - because a malformed/non-canonical stored snapshot must NEVER
 * accidentally count as an exact replay. Mirrors
 * reverseTripExpense.ts's own isWellFormedReversalRequestSnapshot
 * precisely. `tripSettlements` has never been deployed, so there is no
 * legacy-compatibility shape to tolerate: every genuinely-persisted
 * snapshot this function will ever see was written by THIS trusted
 * callable and must match its own canonical contract exactly - anything
 * else is necessarily corrupted or forged, and must fail closed rather
 * than be coerced into a plausible-looking match.
 * @param {unknown} value The candidate value.
 * @return {boolean} True if value is an exact, canonical, well-formed
 *   creationRequest.
 */
function isWellFormedCreationRequestSnapshot(
  value: unknown
): value is NormalizedCreationRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;

  const keys = Object.keys(v);
  if (
    keys.length !== CREATION_REQUEST_KEYS.size ||
    !keys.every((k) => CREATION_REQUEST_KEYS.has(k))
  ) {
    return false;
  }

  if (typeof v.tripId !== "string" || !isValidFirestoreDocumentId(v.tripId)) {
    return false;
  }
  if (typeof v.fromUid !== "string" || v.fromUid.trim().length === 0) {
    return false;
  }
  if (typeof v.toUid !== "string" || v.toUid.trim().length === 0) {
    return false;
  }
  if (v.fromUid === v.toUid) {
    return false;
  }
  if (
    typeof v.amountMinor !== "number" ||
    !Number.isSafeInteger(v.amountMinor) ||
    v.amountMinor <= 0
  ) {
    return false;
  }
  if (v.currency !== "USD") {
    return false;
  }
  if (typeof v.method !== "string" || !SETTLEMENT_METHODS.has(v.method)) {
    return false;
  }
  // note: exactly null, OR a non-empty, already-trimmed string of at
  // most MAX_NOTE_LENGTH characters - the exact canonical shape
  // validateInput ever produces (never "", never whitespace-only, never
  // untrimmed, never oversized).
  if (v.note !== null) {
    if (
      typeof v.note !== "string" ||
      v.note.length === 0 ||
      v.note.length > MAX_NOTE_LENGTH ||
      v.note.trim() !== v.note
    ) {
      return false;
    }
  }
  // occurredAtInstantMs: exactly null, OR a safe integer - never coerced
  // from a missing key or a wrong type into null.
  if (v.occurredAtInstantMs !== null) {
    if (
      typeof v.occurredAtInstantMs !== "number" ||
      !Number.isSafeInteger(v.occurredAtInstantMs)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * True if a previously-stored creationRequest snapshot is CANONICALLY
 * well-formed AND exactly matches an incoming normalized snapshot.
 * Checkpoint 4E.2A hardening: a malformed/non-canonical stored snapshot
 * can never count as a match, regardless of whether its individual
 * fields happen to superficially agree with the incoming request -
 * `tripSettlements` has never been deployed, so every genuinely-
 * persisted snapshot is already canonical by construction; anything else
 * is necessarily corrupted or forged and must fall through to
 * already-exists, never a successful replay. Explicit field-by-field
 * comparison (never a blind JSON.stringify equality) once well-formedness
 * is confirmed. createdBy is deliberately NOT compared here - it is
 * checked separately, one level up, against the Settlement document's
 * own top-level field.
 * @param {unknown} stored The persisted creationRequest map, as read back
 *   from Firestore.
 * @param {NormalizedCreationRequest} incoming The incoming normalized
 *   snapshot.
 * @return {boolean} True if the stored snapshot is well-formed AND every
 *   compared fact matches exactly.
 */
function creationRequestsMatch(
  stored: unknown,
  incoming: NormalizedCreationRequest
): boolean {
  if (!isWellFormedCreationRequestSnapshot(stored)) {
    return false;
  }
  return (
    stored.tripId === incoming.tripId &&
    stored.fromUid === incoming.fromUid &&
    stored.toUid === incoming.toUid &&
    stored.amountMinor === incoming.amountMinor &&
    stored.currency === incoming.currency &&
    stored.method === incoming.method &&
    stored.note === incoming.note &&
    stored.occurredAtInstantMs === incoming.occurredAtInstantMs
  );
}

/**
 * Validates and narrows a raw callable request body. Strict top-level
 * field validation: any key not in ALLOWED_TOP_LEVEL_KEYS is rejected
 * outright (invalid-argument) rather than silently ignored - this is how
 * an attempt to inject createdBy/status/reversedAt/reversedBy/
 * reversalReason/creationRequest/id is caught before ever reaching
 * Firestore.
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
    typeof data.tripId !== "string" ||
    !isValidFirestoreDocumentId(data.tripId)
  ) {
    throw new HttpsError(
      "invalid-argument",
      "tripId must be a non-empty, valid Firestore document id."
    );
  }
  if (typeof data.fromUid !== "string" || data.fromUid.trim().length === 0) {
    throw new HttpsError(
      "invalid-argument",
      "fromUid must be a non-empty identifier."
    );
  }
  if (typeof data.toUid !== "string" || data.toUid.trim().length === 0) {
    throw new HttpsError(
      "invalid-argument",
      "toUid must be a non-empty identifier."
    );
  }
  if (data.fromUid === data.toUid) {
    throw new HttpsError(
      "invalid-argument",
      "fromUid and toUid must not be the same person."
    );
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
  if (typeof data.method !== "string" || !SETTLEMENT_METHODS.has(data.method)) {
    throw new HttpsError(
      "invalid-argument",
      "method must be one of \"venmo\", \"paypal\", \"zelle\", \"cash\", " +
        "or \"other\"."
    );
  }
  const method = data.method as SettlementMethod;

  let note: string | undefined;
  if (data.note !== undefined) {
    if (typeof data.note !== "string") {
      throw new HttpsError("invalid-argument", "note must be a string.");
    }
    const trimmed = data.note.trim();
    if (trimmed.length > MAX_NOTE_LENGTH) {
      throw new HttpsError(
        "invalid-argument",
        `note must be at most ${MAX_NOTE_LENGTH} characters.`
      );
    }
    // Checkpoint 4E preflight §16 (idempotency/normalization): omitted OR
    // whitespace-only both normalize to the SAME logical fact (absent) -
    // never treated as two different facts, matching reversalReason's
    // own established convention exactly.
    note = trimmed.length > 0 ? trimmed : undefined;
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
    fromUid: data.fromUid,
    toUid: data.toUid,
    amountMinor: data.amountMinor,
    currency: data.currency,
    method,
    note,
    occurredAtInstantMs,
    occurredAtTimestamp,
    clientRequestId: data.clientRequestId,
  };
}

/**
 * Parses and validates an occurredAt string against the documented
 * contract: an ISO 8601 date-time string WITH AN EXPLICIT TIMEZONE.
 * Identical logic to recordTripExpense.ts's own parseOccurredAt - see
 * that file's comment for the full rationale (never a date-only or
 * locale-formatted string; converts to a Firestore Timestamp inside a
 * try/catch so an out-of-range instant surfaces as invalid-argument
 * rather than an uncaught exception).
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
