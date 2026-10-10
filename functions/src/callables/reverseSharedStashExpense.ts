import {createHash} from "crypto";
import {FieldValue, Timestamp, getFirestore} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";
import type {MemberOwnershipBalance} from "../domain/tripOwnershipAccounting";
import {restoreSharedStashDepletion} from "../domain/tripOwnershipAccounting";
import {
  isValidTripOwnershipAllocationIdentity,
  validateTripOwnershipAllocationShape,
} from "../domain/tripOwnershipAllocation";
import {classifyOwnershipMutationGate} from "../domain/tripOwnershipModel";
import {
  isValidOwnershipMinor,
  tripMemberOwnershipId,
} from "../domain/tripMemberOwnership";

type CallableAuth = CallableRequest["auth"];

interface ReverseSharedStashExpenseResult {
  expenseId: string;
  refundTransactionId: string;
}

// The server-normalized reversalRequest snapshot compared on replay,
// duplicated verbatim from reverseTripExpense.ts's own
// NormalizedReversalRequest/reversalRequestsMatch convention.
interface NormalizedReversalRequest {
  clientRequestId: string;
  reversalReason: string | null;
}

interface ValidatedInput {
  expenseId: string;
  reversalReason: string | null;
  clientRequestId: string;
}

// Duplicated verbatim from reverseTripExpense.ts/recordSharedStashExpense.ts
// rather than imported - the established, deliberate per-file duplication
// convention already used throughout this package.
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_REVERSAL_REASON_LENGTH = 500;
const MAX_FIRESTORE_DOCUMENT_ID_BYTES = 1500;

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "expenseId",
  "reversalReason",
  "clientRequestId",
]);

/**
 * reverseSharedStashExpense
 * Input: {
 *   expenseId: string, reversalReason?: string, clientRequestId: string,
 * }
 * Output: { expenseId: string, refundTransactionId: string }
 *
 * Security (docs/audits/TRIP_SHARED_STASH_EXPENSE_PREFLIGHT_2026-09-30.md
 * §13/§14, as corrected by its 4F.0A amendment):
 * - Requires caller to be signed in.
 * - tripId is never client input - always read from the trusted,
 *   already-persisted Expense document, exactly mirroring
 *   reverseTripExpense.ts's own §4.1 convention.
 * - Authorization is IDENTICAL to reverseTripExpense.ts's own rule (FROZEN,
 *   no new authority rule introduced): the Trip's CURRENT owner, OR the
 *   Expense's original createdBy provided they are STILL a current Trip
 *   member.
 * - Reversal is NOT gated on Trip archive state - an archived Trip must
 *   still permit reversal, exactly like reverseTripExpense.ts.
 * - This is a DEDICATED path for paymentSource === "shared_stash" Expenses
 *   only - attempting to reverse a "member_out_of_pocket" Expense through
 *   this callable is rejected; use reverseTripExpense for that shape.
 * - One atomic Firestore transaction: marks the Expense reversed AND
 *   writes exactly one offsetting Shared Stash contribution AND updates
 *   the Trip's canonical ledger/cache fields together, or none of them.
 * - The refund amount is added to the Trip's CURRENT canonical balance at
 *   reversal time - never a restored historical snapshot - preserving any
 *   unrelated Shared Stash activity that happened before or after the
 *   original withdrawal.
 * - The refund's `reversalOf` links it to the ORIGINAL withdrawal
 *   (Expense.sharedStashTransactionId); the original withdrawal document
 *   itself is only ever READ here, never mutated or deleted.
 * - Idempotent replay is bound to BOTH the original reverser (stored
 *   reversedBy === authUid) AND an exact normalized reversalRequest match,
 *   AND (hardening beyond reverseTripExpense.ts, since this callable moves
 *   money) an exact match on paymentSource plus the linked refund
 *   transaction's own resourceType/resourceId/type/amountMinor/currency/
 *   reversalOf/linkedExpenseId/attribution - never silently reconciling a
 *   corrupted half-state as success.
 * - Before performing a genuinely new reversal, the ORIGINAL linked
 *   withdrawal is read and verified (resourceType/resourceId/type/
 *   amountMinor/currency/linkedExpenseId) - an inconsistent linked
 *   withdrawal is a reason to refuse the reversal, not to guess a refund
 *   amount.
 * - This callable never reads or writes tripExpenseSplits (no splits exist
 *   for this payment source).
 * - recordSavingsTransaction.ts is not modified or called by this file -
 *   the canonical Trip ledger-state classification it establishes is
 *   reproduced locally, matching recordSharedStashExpense.ts's own
 *   duplication of the same logic.
 */
export const reverseSharedStashExpense = onCall(async (request) => {
  const authUid = requireAuthenticatedUid(request.auth);

  return reverseSharedStashExpenseCore(getFirestore(), authUid, request.data);
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
 * onCall request context directly, matching every other *Core function in
 * this package.
 * @param {Firestore} db Admin SDK Firestore instance (emulator or prod).
 * @param {string} authUid The authenticated caller's uid.
 * @param {unknown} rawInput The callable request body, validated inside.
 * @return {Promise<ReverseSharedStashExpenseResult>} The reversed (or
 *   idempotently replayed) Expense id and its refund transaction id.
 */
export async function reverseSharedStashExpenseCore(
  db: Firestore,
  authUid: string,
  rawInput: unknown
): Promise<ReverseSharedStashExpenseResult> {
  const input = validateInput(rawInput);

  const incomingReversalRequest: NormalizedReversalRequest = {
    clientRequestId: input.clientRequestId,
    reversalReason: input.reversalReason,
  };

  const refundId = deriveSharedStashRefundId(input.clientRequestId);
  const expenseRef = db.collection("tripExpenses").doc(input.expenseId);
  const refundRef = db.collection("savingsTransactions").doc(refundId);

  return db.runTransaction(async (tx) => {
    // A. Read the Expense first, unconditionally.
    const expenseSnap = await tx.get(expenseRef);
    if (!expenseSnap.exists) {
      throw new HttpsError(
        "not-found",
        "No expense found for the given expenseId."
      );
    }
    const expenseData = expenseSnap.data() as FirebaseFirestore.DocumentData;

    // The deterministic refund slot is read here too (before any
    // branching) - both the replay branch below and the genuinely-new
    // collision guard further down reuse this same read, matching
    // recordSharedStashExpense.ts's own "read both documents up front"
    // structure.
    const refundSnap = await tx.get(refundRef);

    // B. Idempotent replay of MY OWN prior reversal, FIRST - before ANY
    // Trip lookup, before any authorization requirement of any kind,
    // mirroring reverseTripExpense.ts's own ordering exactly.
    // paymentSource is included in this match (hardening beyond
    // reverseTripExpense.ts): without it, an Expense that was already
    // reversed through the OTHER callable (reverseTripExpense, which
    // never inspects paymentSource) with a coincidentally-matching
    // reversalRequest/reversedBy could be misidentified here as THIS
    // callable's own prior successful refund, even though no refund was
    // ever written for it.
    if (
      expenseData.status === "reversed" &&
      expenseData.paymentSource === "shared_stash" &&
      expenseData.reversedBy === authUid &&
      reversalRequestsMatch(
        expenseData.reversalRequest,
        incomingReversalRequest
      )
    ) {
      // Exact replay: defensively verify the refund is still mutually
      // consistent with the original Expense before reconciling as a
      // no-op success - never silently trusting the earlier atomic
      // transaction, never silently repairing a mismatch.
      if (!refundSnap.exists) {
        throw new HttpsError(
          "failed-precondition",
          "Expense was reversed but its refund transaction is missing."
        );
      }
      const storedRefund = refundSnap.data() as FirebaseFirestore.DocumentData;
      if (storedRefund.resourceType !== "trip") {
        throw new HttpsError(
          "failed-precondition",
          "Refund transaction has an unexpected resourceType."
        );
      }
      if (storedRefund.resourceId !== expenseData.tripId) {
        throw new HttpsError(
          "failed-precondition",
          "Refund transaction has an unexpected resourceId."
        );
      }
      if (storedRefund.type !== "contribution") {
        throw new HttpsError(
          "failed-precondition",
          "Refund transaction has an unexpected type."
        );
      }
      if (storedRefund.amountMinor !== expenseData.amountMinor) {
        throw new HttpsError(
          "failed-precondition",
          "Refund transaction has an unexpected amountMinor."
        );
      }
      if (storedRefund.currency !== expenseData.currency) {
        throw new HttpsError(
          "failed-precondition",
          "Refund transaction has an unexpected currency."
        );
      }
      if (storedRefund.reversalOf !== expenseData.sharedStashTransactionId) {
        throw new HttpsError(
          "failed-precondition",
          "Refund transaction does not reference the original withdrawal."
        );
      }
      if (storedRefund.linkedExpenseId !== input.expenseId) {
        throw new HttpsError(
          "failed-precondition",
          "Refund transaction does not correspond to this expense."
        );
      }
      if (
        storedRefund.memberUid !== expenseData.reversedBy ||
        storedRefund.recordedBy !== expenseData.reversedBy
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Refund transaction has unexpected creator attribution."
        );
      }

      return {expenseId: input.expenseId, refundTransactionId: refundId};
    }

    // C. Validate ONLY expenseData.tripId - the single routing fact
    // actually required to identify which Trip governs authorization,
    // mirroring reverseTripExpense.ts's own step C exactly.
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
    // Trip document is read for authorization purposes.
    const tripRef = db.collection("trips").doc(tripId);
    const tripSnap = await tx.get(tripRef);
    if (!tripSnap.exists) {
      throw new HttpsError(
        "failed-precondition",
        "No trip found for this expense."
      );
    }
    const tripData = tripSnap.data() as FirebaseFirestore.DocumentData;

    // E. Authorization (FROZEN, identical to reverseTripExpense.ts - no
    // new authority rule). Reached WITHOUT ever having inspected
    // expenseData.status or paymentSource.
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
    // Trip archive status at all.

    // G. NOW, for an authorized caller only: validate expenseData.status.
    if (expenseData.status !== "active" && expenseData.status !== "reversed") {
      throw new HttpsError(
        "failed-precondition",
        "This expense has a malformed status and cannot be reversed."
      );
    }
    if (expenseData.status === "reversed") {
      // B already established this is NOT the caller's own prior
      // shared-stash reversal - either someone/something else's
      // already-committed reversal (possibly via reverseTripExpense,
      // which never writes a refund), or malformed metadata.
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

    // H. NOW, for an authorized caller with a genuinely active Expense:
    // this callable only handles shared_stash Expenses.
    if (expenseData.paymentSource !== "shared_stash") {
      throw new HttpsError(
        "failed-precondition",
        "This expense is not a Shared-Stash-funded expense and cannot " +
          "be reversed through this operation."
      );
    }

    // H2. Checkpoint 5B.3: the ownership-model-state gate, right after
    // authorization/status/paymentSource are all confirmed, and before
    // any further validation. A "migrating"/"needs_reconciliation" Trip
    // rejects every new reversal outright; a corrupt/unsupported-version
    // Trip fails closed. A "legacy" Trip falls through with zero
    // behavior change - older legacy expenses may have no allocation
    // record at all, and none is ever required on a legacy Trip.
    const ownershipGate = classifyOwnershipMutationGate(
      tripData.ownershipModelState,
      tripData.ownershipModelVersion
    );
    if (ownershipGate.kind === "blocked") {
      throw new HttpsError(
        "failed-precondition",
        "This trip's ownership model is currently being migrated or " +
          "reconciled; expense reversal is temporarily unavailable."
      );
    }
    if (ownershipGate.kind === "fail_closed") {
      throw new HttpsError(
        "failed-precondition",
        "This trip has an unsupported or corrupt ownership model state."
      );
    }

    // I. Validate the trusted financial facts this transaction is about
    // to use arithmetically.
    if (
      typeof expenseData.amountMinor !== "number" ||
      !Number.isSafeInteger(expenseData.amountMinor) ||
      expenseData.amountMinor <= 0
    ) {
      throw new HttpsError(
        "failed-precondition",
        "This expense has a malformed amountMinor and cannot be reversed."
      );
    }
    if (
      typeof expenseData.currency !== "string" ||
      expenseData.currency.length === 0
    ) {
      throw new HttpsError(
        "failed-precondition",
        "This expense has a malformed currency and cannot be reversed."
      );
    }

    // J. Read and verify the ORIGINAL linked withdrawal - never mutated or
    // deleted, only read, to confirm the refund amount is safe to trust.
    if (
      typeof expenseData.sharedStashTransactionId !== "string" ||
      expenseData.sharedStashTransactionId.length === 0
    ) {
      throw new HttpsError(
        "failed-precondition",
        "This expense has a malformed sharedStashTransactionId and " +
          "cannot be reversed."
      );
    }
    const withdrawalRef = db
      .collection("savingsTransactions")
      .doc(expenseData.sharedStashTransactionId);
    const withdrawalSnap = await tx.get(withdrawalRef);
    if (!withdrawalSnap.exists) {
      throw new HttpsError(
        "failed-precondition",
        "The linked Shared Stash withdrawal is missing."
      );
    }
    const withdrawalData =
      withdrawalSnap.data() as FirebaseFirestore.DocumentData;
    if (withdrawalData.resourceType !== "trip") {
      throw new HttpsError(
        "failed-precondition",
        "The linked Shared Stash withdrawal has an unexpected resourceType."
      );
    }
    if (withdrawalData.resourceId !== tripId) {
      throw new HttpsError(
        "failed-precondition",
        "The linked Shared Stash withdrawal has an unexpected resourceId."
      );
    }
    if (withdrawalData.type !== "withdrawal") {
      throw new HttpsError(
        "failed-precondition",
        "The linked Shared Stash withdrawal has an unexpected type."
      );
    }
    if (withdrawalData.amountMinor !== expenseData.amountMinor) {
      throw new HttpsError(
        "failed-precondition",
        "The linked Shared Stash withdrawal has an unexpected amountMinor."
      );
    }
    if (withdrawalData.currency !== expenseData.currency) {
      throw new HttpsError(
        "failed-precondition",
        "The linked Shared Stash withdrawal has an unexpected currency."
      );
    }
    if (withdrawalData.linkedExpenseId !== input.expenseId) {
      throw new HttpsError(
        "failed-precondition",
        "The linked Shared Stash withdrawal does not correspond to this " +
          "expense."
      );
    }

    // J2. Checkpoint 5B.3, items 18-21: for an "initialized" Trip only,
    // locate the ONE immutable tripOwnershipAllocations record this
    // Expense's original withdrawal created, cross-validate it against
    // the Expense/withdrawal we just verified, read every uid it names
    // (missing row fails closed - 5B.3 never reconstructs one), and
    // compute the exact restoration - NEVER recomputed proportions.
    let restoredOwnership: MemberOwnershipBalance[] | null = null;
    if (ownershipGate.kind === "initialized") {
      const allocationRef = db
        .collection("tripOwnershipAllocations")
        .doc(expenseData.sharedStashTransactionId);
      const allocationSnap = await tx.get(allocationRef);
      if (!allocationSnap.exists) {
        throw new HttpsError(
          "failed-precondition",
          "This expense's ownership allocation record is missing and " +
            "cannot be reversed."
        );
      }
      const allocationData =
        allocationSnap.data() as FirebaseFirestore.DocumentData;

      // Checkpoint 5B.3A, item 8: full persisted-record validation,
      // reusing the existing 5B.1 shape validator rather than
      // re-deriving ad-hoc field checks - proves the record is an
      // internally well-formed allocation (canonical ascending uid
      // order, no duplicates, positive entries, exact sum, a
      // recognized provenance) before any of this callable's OWN
      // cross-document linkage checks below are even attempted.
      // Deliberately accepts EITHER "original" or "migrated"
      // provenance - 5B.4 will backfill historical allocations as
      // "migrated", and reversal must restore those identically to a
      // live "original" one; this must never regress into silently
      // requiring provenance === "original".
      const shapeResult = validateTripOwnershipAllocationShape({
        tripId: allocationData.tripId,
        expenseId: allocationData.expenseId,
        withdrawalTransactionId: allocationData.withdrawalTransactionId,
        amountMinor: allocationData.amountMinor,
        currency: allocationData.currency,
        allocations: allocationData.allocations,
        provenance: allocationData.provenance,
      });
      if (!shapeResult.ok) {
        throw new HttpsError(
          "failed-precondition",
          "This expense's ownership allocation record is malformed."
        );
      }

      // Cross-document validation (item 19) - facts the shape
      // validator cannot know, since it only proves internal
      // well-formedness, never that THIS record correctly links to
      // THIS Expense/withdrawal. Any disagreement fails closed; no
      // partial reversal.
      if (
        allocationData.tripId !== tripId ||
        allocationData.expenseId !== input.expenseId ||
        allocationData.withdrawalTransactionId !==
          expenseData.sharedStashTransactionId ||
        !isValidTripOwnershipAllocationIdentity(
          allocationSnap.id,
          allocationData.withdrawalTransactionId
        ) ||
        allocationData.amountMinor !== expenseData.amountMinor ||
        allocationData.currency !== expenseData.currency
      ) {
        throw new HttpsError(
          "failed-precondition",
          "This expense's ownership allocation record is inconsistent " +
            "with the expense and cannot be reversed."
        );
      }

      // Checkpoint 5B.3A, item 8: runtime-only timestamp validation the
      // pure 5B.1 shape validator intentionally cannot perform - it
      // operates on the pre-write CANDIDATE shape, which carries no
      // timestamps at all (tripOwnershipAllocation.ts's own
      // TripOwnershipAllocationCandidate type). Validated here instead,
      // against the frozen persisted-schema boundary (5B.1A): every
      // record must carry a real createdAt; an "original" record must
      // never also carry migratedAt; a "migrated" record must carry a
      // real migratedAt too.
      if (!(allocationData.createdAt instanceof Timestamp)) {
        throw new HttpsError(
          "failed-precondition",
          "This expense's ownership allocation record has a missing or " +
            "invalid createdAt."
        );
      }
      if (allocationData.provenance === "original") {
        if (allocationData.migratedAt !== undefined) {
          throw new HttpsError(
            "failed-precondition",
            "This expense's ownership allocation record is malformed - " +
              "an \"original\" record must not carry migratedAt."
          );
        }
      } else if (!(allocationData.migratedAt instanceof Timestamp)) {
        throw new HttpsError(
          "failed-precondition",
          "This expense's ownership allocation record has a missing or " +
            "invalid migratedAt."
        );
      }

      // Read every named uid's CURRENT ownership row - every row must
      // still exist (the frozen former-member policy guarantees this
      // for a genuine steady-state reversal); a missing row fails
      // closed rather than being silently recreated. The entries
      // themselves are already proven well-formed by the shape
      // validator above (valid uid, ascending order, no duplicates).
      const balances: MemberOwnershipBalance[] = [];
      for (const entry of allocationData.allocations) {
        const uid = (entry as {uid: string}).uid;
        const rowRef = db
          .collection("tripMemberOwnership")
          .doc(tripMemberOwnershipId(tripId, uid));
        const rowSnap = await tx.get(rowRef);
        if (!rowSnap.exists) {
          throw new HttpsError(
            "failed-precondition",
            `No Shared Stash ownership record exists for "${uid}" on ` +
              "this trip - cannot restore."
          );
        }
        const rowData = rowSnap.data() as FirebaseFirestore.DocumentData;
        if (
          rowData.tripId !== tripId ||
          rowData.uid !== uid ||
          !isValidOwnershipMinor(rowData.ownershipMinor)
        ) {
          throw new HttpsError(
            "failed-precondition",
            `The Shared Stash ownership record for "${uid}" on this ` +
              "trip is malformed."
          );
        }
        balances.push({uid, ownershipMinor: rowData.ownershipMinor});
      }

      const restoreResult = restoreSharedStashDepletion(balances, {
        amountMinor: allocationData.amountMinor,
        allocations: allocationData.allocations,
      });
      if (!restoreResult.ok) {
        throw new HttpsError(
          "failed-precondition",
          "This expense's ownership allocation could not be restored."
        );
      }
      restoredOwnership = restoreResult.resultingOwnership;
    }

    // K. Genuinely new request path guard: the derived refund id must NOT
    // already exist. Since it is deterministically derived from this
    // reversal's own clientRequestId alone, this should be unreachable in
    // practice - fail closed rather than ever overwriting it.
    if (refundSnap.exists) {
      throw new HttpsError(
        "failed-precondition",
        "Unexpected existing Shared Stash refund for this request."
      );
    }

    // L. Canonical ledger-state classification, reproduced exactly from
    // recordSavingsTransaction.ts/recordSharedStashExpense.ts (preflight
    // §4 frozen invariant) - never a bare addition to ledgerBalanceMinor
    // without first confirming the Trip's trusted ledger state is
    // well-formed.
    const hasOpening = "ledgerOpeningBalanceMinor" in tripData;
    const hasBalance = "ledgerBalanceMinor" in tripData;

    let currentBalanceMinor: number;
    let initOpeningMinor: number | null = null;

    if (hasOpening && hasBalance) {
      const opening = tripData.ledgerOpeningBalanceMinor;
      const balance = tripData.ledgerBalanceMinor;
      const openingValid = Number.isSafeInteger(opening) && opening >= 0;
      const balanceValid = Number.isSafeInteger(balance) && balance >= 0;
      if (!openingValid || !balanceValid) {
        throw new HttpsError(
          "failed-precondition",
          "Trip has an invalid trusted ledger state."
        );
      }
      currentBalanceMinor = balance;
    } else if (!hasOpening && !hasBalance) {
      // Checkpoint 4F.2A fix: reproduce recordSavingsTransaction.ts's/
      // recordSharedStashExpense.ts's own history-emptiness guard here
      // too, rather than silently legacy-deriving. A genuine shared_stash
      // Expense's original withdrawal is itself a savingsTransactions
      // document for this exact (resourceType, resourceId) pair - so if
      // BOTH canonical ledger fields are missing from the Trip while
      // savingsTransactions history already exists (the original
      // withdrawal, or any other prior activity), this is exactly the
      // ambiguous/corrupt state recordSavingsTransaction.ts itself
      // refuses to silently reinitialize from - never guessed or
      // reconstructed, regardless of how plausible a legacy `saved`
      // value might look.
      const historySnap = await tx.get(
        db
          .collection("savingsTransactions")
          .where("resourceType", "==", "trip")
          .where("resourceId", "==", tripId)
          .limit(1)
      );
      if (!historySnap.empty) {
        throw new HttpsError(
          "failed-precondition",
          "Trip has savingsTransactions history but no initialized " +
            "ledger state."
        );
      }

      // A shared_stash Expense can only ever have been created by
      // recordSharedStashExpenseCore, which always initializes the
      // ledger on its own first successful write - so, now that the
      // history guard above has confirmed no prior savingsTransactions
      // activity exists for this Trip at all, this branch should still be
      // unreachable in practice for a Trip with a genuinely active
      // shared_stash Expense (its own withdrawal would already be exactly
      // such history). Handled anyway, reproducing the same
      // legacy-derivation rule, rather than assuming initialization.
      const legacyDollars = tripData.saved ?? 0;
      const legacyValid =
        typeof legacyDollars === "number" &&
        Number.isFinite(legacyDollars) &&
        legacyDollars >= 0;
      if (!legacyValid) {
        throw new HttpsError(
          "failed-precondition",
          "Trip has an invalid legacy compatibility balance."
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
        "Trip has a partial/corrupt ledger initialization state."
      );
    }

    // M. The refund ADDS the original Expense amount back to the Trip's
    // CURRENT canonical balance - never a restored historical snapshot.
    // Any unrelated Shared Stash activity that happened before or after
    // the original withdrawal is preserved exactly, since this is a
    // single additive delta applied on top of whatever the current
    // balance happens to be.
    const newBalanceMinor = currentBalanceMinor + expenseData.amountMinor;
    if (!Number.isSafeInteger(newBalanceMinor)) {
      throw new HttpsError(
        "failed-precondition",
        "Resulting balance is not a safe integer."
      );
    }

    // N. Persist all documents atomically - the refund, the reversed
    // Expense, and the Trip's cached ledger fields either all commit or
    // none do.
    const refundData: Record<string, unknown> = {
      resourceType: "trip",
      resourceId: tripId,
      memberUid: authUid,
      recordedBy: authUid,
      amountMinor: expenseData.amountMinor,
      currency: expenseData.currency,
      type: "contribution",
      createdAt: FieldValue.serverTimestamp(),
      reversalOf: expenseData.sharedStashTransactionId,
      linkedExpenseId: input.expenseId,
    };
    tx.set(refundRef, refundData);

    const expenseUpdate: Record<string, unknown> = {
      status: "reversed",
      reversedAt: FieldValue.serverTimestamp(),
      reversedBy: authUid,
      reversalRequest: incomingReversalRequest,
      refundTransactionId: refundId,
      reversalReason:
        input.reversalReason !== null ?
          input.reversalReason :
          FieldValue.delete(),
    };
    tx.update(expenseRef, expenseUpdate);

    const tripUpdate: Record<string, unknown> = {
      ledgerBalanceMinor: newBalanceMinor,
      lastUpdatedAt: FieldValue.serverTimestamp(),
      lastUpdatedBy: authUid,
      saved: newBalanceMinor / 100,
    };
    if (initOpeningMinor !== null) {
      tripUpdate.ledgerOpeningBalanceMinor = initOpeningMinor;
    }
    tx.update(tripRef, tripUpdate);

    // Checkpoint 5B.3, item 21: every restored member's ownership row,
    // in this SAME transaction - the original allocation record itself
    // is never touched/mutated/re-created; only each named uid's own
    // CURRENT ownership row moves, by exactly their original delta.
    if (restoredOwnership !== null) {
      for (const b of restoredOwnership) {
        tx.update(
          db.collection("tripMemberOwnership").doc(
            tripMemberOwnershipId(tripId, b.uid)
          ),
          {
            ownershipMinor: b.ownershipMinor,
            lastUpdatedAt: FieldValue.serverTimestamp(),
          }
        );
      }
    }

    return {expenseId: input.expenseId, refundTransactionId: refundId};
  });
}

/**
 * Deterministic, collision-safe document id for the Shared-Stash refund
 * linked to a given reversal request, derived from the reversal's own
 * clientRequestId plus a fixed discriminant distinct from
 * recordSharedStashExpense.ts's own "shared-stash-withdrawal" discriminant
 * - the exact same hashed-JSON-array pattern splitDocumentId establishes,
 * duplicated locally here.
 * @param {string} reversalClientRequestId The reversal's own
 *   clientRequestId.
 * @return {string} A lowercase-hex SHA-256 digest, safe to use as a
 *   Firestore document id.
 */
function deriveSharedStashRefundId(reversalClientRequestId: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify([reversalClientRequestId, "shared-stash-refund"]),
      "utf8"
    )
    .digest("hex");
}

/**
 * True if uid is a current member of the Trip (memberIds or ownerId).
 * Duplicated verbatim from reverseTripExpense.ts/recordTripExpense.ts.
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
 * True if id satisfies Firestore's own document-id constraints. Duplicated
 * verbatim from reverseTripExpense.ts/recordTripExpense.ts.
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
 * True if a previously-stored reversalRequest snapshot exactly matches an
 * incoming normalized snapshot. Duplicated verbatim from
 * reverseTripExpense.ts's own reversalRequestsMatch.
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
 * True if value has the EXACT expected NormalizedReversalRequest shape.
 * Duplicated verbatim from reverseTripExpense.ts's own
 * isWellFormedReversalRequestSnapshot.
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
 * field validation, mirroring reverseTripExpense.ts's own validateInput.
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
