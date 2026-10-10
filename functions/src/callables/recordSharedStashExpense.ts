import {createHash} from "crypto";
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
import type {MemberOwnershipBalance} from "../domain/tripOwnershipAccounting";
import {
  applySharedStashDepletion,
  reconcileOwnershipAgainstAggregate,
} from "../domain/tripOwnershipAccounting";
import type {
  TripOwnershipAllocationEntry,
} from "../domain/tripOwnershipAllocation";
import {tripOwnershipAllocationId} from "../domain/tripOwnershipAllocation";
import {
  classifyOwnershipMutationGate,
  classifyTripOwnershipModelState,
  isValidTripOwnershipModelTransition,
} from "../domain/tripOwnershipModel";
import {
  isValidOwnershipMinor,
  tripMemberOwnershipId,
} from "../domain/tripMemberOwnership";

type CallableAuth = CallableRequest["auth"];

// Checkpoint 4F.1, per the approved docs/audits/
// TRIP_SHARED_STASH_EXPENSE_PREFLIGHT_2026-09-30.md (as corrected by its
// 4F.0A amendment): the client supplies only the facts it legitimately
// controls - tripId, amount/currency, description/category, an optional
// occurredAt, and the clientRequestId identifying this logical request.
// There is no payerUid (the group fund paid, not a member), no
// splitStrategy/participants input (§15 - zero tripExpenseSplits are ever
// created for this payment source), and no paymentSource/
// sharedStashTransactionId/createdBy (all server-derived, §4 of this
// checkpoint's own instructions - the client must never be authoritative
// for any of them). See validateInput below for the exact wire contract;
// no separate raw-input interface is declared since every field is
// narrowed directly into ValidatedInput with no intermediate shape (unlike
// recordTripExpense.ts, whose participants field genuinely needs one).
interface ValidatedInput {
  tripId: string;
  amountMinor: number;
  currency: string;
  description: string;
  category?: string;
  occurredAtInstantMs: number | null;
  occurredAtTimestamp: Timestamp | undefined;
  clientRequestId: string;
  // Checkpoint 4F.4A, per the approved docs/audits/
  // TRIP_SHARED_STASH_EXPENSE_PREFLIGHT_2026-09-30.md §15: identifies the
  // OLD (already-reversed) Shared-Stash Expense this new Expense is a
  // correction/replacement for. Omitted for ordinary creation. Validated
  // as an ordinary Firestore document id, mirroring recordTripExpense.ts's
  // own replacesExpenseId contract exactly - never a new id format.
  replacesExpenseId: string | null;
}

// The server-normalized creationRequest snapshot compared on replay,
// mirroring recordTripExpense.ts's own NormalizedCreationRequest/
// creationRequestsMatch convention exactly. Deliberately does NOT include
// createdBy - that stays a separate, top-level persisted field compared
// independently, same split as recordTripExpense.ts.
interface NormalizedCreationRequest {
  tripId: string;
  amountMinor: number;
  currency: string;
  description: string;
  category: string | null;
  paymentSource: "shared_stash";
  occurredAtInstantMs: number | null;
  // Checkpoint 4F.4A: part of the exact creation identity, exactly like
  // every other field here - a same-clientRequestId request that changes
  // only its correction target is a genuine conflict (already-exists),
  // never an exact replay. Unlike recordTripExpense.ts's own
  // normalizeStoredReplacesExpenseId, no legacy-absent-key compatibility
  // shim is needed here - every document recordSharedStashExpenseCore
  // has ever written (before or after this checkpoint) already writes
  // this field explicitly, so a stored value is always a real
  // `string | null`, never an absent key.
  replacesExpenseId: string | null;
}

interface RecordSharedStashExpenseResult {
  expenseId: string;
  sharedStashTransactionId: string;
}

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
// Mirrors recordTripExpense.ts's own MAX_DESCRIPTION_LENGTH/
// MAX_CATEGORY_LENGTH values exactly - description/category play the
// identical role here as they do for an ordinary out-of-pocket Expense.
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_CATEGORY_LENGTH = 100;
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const MAX_FIRESTORE_DOCUMENT_ID_BYTES = 1500;

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "tripId",
  "amountMinor",
  "currency",
  "description",
  "category",
  "occurredAt",
  "clientRequestId",
  "replacesExpenseId",
]);

/**
 * recordSharedStashExpense
 * Input: {
 *   tripId: string, amountMinor: number, currency: string,
 *   description: string, category?: string, occurredAt?: string,
 *   clientRequestId: string,
 * }
 * Output: { expenseId: string, sharedStashTransactionId: string }
 *
 * Security (docs/audits/TRIP_SHARED_STASH_EXPENSE_PREFLIGHT_2026-09-30.md,
 * as corrected by its 4F.0A amendment):
 * - Requires caller to be signed in.
 * - Any current Trip member (memberIds or ownerId) may create a
 *   Shared-Stash Expense - identical to recordTripExpense's own
 *   authorization, never restricted to ownerId, never a new
 *   organizer/approver role (§9, FROZEN/final).
 * - New Expense creation is rejected on an archived Trip
 *   (failed-precondition), checked only AFTER caller authorization so an
 *   unauthorized caller never learns the Trip's archive state (§10).
 * - Idempotent replay is bound to BOTH the original creator (stored
 *   createdBy === authUid) AND an exact normalized creationRequest match,
 *   exactly mirroring recordTripExpense's own anti-enumeration property
 *   (§7/§16 of the preflight) - and additionally verifies (Checkpoint
 *   4F.1A) that the linked Shared-Stash withdrawal's resourceType,
 *   resourceId, type, amountMinor, currency, linkedExpenseId, and creator
 *   attribution all still match the original request, and that the
 *   Expense's own sharedStashTransactionId still equals the deterministic
 *   withdrawal id, before ever reconciling as a replay - never silently
 *   accepting or repairing a corrupted half-state.
 * - One atomic Firestore transaction produces the Expense, its linked
 *   savingsTransactions withdrawal, and the Trip's updated ledger/cache
 *   fields together, or none of them (§3/§8 of this checkpoint).
 * - Reproduces recordSavingsTransaction.ts's own canonical Trip
 *   ledger-state classification (already-initialized / legacy-
 *   uninitialized / partial-corrupt) and cached-field synchronization
 *   exactly, per the preflight's §4 frozen invariant - never a bare
 *   `ledgerBalanceMinor - amountMinor`.
 * - Zero tripExpenseSplits documents are ever created for this payment
 *   source (§11/§15) - there is no personal payer and therefore no
 *   reimbursement edge.
 * - Checkpoint 4F.4A: when replacesExpenseId is supplied, it is part of
 *   exact creation identity (a same-clientRequestId request with a
 *   different replacesExpenseId is already-exists, never a replay).
 *   Claiming the correction slot requires a narrower authorization than
 *   ordinary creation (Trip owner, OR the old Expense's createdBy/
 *   reversedBy while still a current member) - old Expense state
 *   (active/reversed/already-replaced) is never inspected or disclosed
 *   until that authorization succeeds, and the old Expense must itself be
 *   paymentSource === "shared_stash". Both link fields
 *   (new.replacesExpenseId, old.replacedByExpenseId) are written
 *   atomically in this same transaction, enforcing at most one direct
 *   replacement per reversed Expense - mirroring recordTripExpense.ts's
 *   own correction-link model exactly.
 */
export const recordSharedStashExpense = onCall(async (request) => {
  const authUid = requireAuthenticatedUid(request.auth);

  return recordSharedStashExpenseCore(getFirestore(), authUid, request.data);
});

/**
 * Requires an authenticated caller, matching the guard every callable in
 * this project uses (see recordTripExpense.ts/recordSavingsTransaction.ts).
 * Extracted so the production auth boundary itself can be tested directly -
 * the onCall wrapper above calls this exact function, not a separate/
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

// Checkpoint 5B.3, per the frozen preflight §12/item 12 of this
// checkpoint's own instructions: committing a Trip's
// "initialized" -> "needs_reconciliation" transition WHILE rejecting
// the Expense requires the state write to survive even though the
// callable must still report failure - throwing inside
// db.runTransaction's own callback would abort that same write. The
// fix: the transaction callback never throws for this one case: it
// queues the state-transition write (if the transition is itself
// legal) and returns a `{kind: "reconciliation_failed"}` sentinel
// instead of its usual `{kind: "success", result: ...}`; the
// HttpsError is thrown AFTER the transaction has already committed,
// outside the callback, once `outcome.kind` is inspected below.

/**
 * Testable trusted core. Receives an already-resolved Firestore instance
 * and the authenticated caller's uid rather than pulling either from the
 * onCall request context directly, so tests can invoke this against the
 * Firestore emulator without the heavier Functions-emulator/HTTPS callable
 * machinery - matching every other *Core function in this package.
 * @param {Firestore} db Admin SDK Firestore instance (emulator or prod).
 * @param {string} authUid The authenticated caller's uid.
 * @param {unknown} rawInput The callable request body, validated inside.
 * @return {Promise<RecordSharedStashExpenseResult>} The new/idempotently
 *   replayed Expense id and its linked Shared-Stash transaction id.
 */
export async function recordSharedStashExpenseCore(
  db: Firestore,
  authUid: string,
  rawInput: unknown
): Promise<RecordSharedStashExpenseResult> {
  const input = validateInput(rawInput);

  const withdrawalId = deriveSharedStashWithdrawalId(input.clientRequestId);

  const creationRequest: NormalizedCreationRequest = {
    tripId: input.tripId,
    amountMinor: input.amountMinor,
    currency: input.currency,
    description: input.description,
    category: input.category ?? null,
    paymentSource: "shared_stash",
    occurredAtInstantMs: input.occurredAtInstantMs,
    replacesExpenseId: input.replacesExpenseId,
  };

  const expenseRef = db.collection("tripExpenses").doc(input.clientRequestId);
  const withdrawalRef = db.collection("savingsTransactions").doc(withdrawalId);
  const tripRef = db.collection("trips").doc(input.tripId);
  // Checkpoint 5B.3A, item 1: the canonical allocation ref shares its id
  // with withdrawalRef by construction (tripOwnershipAllocationId
  // returns the withdrawal id unchanged) - read explicitly here, in the
  // same up-front read phase as every other collision guard, rather
  // than trusting that a deterministic id merely makes collision
  // "unreachable." A deterministic id makes the WRITE TARGET
  // predictable; it does not prove the document cannot already exist
  // (e.g. a stale/corrupt record).
  const allocationRef = db
    .collection("tripOwnershipAllocations")
    .doc(tripOwnershipAllocationId(withdrawalId));
  const historyQuery = db
    .collection("savingsTransactions")
    .where("resourceType", "==", "trip")
    .where("resourceId", "==", input.tripId)
    .limit(1);

  const outcome = await db.runTransaction(async (tx) => {
  // All mandatory reads happen before any write - Firestore transactions
  // require this ordering. The conditional historyQuery read (legacy/
  // uninitialized ledger branch, below) also happens before the first
  // write, matching recordSavingsTransaction.ts's own structure.
    const existingExpenseSnap = await tx.get(expenseRef);
    const existingWithdrawalSnap = await tx.get(withdrawalRef);
    const existingAllocationSnap = await tx.get(allocationRef);
    const tripSnap = await tx.get(tripRef);

    // A. Existing Expense / idempotent replay FIRST (mirrors
    // recordTripExpense.ts's own §5.1/§7-step-3 ordering) - evaluated
    // entirely from data already loaded above, no additional read, and
    // deliberately NOT gated on the parent Trip's existence (the same
    // Checkpoint 4C.2D "parent-independent replay" property
    // recordTripExpense.ts already established): the original creator
    // must be able to reconcile their own already-committed request even
    // if the Trip was later archived, they were later removed from Trip
    // membership, or the parent Trip document itself is unexpectedly
    // missing - that is historical reconciliation, not a fresh
    // authorization decision.
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

      // Exact replay: defensively verify the Expense and its linked
      // Shared-Stash withdrawal are STILL mutually consistent with the
      // original successful request before reconciling as a no-op
      // success - never silently trusting that the earlier atomic
      // transaction behaved as expected, and never silently repairing a
      // mismatch. These branches should be unreachable in practice (both
      // documents are always written together in one transaction,
      // §3/§8) - this is explicit corrupt/impossible-state handling.
      // Checkpoint 4F.1A: the withdrawal's deterministic document id is
      // already guaranteed correct by construction - existingWithdrawalSnap
      // was read at withdrawalRef, which is `.doc(withdrawalId)`, the same
      // deterministic id derived from this exact clientRequestId - so
      // there is no separate "wrong id" case to check; what remains is
      // verifying the CONTENT at that id is what the original request
      // actually produced.
      if (!existingWithdrawalSnap.exists) {
        throw new HttpsError(
          "failed-precondition",
          "Expense exists but its linked Shared Stash transaction is missing."
        );
      }
      const storedWithdrawal =
      existingWithdrawalSnap.data() as FirebaseFirestore.DocumentData;
      if (storedWithdrawal.resourceType !== "trip") {
        throw new HttpsError(
          "failed-precondition",
          "Linked Shared Stash transaction has an unexpected resourceType."
        );
      }
      if (storedWithdrawal.resourceId !== input.tripId) {
        throw new HttpsError(
          "failed-precondition",
          "Linked Shared Stash transaction has an unexpected resourceId."
        );
      }
      if (storedWithdrawal.type !== "withdrawal") {
        throw new HttpsError(
          "failed-precondition",
          "Linked Shared Stash transaction has an unexpected type."
        );
      }
      if (storedWithdrawal.amountMinor !== input.amountMinor) {
        throw new HttpsError(
          "failed-precondition",
          "Linked Shared Stash transaction has an unexpected amountMinor."
        );
      }
      if (storedWithdrawal.currency !== input.currency) {
        throw new HttpsError(
          "failed-precondition",
          "Linked Shared Stash transaction has an unexpected currency."
        );
      }
      if (storedWithdrawal.linkedExpenseId !== input.clientRequestId) {
        throw new HttpsError(
          "failed-precondition",
          "Linked Shared Stash transaction does not correspond to this " +
          "expense."
        );
      }
      // Expected creator attribution under the frozen 4F.1 design
      // (preflight §5): memberUid/recordedBy are both the ORIGINAL
      // creator (stored.createdBy, already confirmed === authUid above),
      // never the replaying caller's identity re-derived fresh - a
      // withdrawal attributed to someone other than the Expense's own
      // creator is corrupt, regardless of who is replaying the request.
      if (
        storedWithdrawal.memberUid !== stored.createdBy ||
      storedWithdrawal.recordedBy !== stored.createdBy
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Linked Shared Stash transaction has unexpected creator " +
          "attribution."
        );
      }
      if (stored.sharedStashTransactionId !== withdrawalId) {
        throw new HttpsError(
          "failed-precondition",
          "Expense's sharedStashTransactionId does not match its " +
          "deterministic withdrawal id."
        );
      }

      return {
        kind: "success" as const,
        result: {
          expenseId: input.clientRequestId,
          sharedStashTransactionId: withdrawalId,
        },
      };
    }

    // A2. Genuinely new request path: the derived withdrawal id must NOT
    // already exist. Since it is deterministically derived from
    // clientRequestId alone, this should be unreachable in practice
    // (it would require either a hash collision or some other write path
    // using this id) - fail closed rather than ever overwriting it.
    if (existingWithdrawalSnap.exists) {
      throw new HttpsError(
        "failed-precondition",
        "Unexpected existing Shared Stash transaction for this request."
      );
    }

    // B. Only for a GENUINELY NEW Expense: the parent Trip must exist.
    if (!tripSnap.exists) {
      throw new HttpsError(
        "not-found",
        "No trip found for the given tripId."
      );
    }
    const tripData = tripSnap.data() as FirebaseFirestore.DocumentData;

    // C. For a NEW Expense: validate caller is a current Trip member,
    // using isCurrentTripMember()'s own missing-safe/malformed-safe check -
    // this MUST run and reject BEFORE any structural-integrity fact about
    // the Trip is disclosed, mirroring recordTripExpense.ts's own ordering
    // exactly (preflight §9, FROZEN: any current Trip member, never
    // restricted to ownerId).
    if (!isCurrentTripMember(tripData, authUid)) {
      throw new HttpsError(
        "permission-denied",
        "You must be a current member of this Trip to record an expense."
      );
    }

    // C2. Only for an AUTHORIZED caller: now it's safe to disclose that
    // the Trip's own data is structurally corrupt.
    if (!Array.isArray(tripData.memberIds)) {
      throw new HttpsError(
        "failed-precondition",
        "Trip has malformed memberIds."
      );
    }

    // C3. Checkpoint 5B.3: the ownership-model-state gate, right after
    // membership authorization and before archive/correction-link - a
    // Trip that is "migrating"/"needs_reconciliation" rejects every new
    // Shared-Stash Expense outright, and a corrupt/unsupported-version
    // Trip fails closed, before any further work is done. A "legacy"
    // Trip falls through with zero behavior change; "initialized" is
    // handled further below, once the ownership set this operation
    // needs is cheap to load (right before the final atomic write).
    const ownershipGate = classifyOwnershipMutationGate(
      tripData.ownershipModelState,
      tripData.ownershipModelVersion
    );
    if (ownershipGate.kind === "blocked") {
      throw new HttpsError(
        "failed-precondition",
        "This trip's ownership model is currently being migrated or " +
        "reconciled; new Shared Stash expenses are temporarily " +
        "unavailable."
      );
    }
    if (ownershipGate.kind === "fail_closed") {
      throw new HttpsError(
        "failed-precondition",
        "This trip has an unsupported or corrupt ownership model state."
      );
    }

    // D. ONLY after caller authorization: check Trip archived state (§10,
    // FROZEN: new Shared-Stash Expense creation is archive-gated, exactly
    // like ordinary Expense creation).
    if (isTripArchived(tripData)) {
      throw new HttpsError(
        "failed-precondition",
        "This trip is archived and no longer accepts new expenses."
      );
    }

    // D2. Checkpoint 4F.4A, per the approved preflight §15 (as corrected
    // by 4F.4A): correction-target validation, ONLY on this genuinely-
    // new-Expense path, ONLY when replacesExpenseId was supplied, and
    // ONLY after the ordinary Trip-membership/archive authorization above
    // already succeeded - this is ADDITIONAL authorization/state
    // validation layered on top of ordinary creation authority, never a
    // replacement for it, mirroring recordTripExpense.ts's own D2/5A-5E
    // steps exactly. The old Expense is read here (still before any
    // write), then evaluated in this exact decision/disclosure order:
    // existence -> same-Trip -> same-payment-source -> correction-link
    // authorization -> ONLY THEN old status/already-replaced state
    // (reading data is not equivalent to disclosing it).
    let oldExpenseRef: FirebaseFirestore.DocumentReference | null = null;
    if (input.replacesExpenseId !== null) {
      oldExpenseRef = db
        .collection("tripExpenses")
        .doc(input.replacesExpenseId);
      const oldExpenseSnap = await tx.get(oldExpenseRef);

      // 5A. The referenced old Expense must exist.
      if (!oldExpenseSnap.exists) {
        throw new HttpsError(
          "failed-precondition",
          "replacesExpenseId does not reference an existing expense."
        );
      }
      const oldExpenseData =
      oldExpenseSnap.data() as FirebaseFirestore.DocumentData;

      // 5B. Structural/routing requirement, resolved before correction-
      // link authority is evaluated - authority over a DIFFERENT Trip's
      // record is not a question THIS Trip's membership can even answer.
      if (oldExpenseData.tripId !== input.tripId) {
        throw new HttpsError(
          "failed-precondition",
          "replacesExpenseId must reference an expense on the same trip."
        );
      }

      // 5B2. This callable only corrects a shared_stash original - a
      // member_out_of_pocket Expense must be corrected through
      // recordTripExpense instead, which has its own, independent
      // correction-link bookkeeping (replacedByExpenseId is a single,
      // shared top-level field - only one trusted writer may ever claim
      // it for a given old Expense).
      if (oldExpenseData.paymentSource !== "shared_stash") {
        throw new HttpsError(
          "failed-precondition",
          "replacesExpenseId must reference a Shared-Stash-funded expense."
        );
      }

      // 5C. Correction-link authorization - narrower than, and layered
      // on top of, ordinary creation authority: the Trip's current
      // owner, OR the old Expense's createdBy (still a current member),
      // OR the old Expense's reversedBy (still a current member).
      // Reached WITHOUT yet inspecting or disclosing whether the old
      // Expense is active/reversed or already replaced.
      const isOwner = tripData.ownerId === authUid;
      const isOldCreatorStillMember =
      oldExpenseData.createdBy === authUid &&
      isCurrentTripMember(tripData, authUid);
      const isOldReverserStillMember =
      oldExpenseData.reversedBy === authUid &&
      isCurrentTripMember(tripData, authUid);
      if (!isOwner && !isOldCreatorStillMember && !isOldReverserStillMember) {
        throw new HttpsError(
          "permission-denied",
          "You are not authorized to claim this expense's correction slot."
        );
      }

      // 5D. NOW, for an authorized caller only: the old Expense must
      // actually be reversed - safe to disclose now.
      if (oldExpenseData.status !== "reversed") {
        throw new HttpsError(
          "failed-precondition",
          "Only a reversed expense can be replaced."
        );
      }

      // 5E. At most one direct replacement, enforced by construction: if
      // replacedByExpenseId is already present in ANY non-absent form,
      // fail closed rather than silently overwriting it.
      if (oldExpenseData.replacedByExpenseId !== undefined) {
        throw new HttpsError(
          "failed-precondition",
          "This expense has already been replaced."
        );
      }
    }

    // E/F/G. Checkpoint 4F.5: currency/ledger-state/transition
    // interpretation is now delegated to the shared pure domain
    // primitive (functions/src/domain/savingsLedger.ts), extracted from
    // this exact logic (previously duplicated independently here and in
    // recordSavingsTransaction.ts) per the approved docs/audits/
    // TRIP_SHARED_STASH_EXPENSE_PREFLIGHT_2026-09-30.md §4/§24. Every
    // error code/message/ordering below is byte-for-byte identical to
    // this callable's own pre-extraction behavior - only WHERE the
    // interpretation happens moved, never WHAT it decides. A
    // Shared-Stash Expense is always a withdrawal (the group fund paid) -
    // never a client-displayed balance; the backend-authoritative
    // overdraft rejection below is checked against the canonical balance
    // obtained inside this same transaction (preflight §8/§12).
    const currencyResult = resolveEffectiveCurrency(tripData, input.currency);
    if (!currencyResult.ok) {
      if (currencyResult.reason === "malformed_parent_currency") {
        throw new HttpsError(
          "failed-precondition",
          "Trip has a malformed currency field."
        );
      }
      throw new HttpsError(
        "failed-precondition",
        "currency must match the Trip's currency " +
        `(${currencyResult.effectiveCurrency}).`
      );
    }

    let currentBalanceMinor: number;
    let initOpeningMinor: number | null = null;

    const initState = classifyLedgerInitialization(tripData);
    if (initState.kind === "initialized") {
      currentBalanceMinor = initState.currentBalanceMinor;
    } else if (initState.kind === "invalid_initialized_state") {
      throw new HttpsError(
        "failed-precondition",
        "Trip has an invalid trusted ledger state."
      );
    } else if (initState.kind === "uninitialized") {
    // Legacy/uninitialized Trip - guard against ambiguous prior history
    // before inventing an opening balance, exactly as
    // recordSavingsTransaction.ts does.
      const historySnap = await tx.get(historyQuery);
      if (!historySnap.empty) {
        throw new HttpsError(
          "failed-precondition",
          "Trip has savingsTransactions history but no initialized " +
          "ledger state."
        );
      }

      const legacyDollars = tripData.saved ?? 0;
      const legacyResult = deriveLegacyLedgerInitialization(legacyDollars);
      if (!legacyResult.ok) {
        if (legacyResult.reason === "invalid_legacy_value") {
          throw new HttpsError(
            "failed-precondition",
            "Trip has an invalid legacy compatibility balance."
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
        "Trip has a partial/corrupt ledger initialization state."
      );
    }

    // Checkpoint 5B.3, items 10-13: for an "initialized" Trip only, load
    // the complete tripMemberOwnership set for this Trip - the SAME set
    // this operation already needs to compute the §9 proportional
    // depletion, so this adds no separate architectural scan beyond what
    // the operation requires anyway (item 31 - unlike an ordinary
    // contribution/withdrawal, which never does this). Reconcile it
    // against the Trip's own trusted aggregate BEFORE computing or
    // committing anything - a genuine drift must never be spent against.
    let depletionAllocations: TripOwnershipAllocationEntry[] | null = null;
    let depletionResultingOwnership: MemberOwnershipBalance[] | null = null;
    if (ownershipGate.kind === "initialized") {
      // A3. Checkpoint 5B.3B: the canonical allocation document must
      // ALSO not already exist for a genuinely new request - checked
      // as its own explicit fact, never merely inferred from A2's
      // withdrawal check (the two are separate collections; a stale or
      // corrupt allocation record could exist even where the
      // withdrawal does not). This is the immutable financial
      // source-of-truth collection - it is NEVER overwritten, NEVER
      // merged, under any circumstance other than being newly created
      // once, right here. Deliberately scoped to the "initialized"
      // ownership-aware branch ONLY (moved here from an earlier,
      // unconditional position in Checkpoint 5B.3A) - a "legacy" Trip
      // never creates, reads for its own sake, or is blocked by
      // anything in this collection; the frozen contract that legacy
      // preserves today's exact aggregate-only behavior with zero new
      // dependency on tripOwnershipAllocations would otherwise be
      // violated by a stray/stale document a legacy Trip has no reason
      // to even know exists.
      if (existingAllocationSnap.exists) {
        throw new HttpsError(
          "failed-precondition",
          "Unexpected existing Shared Stash ownership allocation for " +
            "this request."
        );
      }

      const ownershipQuery = db
        .collection("tripMemberOwnership")
        .where("tripId", "==", input.tripId);
      const ownershipSnap = await tx.get(ownershipQuery);

      const balances: MemberOwnershipBalance[] = [];
      for (const doc of ownershipSnap.docs) {
        const rowData = doc.data();
        if (
          rowData.tripId !== input.tripId ||
        typeof rowData.uid !== "string" ||
        rowData.uid.length === 0 ||
        !isValidOwnershipMinor(rowData.ownershipMinor) ||
        doc.id !== tripMemberOwnershipId(input.tripId, rowData.uid)
        ) {
          throw new HttpsError(
            "failed-precondition",
            "This trip has a malformed Shared Stash ownership record."
          );
        }
        balances.push({
          uid: rowData.uid,
          ownershipMinor: rowData.ownershipMinor,
        });
      }

      if (balances.length === 0) {
        if (currentBalanceMinor !== 0) {
        // Zero ownership rows but a nonzero aggregate is a genuine
        // drift - fail closed and flag for reconciliation rather than
        // ever spending against an un-attributable balance.
          const reconciliationUpdate = buildNeedsReconciliationUpdate(
            tripData,
            authUid
          );
          if (reconciliationUpdate !== null) {
            tx.update(tripRef, reconciliationUpdate);
          }
          return {kind: "reconciliation_failed" as const};
        }
        throw new HttpsError(
          "failed-precondition",
          "No member has positive Shared Stash ownership - this expense " +
          "cannot be funded."
        );
      }

      const reconcileResult = reconcileOwnershipAgainstAggregate(
        currentBalanceMinor,
        balances
      );
      if (!reconcileResult.ok) {
        const reconciliationUpdate = buildNeedsReconciliationUpdate(
          tripData,
          authUid
        );
        if (reconciliationUpdate !== null) {
          tx.update(tripRef, reconciliationUpdate);
        }
        return {kind: "reconciliation_failed" as const};
      }

      const depletionResult = applySharedStashDepletion(
        input.amountMinor,
        balances
      );
      if (!depletionResult.ok) {
        throw new HttpsError(
          "failed-precondition",
          "Insufficient Shared Stash ownership to fund this expense."
        );
      }
      depletionAllocations = depletionResult.allocations;
      depletionResultingOwnership = depletionResult.resultingOwnership;
    }

    const transitionResult = applyLedgerTransition(
      currentBalanceMinor,
      "withdrawal",
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
        "Insufficient Shared Stash balance for this expense."
      );
    }
    const newBalanceMinor = transitionResult.newBalanceMinor;

    // H. Persist all documents atomically - the Expense, its linked
    // withdrawal, and the Trip's cached ledger fields either all commit
    // or none do (preflight §3).
    const expenseData: Record<string, unknown> = {
      tripId: input.tripId,
      payerUid: null,
      createdBy: authUid,
      amountMinor: input.amountMinor,
      currency: "USD",
      description: input.description,
      // No participants/debt exists for this payment source (§11/§15) -
      // "equal" is an inert default with zero split documents to apply to,
      // kept only because the existing Expense schema requires some
      // SplitStrategy value on every document.
      splitStrategy: "equal",
      paymentSource: "shared_stash",
      sharedStashTransactionId: withdrawalId,
      status: "active",
      createdAt: FieldValue.serverTimestamp(),
      creationRequest,
    };
    if (input.category !== undefined) {
      expenseData.category = input.category;
    }
    if (input.occurredAtTimestamp !== undefined) {
      expenseData.occurredAt = input.occurredAtTimestamp;
    }
    // Checkpoint 4F.4A: top-level replacesExpenseId is optional
    // correction/audit metadata, only ever persisted for a correction
    // creation - mirrors category's own conditional-write convention
    // exactly, and recordTripExpense.ts's own identical field. (The
    // creationRequest's own replacesExpenseId above ALWAYS exists,
    // explicit null for ordinary creation - that is the one field
    // compared on replay; this top-level field is display/audit
    // convenience only.)
    if (input.replacesExpenseId !== null) {
      expenseData.replacesExpenseId = input.replacesExpenseId;
    }
    tx.set(expenseRef, expenseData);

    // Checkpoint 4F.0/§5 (attribution semantics): memberUid remains
    // required for schema compatibility but is NOT personal attribution
    // here - linkedExpenseId's presence is the authoritative discriminator
    // that this is group-funded Expense activity, not a personal
    // withdrawal. Excluding linkedExpenseId-tagged transactions from
    // per-member personal totals is explicitly deferred to Checkpoint
    // 4F.3 (deriveMemberSavingsBalanceMinor), not implemented here.
    const withdrawalData: Record<string, unknown> = {
      resourceType: "trip",
      resourceId: input.tripId,
      memberUid: authUid,
      recordedBy: authUid,
      amountMinor: input.amountMinor,
      currency: input.currency,
      type: "withdrawal",
      createdAt: FieldValue.serverTimestamp(),
      reversalOf: null,
      linkedExpenseId: input.clientRequestId,
    };
    tx.set(withdrawalRef, withdrawalData);

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

    // Checkpoint 4F.4A: the ONE new write against the OLD Expense
    // document, in the SAME transaction as everything else above - both
    // directional link fields commit together or neither does. No other
    // field on the old Expense is ever touched, mirroring
    // recordTripExpense.ts's own identical write exactly.
    if (oldExpenseRef !== null) {
      tx.update(oldExpenseRef, {replacedByExpenseId: input.clientRequestId});
    }

    // Checkpoint 5B.3, items 13-15: for an "initialized" Trip only, the
    // ONE immutable tripOwnershipAllocations record for this expense -
    // keyed solely by the withdrawal's own id, never the Expense id -
    // plus every participating member's ownership-row update to the
    // pure allocator's own exact resultingOwnership value. The
    // allocations array comes straight from the pure helper, untouched -
    // never re-sorted/re-transformed here.
    if (
      depletionAllocations !== null &&
      depletionResultingOwnership !== null
    ) {
      // Checkpoint 5B.3A, item 1: reuses the SAME allocationRef already
      // read (and proven absent) above as `existingAllocationSnap` -
      // never re-derives a second reference to the same canonical id.
      // `tx.create` (not `tx.set`) is an additional write-time
      // safeguard on top of that explicit read: Firestore itself
      // rejects this write with ALREADY_EXISTS if the document were
      // somehow created between the read and this point, rather than
      // silently overwriting it either way.
      tx.create(allocationRef, {
        tripId: input.tripId,
        expenseId: input.clientRequestId,
        withdrawalTransactionId: withdrawalId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        allocations: depletionAllocations,
        provenance: "original",
        createdAt: FieldValue.serverTimestamp(),
      });

      const resultingByUid = new Map(
        depletionResultingOwnership.map((b) => [b.uid, b.ownershipMinor])
      );
      for (const allocation of depletionAllocations) {
        const newOwnershipMinor = resultingByUid.get(allocation.uid);
        if (newOwnershipMinor === undefined) {
          throw new HttpsError(
            "internal",
            "Internal invariant violated - allocated member missing from " +
            "resulting ownership."
          );
        }
        tx.update(
          db
            .collection("tripMemberOwnership")
            .doc(tripMemberOwnershipId(input.tripId, allocation.uid)),
          {
            ownershipMinor: newOwnershipMinor,
            lastUpdatedAt: FieldValue.serverTimestamp(),
          }
        );
      }
    }

    return {
      kind: "success" as const,
      result: {
        expenseId: input.clientRequestId,
        sharedStashTransactionId: withdrawalId,
      },
    };
  });

  if (outcome.kind === "reconciliation_failed") {
    throw new HttpsError(
      "failed-precondition",
      "This trip's ownership ledger could not be verified and has been " +
        "flagged for reconciliation. Please try again later."
    );
  }
  return outcome.result;
}

/**
 * Deterministic, collision-safe document id for the Shared-Stash
 * withdrawal linked to a given Expense request, derived from the
 * Expense's own clientRequestId plus a fixed discriminant - the exact
 * same hashed-JSON-array pattern splitDocumentId (functions/src/domain/
 * tripExpenseSplits.ts) already establishes, duplicated locally here
 * (preflight §6) rather than imported, matching this package's existing
 * per-file small-primitive duplication convention (CLIENT_REQUEST_ID_
 * PATTERN, isTripArchived, isValidFirestoreDocumentId are all duplicated
 * the same way). Pure and stateless, so it is safe to compute multiple
 * times (including across Firestore's own automatic transaction retries)
 * and always land on the same write target. The client never supplies or
 * sees this id.
 * @param {string} clientRequestId The Expense's own clientRequestId
 *   (== its document id).
 * @return {string} A lowercase-hex SHA-256 digest, safe to use as a
 *   Firestore document id.
 */
function deriveSharedStashWithdrawalId(clientRequestId: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify([clientRequestId, "shared-stash-withdrawal"]),
      "utf8"
    )
    .digest("hex");
}

/**
 * Checkpoint 5B.3, item 12: builds the Trip update that transitions
 * `"initialized" -> "needs_reconciliation"` (retaining the exact same
 * `ownershipModelVersion`, per the frozen state machine), or `null` if
 * that transition is not legal from the Trip's current classification
 * (defensive only - this is always called from the `"initialized"`
 * branch, so the transition should always be legal in practice). The
 * caller queues this as a `tx.update` and returns a sentinel WITHOUT
 * throwing, so the state write survives even though the overall
 * operation must still report failure - throwing inside the
 * transaction callback would abort this same write.
 * @param {FirebaseFirestore.DocumentData} tripData The Trip document
 *   data, as read inside this transaction.
 * @param {string} authUid The authenticated caller's uid.
 * @return {Record<string, unknown> | null} The Trip update to queue, or
 *   null if the transition is not legal.
 */
function buildNeedsReconciliationUpdate(
  tripData: FirebaseFirestore.DocumentData,
  authUid: string
): Record<string, unknown> | null {
  const classification = classifyTripOwnershipModelState(
    tripData.ownershipModelState,
    tripData.ownershipModelVersion
  );
  if (classification.kind !== "initialized") {
    return null;
  }
  const target = {
    kind: "needs_reconciliation" as const,
    version: classification.version,
  };
  if (!isValidTripOwnershipModelTransition(classification, target)) {
    return null;
  }
  return {
    ownershipModelState: "needs_reconciliation",
    lastUpdatedAt: FieldValue.serverTimestamp(),
    lastUpdatedBy: authUid,
  };
}

/**
 * True if uid is a current member of the Trip (memberIds or ownerId).
 * Never trusts client-supplied membership - always reads from the Trip
 * data loaded fresh inside the transaction. Duplicated verbatim from
 * recordTripExpense.ts/reverseTripExpense.ts (not exported there) - see
 * this file's own top-of-file duplication note.
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
 * Trusted-backend mirror of firestore.rules' `tripIsActive()` missing-safe
 * check, duplicated verbatim from recordTripExpense.ts/
 * recordSavingsTransaction.ts (each keeps its own copy, a deliberate,
 * well-justified duplication of a two-line predicate). A legacy Trip with
 * no `archivedAt` key, or one explicitly `null`, reads as active; only a
 * real archivedAt value reads as archived.
 * @param {FirebaseFirestore.DocumentData} tripData The Trip document data.
 * @return {boolean} True if the Trip is archived.
 */
function isTripArchived(tripData: FirebaseFirestore.DocumentData): boolean {
  return tripData.archivedAt !== undefined && tripData.archivedAt !== null;
}

/**
 * True if id satisfies Firestore's own document-id constraints (never
 * empty, never exactly "." or "..", never containing "/", and never
 * exceeding Firestore's maximum document-id byte length) - duplicated
 * verbatim from recordTripExpense.ts's own helper of the same name.
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
 * True if a previously-stored creationRequest snapshot exactly matches an
 * incoming normalized snapshot. Explicit field-by-field comparison (never
 * a blind JSON.stringify equality), mirroring recordTripExpense.ts's own
 * creationRequestsMatch convention. createdBy is deliberately NOT compared
 * here - it is checked separately, one level up, against the Expense
 * document's own top-level field.
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
    s.amountMinor === incoming.amountMinor &&
    s.currency === incoming.currency &&
    s.description === incoming.description &&
    (s.category ?? null) === incoming.category &&
    s.paymentSource === incoming.paymentSource &&
    (typeof s.occurredAtInstantMs === "number" ?
      s.occurredAtInstantMs :
      null) === incoming.occurredAtInstantMs &&
    (s.replacesExpenseId === undefined ? null : s.replacesExpenseId) ===
      incoming.replacesExpenseId
  );
}

/**
 * Validates and narrows a raw callable request body. Strict top-level
 * field validation: any key not in ALLOWED_TOP_LEVEL_KEYS is rejected
 * outright (invalid-argument) rather than silently ignored - this is how
 * an attempt to inject paymentSource/payerUid/sharedStashTransactionId/
 * createdBy/status/splitStrategy/participants is caught before ever
 * reaching Firestore (per this checkpoint's own §4 instruction: those
 * values must be server-derived, never client-suppliable).
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

  // Checkpoint 4F.4A: validated with the exact same isValidFirestoreDocumentId
  // helper already hardened for tripId - no new id format, no weaker
  // check, mirroring recordTripExpense.ts's own replacesExpenseId
  // validation exactly. Omitted normalizes to null, never left undefined.
  let replacesExpenseId: string | null = null;
  if (data.replacesExpenseId !== undefined) {
    if (
      typeof data.replacesExpenseId !== "string" ||
      !isValidFirestoreDocumentId(data.replacesExpenseId)
    ) {
      throw new HttpsError(
        "invalid-argument",
        "replacesExpenseId must be a non-empty, valid Firestore " +
          "document id."
      );
    }
    replacesExpenseId = data.replacesExpenseId;
  }

  return {
    tripId: data.tripId,
    amountMinor: data.amountMinor,
    currency: data.currency,
    description,
    category,
    occurredAtInstantMs,
    occurredAtTimestamp,
    clientRequestId: data.clientRequestId,
    replacesExpenseId,
  };
}

/**
 * Parses and validates an occurredAt string against the documented
 * contract: an ISO 8601 date-time string WITH AN EXPLICIT TIMEZONE,
 * duplicated verbatim from recordTripExpense.ts's own parseOccurredAt.
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
