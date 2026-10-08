import {getAuth} from "firebase-admin/auth";
import {FieldValue, Timestamp, getFirestore} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";

type CallableAuth = CallableRequest["auth"];

interface CreateTripInvitationInput {
  tripId: string;
  inviteeEmail: string;
}

interface CreateTripInvitationResult {
  invitationId: string;
  inviteeUid: string;
}

const INVITATION_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;

// Checkpoint 5A.1 (item 7), corrected by 5A.2 (item 5): the underscore
// delimiter in tripInvitationId/tripMembershipAcceptanceId is accepted
// ONLY because SquadStash's CURRENT generated-id/auth flow happens not
// to produce a component containing it - this is an observation about
// this application's existing flow, never a guarantee of the underlying
// Firebase APIs themselves:
//   - tripId and termsDocId are both Firestore client-SDK/Admin-SDK
//     auto-generated document ids (trips.ts's createTrip and
//     publishTripTerms.ts both use addDoc()/doc() with no caller-chosen
//     id anywhere) - Firestore's own auto-id generator is documented to
//     draw from a fixed 62-character alphanumeric alphabet with no
//     underscore, so THIS part is a genuine platform guarantee, not an
//     assumption.
//   - inviteeUid/uid, by contrast, is a Firebase Auth uid - and Firebase
//     Auth's own API contract does NOT promise a uid is underscore-free;
//     it is an opaque string of at most 128 characters, and a *custom*
//     uid (e.g. one a future flow assigns via the Admin SDK's
//     createUser({uid: ...}), or a different identity provider/import
//     path) could legally contain "_". This project's CURRENT
//     registration flow never calls createUser() with a caller-chosen
//     uid anywhere (confirmed by reading every functions/src/callables/
//     *.ts file) - every uid it produces today happens to come from
//     Firebase Auth's own default generator, which is alphanumeric - but
//     that is a fact about this app's current flow, not a property
//     Firebase Auth itself enforces or documents as permanent.
// If SquadStash ever introduces custom/imported Auth uids, or any other
// identity model whose ids may contain this delimiter, THIS composite-id
// scheme must be replaced before such identities are supported - not
// patched around. Until then, the belt-and-suspenders checks below
// (assertNoDelimiter) make any violation of this assumption LOUD (an
// explicit "internal" rejection) instead of a silent id collision.
const ID_DELIMITER = "_";

/**
 * Throws if `value` contains the composite-id delimiter - see the
 * ID_DELIMITER comment above for exactly which invariant this guards.
 * @param {string} value The component to check.
 * @param {string} label A short name for the component, for the error.
 * @return {void}
 */
function assertNoDelimiter(value: string, label: string): void {
  if (value.includes(ID_DELIMITER)) {
    throw new HttpsError(
      "internal",
      `${label} unexpectedly contains "${ID_DELIMITER}" - refusing to ` +
        "build a composite invitation id that could collide."
    );
  }
}

/**
 * Deterministic tripInvitations document id - the entire uniqueness
 * mechanism for "at most one invitation record ever exists for a given
 * (tripId, inviteeUid) pair" (mirrors createBucket.ts's own
 * tripPersonalBucketId convention). See the ID_DELIMITER comment above
 * for why this concatenation is safe.
 *
 * IMPORTANT: this exact formula is duplicated in
 * src/services/firebase/tripInvitations.ts on the client (a separate
 * compiled TypeScript project with no shared import path). Keep both in
 * sync manually if this ever changes.
 * @param {string} tripId The Trip's document id.
 * @param {string} inviteeUid The resolved invitee's uid.
 * @return {string} The deterministic invitation document id.
 */
function tripInvitationId(tripId: string, inviteeUid: string): string {
  assertNoDelimiter(tripId, "tripId");
  assertNoDelimiter(inviteeUid, "inviteeUid");
  return `${tripId}${ID_DELIMITER}${inviteeUid}`;
}

/**
 * createTripInvitation (Checkpoint 5A, docs/audits/
 * TRIP_WALLET_MILESTONE_PREFLIGHT_2026-10-06.md as hardened by its 5.0A
 * amendment)
 * Input: { tripId: string, inviteeEmail: string }
 * Output: { invitationId: string, inviteeUid: string }
 *
 * Security:
 * - Requires caller to be signed in.
 * - Owner-only (Master Spec §7.1: inviting members is a Trip-owner
 *   privilege - no Manager role exists yet to delegate it to).
 * - Resolves inviteeEmail to a uid server-side via the Admin SDK (the
 *   same getAuth().getUserByEmail lookup lookupUserByEmail.ts already
 *   performs, deliberately duplicated here rather than refactoring that
 *   already-deployed callable - see the Checkpoint 5A report). This is
 *   the sole mechanism for turning an email into an invitation: no
 *   public Firestore email-query surface is created.
 * - Rejects a Trip that is archived (no new invitations on an archived
 *   Trip, matching every other "new activity" gate already applied to
 *   contributions/Expense creation).
 * - Rejects inviting a uid that is already a current Trip member
 *   (ownerId or memberIds), and rejects a second invitation for a uid
 *   that already has ANY invitation record (any status) for this Trip -
 *   Checkpoint 5A does not support re-inviting after decline/cancel.
 *
 * FROZEN INVARIANT (preflight §5, amendment 5.0A): this callable never
 * writes to `trips.memberIds` and never grants Trip financial
 * authorization. It writes only a tripInvitations document - an inert
 * record no trusted financial callable reads. Activating real financial
 * membership from an accepted invitation is explicitly deferred to a
 * future checkpoint (5C), gated on a withdrawal-ceiling checkpoint (5B)
 * landing first - see the preflight's revised §10.
 */
export const createTripInvitation = onCall(async (request) => {
  const authUid = requireAuthenticatedUid(request.auth);

  return createTripInvitationCore(getFirestore(), authUid, request.data);
});

/**
 * Requires an authenticated caller, matching the guard every callable in
 * this project uses (see lookupUserByEmail, createBucket,
 * recordSavingsTransaction).
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
 * callable machinery - matching every other callable's own Core-function
 * convention in this project.
 * @param {Firestore} db Admin SDK Firestore instance (emulator or prod).
 * @param {string} authUid The authenticated caller's uid.
 * @param {unknown} rawInput The callable request body, validated inside.
 * @param {function(string): Promise<string>} resolveInviteeUid
 *   Resolves a normalized email to a uid, or rejects. Defaults to the
 *   real Admin Auth lookup (defaultResolveInviteeUid, below) - injectable
 *   so tests can exercise this callable's Firestore logic against the
 *   Firestore emulator without also requiring an Auth emulator, which
 *   this project does not configure (see firebase.json; lookupUserByEmail
 *   itself has never had emulator-backed tests for the same reason).
 * @return {Promise<CreateTripInvitationResult>} The new invitation's id
 *   and the resolved invitee uid.
 */
export async function createTripInvitationCore(
  db: Firestore,
  authUid: string,
  rawInput: unknown,
  resolveInviteeUid: (
    email: string
  ) => Promise<string> = defaultResolveInviteeUid
): Promise<CreateTripInvitationResult> {
  const input = validateInput(rawInput);
  const tripRef = db.collection("trips").doc(input.tripId);

  // PRELIMINARY authorization read (privacy protection, Checkpoint
  // 5A.1): establishes Trip existence, owner-only authority, and
  // archive state BEFORE any Admin Auth email lookup. This ordering is
  // the entire fix for an email-enumeration oracle: a non-owner or
  // outsider must get the exact same not-found/permission-denied
  // outcome regardless of whether inviteeEmail corresponds to a
  // registered account, because this callable never even attempts to
  // resolve that email until the caller is already proven to be this
  // Trip's owner. This read is plain (not inside the transaction below)
  // because the Admin Auth lookup it gates cannot itself participate in
  // a Firestore transaction - see assertTripInvitationAuthorized's own
  // comment for why its result must still be re-checked, never trusted
  // for the actual write decision.
  const preliminaryTripSnap = await tripRef.get();
  assertTripInvitationAuthorized(preliminaryTripSnap, authUid);

  // Admin Auth lookup happens outside the Firestore transaction below -
  // it is not a Firestore operation and cannot participate in one. Only
  // reached once the caller is already confirmed to be this Trip's
  // current, non-archived owner.
  const inviteeUid = await resolveInviteeUid(input.inviteeEmail);

  if (inviteeUid === authUid) {
    throw new HttpsError(
      "invalid-argument",
      "You cannot invite yourself to your own Trip."
    );
  }

  const invitationId = tripInvitationId(input.tripId, inviteeUid);
  const invitationRef = db.collection("tripInvitations").doc(invitationId);

  return db.runTransaction(async (tx) => {
    // All reads happen before any write - Firestore transactions require
    // this ordering. RE-READS and RE-VALIDATES the Trip from scratch -
    // race/concurrency protection (e.g. the Trip was archived or its
    // ownership changed between the preliminary read above and this
    // transaction) - the preliminary read above is authorization for
    // deciding whether to perform the email lookup at all, never trusted
    // as the basis for the actual write.
    const tripSnap = await tx.get(tripRef);
    const existingInvitationSnap = await tx.get(invitationRef);

    assertTripInvitationAuthorized(tripSnap, authUid);
    const tripData = tripSnap.data() as FirebaseFirestore.DocumentData;

    const memberIds = Array.isArray(tripData.memberIds) ?
      tripData.memberIds :
      [];
    if (tripData.ownerId === inviteeUid || memberIds.includes(inviteeUid)) {
      throw new HttpsError(
        "already-exists",
        "This user is already a member of this Trip."
      );
    }

    if (existingInvitationSnap.exists) {
      throw new HttpsError(
        "already-exists",
        "An invitation already exists for this user on this Trip."
      );
    }

    const now = Timestamp.now();
    const expiresAt = Timestamp.fromMillis(
      now.toMillis() + INVITATION_EXPIRY_MS
    );

    tx.set(invitationRef, {
      tripId: input.tripId,
      inviterUid: authUid,
      inviteeEmail: input.inviteeEmail,
      inviteeUid,
      status: "pending",
      createdAt: FieldValue.serverTimestamp(),
      expiresAt,
      respondedAt: null,
    });

    return {invitationId, inviteeUid};
  });
}

/**
 * Establishes Trip existence, owner-only authority, and non-archived
 * state - shared by both the preliminary (pre-email-lookup) read and the
 * transactional (pre-write) re-check in createTripInvitationCore, so the
 * two can never silently drift out of sync with each other.
 * @param {FirebaseFirestore.DocumentSnapshot} tripSnap The Trip document
 *   snapshot to validate.
 * @param {string} authUid The authenticated caller's uid.
 * @return {void}
 */
function assertTripInvitationAuthorized(
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
      "Only the Trip owner may invite members."
    );
  }

  if (isTripArchived(tripData)) {
    throw new HttpsError(
      "failed-precondition",
      "This trip is archived and no longer accepts new invitations."
    );
  }
}

/**
 * Resolves a normalized email to a uid via the Admin SDK - the same
 * getAuth().getUserByEmail lookup lookupUserByEmail.ts already performs,
 * deliberately duplicated here rather than refactoring that already-
 * deployed callable (see the Checkpoint 5A report).
 * @param {string} email A normalized (trimmed, lowercased) email.
 * @return {Promise<string>} The resolved uid.
 */
async function defaultResolveInviteeUid(email: string): Promise<string> {
  try {
    const userRecord = await getAuth().getUserByEmail(email);
    return userRecord.uid;
  } catch {
    throw new HttpsError("not-found", "No user found with that email.");
  }
}

/**
 * Trusted-backend mirror of firestore.rules' own missing-safe
 * tripIsActive() check - deliberately duplicated the same way every
 * other callable that needs this already duplicates it (see
 * recordSavingsTransaction.ts's own identical helper and comment).
 * @param {FirebaseFirestore.DocumentData} tripData The Trip document data.
 * @return {boolean} True if the Trip is archived.
 */
function isTripArchived(tripData: FirebaseFirestore.DocumentData): boolean {
  return tripData.archivedAt !== undefined && tripData.archivedAt !== null;
}

/**
 * Validates and narrows a raw callable request body.
 * @param {unknown} raw The unvalidated callable request body.
 * @return {CreateTripInvitationInput} The validated, narrowed input.
 */
function validateInput(raw: unknown): CreateTripInvitationInput {
  if (typeof raw !== "object" || raw === null) {
    throw new HttpsError("invalid-argument", "Request body is required.");
  }
  const data = raw as Record<string, unknown>;

  if (typeof data.tripId !== "string" || data.tripId.length === 0) {
    throw new HttpsError("invalid-argument", "tripId is required.");
  }

  const emailRaw = String(data.inviteeEmail ?? "");
  const inviteeEmail = emailRaw.trim().toLowerCase();
  if (!inviteeEmail) {
    throw new HttpsError("invalid-argument", "inviteeEmail is required.");
  }

  return {
    tripId: data.tripId,
    inviteeEmail,
  };
}
