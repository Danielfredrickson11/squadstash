// Tests for acceptTripInvitationCore against the local Firestore emulator
// via the Admin SDK - never production, guarded below. Run via
// `npm --prefix functions test`, wrapped in
// `firebase emulators:exec --only firestore "..."`.
import assert from "node:assert/strict";
import {after, before, beforeEach, describe, it} from "node:test";
import {deleteApp, initializeApp} from "firebase-admin/app";
import type {App} from "firebase-admin/app";
import {FieldValue, Timestamp, getFirestore} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";
import {
  acceptTripInvitationCore,
  requireAuthenticatedUid,
} from "../src/callables/acceptTripInvitation";
import {publishTripTermsCore} from "../src/callables/publishTripTerms";
import {
  tripInvitationId,
  tripMembershipAcceptanceId,
} from "../src/domain/tripCompositeId";
import {CURRENT_TRIP_OWNERSHIP_MODEL_VERSION} from "../src/domain/tripOwnershipModel";

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
const TRIP_ID = "canada-trip";
const INVITATION_ID = tripInvitationId(TRIP_ID, INVITEE_UID);

let app: App;
let db: Firestore;

before(() => {
  // A distinct "demo-" project id from every other Functions test file's
  // own test app - see createBucketCore.ts's comment for why this
  // matters (Node's test runner executes test files concurrently).
  app = initializeApp({
    projectId: "demo-squadstash-functions-test-accept-trip-invitation",
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
    "tripTerms",
    "tripTermsCurrent",
    "tripMembershipAcceptances",
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
    ledgerOpeningBalanceMinor: 0,
    ledgerBalanceMinor: 0,
    currency: "USD",
    ownershipModelState: "initialized",
    ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
    ...overrides,
  };
}

async function seedTrip(
  overrides: Record<string, unknown> = {}
): Promise<void> {
  const data = baseTripData(overrides);
  // Firestore's Admin SDK rejects an explicit `undefined` field value
  // outright - simulating a genuinely ABSENT field (e.g.
  // ownershipModelVersion when testing a "legacy" state) means omitting
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

/** Seeds a tripTerms document + its tripTermsCurrent pointer, version 1. */
async function seedTermsAndPointer(
  overrides: {termsOverrides?: Record<string, unknown>} = {}
): Promise<string> {
  const termsRef = db.collection("tripTerms").doc();
  await termsRef.set({
    tripId: TRIP_ID,
    version: 1,
    createdAt: Timestamp.now(),
    createdBy: OWNER_UID,
    contributionExpectations: "Each member contributes $200.",
    expenseAllocationExpectations: "Shared expenses split evenly.",
    sharedStashSpendingAuthority: "Any member may record an expense.",
    withdrawalExpectations: "Uncommitted funds may be withdrawn any time.",
    settlementExpectations: "Debts settle within 7 days.",
    ...overrides.termsOverrides,
  });
  await db.collection("tripTermsCurrent").doc(TRIP_ID).set({
    tripId: TRIP_ID,
    currentVersion: 1,
    currentTermsDocId: termsRef.id,
    updatedAt: Timestamp.now(),
  });
  return termsRef.id;
}

/** Full happy-path setup: Trip, pending+unexpired invitation, terms. */
async function seedReadyToAcceptScenario(
  tripOverrides: Record<string, unknown> = {},
  invitationOverrides: Record<string, unknown> = {}
): Promise<string> {
  await seedTrip(tripOverrides);
  await seedInvitation(invitationOverrides);
  return seedTermsAndPointer();
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

describe("acceptTripInvitationCore - input validation", () => {
  it("null body is rejected", async () => {
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, null),
      "invalid-argument"
    );
  });

  it("non-object body is rejected", async () => {
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, "not-an-object"),
      "invalid-argument"
    );
  });

  it("missing invitationId is rejected", async () => {
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        acceptedTermsDocId: "terms-1",
      }),
      "invalid-argument"
    );
  });

  it("missing acceptedTermsDocId is rejected", async () => {
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
      }),
      "invalid-argument"
    );
  });

  it("empty-string invitationId is rejected", async () => {
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: "",
        acceptedTermsDocId: "terms-1",
      }),
      "invalid-argument"
    );
  });

  it("empty-string acceptedTermsDocId is rejected", async () => {
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: "",
      }),
      "invalid-argument"
    );
  });

  it("non-string invitationId is rejected", async () => {
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: 123,
        acceptedTermsDocId: "terms-1",
      }),
      "invalid-argument"
    );
  });

  it("non-string acceptedTermsDocId is rejected", async () => {
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: 123,
      }),
      "invalid-argument"
    );
  });

  it("an unknown top-level field is rejected", async () => {
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: "terms-1",
        uid: INVITEE_UID,
      }),
      "invalid-argument"
    );
  });

  it("a trusted field (memberIds) present is rejected", async () => {
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: "terms-1",
        memberIds: [INVITEE_UID],
      }),
      "invalid-argument"
    );
  });

  it("an unsafe/malformed document id (path-like) is rejected", async () => {
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: "not/a/safe/id",
        acceptedTermsDocId: "terms-1",
      }),
      "invalid-argument"
    );
  });

  it("a realistic long composite invitationId (long uid) is NOT rejected merely for length", async () => {
    // Firebase Auth uids can be substantially longer than a Firestore
    // auto-id - this must not be mistaken for an unsafe id.
    const longUid = "a".repeat(128);
    const longInvitationId = `${TRIP_ID}_${longUid}`;
    await seedTrip();
    await seedInvitation({inviteeUid: longUid});
    const termsDocId = await seedTermsAndPointer();
    await assert.doesNotReject(
      acceptTripInvitationCore(db, longUid, {
        invitationId: longInvitationId,
        acceptedTermsDocId: termsDocId,
      })
    );
  });

  // Checkpoint 5C.1A: acceptedTermsDocId must reject the composite-id
  // delimiter BEFORE any Firestore read - it is a plain (non-composite)
  // tripTerms id, and a value containing "_" can never be a valid
  // component of tripMembershipAcceptanceId(tripId, uid, termsDocId).
  it('acceptedTermsDocId containing the composite-id delimiter "_" is rejected with invalid-argument, before any Firestore read', async () => {
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: "terms_with_underscore",
      }),
      "invalid-argument"
    );
    // No invitation document was seeded at all - if this reached a
    // Firestore read it would fail with "not-found" instead.
  });

  it("an otherwise-malformed acceptedTermsDocId (path-like) is rejected with invalid-argument", async () => {
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: "../not/a/safe/id",
      }),
      "invalid-argument"
    );
  });

  it("a normal current auto-generated terms id still succeeds", async () => {
    const termsDocId = await seedReadyToAcceptScenario();
    // A real Firestore auto-id is alphanumeric-only - well within the
    // stricter acceptedTermsDocId pattern (no underscore permitted).
    await assert.doesNotReject(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      })
    );
  });
});

describe("acceptTripInvitationCore - invitation identity", () => {
  it("missing invitation is rejected", async () => {
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: "terms-1",
      }),
      "not-found"
    );
  });

  it("the wrong invitee gets permission-denied", async () => {
    const termsDocId = await seedReadyToAcceptScenario();
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, OUTSIDER_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "permission-denied"
    );
  });

  it("the Trip owner cannot accept on behalf of the invitee", async () => {
    const termsDocId = await seedReadyToAcceptScenario();
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, OWNER_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "permission-denied"
    );
  });

  it("another current member cannot accept on behalf of the invitee", async () => {
    const termsDocId = await seedReadyToAcceptScenario({
      memberIds: [OWNER_UID, OTHER_MEMBER_UID],
    });
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, OTHER_MEMBER_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "permission-denied"
    );
  });

  it("an invitation doc id inconsistent with its own stored tripId/inviteeUid fails closed (canonical-id check, not merely the identity check)", async () => {
    await seedTrip();
    const termsDocId = await seedTermsAndPointer();
    // Seed a document AT the canonical INVITATION_ID, with inviteeUid
    // correctly matching the caller (so the earlier authUid === inviteeUid
    // check passes), but a tripId that disagrees with what that id
    // implies - this specifically exercises the canonical-id check
    // itself, not the identity check.
    await db.collection("tripInvitations").doc(INVITATION_ID).set(
      baseInvitationData({tripId: "some-other-trip", inviteeUid: INVITEE_UID})
    );
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("inviterUid differing from the Trip's current ownerId fails closed", async () => {
    await seedTrip();
    await seedInvitation({inviterUid: OTHER_MEMBER_UID});
    const termsDocId = await seedTermsAndPointer();
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("malformed inviterUid fails closed", async () => {
    await seedTrip();
    await seedInvitation({inviterUid: ""});
    const termsDocId = await seedTermsAndPointer();
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("malformed inviteeUid fails closed", async () => {
    await seedTrip();
    // Seeded directly at the fixed canonical INVITATION_ID (not via
    // seedInvitation, whose own id-computation would otherwise be
    // thrown off by this deliberately-corrupted field) - the lookup by
    // invitationId must still find the document, then the shape
    // validator must catch the corruption.
    await db
      .collection("tripInvitations")
      .doc(INVITATION_ID)
      .set(baseInvitationData({inviteeUid: 123}));
    const termsDocId = await seedTermsAndPointer();
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("malformed tripId fails closed", async () => {
    await seedTrip();
    await db
      .collection("tripInvitations")
      .doc(INVITATION_ID)
      .set(baseInvitationData({tripId: ""}));
    const termsDocId = await seedTermsAndPointer();
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("malformed createdAt fails closed", async () => {
    await seedTrip();
    await seedInvitation({createdAt: "2026-01-01"});
    const termsDocId = await seedTermsAndPointer();
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("malformed expiresAt fails closed", async () => {
    await seedTrip();
    await seedInvitation({expiresAt: "2026-01-01"});
    const termsDocId = await seedTermsAndPointer();
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("a pending invitation with a non-null respondedAt fails closed", async () => {
    await seedTrip();
    await seedInvitation({respondedAt: Timestamp.now()});
    const termsDocId = await seedTermsAndPointer();
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("an unknown invitation status fails closed", async () => {
    await seedTrip();
    await seedInvitation({status: "revoked", respondedAt: Timestamp.now()});
    const termsDocId = await seedTermsAndPointer();
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });
});

describe("acceptTripInvitationCore - Trip member canonicality", () => {
  it("memberIds not an array fails closed", async () => {
    const termsDocId = await seedReadyToAcceptScenario({memberIds: OWNER_UID});
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("a non-string memberIds entry fails closed", async () => {
    const termsDocId = await seedReadyToAcceptScenario({
      memberIds: [OWNER_UID, 123],
    });
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("an empty-string memberIds entry fails closed", async () => {
    const termsDocId = await seedReadyToAcceptScenario({
      memberIds: [OWNER_UID, ""],
    });
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("a duplicate uid in memberIds fails closed", async () => {
    const termsDocId = await seedReadyToAcceptScenario({
      memberIds: [OWNER_UID, OWNER_UID],
    });
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("ownerId absent from memberIds fails closed", async () => {
    const termsDocId = await seedReadyToAcceptScenario({
      memberIds: [OTHER_MEMBER_UID],
    });
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("ownerId duplicated within memberIds fails closed", async () => {
    const termsDocId = await seedReadyToAcceptScenario({
      memberIds: [OWNER_UID, OWNER_UID, OTHER_MEMBER_UID],
    });
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("new acceptance where the invitee is already present in memberIds fails closed", async () => {
    const termsDocId = await seedReadyToAcceptScenario({
      memberIds: [OWNER_UID, INVITEE_UID],
    });
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });
});

describe("acceptTripInvitationCore - invitation state (new acceptance)", () => {
  it("a valid pending, unexpired invitation succeeds", async () => {
    const termsDocId = await seedReadyToAcceptScenario();
    const result = await acceptTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
      acceptedTermsDocId: termsDocId,
    });
    assert.deepEqual(result, {tripId: TRIP_ID});
  });

  it("an expired pending invitation is rejected", async () => {
    await seedTrip();
    await seedInvitation({expiresAt: pastTimestamp()});
    const termsDocId = await seedTermsAndPointer();
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("a declined invitation is rejected", async () => {
    await seedTrip();
    await seedInvitation({status: "declined", respondedAt: Timestamp.now()});
    const termsDocId = await seedTermsAndPointer();
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("a cancelled invitation is rejected", async () => {
    await seedTrip();
    await seedInvitation({status: "cancelled", respondedAt: Timestamp.now()});
    const termsDocId = await seedTermsAndPointer();
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("an archived Trip rejects a NEW acceptance", async () => {
    const termsDocId = await seedReadyToAcceptScenario({
      archivedAt: Timestamp.now(),
      archivedBy: OWNER_UID,
    });
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });
});

describe("acceptTripInvitationCore - ownership-model gate (new acceptance only)", () => {
  it("absent ownershipModelState (legacy) rejects", async () => {
    await seedTrip({
      ownershipModelState: undefined,
      ownershipModelVersion: undefined,
    });
    await seedInvitation();
    const termsDocId = await seedTermsAndPointer();
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it('explicit "legacy" rejects', async () => {
    const termsDocId = await seedReadyToAcceptScenario({
      ownershipModelState: "legacy",
      ownershipModelVersion: undefined,
    });
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it('"migrating" rejects', async () => {
    const termsDocId = await seedReadyToAcceptScenario({
      ownershipModelState: "migrating",
      ownershipModelVersion: undefined,
    });
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it('"needs_reconciliation" rejects', async () => {
    const termsDocId = await seedReadyToAcceptScenario({
      ownershipModelState: "needs_reconciliation",
      ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
    });
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("malformed/corrupt ownership state rejects", async () => {
    const termsDocId = await seedReadyToAcceptScenario({
      ownershipModelState: "bogus-state",
    });
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("initialized at an unsupported version rejects", async () => {
    const termsDocId = await seedReadyToAcceptScenario({
      ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION + 1,
    });
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("initialized at the current version succeeds", async () => {
    const termsDocId = await seedReadyToAcceptScenario();
    await assert.doesNotReject(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      })
    );
  });
});

describe("acceptTripInvitationCore - terms / anti-TOCTOU (new acceptance only)", () => {
  it("a missing tripTermsCurrent pointer rejects", async () => {
    await seedTrip();
    await seedInvitation();
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: "nonexistent-terms",
      }),
      "failed-precondition"
    );
  });

  it("a malformed pointer (bad currentVersion) rejects", async () => {
    await seedTrip();
    await seedInvitation();
    const termsDocId = await seedTermsAndPointer();
    await db.collection("tripTermsCurrent").doc(TRIP_ID).update({
      currentVersion: -1,
    });
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  // Checkpoint 5C.1A, item 5: the publishTripTerms regression suite
  // already proves the extracted tripTermsPointer.ts validator itself
  // exhaustively - these few tests exist only to prove THIS callable is
  // actually wired through those same shared checks, not to re-derive
  // the whole corruption matrix a second time.
  it("wiring: pointer.tripId mismatch rejects", async () => {
    await seedTrip();
    await seedInvitation();
    const termsDocId = await seedTermsAndPointer();
    await db.collection("tripTermsCurrent").doc(TRIP_ID).update({
      tripId: "some-other-trip",
    });
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("wiring: pointer.currentTermsDocId empty/wrong type rejects", async () => {
    await seedTrip();
    await seedInvitation();
    const termsDocId = await seedTermsAndPointer();
    await db.collection("tripTermsCurrent").doc(TRIP_ID).update({
      currentTermsDocId: "",
    });
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("wiring: pointer.currentVersion fractional/unsafe rejects", async () => {
    await seedTrip();
    await seedInvitation();
    const termsDocId = await seedTermsAndPointer();
    await db.collection("tripTermsCurrent").doc(TRIP_ID).update({
      currentVersion: 1.5,
    });
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("a missing accepted terms document rejects", async () => {
    await seedTrip();
    await seedInvitation();
    await seedTermsAndPointer();
    // Point the pointer at a doc that does not exist, and try to accept
    // that same (nonexistent) id.
    await db.collection("tripTermsCurrent").doc(TRIP_ID).update({
      currentTermsDocId: "nonexistent-terms-doc",
    });
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: "nonexistent-terms-doc",
      }),
      "failed-precondition"
    );
  });

  it("terms belonging to a different Trip rejects", async () => {
    await seedTrip();
    await seedInvitation();
    const foreignTermsRef = db.collection("tripTerms").doc();
    await foreignTermsRef.set({
      tripId: "some-other-trip",
      version: 1,
      createdAt: Timestamp.now(),
      createdBy: OWNER_UID,
      contributionExpectations: "x",
      expenseAllocationExpectations: "x",
      sharedStashSpendingAuthority: "x",
      withdrawalExpectations: "x",
      settlementExpectations: "x",
    });
    await db.collection("tripTermsCurrent").doc(TRIP_ID).set({
      tripId: TRIP_ID,
      currentVersion: 1,
      currentTermsDocId: foreignTermsRef.id,
      updatedAt: Timestamp.now(),
    });
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: foreignTermsRef.id,
      }),
      "failed-precondition"
    );
  });

  it("a terms/pointer version mismatch rejects", async () => {
    await seedTrip();
    await seedInvitation();
    const termsDocId = await seedTermsAndPointer();
    await db.collection("tripTermsCurrent").doc(TRIP_ID).update({
      currentVersion: 2,
    });
    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("a stale acceptedTermsDocId (pointer has since moved on) rejects with a terms_changed reason", async () => {
    await seedTrip();
    await seedInvitation();
    const staleTermsDocId = await seedTermsAndPointer();
    // Republish - the pointer now names a NEW, different document.
    const newTermsRef = db.collection("tripTerms").doc();
    await newTermsRef.set({
      tripId: TRIP_ID,
      version: 2,
      createdAt: Timestamp.now(),
      createdBy: OWNER_UID,
      contributionExpectations: "Updated terms.",
      expenseAllocationExpectations: "x",
      sharedStashSpendingAuthority: "x",
      withdrawalExpectations: "x",
      settlementExpectations: "x",
    });
    await db.collection("tripTermsCurrent").doc(TRIP_ID).set({
      tripId: TRIP_ID,
      currentVersion: 2,
      currentTermsDocId: newTermsRef.id,
      updatedAt: Timestamp.now(),
    });

    await assert.rejects(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: staleTermsDocId,
      }),
      (err: unknown) => {
        assert.ok(err instanceof HttpsError);
        assert.equal((err as HttpsError).code, "failed-precondition");
        assert.equal(
          (err as HttpsError & {details?: {reason?: string}}).details
            ?.reason,
          "terms_changed"
        );
        return true;
      }
    );
  });

  it("the exact displayed/current terms succeeds", async () => {
    const termsDocId = await seedReadyToAcceptScenario();
    await assert.doesNotReject(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      })
    );
  });
});

describe("acceptTripInvitationCore - atomic success writes", () => {
  it("invitation becomes accepted with a server-set respondedAt", async () => {
    const termsDocId = await seedReadyToAcceptScenario();
    const before = Date.now();
    await acceptTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
      acceptedTermsDocId: termsDocId,
    });
    const snap = await db.collection("tripInvitations").doc(INVITATION_ID).get();
    const data = snap.data()!;
    assert.equal(data.status, "accepted");
    assert.ok(data.respondedAt instanceof Timestamp);
    assert.ok(data.respondedAt.toMillis() >= before);
  });

  it("the immutable acceptance record has exactly the five expected fields, with acceptedTermsVersion derived from terms", async () => {
    const termsDocId = await seedReadyToAcceptScenario();
    await acceptTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
      acceptedTermsDocId: termsDocId,
    });
    const acceptanceId = tripMembershipAcceptanceId(
      TRIP_ID,
      INVITEE_UID,
      termsDocId
    );
    const snap = await db
      .collection("tripMembershipAcceptances")
      .doc(acceptanceId)
      .get();
    const data = snap.data()!;
    assert.deepEqual(Object.keys(data).sort(), [
      "acceptedAt",
      "acceptedTermsVersion",
      "termsDocId",
      "tripId",
      "uid",
    ]);
    assert.equal(data.tripId, TRIP_ID);
    assert.equal(data.uid, INVITEE_UID);
    assert.equal(data.termsDocId, termsDocId);
    assert.equal(data.acceptedTermsVersion, 1);
    assert.ok(data.acceptedAt instanceof Timestamp);
  });

  it("memberIds becomes exactly the prior canonical array plus the invitee, and lastUpdatedBy is set", async () => {
    const termsDocId = await seedReadyToAcceptScenario({
      memberIds: [OWNER_UID, OTHER_MEMBER_UID],
    });
    const before = Date.now();
    await acceptTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
      acceptedTermsDocId: termsDocId,
    });
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    const trip = tripSnap.data()!;
    assert.deepEqual(trip.memberIds, [
      OWNER_UID,
      OTHER_MEMBER_UID,
      INVITEE_UID,
    ]);
    assert.equal(trip.lastUpdatedBy, INVITEE_UID);
    assert.ok(trip.lastUpdatedAt instanceof Timestamp);
    assert.ok(trip.lastUpdatedAt.toMillis() >= before);
  });

  it("no financial/ownership field changes: saved, ledgerOpeningBalanceMinor, ledgerBalanceMinor, ownership state/version unchanged", async () => {
    const termsDocId = await seedReadyToAcceptScenario({
      saved: 0,
      ledgerOpeningBalanceMinor: 0,
      ledgerBalanceMinor: 12345,
    });
    await acceptTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
      acceptedTermsDocId: termsDocId,
    });
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    const trip = tripSnap.data()!;
    assert.equal(trip.saved, 0);
    assert.equal(trip.ledgerOpeningBalanceMinor, 0);
    assert.equal(trip.ledgerBalanceMinor, 12345);
    assert.equal(trip.ownershipModelState, "initialized");
    assert.equal(trip.ownershipModelVersion, CURRENT_TRIP_OWNERSHIP_MODEL_VERSION);
  });

  it("no tripMemberOwnership row is created for the new member", async () => {
    const termsDocId = await seedReadyToAcceptScenario();
    await acceptTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
      acceptedTermsDocId: termsDocId,
    });
    const snap = await db.collection("tripMemberOwnership").get();
    assert.equal(snap.size, 0);
  });

  it("no savingsTransaction or ownership allocation is created", async () => {
    const termsDocId = await seedReadyToAcceptScenario();
    await acceptTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
      acceptedTermsDocId: termsDocId,
    });
    const txnSnap = await db.collection("savingsTransactions").get();
    assert.equal(txnSnap.size, 0);
    const allocSnap = await db.collection("tripOwnershipAllocations").get();
    assert.equal(allocSnap.size, 0);
  });
});

describe("acceptTripInvitationCore - idempotent replay", () => {
  it("an exact replay returns the same {tripId} with zero additional writes", async () => {
    const termsDocId = await seedReadyToAcceptScenario();
    const first = await acceptTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
      acceptedTermsDocId: termsDocId,
    });

    const invitationBefore = (
      await db.collection("tripInvitations").doc(INVITATION_ID).get()
    ).data()!;
    const tripBefore = (
      await db.collection("trips").doc(TRIP_ID).get()
    ).data()!;

    const second = await acceptTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
      acceptedTermsDocId: termsDocId,
    });
    assert.deepEqual(second, first);

    const invitationAfter = (
      await db.collection("tripInvitations").doc(INVITATION_ID).get()
    ).data()!;
    const tripAfter = (
      await db.collection("trips").doc(TRIP_ID).get()
    ).data()!;
    assert.ok(
      (invitationBefore.respondedAt as Timestamp).isEqual(
        invitationAfter.respondedAt as Timestamp
      ),
      "replay must not reset respondedAt"
    );
    assert.deepEqual(tripAfter.memberIds, tripBefore.memberIds);
    assert.ok(
      (tripBefore.lastUpdatedAt as Timestamp).isEqual(
        tripAfter.lastUpdatedAt as Timestamp
      ),
      "replay must not touch lastUpdatedAt again"
    );
  });

  it("replay still succeeds after a newer terms version is later published", async () => {
    const termsDocId = await seedReadyToAcceptScenario();
    await acceptTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
      acceptedTermsDocId: termsDocId,
    });

    const newTermsRef = db.collection("tripTerms").doc();
    await newTermsRef.set({
      tripId: TRIP_ID,
      version: 2,
      createdAt: Timestamp.now(),
      createdBy: OWNER_UID,
      contributionExpectations: "Updated.",
      expenseAllocationExpectations: "x",
      sharedStashSpendingAuthority: "x",
      withdrawalExpectations: "x",
      settlementExpectations: "x",
    });
    await db.collection("tripTermsCurrent").doc(TRIP_ID).set({
      tripId: TRIP_ID,
      currentVersion: 2,
      currentTermsDocId: newTermsRef.id,
      updatedAt: Timestamp.now(),
    });

    const result = await acceptTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
      acceptedTermsDocId: termsDocId,
    });
    assert.deepEqual(result, {tripId: TRIP_ID});
  });

  it("replay still succeeds after the Trip is later archived", async () => {
    const termsDocId = await seedReadyToAcceptScenario();
    await acceptTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
      acceptedTermsDocId: termsDocId,
    });
    await db.collection("trips").doc(TRIP_ID).update({
      archivedAt: Timestamp.now(),
      archivedBy: OWNER_UID,
    });

    const result = await acceptTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
      acceptedTermsDocId: termsDocId,
    });
    assert.deepEqual(result, {tripId: TRIP_ID});
  });

  it("replay still succeeds after the ownership model later becomes needs_reconciliation", async () => {
    const termsDocId = await seedReadyToAcceptScenario();
    await acceptTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
      acceptedTermsDocId: termsDocId,
    });
    await db.collection("trips").doc(TRIP_ID).update({
      ownershipModelState: "needs_reconciliation",
    });

    const result = await acceptTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
      acceptedTermsDocId: termsDocId,
    });
    assert.deepEqual(result, {tripId: TRIP_ID});
  });

  it("replay succeeds for a fully historical already-completed acceptance whose invitation expiresAt is already in the past - proving Branch A never re-checks CURRENT expiry (deterministic, no sleep/wall-clock threshold)", async () => {
    // Seeds a complete, internally-consistent "already accepted" world
    // directly (never runs Branch B at all) - both expiresAt AND
    // respondedAt are already in the past, with respondedAt earlier
    // than expiresAt (consistent with "accepted while still
    // unexpired" at the time it actually happened).
    const respondedAt = pastTimestamp(3);
    const expiresAt = pastTimestamp(2);
    await seedTrip({memberIds: [OWNER_UID, INVITEE_UID]});
    await seedInvitation({
      status: "accepted",
      expiresAt,
      respondedAt,
    });
    const termsDocId = await seedTermsAndPointer();
    const acceptanceId = tripMembershipAcceptanceId(
      TRIP_ID,
      INVITEE_UID,
      termsDocId
    );
    await db.collection("tripMembershipAcceptances").doc(acceptanceId).set({
      tripId: TRIP_ID,
      uid: INVITEE_UID,
      termsDocId,
      acceptedTermsVersion: 1,
      acceptedAt: respondedAt,
    });

    const tripBefore = (
      await db.collection("trips").doc(TRIP_ID).get()
    ).data()!;
    const invitationBefore = (
      await db.collection("tripInvitations").doc(INVITATION_ID).get()
    ).data()!;

    const result = await acceptTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
      acceptedTermsDocId: termsDocId,
    });
    assert.deepEqual(result, {tripId: TRIP_ID});

    const tripAfter = (
      await db.collection("trips").doc(TRIP_ID).get()
    ).data()!;
    const invitationAfter = (
      await db.collection("tripInvitations").doc(INVITATION_ID).get()
    ).data()!;
    assert.deepEqual(tripAfter, tripBefore);
    assert.deepEqual(invitationAfter, invitationBefore);
  });

  it("accepted invitation + missing acceptance record fails closed", async () => {
    const termsDocId = await seedReadyToAcceptScenario();
    await acceptTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
      acceptedTermsDocId: termsDocId,
    });
    const acceptanceId = tripMembershipAcceptanceId(
      TRIP_ID,
      INVITEE_UID,
      termsDocId
    );
    await db.collection("tripMembershipAcceptances").doc(acceptanceId).delete();

    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("accepted invitation + invitee missing from memberIds fails closed", async () => {
    const termsDocId = await seedReadyToAcceptScenario();
    await acceptTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
      acceptedTermsDocId: termsDocId,
    });
    await db.collection("trips").doc(TRIP_ID).update({
      memberIds: [OWNER_UID],
    });

    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("a malformed acceptance record fails closed", async () => {
    const termsDocId = await seedReadyToAcceptScenario();
    await acceptTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
      acceptedTermsDocId: termsDocId,
    });
    const acceptanceId = tripMembershipAcceptanceId(
      TRIP_ID,
      INVITEE_UID,
      termsDocId
    );
    await db.collection("tripMembershipAcceptances").doc(acceptanceId).update({
      extraUnexpectedField: "bogus",
    });

    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("an acceptance record naming the wrong uid fails closed", async () => {
    const termsDocId = await seedReadyToAcceptScenario();
    await acceptTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
      acceptedTermsDocId: termsDocId,
    });
    const acceptanceId = tripMembershipAcceptanceId(
      TRIP_ID,
      INVITEE_UID,
      termsDocId
    );
    await db.collection("tripMembershipAcceptances").doc(acceptanceId).update({
      uid: OTHER_MEMBER_UID,
    });

    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("an acceptance record naming the wrong tripId fails closed", async () => {
    const termsDocId = await seedReadyToAcceptScenario();
    await acceptTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
      acceptedTermsDocId: termsDocId,
    });
    const acceptanceId = tripMembershipAcceptanceId(
      TRIP_ID,
      INVITEE_UID,
      termsDocId
    );
    await db.collection("tripMembershipAcceptances").doc(acceptanceId).update({
      tripId: "some-other-trip",
    });

    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("an acceptance record naming the wrong termsDocId fails closed", async () => {
    const termsDocId = await seedReadyToAcceptScenario();
    await acceptTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
      acceptedTermsDocId: termsDocId,
    });
    const acceptanceId = tripMembershipAcceptanceId(
      TRIP_ID,
      INVITEE_UID,
      termsDocId
    );
    await db.collection("tripMembershipAcceptances").doc(acceptanceId).update({
      termsDocId: "some-other-terms-doc",
    });

    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("an acceptance record with an invalid acceptedTermsVersion value (negative) fails closed", async () => {
    const termsDocId = await seedReadyToAcceptScenario();
    await acceptTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
      acceptedTermsDocId: termsDocId,
    });
    const acceptanceId = tripMembershipAcceptanceId(
      TRIP_ID,
      INVITEE_UID,
      termsDocId
    );
    await db.collection("tripMembershipAcceptances").doc(acceptanceId).update({
      acceptedTermsVersion: -1,
    });

    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("an acceptance record with an invalid acceptedTermsVersion value (fractional) fails closed", async () => {
    const termsDocId = await seedReadyToAcceptScenario();
    await acceptTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
      acceptedTermsDocId: termsDocId,
    });
    const acceptanceId = tripMembershipAcceptanceId(
      TRIP_ID,
      INVITEE_UID,
      termsDocId
    );
    await db.collection("tripMembershipAcceptances").doc(acceptanceId).update({
      acceptedTermsVersion: 1.5,
    });

    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("an acceptance record with an invalid (non-Timestamp) acceptedAt fails closed", async () => {
    const termsDocId = await seedReadyToAcceptScenario();
    await acceptTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
      acceptedTermsDocId: termsDocId,
    });
    const acceptanceId = tripMembershipAcceptanceId(
      TRIP_ID,
      INVITEE_UID,
      termsDocId
    );
    await db.collection("tripMembershipAcceptances").doc(acceptanceId).update({
      acceptedAt: "2026-01-01",
    });

    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("an acceptance record missing one of its five required keys fails closed", async () => {
    const termsDocId = await seedReadyToAcceptScenario();
    await acceptTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
      acceptedTermsDocId: termsDocId,
    });
    const acceptanceId = tripMembershipAcceptanceId(
      TRIP_ID,
      INVITEE_UID,
      termsDocId
    );
    await db.collection("tripMembershipAcceptances").doc(acceptanceId).update({
      acceptedTermsVersion: FieldValue.delete(),
    });

    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("historical terms document missing fails closed", async () => {
    const termsDocId = await seedReadyToAcceptScenario();
    await acceptTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
      acceptedTermsDocId: termsDocId,
    });
    await db.collection("tripTerms").doc(termsDocId).delete();

    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });

  it("historical terms version mismatch (vs. the acceptance record) fails closed", async () => {
    const termsDocId = await seedReadyToAcceptScenario();
    await acceptTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
      acceptedTermsDocId: termsDocId,
    });
    await db.collection("tripTerms").doc(termsDocId).update({version: 99});

    await assertRejectsWithCode(
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      "failed-precondition"
    );
  });
});

describe("acceptTripInvitationCore - concurrency", () => {
  it("two simultaneous accepts for the same invitation/input resolve to the same successful result with no duplicate state", async () => {
    const termsDocId = await seedReadyToAcceptScenario();
    const [first, second] = await Promise.all([
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
    ]);
    assert.deepEqual(first, {tripId: TRIP_ID});
    assert.deepEqual(second, {tripId: TRIP_ID});

    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.deepEqual(tripSnap.data()!.memberIds, [OWNER_UID, INVITEE_UID]);

    const acceptanceSnap = await db
      .collection("tripMembershipAcceptances")
      .where("tripId", "==", TRIP_ID)
      .where("uid", "==", INVITEE_UID)
      .get();
    assert.equal(acceptanceSnap.size, 1);
  });

  it("a concurrent terms republish during acceptance resolves to EXACTLY one of two allowed outcomes - acceptance wins, or republish wins and acceptance rejects terms_changed", async () => {
    const termsDocId = await seedReadyToAcceptScenario();

    // Uses the real publishTripTermsCore for the republish race (not a
    // hand-rewritten tripTermsCurrent) - this is the actual production
    // write path, so the race is realistic, not merely simulated.
    const [acceptOutcome] = await Promise.allSettled([
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      publishTripTermsCore(db, OWNER_UID, {
        tripId: TRIP_ID,
        contributionExpectations: "Updated.",
        expenseAllocationExpectations: "x",
        sharedStashSpendingAuthority: "x",
        withdrawalExpectations: "x",
        settlementExpectations: "x",
      }),
    ]);

    const acceptanceId = tripMembershipAcceptanceId(
      TRIP_ID,
      INVITEE_UID,
      termsDocId
    );
    const acceptanceSnap = await db
      .collection("tripMembershipAcceptances")
      .doc(acceptanceId)
      .get();
    const invitationSnap = await db
      .collection("tripInvitations")
      .doc(INVITATION_ID)
      .get();
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    const memberIds = tripSnap.data()!.memberIds as string[];

    if (acceptOutcome.status === "fulfilled") {
      // Outcome A: acceptance wins.
      assert.deepEqual(acceptOutcome.value, {tripId: TRIP_ID});
      assert.equal(invitationSnap.data()!.status, "accepted");
      assert.equal(
        memberIds.filter((uid) => uid === INVITEE_UID).length,
        1
      );
      assert.equal(acceptanceSnap.exists, true);
      assert.equal(acceptanceSnap.data()!.termsDocId, termsDocId);
      // No acceptance exists for the newly published/unseen version.
      const allAcceptancesForInvitee = await db
        .collection("tripMembershipAcceptances")
        .where("tripId", "==", TRIP_ID)
        .where("uid", "==", INVITEE_UID)
        .get();
      assert.equal(allAcceptancesForInvitee.size, 1);
      assert.equal(allAcceptancesForInvitee.docs[0].id, acceptanceId);
    } else {
      // Outcome B: republish wins, acceptance retries and rejects.
      assert.ok(acceptOutcome.reason instanceof HttpsError);
      assert.equal(
        (acceptOutcome.reason as HttpsError).code,
        "failed-precondition"
      );
      assert.equal(
        (acceptOutcome.reason as HttpsError & {details?: {reason?: string}})
          .details?.reason,
        "terms_changed"
      );
      assert.equal(invitationSnap.data()!.status, "pending");
      assert.ok(!memberIds.includes(INVITEE_UID));
      assert.equal(acceptanceSnap.exists, false);
    }
  });

  it("a concurrent Trip archive during acceptance resolves to EXACTLY one of two allowed outcomes - acceptance commits fully, or archive wins and acceptance rejects with no partial membership", async () => {
    const termsDocId = await seedReadyToAcceptScenario();

    const [acceptOutcome] = await Promise.allSettled([
      acceptTripInvitationCore(db, INVITEE_UID, {
        invitationId: INVITATION_ID,
        acceptedTermsDocId: termsDocId,
      }),
      db.collection("trips").doc(TRIP_ID).update({
        archivedAt: Timestamp.now(),
        archivedBy: OWNER_UID,
      }),
    ]);

    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    const memberIds = tripSnap.data()!.memberIds as string[];
    const invitationSnap = await db
      .collection("tripInvitations")
      .doc(INVITATION_ID)
      .get();
    const acceptanceId = tripMembershipAcceptanceId(
      TRIP_ID,
      INVITEE_UID,
      termsDocId
    );
    const acceptanceSnap = await db
      .collection("tripMembershipAcceptances")
      .doc(acceptanceId)
      .get();

    if (acceptOutcome.status === "fulfilled") {
      // Outcome A: acceptance commits first (fully, never partially).
      assert.deepEqual(acceptOutcome.value, {tripId: TRIP_ID});
      assert.equal(invitationSnap.data()!.status, "accepted");
      assert.equal(
        memberIds.filter((uid) => uid === INVITEE_UID).length,
        1
      );
      assert.equal(acceptanceSnap.exists, true);
      assert.equal(acceptanceSnap.data()!.tripId, TRIP_ID);
      assert.equal(acceptanceSnap.data()!.uid, INVITEE_UID);
      // The archive write may also exist now (it is not blocked by
      // acceptance committing first) - not asserted either way.
    } else {
      // Outcome B: archive wins, acceptance rejects - no partial grant.
      assert.ok(acceptOutcome.reason instanceof HttpsError);
      assert.equal(
        (acceptOutcome.reason as HttpsError).code,
        "failed-precondition"
      );
      assert.equal(invitationSnap.data()!.status, "pending");
      assert.ok(!memberIds.includes(INVITEE_UID));
      assert.equal(acceptanceSnap.exists, false);
    }
  });
});

describe("acceptTripInvitationCore - composite ids", () => {
  it("the acceptance-id helper is deterministic for the same inputs", () => {
    const a = tripMembershipAcceptanceId(TRIP_ID, INVITEE_UID, "terms-1");
    const b = tripMembershipAcceptanceId(TRIP_ID, INVITEE_UID, "terms-1");
    assert.equal(a, b);
    assert.equal(a, `${TRIP_ID}_${INVITEE_UID}_terms-1`);
  });

  it("a delimiter violation in any component fails closed", () => {
    assert.throws(
      () => tripMembershipAcceptanceId("trip_with_underscore", INVITEE_UID, "terms-1"),
      (err: unknown) => {
        assert.ok(err instanceof HttpsError);
        assert.equal((err as HttpsError).code, "internal");
        return true;
      }
    );
  });

  it("acceptTripInvitationCore never hand-builds an alternate acceptance id - the persisted record lands exactly at the shared helper's id", async () => {
    const termsDocId = await seedReadyToAcceptScenario();
    await acceptTripInvitationCore(db, INVITEE_UID, {
      invitationId: INVITATION_ID,
      acceptedTermsDocId: termsDocId,
    });
    const expectedId = tripMembershipAcceptanceId(
      TRIP_ID,
      INVITEE_UID,
      termsDocId
    );
    const snap = await db
      .collection("tripMembershipAcceptances")
      .doc(expectedId)
      .get();
    assert.equal(snap.exists, true);
  });
});
