// Tests for publishTripTermsCore against the local Firestore emulator
// via the Admin SDK - never production, guarded below. Run via
// `npm --prefix functions test`, wrapped in
// `firebase emulators:exec --only firestore "..."`.
import assert from "node:assert/strict";
import {after, before, beforeEach, describe, it} from "node:test";
import {deleteApp, initializeApp} from "firebase-admin/app";
import type {App} from "firebase-admin/app";
import {getFirestore} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";
import {
  publishTripTermsCore,
  requireAuthenticatedUid,
} from "../src/callables/publishTripTerms";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "FIRESTORE_EMULATOR_HOST is not set. Run these tests via " +
      '`firebase emulators:exec --only firestore "npm --prefix functions test"` ' +
      "so the Admin SDK talks to the local emulator, never production."
  );
}

const OWNER_UID = "owner-uid";
const OTHER_UID = "other-uid";
const TRIP_ID = "canada-trip";

let app: App;
let db: Firestore;

before(() => {
  // A distinct "demo-" project id from every other Functions test file's
  // own test app - see createBucketCore.ts's comment for why this
  // matters (Node's test runner executes test files concurrently).
  app = initializeApp({
    projectId: "demo-squadstash-functions-test-publish-trip-terms",
  });
  db = getFirestore(app);
});

after(async () => {
  await deleteApp(app);
});

async function clearFirestore(): Promise<void> {
  for (const name of ["trips", "tripTerms", "tripTermsCurrent"]) {
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

function baseRequest(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    tripId: TRIP_ID,
    contributionExpectations: "Each member contributes $200 by June 1.",
    expenseAllocationExpectations: "Shared expenses split evenly.",
    sharedStashSpendingAuthority: "Any member may record a Shared Stash expense.",
    withdrawalExpectations: "Uncommitted funds may be withdrawn at any time.",
    settlementExpectations: "Debts settle within 7 days of trip end.",
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

describe("publishTripTermsCore - input validation", () => {
  beforeEach(async () => {
    await seedTrip(TRIP_ID);
  });

  it("missing tripId is rejected", async () => {
    await assertRejectsWithCode(
      publishTripTermsCore(db, OWNER_UID, baseRequest({tripId: undefined})),
      "invalid-argument"
    );
  });

  it("missing contributionExpectations is rejected", async () => {
    await assertRejectsWithCode(
      publishTripTermsCore(
        db,
        OWNER_UID,
        baseRequest({contributionExpectations: undefined})
      ),
      "invalid-argument"
    );
  });

  it("whitespace-only withdrawalExpectations is rejected", async () => {
    await assertRejectsWithCode(
      publishTripTermsCore(db, OWNER_UID, baseRequest({withdrawalExpectations: "   "})),
      "invalid-argument"
    );
  });

  it("a field exceeding the max length is rejected", async () => {
    await assertRejectsWithCode(
      publishTripTermsCore(
        db,
        OWNER_UID,
        baseRequest({settlementExpectations: "x".repeat(2001)})
      ),
      "invalid-argument"
    );
  });

  it("a field at exactly the max length is accepted", async () => {
    await assert.doesNotReject(
      publishTripTermsCore(
        db,
        OWNER_UID,
        baseRequest({settlementExpectations: "x".repeat(2000)})
      )
    );
  });
});

describe("publishTripTermsCore - authorization", () => {
  it("rejects a tripId with no Trip document", async () => {
    await assertRejectsWithCode(
      publishTripTermsCore(db, OWNER_UID, baseRequest()),
      "not-found"
    );
  });

  it("a non-owner member cannot publish terms", async () => {
    await seedTrip(TRIP_ID, {memberIds: [OWNER_UID, OTHER_UID]});
    await assertRejectsWithCode(
      publishTripTermsCore(db, OTHER_UID, baseRequest()),
      "permission-denied"
    );
  });

  it("an outsider cannot publish terms", async () => {
    await seedTrip(TRIP_ID);
    await assertRejectsWithCode(
      publishTripTermsCore(db, OTHER_UID, baseRequest()),
      "permission-denied"
    );
  });

  it("rejects an archived Trip", async () => {
    await seedTrip(TRIP_ID, {archivedAt: new Date(), archivedBy: OWNER_UID});
    await assertRejectsWithCode(
      publishTripTermsCore(db, OWNER_UID, baseRequest()),
      "failed-precondition"
    );
  });

  it("a legacy Trip with no archivedAt key at all still accepts a new terms version", async () => {
    await seedTrip(TRIP_ID);
    await assert.doesNotReject(publishTripTermsCore(db, OWNER_UID, baseRequest()));
  });
});

describe("publishTripTermsCore - versioning and the current-terms pointer", () => {
  beforeEach(async () => {
    await seedTrip(TRIP_ID);
  });

  it("the first published version is 1", async () => {
    const result = await publishTripTermsCore(db, OWNER_UID, baseRequest());
    assert.equal(result.version, 1);
  });

  it("a second publish for the same Trip is version 2, never reusing version 1", async () => {
    await publishTripTermsCore(db, OWNER_UID, baseRequest());
    const second = await publishTripTermsCore(db, OWNER_UID, baseRequest());
    assert.equal(second.version, 2);
  });

  it("three sequential publishes produce 1, 2, 3 with no gaps or repeats", async () => {
    const first = await publishTripTermsCore(db, OWNER_UID, baseRequest());
    const second = await publishTripTermsCore(db, OWNER_UID, baseRequest());
    const third = await publishTripTermsCore(db, OWNER_UID, baseRequest());
    assert.deepEqual(
      [first.version, second.version, third.version],
      [1, 2, 3]
    );
  });

  it("the pointer document always names the newest version after sequential publishes", async () => {
    await publishTripTermsCore(db, OWNER_UID, baseRequest());
    const second = await publishTripTermsCore(db, OWNER_UID, baseRequest());
    const pointerSnap = await db.collection("tripTermsCurrent").doc(TRIP_ID).get();
    const pointer = pointerSnap.data()!;
    assert.equal(pointer.currentVersion, 2);
    assert.equal(pointer.currentTermsDocId, second.termsDocId);
  });

  it("concurrent publishes for the same Trip never both produce version 1 (the Firestore counter pattern)", async () => {
    const [first, second] = await Promise.all([
      publishTripTermsCore(db, OWNER_UID, baseRequest()),
      publishTripTermsCore(db, OWNER_UID, baseRequest()),
    ]);
    const versions = [first.version, second.version].sort();
    assert.deepEqual(versions, [1, 2]);

    const pointerSnap = await db.collection("tripTermsCurrent").doc(TRIP_ID).get();
    const pointer = pointerSnap.data()!;
    assert.equal(pointer.currentVersion, 2);
    const winner = first.version === 2 ? first : second;
    assert.equal(pointer.currentTermsDocId, winner.termsDocId);
  });

  it("each version is a distinct document, never overwriting a previous one", async () => {
    const first = await publishTripTermsCore(db, OWNER_UID, baseRequest());
    const second = await publishTripTermsCore(db, OWNER_UID, baseRequest());
    assert.notEqual(first.termsDocId, second.termsDocId);
    const firstSnap = await db.collection("tripTerms").doc(first.termsDocId).get();
    assert.equal(firstSnap.exists, true);
    assert.equal(firstSnap.data()!.version, 1);
  });

  it("publishing for a different Trip starts its own independent version sequence at 1", async () => {
    const otherTripId = "other-trip";
    await seedTrip(otherTripId);
    await publishTripTermsCore(db, OWNER_UID, baseRequest());
    const otherFirst = await publishTripTermsCore(
      db,
      OWNER_UID,
      baseRequest({tripId: otherTripId})
    );
    assert.equal(otherFirst.version, 1);
  });
});

// Checkpoint 5A.2: an EXISTING tripTermsCurrent/{tripId} pointer is
// trusted authoritative state - a malformed one must never be silently
// treated as "this Trip has never had terms" (which would invent a
// false version 1, risking collision with a real published version 1).
describe("publishTripTermsCore - fails closed on corrupt pointer state", () => {
  beforeEach(async () => {
    await seedTrip(TRIP_ID);
  });

  async function seedValidTermsDoc(
    version: number,
    overrides: Record<string, unknown> = {}
  ): Promise<string> {
    const ref = db.collection("tripTerms").doc();
    await ref.set({
      tripId: TRIP_ID,
      version,
      createdAt: new Date(),
      createdBy: OWNER_UID,
      contributionExpectations: "x",
      expenseAllocationExpectations: "x",
      sharedStashSpendingAuthority: "x",
      withdrawalExpectations: "x",
      settlementExpectations: "x",
      ...overrides,
    });
    return ref.id;
  }

  async function seedPointer(overrides: Record<string, unknown>): Promise<void> {
    const merged: Record<string, unknown> = {
      tripId: TRIP_ID,
      currentVersion: 1,
      currentTermsDocId: "placeholder",
      updatedAt: new Date(),
      ...overrides,
    };
    // Firestore's Admin SDK rejects an explicit `undefined` field value
    // outright - simulating a genuinely MISSING field means omitting the
    // key entirely, never passing `undefined` through to .set().
    for (const key of Object.keys(merged)) {
      if (merged[key] === undefined) {
        delete merged[key];
      }
    }
    await db.collection("tripTermsCurrent").doc(TRIP_ID).set(merged);
  }

  it("1. pointer with missing currentVersion is rejected", async () => {
    const termsId = await seedValidTermsDoc(1);
    await seedPointer({currentTermsDocId: termsId, currentVersion: undefined});
    await assertRejectsWithCode(
      publishTripTermsCore(db, OWNER_UID, baseRequest()),
      "failed-precondition"
    );
  });

  it("2. pointer with a fractional currentVersion is rejected", async () => {
    const termsId = await seedValidTermsDoc(1);
    await seedPointer({currentTermsDocId: termsId, currentVersion: 1.5});
    await assertRejectsWithCode(
      publishTripTermsCore(db, OWNER_UID, baseRequest()),
      "failed-precondition"
    );
  });

  it("3a. pointer with a zero currentVersion is rejected", async () => {
    const termsId = await seedValidTermsDoc(1);
    await seedPointer({currentTermsDocId: termsId, currentVersion: 0});
    await assertRejectsWithCode(
      publishTripTermsCore(db, OWNER_UID, baseRequest()),
      "failed-precondition"
    );
  });

  it("3b. pointer with a negative currentVersion is rejected", async () => {
    const termsId = await seedValidTermsDoc(1);
    await seedPointer({currentTermsDocId: termsId, currentVersion: -1});
    await assertRejectsWithCode(
      publishTripTermsCore(db, OWNER_UID, baseRequest()),
      "failed-precondition"
    );
  });

  it("4. pointer with an unsafe-integer currentVersion is rejected", async () => {
    const termsId = await seedValidTermsDoc(1);
    await seedPointer({
      currentTermsDocId: termsId,
      currentVersion: Number.MAX_SAFE_INTEGER + 2,
    });
    await assertRejectsWithCode(
      publishTripTermsCore(db, OWNER_UID, baseRequest()),
      "failed-precondition"
    );
  });

  it("5. pointer with the wrong tripId is rejected", async () => {
    const termsId = await seedValidTermsDoc(1);
    await seedPointer({tripId: "some-other-trip", currentTermsDocId: termsId});
    await assertRejectsWithCode(
      publishTripTermsCore(db, OWNER_UID, baseRequest()),
      "failed-precondition"
    );
  });

  it("6a. pointer with a missing currentTermsDocId is rejected", async () => {
    await seedPointer({currentTermsDocId: undefined});
    await assertRejectsWithCode(
      publishTripTermsCore(db, OWNER_UID, baseRequest()),
      "failed-precondition"
    );
  });

  it("6b. pointer with an empty-string currentTermsDocId is rejected", async () => {
    await seedPointer({currentTermsDocId: ""});
    await assertRejectsWithCode(
      publishTripTermsCore(db, OWNER_UID, baseRequest()),
      "failed-precondition"
    );
  });

  it("7. pointer referencing a tripTerms document that does not exist is rejected", async () => {
    await seedPointer({currentTermsDocId: "no-such-terms-doc", currentVersion: 1});
    await assertRejectsWithCode(
      publishTripTermsCore(db, OWNER_UID, baseRequest()),
      "failed-precondition"
    );
  });

  it("8. pointer referencing a TripTerms document belonging to another Trip is rejected", async () => {
    const otherTripId = "other-trip";
    await seedTrip(otherTripId);
    const foreignTermsId = await seedValidTermsDoc(1, {tripId: otherTripId});
    await seedPointer({currentTermsDocId: foreignTermsId, currentVersion: 1});
    await assertRejectsWithCode(
      publishTripTermsCore(db, OWNER_UID, baseRequest()),
      "failed-precondition"
    );
  });

  it("9. pointer version disagreeing with its referenced TripTerms document's own version is rejected", async () => {
    const termsId = await seedValidTermsDoc(1);
    await seedPointer({currentTermsDocId: termsId, currentVersion: 2});
    await assertRejectsWithCode(
      publishTripTermsCore(db, OWNER_UID, baseRequest()),
      "failed-precondition"
    );
  });

  it("10. a MAX_SAFE_INTEGER currentVersion cannot overflow into a new version", async () => {
    const termsId = await seedValidTermsDoc(Number.MAX_SAFE_INTEGER);
    await seedPointer({
      currentTermsDocId: termsId,
      currentVersion: Number.MAX_SAFE_INTEGER,
    });
    await assertRejectsWithCode(
      publishTripTermsCore(db, OWNER_UID, baseRequest()),
      "failed-precondition"
    );
  });

  it("11. a rejected publish leaves the existing pointer completely unchanged", async () => {
    const termsId = await seedValidTermsDoc(1);
    await seedPointer({currentTermsDocId: termsId, currentVersion: -1});
    const before = (await db.collection("tripTermsCurrent").doc(TRIP_ID).get()).data();

    await assertRejectsWithCode(
      publishTripTermsCore(db, OWNER_UID, baseRequest()),
      "failed-precondition"
    );

    const after = (await db.collection("tripTermsCurrent").doc(TRIP_ID).get()).data();
    assert.deepEqual(after, before);
  });

  it("12. a rejected publish creates no new tripTerms document", async () => {
    const termsId = await seedValidTermsDoc(1);
    await seedPointer({currentTermsDocId: termsId, currentVersion: -1});

    const beforeSnap = await db.collection("tripTerms").get();
    const beforeIds = beforeSnap.docs.map((d) => d.id).sort();

    await assertRejectsWithCode(
      publishTripTermsCore(db, OWNER_UID, baseRequest()),
      "failed-precondition"
    );

    const afterSnap = await db.collection("tripTerms").get();
    const afterIds = afterSnap.docs.map((d) => d.id).sort();
    assert.deepEqual(afterIds, beforeIds);
  });

  it("a genuinely valid existing pointer still allows publishing the next version normally", async () => {
    const termsId = await seedValidTermsDoc(1);
    await seedPointer({currentTermsDocId: termsId, currentVersion: 1});
    const result = await publishTripTermsCore(db, OWNER_UID, baseRequest());
    assert.equal(result.version, 2);
  });
});

describe("publishTripTermsCore - persisted document shape", () => {
  beforeEach(async () => {
    await seedTrip(TRIP_ID);
  });

  it("writes the expected fields on the new TripTerms document", async () => {
    const before = Date.now();
    const result = await publishTripTermsCore(db, OWNER_UID, baseRequest());
    const snap = await db.collection("tripTerms").doc(result.termsDocId).get();
    const data = snap.data()!;
    assert.equal(data.tripId, TRIP_ID);
    assert.equal(data.version, 1);
    assert.equal(data.createdBy, OWNER_UID);
    assert.ok(data.createdAt.toMillis() >= before);
    assert.equal(
      data.contributionExpectations,
      "Each member contributes $200 by June 1."
    );
  });

  it("never mutates the Trip document's own memberIds or ownerId", async () => {
    await publishTripTermsCore(db, OWNER_UID, baseRequest());
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.deepEqual(tripSnap.data()!.memberIds, [OWNER_UID]);
    assert.equal(tripSnap.data()!.ownerId, OWNER_UID);
  });
});
