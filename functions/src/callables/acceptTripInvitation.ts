import {FieldValue, Timestamp, getFirestore} from "firebase-admin/firestore";
import type {Firestore, Transaction} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";
import {classifyOwnershipMutationGate} from "../domain/tripOwnershipModel";
import {
  assertPointerTargetValid,
  assertValidExistingPointer,
} from "../domain/tripTermsPointer";
import {
  tripInvitationId,
  tripMembershipAcceptanceId,
} from "../domain/tripCompositeId";

type CallableAuth = CallableRequest["auth"];

interface AcceptTripInvitationInput {
  invitationId: string;
  acceptedTermsDocId: string;
}

interface AcceptTripInvitationResult {
  tripId: string;
}

// Generous enough to hold the composite invitationId (tripId + "_" +
// a Firebase Auth uid, which can be up to 128 characters per the Auth
// API contract - substantially longer than a Firestore auto-id) while
// still rejecting path-like/malformed ids. Deliberately NOT the same
// 128-char CLIENT_REQUEST_ID_PATTERN used elsewhere in this codebase
// (createBucket.ts, createTrip.ts, etc.) - that pattern's own max
// length would incorrectly reject a real, canonical invitation id (see
// the frozen docs/audits/
// TRIP_FINANCIAL_MEMBERSHIP_ACCEPTANCE_PREFLIGHT_2026-10-16.md §3's
// explicit warning about this). Underscore is deliberately ALLOWED here
// - invitationId is itself composite (tripId + ID_DELIMITER + uid), so
// it must legitimately contain the delimiter.
const SAFE_INVITATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,300}$/;

// Checkpoint 5C.1A: acceptedTermsDocId is a PLAIN (non-composite)
// tripTerms document id - it is one component later fed into
// tripMembershipAcceptanceId(tripId, uid, termsDocId), which calls
// assertNoDelimiter() on it. A pattern that permits "_" here would let
// a request pass this initial validation and only fail later, deep
// inside the transaction, with the wrong error ("internal" from
// assertNoDelimiter rather than "invalid-argument" here, and after
// Firestore reads have already begun) - violating the frozen rule that
// malformed identifier input must reject with invalid-argument BEFORE
// any Firestore read. Deliberately not pinned to the exact real
// Firestore auto-id alphabet/length (62-char alphanumeric, 20 chars) -
// that would be overfitting to an implementation detail this
// repository has not frozen as a rule - but underscore is excluded
// because it is a hard structural constraint (the composite-id
// delimiter), not a style preference.
const SAFE_TERMS_DOC_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

const ALLOWED_INPUT_KEYS: ReadonlySet<string> = new Set([
  "invitationId",
  "acceptedTermsDocId",
]);

const RECOGNIZED_INVITATION_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "accepted",
  "declined",
  "cancelled",
]);

const ACCEPTANCE_KEYS: ReadonlySet<string> = new Set([
  "tripId",
  "uid",
  "termsDocId",
  "acceptedTermsVersion",
  "acceptedAt",
]);

/**
 * acceptTripInvitation (Checkpoint 5C.1, per the frozen docs/audits/
 * TRIP_FINANCIAL_MEMBERSHIP_ACCEPTANCE_PREFLIGHT_2026-10-16.md)
 * Input: { invitationId: string, acceptedTermsDocId: string }
 * Output: { tripId: string }
 *
 * Security:
 * - Requires caller to be signed in.
 * - Only the invitation's own named invitee may accept it - never the
 *   Trip owner on their behalf, never any other current member.
 * - ownerId/memberIds/acceptedAt/acceptedTermsVersion/financial/ledger/
 *   ownership state are never accepted from client input - every one is
 *   derived server-side from already-trusted Firestore state read
 *   fresh inside this callable's own transaction.
 * - `acceptedTermsDocId` means only "this is the exact document the
 *   client displayed" - it is independently re-verified against the
 *   live `tripTermsCurrent` pointer before being trusted as current
 *   (anti-TOCTOU - preflight §10/§13).
 * - A brand-new acceptance is permitted ONLY when the Trip's ownership
 *   model is `"initialized"` at `CURRENT_TRIP_OWNERSHIP_MODEL_VERSION`
 *   (reusing `classifyOwnershipMutationGate` verbatim - preflight §14);
 *   every other state (legacy/migrating/needs_reconciliation/corrupt)
 *   fails closed.
 * - An exact replay of an already-completed acceptance (the invitation
 *   is already `"accepted"`) is a read-only historical confirmation,
 *   never re-authorized against the Trip's CURRENT archive state,
 *   ownership-model state, or terms pointer - those governed only the
 *   original event (preflight §9's two-branch model).
 * - Successful acceptance atomically: flips the invitation to
 *   `"accepted"`; writes an immutable `tripMembershipAcceptances`
 *   record; and adds the accepting uid to `trips.memberIds` as the
 *   full, explicit canonical array (never `arrayUnion`). It never
 *   touches `saved`, `ledgerOpeningBalanceMinor`, `ledgerBalanceMinor`,
 *   `currency`, `ownershipModelState`/`Version`, or any
 *   `tripMemberOwnership`/`tripOwnershipAllocations`/
 *   `savingsTransactions` document - the new member starts with zero
 *   economic ownership, represented by the ABSENCE of an ownership row
 *   (5B.3C's lazy-initialization path handles their first real
 *   contribution later).
 */
export const acceptTripInvitation = onCall(async (request) => {
  const authUid = requireAuthenticatedUid(request.auth);

  return acceptTripInvitationCore(getFirestore(), authUid, request.data);
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
 * Core-function convention in this project. Uses exactly one Firestore
 * transaction for the entire operation (unlike createTripInvitation.ts/
 * publishTripTerms.ts, which need a preliminary out-of-transaction read
 * to gate an Admin Auth lookup - this callable has no such lookup, so
 * every read, from the very first, already happens inside the
 * transaction).
 * @param {Firestore} db Admin SDK Firestore instance (emulator or prod).
 * @param {string} authUid The authenticated caller's uid.
 * @param {unknown} rawInput The callable request body, validated inside.
 * @return {Promise<AcceptTripInvitationResult>} The joined Trip's id.
 */
export async function acceptTripInvitationCore(
  db: Firestore,
  authUid: string,
  rawInput: unknown
): Promise<AcceptTripInvitationResult> {
  const input = validateInput(rawInput);
  const invitationRef = db
    .collection("tripInvitations")
    .doc(input.invitationId);

  return db.runTransaction(async (tx) => {
    // ---------------------------------------------------------------
    // Step 0 - shared read + corruption validation (both branches).
    // ---------------------------------------------------------------
    const invitationSnap = await tx.get(invitationRef);
    if (!invitationSnap.exists) {
      throw new HttpsError(
        "not-found",
        "No invitation found for the given invitationId."
      );
    }
    const invitation = invitationSnap.data() as FirebaseFirestore.DocumentData;

    assertNonEmptyString(invitation.inviterUid, "invitation.inviterUid");
    assertNonEmptyString(invitation.inviteeUid, "invitation.inviteeUid");
    assertNonEmptyString(invitation.tripId, "invitation.tripId");
    if (typeof invitation.inviteeEmail !== "string") {
      throw new HttpsError(
        "failed-precondition",
        "invitation.inviteeEmail must be a string."
      );
    }
    assertValidTimestamp(invitation.createdAt, "invitation.createdAt");
    assertValidTimestamp(invitation.expiresAt, "invitation.expiresAt");
    if (!RECOGNIZED_INVITATION_STATUSES.has(invitation.status)) {
      throw new HttpsError(
        "failed-precondition",
        `Unrecognized invitation status "${String(invitation.status)}".`
      );
    }
    if (invitation.status === "pending") {
      if (invitation.respondedAt !== null) {
        throw new HttpsError(
          "failed-precondition",
          "Pending invitation unexpectedly has a non-null respondedAt."
        );
      }
    } else {
      assertValidTimestamp(invitation.respondedAt, "invitation.respondedAt");
    }

    if (authUid !== invitation.inviteeUid) {
      throw new HttpsError(
        "permission-denied",
        "Only the invited member may accept this invitation."
      );
    }

    // Do not trust that merely finding a document at the requested id
    // proves its identity - verify its persisted tripId/inviteeUid
    // actually produce this exact deterministic id (preflight §5 of
    // the 5C.1 checkpoint).
    const expectedInvitationId = tripInvitationId(
      invitation.tripId,
      invitation.inviteeUid
    );
    if (input.invitationId !== expectedInvitationId) {
      throw new HttpsError(
        "failed-precondition",
        "Invitation document id is not canonical for its own tripId/" +
          "inviteeUid."
      );
    }

    const tripRef = db.collection("trips").doc(invitation.tripId as string);
    const tripSnap = await tx.get(tripRef);
    if (!tripSnap.exists) {
      throw new HttpsError("not-found", "No Trip found for this invitation.");
    }
    const trip = tripSnap.data() as FirebaseFirestore.DocumentData;

    assertNonEmptyString(trip.ownerId, "Trip.ownerId");
    if (invitation.inviterUid !== trip.ownerId) {
      throw new HttpsError(
        "failed-precondition",
        "This invitation's inviter is no longer this Trip's current " +
          "authoritative owner."
      );
    }

    // Canonical memberIds validation - shared by BOTH branches. Never
    // repaired, never deduplicated, never normalized.
    const canonicalMemberIds = assertCanonicalMemberIds(
      trip.memberIds,
      trip.ownerId
    );

    // ---------------------------------------------------------------
    // Branch selection.
    // ---------------------------------------------------------------
    if (invitation.status === "accepted") {
      return evaluateCompletedReplay(
        tx,
        db,
        invitation,
        input,
        authUid,
        canonicalMemberIds
      );
    }

    if (invitation.status !== "pending") {
      // "declined" or "cancelled" - neither branch applies.
      throw new HttpsError(
        "failed-precondition",
        `Invitation status "${invitation.status}" cannot be accepted.`
      );
    }

    // ---------------------------------------------------------------
    // Branch B - new acceptance.
    // ---------------------------------------------------------------
    const now = Timestamp.now();
    const expiresAt = invitation.expiresAt as Timestamp;
    if (expiresAt.toMillis() <= now.toMillis()) {
      throw new HttpsError(
        "failed-precondition",
        "This invitation has expired."
      );
    }

    if (isTripArchived(trip)) {
      throw new HttpsError(
        "failed-precondition",
        "This trip is archived and no longer accepts new members."
      );
    }

    if (authUid === trip.ownerId) {
      throw new HttpsError(
        "failed-precondition",
        "The Trip owner cannot accept an invitation to their own Trip."
      );
    }
    if (canonicalMemberIds.includes(authUid)) {
      throw new HttpsError(
        "failed-precondition",
        "You are already a member of this Trip."
      );
    }

    const gate = classifyOwnershipMutationGate(
      trip.ownershipModelState,
      trip.ownershipModelVersion
    );
    if (gate.kind !== "initialized") {
      throw new HttpsError(
        "failed-precondition",
        "This trip's ownership model is not ready to accept a new " +
          "financially-authorized member."
      );
    }

    const pointerRef = db
      .collection("tripTermsCurrent")
      .doc(invitation.tripId as string);
    const pointerSnap = await tx.get(pointerRef);
    if (!pointerSnap.exists) {
      throw new HttpsError(
        "failed-precondition",
        "This trip has no published terms to accept."
      );
    }
    const pointerData = pointerSnap.data() as FirebaseFirestore.DocumentData;
    const currentVersion = assertValidExistingPointer(
      pointerData,
      invitation.tripId as string
    );

    // Anti-TOCTOU: the client's displayed terms doc must still be the
    // CURRENT one - never silently accept a newer, unseen version.
    if (pointerData.currentTermsDocId !== input.acceptedTermsDocId) {
      throw new HttpsError(
        "failed-precondition",
        "The Trip terms you reviewed are no longer current. Please " +
          "review the latest terms before accepting.",
        {reason: "terms_changed"}
      );
    }

    const termsRef = db.collection("tripTerms").doc(input.acceptedTermsDocId);
    const termsSnap = await tx.get(termsRef);
    assertPointerTargetValid(
      termsSnap,
      invitation.tripId as string,
      currentVersion
    );
    const terms = termsSnap.data() as FirebaseFirestore.DocumentData;

    const acceptanceId = tripMembershipAcceptanceId(
      invitation.tripId as string,
      authUid,
      input.acceptedTermsDocId
    );
    const acceptanceRef = db
      .collection("tripMembershipAcceptances")
      .doc(acceptanceId);
    const acceptanceSnap = await tx.get(acceptanceRef);
    if (acceptanceSnap.exists) {
      throw new HttpsError(
        "failed-precondition",
        "An acceptance record already exists for a still-pending " +
          "invitation - inconsistent trusted state."
      );
    }

    // -------- Atomic writes (Branch B only) --------
    tx.update(invitationRef, {
      status: "accepted",
      respondedAt: FieldValue.serverTimestamp(),
    });

    tx.set(acceptanceRef, {
      tripId: invitation.tripId,
      uid: authUid,
      termsDocId: input.acceptedTermsDocId,
      acceptedTermsVersion: terms.version,
      acceptedAt: FieldValue.serverTimestamp(),
    });

    tx.update(tripRef, {
      memberIds: [...canonicalMemberIds, authUid],
      lastUpdatedAt: FieldValue.serverTimestamp(),
      lastUpdatedBy: authUid,
    });

    return {tripId: invitation.tripId as string};
  });
}

/**
 * Branch A - completed/idempotent replay. The invitation is already
 * `"accepted"`; this is a read-only historical confirmation, never a
 * new authorization event. Deliberately does NOT re-check the Trip's
 * current archive state, ownership-model state, or the current terms
 * pointer - those governed only the original acceptance event (preflight
 * §9/§24's DOES/DOES-NOT-validate list).
 * @param {Transaction} tx The active Firestore transaction.
 * @param {Firestore} db Admin SDK Firestore instance.
 * @param {FirebaseFirestore.DocumentData} invitation The already-read,
 *   already-shape-validated invitation document data.
 * @param {AcceptTripInvitationInput} input The validated request input.
 * @param {string} authUid The authenticated caller's uid.
 * @param {string[]} canonicalMemberIds The Trip's already-validated
 *   canonical memberIds array.
 * @return {Promise<AcceptTripInvitationResult>} The joined Trip's id.
 */
async function evaluateCompletedReplay(
  tx: Transaction,
  db: Firestore,
  invitation: FirebaseFirestore.DocumentData,
  input: AcceptTripInvitationInput,
  authUid: string,
  canonicalMemberIds: string[]
): Promise<AcceptTripInvitationResult> {
  assertValidTimestamp(invitation.respondedAt, "invitation.respondedAt");

  const occurrences = canonicalMemberIds.filter(
    (uid) => uid === authUid
  ).length;
  if (occurrences !== 1) {
    throw new HttpsError(
      "failed-precondition",
      "Accepted invitation but the invitee is not present in " +
        "memberIds exactly once."
    );
  }

  const acceptanceId = tripMembershipAcceptanceId(
    invitation.tripId as string,
    authUid,
    input.acceptedTermsDocId
  );
  const acceptanceRef = db
    .collection("tripMembershipAcceptances")
    .doc(acceptanceId);
  const acceptanceSnap = await tx.get(acceptanceRef);
  if (!acceptanceSnap.exists) {
    throw new HttpsError(
      "failed-precondition",
      "Accepted invitation but its acceptance record is missing."
    );
  }
  const acceptance = acceptanceSnap.data() as FirebaseFirestore.DocumentData;

  const acceptanceKeys = Object.keys(acceptance);
  if (
    acceptanceKeys.length !== ACCEPTANCE_KEYS.size ||
    acceptanceKeys.some((key) => !ACCEPTANCE_KEYS.has(key))
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Acceptance record does not have the exact expected shape."
    );
  }
  if (
    acceptance.tripId !== invitation.tripId ||
    acceptance.uid !== authUid ||
    acceptance.termsDocId !== input.acceptedTermsDocId
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Acceptance record does not match this invitation's identity."
    );
  }
  if (
    !Number.isSafeInteger(acceptance.acceptedTermsVersion) ||
    (acceptance.acceptedTermsVersion as number) <= 0
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Acceptance record has an invalid acceptedTermsVersion."
    );
  }
  assertValidTimestamp(acceptance.acceptedAt, "acceptance.acceptedAt");

  const termsRef = db.collection("tripTerms").doc(input.acceptedTermsDocId);
  const termsSnap = await tx.get(termsRef);
  if (!termsSnap.exists) {
    throw new HttpsError(
      "failed-precondition",
      "Historical accepted terms document no longer exists."
    );
  }
  const terms = termsSnap.data() as FirebaseFirestore.DocumentData;
  if (terms.tripId !== invitation.tripId) {
    throw new HttpsError(
      "failed-precondition",
      "Historical accepted terms document belongs to a different Trip."
    );
  }
  if (!Number.isSafeInteger(terms.version) || (terms.version as number) <= 0) {
    throw new HttpsError(
      "failed-precondition",
      "Historical accepted terms document has an invalid version."
    );
  }
  if (terms.version !== acceptance.acceptedTermsVersion) {
    throw new HttpsError(
      "failed-precondition",
      "Historical accepted terms document's version disagrees with " +
        "the acceptance record."
    );
  }

  return {tripId: invitation.tripId as string};
}

/**
 * Validates `trips.memberIds` as a SET-like authorization list, shared
 * by both branches (preflight §9's "canonical memberIds validation,
 * shared by BOTH branches"). Never repaired, never deduplicated, never
 * normalized - any violation fails closed.
 * @param {unknown} memberIds The Trip document's own memberIds field.
 * @param {unknown} ownerId The Trip document's own ownerId field.
 * @return {string[]} The validated, canonical memberIds array.
 */
function assertCanonicalMemberIds(
  memberIds: unknown,
  ownerId: unknown
): string[] {
  if (!Array.isArray(memberIds)) {
    throw new HttpsError(
      "failed-precondition",
      "Trip.memberIds must be an array."
    );
  }
  const seen = new Set<string>();
  for (const entry of memberIds) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new HttpsError(
        "failed-precondition",
        "Trip.memberIds contains a non-string or empty-string entry."
      );
    }
    if (seen.has(entry)) {
      throw new HttpsError(
        "failed-precondition",
        "Trip.memberIds contains a duplicate uid."
      );
    }
    seen.add(entry);
  }
  if (typeof ownerId !== "string" || ownerId.length === 0) {
    throw new HttpsError(
      "failed-precondition",
      "Trip.ownerId must be a non-empty string."
    );
  }
  const ownerOccurrences = (memberIds as string[]).filter(
    (uid) => uid === ownerId
  ).length;
  if (ownerOccurrences !== 1) {
    throw new HttpsError(
      "failed-precondition",
      "Trip.ownerId must appear in memberIds exactly once."
    );
  }
  return memberIds as string[];
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
 * Fails closed unless `value` is a non-empty string.
 * @param {unknown} value The candidate value.
 * @param {string} label A short name for the value, for the error.
 * @return {void}
 */
function assertNonEmptyString(value: unknown, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpsError(
      "failed-precondition",
      `${label} must be a non-empty string.`
    );
  }
}

/**
 * Fails closed unless `value` is a real Firestore Timestamp instance.
 * @param {unknown} value The candidate value.
 * @param {string} label A short name for the value, for the error.
 * @return {void}
 */
function assertValidTimestamp(value: unknown, label: string): void {
  if (!(value instanceof Timestamp)) {
    throw new HttpsError(
      "failed-precondition",
      `${label} must be a valid Firestore Timestamp.`
    );
  }
}

/**
 * Validates and narrows a raw callable request body against the exact
 * two-key allowlist - any other key present, trusted or not, fails the
 * whole request closed with invalid-argument.
 * @param {unknown} raw The unvalidated callable request body.
 * @return {AcceptTripInvitationInput} The validated, narrowed input.
 */
function validateInput(raw: unknown): AcceptTripInvitationInput {
  if (typeof raw !== "object" || raw === null) {
    throw new HttpsError("invalid-argument", "Request body is required.");
  }
  const data = raw as Record<string, unknown>;

  for (const key of Object.keys(data)) {
    if (!ALLOWED_INPUT_KEYS.has(key)) {
      throw new HttpsError(
        "invalid-argument",
        `Unexpected field "${key}" is not allowed.`
      );
    }
  }

  if (
    typeof data.invitationId !== "string" ||
    !SAFE_INVITATION_ID_PATTERN.test(data.invitationId)
  ) {
    throw new HttpsError(
      "invalid-argument",
      "invitationId must be a non-empty, safely-shaped document id."
    );
  }
  if (
    typeof data.acceptedTermsDocId !== "string" ||
    !SAFE_TERMS_DOC_ID_PATTERN.test(data.acceptedTermsDocId)
  ) {
    throw new HttpsError(
      "invalid-argument",
      "acceptedTermsDocId must be a non-empty, safely-shaped document " +
        "id (it must never contain the composite-id delimiter)."
    );
  }

  return {
    invitationId: data.invitationId,
    acceptedTermsDocId: data.acceptedTermsDocId,
  };
}
