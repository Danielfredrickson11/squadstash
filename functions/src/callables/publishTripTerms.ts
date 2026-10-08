import {FieldValue, getFirestore} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";

type CallableAuth = CallableRequest["auth"];

interface PublishTripTermsInput {
  tripId: string;
  contributionExpectations: string;
  expenseAllocationExpectations: string;
  sharedStashSpendingAuthority: string;
  withdrawalExpectations: string;
  settlementExpectations: string;
}

interface PublishTripTermsResult {
  termsDocId: string;
  version: number;
}

const MAX_FIELD_LENGTH = 2000;

/**
 * publishTripTerms (Checkpoint 5A.1, items 5/6 - docs/audits/
 * TRIP_WALLET_MILESTONE_PREFLIGHT_2026-10-06.md)
 * Input: {
 *   tripId: string, contributionExpectations: string,
 *   expenseAllocationExpectations: string,
 *   sharedStashSpendingAuthority: string, withdrawalExpectations: string,
 *   settlementExpectations: string,
 * }
 * Output: { termsDocId: string, version: number }
 *
 * Security:
 * - Requires caller to be signed in.
 * - Owner-only (Master Spec §7.1: defining the contribution plan/trip
 *   terms is an owner privilege - no Manager role exists yet to delegate
 *   it to).
 * - Rejects an archived Trip (no new terms versions once a Trip can no
 *   longer accept new activity, matching every other "new activity"
 *   gate already applied elsewhere).
 * - This is now the SOLE path that can create a tripTerms document;
 *   firestore.rules closes direct client creation entirely (see that
 *   file's own comment on the collection for why a client-computed
 *   "max version + 1" could never be an authoritative answer).
 *
 * Maintains tripTermsCurrent/{tripId} - a single pointer document per
 * Trip naming the current authoritative version - inside the SAME
 * Firestore transaction that creates the new tripTerms document, so the
 * two can never be read out of step with each other. Reading-then-
 * incrementing that one pointer document inside a transaction is what
 * makes concurrent publish attempts serialize correctly: Firestore
 * detects the conflicting read/write on tripTermsCurrent and retries the
 * loser automatically (the same standard Firestore counter pattern used
 * elsewhere - e.g. this project's own ledger-balance updates), so two
 * concurrent calls can never both produce "version N" - the second
 * always retries against the first's already-committed pointer and
 * produces N+1.
 *
 * FAILS CLOSED on corrupt pointer state (Checkpoint 5A.2): an absent
 * pointer is the one legitimate "never had terms" state (resolves to
 * version 1); an EXISTING pointer is trusted authoritative state, so a
 * malformed one (wrong tripId, invalid currentVersion, invalid
 * currentTermsDocId, or a currentTermsDocId naming a document that is
 * missing/mismatched/version-disagreeing) is REJECTED outright - never
 * silently treated as "no terms yet," which would risk colliding with
 * a real, already-published version 1. No automatic repair is ever
 * attempted; see assertValidExistingPointer/assertPointerTargetValid.
 */
export const publishTripTerms = onCall(async (request) => {
  const authUid = requireAuthenticatedUid(request.auth);

  return publishTripTermsCore(getFirestore(), authUid, request.data);
});

/**
 * Requires an authenticated caller, matching the guard every callable in
 * this project uses.
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
 * onCall request context directly - matching every other callable's own
 * Core-function convention in this project.
 * @param {Firestore} db Admin SDK Firestore instance (emulator or prod).
 * @param {string} authUid The authenticated caller's uid.
 * @param {unknown} rawInput The callable request body, validated inside.
 * @return {Promise<PublishTripTermsResult>} The new terms document's id
 *   and its assigned version number.
 */
export async function publishTripTermsCore(
  db: Firestore,
  authUid: string,
  rawInput: unknown
): Promise<PublishTripTermsResult> {
  const input = validateInput(rawInput);
  const tripRef = db.collection("trips").doc(input.tripId);

  // Preliminary authorization read, mirroring createTripInvitation.ts's
  // own ordering discipline - fails fast before opening a transaction.
  // There is no email lookup here, so no enumeration concern applies,
  // but resolving authorization before any heavier work is still the
  // right default.
  const preliminaryTripSnap = await tripRef.get();
  assertTripTermsAuthorized(preliminaryTripSnap, authUid);

  const pointerRef = db.collection("tripTermsCurrent").doc(input.tripId);

  return db.runTransaction(async (tx) => {
    // All reads happen before any write - Firestore transactions require
    // this ordering. RE-READS and RE-VALIDATES the Trip from scratch -
    // race/concurrency protection (e.g. the Trip was archived or its
    // ownership changed between the preliminary read above and this
    // transaction).
    const tripSnap = await tx.get(tripRef);
    const pointerSnap = await tx.get(pointerRef);

    assertTripTermsAuthorized(tripSnap, authUid);

    // Checkpoint 5A.2 (items 1/2): an ABSENT pointer is the one and only
    // legitimate "this Trip has never had terms" state, and resolves to
    // version 1. An EXISTING pointer is trusted authoritative state - if
    // it exists at all, it must be internally valid, and the exact
    // tripTerms document it names must itself agree with it, or this
    // call fails closed rather than silently treating corruption as
    // "never had terms" (which would have invented a FALSE version 1,
    // potentially colliding with a real, already-published version 1).
    // The target-document read happens inside this same transaction,
    // still before any write below - an additional read, never a
    // collection scan.
    let nextVersion: number;
    if (!pointerSnap.exists) {
      nextVersion = 1;
    } else {
      const pointerData = pointerSnap.data() as FirebaseFirestore.DocumentData;
      const currentVersion = assertValidExistingPointer(
        pointerData,
        input.tripId
      );

      const targetRef = db
        .collection("tripTerms")
        .doc(pointerData.currentTermsDocId as string);
      const targetSnap = await tx.get(targetRef);
      assertPointerTargetValid(targetSnap, input.tripId, currentVersion);

      nextVersion = currentVersion + 1;
      if (!Number.isSafeInteger(nextVersion) || nextVersion <= 0) {
        throw new HttpsError(
          "failed-precondition",
          "Trip terms version counter cannot be safely incremented."
        );
      }
    }

    const newTermsRef = db.collection("tripTerms").doc();

    tx.set(newTermsRef, {
      tripId: input.tripId,
      version: nextVersion,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: authUid,
      contributionExpectations: input.contributionExpectations,
      expenseAllocationExpectations: input.expenseAllocationExpectations,
      sharedStashSpendingAuthority: input.sharedStashSpendingAuthority,
      withdrawalExpectations: input.withdrawalExpectations,
      settlementExpectations: input.settlementExpectations,
    });

    tx.set(pointerRef, {
      tripId: input.tripId,
      currentVersion: nextVersion,
      currentTermsDocId: newTermsRef.id,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {termsDocId: newTermsRef.id, version: nextVersion};
  });
}

/**
 * Establishes Trip existence, owner-only authority, and non-archived
 * state - shared by both the preliminary and transactional reads in
 * publishTripTermsCore, so the two can never silently drift out of sync.
 * @param {FirebaseFirestore.DocumentSnapshot} tripSnap The Trip document
 *   snapshot to validate.
 * @param {string} authUid The authenticated caller's uid.
 * @return {void}
 */
function assertTripTermsAuthorized(
  tripSnap: FirebaseFirestore.DocumentSnapshot,
  authUid: string
): void {
  if (!tripSnap.exists) {
    throw new HttpsError("not-found", "No Trip found for the given tripId.");
  }
  const tripData = tripSnap.data() as FirebaseFirestore.DocumentData;

  if (tripData.ownerId !== authUid) {
    throw new HttpsError(
      "permission-denied",
      "Only the Trip owner may publish Trip terms."
    );
  }

  if (isTripArchived(tripData)) {
    throw new HttpsError(
      "failed-precondition",
      "This trip is archived and no longer accepts new Trip terms."
    );
  }
}

/**
 * Trusted-backend mirror of firestore.rules' own missing-safe
 * tripIsActive() check - deliberately duplicated the same way every
 * other callable that needs this already duplicates it.
 * @param {FirebaseFirestore.DocumentData} tripData The Trip document data.
 * @return {boolean} True if the Trip is archived.
 */
function isTripArchived(tripData: FirebaseFirestore.DocumentData): boolean {
  return tripData.archivedAt !== undefined && tripData.archivedAt !== null;
}

/**
 * Validates an EXISTING tripTermsCurrent/{tripId} pointer's own fields,
 * following this project's established corruption/server-state error
 * convention (see recordSavingsTransaction.ts's identical
 * failed-precondition pattern for a malformed ledger state) - never
 * silently treating a malformed pointer as equivalent to "no pointer."
 * @param {FirebaseFirestore.DocumentData} pointerData The pointer
 *   document's data.
 * @param {string} tripId The Trip id this publish request is for.
 * @return {number} The pointer's validated currentVersion.
 */
function assertValidExistingPointer(
  pointerData: FirebaseFirestore.DocumentData,
  tripId: string
): number {
  if (pointerData.tripId !== tripId) {
    throw new HttpsError(
      "failed-precondition",
      "Trip terms pointer references a different tripId."
    );
  }
  if (
    !Number.isSafeInteger(pointerData.currentVersion) ||
    (pointerData.currentVersion as number) <= 0
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Trip terms pointer has an invalid currentVersion."
    );
  }
  if (
    typeof pointerData.currentTermsDocId !== "string" ||
    pointerData.currentTermsDocId.length === 0
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Trip terms pointer has an invalid currentTermsDocId."
    );
  }
  return pointerData.currentVersion as number;
}

/**
 * Validates that the EXACT tripTerms document an existing pointer names
 * actually agrees with it, inside the same transaction - a malformed or
 * manually corrupted pointer must never become the basis of subsequent
 * authoritative history.
 * @param {FirebaseFirestore.DocumentSnapshot} targetSnap The pointer's
 *   named tripTerms document snapshot.
 * @param {string} tripId The Trip id this publish request is for.
 * @param {number} expectedVersion The pointer's own currentVersion.
 * @return {void}
 */
function assertPointerTargetValid(
  targetSnap: FirebaseFirestore.DocumentSnapshot,
  tripId: string,
  expectedVersion: number
): void {
  if (!targetSnap.exists) {
    throw new HttpsError(
      "failed-precondition",
      "Trip terms pointer references a terms document that does not exist."
    );
  }
  const targetData = targetSnap.data() as FirebaseFirestore.DocumentData;
  if (targetData.tripId !== tripId) {
    throw new HttpsError(
      "failed-precondition",
      "Trip terms pointer's referenced document belongs to a different Trip."
    );
  }
  if (targetData.version !== expectedVersion) {
    throw new HttpsError(
      "failed-precondition",
      "Trip terms pointer's version disagrees with its referenced document."
    );
  }
}

/**
 * Validates and narrows a raw callable request body.
 * @param {unknown} raw The unvalidated callable request body.
 * @return {PublishTripTermsInput} The validated, narrowed input.
 */
function validateInput(raw: unknown): PublishTripTermsInput {
  if (typeof raw !== "object" || raw === null) {
    throw new HttpsError("invalid-argument", "Request body is required.");
  }
  const data = raw as Record<string, unknown>;

  if (typeof data.tripId !== "string" || data.tripId.length === 0) {
    throw new HttpsError("invalid-argument", "tripId is required.");
  }

  const fieldNames: Array<keyof Omit<PublishTripTermsInput, "tripId">> = [
    "contributionExpectations",
    "expenseAllocationExpectations",
    "sharedStashSpendingAuthority",
    "withdrawalExpectations",
    "settlementExpectations",
  ];
  const fields: Record<string, string> = {};
  for (const name of fieldNames) {
    const value = data[name];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new HttpsError("invalid-argument", `${name} is required.`);
    }
    if (value.length > MAX_FIELD_LENGTH) {
      throw new HttpsError(
        "invalid-argument",
        `${name} must be at most ${MAX_FIELD_LENGTH} characters.`
      );
    }
    fields[name] = value;
  }

  return {
    tripId: data.tripId,
    contributionExpectations: fields.contributionExpectations,
    expenseAllocationExpectations: fields.expenseAllocationExpectations,
    sharedStashSpendingAuthority: fields.sharedStashSpendingAuthority,
    withdrawalExpectations: fields.withdrawalExpectations,
    settlementExpectations: fields.settlementExpectations,
  };
}
