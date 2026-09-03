import {FieldValue, Timestamp, getFirestore} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";

type ResourceType = "bucket" | "trip";
type SavingsTransactionType = "contribution" | "withdrawal";
type CallableAuth = CallableRequest["auth"];

interface RecordSavingsTransactionInput {
  resourceType: ResourceType;
  resourceId: string;
  memberUid: string;
  type: SavingsTransactionType;
  amountMinor: number;
  currency: string;
  note?: string;
  occurredAt?: string;
  clientRequestId: string;
}

interface RecordSavingsTransactionResult {
  transactionId: string;
  balanceMinor: number;
}

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_NOTE_LENGTH = 500;

/**
 * recordSavingsTransaction
 * Input: {
 *   resourceType: "bucket" | "trip", resourceId: string, memberUid: string,
 *   type: "contribution" | "withdrawal", amountMinor: number,
 *   currency: string, note?: string, occurredAt?: string,
 *   clientRequestId: string,
 * }
 * Output: { transactionId: string, balanceMinor: number }
 *
 * Security:
 * - Requires caller to be signed in
 * - Caller may record only their own activity (memberUid must equal the
 *   authenticated uid); memberUid must also still be a current member of
 *   the resource
 * - Owner-on-behalf recording (an owner recording for another member) is
 *   intentionally NOT permitted right now (Milestone 2C Checkpoint 2C-1).
 *   A Bucket owner can unilaterally add another registered uid to
 *   memberIds with no acceptance step, and no trusted Membership/
 *   Invitation-acceptance record exists yet to distinguish that from
 *   independently-accepted membership - so financial attribution stays
 *   self-only until a future group-sharing milestone adds trusted,
 *   accepted membership.
 * - This is the sole trusted write path for savingsTransactions; direct
 *   client creation is expected to be locked down separately (see
 *   Milestone 2B Checkpoint 4B)
 */
export const recordSavingsTransaction = onCall(async (request) => {
  const authUid = requireAuthenticatedUid(request.auth);

  return recordSavingsTransactionCore(
    getFirestore(),
    authUid,
    request.data
  );
});

/**
 * Requires an authenticated caller, matching the guard every callable in
 * this project uses (see lookupUserByEmail). Extracted so the production
 * auth boundary itself can be tested directly - the onCall wrapper above
 * calls this exact function, not a separate/duplicated check.
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
 * @return {Promise<RecordSavingsTransactionResult>} The new/idempotently
 *   replayed transaction id and the resource's resulting trusted balance.
 */
export async function recordSavingsTransactionCore(
  db: Firestore,
  authUid: string,
  rawInput: unknown
): Promise<RecordSavingsTransactionResult> {
  const input = validateInput(rawInput);
  const occurredAtTimestamp = input.occurredAt === undefined ?
    undefined :
    Timestamp.fromDate(new Date(input.occurredAt));

  const parentCollection =
    input.resourceType === "bucket" ? "buckets" : "trips";
  const parentRef = db.collection(parentCollection).doc(input.resourceId);
  const transactionRef =
    db.collection("savingsTransactions").doc(input.clientRequestId);
  const historyQuery = db.collection("savingsTransactions")
    .where("resourceType", "==", input.resourceType)
    .where("resourceId", "==", input.resourceId)
    .limit(1);

  return db.runTransaction(async (tx) => {
    // All reads happen before any write - Firestore transactions
    // require this ordering.
    const existingTxnSnap = await tx.get(transactionRef);
    const parentSnap = await tx.get(parentRef);

    if (!parentSnap.exists) {
      throw new HttpsError(
        "not-found",
        `No ${input.resourceType} found for the given resourceId.`
      );
    }
    const parentData = parentSnap.data() as FirebaseFirestore.DocumentData;

    // Idempotent replay: the exact same clientRequestId was already used.
    if (existingTxnSnap.exists) {
      const stored = existingTxnSnap.data() as FirebaseFirestore.DocumentData;
      if (!storedFactsMatch(stored, input, authUid, occurredAtTimestamp)) {
        throw new HttpsError(
          "already-exists",
          "clientRequestId was already used for a different request."
        );
      }
      const existingBalance = parentData.ledgerBalanceMinor;
      if (!Number.isSafeInteger(existingBalance)) {
        throw new HttpsError(
          "failed-precondition",
          "Parent resource has no valid trusted ledger balance."
        );
      }
      return {
        transactionId: input.clientRequestId,
        balanceMinor: existingBalance,
      };
    }

    if (!Array.isArray(parentData.memberIds)) {
      throw new HttpsError(
        "failed-precondition",
        "Parent resource has malformed memberIds."
      );
    }
    if (!parentData.memberIds.includes(input.memberUid)) {
      throw new HttpsError(
        "permission-denied",
        "memberUid is not a current member of this resource."
      );
    }

    // Self-only for now (Milestone 2C Checkpoint 2C-1): owner-on-behalf
    // recording is intentionally deferred until trusted, accepted
    // membership exists - see the security note in the file header.
    if (authUid !== input.memberUid) {
      throw new HttpsError(
        "permission-denied",
        "You may only record a savings transaction for yourself."
      );
    }

    let effectiveCurrency = "USD";
    if ("currency" in parentData) {
      const parentCurrency = parentData.currency;
      if (typeof parentCurrency !== "string" || parentCurrency.length === 0) {
        throw new HttpsError(
          "failed-precondition",
          "Parent resource has a malformed currency field."
        );
      }
      effectiveCurrency = parentCurrency;
    }
    if (input.currency !== effectiveCurrency) {
      throw new HttpsError(
        "failed-precondition",
        `currency must match the resource's currency (${effectiveCurrency}).`
      );
    }

    const hasOpening = "ledgerOpeningBalanceMinor" in parentData;
    const hasBalance = "ledgerBalanceMinor" in parentData;

    let currentBalanceMinor: number;
    let initOpeningMinor: number | null = null;

    if (hasOpening && hasBalance) {
      const opening = parentData.ledgerOpeningBalanceMinor;
      const balance = parentData.ledgerBalanceMinor;
      const openingValid = Number.isSafeInteger(opening) && opening >= 0;
      const balanceValid = Number.isSafeInteger(balance) && balance >= 0;
      if (!openingValid || !balanceValid) {
        throw new HttpsError(
          "failed-precondition",
          "Parent resource has an invalid trusted ledger state."
        );
      }
      currentBalanceMinor = balance;
    } else if (!hasOpening && !hasBalance) {
      // Uninitialized resource - guard against ambiguous prior history
      // before inventing an opening balance.
      const historySnap = await tx.get(historyQuery);
      if (!historySnap.empty) {
        throw new HttpsError(
          "failed-precondition",
          "Resource has savingsTransactions history but no " +
            "initialized ledger state."
        );
      }

      const legacyDollars = input.resourceType === "bucket" ?
        parentData.balance :
        (parentData.saved ?? 0);
      const legacyValid = typeof legacyDollars === "number" &&
        Number.isFinite(legacyDollars) && legacyDollars >= 0;
      if (!legacyValid) {
        throw new HttpsError(
          "failed-precondition",
          "Parent resource has an invalid legacy compatibility balance."
        );
      }
      const legacyMinor = Math.round(legacyDollars * 100);
      if (!Number.isSafeInteger(legacyMinor)) {
        throw new HttpsError(
          "failed-precondition",
          "Legacy compatibility balance is too large to convert safely."
        );
      }
      currentBalanceMinor = legacyMinor;
      initOpeningMinor = legacyMinor;
    } else {
      throw new HttpsError(
        "failed-precondition",
        "Parent resource has a partial/corrupt ledger initialization " +
          "state."
      );
    }

    const signedDelta =
      input.type === "contribution" ? input.amountMinor : -input.amountMinor;
    const newBalanceMinor = currentBalanceMinor + signedDelta;
    if (!Number.isSafeInteger(newBalanceMinor)) {
      throw new HttpsError(
        "failed-precondition",
        "Resulting balance is not a safe integer."
      );
    }
    if (newBalanceMinor < 0) {
      throw new HttpsError(
        "failed-precondition",
        "Insufficient balance for this withdrawal."
      );
    }

    const transactionData: Record<string, unknown> = {
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      memberUid: input.memberUid,
      recordedBy: authUid,
      amountMinor: input.amountMinor,
      currency: input.currency,
      type: input.type,
      createdAt: FieldValue.serverTimestamp(),
      reversalOf: null,
    };
    if (input.note !== undefined) {
      transactionData.note = input.note;
    }
    if (occurredAtTimestamp !== undefined) {
      transactionData.occurredAt = occurredAtTimestamp;
    }
    tx.set(transactionRef, transactionData);

    const parentUpdate: Record<string, unknown> = {
      ledgerBalanceMinor: newBalanceMinor,
      lastUpdatedAt: FieldValue.serverTimestamp(),
      lastUpdatedBy: authUid,
    };
    if (input.resourceType === "bucket") {
      parentUpdate.balance = newBalanceMinor / 100;
    } else {
      parentUpdate.saved = newBalanceMinor / 100;
    }
    if (initOpeningMinor !== null) {
      parentUpdate.ledgerOpeningBalanceMinor = initOpeningMinor;
    }
    tx.update(parentRef, parentUpdate);

    return {
      transactionId: input.clientRequestId,
      balanceMinor: newBalanceMinor,
    };
  });
}

/**
 * Validates and narrows a raw callable request body.
 * @param {unknown} raw The unvalidated callable request body.
 * @return {RecordSavingsTransactionInput} The validated, narrowed input.
 */
function validateInput(raw: unknown): RecordSavingsTransactionInput {
  if (typeof raw !== "object" || raw === null) {
    throw new HttpsError("invalid-argument", "Request body is required.");
  }
  const data = raw as Record<string, unknown>;

  if (data.resourceType !== "bucket" && data.resourceType !== "trip") {
    throw new HttpsError(
      "invalid-argument",
      "resourceType must be \"bucket\" or \"trip\"."
    );
  }
  if (typeof data.resourceId !== "string" || data.resourceId.length === 0) {
    throw new HttpsError("invalid-argument", "resourceId is required.");
  }
  if (typeof data.memberUid !== "string" || data.memberUid.length === 0) {
    throw new HttpsError("invalid-argument", "memberUid is required.");
  }
  if (data.type !== "contribution" && data.type !== "withdrawal") {
    throw new HttpsError(
      "invalid-argument",
      "type must be \"contribution\" or \"withdrawal\"."
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
  if (typeof data.currency !== "string" || data.currency.length === 0) {
    throw new HttpsError("invalid-argument", "currency is required.");
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

  let note: string | undefined;
  if (data.note !== undefined) {
    if (typeof data.note !== "string" || data.note.length > MAX_NOTE_LENGTH) {
      throw new HttpsError(
        "invalid-argument",
        `note must be a string of at most ${MAX_NOTE_LENGTH} characters.`
      );
    }
    note = data.note;
  }

  let occurredAt: string | undefined;
  if (data.occurredAt !== undefined) {
    if (
      typeof data.occurredAt !== "string" ||
      Number.isNaN(Date.parse(data.occurredAt))
    ) {
      throw new HttpsError(
        "invalid-argument",
        "occurredAt must be a valid ISO date/time string."
      );
    }
    occurredAt = data.occurredAt;
  }

  return {
    resourceType: data.resourceType,
    resourceId: data.resourceId,
    memberUid: data.memberUid,
    type: data.type,
    amountMinor: data.amountMinor,
    currency: data.currency,
    note,
    occurredAt,
    clientRequestId: data.clientRequestId,
  };
}

/**
 * True if a previously-stored transaction matches an incoming replay.
 * @param {FirebaseFirestore.DocumentData} stored The existing persisted
 *   savingsTransactions document at the incoming clientRequestId.
 * @param {RecordSavingsTransactionInput} input The incoming validated
 *   request.
 * @param {string} authUid The incoming request's authenticated caller.
 * @param {Timestamp | undefined} occurredAtTimestamp The incoming
 *   request's occurredAt, already converted to a Timestamp if provided.
 * @return {boolean} True if every immutable stored fact matches.
 */
function storedFactsMatch(
  stored: FirebaseFirestore.DocumentData,
  input: RecordSavingsTransactionInput,
  authUid: string,
  occurredAtTimestamp: Timestamp | undefined
): boolean {
  if (stored.resourceType !== input.resourceType) {
    return false;
  }
  if (stored.resourceId !== input.resourceId) {
    return false;
  }
  if (stored.memberUid !== input.memberUid) {
    return false;
  }
  if (stored.recordedBy !== authUid) {
    return false;
  }
  if (stored.type !== input.type) {
    return false;
  }
  if (stored.amountMinor !== input.amountMinor) {
    return false;
  }
  if (stored.currency !== input.currency) {
    return false;
  }

  const storedNote: string | undefined = stored.note;
  if ((storedNote ?? undefined) !== (input.note ?? undefined)) {
    return false;
  }

  const storedOccurredAt: Timestamp | undefined = stored.occurredAt;
  if (storedOccurredAt === undefined && occurredAtTimestamp === undefined) {
    return true;
  }
  if (storedOccurredAt === undefined || occurredAtTimestamp === undefined) {
    return false;
  }
  return storedOccurredAt.isEqual(occurredAtTimestamp);
}
