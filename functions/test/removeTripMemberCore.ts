// Tests for removeTripMemberCore against the local Firestore emulator
// via the Admin SDK - never production, guarded below. Run via
// `npm --prefix functions test`, wrapped in
// `firebase emulators:exec --only firestore "..."` so
// FIRESTORE_EMULATOR_HOST is set automatically.
//
// Checkpoint 6.7B1: covers remove-specific authorization/replay
// semantics, plus a representative subset of the financial-gate matrix
// (the FULL matrix already lives in leaveTripCore.ts's own test file,
// against the IDENTICAL shared transaction core - see
// tripMembershipDepartureCore.ts - so it is not duplicated here in
// full, per this checkpoint's own "avoid redundant test explosion"
// instruction).
import assert from "node:assert/strict";
import {after, before, beforeEach, describe, it} from "node:test";
import {deleteApp, initializeApp} from "firebase-admin/app";
import type {App} from "firebase-admin/app";
import {getFirestore} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {
  removeTripMemberCore,
  requireAuthenticatedUid,
} from "../src/callables/removeTripMember";
import {CURRENT_TRIP_OWNERSHIP_MODEL_VERSION} from "../src/domain/tripOwnershipModel";
import {CURRENT_TRIP_EXPENSE_BALANCE_MODEL_VERSION} from "../src/domain/tripExpenseBalanceModel";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "FIRESTORE_EMULATOR_HOST is not set. Run these tests via " +
      '`firebase emulators:exec --only firestore "npm --prefix functions test"` ' +
      "so the Admin SDK talks to the local emulator, never production."
  );
}

const OWNER_UID = "owner-uid";
const MEMBER_UID = "member-uid";
const OTHER_MEMBER_UID = "other-member-uid";
const OUTSIDER_UID = "outsider-uid";
const TRIP_ID = "test-trip";

let app: App;
let db: Firestore;

before(() => {
  app = initializeApp({
    projectId: "demo-squadstash-functions-test-remove-trip-member",
  });
  db = getFirestore(app);
});

after(async () => {
  await deleteApp(app);
});

async function clearFirestore(): Promise<void> {
  for (const name of [
    "trips",
    "tripMemberOwnership",
    "tripExpenseBalances",
    "tripMembershipDepartures",
  ]) {
    const snap = await db.collection(name).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

beforeEach(async () => {
  await clearFirestore();
});

function balanceId(tripId: string, uid: string): string {
  return `${tripId}_${uid}`;
}
function departureId(tripId: string, uid: string): string {
  return `${tripId}_${uid}`;
}

function readyTripOverrides(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ledgerOpeningBalanceMinor: 0,
    ledgerBalanceMinor: 0,
    currency: "USD",
    ownershipModelState: "initialized",
    ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
    expenseBalanceModelState: "initialized",
    expenseBalanceModelVersion: CURRENT_TRIP_EXPENSE_BALANCE_MODEL_VERSION,
    ...overrides,
  };
}

function seedTrip(
  overrides: Record<string, unknown> = {}
): Promise<FirebaseFirestore.WriteResult> {
  const data: Record<string, unknown> = {
    ownerId: OWNER_UID,
    memberIds: [OWNER_UID, MEMBER_UID, OTHER_MEMBER_UID],
    title: "Test Trip",
    target: 1000,
    saved: 0,
    imageUrl: "https://example.com/trip.jpg",
    tripStartDate: "2027-06-12",
    ...overrides,
  };
  for (const key of Object.keys(data)) {
    if (data[key] === undefined) {
      delete data[key];
    }
  }
  return db.collection("trips").doc(TRIP_ID).set(data);
}

function seedExpenseBalance(
  uid: string,
  netBalanceMinor: number,
  overrides: Record<string, unknown> = {}
): Promise<FirebaseFirestore.WriteResult> {
  return db
    .collection("tripExpenseBalances")
    .doc(balanceId(TRIP_ID, uid))
    .set({
      tripId: TRIP_ID,
      uid,
      netBalanceMinor,
      updatedAt: new Date(),
      ...overrides,
    });
}

async function getTripMemberIds(): Promise<string[] | undefined> {
  const snap = await db.collection("trips").doc(TRIP_ID).get();
  return snap.data()?.memberIds;
}

async function getDeparture(
  uid: string
): Promise<FirebaseFirestore.DocumentData | undefined> {
  const snap = await db
    .collection("tripMembershipDepartures")
    .doc(departureId(TRIP_ID, uid))
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

describe("removeTripMemberCore - authorization", () => {
  it("the owner removes an eligible non-owner", async () => {
    await seedTrip(readyTripOverrides());
    const result = await removeTripMemberCore(db, OWNER_UID, {
      tripId: TRIP_ID,
      targetUid: MEMBER_UID,
    });
    assert.deepEqual(result, {
      tripId: TRIP_ID,
      uid: MEMBER_UID,
      departureType: "removed",
    });
    assert.deepEqual(await getTripMemberIds(), [OWNER_UID, OTHER_MEMBER_UID]);
    const departure = await getDeparture(MEMBER_UID);
    assert.equal(departure?.departureType, "removed");
    assert.equal(departure?.departedByUid, OWNER_UID);
  });

  it("an ordinary member cannot remove another member", async () => {
    await seedTrip(readyTripOverrides());
    await assertRejectsWithCode(
      removeTripMemberCore(db, OTHER_MEMBER_UID, {
        tripId: TRIP_ID,
        targetUid: MEMBER_UID,
      }),
      "permission-denied"
    );
    assert.deepEqual(await getTripMemberIds(), [
      OWNER_UID,
      MEMBER_UID,
      OTHER_MEMBER_UID,
    ]);
  });

  it("an outsider cannot remove a member", async () => {
    await seedTrip(readyTripOverrides());
    await assertRejectsWithCode(
      removeTripMemberCore(db, OUTSIDER_UID, {
        tripId: TRIP_ID,
        targetUid: MEMBER_UID,
      }),
      "permission-denied"
    );
  });

  it("the owner cannot remove self", async () => {
    await seedTrip(readyTripOverrides());
    await assertRejectsWithCode(
      removeTripMemberCore(db, OWNER_UID, {
        tripId: TRIP_ID,
        targetUid: OWNER_UID,
      }),
      "failed-precondition"
    );
  });

  it("the owner cannot remove the owner target (identical to self-removal, defense in depth)", async () => {
    await seedTrip(readyTripOverrides());
    await assertRejectsWithCode(
      removeTripMemberCore(db, OWNER_UID, {
        tripId: TRIP_ID,
        targetUid: OWNER_UID,
      }),
      "failed-precondition"
    );
  });

  it("target already absent (not a current member) is a safe failure", async () => {
    await seedTrip(readyTripOverrides());
    await assertRejectsWithCode(
      removeTripMemberCore(db, OWNER_UID, {
        tripId: TRIP_ID,
        targetUid: OUTSIDER_UID,
      }),
      "failed-precondition"
    );
  });

  it("unrelated members (including the remover) are preserved exactly", async () => {
    await seedTrip(readyTripOverrides());
    await removeTripMemberCore(db, OWNER_UID, {
      tripId: TRIP_ID,
      targetUid: MEMBER_UID,
    });
    assert.deepEqual(await getTripMemberIds(), [OWNER_UID, OTHER_MEMBER_UID]);
  });

  it("an archived Trip removal succeeds when eligible", async () => {
    await seedTrip(
      readyTripOverrides({archivedAt: new Date(), archivedBy: OWNER_UID})
    );
    const result = await removeTripMemberCore(db, OWNER_UID, {
      tripId: TRIP_ID,
      targetUid: MEMBER_UID,
    });
    assert.equal(result.departureType, "removed");
  });
});

describe("removeTripMemberCore - replay", () => {
  it("a matching prior remove event exact-replays success", async () => {
    await seedTrip(readyTripOverrides());
    const first = await removeTripMemberCore(db, OWNER_UID, {
      tripId: TRIP_ID,
      targetUid: MEMBER_UID,
    });
    const replay = await removeTripMemberCore(db, OWNER_UID, {
      tripId: TRIP_ID,
      targetUid: MEMBER_UID,
    });
    assert.deepEqual(replay, first);
  });

  it("a prior VOLUNTARY-LEAVE event is NOT a valid remove replay - the owner's remove attempt fails as an ordinary not-current-member case", async () => {
    await seedTrip(readyTripOverrides());
    // Simulate a prior LEAVE (not a removal) exactly as leaveTripCore
    // itself would have left it.
    await db.collection("trips").doc(TRIP_ID).update({
      memberIds: [OWNER_UID, OTHER_MEMBER_UID],
    });
    await db
      .collection("tripMembershipDepartures")
      .doc(departureId(TRIP_ID, MEMBER_UID))
      .set({
        tripId: TRIP_ID,
        uid: MEMBER_UID,
        departureType: "left",
        departedByUid: MEMBER_UID,
        departedAt: new Date(),
        tripTitleSnapshot: "Test Trip",
      });

    await assertRejectsWithCode(
      removeTripMemberCore(db, OWNER_UID, {
        tripId: TRIP_ID,
        targetUid: MEMBER_UID,
      }),
      "failed-precondition"
    );
  });
});

describe("removeTripMemberCore - representative financial gate (shared core already exhaustively tested via leaveTripCore)", () => {
  it("a nonzero target social balance blocks removal - the owner can never seize or redistribute a departing member's position by removing them", async () => {
    await seedTrip(readyTripOverrides());
    await seedExpenseBalance(MEMBER_UID, 500);
    await seedExpenseBalance(OWNER_UID, -500);
    await assertRejectsWithCode(
      removeTripMemberCore(db, OWNER_UID, {
        tripId: TRIP_ID,
        targetUid: MEMBER_UID,
      }),
      "failed-precondition"
    );
    assert.deepEqual(await getTripMemberIds(), [
      OWNER_UID,
      MEMBER_UID,
      OTHER_MEMBER_UID,
    ]);
  });

  it("a zero target social balance allows removal", async () => {
    await seedTrip(readyTripOverrides());
    await seedExpenseBalance(MEMBER_UID, 0);
    const result = await removeTripMemberCore(db, OWNER_UID, {
      tripId: TRIP_ID,
      targetUid: MEMBER_UID,
    });
    assert.equal(result.departureType, "removed");
  });
});

describe("removeTripMemberCore - production auth boundary", () => {
  it("requireAuthenticatedUid rejects an absent auth context", () => {
    assert.throws(
      () => requireAuthenticatedUid(undefined),
      (err: unknown) => err instanceof HttpsError && err.code === "unauthenticated"
    );
  });
});

describe("removeTripMemberCore - input validation", () => {
  it("rejects an unexpected field", async () => {
    await seedTrip(readyTripOverrides());
    await assertRejectsWithCode(
      removeTripMemberCore(db, OWNER_UID, {
        tripId: TRIP_ID,
        targetUid: MEMBER_UID,
        departedByUid: OWNER_UID,
      }),
      "invalid-argument"
    );
  });

  it("rejects a missing/malformed targetUid", async () => {
    await seedTrip(readyTripOverrides());
    await assertRejectsWithCode(
      removeTripMemberCore(db, OWNER_UID, {tripId: TRIP_ID}),
      "invalid-argument"
    );
    await assertRejectsWithCode(
      removeTripMemberCore(db, OWNER_UID, {
        tripId: TRIP_ID,
        targetUid: "",
      }),
      "invalid-argument"
    );
  });
});
