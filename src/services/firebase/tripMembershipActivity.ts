// Firestore READS for the tripMembershipActivity collection (Checkpoint
// 6.8B2). This collection is fully client-write-closed - every real
// event is written exclusively inside a trusted backend transaction
// (functions/src/callables/{createTrip,createTripInvitation,
// acceptTripInvitation,declineTripInvitation,cancelTripInvitation}.ts
// and tripMembershipDepartureCore.ts) - so this file contains NO write
// function of any kind (no addDoc/setDoc/updateDoc/runTransaction), and
// none should ever be added here.
//
// Query shape mirrors this codebase's own established convention for
// an equality-filtered, createdAt-ordered collection (see
// src/services/firebase/savingsTransactions.ts's resourceTransactionsQuery/
// src/services/firebase/trips.ts/buckets.ts): `where("tripId", "==",
// tripId)` + `orderBy("createdAt", "desc")`, nothing more - see
// fetchTripMembershipActivityPage's own comment for why no explicit
// `orderBy(documentId())` tie-breaker is added, and firestore.indexes.json
// for the required composite index this query needs.
import {
  collection,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  Timestamp,
  where,
} from "firebase/firestore";
import type { DocumentData, QueryDocumentSnapshot } from "firebase/firestore";
import { db } from "../../../firebase";
import type { TripMembershipActivityEvent } from "../../types/domain";

const REAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "trip_created",
  "invitation_created",
  "invitation_accepted",
  "invitation_declined",
  "invitation_cancelled",
  "member_left",
  "member_removed",
]);

const INVITATION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "invitation_created",
  "invitation_accepted",
  "invitation_declined",
  "invitation_cancelled",
]);

// Checkpoint 6.8B2R: the exact allowed persisted-field set per
// discriminated variant - `id` is deliberately NEVER in this list under
// any variant (the persisted document never contains one; see
// parseTripMembershipActivityDocument's own explicit id-rejection
// check, below, which runs before this set is even consulted).
// `invitationId` is the only field that varies by type.
const COMMON_ACTIVITY_FIELDS: readonly string[] = [
  "tripId",
  "type",
  "actorUid",
  "targetUid",
  "createdAt",
  "schemaVersion",
];

function allowedActivityFieldsFor(type: string): Set<string> {
  const fields = new Set(COMMON_ACTIVITY_FIELDS);
  if (INVITATION_EVENT_TYPES.has(type)) {
    fields.add("invitationId");
  }
  return fields;
}

// Checkpoint 6.8B2 design decision: a malformed document FAILS THE
// WHOLE PAGE FETCH (this function throws synchronously; the caller -
// fetchTripMembershipActivityPage below - never catches it, so the
// returned Promise rejects) rather than being silently skipped. This
// mirrors mapSavingsTransactionDocument's own established convention in
// this codebase exactly (an invalid `type` on a savingsTransactions
// document throws, uncaught, failing the entire fetch) - the repo's
// consistent fail-closed philosophy is "never silently hide corrupt
// data," and a membership-activity feed that quietly dropped a corrupt
// row would misrepresent a Trip's history as complete when it isn't,
// which is worse than a visibly failed load the UI can retry. A
// skip-and-log alternative was considered and rejected: this collection
// is written exclusively by trusted backend transactions (never a
// client), so a malformed document here would mean something has
// already gone wrong upstream in a way worth surfacing loudly, not
// papering over.
//
// Exported so its own round-trip can be tested directly, matching
// mapSavingsTransactionDocument's/mapExpenseDocument's identical
// exported-mapper convention.
export function parseTripMembershipActivityDocument(
  id: string,
  data: DocumentData
): TripMembershipActivityEvent {
  // Checkpoint 6.8B2R item 3: the id ARGUMENT itself (always
  // QueryDocumentSnapshot.id at every real call site) must be a
  // non-empty string before anything else - fail closed rather than
  // ever hydrating an event with an invalid identity. Never parse the
  // event type from this id's own prefix; `data.type` remains the sole
  // authoritative source for event semantics, checked independently
  // below.
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(
      "parseTripMembershipActivityDocument: id must be a non-empty string."
    );
  }

  // Checkpoint 6.8B2R item 1: explicitly reject a persisted `id` field
  // as malformed data, BEFORE any object construction - the approved
  // contract is that a persisted document never contains one (the
  // Firestore document id lives solely as the DocumentReference/
  // QueryDocumentSnapshot's own id). This is a named, explicit check,
  // not an incidental side effect of the generic unexpected-field scan
  // below, and the hydrated event is never built via a blanket
  // `...data` spread (see the field-by-field construction at the end of
  // this function) - so a persisted `id` can never silently override
  // the trusted `id` argument regardless of object-literal ordering.
  if ("id" in data) {
    throw new Error(
      `parseTripMembershipActivityDocument: invalid tripMembershipActivity document "${id}" - ` +
        "a persisted document must not contain an id field (the document " +
        "id lives solely as the Firestore document reference)."
    );
  }

  if (typeof data.tripId !== "string" || data.tripId.length === 0) {
    throw new Error(
      `parseTripMembershipActivityDocument: invalid tripMembershipActivity document "${id}" - ` +
        "tripId must be a non-empty string."
    );
  }
  const isRealType =
    typeof data.type === "string" && REAL_EVENT_TYPES.has(data.type);
  const isSystemType = data.type === "history_tracking_started";
  if (!isRealType && !isSystemType) {
    throw new Error(
      `parseTripMembershipActivityDocument: invalid tripMembershipActivity document "${id}" - ` +
        `unrecognized type "${String(data.type)}".`
    );
  }
  if (data.schemaVersion !== 1) {
    throw new Error(
      `parseTripMembershipActivityDocument: invalid tripMembershipActivity document "${id}" - ` +
        `unsupported schemaVersion "${String(data.schemaVersion)}".`
    );
  }
  if (!(data.createdAt instanceof Timestamp)) {
    throw new Error(
      `parseTripMembershipActivityDocument: invalid tripMembershipActivity document "${id}" - ` +
        "createdAt must be a real Firestore Timestamp."
    );
  }

  const type = data.type as string;

  // Checkpoint 6.8B2R item 2: the EXACT allowed persisted-field set for
  // this variant - any other key (including a typo'd/legacy/forged
  // field, or `invitationId` on a non-invitation variant) fails closed
  // rather than being silently accepted or silently dropped.
  const allowedFields = allowedActivityFieldsFor(type);
  for (const key of Object.keys(data)) {
    if (!allowedFields.has(key)) {
      throw new Error(
        `parseTripMembershipActivityDocument: invalid tripMembershipActivity document "${id}" - ` +
          `unexpected persisted field "${key}" is not allowed for type "${type}".`
      );
    }
  }

  const hasInvitationId =
    typeof data.invitationId === "string" && data.invitationId.length > 0;
  if (INVITATION_EVENT_TYPES.has(type) && !hasInvitationId) {
    throw new Error(
      `parseTripMembershipActivityDocument: invalid tripMembershipActivity document "${id}" - ` +
        `type "${type}" requires a non-empty invitationId.`
    );
  }

  if (isSystemType) {
    if (data.actorUid !== null || data.targetUid !== null) {
      throw new Error(
        `parseTripMembershipActivityDocument: invalid tripMembershipActivity document "${id}" - ` +
          "history_tracking_started requires actorUid and targetUid to both be null."
      );
    }
    return {
      id,
      tripId: data.tripId,
      type: "history_tracking_started",
      actorUid: null,
      targetUid: null,
      createdAt: data.createdAt,
      schemaVersion: 1,
    } as TripMembershipActivityEvent;
  }

  if (
    typeof data.actorUid !== "string" ||
    data.actorUid.length === 0 ||
    typeof data.targetUid !== "string" ||
    data.targetUid.length === 0
  ) {
    throw new Error(
      `parseTripMembershipActivityDocument: invalid tripMembershipActivity document "${id}" - ` +
        `type "${type}" requires non-empty string actorUid/targetUid.`
    );
  }

  // Field-by-field construction - deliberately never a blanket
  // `...data` spread (Checkpoint 6.8B2R item 1): `id` is sourced
  // exclusively from the trusted function argument, validated above,
  // and every other field is read individually, already validated.
  if (INVITATION_EVENT_TYPES.has(type)) {
    return {
      id,
      tripId: data.tripId,
      type,
      actorUid: data.actorUid,
      targetUid: data.targetUid,
      invitationId: data.invitationId,
      createdAt: data.createdAt,
      schemaVersion: 1,
    } as TripMembershipActivityEvent;
  }
  return {
    id,
    tripId: data.tripId,
    type,
    actorUid: data.actorUid,
    targetUid: data.targetUid,
    createdAt: data.createdAt,
    schemaVersion: 1,
  } as TripMembershipActivityEvent;
}

// An opaque pagination cursor - a raw Firestore QueryDocumentSnapshot.
// Deliberately NOT decomposed into {createdAt, id} fields: letting the
// Firestore SDK's own startAfter(snapshot) overload extract every
// resolved sort-field value (including the implicit documentId
// tie-breaker - see fetchTripMembershipActivityPage's comment) is both
// simpler and more robust than this file re-deriving that tuple by
// hand. React components treat this purely as an opaque token to pass
// back into the next page call - they never need to (and should not)
// inspect its fields.
export type TripMembershipActivityCursor = QueryDocumentSnapshot<DocumentData>;

export type TripMembershipActivityPage = {
  events: TripMembershipActivityEvent[];
  nextCursor: TripMembershipActivityCursor | null;
  hasMore: boolean;
};

const DEFAULT_PAGE_SIZE = 20;

/**
 * Fetches one page of a Trip's membership-activity history, newest
 * first. READ ONLY - no write path exists in this file.
 *
 * Ordering/index note: the query below is exactly
 * `where("tripId", "==", tripId)` + `orderBy("createdAt", "desc")` -
 * mirroring this codebase's established convention for every other
 * equality-filtered, createdAt-ordered query (buckets.ts/trips.ts/
 * savingsTransactions.ts), none of which adds an explicit
 * `orderBy(documentId())` clause either. This is deliberate, not an
 * oversight: Firestore ALWAYS implicitly appends an orderBy on the
 * document's own id as the final tie-breaker whenever a query has at
 * least one explicit orderBy and no explicit document-id ordering of
 * its own - and that implicit tie-breaker's direction automatically
 * MATCHES the direction of the last explicit orderBy clause (here,
 * "desc"). That implicit ordering is exactly what makes two activity
 * events that happen to share an identical `createdAt` server timestamp
 * (possible in principle - Firestore timestamps are not guaranteed
 * collision-free across rapid, distinct transactions) still resolve to
 * a single, deterministic, stable total order - without this file ever
 * needing to add a second explicit orderBy or hand-construct a
 * {createdAt, id} tuple cursor. The REQUIRED composite index (tripId
 * ASCENDING, createdAt DESCENDING, __name__ DESCENDING - matching this
 * implicit tie-breaker's direction) has been added to
 * firestore.indexes.json (not deployed - see that file's own comment).
 *
 * Pagination: fetches `pageSize + 1` documents to determine `hasMore`
 * without a second round-trip; the extra document (if present) is
 * trimmed before being returned. `nextCursor` is the last RETURNED
 * document's own QueryDocumentSnapshot, suitable for `startAfter()` on
 * the next call.
 * @param {string} tripId The Trip to fetch membership activity for.
 * @param {{pageSize?: number, cursor?: TripMembershipActivityCursor | null}} options
 *   `pageSize` defaults to 20; `cursor` is the `nextCursor` from a prior
 *   page, or omitted/null for the first page.
 * @return {Promise<TripMembershipActivityPage>} The requested page.
 */
export async function fetchTripMembershipActivityPage(
  tripId: string,
  options: {
    pageSize?: number;
    cursor?: TripMembershipActivityCursor | null;
  } = {}
): Promise<TripMembershipActivityPage> {
  // Checkpoint 6.8B2R item 4: fail closed on clearly invalid input
  // BEFORE issuing any Firestore query - cursor behavior itself is
  // intentionally unchanged (an invalid cursor is still whatever the
  // Firestore SDK's own startAfter() does with it; this file does not
  // second-guess that).
  if (typeof tripId !== "string" || tripId.length === 0) {
    throw new Error(
      "fetchTripMembershipActivityPage: tripId must be a non-empty string."
    );
  }
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error(
      "fetchTripMembershipActivityPage: pageSize must be a positive integer."
    );
  }

  const constraints = [
    where("tripId", "==", tripId),
    orderBy("createdAt", "desc"),
  ];
  const pageQuery = options.cursor
    ? query(
        collection(db, "tripMembershipActivity"),
        ...constraints,
        startAfter(options.cursor),
        limit(pageSize + 1)
      )
    : query(
        collection(db, "tripMembershipActivity"),
        ...constraints,
        limit(pageSize + 1)
      );

  const snap = await getDocs(pageQuery);
  const hasMore = snap.docs.length > pageSize;
  const pageDocs = hasMore ? snap.docs.slice(0, pageSize) : snap.docs;

  const events = pageDocs.map((docSnap) =>
    parseTripMembershipActivityDocument(docSnap.id, docSnap.data())
  );
  const nextCursor = hasMore ? pageDocs[pageDocs.length - 1] : null;

  return { events, nextCursor, hasMore };
}
