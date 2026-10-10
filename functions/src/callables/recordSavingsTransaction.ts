import {FieldValue, Timestamp, getFirestore} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";
import {
  applyLedgerTransition,
  classifyLedgerInitialization,
  deriveLegacyLedgerInitialization,
  resolveEffectiveCurrency,
} from "../domain/savingsLedger";
import {
  applyMemberContribution,
  applyMemberWithdrawal,
} from "../domain/tripOwnershipAccounting";
import {classifyOwnershipMutationGate} from "../domain/tripOwnershipModel";
import {
  isValidOwnershipMinor,
  tripMemberOwnershipId,
} from "../domain/tripMemberOwnership";

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

    // Checkpoint 5B.3 (docs/audits/TRIP_WALLET_OWNERSHIP_WITHDRAWAL_
    // PREFLIGHT_2026-10-08.md §11, extending recordSavingsTransactionCore's
    // existing sequence exactly as frozen: self-only -> current-member ->
    // [NEW] ownership-model-state gate -> [NEW] ownership ceiling ->
    // archive-gate -> currency/ledger-state -> aggregate transition).
    // Only the "trip" resource type has any ownership model at all - a
    // "bucket" (including a trip_personal My Stash Bucket) is single-
    // member by definition and is never touched by any of this.
    let ownershipRowUpdate: {
      ref: FirebaseFirestore.DocumentReference;
      newOwnershipMinor: number;
    } | null = null;
    if (input.resourceType === "trip") {
      const gate = classifyOwnershipMutationGate(
        parentData.ownershipModelState,
        parentData.ownershipModelVersion
      );
      if (gate.kind === "blocked") {
        throw new HttpsError(
          "failed-precondition",
          "This trip's ownership model is currently being migrated or " +
            "reconciled; new savings activity is temporarily unavailable."
        );
      }
      if (gate.kind === "fail_closed") {
        throw new HttpsError(
          "failed-precondition",
          "This trip has an unsupported or corrupt ownership model state."
        );
      }
      if (gate.kind === "initialized") {
        // An initialized Trip has, by definition, completed migration/
        // reconciliation and must have a complete trusted ownership
        // cache - 5B.3 never silently invents or repairs a missing row
        // (that is exclusively 5B.4/5B.5's job).
        const ownershipId = tripMemberOwnershipId(
          input.resourceId,
          input.memberUid
        );
        const ownershipRef = db
          .collection("tripMemberOwnership")
          .doc(ownershipId);
        const ownershipSnap = await tx.get(ownershipRef);
        if (!ownershipSnap.exists) {
          throw new HttpsError(
            "failed-precondition",
            "No Shared Stash ownership record exists for you on this trip."
          );
        }
        const ownershipData =
          ownershipSnap.data() as FirebaseFirestore.DocumentData;
        if (
          ownershipData.tripId !== input.resourceId ||
          ownershipData.uid !== input.memberUid ||
          !isValidOwnershipMinor(ownershipData.ownershipMinor)
        ) {
          throw new HttpsError(
            "failed-precondition",
            "Your Shared Stash ownership record is malformed."
          );
        }
        const currentOwnershipMinor: number = ownershipData.ownershipMinor;

        if (input.type === "contribution") {
          const contributionResult = applyMemberContribution(
            currentOwnershipMinor,
            input.amountMinor
          );
          if (!contributionResult.ok) {
            throw new HttpsError(
              "failed-precondition",
              "Your resulting Shared Stash ownership is not a safe integer."
            );
          }
          ownershipRowUpdate = {
            ref: ownershipRef,
            newOwnershipMinor: contributionResult.newOwnershipMinor,
          };
        } else {
          // withdrawal - the frozen ceiling: requested <= own ownership.
          // The Trip owner has no special ability to consume someone
          // else's ownership; this primitive only ever sees the acting
          // member's own row, structurally.
          const withdrawalResult = applyMemberWithdrawal(
            currentOwnershipMinor,
            input.amountMinor
          );
          if (!withdrawalResult.ok) {
            throw new HttpsError(
              "failed-precondition",
              "This withdrawal exceeds your own Shared Stash ownership."
            );
          }
          ownershipRowUpdate = {
            ref: ownershipRef,
            newOwnershipMinor: withdrawalResult.newOwnershipMinor,
          };
        }
      }
      // gate.kind === "legacy": no ownership row is read or required -
      // today's exact aggregate-only behavior, unchanged.
    }

    // Checkpoint 4B.5C (docs/audits/TRIP_ARCHIVE_DELETE_SAFETY_PREFLIGHT_
    // 2026-09-13.md, as hardened by its 4B.5A.1 amendment), ordering
    // corrected by 4B.5C.1: the trusted enforcement half of the archive
    // lifecycle 4B.5B already built in Rules/UI. This sits AFTER the
    // idempotent-replay check above (an exact replay of an already-
    // committed contribution answers "did this already happen?", not "is
    // it still allowed today" - it must keep reconciling to the original
    // success even once the Trip has since been archived) AND after the
    // membership/self-only authorization checks immediately above (an
    // unauthorized caller must learn permission-denied, never the Trip's
    // archive state - putting this check any earlier would leak Trip
    // lifecycle state to a caller who isn't even authorized to act on the
    // resource). Only new "trip" contributions are affected: withdrawals
    // continue through every existing invariant unchanged (the wind-down
    // model only closes the contribution path), and "bucket" (including a
    // trip_personal My Stash Bucket) never consults Trip archive state at
    // all - archive status is not permission-denied (the caller is, by
    // this point, already confirmed to be a fully valid member) but a
    // failed-precondition on the resource's own lifecycle state.
    if (
      input.resourceType === "trip" &&
      input.type === "contribution" &&
      isTripArchived(parentData)
    ) {
      throw new HttpsError(
        "failed-precondition",
        "This trip is archived and no longer accepts shared contributions."
      );
    }

    // Checkpoint 4F.5: currency/ledger-state/transition interpretation is
    // now delegated to the shared pure domain primitive
    // (functions/src/domain/savingsLedger.ts), extracted from this exact
    // logic per the approved docs/audits/
    // TRIP_SHARED_STASH_EXPENSE_PREFLIGHT_2026-09-30.md §4/§24. Every
    // error code/message/ordering below is byte-for-byte identical to
    // this callable's own pre-extraction behavior - only WHERE the
    // interpretation happens moved, never WHAT it decides.
    const currencyResult = resolveEffectiveCurrency(parentData, input.currency);
    if (!currencyResult.ok) {
      if (currencyResult.reason === "malformed_parent_currency") {
        throw new HttpsError(
          "failed-precondition",
          "Parent resource has a malformed currency field."
        );
      }
      throw new HttpsError(
        "failed-precondition",
        "currency must match the resource's currency " +
          `(${currencyResult.effectiveCurrency}).`
      );
    }

    let currentBalanceMinor: number;
    let initOpeningMinor: number | null = null;

    const initState = classifyLedgerInitialization(parentData);
    if (initState.kind === "initialized") {
      currentBalanceMinor = initState.currentBalanceMinor;
    } else if (initState.kind === "invalid_initialized_state") {
      throw new HttpsError(
        "failed-precondition",
        "Parent resource has an invalid trusted ledger state."
      );
    } else if (initState.kind === "uninitialized") {
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
      const legacyResult = deriveLegacyLedgerInitialization(legacyDollars);
      if (!legacyResult.ok) {
        if (legacyResult.reason === "invalid_legacy_value") {
          throw new HttpsError(
            "failed-precondition",
            "Parent resource has an invalid legacy compatibility balance."
          );
        }
        throw new HttpsError(
          "failed-precondition",
          "Legacy compatibility balance is too large to convert safely."
        );
      }
      currentBalanceMinor = legacyResult.currentBalanceMinor;
      initOpeningMinor = legacyResult.initOpeningMinor;
    } else {
      // partial_corrupt
      throw new HttpsError(
        "failed-precondition",
        "Parent resource has a partial/corrupt ledger initialization " +
          "state."
      );
    }

    const transitionResult = applyLedgerTransition(
      currentBalanceMinor,
      input.type,
      input.amountMinor
    );
    if (!transitionResult.ok) {
      if (transitionResult.reason === "unsafe_result") {
        throw new HttpsError(
          "failed-precondition",
          "Resulting balance is not a safe integer."
        );
      }
      throw new HttpsError(
        "failed-precondition",
        "Insufficient balance for this withdrawal."
      );
    }
    const newBalanceMinor = transitionResult.newBalanceMinor;

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

    // Checkpoint 5B.3: the exact same contribution/withdrawal amount
    // that just moved Trip.ledgerBalanceMinor also moves the acting
    // member's own tripMemberOwnership row, atomically, in this same
    // transaction - only for an "initialized" Trip (ownershipRowUpdate
    // stays null for "legacy", which never reads or writes this
    // collection at all). No other member's row is ever touched.
    if (ownershipRowUpdate !== null) {
      tx.update(ownershipRowUpdate.ref, {
        ownershipMinor: ownershipRowUpdate.newOwnershipMinor,
        lastUpdatedAt: FieldValue.serverTimestamp(),
      });
    }

    return {
      transactionId: input.clientRequestId,
      balanceMinor: newBalanceMinor,
    };
  });
}

/**
 * Checkpoint 4B.5C: trusted-backend mirror of the client Rules'
 * `tripIsActive()` missing-safe check (firestore.rules) - deliberately no
 * separate `status: "active" | "archived"` field exists anywhere in this
 * system, so `archivedAt`'s own presence is the only source of truth. A
 * legacy Trip with no `archivedAt` key, or one explicitly `null`, reads as
 * active; only a real archivedAt value (Firestore returns a Timestamp for
 * a persisted field, but this only needs "is a real value present") reads
 * as archived.
 * @param {FirebaseFirestore.DocumentData} tripData The Trip document data.
 * @return {boolean} True if the Trip is archived.
 */
function isTripArchived(tripData: FirebaseFirestore.DocumentData): boolean {
  return tripData.archivedAt !== undefined && tripData.archivedAt !== null;
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
