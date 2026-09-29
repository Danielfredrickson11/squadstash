// Firestore access + trusted-callable wrappers for Trip Settlements
// (Checkpoint 4E.3, per the frozen docs/audits/
// TRIP_BALANCES_SETTLEMENTS_PREFLIGHT_2026-09-28.md §10-§16, as hardened
// by 4E.0A/4E.2A). Structurally modeled on
// src/services/firebase/expenses.ts.
//
// Reads are direct Firestore queries/gets - tripSettlements is read-only
// from the client (firestore.rules denies every client create/update/
// delete unconditionally). Writes go exclusively through the trusted
// recordTripSettlement/reverseTripSettlement Cloud Functions via
// httpsCallable - this file contains NO addDoc/setDoc/updateDoc/
// deleteDoc/writeBatch/runTransaction against tripSettlements, and must
// never gain one.
//
// Settlements are LIVE-subscribed (status/reversal metadata can change
// after creation).
import { httpsCallable } from "firebase/functions";
import {
  Timestamp,
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  where,
} from "firebase/firestore";
import type { DocumentData, Unsubscribe } from "firebase/firestore";
import { db, functions } from "../../../firebase";
import type { Settlement, SettlementMethod } from "../../types/domain";

// ---------------------------------------------------------------------
// VALIDATION PRIMITIVES
// ---------------------------------------------------------------------

// Checkpoint 4E.3A hardening: identifier/audit-actor fields (tripId,
// fromUid, toUid, createdBy, reversedBy) must be genuinely non-blank - a
// whitespace-only value ("   ", "\t") must fail closed, not merely a
// zero-length one. Validation only - never trims/rewrites the persisted
// value.
function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value > 0;
}

// A real Firestore Timestamp instance - never a plain object/number/
// string that merely "looks like" one. Malformed persisted financial/
// audit-timing data is not a Settlement (mirrors expenses.ts's own
// isFirestoreTimestamp exactly).
function isFirestoreTimestamp(value: unknown): value is Timestamp {
  return value instanceof Timestamp;
}

function isValidSettlementMethod(value: unknown): value is SettlementMethod {
  return (
    value === "venmo" ||
    value === "paypal" ||
    value === "zelle" ||
    value === "cash" ||
    value === "other"
  );
}

function isValidSettlementStatus(
  value: unknown
): value is Settlement["status"] {
  return value === "active" || value === "reversed";
}

// Mirrors the trusted backend's own persisted-field length caps exactly
// (functions/src/callables/recordTripSettlement.ts's MAX_NOTE_LENGTH,
// functions/src/callables/reverseTripSettlement.ts's
// MAX_REVERSAL_REASON_LENGTH) - reader/writer contract limits, not
// client-invented restrictions.
const MAX_NOTE_LENGTH = 500;
const MAX_REVERSAL_REASON_LENGTH = 500;

// A "normalized non-empty trimmed string, at most maxLength characters" -
// the exact shape the trusted backend persists for a non-null note/
// reversalReason (already trimmed server-side; never blank/whitespace-
// only, never leading/trailing-whitespace, never oversized). Mirrors
// expenses.ts's own isNormalizedNonEmptyString exactly.
function isNormalizedNonEmptyString(
  value: unknown,
  maxLength: number
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value
  );
}

// ---------------------------------------------------------------------
// SETTLEMENT MAPPER - fail closed (Checkpoint 4E.3 §5/§6)
// ---------------------------------------------------------------------

// Strict field-by-field mapper. Never a whole-object cast, never
// String(...)/Number(...)/||/?? coercion of a malformed value into a
// fabricated default. Every load-bearing/discriminant field is
// validated; a document that fails validation throws rather than mapping
// to a lossy or fake shape - there is no third "invalid"/"unavailable"
// Settlement status, matching mapExpenseDocument's identical philosophy.
// Trusted backend-internal fields (creationRequest, reversalRequest) are
// never read here - their presence or absence has no bearing on whether
// this mapping succeeds.
export function mapSettlementDocument(
  id: string,
  data: DocumentData
): Settlement {
  const fail = (reason: string): never => {
    throw new Error(
      `mapSettlementDocument: invalid Settlement document "${id}" - ${reason}.`
    );
  };

  if (!isNonBlankString(data.tripId)) {
    fail("tripId must be a non-blank string");
  }
  if (!isNonBlankString(data.fromUid)) {
    fail("fromUid must be a non-blank string");
  }
  if (!isNonBlankString(data.toUid)) {
    fail("toUid must be a non-blank string");
  }
  // Checkpoint 4E.3A hardening: the trusted recordTripSettlement callable
  // guarantees fromUid !== toUid (functions/src/callables/
  // recordTripSettlement.ts's own isWellFormedCreationRequestSnapshot/
  // validateInput) - the mapper enforces the identical persisted
  // invariant rather than accepting a self-settlement as valid.
  if (data.fromUid === data.toUid) {
    fail("fromUid and toUid must not be the same person");
  }
  if (!isPositiveSafeInteger(data.amountMinor)) {
    fail("amountMinor must be a positive safe integer");
  }
  if (data.currency !== "USD") {
    fail('currency must be exactly "USD" for this milestone');
  }
  if (!isValidSettlementMethod(data.method)) {
    fail(
      'method must be one of "venmo", "paypal", "zelle", "cash", or "other"'
    );
  }
  if (!isFirestoreTimestamp(data.createdAt)) {
    fail("createdAt must be a real Firestore Timestamp");
  }
  if (!isNonBlankString(data.createdBy)) {
    fail("createdBy must be a non-blank string");
  }
  // Checkpoint 4E.3A hardening: the trusted recordTripSettlement callable
  // authorizes only authUid === toUid and persists createdBy = authUid -
  // so every legitimate persisted Settlement satisfies
  // createdBy === toUid. This is a public audit invariant (who recorded
  // this Settlement, and are they the recipient it claims), not
  // trusted-internal metadata, so the mapper enforces it directly.
  if (data.createdBy !== data.toUid) {
    fail("createdBy must equal toUid");
  }
  if (!isValidSettlementStatus(data.status)) {
    fail('status must be "active" or "reversed"');
  }

  // note is backend-normalized (recordTripSettlement.ts trims and
  // omits an empty/whitespace-only value before persisting) - the mapper
  // is a validator, not a normalizer, so an un-trimmed/empty persisted
  // value is itself a malformed document.
  let note: string | undefined;
  if (data.note !== undefined) {
    if (!isNormalizedNonEmptyString(data.note, MAX_NOTE_LENGTH)) {
      fail(
        "note, when present, must be a non-empty, already-trimmed " +
          `string of at most ${MAX_NOTE_LENGTH} characters`
      );
    }
    note = data.note;
  }

  let occurredAt: Timestamp | undefined;
  if (data.occurredAt !== undefined) {
    if (!isFirestoreTimestamp(data.occurredAt)) {
      fail("occurredAt, when present, must be a real Firestore Timestamp");
    }
    occurredAt = data.occurredAt;
  }

  // Reversal metadata: required and validated together when status is
  // "reversed"; must NOT be present on an "active" Settlement - a
  // present-but-contradictory reversal field on an active record is
  // itself a malformed document, never something to silently ignore
  // (mirrors mapExpenseDocument's identical reversal conditional-shape
  // rule exactly).
  let reversedAt: Timestamp | undefined;
  let reversedBy: string | undefined;
  let reversalReason: string | undefined;
  if (data.status === "reversed") {
    if (!isFirestoreTimestamp(data.reversedAt)) {
      fail(
        'reversedAt must be a real Firestore Timestamp when status is "reversed"'
      );
    }
    if (!isNonBlankString(data.reversedBy)) {
      fail('reversedBy must be a non-blank string when status is "reversed"');
    }
    // Checkpoint 4E.3A hardening: the trusted reverseTripSettlement
    // callable authorizes only authUid === settlement.toUid and persists
    // reversedBy = authUid - so every legitimately reversed Settlement
    // satisfies reversedBy === toUid. reversalReason remains optional;
    // this does not touch that.
    if (data.reversedBy !== data.toUid) {
      fail('reversedBy must equal toUid when status is "reversed"');
    }
    reversedAt = data.reversedAt;
    reversedBy = data.reversedBy;
    if (data.reversalReason !== undefined) {
      // reversalReason is OPTIONAL on a reversed Settlement - matches
      // reverseTripSettlement.ts's own trusted persisted contract
      // exactly: a non-null reversalReason is always already trimmed,
      // non-empty, and at most MAX_REVERSAL_REASON_LENGTH characters (a
      // null reason is never persisted - the field is deleted instead).
      if (
        !isNormalizedNonEmptyString(
          data.reversalReason,
          MAX_REVERSAL_REASON_LENGTH
        )
      ) {
        fail(
          "reversalReason, when present, must be a non-empty, already-" +
            `trimmed string of at most ${MAX_REVERSAL_REASON_LENGTH} characters`
        );
      }
      reversalReason = data.reversalReason;
    }
  } else if (
    data.reversedAt !== undefined ||
    data.reversedBy !== undefined ||
    data.reversalReason !== undefined
  ) {
    // Reversal metadata belongs only to a "reversed" Settlement - any of
    // reversedAt/reversedBy/reversalReason present on an "active" record
    // is itself a malformed document. This does NOT inspect the
    // backend-internal reversalRequest field, which is never part of
    // the public Settlement mapper.
    fail(
      'reversedAt/reversedBy/reversalReason must not be present when status is "active"'
    );
  }

  const settlement: Settlement = {
    id,
    tripId: data.tripId,
    fromUid: data.fromUid,
    toUid: data.toUid,
    amountMinor: data.amountMinor,
    currency: data.currency,
    method: data.method,
    createdAt: data.createdAt,
    createdBy: data.createdBy,
    status: data.status,
  };
  if (note !== undefined) settlement.note = note;
  if (occurredAt !== undefined) settlement.occurredAt = occurredAt;
  if (reversedAt !== undefined) settlement.reversedAt = reversedAt;
  if (reversedBy !== undefined) settlement.reversedBy = reversedBy;
  if (reversalReason !== undefined) settlement.reversalReason = reversalReason;

  return settlement;
}

// ---------------------------------------------------------------------
// HISTORY ORDERING (Checkpoint 4E.3 §7)
// ---------------------------------------------------------------------

// occurredAt represents when the external payment happened; createdAt
// represents when SquadStash recorded it. occurredAt is preferred when
// present, falling back to the always-present createdAt - identical
// precedence to expenseHistoryTimestamp in expenses.ts.
function settlementHistoryTimestamp(settlement: Settlement): Timestamp {
  return settlement.occurredAt ?? settlement.createdAt;
}

// Deterministic descending sort: primarily by occurredAt ?? createdAt,
// tie-broken by ascending Settlement document id (never Firestore's own
// incidental snapshot return order, which is not a documented ordering
// guarantee for an unordered `where` query). Never mutates the input.
export function sortSettlementsForHistory(
  settlements: Settlement[]
): Settlement[] {
  return [...settlements].sort((a, b) => {
    const aMs = settlementHistoryTimestamp(a).toMillis();
    const bMs = settlementHistoryTimestamp(b).toMillis();
    if (aMs !== bMs) return bMs - aMs;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ---------------------------------------------------------------------
// ROUTE-tripId INTEGRITY (Checkpoint 4E.3 §8, load-bearing)
// ---------------------------------------------------------------------

// Firestore Rules answer "may this signed-in user read this document?".
// This answers a different question: "does this document belong to the
// Trip this screen/route represents?" A user may legitimately be a
// current member of more than one Trip - without this check, a Rules-
// authorized-but-wrong-Trip Settlement could otherwise render inside
// another Trip's own screen. Mirrors expenseBelongsToTrip exactly.
export function settlementBelongsToTrip(
  settlement: Settlement,
  tripId: string
): boolean {
  return settlement.tripId === tripId;
}

// ---------------------------------------------------------------------
// READS
// ---------------------------------------------------------------------

function settlementDocRef(settlementId: string) {
  return doc(db, "tripSettlements", settlementId);
}

function tripSettlementsQuery(tripId: string) {
  return query(
    collection(db, "tripSettlements"),
    where("tripId", "==", tripId)
  );
}

// No orderBy - client-side sorting (sortSettlementsForHistory above)
// avoids introducing a composite index (preflight §13);
// firestore.indexes.json has no tripSettlements index today and this
// checkpoint does not add one.
export function subscribeToSettlementsForTrip(
  tripId: string,
  onChange: (settlements: Settlement[]) => void,
  onError?: (error: unknown) => void
): Unsubscribe {
  return onSnapshot(
    tripSettlementsQuery(tripId),
    (snap) => {
      try {
        const next: Settlement[] = [];
        snap.forEach((docSnap) => {
          const settlement = mapSettlementDocument(
            docSnap.id,
            docSnap.data() as DocumentData
          );
          // Defensive re-check even though the query already constrains
          // tripId - never trust the query shape alone (mirrors
          // fetchExpenseSplitsForExpense's identical discipline).
          if (!settlementBelongsToTrip(settlement, tripId)) {
            throw new Error(
              `subscribeToSettlementsForTrip: returned Settlement "${docSnap.id}" ` +
                "does not match the requested tripId."
            );
          }
          next.push(settlement);
        });
        onChange(sortSettlementsForHistory(next));
      } catch (mappingError) {
        // A mapping exception thrown inside an onSnapshot success
        // callback is NOT automatically routed through Firestore's own
        // onError - it must be caught and forwarded explicitly. Never
        // emit a partial list with the bad record silently dropped and
        // the rest presented as complete (mirrors
        // subscribeToExpensesForTrip's identical discipline).
        if (onError) {
          onError(mappingError);
        } else {
          console.error(
            "subscribeToSettlementsForTrip: mapping failed",
            mappingError
          );
        }
      }
    },
    onError
  );
}

// Route-tripId-bound (§8 above): a Settlement whose own tripId does not
// match the caller's expected tripId is treated as not found for this
// route context, never exposed.
export function subscribeToSettlementById(
  tripId: string,
  settlementId: string,
  onChange: (settlement: Settlement | null) => void,
  onError?: (error: unknown) => void
): Unsubscribe {
  return onSnapshot(
    settlementDocRef(settlementId),
    (snap) => {
      if (!snap.exists()) {
        onChange(null);
        return;
      }
      try {
        const settlement = mapSettlementDocument(
          snap.id,
          snap.data() as DocumentData
        );
        onChange(
          settlementBelongsToTrip(settlement, tripId) ? settlement : null
        );
      } catch (mappingError) {
        if (onError) {
          onError(mappingError);
        } else {
          console.error(
            "subscribeToSettlementById: mapping failed",
            mappingError
          );
        }
      }
    },
    onError
  );
}

export async function fetchSettlementById(
  tripId: string,
  settlementId: string
): Promise<Settlement | null> {
  const snap = await getDoc(settlementDocRef(settlementId));
  if (!snap.exists()) return null;
  const settlement = mapSettlementDocument(
    snap.id,
    snap.data() as DocumentData
  );
  return settlementBelongsToTrip(settlement, tripId) ? settlement : null;
}

// ---------------------------------------------------------------------
// CLIENT REQUEST ID (Checkpoint 4E.3 §12)
// ---------------------------------------------------------------------

// Reads the id off a Firestore DocumentReference built by the client
// SDK's own auto-id generator - no document is created, no network call
// is made. Mirrors generateExpenseClientRequestId/
// generateSavingsClientRequestId/generateBucketClientRequestId exactly
// (never crypto.randomUUID(), no new dependency). The controller layer
// (4E.4) owns when a request id is reused across a retry.
export function generateSettlementClientRequestId(): string {
  return doc(collection(db, "tripSettlements")).id;
}

// ---------------------------------------------------------------------
// recordTripSettlement (Checkpoint 4E.3 §13-§16)
// ---------------------------------------------------------------------

// Deliberately NOT src/types/domain/settlement.ts's own
// CreateSettlementInput - that type has no clientRequestId shape at all.
// occurredAt remains supported here because the trusted callable accepts
// it for a future/internal caller (preflight §12); the 4E MVP UI simply
// never supplies it - this service must not remove the capability merely
// because the first UI omits it.
export type RecordTripSettlementInput = {
  tripId: string;
  fromUid: string;
  toUid: string;
  amountMinor: number;
  currency: "USD";
  method: SettlementMethod;
  note?: string;
  occurredAt?: Date;
  clientRequestId: string;
};

type RecordTripSettlementRequest = {
  tripId: string;
  fromUid: string;
  toUid: string;
  amountMinor: number;
  currency: "USD";
  method: SettlementMethod;
  note?: string;
  occurredAt?: string;
  clientRequestId: string;
};

// Pure request-shaping, exported for direct testing without any Firebase
// mocking. Never invents createdBy/status/reversedAt/reversedBy/
// reversalReason/creationRequest/reversalRequest on the wire payload -
// this type simply has no way to carry any of them. Does NOT normalize/
// trim note - the trusted backend owns canonical validation/
// normalization, matching buildRecordTripExpenseRequest's own discipline.
export function buildRecordTripSettlementRequest(
  input: RecordTripSettlementInput
): RecordTripSettlementRequest {
  const request: RecordTripSettlementRequest = {
    tripId: input.tripId,
    fromUid: input.fromUid,
    toUid: input.toUid,
    amountMinor: input.amountMinor,
    currency: input.currency,
    method: input.method,
    clientRequestId: input.clientRequestId,
  };
  if (input.note !== undefined) {
    request.note = input.note;
  }
  if (input.occurredAt !== undefined) {
    if (Number.isNaN(input.occurredAt.getTime())) {
      throw new Error(
        "recordTripSettlement: occurredAt is an invalid Date."
      );
    }
    // Full ISO instant with an explicit "Z" timezone - never a date-only
    // value.
    request.occurredAt = input.occurredAt.toISOString();
  }
  return request;
}

export type RecordTripSettlementResult = { settlementId: string };

// Validates the callable's response field-by-field rather than trusting
// a whole-object cast, matching parseRecordTripExpenseResponse's own
// established discipline exactly.
export function parseRecordTripSettlementResponse(
  data: unknown
): RecordTripSettlementResult {
  if (typeof data !== "object" || data === null) {
    throw new Error(
      "recordTripSettlement: invalid response (expected an object)."
    );
  }
  const { settlementId } = data as Record<string, unknown>;
  if (typeof settlementId !== "string" || settlementId.length === 0) {
    throw new Error(
      "recordTripSettlement: invalid response (settlementId must be a non-empty string)."
    );
  }
  return { settlementId };
}

// The sole write path for creating a tripSettlements document: invokes
// the trusted recordTripSettlement Cloud Function via httpsCallable.
// Callable errors (HttpsError/FirebaseError) are not caught or wrapped -
// they propagate to the caller unchanged, matching every other trusted-
// write wrapper in this codebase. Never inserts an optimistic local
// Settlement, never performs a direct Firestore write.
export async function recordTripSettlement(
  input: RecordTripSettlementInput
): Promise<RecordTripSettlementResult> {
  const payload = buildRecordTripSettlementRequest(input);
  const callable = httpsCallable<RecordTripSettlementRequest, unknown>(
    functions,
    "recordTripSettlement"
  );
  const res = await callable(payload);
  return parseRecordTripSettlementResponse(res.data);
}

// ---------------------------------------------------------------------
// reverseTripSettlement (Checkpoint 4E.3 §17-§18)
// ---------------------------------------------------------------------

// Deliberately no tripId - the backend derives it from the persisted
// Settlement document itself. Also deliberately does not normalize
// reversalReason or own any idempotency-retry policy - that belongs to
// the later 4E.4 UI/domain controller. This wrapper transmits the
// supplied optional reason faithfully, as-is.
export type ReverseTripSettlementInput = {
  settlementId: string;
  reversalReason?: string;
  clientRequestId: string;
};

type ReverseTripSettlementRequest = {
  settlementId: string;
  reversalReason?: string;
  clientRequestId: string;
};

export type ReverseTripSettlementResult = { settlementId: string };

export function parseReverseTripSettlementResponse(
  data: unknown
): ReverseTripSettlementResult {
  if (typeof data !== "object" || data === null) {
    throw new Error(
      "reverseTripSettlement: invalid response (expected an object)."
    );
  }
  const { settlementId } = data as Record<string, unknown>;
  if (typeof settlementId !== "string" || settlementId.length === 0) {
    throw new Error(
      "reverseTripSettlement: invalid response (settlementId must be a non-empty string)."
    );
  }
  return { settlementId };
}

// The sole write path for reversing a tripSettlements document. Never
// updates Firestore status directly, never normalizes reversal authority
// client-side - the backend remains the sole authority for all of that.
// Callable errors propagate unchanged, matching recordTripSettlement's
// own convention above.
export async function reverseTripSettlement(
  input: ReverseTripSettlementInput
): Promise<ReverseTripSettlementResult> {
  const payload: ReverseTripSettlementRequest = {
    settlementId: input.settlementId,
    clientRequestId: input.clientRequestId,
  };
  if (input.reversalReason !== undefined) {
    payload.reversalReason = input.reversalReason;
  }
  const callable = httpsCallable<ReverseTripSettlementRequest, unknown>(
    functions,
    "reverseTripSettlement"
  );
  const res = await callable(payload);
  return parseReverseTripSettlementResponse(res.data);
}
