// Tests for leaveTripCore against the local Firestore emulator via the
// Admin SDK - never production, guarded below. Run via
// `npm --prefix functions test`, wrapped in
// `firebase emulators:exec --only firestore "..."` so
// FIRESTORE_EMULATOR_HOST is set automatically.
//
// Checkpoint 6.7B1 first-pass coverage. The full financial-gate matrix
// lives here (leaveTripCore is the simpler of the two public callables
// to drive directly, and both delegate to the IDENTICAL shared
// transaction core - see tripMembershipDepartureCore.ts); removeTripMemberCore.ts's
// own test file covers remove-specific authorization/replay semantics
// plus a representative subset of the same financial gates, rather
// than duplicating this entire matrix a second time.
import assert from "node:assert/strict";
import {after, before, beforeEach, describe, it} from "node:test";
import {deleteApp, initializeApp} from "firebase-admin/app";
import type {App} from "firebase-admin/app";
import {getFirestore} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {leaveTripCore, requireAuthenticatedUid} from "../src/callables/leaveTrip";
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
    projectId: "demo-squadstash-functions-test-leave-trip",
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

function ownershipId(tripId: string, uid: string): string {
  return `${tripId}_${uid}`;
}
function balanceId(tripId: string, uid: string): string {
  return `${tripId}_${uid}`;
}
function departureId(tripId: string, uid: string): string {
  return `${tripId}_${uid}`;
}

// A fully financially-ready Trip - both model states initialized at
// their current version, a valid trusted ledger, no history (zero
// everywhere, nothing to reconcile). Individual tests layer ownership/
// expense-balance rows and ledger values on top via overrides.
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
  // An override value of `undefined` means "omit this key entirely"
  // (e.g. to simulate a legacy Trip's absent ownershipModelState) -
  // Firestore's own `.set()` throws on a literal `undefined` field
  // value, so every such key is deleted before writing.
  for (const key of Object.keys(data)) {
    if (data[key] === undefined) {
      delete data[key];
    }
  }
  return db.collection("trips").doc(TRIP_ID).set(data);
}

function seedOwnership(
  uid: string,
  ownershipMinor: number,
  overrides: Record<string, unknown> = {}
): Promise<FirebaseFirestore.WriteResult> {
  return db
    .collection("tripMemberOwnership")
    .doc(ownershipId(TRIP_ID, uid))
    .set({
      tripId: TRIP_ID,
      uid,
      ownershipMinor,
      lastUpdatedAt: new Date(),
      ...overrides,
    });
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

describe("leaveTripCore - authorization", () => {
  it("an eligible non-owner leaves successfully", async () => {
    await seedTrip(readyTripOverrides());
    const result = await leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID});
    assert.deepEqual(result, {
      tripId: TRIP_ID,
      uid: MEMBER_UID,
      departureType: "left",
    });
    const memberIds = await getTripMemberIds();
    assert.deepEqual(memberIds, [OWNER_UID, OTHER_MEMBER_UID]);
    const departure = await getDeparture(MEMBER_UID);
    assert.equal(departure?.departureType, "left");
    assert.equal(departure?.departedByUid, MEMBER_UID);
    assert.equal(departure?.tripId, TRIP_ID);
    assert.equal(departure?.uid, MEMBER_UID);
  });

  it("the owner cannot leave", async () => {
    await seedTrip(readyTripOverrides());
    await assertRejectsWithCode(
      leaveTripCore(db, OWNER_UID, {tripId: TRIP_ID}),
      "failed-precondition"
    );
    assert.deepEqual(await getTripMemberIds(), [
      OWNER_UID,
      MEMBER_UID,
      OTHER_MEMBER_UID,
    ]);
  });

  it("an outsider/non-member cannot leave", async () => {
    await seedTrip(readyTripOverrides());
    await assertRejectsWithCode(
      leaveTripCore(db, OUTSIDER_UID, {tripId: TRIP_ID}),
      "permission-denied"
    );
  });

  it("a totally non-array memberIds blocks departure (via the lenient membership check itself, since a non-array can never confirm a non-owner's membership)", async () => {
    await seedTrip(readyTripOverrides({memberIds: "not-a-list"}));
    await assertRejectsWithCode(
      leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID}),
      "permission-denied"
    );
  });

  it("duplicate memberIds blocks departure", async () => {
    await seedTrip(
      readyTripOverrides({
        memberIds: [OWNER_UID, MEMBER_UID, MEMBER_UID],
      })
    );
    await assertRejectsWithCode(
      leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID}),
      "failed-precondition"
    );
  });

  it("missing owner in memberIds blocks departure", async () => {
    await seedTrip(
      readyTripOverrides({memberIds: [MEMBER_UID, OTHER_MEMBER_UID]})
    );
    await assertRejectsWithCode(
      leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID}),
      "failed-precondition"
    );
  });

  it("an archived Trip leave succeeds when financially eligible", async () => {
    await seedTrip(
      readyTripOverrides({archivedAt: new Date(), archivedBy: OWNER_UID})
    );
    const result = await leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID});
    assert.equal(result.departureType, "left");
  });
});

describe("leaveTripCore - replay", () => {
  it("replaying an already-committed leave returns the identical exact-replay success, memberIds unchanged by the replay itself", async () => {
    await seedTrip(readyTripOverrides());
    const first = await leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID});
    const replay = await leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID});
    assert.deepEqual(replay, first);
    assert.deepEqual(await getTripMemberIds(), [OWNER_UID, OTHER_MEMBER_UID]);
  });

  it("a member who was removed (not their own leave) cannot be exact-replayed as a leave - and ordinary re-attempt is rejected, since they are no longer a member", async () => {
    await seedTrip(readyTripOverrides());
    // Simulate a prior REMOVAL (not a leave) by directly seeding the
    // departure event + post-removal membership, exactly as
    // removeTripMemberCore itself would have left it.
    await db.collection("trips").doc(TRIP_ID).update({
      memberIds: [OWNER_UID, OTHER_MEMBER_UID],
    });
    await db
      .collection("tripMembershipDepartures")
      .doc(departureId(TRIP_ID, MEMBER_UID))
      .set({
        tripId: TRIP_ID,
        uid: MEMBER_UID,
        departureType: "removed",
        departedByUid: OWNER_UID,
        departedAt: new Date(),
        tripTitleSnapshot: "Test Trip",
      });

    await assertRejectsWithCode(
      leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID}),
      "permission-denied"
    );
  });
});

describe("leaveTripCore - financial gates: Shared Stash ownership", () => {
  it("positive target ownership blocks departure", async () => {
    await seedTrip(readyTripOverrides({ledgerBalanceMinor: 100}));
    await seedOwnership(MEMBER_UID, 100);
    await assertRejectsWithCode(
      leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID}),
      "failed-precondition"
    );
    assert.deepEqual(await getTripMemberIds(), [
      OWNER_UID,
      MEMBER_UID,
      OTHER_MEMBER_UID,
    ]);
  });

  it("zero target ownership (explicit row) passes", async () => {
    await seedTrip(readyTripOverrides({ledgerBalanceMinor: 50}));
    await seedOwnership(OWNER_UID, 50);
    await seedOwnership(MEMBER_UID, 0);
    const result = await leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID});
    assert.equal(result.departureType, "left");
  });

  it("absent target ownership row + full set reconciling passes", async () => {
    await seedTrip(readyTripOverrides({ledgerBalanceMinor: 50}));
    await seedOwnership(OWNER_UID, 50);
    // MEMBER_UID has no ownership row at all.
    const result = await leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID});
    assert.equal(result.departureType, "left");
  });

  it("absent target ownership row + full set NOT reconciling blocks - drift could hide a stolen zero", async () => {
    await seedTrip(readyTripOverrides({ledgerBalanceMinor: 100}));
    await seedOwnership(OWNER_UID, 50); // sums to 50, ledger says 100
    await assertRejectsWithCode(
      leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID}),
      "failed-precondition"
    );
  });

  it("a malformed ownership row blocks departure", async () => {
    await seedTrip(readyTripOverrides({ledgerBalanceMinor: 50}));
    await seedOwnership(OWNER_UID, 50, {ownershipMinor: -5});
    await assertRejectsWithCode(
      leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID}),
      "failed-precondition"
    );
  });

  it("ownership model \"legacy\" blocks departure", async () => {
    await seedTrip(
      readyTripOverrides({
        ownershipModelState: undefined,
        ownershipModelVersion: undefined,
      })
    );
    await assertRejectsWithCode(
      leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID}),
      "failed-precondition"
    );
  });

  it("ownership model \"migrating\" blocks departure", async () => {
    await seedTrip(
      readyTripOverrides({
        ownershipModelState: "migrating",
        ownershipModelVersion: undefined,
      })
    );
    await assertRejectsWithCode(
      leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID}),
      "failed-precondition"
    );
  });

  it("ownership model \"needs_reconciliation\" blocks departure", async () => {
    await seedTrip(
      readyTripOverrides({ownershipModelState: "needs_reconciliation"})
    );
    await assertRejectsWithCode(
      leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID}),
      "failed-precondition"
    );
  });

  it("an unsupported ownership model version fails closed", async () => {
    await seedTrip(readyTripOverrides({ownershipModelVersion: 999}));
    await assertRejectsWithCode(
      leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID}),
      "failed-precondition"
    );
  });

  it("an unknown ownership model state fails closed", async () => {
    await seedTrip(
      readyTripOverrides({
        ownershipModelState: "bogus",
        ownershipModelVersion: undefined,
      })
    );
    await assertRejectsWithCode(
      leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID}),
      "failed-precondition"
    );
  });
});

describe("leaveTripCore - financial gates: social expense balance", () => {
  it("positive target balance blocks departure", async () => {
    await seedTrip(readyTripOverrides());
    await seedExpenseBalance(MEMBER_UID, 500);
    await seedExpenseBalance(OWNER_UID, -500);
    await assertRejectsWithCode(
      leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID}),
      "failed-precondition"
    );
  });

  it("negative target balance blocks departure", async () => {
    await seedTrip(readyTripOverrides());
    await seedExpenseBalance(MEMBER_UID, -500);
    await seedExpenseBalance(OWNER_UID, 500);
    await assertRejectsWithCode(
      leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID}),
      "failed-precondition"
    );
  });

  it("zero target balance (explicit row) passes", async () => {
    await seedTrip(readyTripOverrides());
    await seedExpenseBalance(MEMBER_UID, 0);
    const result = await leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID});
    assert.equal(result.departureType, "left");
  });

  it("absent target balance row + valid zero-sum aggregate passes", async () => {
    await seedTrip(readyTripOverrides());
    await seedExpenseBalance(OWNER_UID, 300);
    await seedExpenseBalance(OTHER_MEMBER_UID, -300);
    // MEMBER_UID has no balance row at all.
    const result = await leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID});
    assert.equal(result.departureType, "left");
  });

  it("a nonzero-sum aggregate blocks departure even if the target's own row is absent or zero", async () => {
    await seedTrip(readyTripOverrides());
    await seedExpenseBalance(OWNER_UID, 300); // no offsetting -300 anywhere
    await assertRejectsWithCode(
      leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID}),
      "failed-precondition"
    );
  });

  it("a malformed expense-balance row blocks departure", async () => {
    await seedTrip(readyTripOverrides());
    await seedExpenseBalance(OWNER_UID, 0, {netBalanceMinor: "not-a-number"});
    await assertRejectsWithCode(
      leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID}),
      "failed-precondition"
    );
  });

  it("expense-balance model \"legacy\" blocks departure", async () => {
    await seedTrip(
      readyTripOverrides({
        expenseBalanceModelState: undefined,
        expenseBalanceModelVersion: undefined,
      })
    );
    await assertRejectsWithCode(
      leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID}),
      "failed-precondition"
    );
  });

  it("expense-balance model \"migrating\" blocks departure", async () => {
    await seedTrip(
      readyTripOverrides({
        expenseBalanceModelState: "migrating",
        expenseBalanceModelVersion: undefined,
      })
    );
    await assertRejectsWithCode(
      leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID}),
      "failed-precondition"
    );
  });

  it("expense-balance model \"needs_reconciliation\" blocks departure", async () => {
    await seedTrip(
      readyTripOverrides({expenseBalanceModelState: "needs_reconciliation"})
    );
    await assertRejectsWithCode(
      leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID}),
      "failed-precondition"
    );
  });

  it("an unsupported expense-balance model version fails closed", async () => {
    await seedTrip(readyTripOverrides({expenseBalanceModelVersion: 999}));
    await assertRejectsWithCode(
      leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID}),
      "failed-precondition"
    );
  });

  it("an unknown expense-balance model state fails closed", async () => {
    await seedTrip(
      readyTripOverrides({
        expenseBalanceModelState: "bogus",
        expenseBalanceModelVersion: undefined,
      })
    );
    await assertRejectsWithCode(
      leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID}),
      "failed-precondition"
    );
  });
});

describe("leaveTripCore - trusted ledger state", () => {
  it("an uninitialized ledger blocks departure even if both models say initialized", async () => {
    await seedTrip(
      readyTripOverrides({
        ledgerOpeningBalanceMinor: undefined,
        ledgerBalanceMinor: undefined,
      })
    );
    await assertRejectsWithCode(
      leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID}),
      "failed-precondition"
    );
  });

  it("a partial/corrupt ledger (one field present, one absent) blocks departure", async () => {
    await seedTrip(
      readyTripOverrides({ledgerOpeningBalanceMinor: undefined})
    );
    await assertRejectsWithCode(
      leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID}),
      "failed-precondition"
    );
  });

  it("an invalid initialized ledger (negative balance) blocks departure", async () => {
    await seedTrip(readyTripOverrides({ledgerBalanceMinor: -1}));
    await assertRejectsWithCode(
      leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID}),
      "failed-precondition"
    );
  });
});

describe("leaveTripCore - atomicity", () => {
  it("a failed financial gate leaves memberIds unchanged and creates no departure event", async () => {
    await seedTrip(readyTripOverrides({ledgerBalanceMinor: 100}));
    await seedOwnership(MEMBER_UID, 100);
    await assertRejectsWithCode(
      leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID}),
      "failed-precondition"
    );
    assert.deepEqual(await getTripMemberIds(), [
      OWNER_UID,
      MEMBER_UID,
      OTHER_MEMBER_UID,
    ]);
    assert.equal(await getDeparture(MEMBER_UID), undefined);
  });

  it("success changes memberIds AND creates exactly one departure event, in the same transaction", async () => {
    await seedTrip(readyTripOverrides());
    await leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID});
    assert.deepEqual(await getTripMemberIds(), [OWNER_UID, OTHER_MEMBER_UID]);
    const departure = await getDeparture(MEMBER_UID);
    assert.ok(departure);
  });
});

describe("leaveTripCore - production auth boundary", () => {
  it("requireAuthenticatedUid rejects an absent auth context", () => {
    assert.throws(
      () => requireAuthenticatedUid(undefined),
      (err: unknown) => err instanceof HttpsError && err.code === "unauthenticated"
    );
  });

  it("returns the exact uid when auth is present", () => {
    assert.equal(
      requireAuthenticatedUid({uid: "some-uid"} as never),
      "some-uid"
    );
  });
});

describe("leaveTripCore - input validation", () => {
  it("rejects an unexpected field", async () => {
    await seedTrip(readyTripOverrides());
    await assertRejectsWithCode(
      leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID, memberIds: []}),
      "invalid-argument"
    );
  });

  it("rejects a missing/malformed tripId", async () => {
    await assertRejectsWithCode(
      leaveTripCore(db, MEMBER_UID, {}),
      "invalid-argument"
    );
    await assertRejectsWithCode(
      leaveTripCore(db, MEMBER_UID, {tripId: ""}),
      "invalid-argument"
    );
  });

  it("rejects a nonexistent Trip", async () => {
    await assertRejectsWithCode(
      leaveTripCore(db, MEMBER_UID, {tripId: "nonexistent-trip"}),
      "not-found"
    );
  });
});
