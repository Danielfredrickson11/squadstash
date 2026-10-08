// Tests for createTripInvitationCore against the local Firestore
// emulator via the Admin SDK - never production, guarded below. Run via
// `npm --prefix functions test`, wrapped in
// `firebase emulators:exec --only firestore "..."`.
//
// The Admin Auth email-to-uid lookup is injected (never the real
// getAuth().getUserByEmail) - this project configures no Auth emulator
// (see firebase.json), so every test below supplies a fake
// resolveInviteeUid instead. See createTripInvitation.ts's own doc
// comment on that parameter for why.
import assert from "node:assert/strict";
import {after, before, beforeEach, describe, it} from "node:test";
import {deleteApp, initializeApp} from "firebase-admin/app";
import type {App} from "firebase-admin/app";
import {getFirestore} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";
import {
  createTripInvitationCore,
  requireAuthenticatedUid,
} from "../src/callables/createTripInvitation";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "FIRESTORE_EMULATOR_HOST is not set. Run these tests via " +
      '`firebase emulators:exec --only firestore "npm --prefix functions test"` ' +
      "so the Admin SDK talks to the local emulator, never production."
  );
}

const OWNER_UID = "owner-uid";
const INVITEE_UID = "invitee-uid";
const OTHER_UID = "other-uid";
const TRIP_ID = "canada-trip";

let app: App;
let db: Firestore;

before(() => {
  // A distinct "demo-" project id from every other Functions test file's
  // own test app - see createBucketCore.ts's comment for why this
  // matters (Node's test runner executes test files concurrently).
  app = initializeApp({
    projectId: "demo-squadstash-functions-test-create-trip-invitation",
  });
  db = getFirestore(app);
});

after(async () => {
  await deleteApp(app);
});

async function clearFirestore(): Promise<void> {
  for (const name of ["trips", "tripInvitations"]) {
    const snap = await db.collection(name).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

beforeEach(async () => {
  await clearFirestore();
});

function baseTripData(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ownerId: OWNER_UID,
    memberIds: [OWNER_UID],
    title: "Canada Trip",
    location: "Banff, Canada",
    target: 5000,
    saved: 0,
    imageUrl: "https://example.com/canada.jpg",
    tripStartDate: "2027-06-12",
    ...overrides,
  };
}

async function seedTrip(
  tripId: string,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  await db.collection("trips").doc(tripId).set(baseTripData(overrides));
}

const INVITEE_EMAIL = "friend@example.com";

// A fake resolveInviteeUid that always resolves to INVITEE_UID,
// regardless of the email passed - sufficient for every test below,
// since none needs to exercise multiple distinct resolved identities at
// once.
async function fakeResolveInviteeUid(): Promise<string> {
  return INVITEE_UID;
}

async function neverResolveInviteeUid(): Promise<string> {
  throw new HttpsError("not-found", "No user found with that email.");
}

function baseRequest(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    tripId: TRIP_ID,
    inviteeEmail: INVITEE_EMAIL,
    ...overrides,
  };
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
    const auth = {uid: OWNER_UID} as CallableRequest["auth"];
    assert.equal(requireAuthenticatedUid(auth), OWNER_UID);
  });
});

describe("createTripInvitationCore - input validation", () => {
  beforeEach(async () => {
    await seedTrip(TRIP_ID);
  });

  it("missing tripId is rejected", async () => {
    await assertRejectsWithCode(
      createTripInvitationCore(
        db,
        OWNER_UID,
        baseRequest({tripId: undefined}),
        fakeResolveInviteeUid
      ),
      "invalid-argument"
    );
  });

  it("non-string tripId is rejected", async () => {
    await assertRejectsWithCode(
      createTripInvitationCore(
        db,
        OWNER_UID,
        baseRequest({tripId: 123}),
        fakeResolveInviteeUid
      ),
      "invalid-argument"
    );
  });

  it("missing inviteeEmail is rejected", async () => {
    await assertRejectsWithCode(
      createTripInvitationCore(
        db,
        OWNER_UID,
        baseRequest({inviteeEmail: undefined}),
        fakeResolveInviteeUid
      ),
      "invalid-argument"
    );
  });

  it("whitespace-only inviteeEmail is rejected", async () => {
    await assertRejectsWithCode(
      createTripInvitationCore(
        db,
        OWNER_UID,
        baseRequest({inviteeEmail: "   "}),
        fakeResolveInviteeUid
      ),
      "invalid-argument"
    );
  });
});

describe("createTripInvitationCore - trip existence and authorization", () => {
  it("rejects a tripId with no Trip document", async () => {
    await assertRejectsWithCode(
      createTripInvitationCore(db, OWNER_UID, baseRequest(), fakeResolveInviteeUid),
      "not-found"
    );
  });

  it("a non-owner member cannot invite", async () => {
    await seedTrip(TRIP_ID, {memberIds: [OWNER_UID, OTHER_UID]});
    await assertRejectsWithCode(
      createTripInvitationCore(db, OTHER_UID, baseRequest(), fakeResolveInviteeUid),
      "permission-denied"
    );
  });

  it("an outsider (not a member at all) cannot invite", async () => {
    await seedTrip(TRIP_ID);
    await assertRejectsWithCode(
      createTripInvitationCore(db, OTHER_UID, baseRequest(), fakeResolveInviteeUid),
      "permission-denied"
    );
  });

  it("the owner can invite", async () => {
    await seedTrip(TRIP_ID);
    const result = await createTripInvitationCore(
      db,
      OWNER_UID,
      baseRequest(),
      fakeResolveInviteeUid
    );
    assert.equal(result.inviteeUid, INVITEE_UID);
    assert.equal(result.invitationId, `${TRIP_ID}_${INVITEE_UID}`);
  });

  it("rejects an archived Trip", async () => {
    await seedTrip(TRIP_ID, {archivedAt: new Date(), archivedBy: OWNER_UID});
    await assertRejectsWithCode(
      createTripInvitationCore(db, OWNER_UID, baseRequest(), fakeResolveInviteeUid),
      "failed-precondition"
    );
  });

  it("a legacy Trip with no archivedAt key at all still accepts invitations", async () => {
    await seedTrip(TRIP_ID);
    await assert.doesNotReject(
      createTripInvitationCore(db, OWNER_UID, baseRequest(), fakeResolveInviteeUid)
    );
  });
});

describe("createTripInvitationCore - email-enumeration ordering (Checkpoint 5A.1)", () => {
  // A caller must not learn whether inviteeEmail corresponds to a
  // registered account until AFTER they are proven to be this Trip's
  // owner on an active Trip - this spy proves resolveInviteeUid is never
  // even INVOKED for an unauthorized caller, not merely that its result
  // is discarded.
  function spyResolver() {
    let callCount = 0;
    const resolve = async (): Promise<string> => {
      callCount += 1;
      return INVITEE_UID;
    };
    return {resolve, getCallCount: () => callCount};
  }

  it("never calls the email resolver for a nonexistent Trip", async () => {
    const spy = spyResolver();
    await assertRejectsWithCode(
      createTripInvitationCore(db, OWNER_UID, baseRequest(), spy.resolve),
      "not-found"
    );
    assert.equal(spy.getCallCount(), 0);
  });

  it("never calls the email resolver for a non-owner current member", async () => {
    await seedTrip(TRIP_ID, {memberIds: [OWNER_UID, OTHER_UID]});
    const spy = spyResolver();
    await assertRejectsWithCode(
      createTripInvitationCore(db, OTHER_UID, baseRequest(), spy.resolve),
      "permission-denied"
    );
    assert.equal(spy.getCallCount(), 0);
  });

  it("never calls the email resolver for a complete outsider", async () => {
    await seedTrip(TRIP_ID);
    const spy = spyResolver();
    await assertRejectsWithCode(
      createTripInvitationCore(db, OTHER_UID, baseRequest(), spy.resolve),
      "permission-denied"
    );
    assert.equal(spy.getCallCount(), 0);
  });

  it("never calls the email resolver for an archived Trip, even for its own owner", async () => {
    await seedTrip(TRIP_ID, {archivedAt: new Date(), archivedBy: OWNER_UID});
    const spy = spyResolver();
    await assertRejectsWithCode(
      createTripInvitationCore(db, OWNER_UID, baseRequest(), spy.resolve),
      "failed-precondition"
    );
    assert.equal(spy.getCallCount(), 0);
  });

  it("DOES call the email resolver once the caller is confirmed as owner on an active Trip", async () => {
    await seedTrip(TRIP_ID);
    const spy = spyResolver();
    await createTripInvitationCore(db, OWNER_UID, baseRequest(), spy.resolve);
    assert.equal(spy.getCallCount(), 1);
  });
});

describe("createTripInvitationCore - composite-id delimiter safety (item 7)", () => {
  it("refuses to build an invitation id when tripId contains the delimiter", async () => {
    const underscoreTripId = "trip_with_underscore";
    await db.collection("trips").doc(underscoreTripId).set({
      ownerId: OWNER_UID,
      memberIds: [OWNER_UID],
      title: "Underscore Trip",
      location: "Nowhere",
      target: 1000,
      saved: 0,
      imageUrl: "https://example.com/u.jpg",
      tripStartDate: "2027-06-12",
    });
    await assertRejectsWithCode(
      createTripInvitationCore(
        db,
        OWNER_UID,
        baseRequest({tripId: underscoreTripId}),
        fakeResolveInviteeUid
      ),
      "internal"
    );
  });

  it("refuses to build an invitation id when the resolved inviteeUid contains the delimiter", async () => {
    await seedTrip(TRIP_ID);
    async function resolveToUnderscoreUid(): Promise<string> {
      return "invitee_with_underscore";
    }
    await assertRejectsWithCode(
      createTripInvitationCore(db, OWNER_UID, baseRequest(), resolveToUnderscoreUid),
      "internal"
    );
  });
});

describe("createTripInvitationCore - invitee email resolution", () => {
  beforeEach(async () => {
    await seedTrip(TRIP_ID);
  });

  it("propagates a not-found lookup failure as not-found", async () => {
    await assertRejectsWithCode(
      createTripInvitationCore(
        db,
        OWNER_UID,
        baseRequest(),
        neverResolveInviteeUid
      ),
      "not-found"
    );
  });

  it("rejects inviting yourself", async () => {
    async function resolveToSelf(): Promise<string> {
      return OWNER_UID;
    }
    await assertRejectsWithCode(
      createTripInvitationCore(db, OWNER_UID, baseRequest(), resolveToSelf),
      "invalid-argument"
    );
  });
});

describe("createTripInvitationCore - duplicate/already-member rejection", () => {
  it("rejects inviting a uid that is already a member", async () => {
    await seedTrip(TRIP_ID, {memberIds: [OWNER_UID, INVITEE_UID]});
    await assertRejectsWithCode(
      createTripInvitationCore(db, OWNER_UID, baseRequest(), fakeResolveInviteeUid),
      "already-exists"
    );
  });

  it("rejects a second invitation for a uid that already has one (any status)", async () => {
    await seedTrip(TRIP_ID);
    await createTripInvitationCore(db, OWNER_UID, baseRequest(), fakeResolveInviteeUid);
    await assertRejectsWithCode(
      createTripInvitationCore(db, OWNER_UID, baseRequest(), fakeResolveInviteeUid),
      "already-exists"
    );
  });

  it("rejects a second invitation even after the first was manually set to declined", async () => {
    await seedTrip(TRIP_ID);
    const first = await createTripInvitationCore(
      db,
      OWNER_UID,
      baseRequest(),
      fakeResolveInviteeUid
    );
    await db
      .collection("tripInvitations")
      .doc(first.invitationId)
      .update({status: "declined"});
    await assertRejectsWithCode(
      createTripInvitationCore(db, OWNER_UID, baseRequest(), fakeResolveInviteeUid),
      "already-exists"
    );
  });
});

describe("createTripInvitationCore - persisted document shape", () => {
  it("writes the expected fields with pending status and no response yet", async () => {
    await seedTrip(TRIP_ID);
    const before = Date.now();
    const result = await createTripInvitationCore(
      db,
      OWNER_UID,
      baseRequest(),
      fakeResolveInviteeUid
    );
    const snap = await db.collection("tripInvitations").doc(result.invitationId).get();
    const data = snap.data()!;
    assert.equal(data.tripId, TRIP_ID);
    assert.equal(data.inviterUid, OWNER_UID);
    assert.equal(data.inviteeEmail, INVITEE_EMAIL);
    assert.equal(data.inviteeUid, INVITEE_UID);
    assert.equal(data.status, "pending");
    assert.equal(data.respondedAt, null);
    assert.ok(data.createdAt.toMillis() >= before);
    assert.ok(data.expiresAt.toMillis() > data.createdAt.toMillis());
  });

  it("never writes a memberIds field on the invitation document itself", async () => {
    await seedTrip(TRIP_ID);
    const result = await createTripInvitationCore(
      db,
      OWNER_UID,
      baseRequest(),
      fakeResolveInviteeUid
    );
    const snap = await db.collection("tripInvitations").doc(result.invitationId).get();
    assert.equal("memberIds" in snap.data()!, false);
  });

  it("never mutates the Trip document's own memberIds", async () => {
    await seedTrip(TRIP_ID);
    await createTripInvitationCore(db, OWNER_UID, baseRequest(), fakeResolveInviteeUid);
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.deepEqual(tripSnap.data()!.memberIds, [OWNER_UID]);
  });
});
