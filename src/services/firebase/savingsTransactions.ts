// Firestore access for the savingsTransactions ledger (Milestone 2B).
// Reads are direct Firestore queries, resource-scoped only - no global or
// member-filtered query, matching the exact query shape firestore.rules
// authorizes (see Checkpoint 2's rules tests: resourceType == ...,
// resourceId == ..., orderBy createdAt desc) - and turn documents into
// canonical SavingsTransaction[] values.
//
// Writes (Checkpoint 4B/4C) go exclusively through the trusted
// recordSavingsTransaction Cloud Function via httpsCallable: Firestore
// rules unconditionally deny client create/update/delete on this
// collection, so no addDoc/setDoc/updateDoc/runTransaction/writeBatch
// call could ever succeed here even if one were written. Reversals are a
// separate future checkpoint.
//
// No balance calculation happens here - that is src/domain/
// savingsBalance.ts's job for locally-derived balances, and the trusted
// balanceMinor returned by the callable for the authoritative one; this
// file never imports savingsBalance.ts or recomputes a balance itself.
import { httpsCallable } from "firebase/functions";
import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import type { DocumentData, Unsubscribe } from "firebase/firestore";
import { db, functions } from "../../../firebase";
import type {
  CurrencyCode,
  PersistedTimestamp,
  ResourceType,
  SavingsTransaction,
  SavingsTransactionType,
} from "../../types/domain";

// Builds a SavingsTransaction field-by-field from a raw Firestore
// document, matching trips.ts's mapTripDocument convention rather than
// spreading the whole document plus a trailing cast. Every field is
// read and typed individually; nothing is coerced or defaulted to a
// fabricated value - amountMinor/currency/memberUid/recordedBy/
// resourceId/type are trusted as-is from the persisted representation
// (firestore.rules's savingsTransactions create rule, not this mapper,
// is what guarantees their shape on write).
//
// reversalOf is the one deliberate exception: the domain type requires
// it to always be present (`string | null`, no `?`), but the write
// rules intentionally allow the key to be omitted entirely for an
// ordinary (non-reversal) transaction - an absent key and an explicit
// null both mean "no reversal". Normalizing an absent key to null here
// fulfills the canonical type's own contract without fabricating any
// new information.
function mapSavingsTransactionDocument(
  id: string,
  data: DocumentData
): SavingsTransaction {
  const base = {
    id,
    resourceType: data.resourceType as ResourceType,
    resourceId: data.resourceId as string,
    memberUid: data.memberUid as string,
    recordedBy: data.recordedBy as string,
    amountMinor: data.amountMinor as number,
    currency: data.currency as CurrencyCode,
    note: data.note as string | undefined,
    occurredAt: data.occurredAt as PersistedTimestamp | undefined,
    createdAt: data.createdAt as PersistedTimestamp,
    reversalOf: (data.reversalOf ?? null) as string | null,
  };

  // type is intentionally NOT cast-and-trusted like the other fields
  // above: it is the discriminant the pure calculation layer
  // (src/domain/savingsBalance.ts) uses to decide a transaction's sign.
  // A malformed/admin-seeded value here (e.g. "deposit") must fail
  // visibly rather than silently pass through as a fabricated
  // contribution or withdrawal and reach that calculation.
  if (data.type === "contribution") {
    return { ...base, type: "contribution" };
  }
  if (data.type === "withdrawal") {
    return { ...base, type: "withdrawal" };
  }
  throw new Error(
    `Invalid persisted savingsTransactions type "${data.type}" on document ${id}`
  );
}

function resourceTransactionsQuery(
  resourceType: ResourceType,
  resourceId: string
) {
  return query(
    collection(db, "savingsTransactions"),
    where("resourceType", "==", resourceType),
    where("resourceId", "==", resourceId),
    orderBy("createdAt", "desc")
  );
}

export async function fetchSavingsTransactionsForResource(
  resourceType: ResourceType,
  resourceId: string
): Promise<SavingsTransaction[]> {
  const snap = await getDocs(
    resourceTransactionsQuery(resourceType, resourceId)
  );
  return snap.docs.map((d) =>
    mapSavingsTransactionDocument(d.id, d.data() as DocumentData)
  );
}

export function subscribeToSavingsTransactionsForResource(
  resourceType: ResourceType,
  resourceId: string,
  onChange: (transactions: SavingsTransaction[]) => void,
  onError?: (error: unknown) => void
): Unsubscribe {
  return onSnapshot(
    resourceTransactionsQuery(resourceType, resourceId),
    (snap) => {
      const next: SavingsTransaction[] = [];
      snap.forEach((docSnap) => {
        next.push(
          mapSavingsTransactionDocument(docSnap.id, docSnap.data() as DocumentData)
        );
      });
      onChange(next);
    },
    onError
  );
}

// ---------------------------------------
// WRITE PATH (Milestone 2B Checkpoint 4C/4D)
// ---------------------------------------

// Generates a clientRequestId locally, with no network call and no
// document actually created - it only reads the id off a Firestore
// DocumentReference built by the client SDK's own auto-id generator,
// the same mechanism every addDoc() call in this app already relies on
// internally. Its alphabet (A-Za-z0-9) is a strict subset of the
// backend's accepted clientRequestId characters
// (CLIENT_REQUEST_ID_PATTERN in recordSavingsTransaction.ts) and its
// length is well under the 128-character limit, so no extra validation
// is needed. Deliberately not crypto.randomUUID(): that is not
// guaranteed available on every current Expo/React Native target, and no
// new dependency (e.g. expo-crypto, react-native-get-random-values) may
// be added solely for this.
export function generateSavingsClientRequestId(): string {
  return doc(collection(db, "savingsTransactions")).id;
}

// Deliberately narrower than CreateSavingsTransactionInput: recordedBy,
// createdAt and reversalOf are trusted/backend-managed values the
// recordSavingsTransaction Cloud Function itself resolves (recordedBy
// from the authenticated caller, createdAt server-side, reversalOf held
// back for a later reversal checkpoint) and must never be accepted from
// or sent by this client wrapper. clientRequestId is required, not
// optional - it is the idempotency key a retried submit must reuse
// exactly, and generating a fresh one per call here would defeat that;
// its lifecycle (create once per submit attempt, retain across retries)
// belongs to the future UI/action checkpoint that calls this function.
export type RecordSavingsTransactionInput = {
  resourceType: ResourceType;
  resourceId: string;
  memberUid: string;
  type: SavingsTransactionType;
  amountMinor: number;
  currency: CurrencyCode;
  note?: string;
  occurredAt?: Date;
  clientRequestId: string;
};

// The literal shape sent over the wire - identical to
// RecordSavingsTransactionInput except occurredAt is serialized to an
// ISO string at this boundary (the callable's persisted representation
// converts it back to a Timestamp on the backend; this function never
// touches an already-persisted Firestore Timestamp).
type RecordSavingsTransactionRequest = {
  resourceType: ResourceType;
  resourceId: string;
  memberUid: string;
  type: SavingsTransactionType;
  amountMinor: number;
  currency: CurrencyCode;
  note?: string;
  occurredAt?: string;
  clientRequestId: string;
};

export type RecordSavingsTransactionResult = {
  transactionId: string;
  balanceMinor: number;
};

// Validates the callable's response field-by-field rather than trusting
// a whole-object cast - a malformed/unexpected shape must fail visibly,
// never silently coerce via String(...)/Number(...)/||/?? defaulting,
// since balanceMinor is authoritative financial data.
function parseRecordSavingsTransactionResponse(
  data: unknown
): RecordSavingsTransactionResult {
  if (typeof data !== "object" || data === null) {
    throw new Error(
      "recordSavingsTransaction: invalid response (expected an object)."
    );
  }

  const { transactionId, balanceMinor } = data as Record<string, unknown>;

  if (typeof transactionId !== "string" || transactionId.length === 0) {
    throw new Error(
      "recordSavingsTransaction: invalid response (transactionId must be a non-empty string)."
    );
  }
  if (
    typeof balanceMinor !== "number" ||
    !Number.isSafeInteger(balanceMinor) ||
    balanceMinor < 0
  ) {
    throw new Error(
      "recordSavingsTransaction: invalid response (balanceMinor must be a non-negative safe integer)."
    );
  }

  return { transactionId, balanceMinor };
}

// The sole write path for savingsTransactions: invokes the trusted
// recordSavingsTransaction Cloud Function via httpsCallable. Firestore
// rules deny direct client create/update/delete on this collection
// unconditionally (Checkpoint 4B), so no addDoc/setDoc/updateDoc/
// runTransaction/writeBatch call is used or would succeed here. Callable
// errors (HttpsError/FirebaseError) are not caught or wrapped - they
// propagate to the caller unchanged, matching lookupUserByEmail's
// existing convention.
export async function recordSavingsTransaction(
  input: RecordSavingsTransactionInput
): Promise<RecordSavingsTransactionResult> {
  const payload: RecordSavingsTransactionRequest = {
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    memberUid: input.memberUid,
    type: input.type,
    amountMinor: input.amountMinor,
    currency: input.currency,
    clientRequestId: input.clientRequestId,
  };

  if (input.note !== undefined) {
    payload.note = input.note;
  }

  if (input.occurredAt !== undefined) {
    if (Number.isNaN(input.occurredAt.getTime())) {
      throw new Error(
        "recordSavingsTransaction: occurredAt is an invalid Date."
      );
    }
    payload.occurredAt = input.occurredAt.toISOString();
  }

  const callable = httpsCallable<RecordSavingsTransactionRequest, unknown>(
    functions,
    "recordSavingsTransaction"
  );
  const res = await callable(payload);
  return parseRecordSavingsTransactionResponse(res.data);
}
