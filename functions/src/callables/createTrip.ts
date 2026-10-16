import {FieldValue, getFirestore} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";
import {
  CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
} from "../domain/tripOwnershipModel";

type CallableAuth = CallableRequest["auth"];

interface CreateTripInput {
  clientRequestId: string;
  title: string;
  location: string | null;
  target: number;
  imageUrl: string;
  tripStartDate: string;
  tripEndDate: string | null;
}

interface CreateTripResult {
  tripId: string;
}

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_TITLE_LENGTH = 200;
const MAX_LOCATION_LENGTH = 200;
const MAX_IMAGE_URL_LENGTH = 2048;
const CANONICAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Exact allowlist (Checkpoint 5B.5A/amended 5B.5 preflight, item 2) - any
// key outside this list fails the ENTIRE request closed with
// invalid-argument, including every trusted field a native Trip must
// never accept as client input (ownerId, memberIds, saved,
// ledgerOpeningBalanceMinor, ledgerBalanceMinor, currency,
// ownershipModelState, ownershipModelVersion, creationRequest, createdAt,
// lastUpdatedAt, lastUpdatedBy, archivedAt, archivedBy, or anything else
// unrecognized). Deliberately NOT a blocklist - see validateInput below.
const ALLOWED_INPUT_KEYS: ReadonlySet<string> = new Set([
  "clientRequestId",
  "title",
  "location",
  "target",
  "imageUrl",
  "tripStartDate",
  "tripEndDate",
]);

// Checkpoint 5B.5A hardening, Finding 1: the stored creationRequest is an
// immutable EXACT original-request snapshot, never a loose superset - a
// stored document whose creationRequest carries an extra key (forged or
// corrupted) or is missing one of these is never a valid replay, even if
// every key it DOES have happens to match. One more key than ownerId +
// the seven CreateTripInput fields (ownerId is backend-derived, so it is
// not in ALLOWED_INPUT_KEYS, but it IS part of the frozen creationRequest
// shape - see createTripCore's tripData.creationRequest literal).
const CREATION_REQUEST_KEYS: ReadonlySet<string> = new Set([
  "clientRequestId",
  "ownerId",
  "title",
  "location",
  "target",
  "imageUrl",
  "tripStartDate",
  "tripEndDate",
]);

/**
 * createTrip
 * Input: {
 *   clientRequestId: string, title: string, location: string | null,
 *   target: number, imageUrl: string, tripStartDate: string,
 *   tripEndDate: string | null,
 * }
 * Output: { tripId: string }
 *
 * The trusted, canonical path for brand-new Trip creation (Checkpoint
 * 5B.5A, per the approved amended 5B.5 preflight) - writes a Trip
 * directly into the CURRENT ownership/ledger model
 * (ownershipModelState: "initialized", ownershipModelVersion:
 * CURRENT_TRIP_OWNERSHIP_MODEL_VERSION, a zero-balance ledger) rather
 * than the legacy shape the still-open direct Firestore create path
 * produces. This is a first-write, never a persisted-state transition -
 * the legacy -> migrating -> initialized transition graph
 * (tripOwnershipModel.ts's isValidTripOwnershipModelTransition) governs
 * EXISTING documents being migrated and is neither called nor applicable
 * here.
 *
 * Security (mirrors createBucket.ts's own trust-boundary pattern):
 * - Requires caller to be signed in.
 * - ownerId/memberIds are never accepted from client input - both are
 *   derived exclusively from the authenticated caller (ownerId = authUid,
 *   memberIds = [authUid]).
 * - Every trusted field (ledger/currency/ownership-model/creation
 *   metadata/timestamps/archive) is backend-only; the request validator
 *   rejects the WHOLE request if any such field - or any other
 *   unrecognized key - is present, rather than silently ignoring it.
 * - Does NOT create a tripMemberOwnership row (the empty-ownership-set
 *   equivalence already proven safe by 5B.3C - sum(empty set) == 0 ==
 *   ledgerBalanceMinor) and does NOT create a
 *   tripOwnershipMigrationState document (that collection exists solely
 *   for the migration tool's own legacy backfill, never for a native
 *   Trip).
 * - Idempotent: the Trip document id IS clientRequestId directly (Trip
 *   has no second resource to key off, unlike createBucket's
 *   trip_personal variant). A replay is proven against the document's
 *   immutable creationRequest snapshot PLUS a set of trusted immutable
 *   root invariants - never against current mutable state (memberIds,
 *   display fields, ledgerBalanceMinor/saved, ownershipModelState,
 *   timestamps, archive fields all legitimately change after creation).
 */
export const createTrip = onCall(async (request) => {
  const authUid = requireAuthenticatedUid(request.auth);

  return createTripCore(getFirestore(), authUid, request.data);
});

/**
 * Requires an authenticated caller, matching the guard every callable in
 * this project duplicates locally (see createBucket.ts,
 * recordSavingsTransaction.ts, etc.) rather than importing a shared
 * helper.
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
 * Testable trusted core - receives an already-resolved Firestore instance
 * and the authenticated caller's uid rather than pulling either from the
 * onCall request context directly, matching createBucketCore's own
 * testing convention.
 * @param {Firestore} db Admin SDK Firestore instance (emulator or prod).
 * @param {string} authUid The authenticated caller's uid.
 * @param {unknown} rawInput The callable request body, validated inside.
 * @return {Promise<CreateTripResult>} The new/idempotently replayed
 *   Trip's id.
 */
export async function createTripCore(
  db: Firestore,
  authUid: string,
  rawInput: unknown
): Promise<CreateTripResult> {
  const input = validateInput(rawInput);
  const tripRef = db.collection("trips").doc(input.clientRequestId);

  return db.runTransaction(async (tx) => {
    const existingSnap = await tx.get(tripRef);

    if (existingSnap.exists) {
      const stored = existingSnap.data() as FirebaseFirestore.DocumentData;
      if (!matchesCreationRequest(stored, input, authUid)) {
        throw new HttpsError(
          "already-exists",
          "clientRequestId was already used for a different request."
        );
      }
      return {tripId: input.clientRequestId};
    }

    const tripData: Record<string, unknown> = {
      ownerId: authUid,
      memberIds: [authUid],
      title: input.title,
      location: input.location,
      target: input.target,
      imageUrl: input.imageUrl,
      tripStartDate: input.tripStartDate,
      tripEndDate: input.tripEndDate,
      saved: 0,
      ledgerOpeningBalanceMinor: 0,
      ledgerBalanceMinor: 0,
      currency: "USD",
      ownershipModelState: "initialized",
      ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
      // Immutable trusted creation metadata - the sole source of truth
      // idempotent replay compares against (matchesCreationRequest
      // below), never a client-write input, mirroring createBucket.ts's
      // identical creationRequest convention.
      creationRequest: {
        clientRequestId: input.clientRequestId,
        ownerId: authUid,
        title: input.title,
        location: input.location,
        target: input.target,
        imageUrl: input.imageUrl,
        tripStartDate: input.tripStartDate,
        tripEndDate: input.tripEndDate,
      },
      createdAt: FieldValue.serverTimestamp(),
      lastUpdatedAt: FieldValue.serverTimestamp(),
      lastUpdatedBy: authUid,
    };
    tx.set(tripRef, tripData);

    return {tripId: input.clientRequestId};
  });
}

/**
 * True if `value` is a real "YYYY-MM-DD" calendar date - not merely a
 * string matching the shape, but a date that actually exists (rejects,
 * e.g., "2027-02-30"). Mirrors src/domain/tripDates.ts's own
 * parseCanonicalDate round-trip-through-Date.UTC technique exactly -
 * duplicated here because Functions and the app are separate compiled
 * TypeScript projects with no shared import path (the same reason
 * createBucket.ts's tripPersonalBucketId formula is duplicated against
 * src/domain/tripPersonalFund.ts). Deliberately never rejects a past
 * date - per the amended 5B.5 preflight, "before today" is a
 * client-perspective, timezone-sensitive UI guardrail only, never a
 * server-enforced invariant (matching firestore.rules' own documented
 * decision for tripStartDate).
 * @param {string} value The candidate date string.
 * @return {boolean} True if value is a real calendar date.
 */
function isRealCanonicalDate(value: string): boolean {
  if (!CANONICAL_DATE_PATTERN.test(value)) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  return (
    roundTrip.getUTCFullYear() === year &&
    roundTrip.getUTCMonth() === month - 1 &&
    roundTrip.getUTCDate() === day
  );
}

/**
 * Validates and narrows a raw callable request body against the exact
 * seven-key allowlist (Checkpoint 5B.5A) - any other key present, trusted
 * or not, fails the whole request closed with invalid-argument rather
 * than being silently ignored. title/location are trimmed here and the
 * trimmed value becomes the canonical stored/creationRequest/idempotency
 * value - callers never see the untrimmed form again, matching
 * createBucketCore's own `name` trimming convention.
 * @param {unknown} raw The unvalidated callable request body.
 * @return {CreateTripInput} The validated, narrowed input.
 */
function validateInput(raw: unknown): CreateTripInput {
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
    typeof data.clientRequestId !== "string" ||
    !CLIENT_REQUEST_ID_PATTERN.test(data.clientRequestId)
  ) {
    throw new HttpsError(
      "invalid-argument",
      "clientRequestId must be a non-empty string of letters, " +
        "numbers, \"_\", or \"-\" (max 128 characters)."
    );
  }

  if (typeof data.title !== "string") {
    throw new HttpsError("invalid-argument", "title must be a string.");
  }
  const title = data.title.trim();
  if (title.length === 0) {
    throw new HttpsError("invalid-argument", "title must not be empty.");
  }
  if (title.length > MAX_TITLE_LENGTH) {
    throw new HttpsError(
      "invalid-argument",
      `title must be at most ${MAX_TITLE_LENGTH} characters.`
    );
  }

  if (data.location !== null && typeof data.location !== "string") {
    throw new HttpsError(
      "invalid-argument",
      "location must be a string or null."
    );
  }
  const location = typeof data.location === "string" ?
    (data.location.trim() || null) :
    null;
  if (location !== null && location.length > MAX_LOCATION_LENGTH) {
    throw new HttpsError(
      "invalid-argument",
      `location must be at most ${MAX_LOCATION_LENGTH} characters.`
    );
  }

  if (
    typeof data.target !== "number" ||
    !Number.isFinite(data.target) ||
    data.target <= 0
  ) {
    throw new HttpsError(
      "invalid-argument",
      "target must be a positive finite number."
    );
  }

  if (typeof data.imageUrl !== "string") {
    throw new HttpsError("invalid-argument", "imageUrl must be a string.");
  }
  if (
    data.imageUrl.length === 0 ||
    data.imageUrl.length > MAX_IMAGE_URL_LENGTH
  ) {
    throw new HttpsError(
      "invalid-argument",
      `imageUrl must be 1-${MAX_IMAGE_URL_LENGTH} characters.`
    );
  }
  if (!/^https?:\/\//.test(data.imageUrl)) {
    throw new HttpsError(
      "invalid-argument",
      "imageUrl must start with http:// or https://."
    );
  }

  if (
    typeof data.tripStartDate !== "string" ||
    !isRealCanonicalDate(data.tripStartDate)
  ) {
    throw new HttpsError(
      "invalid-argument",
      "tripStartDate must be a real calendar date in \"YYYY-MM-DD\" form."
    );
  }

  if (data.tripEndDate !== null && typeof data.tripEndDate !== "string") {
    throw new HttpsError(
      "invalid-argument",
      "tripEndDate must be a string or null."
    );
  }
  if (data.tripEndDate !== null) {
    const tripEndDate = data.tripEndDate as string;
    if (!isRealCanonicalDate(tripEndDate)) {
      throw new HttpsError(
        "invalid-argument",
        "tripEndDate must be a real calendar date in \"YYYY-MM-DD\" form."
      );
    }
    if (tripEndDate < data.tripStartDate) {
      throw new HttpsError(
        "invalid-argument",
        "tripEndDate cannot be before tripStartDate."
      );
    }
  }

  return {
    clientRequestId: data.clientRequestId,
    title,
    location,
    target: data.target,
    imageUrl: data.imageUrl,
    tripStartDate: data.tripStartDate,
    tripEndDate: (data.tripEndDate as string | null) ?? null,
  };
}

/**
 * True if a previously-stored document at the incoming Trip id is a
 * valid idempotent replay of this exact original creation request -
 * compares the incoming request against the document's IMMUTABLE
 * creationRequest metadata PLUS a small set of trusted immutable root
 * invariants that also never change after a canonical native creation
 * (Checkpoint 5B.5A's "IMPORTANT REPLAY HARDENING" requirement: a stored
 * creationRequest snapshot alone is not sufficient proof, since a
 * hand-crafted/forged document could fake it). The stored
 * creationRequest itself must have EXACTLY the frozen eight-key shape
 * (Checkpoint 5B.5A hardening, Finding 1) - neither a missing key nor an
 * extra one is a valid replay, even if every key present happens to
 * match. Deliberately never
 * compares against CURRENT mutable state - memberIds, the display
 * fields (title/location/target/imageUrl/tripStartDate/tripEndDate),
 * saved/ledgerBalanceMinor, lastUpdatedAt/lastUpdatedBy, archivedAt/
 * archivedBy, and - critically - ownershipModelState (a genuinely native
 * Trip may later legitimately enter "needs_reconciliation"; the mutable
 * lifecycle state is not an idempotency identity condition) may all
 * legitimately change after creation without ever invalidating a replay
 * of the ORIGINAL request. Mirrors createBucket.ts's
 * matchesCreationRequest in spirit, simplified since Trip has no second
 * bucketType-style variant to discriminate.
 * @param {FirebaseFirestore.DocumentData} stored The existing persisted
 *   trips document at the incoming id.
 * @param {CreateTripInput} input The incoming validated request.
 * @param {string} authUid The incoming request's authenticated caller.
 * @return {boolean} True if this is the trusted result of the exact same
 *   original creation request.
 */
function matchesCreationRequest(
  stored: FirebaseFirestore.DocumentData,
  input: CreateTripInput,
  authUid: string
): boolean {
  const creationRequest = stored.creationRequest;
  if (typeof creationRequest !== "object" || creationRequest === null) {
    return false;
  }
  // Exact-shape check (Finding 1): no missing key, no extra key - a
  // partial or over-populated creationRequest is never a valid replay,
  // regardless of whether the keys it does have match.
  const creationRequestKeys = Object.keys(creationRequest);
  if (
    creationRequestKeys.length !== CREATION_REQUEST_KEYS.size ||
    creationRequestKeys.some((key) => !CREATION_REQUEST_KEYS.has(key))
  ) {
    return false;
  }
  if (creationRequest.clientRequestId !== input.clientRequestId) {
    return false;
  }
  if (creationRequest.ownerId !== authUid) {
    return false;
  }
  if (creationRequest.title !== input.title) {
    return false;
  }
  if (creationRequest.location !== input.location) {
    return false;
  }
  if (creationRequest.target !== input.target) {
    return false;
  }
  if (creationRequest.imageUrl !== input.imageUrl) {
    return false;
  }
  if (creationRequest.tripStartDate !== input.tripStartDate) {
    return false;
  }
  if (creationRequest.tripEndDate !== input.tripEndDate) {
    return false;
  }

  // Trusted immutable root invariants - proving this document was
  // genuinely produced by canonical native creation, never only that its
  // creationRequest snapshot happens to match. Deliberately excludes
  // every field that legitimately mutates after creation, including
  // ownershipModelState (see the function comment above).
  if (stored.ownerId !== authUid) {
    return false;
  }
  if (stored.ledgerOpeningBalanceMinor !== 0) {
    return false;
  }
  if (stored.currency !== "USD") {
    return false;
  }
  if (stored.ownershipModelVersion !== CURRENT_TRIP_OWNERSHIP_MODEL_VERSION) {
    return false;
  }

  return true;
}
