// Checkpoint 5B.4B.1, Section A (as resolved by 5B.3C/5B.3C.1): proves
// that a Trip finalized by the ownership migration tool can actually
// be used by the REAL, deployed `recordSavingsTransactionCore`
// afterward. Uses the actual production function - never a stub/mock
// of it.
//
// HISTORY: 5B.4B.1 Section A originally found a confirmed architecture
// gap here - a current Trip member who had never personally
// transacted before migration had no `tripMemberOwnership` row (the
// migration tool only ever creates rows for uids that appear in the
// Trip's historical `savingsTransactions`/allocations - never for
// every current `memberIds` entry, per the frozen §11 "ownership
// follows financial history, never current UI membership" rule), and
// `recordSavingsTransactionCore`'s "initialized" branch used to refuse
// to invent or repair a missing row outright, permanently blocking
// that member's first-ever contribution/withdrawal.
//
// RESOLUTION (Checkpoint 5B.3C, hardened by 5B.3C.1): a missing acting-
// member row is now lazily materialized at ownership 0 for a
// CONTRIBUTION, but only once the complete existing
// `tripMemberOwnership` set for the Trip is proven to already
// reconcile exactly against the pre-contribution aggregate (closing
// the corruption gap 5B.3C.1 identified - a missing row is NOT blindly
// trusted to mean "never participated" if the remaining rows don't
// already sum to the aggregate). A withdrawal against a missing row
// still rejects unconditionally - lazy creation is contribution-only.
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {after, before, beforeEach, describe, it} from "node:test";
import {deleteApp, initializeApp} from "firebase-admin/app";
import type {App} from "firebase-admin/app";
import {Timestamp, getFirestore} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {runApply} from "../src/admin/migrateTripOwnership";
import {recordSavingsTransactionCore} from "../src/callables/recordSavingsTransaction";
import {CURRENT_TRIP_OWNERSHIP_MODEL_VERSION} from "../src/domain/tripOwnershipModel";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "FIRESTORE_EMULATOR_HOST is not set. Run these tests via " +
      '`firebase emulators:exec --only firestore "npm --prefix functions test"` ' +
      "so the Admin SDK talks to the local emulator, never production."
  );
}

let app: App;
let db: Firestore;

before(() => {
  app = initializeApp({
    projectId: "demo-squadstash-functions-test-migrate-post-compat",
  });
  db = getFirestore(app);
});

after(async () => {
  await deleteApp(app);
});

async function clearFirestore(): Promise<void> {
  for (const name of [
    "trips",
    "savingsTransactions",
    "tripExpenses",
    "tripMemberOwnership",
    "tripOwnershipAllocations",
    "tripOwnershipMigrationState",
  ]) {
    const snap = await db.collection(name).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

beforeEach(async () => {
  await clearFirestore();
});

async function assertRejectsWithCode(
  promise: Promise<unknown>,
  code: string,
  messageSubstring: string
): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof HttpsError, "expected an HttpsError");
    assert.equal((err as HttpsError).code, code);
    assert.match((err as HttpsError).message, new RegExp(messageSubstring));
    return true;
  });
}

describe("post-migration compatibility with recordSavingsTransactionCore (Section A)", () => {
  it("a zero-history migrated Trip writes ONLY ownershipModelState/Version - no ledger fields, no ownership rows", async () => {
    const tripId = "zero-history-trip";
    await db.collection("trips").doc(tripId).set({
      ownerId: "daniel",
      memberIds: ["daniel", "friend"],
      title: "Zero History Trip",
      target: 1000,
      saved: 0,
      imageUrl: "https://example.com/trip.jpg",
    });

    const result = await runApply(db, tripId);
    assert.equal(result.verdict, "safe_to_migrate");
    assert.equal(result.phase, "completed");

    const tripSnap = await db.collection("trips").doc(tripId).get();
    const tripData = tripSnap.data();
    assert.equal(tripData?.ownershipModelState, "initialized");
    assert.equal(
      tripData?.ownershipModelVersion,
      CURRENT_TRIP_OWNERSHIP_MODEL_VERSION
    );
    assert.equal(tripData?.ledgerOpeningBalanceMinor, undefined);
    assert.equal(tripData?.ledgerBalanceMinor, undefined);

    const ownershipSnap = await db
      .collection("tripMemberOwnership")
      .where("tripId", "==", tripId)
      .get();
    assert.equal(ownershipSnap.size, 0);
  });

  it("RESOLVED (5B.3C/5B.3C.1): a current member's first-ever contribution to a zero-history migrated Trip succeeds and bootstraps the ledger", async () => {
    const tripId = "zero-history-trip-2";
    await db.collection("trips").doc(tripId).set({
      ownerId: "daniel",
      memberIds: ["daniel", "friend"],
      title: "Zero History Trip",
      target: 1000,
      saved: 0,
      imageUrl: "https://example.com/trip.jpg",
    });
    await runApply(db, tripId);

    const ownershipSnapBefore = await db
      .collection("tripMemberOwnership")
      .where("tripId", "==", tripId)
      .get();
    assert.equal(ownershipSnapBefore.size, 0);

    const result = await recordSavingsTransactionCore(db, "daniel", {
      resourceType: "trip",
      resourceId: tripId,
      memberUid: "daniel",
      type: "contribution",
      amountMinor: 500,
      currency: "USD",
      clientRequestId: randomUUID(),
    });
    assert.equal(result.balanceMinor, 500);

    const rowSnap = await db
      .collection("tripMemberOwnership")
      .doc(`${tripId}_daniel`)
      .get();
    assert.equal(rowSnap.exists, true);
    assert.equal(rowSnap.data()?.ownershipMinor, 500);

    const tripSnap = await db.collection("trips").doc(tripId).get();
    assert.equal(tripSnap.data()?.ledgerBalanceMinor, 500);
  });

  it("RESOLVED (5B.3C/5B.3C.1): a never-transacted current member's first contribution succeeds on a Trip WITH other members' history", async () => {
    const tripId = "partial-history-trip";
    await db.collection("trips").doc(tripId).set({
      ownerId: "daniel",
      memberIds: ["daniel", "friend"],
      title: "Partial History Trip",
      target: 1000,
      saved: 9,
      imageUrl: "https://example.com/trip.jpg",
      ledgerOpeningBalanceMinor: 0,
      ledgerBalanceMinor: 900,
      currency: "USD",
    });
    await db.collection("savingsTransactions").doc("tx-1").set({
      resourceType: "trip",
      resourceId: tripId,
      memberUid: "daniel",
      type: "contribution",
      amountMinor: 900,
      currency: "USD",
      createdAt: Timestamp.fromMillis(1000),
      reversalOf: null,
    });

    const result = await runApply(db, tripId);
    assert.equal(result.verdict, "safe_to_migrate");

    // The migration correctly created a row for "daniel" (who has
    // history) - "friend" (current member, never transacted) has none.
    const ownershipSnap = await db
      .collection("tripMemberOwnership")
      .where("tripId", "==", tripId)
      .get();
    assert.equal(ownershipSnap.size, 1);
    assert.equal(ownershipSnap.docs[0].data().uid, "daniel");
    assert.equal(ownershipSnap.docs[0].data().ownershipMinor, 900);

    // "friend"'s first-ever contribution now succeeds: the complete
    // existing set (daniel=900) reconciles exactly against the
    // pre-contribution aggregate (900), so friend's missing row is
    // safely treated as 0.
    const friendResult = await recordSavingsTransactionCore(db, "friend", {
      resourceType: "trip",
      resourceId: tripId,
      memberUid: "friend",
      type: "contribution",
      amountMinor: 100,
      currency: "USD",
      clientRequestId: randomUUID(),
    });
    assert.equal(friendResult.balanceMinor, 1000);

    const danielRowSnap = await db
      .collection("tripMemberOwnership")
      .doc(`${tripId}_daniel`)
      .get();
    assert.equal(danielRowSnap.data()?.ownershipMinor, 900);
    const friendRowSnap = await db
      .collection("tripMemberOwnership")
      .doc(`${tripId}_friend`)
      .get();
    assert.equal(friendRowSnap.data()?.ownershipMinor, 100);

    // "daniel" (already has a row) can still transact normally
    // afterward, via the existing, unaffected efficient path.
    const danielResult = await recordSavingsTransactionCore(db, "daniel", {
      resourceType: "trip",
      resourceId: tripId,
      memberUid: "daniel",
      type: "contribution",
      amountMinor: 50,
      currency: "USD",
      clientRequestId: randomUUID(),
    });
    assert.equal(danielResult.balanceMinor, 1050);
  });

  it("UNCHANGED: a never-transacted member's first-ever withdrawal still rejects (lazy creation is contribution-only)", async () => {
    const tripId = "zero-history-trip-3";
    await db.collection("trips").doc(tripId).set({
      ownerId: "daniel",
      memberIds: ["daniel", "friend"],
      title: "Zero History Trip",
      target: 1000,
      saved: 0,
      imageUrl: "https://example.com/trip.jpg",
    });
    await runApply(db, tripId);

    await assertRejectsWithCode(
      recordSavingsTransactionCore(db, "friend", {
        resourceType: "trip",
        resourceId: tripId,
        memberUid: "friend",
        type: "withdrawal",
        amountMinor: 10,
        currency: "USD",
        clientRequestId: randomUUID(),
      }),
      "failed-precondition",
      "This withdrawal exceeds your own Shared Stash ownership"
    );
  });
});
