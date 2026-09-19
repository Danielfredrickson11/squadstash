// Firestore access + trusted-callable wrappers for Trip Expenses
// (Checkpoint 4D.1B, per the frozen docs/audits/
// TRIP_EXPENSE_UI_UX_PREFLIGHT_2026-09-18.md, as hardened by 4D.0A/4D.0B).
//
// Reads are direct Firestore queries/gets - tripExpenses/tripExpenseSplits
// are read-only from the client (firestore.rules denies every client
// create/update/delete unconditionally). Writes go exclusively through the
// trusted recordTripExpense/reverseTripExpense Cloud Functions via
// httpsCallable - this file contains NO addDoc/setDoc/updateDoc/
// deleteDoc/writeBatch/runTransaction against either collection, and must
// never gain one.
//
// Expenses are LIVE-subscribed (status/reversal/correction-link fields can
// change after creation); ExpenseSplits are read ONE-SHOT (immutable after
// their single atomic creation inside recordTripExpenseCore's own
// transaction - a permanent listener on data that can never change again
// buys nothing).
import { httpsCallable } from "firebase/functions";
import {
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  where,
} from "firebase/firestore";
import type { DocumentData, Unsubscribe } from "firebase/firestore";
import { db, functions } from "../../../firebase";
import type {
  Expense,
  ExpensePaymentSource,
  ExpenseSplit,
  ExpenseStatus,
  SplitStrategy,
} from "../../types/domain";

// ---------------------------------------------------------------------
// VALIDATION PRIMITIVES
// ---------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0;
}

// A real Firestore Timestamp instance - never a plain object/number/
// string that merely "looks like" one. Malformed persisted financial/
// audit-timing data is not an Expense (Checkpoint 4D.1B §10).
function isFirestoreTimestamp(value: unknown): value is Timestamp {
  return value instanceof Timestamp;
}

// Manual UTF-8 byte-length count - deliberately NOT Buffer.byteLength
// (Buffer is a Node.js global, unavailable on React Native/Hermes - using
// it here would crash on-device) and not a TextEncoder dependency
// assumption either. Pure, dependency-free, directly testable.
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const codePoint = value.codePointAt(i);
    if (codePoint === undefined) continue;
    if (codePoint > 0xffff) i++; // a surrogate pair consumes two UTF-16 units
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

// Mirrors functions/src/callables/recordTripExpense.ts's own
// isValidFirestoreDocumentId exactly (real Firestore document-id
// constraints, not a client-invented restriction) - reused here so a
// correction-link id (replacesExpenseId/replacedByExpenseId) is only ever
// trusted for later navigation when it's actually shaped like a document
// id, never a malformed value that would throw if passed to doc(...).
const MAX_FIRESTORE_DOCUMENT_ID_BYTES = 1500;
function isValidFirestoreDocumentIdShape(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value === "." || value === "..") return false;
  if (value.includes("/")) return false;
  return utf8ByteLength(value) <= MAX_FIRESTORE_DOCUMENT_ID_BYTES;
}

function isValidSplitStrategy(value: unknown): value is SplitStrategy {
  return value === "equal" || value === "percentage" || value === "custom";
}

function isValidPaymentSource(value: unknown): value is ExpensePaymentSource {
  return value === "member_out_of_pocket" || value === "shared_stash";
}

function isValidStatus(value: unknown): value is ExpenseStatus {
  return value === "active" || value === "reversed";
}

// Mirror the trusted backend's own persisted-field length caps exactly
// (functions/src/callables/recordTripExpense.ts's MAX_DESCRIPTION_LENGTH/
// MAX_CATEGORY_LENGTH, functions/src/callables/reverseTripExpense.ts's
// MAX_REVERSAL_REASON_LENGTH) - Checkpoint 4D.1B.1 §2/§4/§6. These are
// reader/writer contract limits, not client-invented restrictions.
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_CATEGORY_LENGTH = 100;
const MAX_REVERSAL_REASON_LENGTH = 500;

// A "normalized non-empty trimmed string, at most maxLength characters" -
// the exact shape reverseTripExpense.ts persists for a non-null
// reversalReason (already trimmed server-side; never blank/whitespace-only,
// never leading/trailing-whitespace, never oversized).
function isNormalizedNonEmptyString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value
  );
}

// ---------------------------------------------------------------------
// EXPENSE MAPPER - fail closed (Checkpoint 4D.1B §10/§11)
// ---------------------------------------------------------------------

// Strict field-by-field mapper. Never a whole-object cast, never
// String(...)/Number(...)/||/?? coercion of a malformed value into a
// fabricated default. Every load-bearing/discriminant field is validated;
// a document that fails validation throws rather than mapping to a lossy
// or fake shape (there is no third "invalid"/"unavailable" Expense
// status - malformed persisted data is simply not an Expense, per the
// preflight §8). Trusted backend-internal fields (creationRequest,
// reversalRequest) are never read here - their presence or absence has no
// bearing on whether this mapping succeeds (§11).
export function mapExpenseDocument(id: string, data: DocumentData): Expense {
  const fail = (reason: string): never => {
    throw new Error(
      `mapExpenseDocument: invalid Expense document "${id}" - ${reason}.`
    );
  };

  if (!isNonEmptyString(data.tripId)) {
    fail("tripId must be a non-empty string");
  }
  if (!isNonEmptyString(data.createdBy)) {
    fail("createdBy must be a non-empty string");
  }
  if (!isPositiveSafeInteger(data.amountMinor)) {
    fail("amountMinor must be a positive safe integer");
  }
  if (data.currency !== "USD") {
    fail('currency must be exactly "USD" for this milestone');
  }
  // description is backend-normalized (recordTripExpense.ts does
  // `data.description.trim()` before persisting) - the mapper is a
  // validator, not a normalizer, so an un-trimmed persisted value is
  // itself a malformed document and must be rejected, never silently
  // re-trimmed here (Checkpoint 4D.1B.2 §2).
  if (!isNormalizedNonEmptyString(data.description, MAX_DESCRIPTION_LENGTH)) {
    fail(
      "description must be a non-empty, already-trimmed string of at " +
        `most ${MAX_DESCRIPTION_LENGTH} characters`
    );
  }
  if (!isValidSplitStrategy(data.splitStrategy)) {
    fail('splitStrategy must be "equal", "percentage", or "custom"');
  }
  if (!isValidPaymentSource(data.paymentSource)) {
    fail('paymentSource must be "member_out_of_pocket" or "shared_stash"');
  }
  if (!isValidStatus(data.status)) {
    fail('status must be "active" or "reversed"');
  }
  if (!isFirestoreTimestamp(data.createdAt)) {
    fail("createdAt must be a real Firestore Timestamp");
  }

  // Payer/payment-source relationship (mirrors the persisted domain
  // type's own frozen conditional-shape rule exactly, src/types/domain/
  // expense.ts): member_out_of_pocket requires a real payerUid;
  // shared_stash requires payerUid === null and a real
  // sharedStashTransactionId. Never fabricate either side.
  let sharedStashTransactionId: string | undefined;
  if (data.paymentSource === "member_out_of_pocket") {
    if (!isNonEmptyString(data.payerUid)) {
      fail(
        'payerUid must be a non-empty string when paymentSource is "member_out_of_pocket"'
      );
    }
    if (data.sharedStashTransactionId !== undefined) {
      fail(
        'sharedStashTransactionId must not be present when paymentSource is "member_out_of_pocket"'
      );
    }
  } else {
    if (data.payerUid !== null) {
      fail('payerUid must be null when paymentSource is "shared_stash"');
    }
    if (!isNonEmptyString(data.sharedStashTransactionId)) {
      fail(
        'sharedStashTransactionId must be a non-empty string when paymentSource is "shared_stash"'
      );
    }
    sharedStashTransactionId = data.sharedStashTransactionId;
  }

  // category is a backend-normalized (typeof-only, NOT trimmed/non-empty)
  // free-form label - the trusted writer permits "" (an empty category is
  // a legitimate persisted fact, not a malformed document), so the reader
  // must accept it too rather than requiring non-empty (Checkpoint
  // 4D.1B.1 §2).
  let category: string | undefined;
  if (data.category !== undefined) {
    if (typeof data.category !== "string") {
      fail("category, when present, must be a string");
    }
    if (data.category.length > MAX_CATEGORY_LENGTH) {
      fail(`category must be at most ${MAX_CATEGORY_LENGTH} characters`);
    }
    category = data.category;
  }

  let receiptImageUrl: string | null | undefined;
  if (data.receiptImageUrl !== undefined) {
    if (data.receiptImageUrl !== null && typeof data.receiptImageUrl !== "string") {
      fail("receiptImageUrl, when present, must be a string or null");
    }
    receiptImageUrl = data.receiptImageUrl;
  }

  let occurredAt: Timestamp | undefined;
  if (data.occurredAt !== undefined) {
    if (!isFirestoreTimestamp(data.occurredAt)) {
      fail("occurredAt, when present, must be a real Firestore Timestamp");
    }
    occurredAt = data.occurredAt;
  }

  let lastUpdatedAt: Timestamp | undefined;
  if (data.lastUpdatedAt !== undefined) {
    if (!isFirestoreTimestamp(data.lastUpdatedAt)) {
      fail("lastUpdatedAt, when present, must be a real Firestore Timestamp");
    }
    lastUpdatedAt = data.lastUpdatedAt;
  }

  let lastUpdatedBy: string | undefined;
  if (data.lastUpdatedBy !== undefined) {
    if (!isNonEmptyString(data.lastUpdatedBy)) {
      fail("lastUpdatedBy, when present, must be a non-empty string");
    }
    lastUpdatedBy = data.lastUpdatedBy;
  }

  // Reversal metadata: required and validated together when status is
  // "reversed" (so reversal can be rendered truthfully - who, when, and
  // optionally why); must NOT be present on an "active" Expense, since a
  // present-but-contradictory reversal field on an active record is
  // itself a malformed document, never something to silently ignore.
  let reversedAt: Timestamp | undefined;
  let reversedBy: string | undefined;
  let reversalReason: string | undefined;
  if (data.status === "reversed") {
    if (!isFirestoreTimestamp(data.reversedAt)) {
      fail(
        'reversedAt must be a real Firestore Timestamp when status is "reversed"'
      );
    }
    if (!isNonEmptyString(data.reversedBy)) {
      fail('reversedBy must be a non-empty string when status is "reversed"');
    }
    reversedAt = data.reversedAt;
    reversedBy = data.reversedBy;
    if (data.reversalReason !== undefined) {
      // Matches reverseTripExpense.ts's own trusted persisted contract
      // exactly: a non-null reversalReason is always already trimmed,
      // non-empty, and at most MAX_REVERSAL_REASON_LENGTH characters (a
      // null reason is never persisted - the field is deleted instead).
      if (!isNormalizedNonEmptyString(data.reversalReason, MAX_REVERSAL_REASON_LENGTH)) {
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
    // Reversal metadata belongs only to a "reversed" Expense - any of
    // reversedAt/reversedBy/reversalReason present on an "active" record
    // is itself a malformed document (Checkpoint 4D.1B.1 §3). This does
    // NOT inspect the backend-internal reversalRequest field, which is
    // never part of the public Expense mapper.
    fail(
      'reversedAt/reversedBy/reversalReason must not be present when status is "active"'
    );
  }

  // Correction-link ids - a non-empty valid Firestore document-id shape
  // is required before this mapper will let later code navigate using
  // them (Checkpoint 4D.1B §10).
  let replacesExpenseId: string | undefined;
  if (data.replacesExpenseId !== undefined) {
    if (!isValidFirestoreDocumentIdShape(data.replacesExpenseId)) {
      fail(
        "replacesExpenseId, when present, must be a non-empty valid Firestore document id"
      );
    }
    replacesExpenseId = data.replacesExpenseId;
  }
  let replacedByExpenseId: string | undefined;
  if (data.replacedByExpenseId !== undefined) {
    if (!isValidFirestoreDocumentIdShape(data.replacedByExpenseId)) {
      fail(
        "replacedByExpenseId, when present, must be a non-empty valid Firestore document id"
      );
    }
    replacedByExpenseId = data.replacedByExpenseId;
  }

  const expense: Expense = {
    id,
    tripId: data.tripId,
    payerUid: data.paymentSource === "member_out_of_pocket" ? data.payerUid : null,
    createdBy: data.createdBy,
    amountMinor: data.amountMinor,
    currency: data.currency,
    description: data.description,
    splitStrategy: data.splitStrategy,
    paymentSource: data.paymentSource,
    createdAt: data.createdAt,
    status: data.status,
  };
  if (category !== undefined) expense.category = category;
  if (receiptImageUrl !== undefined) expense.receiptImageUrl = receiptImageUrl;
  if (sharedStashTransactionId !== undefined) {
    expense.sharedStashTransactionId = sharedStashTransactionId;
  }
  if (occurredAt !== undefined) expense.occurredAt = occurredAt;
  if (lastUpdatedAt !== undefined) expense.lastUpdatedAt = lastUpdatedAt;
  if (lastUpdatedBy !== undefined) expense.lastUpdatedBy = lastUpdatedBy;
  if (reversedAt !== undefined) expense.reversedAt = reversedAt;
  if (reversedBy !== undefined) expense.reversedBy = reversedBy;
  if (reversalReason !== undefined) expense.reversalReason = reversalReason;
  if (replacesExpenseId !== undefined) expense.replacesExpenseId = replacesExpenseId;
  if (replacedByExpenseId !== undefined) {
    expense.replacedByExpenseId = replacedByExpenseId;
  }

  return expense;
}

// ---------------------------------------------------------------------
// EXPENSE SPLIT MAPPER - fail closed (Checkpoint 4D.1B §13)
// ---------------------------------------------------------------------

export function mapExpenseSplitDocument(
  id: string,
  data: DocumentData
): ExpenseSplit {
  const fail = (reason: string): never => {
    throw new Error(
      `mapExpenseSplitDocument: invalid ExpenseSplit document "${id}" - ${reason}.`
    );
  };

  if (!isNonEmptyString(data.expenseId)) {
    fail("expenseId must be a non-empty string");
  }
  if (!isNonEmptyString(data.tripId)) {
    fail("tripId must be a non-empty string");
  }
  if (!isNonEmptyString(data.userId)) {
    fail("userId must be a non-empty string");
  }
  // Zero is valid - a custom split may intentionally include a $0 share
  // (src/domain/tripExpenseSplits.ts's own frozen computeCustomSplit
  // behavior), so this is non-negative, not strictly positive.
  if (!isNonNegativeSafeInteger(data.amountMinor)) {
    fail("amountMinor must be a non-negative safe integer");
  }
  if (!isFirestoreTimestamp(data.createdAt)) {
    fail("createdAt must be a real Firestore Timestamp");
  }

  let percentageBasisPoints: number | undefined;
  if (data.percentageBasisPoints !== undefined) {
    if (
      !isNonNegativeSafeInteger(data.percentageBasisPoints) ||
      data.percentageBasisPoints > 10000
    ) {
      fail(
        "percentageBasisPoints, when present, must be a non-negative safe integer not exceeding 10000"
      );
    }
    percentageBasisPoints = data.percentageBasisPoints;
  }

  const split: ExpenseSplit = {
    expenseId: data.expenseId,
    tripId: data.tripId,
    userId: data.userId,
    amountMinor: data.amountMinor,
    createdAt: data.createdAt,
  };
  if (percentageBasisPoints !== undefined) {
    split.percentageBasisPoints = percentageBasisPoints;
  }
  return split;
}

// ---------------------------------------------------------------------
// HISTORY ORDERING (Checkpoint 4D.1B §6)
// ---------------------------------------------------------------------

// occurredAt represents when the purchase happened; createdAt represents
// when SquadStash recorded it. occurredAt is preferred when present,
// falling back to the always-present createdAt - the identical
// precedence already established by utils/format.ts's own
// formatTransactionTimestamp(transaction.occurredAt ?? transaction.createdAt)
// call, extended here to the sort key itself.
function expenseHistoryTimestamp(expense: Expense): Timestamp {
  return expense.occurredAt ?? expense.createdAt;
}

// Deterministic descending sort: primarily by occurredAt ?? createdAt,
// tie-broken by ascending Expense id (never Firestore's own incidental
// snapshot return order, which is not a documented ordering guarantee for
// an unordered `where` query).
export function sortExpensesForHistory(expenses: Expense[]): Expense[] {
  return [...expenses].sort((a, b) => {
    const aMs = expenseHistoryTimestamp(a).toMillis();
    const bMs = expenseHistoryTimestamp(b).toMillis();
    if (aMs !== bMs) return bMs - aMs;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ---------------------------------------------------------------------
// ROUTE-tripId INTEGRITY (Checkpoint 4D.0B §7, load-bearing)
// ---------------------------------------------------------------------

// Firestore Rules answer "may this signed-in user read this document?".
// This answers a different question: "does this document belong to the
// Trip this screen/route represents?" A user may legitimately be a
// current member of more than one Trip - without this check, a Rules-
// authorized-but-wrong-Trip Expense could otherwise render inside another
// Trip's own screen.
export function expenseBelongsToTrip(expense: Expense, tripId: string): boolean {
  return expense.tripId === tripId;
}

// ---------------------------------------------------------------------
// READS
// ---------------------------------------------------------------------

function expenseDocRef(expenseId: string) {
  return doc(db, "tripExpenses", expenseId);
}

function tripExpensesQuery(tripId: string) {
  return query(collection(db, "tripExpenses"), where("tripId", "==", tripId));
}

// No orderBy - client-side sorting (sortExpensesForHistory above) avoids
// introducing a composite index in 4D (preflight §7); firestore.indexes.json
// has no tripExpenses index today and this checkpoint does not add one.
export function subscribeToExpensesForTrip(
  tripId: string,
  onChange: (expenses: Expense[]) => void,
  onError?: (error: unknown) => void
): Unsubscribe {
  return onSnapshot(
    tripExpensesQuery(tripId),
    (snap) => {
      try {
        const next: Expense[] = [];
        snap.forEach((docSnap) => {
          next.push(mapExpenseDocument(docSnap.id, docSnap.data() as DocumentData));
        });
        onChange(sortExpensesForHistory(next));
      } catch (mappingError) {
        // A mapping exception thrown inside an onSnapshot success
        // callback is NOT automatically routed through Firestore's own
        // onError - it must be caught and forwarded explicitly. Never
        // emit a partial list with the bad record silently dropped and
        // the rest presented as complete (Checkpoint 4D.1B §12).
        if (onError) {
          onError(mappingError);
        } else {
          console.error(
            "subscribeToExpensesForTrip: mapping failed",
            mappingError
          );
        }
      }
    },
    onError
  );
}

// Route-tripId-bound (§7 above): an Expense whose own tripId does not
// match the caller's expected tripId is treated as not found for this
// route context, never exposed.
export function subscribeToExpenseById(
  tripId: string,
  expenseId: string,
  onChange: (expense: Expense | null) => void,
  onError?: (error: unknown) => void
): Unsubscribe {
  return onSnapshot(
    expenseDocRef(expenseId),
    (snap) => {
      if (!snap.exists()) {
        onChange(null);
        return;
      }
      try {
        const expense = mapExpenseDocument(
          snap.id,
          snap.data() as DocumentData
        );
        onChange(expenseBelongsToTrip(expense, tripId) ? expense : null);
      } catch (mappingError) {
        if (onError) {
          onError(mappingError);
        } else {
          console.error(
            "subscribeToExpenseById: mapping failed",
            mappingError
          );
        }
      }
    },
    onError
  );
}

export async function fetchExpenseById(
  tripId: string,
  expenseId: string
): Promise<Expense | null> {
  const snap = await getDoc(expenseDocRef(expenseId));
  if (!snap.exists()) return null;
  const expense = mapExpenseDocument(snap.id, snap.data() as DocumentData);
  return expenseBelongsToTrip(expense, tripId) ? expense : null;
}

function expenseSplitsQuery(tripId: string, expenseId: string) {
  return query(
    collection(db, "tripExpenseSplits"),
    where("tripId", "==", tripId),
    where("expenseId", "==", expenseId)
  );
}

// One-shot only (Splits are immutable - see the module comment). tripId
// is mandatory, not merely a convenience filter: firestore.rules
// authorizes tripExpenseSplits reads strictly through resource.data.tripId
// (canAccessTripById) - expenseId/the Split document id convey no
// authority on their own (Checkpoint 4D.0A/4D.0B §8).
export async function fetchExpenseSplitsForExpense(
  tripId: string,
  expenseId: string
): Promise<ExpenseSplit[]> {
  const snap = await getDocs(expenseSplitsQuery(tripId, expenseId));
  const splits: ExpenseSplit[] = [];
  snap.forEach((docSnap) => {
    const split = mapExpenseSplitDocument(
      docSnap.id,
      docSnap.data() as DocumentData
    );
    // Defensive re-check even though the query already constrains both
    // fields - never trust the query shape alone (Checkpoint 4D.1B §8).
    if (split.tripId !== tripId || split.expenseId !== expenseId) {
      throw new Error(
        `fetchExpenseSplitsForExpense: returned Split "${docSnap.id}" does ` +
          "not match the requested tripId/expenseId."
      );
    }
    splits.push(split);
  });
  return splits.sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
}

// ---------------------------------------------------------------------
// CLIENT REQUEST ID (Checkpoint 4D.1B §14)
// ---------------------------------------------------------------------

// Reads the id off a Firestore DocumentReference built by the client
// SDK's own auto-id generator - no document is created, no network call
// is made. Mirrors generateSavingsClientRequestId/
// generateBucketClientRequestId exactly (never crypto.randomUUID(), no
// new dependency). Valid for both recordTripExpense creation idempotency
// and reverseTripExpense's own reversalRequest idempotency - this service
// only generates an id on request; the UI/controller layer owns when a
// request id is reused across a retry.
export function generateExpenseClientRequestId(): string {
  return doc(collection(db, "tripExpenses")).id;
}

// ---------------------------------------------------------------------
// recordTripExpense (Checkpoint 4D.1B §15-§17)
// ---------------------------------------------------------------------

type RecordTripExpenseCommonFacts = {
  tripId: string;
  payerUid: string;
  amountMinor: number;
  currency: "USD";
  description: string;
  category?: string;
  // Preservation support only (Checkpoint 4D.0B §16/§26 of the
  // preflight) - NOT a new Expense-Date UI. Ordinary 4D Add Expense omits
  // this entirely; a correction may pass an existing old Expense's own
  // already-persisted instant through unchanged.
  occurredAt?: Date;
  clientRequestId: string;
  replacesExpenseId?: string;
};

// Deliberately NOT src/types/domain/expense.ts's own CreateExpenseInput -
// that type can represent Shared-Stash creation (paymentSource,
// sharedStashTransactionId) and has no participants/clientRequestId
// shape at all. This client-service input can only ever represent an
// out-of-pocket creation, matching the callable's own 4C-era contract
// (paymentSource is never a user-selectable choice here - always sent as
// "member_out_of_pocket" by buildRecordTripExpenseRequest below).
export type RecordTripExpenseInput =
  | (RecordTripExpenseCommonFacts & {
      splitStrategy: "equal";
      participants: {uid: string}[];
    })
  | (RecordTripExpenseCommonFacts & {
      splitStrategy: "percentage";
      participants: {uid: string; percentageBasisPoints: number}[];
    })
  | (RecordTripExpenseCommonFacts & {
      splitStrategy: "custom";
      participants: {uid: string; amountMinor: number}[];
    });

type RecordTripExpenseRequest = {
  tripId: string;
  payerUid: string;
  amountMinor: number;
  currency: "USD";
  description: string;
  category?: string;
  splitStrategy: SplitStrategy;
  participants: unknown[];
  paymentSource: "member_out_of_pocket";
  occurredAt?: string;
  clientRequestId: string;
  replacesExpenseId?: string;
};

// Pure request-shaping, exported for direct testing without any Firebase
// mocking. Never invented createdBy/status/reversedAt/reversedBy/
// reversalReason/replacedByExpenseId/sharedStashTransactionId/
// receiptImageUrl/id on the wire payload - this type simply has no way to
// carry any of them.
export function buildRecordTripExpenseRequest(
  input: RecordTripExpenseInput
): RecordTripExpenseRequest {
  const request: RecordTripExpenseRequest = {
    tripId: input.tripId,
    payerUid: input.payerUid,
    amountMinor: input.amountMinor,
    currency: input.currency,
    description: input.description,
    splitStrategy: input.splitStrategy,
    participants: input.participants,
    paymentSource: "member_out_of_pocket",
    clientRequestId: input.clientRequestId,
  };
  if (input.category !== undefined) {
    request.category = input.category;
  }
  if (input.replacesExpenseId !== undefined) {
    request.replacesExpenseId = input.replacesExpenseId;
  }
  if (input.occurredAt !== undefined) {
    if (Number.isNaN(input.occurredAt.getTime())) {
      throw new Error("recordTripExpense: occurredAt is an invalid Date.");
    }
    // Full ISO instant with an explicit "Z" timezone - never a date-only
    // value, and never parsed/constructed from one here (Checkpoint
    // 4D.0B §16 - this is preservation of an already-real instant, not a
    // new date-only-to-instant conversion).
    request.occurredAt = input.occurredAt.toISOString();
  }
  return request;
}

export type RecordTripExpenseResult = {expenseId: string};

// Validates the callable's response field-by-field rather than trusting a
// whole-object cast, matching parseRecordSavingsTransactionResponse's own
// established discipline exactly.
export function parseRecordTripExpenseResponse(
  data: unknown
): RecordTripExpenseResult {
  if (typeof data !== "object" || data === null) {
    throw new Error(
      "recordTripExpense: invalid response (expected an object)."
    );
  }
  const {expenseId} = data as Record<string, unknown>;
  if (typeof expenseId !== "string" || expenseId.length === 0) {
    throw new Error(
      "recordTripExpense: invalid response (expenseId must be a non-empty string)."
    );
  }
  return {expenseId};
}

// The sole write path for creating/correcting a tripExpenses document:
// invokes the trusted recordTripExpense Cloud Function via httpsCallable.
// Callable errors (HttpsError/FirebaseError) are not caught or wrapped -
// they propagate to the caller unchanged, matching every other trusted-
// write wrapper in this codebase (recordSavingsTransaction, createBucket).
export async function recordTripExpense(
  input: RecordTripExpenseInput
): Promise<RecordTripExpenseResult> {
  const payload = buildRecordTripExpenseRequest(input);
  const callable = httpsCallable<RecordTripExpenseRequest, unknown>(
    functions,
    "recordTripExpense"
  );
  const res = await callable(payload);
  return parseRecordTripExpenseResponse(res.data);
}

// ---------------------------------------------------------------------
// reverseTripExpense (Checkpoint 4D.1B §18)
// ---------------------------------------------------------------------

// Deliberately no tripId - the backend derives it from the persisted
// Expense document itself (preflight §4.1); this wrapper must not invent
// one to send. Also deliberately does not normalize reversalReason or own
// any idempotency-retry policy - that belongs to the later 4D.6 UI/domain
// controller. This wrapper transmits the supplied optional reason
// faithfully, as-is.
export type ReverseTripExpenseInput = {
  expenseId: string;
  reversalReason?: string;
  clientRequestId: string;
};

type ReverseTripExpenseRequest = {
  expenseId: string;
  reversalReason?: string;
  clientRequestId: string;
};

export type ReverseTripExpenseResult = {expenseId: string};

export function parseReverseTripExpenseResponse(
  data: unknown
): ReverseTripExpenseResult {
  if (typeof data !== "object" || data === null) {
    throw new Error(
      "reverseTripExpense: invalid response (expected an object)."
    );
  }
  const {expenseId} = data as Record<string, unknown>;
  if (typeof expenseId !== "string" || expenseId.length === 0) {
    throw new Error(
      "reverseTripExpense: invalid response (expenseId must be a non-empty string)."
    );
  }
  return {expenseId};
}

// The sole write path for reversing a tripExpenses document. Never
// updates Firestore status directly, never touches tripExpenseSplits,
// never normalizes reversal authority client-side - the backend remains
// the sole authority for all of that. Callable errors propagate
// unchanged, matching recordTripExpense's own convention above.
export async function reverseTripExpense(
  input: ReverseTripExpenseInput
): Promise<ReverseTripExpenseResult> {
  const payload: ReverseTripExpenseRequest = {
    expenseId: input.expenseId,
    clientRequestId: input.clientRequestId,
  };
  if (input.reversalReason !== undefined) {
    payload.reversalReason = input.reversalReason;
  }
  const callable = httpsCallable<ReverseTripExpenseRequest, unknown>(
    functions,
    "reverseTripExpense"
  );
  const res = await callable(payload);
  return parseReverseTripExpenseResponse(res.data);
}
