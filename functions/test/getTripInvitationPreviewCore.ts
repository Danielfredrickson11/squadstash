// Tests for getTripInvitationPreviewCore against the local Firestore
// emulator via the Admin SDK - never production, guarded below. Run via
// `npm --prefix functions test`, wrapped in
// `firebase emulators:exec --only firestore "..."`.
import assert from "node:assert/strict";
import {after, before, beforeEach, describe, it} from "node:test";
import {deleteApp, initializeApp} from "firebase-admin/app";
import type {App} from "firebase-admin/app";
import {Timestamp, getFirestore} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";
import {
  getTripInvitationPreviewCore,
  requireAuthenticatedUid,
} from "../src/callables/getTripInvitationPreview";
import {tripInvitationId} from "../src/domain/tripCompositeId";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "FIRESTORE_EMULATOR_HOST is not set. Run these tests via " +
      '`firebase emulators:exec --only firestore "npm --prefix functions test"` ' +
      "so the Admin SDK talks to the local emulator, never production."
  );
}

const OWNER_UID = "owner-uid";
const INVITEE_UID = "invitee-uid";
const OTHER_MEMBER_UID = "other-member-uid";
const OUTSIDER_UID = "outsider-uid";
const TRIP_ID = "iceland-trip";
const INVITATION_ID = tripInvitationId(TRIP_ID, INVITEE_UID);

const EXPECTED_RESPONSE_KEYS = [
  "tripId",
  "title",
  "location",
  "imageUrl",
  "tripStartDate",
  "tripEndDate",
].sort();

let app: App;
let db: Firestore;

before(() => {
  // A distinct "demo-" project id from every other Functions test file's
  // own test app - see acceptTripInvitationCore.ts's comment for why
  // this matters (Node's test runner executes test files concurrently).
  app = initializeApp({
    projectId: "demo-squadstash-functions-test-get-trip-invitation-preview",
  });
  db = getFirestore(app);
});

after(async () => {
  await deleteApp(app);
});

async function clearFirestore(): Promise<void> {
  for (const name of [
    "trips",
    "tripInvitations",
    "tripMembershipAcceptances",
    "tripMemberOwnership",
  ]) {
    const snap = await db.collection(name).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

beforeEach(async () => {
  await clearFirestore();
});

function futureTimestamp(daysFromNow = 14): Timestamp {
  return Timestamp.fromMillis(Date.now() + daysFromNow * 24 * 60 * 60 * 1000);
}

function pastTimestamp(daysAgo = 1): Timestamp {
  return Timestamp.fromMillis(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
}

// Deliberately carries a FULL set of conspicuous, financially-sensitive
// values by default (not just the fields this callable actually needs)
// - every success-path test built on this fixture therefore doubles as
// an implicit financial-privacy regression, on top of the dedicated
// "FINANCIAL PRIVACY" describe block below which checks explicitly.
function baseTripData(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ownerId: OWNER_UID,
    memberIds: [OWNER_UID, OTHER_MEMBER_UID],
    title: "Iceland Trip",
    location: "Reykjavik, Iceland",
    target: 777777,
    saved: 333333,
    imageUrl: "https://example.com/iceland.jpg",
    tripStartDate: "2027-09-01",
    tripEndDate: "2027-09-10",
    ledgerOpeningBalanceMinor: 111111,
    ledgerBalanceMinor: 222222,
    currency: "USD",
    ownershipModelState: "initialized",
    ownershipModelVersion: 1,
    lastUpdatedBy: OWNER_UID,
    creationRequest: {
      clientRequestId: "sensitive-creation-request-id",
      ownerId: OWNER_UID,
    },
    ...overrides,
  };
}

async function seedTrip(
  overrides: Record<string, unknown> = {}
): Promise<void> {
  const data = baseTripData(overrides);
  // Firestore's Admin SDK rejects an explicit `undefined` field value
  // outright - simulating a genuinely ABSENT field (e.g. a legacy Trip
  // with no location/tripStartDate/tripEndDate at all) means omitting
  // the key entirely, never passing `undefined` through to .set().
  for (const key of Object.keys(data)) {
    if (data[key] === undefined) {
      delete data[key];
    }
  }
  await db.collection("trips").doc(TRIP_ID).set(data);
}

function baseInvitationData(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    tripId: TRIP_ID,
    inviterUid: OWNER_UID,
    inviteeEmail: "friend@example.com",
    inviteeUid: INVITEE_UID,
    status: "pending",
    createdAt: Timestamp.now(),
    expiresAt: futureTimestamp(),
    respondedAt: null,
    ...overrides,
  };
}

async function seedInvitation(
  overrides: Record<string, unknown> = {}
): Promise<void> {
  const data = baseInvitationData(overrides);
  const id = tripInvitationId(data.tripId as string, data.inviteeUid as string);
  await db.collection("tripInvitations").doc(id).set(data);
}

/** Full happy-path setup: Trip + a pending, unexpired invitation. */
async function seedReadyToPreviewScenario(
  tripOverrides: Record<string, unknown> = {},
  invitationOverrides: Record<string, unknown> = {}
): Promise<void> {
  await seedTrip(tripOverrides);
  await seedInvitation(invitationOverrides);
}

async function assertRejectsWithCode(
  promise: Promise<unknown>,
  code: string
): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof HttpsError, "expected an HttpsError");
    assert.equal((err as HttpsError).code, code);
    return true;
  });
}

async function snapshotState(): Promise<{
  trip: FirebaseFirestore.DocumentData | undefined;
  invitation: FirebaseFirestore.DocumentData | undefined;
  acceptanceCount: number;
  ownershipCount: number;
}> {
  const [tripSnap, invitationSnap, acceptanceSnap, ownershipSnap] =
    await Promise.all([
      db.collection("trips").doc(TRIP_ID).get(),
      db.collection("tripInvitations").doc(INVITATION_ID).get(),
      db.collection("tripMembershipAcceptances").get(),
      db.collection("tripMemberOwnership").get(),
    ]);
  return {
    trip: tripSnap.data(),
    invitation: invitationSnap.data(),
    acceptanceCount: acceptanceSnap.size,
    ownershipCount: ownershipSnap.size,
  };
}

describe("requireAuthenticatedUid - the production auth boundary", () => {
  it('throws HttpsError("unauthenticated") when auth is missing', () => {
    assert.throws(
      () => requireAuthenticatedUid(undefined),
      (err: unknown) => {
        assert.ok(err instanceof HttpsError, "expected an HttpsError");
        assert.equal((err as HttpsError).code, "unauthenticated");
        return true;
      }
    );
  });

  it("returns the uid when auth is present", () => {
    const auth = {uid: INVITEE_UID} as CallableRequest["auth"];
    assert.equal(requireAuthenticatedUid(auth), INVITEE_UID);
  });
});

describe("getTripInvitationPreviewCore - input validation", () => {
  it("null body is rejected", async () => {
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, null),
      "invalid-argument"
    );
  });

  it("a non-object body (string) is rejected", async () => {
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, "not-an-object"),
      "invalid-argument"
    );
  });

  it("a non-object body (number) is rejected", async () => {
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, 42),
      "invalid-argument"
    );
  });

  it("an array body is rejected", async () => {
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, [INVITATION_ID]),
      "invalid-argument"
    );
  });

  it("missing invitationId is rejected", async () => {
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, {}),
      "invalid-argument"
    );
  });

  it("a non-string invitationId is rejected", async () => {
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, {invitationId: 12345}),
      "invalid-argument"
    );
  });

  it("an empty-string invitationId is rejected", async () => {
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, {invitationId: ""}),
      "invalid-argument"
    );
  });

  it("an unexpected extra top-level key is rejected", async () => {
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        extra: "nope",
      }),
      "invalid-argument"
    );
  });

  it("a path-like malformed invitationId is rejected", async () => {
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, {
        invitationId: "../../etc/passwd",
      }),
      "invalid-argument"
    );
  });

  it("a realistic long composite invitationId is NOT rejected merely for length", async () => {
    // tripId (~50 chars) + "_" + inviteeUid (~120 chars, approximating a
    // Firebase Auth uid's own up-to-128-character contract) - well
    // beyond a typical Firestore auto-id's length, but still within the
    // frozen 300-char SAFE_INVITATION_ID_PATTERN ceiling.
    const longTripId = "trip-" + "a".repeat(45);
    const longInviteeUid = "invitee-" + "b".repeat(115);
    const longInvitationId = tripInvitationId(longTripId, longInviteeUid);

    await db.collection("trips").doc(longTripId).set(
      baseTripData({ownerId: OWNER_UID, memberIds: [OWNER_UID]})
    );
    await db.collection("tripInvitations").doc(longInvitationId).set(
      baseInvitationData({tripId: longTripId, inviteeUid: longInviteeUid})
    );

    const result = await getTripInvitationPreviewCore(
      db,
      longInviteeUid,
      {invitationId: longInvitationId}
    );
    assert.equal(result.tripId, longTripId);
  });
});

describe("getTripInvitationPreviewCore - invitation existence / identity", () => {
  it("a missing invitation is not-found", async () => {
    await seedTrip();
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
      }),
      "not-found"
    );
  });

  it("the wrong caller (not the named invitee) is permission-denied", async () => {
    await seedReadyToPreviewScenario();
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, OUTSIDER_UID, {
        invitationId: INVITATION_ID,
      }),
      "permission-denied"
    );
  });

  it("another current Trip member (neither owner nor invitee) is permission-denied", async () => {
    await seedReadyToPreviewScenario();
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, OTHER_MEMBER_UID, {
        invitationId: INVITATION_ID,
      }),
      "permission-denied"
    );
  });

  it("a persisted malformed tripId fails closed", async () => {
    await seedTrip();
    await db.collection("tripInvitations").doc(INVITATION_ID).set(
      baseInvitationData({tripId: ""})
    );
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
      }),
      "failed-precondition"
    );
  });

  it("a persisted malformed inviteeUid fails closed", async () => {
    await seedTrip();
    // Seeded directly at the fixed INVITATION_ID (bypassing the
    // id-computing helper) - corrupting inviteeUid would otherwise make
    // seedInvitation compute a DIFFERENT document id than the one this
    // test actually requests, which would hit not-found instead of the
    // intended failed-precondition.
    await db.collection("tripInvitations").doc(INVITATION_ID).set(
      baseInvitationData({inviteeUid: ""})
    );
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
      }),
      "failed-precondition"
    );
  });

  it("a persisted malformed inviterUid fails closed", async () => {
    await seedReadyToPreviewScenario({}, {inviterUid: ""});
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
      }),
      "failed-precondition"
    );
  });

  it("a malformed inviteeEmail fails closed", async () => {
    await seedReadyToPreviewScenario({}, {inviteeEmail: 12345});
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
      }),
      "failed-precondition"
    );
  });

  it("a non-Timestamp createdAt fails closed", async () => {
    // A plain string, not a JS Date - the Admin SDK auto-converts a
    // native Date to a real Firestore Timestamp on write (and reads it
    // back as one), so a Date could never actually simulate corruption
    // here. A string is never auto-converted and round-trips as-is.
    await seedReadyToPreviewScenario({}, {createdAt: "2024-01-01"});
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
      }),
      "failed-precondition"
    );
  });

  it("a non-Timestamp expiresAt fails closed", async () => {
    await seedReadyToPreviewScenario({}, {expiresAt: "2024-01-01"});
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
      }),
      "failed-precondition"
    );
  });

  it("an unrecognized status fails closed", async () => {
    await seedReadyToPreviewScenario({}, {status: "revoked"});
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
      }),
      "failed-precondition"
    );
  });

  it("pending with a non-null respondedAt fails closed", async () => {
    await seedReadyToPreviewScenario({}, {respondedAt: Timestamp.now()});
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
      }),
      "failed-precondition"
    );
  });

  it("a deterministic invitation-id mismatch (canonical-id check, not merely identity) fails closed", async () => {
    await seedTrip();
    // inviteeUid correctly matches authUid, but the persisted tripId is
    // wrong - isolates the canonical-id check from the earlier
    // authUid !== inviteeUid check, which would otherwise fire first.
    await db.collection("tripInvitations").doc(INVITATION_ID).set(
      baseInvitationData({tripId: "some-other-trip", inviteeUid: INVITEE_UID})
    );
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
      }),
      "failed-precondition"
    );
  });
});

describe("getTripInvitationPreviewCore - status / expiry", () => {
  it("a valid pending + unexpired invitation succeeds", async () => {
    await seedReadyToPreviewScenario();
    const result = await getTripInvitationPreviewCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
    });
    assert.equal(result.tripId, TRIP_ID);
  });

  it("an accepted invitation is rejected (preview is pre-join only)", async () => {
    await seedReadyToPreviewScenario(
      {},
      {status: "accepted", respondedAt: Timestamp.now()}
    );
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
      }),
      "failed-precondition"
    );
  });

  it("a declined invitation is rejected", async () => {
    await seedReadyToPreviewScenario(
      {},
      {status: "declined", respondedAt: Timestamp.now()}
    );
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
      }),
      "failed-precondition"
    );
  });

  it("a cancelled invitation is rejected", async () => {
    await seedReadyToPreviewScenario(
      {},
      {status: "cancelled", respondedAt: Timestamp.now()}
    );
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
      }),
      "failed-precondition"
    );
  });

  it("an expired-while-pending invitation is rejected", async () => {
    await seedReadyToPreviewScenario(
      {},
      {expiresAt: pastTimestamp(1)}
    );
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
      }),
      "failed-precondition"
    );
  });

  it("expiration boundary: expiresAt <= now is rejected (deterministic, no sleep)", async () => {
    // Seeded already in the past relative to the moment this test runs
    // - deterministic by construction, never a timing-dependent sleep.
    await seedReadyToPreviewScenario(
      {},
      {expiresAt: Timestamp.fromMillis(Date.now() - 1)}
    );
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
      }),
      "failed-precondition"
    );
  });
});

describe("getTripInvitationPreviewCore - Trip / owner consistency / archive", () => {
  it("a missing Trip is not-found", async () => {
    await seedInvitation();
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
      }),
      "not-found"
    );
  });

  it("a malformed Trip.ownerId fails closed", async () => {
    await seedTrip({ownerId: ""});
    await seedInvitation();
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
      }),
      "failed-precondition"
    );
  });

  it("a stale inviter (inviterUid no longer matches the current Trip.ownerId) fails closed", async () => {
    await seedTrip({ownerId: OTHER_MEMBER_UID, memberIds: [OTHER_MEMBER_UID]});
    await seedInvitation({inviterUid: OWNER_UID});
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
      }),
      "failed-precondition"
    );
  });

  it("a self-invite (authUid === Trip.ownerId) fails closed", async () => {
    // A corrupted/forged state: the invitation names OWNER_UID as its
    // own invitee, and the caller IS that owner. Seeded directly at the
    // fixed INVITATION_ID (its own canonical id for this inviteeUid).
    await seedTrip();
    const selfInvitationId = tripInvitationId(TRIP_ID, OWNER_UID);
    await db.collection("tripInvitations").doc(selfInvitationId).set(
      baseInvitationData({inviteeUid: OWNER_UID})
    );
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, OWNER_UID, {
        invitationId: selfInvitationId,
      }),
      "failed-precondition"
    );
  });

  it("archivedAt absent: Trip is active, preview succeeds", async () => {
    // baseTripData() never includes archivedAt at all by default - this
    // test documents that "legacy Trip, no archivedAt key ever written"
    // case explicitly, distinct from "explicitly null" below.
    await seedTrip();
    await seedInvitation();
    const result = await getTripInvitationPreviewCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
    });
    assert.equal(result.tripId, TRIP_ID);
  });

  it("archivedAt explicitly null: Trip is active, preview succeeds", async () => {
    await seedTrip({archivedAt: null});
    await seedInvitation();
    const result = await getTripInvitationPreviewCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
    });
    assert.equal(result.tripId, TRIP_ID);
  });

  it("archivedAt a real value: Trip is archived, preview rejects", async () => {
    await seedTrip({archivedAt: Timestamp.now(), archivedBy: OWNER_UID});
    await seedInvitation();
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
      }),
      "failed-precondition"
    );
  });
});

describe("getTripInvitationPreviewCore - safe response shape / normalization", () => {
  it("success returns EXACTLY the six expected top-level keys", async () => {
    await seedReadyToPreviewScenario();
    const result = await getTripInvitationPreviewCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
    });
    assert.deepEqual(Object.keys(result).sort(), EXPECTED_RESPONSE_KEYS);
  });

  it("tripId matches invitation.tripId", async () => {
    await seedReadyToPreviewScenario();
    const result = await getTripInvitationPreviewCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
    });
    assert.equal(result.tripId, TRIP_ID);
  });

  it("returns the current title", async () => {
    await seedReadyToPreviewScenario({title: "Current Title"});
    const result = await getTripInvitationPreviewCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
    });
    assert.equal(result.title, "Current Title");
  });

  it("returns the current location", async () => {
    await seedReadyToPreviewScenario({location: "Current Location"});
    const result = await getTripInvitationPreviewCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
    });
    assert.equal(result.location, "Current Location");
  });

  it("returns the current imageUrl", async () => {
    await seedReadyToPreviewScenario({
      imageUrl: "https://example.com/current.jpg",
    });
    const result = await getTripInvitationPreviewCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
    });
    assert.equal(result.imageUrl, "https://example.com/current.jpg");
  });

  it("returns the current tripStartDate/tripEndDate", async () => {
    await seedReadyToPreviewScenario({
      tripStartDate: "2030-01-01",
      tripEndDate: "2030-01-10",
    });
    const result = await getTripInvitationPreviewCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
    });
    assert.equal(result.tripStartDate, "2030-01-01");
    assert.equal(result.tripEndDate, "2030-01-10");
  });

  it("absent location normalizes to null", async () => {
    const {location, ...tripWithoutLocation} = baseTripData();
    await db.collection("trips").doc(TRIP_ID).set(tripWithoutLocation);
    await seedInvitation();
    const result = await getTripInvitationPreviewCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
    });
    assert.equal(result.location, null);
  });

  it("null location normalizes to null", async () => {
    await seedReadyToPreviewScenario({location: null});
    const result = await getTripInvitationPreviewCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
    });
    assert.equal(result.location, null);
  });

  it("wrong location type fails closed", async () => {
    await seedReadyToPreviewScenario({location: 12345});
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
      }),
      "failed-precondition"
    );
  });

  it("absent tripStartDate normalizes to null", async () => {
    const {tripStartDate, ...tripWithoutStart} = baseTripData();
    await db.collection("trips").doc(TRIP_ID).set(tripWithoutStart);
    await seedInvitation();
    const result = await getTripInvitationPreviewCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
    });
    assert.equal(result.tripStartDate, null);
  });

  it("null tripStartDate normalizes to null", async () => {
    await seedReadyToPreviewScenario({tripStartDate: null});
    const result = await getTripInvitationPreviewCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
    });
    assert.equal(result.tripStartDate, null);
  });

  it("wrong tripStartDate type fails closed", async () => {
    await seedReadyToPreviewScenario({tripStartDate: 20300101});
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
      }),
      "failed-precondition"
    );
  });

  it("absent tripEndDate normalizes to null", async () => {
    const {tripEndDate, ...tripWithoutEnd} = baseTripData();
    await db.collection("trips").doc(TRIP_ID).set(tripWithoutEnd);
    await seedInvitation();
    const result = await getTripInvitationPreviewCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
    });
    assert.equal(result.tripEndDate, null);
  });

  it("null tripEndDate normalizes to null", async () => {
    await seedReadyToPreviewScenario({tripEndDate: null});
    const result = await getTripInvitationPreviewCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
    });
    assert.equal(result.tripEndDate, null);
  });

  it("wrong tripEndDate type fails closed", async () => {
    await seedReadyToPreviewScenario({tripEndDate: 20300110});
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
      }),
      "failed-precondition"
    );
  });

  it("wrong title type fails closed", async () => {
    await seedReadyToPreviewScenario({title: 12345});
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
      }),
      "failed-precondition"
    );
  });

  it("wrong imageUrl type fails closed", async () => {
    await seedReadyToPreviewScenario({imageUrl: 12345});
    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
      }),
      "failed-precondition"
    );
  });
});

describe("getTripInvitationPreviewCore - financial privacy", () => {
  it("no financial/sensitive field appears anywhere in the response, for any seeded value", async () => {
    // baseTripData() already seeds every one of these with a
    // conspicuous, easily-recognizable value by default - this test
    // makes the absence assertion explicit rather than merely implicit
    // in the exact-six-keys check above.
    await seedReadyToPreviewScenario();
    const result = await getTripInvitationPreviewCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
    });

    const resultKeys = Object.keys(result);
    for (const forbidden of [
      "target",
      "saved",
      "ledgerOpeningBalanceMinor",
      "ledgerBalanceMinor",
      "currency",
      "memberIds",
      "ownerId",
      "ownershipModelState",
      "ownershipModelVersion",
      "creationRequest",
      "lastUpdatedBy",
      "inviteeEmail",
      "inviterUid",
    ]) {
      assert.ok(
        !resultKeys.includes(forbidden),
        `response unexpectedly contains forbidden field "${forbidden}"`
      );
    }

    // No nested object leaks any of the conspicuous seeded values either
    // - every value in the flat, six-key response is a primitive
    // (string or null), so a JSON round-trip can never hide a nested
    // leak, but this directly checks the actual seeded sensitive
    // values are not present anywhere in the serialized response.
    const serialized = JSON.stringify(result);
    for (const conspicuousValue of [
      "777777",
      "333333",
      "111111",
      "222222",
      "sensitive-creation-request-id",
    ]) {
      assert.ok(
        !serialized.includes(conspicuousValue),
        `response unexpectedly leaks conspicuous value "${conspicuousValue}"`
      );
    }

    assert.deepEqual(Object.keys(result).sort(), EXPECTED_RESPONSE_KEYS);
  });
});

describe("getTripInvitationPreviewCore - currentness (proves Option A avoids stale snapshots)", () => {
  it("preview reflects Trip metadata mutated AFTER the invitation was created", async () => {
    await seedTrip({title: "Original Title", location: "Original Location"});
    await seedInvitation();

    // Mutate Trip metadata directly, simulating the owner editing the
    // Trip sometime after sending the invitation but before the invitee
    // previews it.
    await db.collection("trips").doc(TRIP_ID).update({
      title: "Renamed After Invite",
      location: "New Location After Invite",
    });

    const result = await getTripInvitationPreviewCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
    });
    assert.equal(result.title, "Renamed After Invite");
    assert.equal(result.location, "New Location After Invite");
  });
});

describe("getTripInvitationPreviewCore - zero-write invariant", () => {
  it("a successful preview changes nothing", async () => {
    await seedReadyToPreviewScenario();
    const before = await snapshotState();

    await getTripInvitationPreviewCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
    });

    const after = await snapshotState();
    assert.deepEqual(after, before);
  });

  it("a rejected preview (expired invitation) changes nothing", async () => {
    await seedReadyToPreviewScenario({}, {expiresAt: pastTimestamp(1)});
    const before = await snapshotState();

    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
      }),
      "failed-precondition"
    );

    const after = await snapshotState();
    assert.deepEqual(after, before);
  });

  it("a rejected preview (wrong caller) changes nothing", async () => {
    await seedReadyToPreviewScenario();
    const before = await snapshotState();

    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, OUTSIDER_UID, {
        invitationId: INVITATION_ID,
      }),
      "permission-denied"
    );

    const after = await snapshotState();
    assert.deepEqual(after, before);
  });

  it("a rejected preview (archived Trip) changes nothing", async () => {
    await seedTrip({archivedAt: Timestamp.now(), archivedBy: OWNER_UID});
    await seedInvitation();
    const before = await snapshotState();

    await assertRejectsWithCode(
      getTripInvitationPreviewCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
      }),
      "failed-precondition"
    );

    const after = await snapshotState();
    assert.deepEqual(after, before);
  });
});
