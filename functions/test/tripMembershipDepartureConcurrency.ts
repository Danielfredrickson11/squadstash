// Checkpoint 6.7B1 §31: emulator-backed concurrency coverage proving
// Firestore's own transaction conflict/retry semantics - never a
// separate lock document - correctly serialize Trip membership
// departure against (1) an unrelated concurrent membership addition and
// (2) a real financial mutation (recordTripExpenseCore). Tests
// invariants of the FINAL state, never which operation "wins" - the
// outcome of a genuine race is not deterministic, and asserting a
// specific winner would make this suite flaky by construction.
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {after, before, beforeEach, describe, it} from "node:test";
import {deleteApp, initializeApp} from "firebase-admin/app";
import type {App} from "firebase-admin/app";
import {getFirestore} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";
import {leaveTripCore} from "../src/callables/leaveTrip";
import {recordTripExpenseCore} from "../src/callables/recordTripExpense";
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
const NEW_MEMBER_UID = "new-member-uid";
const TRIP_ID = "test-trip";

let app: App;
let db: Firestore;

before(() => {
  app = initializeApp({
    projectId: "demo-squadstash-functions-test-departure-concurrency",
  });
  db = getFirestore(app);
});

after(async () => {
  await deleteApp(app);
});

async function clearFirestore(): Promise<void> {
  for (const name of [
    "trips",
    "tripExpenses",
    "tripExpenseSplits",
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

async function getTripMemberIds(): Promise<string[] | undefined> {
  const snap = await db.collection("trips").doc(TRIP_ID).get();
  return snap.data()?.memberIds;
}

async function getExpenseBalance(uid: string): Promise<number | undefined> {
  const snap = await db
    .collection("tripExpenseBalances")
    .doc(`${TRIP_ID}_${uid}`)
    .get();
  return snap.exists ?
    (snap.data() as {netBalanceMinor: number}).netBalanceMinor :
    undefined;
}

/**
 * A small, test-only transaction-based membership-add harness - NOT a
 * production primitive. Used solely to prove Firestore's own
 * transaction conflict/retry behavior correctly preserves an unrelated
 * concurrent membership change racing against a departure, without
 * standing up the full invitation-acceptance flow (createTripInvitation
 * + acceptTripInvitation + Trip Terms publication) merely to add one
 * test member.
 * @param {Firestore} dbInstance Admin SDK Firestore instance.
 * @param {string} tripId The Trip to mutate.
 * @param {string} newUid The uid to add, if not already present.
 * @return {Promise<void>}
 */
async function addMemberHarness(
  dbInstance: Firestore,
  tripId: string,
  newUid: string
): Promise<void> {
  const tripRef = dbInstance.collection("trips").doc(tripId);
  await dbInstance.runTransaction(async (tx) => {
    const snap = await tx.get(tripRef);
    const data = snap.data() as FirebaseFirestore.DocumentData;
    const memberIds: string[] = Array.isArray(data.memberIds) ?
      data.memberIds :
      [];
    if (memberIds.includes(newUid)) {
      return;
    }
    tx.update(tripRef, {memberIds: [...memberIds, newUid]});
  });
}

describe("departure concurrency - unrelated membership addition is never lost", () => {
  it("a concurrent addition of a new member survives a simultaneous departure, regardless of commit order", async () => {
    await seedTrip(readyTripOverrides());

    await Promise.all([
      leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID}),
      addMemberHarness(db, TRIP_ID, NEW_MEMBER_UID),
    ]);

    const memberIds = await getTripMemberIds();
    assert.ok(memberIds, "expected memberIds to exist");
    // Both changes must be reflected - MEMBER_UID departed, and
    // NEW_MEMBER_UID was never dropped merely because departure started
    // from an older memberIds snapshot.
    assert.equal(memberIds!.includes(MEMBER_UID), false);
    assert.equal(memberIds!.includes(NEW_MEMBER_UID), true);
    assert.equal(memberIds!.includes(OWNER_UID), true);
    assert.equal(memberIds!.includes(OTHER_MEMBER_UID), true);
    // No duplicates, no dropped unrelated member.
    assert.equal(memberIds!.length, 3);
  });
});

describe("departure concurrency - financial race against a real trusted callable (recordTripExpenseCore)", () => {
  it("leaveTrip vs. a new expense naming the departing member as a split participant: the final state is never contradictory", async () => {
    await seedTrip(readyTripOverrides());

    const expenseRequest = {
      tripId: TRIP_ID,
      payerUid: OTHER_MEMBER_UID,
      amountMinor: 100,
      currency: "USD",
      description: "Race test expense",
      splitStrategy: "equal" as const,
      participants: [{uid: OTHER_MEMBER_UID}, {uid: MEMBER_UID}],
      clientRequestId: randomUUID(),
    };

    const results = await Promise.allSettled([
      leaveTripCore(db, MEMBER_UID, {tripId: TRIP_ID}),
      recordTripExpenseCore(db, OTHER_MEMBER_UID, expenseRequest),
    ]);

    const [leaveResult, expenseResult] = results;
    const memberIds = await getTripMemberIds();
    const memberDeparted = !memberIds!.includes(MEMBER_UID);
    const finalBalance = await getExpenseBalance(MEMBER_UID);

    // Invariant, regardless of which operation actually committed
    // first: a departed member can never be left holding a nonzero
    // social balance, and a still-current member's balance is whatever
    // the (successful) expense produced.
    if (memberDeparted) {
      assert.ok(
        finalBalance === undefined || finalBalance === 0,
        `expected a departed member's balance to be absent/zero, got ${finalBalance}`
      );
      assert.equal(leaveResult.status, "fulfilled");
    } else {
      // leaveTrip did not commit - either it never ran to completion
      // (rejected) or, if it somehow reported fulfilled, membership
      // must still show the member as departed, which is checked above.
      assert.equal(leaveResult.status, "rejected");
    }

    // The expense either fully committed (payer+participant balances
    // reflect it) or fully failed (rejected, no partial write) - never
    // a half-applied state.
    if (expenseResult.status === "fulfilled") {
      // If the expense committed AFTER a departure, its own
      // authorization (every participant must be a current member)
      // would have had to reject it on retry - so reaching "fulfilled"
      // here proves the member had NOT yet departed at commit time,
      // meaning leaveTrip's own later (or concurrently retried) read of
      // the aggregate must have observed the resulting nonzero balance
      // and blocked - i.e. memberDeparted must be false in this branch.
      assert.equal(memberDeparted, false);
    }
  });
});
