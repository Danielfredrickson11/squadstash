// Tests for declineTripInvitationCore against the local Firestore
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
  declineTripInvitationCore,
  requireAuthenticatedUid,
} from "../src/callables/declineTripInvitation";
import {tripInvitationId} from "../src/domain/tripCompositeId";
import {invitationDeclinedActivityId} from "../src/domain/tripMembershipActivity";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "FIRESTORE_EMULATOR_HOST is not set. Run these tests via " +
      '`firebase emulators:exec --only firestore "npm --prefix functions test"` ' +
      "so the Admin SDK talks to the local emulator, never production."
  );
}

const OWNER_UID = "owner-uid";
const INVITEE_UID = "invitee-uid";
const OUTSIDER_UID = "outsider-uid";
const TRIP_ID = "canada-trip";
const INVITATION_ID = tripInvitationId(TRIP_ID, INVITEE_UID);

let app: App;
let db: Firestore;

before(() => {
  app = initializeApp({
    projectId: "demo-squadstash-functions-test-decline-trip-invitation",
  });
  db = getFirestore(app);
});

after(async () => {
  await deleteApp(app);
});

async function clearFirestore(): Promise<void> {
  for (const name of ["trips", "tripInvitations", "tripMembershipActivity"]) {
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

async function seedTrip(
  overrides: Record<string, unknown> = {}
): Promise<void> {
  await db.collection("trips").doc(TRIP_ID).set({
    ownerId: OWNER_UID,
    memberIds: [OWNER_UID],
    title: "Canada Trip",
    saved: 0,
    ...overrides,
  });
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
  await db
    .collection("tripInvitations")
    .doc(INVITATION_ID)
    .set(baseInvitationData(overrides));
}

async function getInvitation(): Promise<FirebaseFirestore.DocumentData | undefined> {
  const snap = await db.collection("tripInvitations").doc(INVITATION_ID).get();
  return snap.data();
}

async function getActivity(): Promise<FirebaseFirestore.DocumentData | undefined> {
  const snap = await db
    .collection("tripMembershipActivity")
    .doc(invitationDeclinedActivityId(TRIP_ID, INVITEE_UID))
    .get();
  return snap.data();
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
      (err: unknown) => err instanceof HttpsError && err.code === "unauthenticated"
    );
  });

  it("returns the uid when auth is present", () => {
    const auth = {uid: INVITEE_UID} as CallableRequest["auth"];
    assert.equal(requireAuthenticatedUid(auth), INVITEE_UID);
  });
});

describe("declineTripInvitationCore - input validation", () => {
  it("rejects an unexpected field", async () => {
    await assertRejectsWithCode(
      declineTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        bogus: true,
      }),
      "invalid-argument"
    );
  });

  it("rejects a missing invitationId", async () => {
    await assertRejectsWithCode(
      declineTripInvitationCore(db, INVITEE_UID, {}),
      "invalid-argument"
    );
  });

  it("rejects a malformed invitationId", async () => {
    await assertRejectsWithCode(
      declineTripInvitationCore(db, INVITEE_UID, {invitationId: "not valid"}),
      "invalid-argument"
    );
  });
});

describe("declineTripInvitationCore - authorization", () => {
  it("rejects a nonexistent invitation", async () => {
    await assertRejectsWithCode(
      declineTripInvitationCore(db, INVITEE_UID, {invitationId: INVITATION_ID}),
      "not-found"
    );
  });

  it("the named invitee can decline", async () => {
    await seedTrip();
    await seedInvitation();
    const result = await declineTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
    });
    assert.deepEqual(result, {invitationId: INVITATION_ID, tripId: TRIP_ID});
  });

  it("the Trip owner cannot decline on the invitee's behalf", async () => {
    await seedTrip();
    await seedInvitation();
    await assertRejectsWithCode(
      declineTripInvitationCore(db, OWNER_UID, {invitationId: INVITATION_ID}),
      "permission-denied"
    );
  });

  it("an outsider cannot decline", async () => {
    await seedTrip();
    await seedInvitation();
    await assertRejectsWithCode(
      declineTripInvitationCore(db, OUTSIDER_UID, {invitationId: INVITATION_ID}),
      "permission-denied"
    );
  });
});

describe("declineTripInvitationCore - terminal-state guards", () => {
  it("rejects declining an already-accepted invitation", async () => {
    await seedTrip();
    await seedInvitation({status: "accepted", respondedAt: Timestamp.now()});
    await assertRejectsWithCode(
      declineTripInvitationCore(db, INVITEE_UID, {invitationId: INVITATION_ID}),
      "failed-precondition"
    );
  });

  it("rejects declining an already-cancelled invitation", async () => {
    await seedTrip();
    await seedInvitation({status: "cancelled", respondedAt: Timestamp.now()});
    await assertRejectsWithCode(
      declineTripInvitationCore(db, INVITEE_UID, {invitationId: INVITATION_ID}),
      "failed-precondition"
    );
  });
});

describe("declineTripInvitationCore - expiry", () => {
  it("decline remains allowed regardless of expiry (an already-expired pending invitation can still be declined)", async () => {
    await seedTrip();
    await seedInvitation({expiresAt: pastTimestamp(2)});
    const result = await declineTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
    });
    assert.deepEqual(result, {invitationId: INVITATION_ID, tripId: TRIP_ID});
    const invitation = await getInvitation();
    assert.equal(invitation?.status, "declined");
  });
});

describe("declineTripInvitationCore - malformed invitation fails closed", () => {
  it("rejects a malformed stored invitation (non-string tripId)", async () => {
    await seedTrip();
    await seedInvitation({tripId: 12345});
    await assertRejectsWithCode(
      declineTripInvitationCore(db, INVITEE_UID, {invitationId: INVITATION_ID}),
      "failed-precondition"
    );
  });

  it("rejects an unrecognized status", async () => {
    await seedTrip();
    await seedInvitation({status: "bogus"});
    await assertRejectsWithCode(
      declineTripInvitationCore(db, INVITEE_UID, {invitationId: INVITATION_ID}),
      "failed-precondition"
    );
  });

  it("rejects a pending invitation with a non-null respondedAt", async () => {
    await seedTrip();
    await seedInvitation({respondedAt: Timestamp.now()});
    await assertRejectsWithCode(
      declineTripInvitationCore(db, INVITEE_UID, {invitationId: INVITATION_ID}),
      "failed-precondition"
    );
  });

  it("rejects a document whose own id is not canonical for its tripId/inviteeUid", async () => {
    // inviteeUid still matches authUid (so the authorization check above
    // passes) but tripId is wrong for this document's own id, so the
    // canonical-id re-derivation is what must catch this.
    await seedTrip();
    await db
      .collection("tripInvitations")
      .doc(INVITATION_ID)
      .set(baseInvitationData({tripId: "a-different-trip"}));
    await assertRejectsWithCode(
      declineTripInvitationCore(db, INVITEE_UID, {invitationId: INVITATION_ID}),
      "failed-precondition"
    );
  });
});

describe("declineTripInvitationCore - atomic success writes", () => {
  it("invitation becomes declined with a server-set respondedAt", async () => {
    await seedTrip();
    await seedInvitation();
    const before = Date.now();
    await declineTripInvitationCore(db, INVITEE_UID, {invitationId: INVITATION_ID});
    const invitation = await getInvitation();
    assert.equal(invitation?.status, "declined");
    assert.ok(invitation?.respondedAt instanceof Timestamp);
    assert.ok((invitation?.respondedAt as Timestamp).toMillis() >= before);
  });

  it("creates the exact invitation_declined membership-activity event", async () => {
    await seedTrip();
    await seedInvitation();
    await declineTripInvitationCore(db, INVITEE_UID, {invitationId: INVITATION_ID});
    const activity = await getActivity();
    assert.equal(activity?.tripId, TRIP_ID);
    assert.equal(activity?.type, "invitation_declined");
    assert.equal(activity?.actorUid, INVITEE_UID);
    assert.equal(activity?.targetUid, INVITEE_UID);
    assert.equal(activity?.invitationId, INVITATION_ID);
    assert.equal(activity?.schemaVersion, 1);
    assert.ok(activity?.createdAt instanceof Timestamp);
  });

  it("never mutates Trip.memberIds", async () => {
    await seedTrip();
    await seedInvitation();
    await declineTripInvitationCore(db, INVITEE_UID, {invitationId: INVITATION_ID});
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.deepEqual(tripSnap.data()!.memberIds, [OWNER_UID]);
  });
});

describe("declineTripInvitationCore - replay/idempotency", () => {
  it("an already-declined invitation (by its own invitee) replays successfully with NO writes", async () => {
    await seedTrip();
    await seedInvitation();
    const first = await declineTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
    });
    const invitationBefore = await getInvitation();
    const activityBefore = await getActivity();

    const second = await declineTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
    });
    assert.deepEqual(second, first);

    const invitationAfter = await getInvitation();
    const activityAfter = await getActivity();
    assert.ok(
      (invitationBefore?.respondedAt as Timestamp).isEqual(
        invitationAfter?.respondedAt as Timestamp
      ),
      "replay must not reset respondedAt"
    );
    assert.ok(
      (activityBefore?.createdAt as Timestamp).isEqual(
        activityAfter?.createdAt as Timestamp
      ),
      "replay must not re-create/touch the activity event"
    );

    const allActivity = await db.collection("tripMembershipActivity").get();
    assert.equal(allActivity.size, 1);
  });

  it("two concurrent identical decline attempts produce exactly one activity event", async () => {
    await seedTrip();
    await seedInvitation();
    await Promise.allSettled([
      declineTripInvitationCore(db, INVITEE_UID, {invitationId: INVITATION_ID}),
      declineTripInvitationCore(db, INVITEE_UID, {invitationId: INVITATION_ID}),
    ]);
    const allActivity = await db.collection("tripMembershipActivity").get();
    assert.equal(allActivity.size, 1);
    const invitation = await getInvitation();
    assert.equal(invitation?.status, "declined");
  });
});

describe("declineTripInvitationCore - atomic failure behavior", () => {
  it("a rejected decline (accepted invitation) creates no activity event and does not mutate the invitation", async () => {
    await seedTrip();
    await seedInvitation({status: "accepted", respondedAt: Timestamp.now()});
    const before = await getInvitation();
    await assertRejectsWithCode(
      declineTripInvitationCore(db, INVITEE_UID, {invitationId: INVITATION_ID}),
      "failed-precondition"
    );
    const after = await getInvitation();
    assert.deepEqual(after, before);
    const activity = await getActivity();
    assert.equal(activity, undefined);
  });
});
