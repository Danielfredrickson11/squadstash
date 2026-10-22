// Checkpoint 5B.3: ownership-model-state-aware integration tests for
// recordSavingsTransactionCore's "trip" branch, against the local
// Firestore emulator via the Admin SDK - never production. Deliberately
// a SEPARATE file from recordSavingsTransactionCore.ts's own existing
// (unmodified) legacy test suite - that file's continued, untouched
// pass is itself part of the proof that legacy behavior is unchanged;
// this file covers only the NEW ownership-model-state branches.
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {after, before, beforeEach, describe, it} from "node:test";
import {deleteApp, initializeApp} from "firebase-admin/app";
import type {App} from "firebase-admin/app";
import {Timestamp, getFirestore} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {recordSavingsTransactionCore} from "../src/callables/recordSavingsTransaction";
import {CURRENT_TRIP_OWNERSHIP_MODEL_VERSION} from "../src/domain/tripOwnershipModel";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "FIRESTORE_EMULATOR_HOST is not set. Run these tests via " +
      '`firebase emulators:exec --only firestore "npm --prefix functions test"` ' +
      "so the Admin SDK talks to the local emulator, never production."
  );
}

const OWNER_UID = "owner-uid";
const MEMBER_UID = "member-uid";
const FRIEND_UID = "friend-uid";
const TRIP_ID = "test-trip";

let app: App;
let db: Firestore;

before(() => {
  app = initializeApp({
    projectId: "demo-squadstash-functions-test-savings-ownership",
  });
  db = getFirestore(app);
});

after(async () => {
  await deleteApp(app);
});

async function clearFirestore(): Promise<void> {
  for (const name of ["trips", "savingsTransactions", "tripMemberOwnership"]) {
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

function seedTrip(
  overrides: Record<string, unknown> = {}
): Promise<FirebaseFirestore.WriteResult> {
  return db
    .collection("trips")
    .doc(TRIP_ID)
    .set({
      ownerId: OWNER_UID,
      memberIds: [OWNER_UID, MEMBER_UID, FRIEND_UID],
      title: "Test Trip",
      target: 1000,
      saved: 10,
      ledgerOpeningBalanceMinor: 0,
      ledgerBalanceMinor: 1000,
      currency: "USD",
      imageUrl: "https://example.com/trip.jpg",
      ...overrides,
    });
}

function initializedOverrides(
  ledgerBalanceMinor: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ledgerOpeningBalanceMinor: 0,
    ledgerBalanceMinor,
    saved: ledgerBalanceMinor / 100,
    ownershipModelState: "initialized",
    ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
    ...overrides,
  };
}

function seedOwnership(
  tripId: string,
  uid: string,
  ownershipMinor: number,
  overrides: Record<string, unknown> = {}
): Promise<FirebaseFirestore.WriteResult> {
  return db
    .collection("tripMemberOwnership")
    .doc(ownershipId(tripId, uid))
    .set({
      tripId,
      uid,
      ownershipMinor,
      lastUpdatedAt: new Date(),
      ...overrides,
    });
}

async function getOwnership(uid: string): Promise<number | undefined> {
  const snap = await db
    .collection("tripMemberOwnership")
    .doc(ownershipId(TRIP_ID, uid))
    .get();
  return snap.exists ? (snap.data() as {ownershipMinor: number}).ownershipMinor : undefined;
}

async function getOwnershipLastUpdatedAt(
  uid: string
): Promise<Timestamp | undefined> {
  const snap = await db
    .collection("tripMemberOwnership")
    .doc(ownershipId(TRIP_ID, uid))
    .get();
  return snap.exists ?
    (snap.data() as {lastUpdatedAt: Timestamp}).lastUpdatedAt :
    undefined;
}

function baseRequest(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    resourceType: "trip",
    resourceId: TRIP_ID,
    memberUid: MEMBER_UID,
    type: "contribution",
    amountMinor: 100,
    currency: "USD",
    clientRequestId: randomUUID(),
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

// ---------------------------------------------------------------------
// Legacy regression (Checkpoint 5B.3, item 23) - minimal, targeted
// proof that an explicit "legacy" state behaves IDENTICALLY to the
// absent-state case the existing recordSavingsTransactionCore.ts suite
// already exhaustively covers.
// ---------------------------------------------------------------------

describe("legacy regression - explicit \"legacy\" state", () => {
  it("contribution succeeds with no ownership row required, state absent", async () => {
    await seedTrip();
    const result = await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest()
    );
    assert.equal(result.balanceMinor, 1100);
    assert.equal(await getOwnership(MEMBER_UID), undefined);
  });

  it("contribution succeeds with no ownership row required, state explicit \"legacy\"", async () => {
    await seedTrip({ownershipModelState: "legacy"});
    const result = await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest()
    );
    assert.equal(result.balanceMinor, 1100);
    assert.equal(await getOwnership(MEMBER_UID), undefined);
  });

  it("withdrawal succeeds using only the aggregate check, state absent", async () => {
    await seedTrip({ledgerBalanceMinor: 1000});
    const result = await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({type: "withdrawal", amountMinor: 1000})
    );
    assert.equal(result.balanceMinor, 0);
  });

  it("withdrawal succeeds using only the aggregate check, state explicit \"legacy\"", async () => {
    await seedTrip({ledgerBalanceMinor: 1000, ownershipModelState: "legacy"});
    const result = await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({type: "withdrawal", amountMinor: 1000})
    );
    assert.equal(result.balanceMinor, 0);
  });

  it("legacy withdrawal exceeding aggregate still rejects, exactly as today", async () => {
    await seedTrip({ledgerBalanceMinor: 500, ownershipModelState: "legacy"});
    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({type: "withdrawal", amountMinor: 501})
      ),
      "failed-precondition"
    );
  });
});

// ---------------------------------------------------------------------
// Initialized contribution (Checkpoint 5B.3, item 24)
// ---------------------------------------------------------------------

describe("initialized contribution", () => {
  it("lastUpdatedAt advances to a trusted server timestamp on success (Checkpoint 5B.3A, item 4)", async () => {
    await seedTrip(initializedOverrides(1000));
    const oldSentinel = Timestamp.fromMillis(1000);
    await seedOwnership(TRIP_ID, MEMBER_UID, 400, {
      lastUpdatedAt: oldSentinel,
    });
    await seedOwnership(TRIP_ID, FRIEND_UID, 600);

    await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({amountMinor: 100})
    );

    const after = await getOwnershipLastUpdatedAt(MEMBER_UID);
    assert.ok(after, "expected lastUpdatedAt to be set");
    assert.ok(
      after!.toMillis() > oldSentinel.toMillis(),
      "expected lastUpdatedAt to advance past the sentinel"
    );
  });

  it("a rejected contribution leaves lastUpdatedAt untouched", async () => {
    await seedTrip(initializedOverrides(1000));
    const sentinel = Timestamp.fromMillis(1000);
    await seedOwnership(TRIP_ID, MEMBER_UID, -1, {lastUpdatedAt: sentinel});

    await assertRejectsWithCode(
      recordSavingsTransactionCore(db, MEMBER_UID, baseRequest()),
      "failed-precondition"
    );

    const after = await getOwnershipLastUpdatedAt(MEMBER_UID);
    assert.deepEqual(after, sentinel);
  });

  it("updates aggregate and the acting member's ownership atomically; other rows unchanged", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, MEMBER_UID, 400);
    await seedOwnership(TRIP_ID, FRIEND_UID, 600);

    const result = await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({amountMinor: 100})
    );

    assert.equal(result.balanceMinor, 1100);
    assert.equal(await getOwnership(MEMBER_UID), 500);
    assert.equal(await getOwnership(FRIEND_UID), 600);
  });

  it("zero -> positive contribution works when the row exists at zero", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, MEMBER_UID, 0);
    await seedOwnership(TRIP_ID, FRIEND_UID, 1000);

    const result = await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({amountMinor: 50})
    );

    assert.equal(result.balanceMinor, 1050);
    assert.equal(await getOwnership(MEMBER_UID), 50);
  });

  // Checkpoint 5B.3C: a missing acting ownership row is exactly
  // ownership 0 (the frozen "no row == ownership 0" equivalence,
  // original preflight §11/§19) - a CONTRIBUTION now lazily
  // materializes that implicit zero row, rather than rejecting. This
  // is NOT ownership repair/migration/authorization - every gate above
  // this block (self-only, current-member, archive, ownership-model-
  // state) still ran identically first.
  // Checkpoint 5B.3C.1, §3: legitimate zero-history case - the complete
  // existing ownership set (empty) reconciles trivially against a
  // zero pre-contribution aggregate, so the missing row safely means 0.
  it("legitimate zero-history missing row lazily creates it at the contribution amount (Checkpoint 5B.3C/5B.3C.1)", async () => {
    await seedTrip(initializedOverrides(0));
    // No ownership row seeded for MEMBER_UID, and no other rows exist -
    // a genuinely zero-history Trip.

    const result = await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({amountMinor: 100})
    );

    assert.equal(result.balanceMinor, 100);
    assert.equal(await getOwnership(MEMBER_UID), 100);
    const lastUpdatedAt = await getOwnershipLastUpdatedAt(MEMBER_UID);
    assert.ok(lastUpdatedAt, "expected the newly-created row to carry a lastUpdatedAt");

    const rowSnap = await db
      .collection("tripMemberOwnership")
      .doc(ownershipId(TRIP_ID, MEMBER_UID))
      .get();
    assert.equal(rowSnap.exists, true);
    assert.equal(rowSnap.data()?.tripId, TRIP_ID);
    assert.equal(rowSnap.data()?.uid, MEMBER_UID);
  });

  // Checkpoint 5B.3C.1, §4: legitimate partial-history case - the
  // complete existing set (friend=600) reconciles exactly against the
  // pre-contribution aggregate (600), so the missing row safely means 0.
  it("legitimate partial-history missing row succeeds after complete-set reconciliation, and does not touch any other member's row", async () => {
    await seedTrip(initializedOverrides(600));
    await seedOwnership(TRIP_ID, FRIEND_UID, 600);
    // No row seeded for MEMBER_UID.

    const result = await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({amountMinor: 100})
    );

    assert.equal(result.balanceMinor, 700);
    assert.equal(await getOwnership(MEMBER_UID), 100);
    assert.equal(await getOwnership(FRIEND_UID), 600);
  });

  // Checkpoint 5B.3C.1, §4: the exact frozen worked example - Daniel
  // has 900, Friend's row is absent, aggregate is 900; Friend's first
  // contribution of 100 must land at Daniel=900/Friend=100/aggregate=1000.
  it("the exact frozen partial-history example: Daniel=900, Friend absent, aggregate=900 -> Friend contributes 100", async () => {
    await seedTrip(initializedOverrides(900));
    await seedOwnership(TRIP_ID, OWNER_UID, 900);

    const result = await recordSavingsTransactionCore(
      db,
      FRIEND_UID,
      baseRequest({memberUid: FRIEND_UID, amountMinor: 100})
    );

    assert.equal(result.balanceMinor, 1000);
    assert.equal(await getOwnership(OWNER_UID), 900);
    assert.equal(await getOwnership(FRIEND_UID), 100);
  });

  // Checkpoint 5B.3C.1, §5: Daniel's true ownership (900) matches the
  // aggregate (1000) together with Friend's 100 - but if Daniel's row
  // is deleted out-of-band, the existing set (Friend=100 alone) no
  // longer reconciles against the aggregate (1000), so Daniel's
  // missing row must NOT be reinterpreted as zero.
  it("CONFIRMED SAFETY GAP CLOSED: a deleted positive acting row fails closed rather than being treated as zero", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, OWNER_UID, 900);
    await seedOwnership(TRIP_ID, FRIEND_UID, 100);
    // Out-of-band deletion of Daniel's (the owner's) row.
    await db
      .collection("tripMemberOwnership")
      .doc(ownershipId(TRIP_ID, OWNER_UID))
      .delete();

    const request = baseRequest({memberUid: OWNER_UID, amountMinor: 100});
    await assertRejectsWithCode(
      recordSavingsTransactionCore(db, OWNER_UID, request),
      "failed-precondition"
    );

    const ownerRowSnap = await db
      .collection("tripMemberOwnership")
      .doc(ownershipId(TRIP_ID, OWNER_UID))
      .get();
    assert.equal(ownerRowSnap.exists, false);
    assert.equal(await getOwnership(FRIEND_UID), 100);
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.ledgerBalanceMinor, 1000);
    const txnSnap = await db
      .collection("savingsTransactions")
      .doc(request.clientRequestId as string)
      .get();
    assert.equal(txnSnap.exists, false);
  });

  // Checkpoint 5B.3C.1, §7: generic drift (no specific deletion
  // narrative) - the existing set simply does not sum to the aggregate.
  it("a generic ownership/aggregate drift rejects the missing-row contribution, with no financial mutation", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, FRIEND_UID, 50);
    // No row for MEMBER_UID - existing set sums to 50, not 1000.

    const request = baseRequest({amountMinor: 100});
    await assertRejectsWithCode(
      recordSavingsTransactionCore(db, MEMBER_UID, request),
      "failed-precondition"
    );

    assert.equal(await getOwnership(MEMBER_UID), undefined);
    assert.equal(await getOwnership(FRIEND_UID), 50);
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.ledgerBalanceMinor, 1000);
  });

  // Checkpoint 5B.3C.1, §6: a malformed OTHER row in the complete scan
  // fails the whole reconciliation closed - never silently excluded.
  it("a malformed OTHER ownership row fails the missing-row contribution closed", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, FRIEND_UID, -1);

    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({amountMinor: 100})
      ),
      "failed-precondition"
    );
    assert.equal(await getOwnership(MEMBER_UID), undefined);
  });

  // Checkpoint 5B.3C.1, §6/§2: a rogue row at a NONCANONICAL document
  // id (even with otherwise plausible-looking content) must fail the
  // scan closed - the canonical-id check is never skipped.
  it("a noncanonical-id rogue ownership row fails the missing-row contribution closed", async () => {
    await seedTrip(initializedOverrides(1000));
    await db.collection("tripMemberOwnership").doc("rogue-doc-id").set({
      tripId: TRIP_ID,
      uid: FRIEND_UID,
      ownershipMinor: 1000,
      lastUpdatedAt: new Date(),
    });

    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({amountMinor: 100})
      ),
      "failed-precondition"
    );
    assert.equal(await getOwnership(MEMBER_UID), undefined);
  });

  // Checkpoint 5B.3C.1, §10: a race between two DIFFERENT members' own
  // first contributions, both starting from a missing row, must still
  // land at the exact summed total - each commit changes the Trip
  // document (always in both transactions' read sets), forcing a
  // retry that re-reads the other's now-committed row rather than
  // reconciling against a stale snapshot.
  it("two concurrent first contributions by DIFFERENT members both succeed and sum exactly", async () => {
    await seedTrip(initializedOverrides(0));
    const [ownerResult, friendResult] = await Promise.all([
      recordSavingsTransactionCore(
        db,
        OWNER_UID,
        baseRequest({
          memberUid: OWNER_UID,
          amountMinor: 100,
          clientRequestId: randomUUID(),
        })
      ),
      recordSavingsTransactionCore(
        db,
        FRIEND_UID,
        baseRequest({
          memberUid: FRIEND_UID,
          amountMinor: 50,
          clientRequestId: randomUUID(),
        })
      ),
    ]);

    assert.equal(await getOwnership(OWNER_UID), 100);
    assert.equal(await getOwnership(FRIEND_UID), 50);
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.ledgerBalanceMinor, 150);
    assert.ok(
      [ownerResult.balanceMinor, friendResult.balanceMinor].includes(150),
      "expected whichever call committed second to observe the summed total"
    );
  });

  it("malformed ownership row (wrong tripId) rejects", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, MEMBER_UID, 400, {tripId: "some-other-trip"});
    await assertRejectsWithCode(
      recordSavingsTransactionCore(db, MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
  });

  it("malformed ownership row (negative ownershipMinor) rejects", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, MEMBER_UID, -1);
    await assertRejectsWithCode(
      recordSavingsTransactionCore(db, MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
  });

  it("unsupported ownershipModelVersion rejects", async () => {
    await seedTrip(
      initializedOverrides(1000, {ownershipModelVersion: 999})
    );
    await seedOwnership(TRIP_ID, MEMBER_UID, 400);
    await assertRejectsWithCode(
      recordSavingsTransactionCore(db, MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
  });

  it("corrupt ownershipModelState rejects", async () => {
    await seedTrip({
      ledgerOpeningBalanceMinor: 0,
      ledgerBalanceMinor: 1000,
      ownershipModelState: "bogus",
    });
    await assertRejectsWithCode(
      recordSavingsTransactionCore(db, MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
  });

  it("idempotent replay does not double-credit ownership", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, MEMBER_UID, 400);
    await seedOwnership(TRIP_ID, FRIEND_UID, 600);
    const request = baseRequest({amountMinor: 100});

    const first = await recordSavingsTransactionCore(db, MEMBER_UID, request);
    assert.equal(first.balanceMinor, 1100);
    assert.equal(await getOwnership(MEMBER_UID), 500);

    const second = await recordSavingsTransactionCore(db, MEMBER_UID, request);
    assert.equal(second.balanceMinor, 1100);
    assert.equal(await getOwnership(MEMBER_UID), 500);
  });

  it("failure leaves all financial docs unchanged (atomicity)", async () => {
    await seedTrip(initializedOverrides(1000));
    // A malformed (not merely missing) row - this contribution must
    // still fail closed, and must not be confused with the new
    // missing-row lazy-creation path above.
    await seedOwnership(TRIP_ID, MEMBER_UID, -1);
    const request = baseRequest();
    await assertRejectsWithCode(
      recordSavingsTransactionCore(db, MEMBER_UID, request),
      "failed-precondition"
    );

    const txnSnap = await db
      .collection("savingsTransactions")
      .doc(request.clientRequestId as string)
      .get();
    assert.equal(txnSnap.exists, false);
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.ledgerBalanceMinor, 1000);
  });

  it("idempotent replay after lazy row creation does not double-credit (Checkpoint 5B.3C)", async () => {
    await seedTrip(initializedOverrides(0));
    const request = baseRequest({amountMinor: 100});

    const first = await recordSavingsTransactionCore(db, MEMBER_UID, request);
    assert.equal(first.balanceMinor, 100);
    assert.equal(await getOwnership(MEMBER_UID), 100);

    const second = await recordSavingsTransactionCore(db, MEMBER_UID, request);
    assert.deepEqual(second, first);
    assert.equal(await getOwnership(MEMBER_UID), 100);

    const snap = await db
      .collection("savingsTransactions")
      .where("resourceType", "==", "trip")
      .where("resourceId", "==", TRIP_ID)
      .get();
    assert.equal(snap.size, 1);
  });

  it("two concurrent first contributions by the same member sum exactly, with no lost update (Checkpoint 5B.3C)", async () => {
    await seedTrip(initializedOverrides(0));
    // No row seeded for MEMBER_UID - both contributions race to
    // lazily create it.
    const [resultA, resultB] = await Promise.all([
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({amountMinor: 100, clientRequestId: randomUUID()})
      ),
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({amountMinor: 50, clientRequestId: randomUUID()})
      ),
    ]);

    assert.equal(await getOwnership(MEMBER_UID), 150);
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.ledgerBalanceMinor, 150);
    // Each call's own RETURNED balance reflects the aggregate as of
    // THAT transaction's own commit - the serializable order between
    // the two (whichever committed second necessarily observes the
    // first one's result and returns the final 150; whichever
    // committed first returns only its own delta, 100 or 50) - never
    // both returning the stale pre-contention value. The absence of a
    // lost update is what the FINAL state assertions above already
    // prove; this only sanity-checks that one of the two calls did
    // observe the fully-summed total.
    assert.ok(
      [resultA.balanceMinor, resultB.balanceMinor].includes(150),
      "expected at least one call to observe the final summed total"
    );
    assert.notEqual(resultA.balanceMinor, resultB.balanceMinor);

    const snap = await db
      .collection("savingsTransactions")
      .where("resourceType", "==", "trip")
      .where("resourceId", "==", TRIP_ID)
      .get();
    assert.equal(snap.size, 2);
  });

  it("an unauthorized (non-member) uid cannot create an ownership row for itself via a missing-row contribution", async () => {
    await seedTrip(initializedOverrides(1000));
    const OUTSIDER_UID = "outsider-uid";
    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        OUTSIDER_UID,
        baseRequest({memberUid: OUTSIDER_UID})
      ),
      "permission-denied"
    );
    const rowSnap = await db
      .collection("tripMemberOwnership")
      .doc(ownershipId(TRIP_ID, OUTSIDER_UID))
      .get();
    assert.equal(rowSnap.exists, false);
  });

  it("a self/memberUid mismatch is rejected before any row could be created", async () => {
    await seedTrip(initializedOverrides(1000));
    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({memberUid: FRIEND_UID})
      ),
      "permission-denied"
    );
    const rowSnap = await db
      .collection("tripMemberOwnership")
      .doc(ownershipId(TRIP_ID, FRIEND_UID))
      .get();
    assert.equal(rowSnap.exists, false);
  });

  it("an archived Trip rejects a missing-row contribution, and no row is created", async () => {
    await seedTrip(
      initializedOverrides(1000, {archivedAt: Timestamp.fromMillis(1000)})
    );
    await assertRejectsWithCode(
      recordSavingsTransactionCore(db, MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
    const rowSnap = await db
      .collection("tripMemberOwnership")
      .doc(ownershipId(TRIP_ID, MEMBER_UID))
      .get();
    assert.equal(rowSnap.exists, false);
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.ledgerBalanceMinor, 1000);
  });
});

// ---------------------------------------------------------------------
// Initialized personal withdrawal (Checkpoint 5B.3, item 25)
// ---------------------------------------------------------------------

describe("initialized personal withdrawal", () => {
  it("lastUpdatedAt advances to a trusted server timestamp on success (Checkpoint 5B.3A, item 4)", async () => {
    await seedTrip(initializedOverrides(1000));
    const oldSentinel = Timestamp.fromMillis(1000);
    await seedOwnership(TRIP_ID, MEMBER_UID, 100, {
      lastUpdatedAt: oldSentinel,
    });
    await seedOwnership(TRIP_ID, FRIEND_UID, 900);

    await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({type: "withdrawal", amountMinor: 40})
    );

    const after = await getOwnershipLastUpdatedAt(MEMBER_UID);
    assert.ok(after, "expected lastUpdatedAt to be set");
    assert.ok(
      after!.toMillis() > oldSentinel.toMillis(),
      "expected lastUpdatedAt to advance past the sentinel"
    );
  });

  it("a rejected withdrawal (ceiling exceeded) leaves lastUpdatedAt untouched", async () => {
    await seedTrip(initializedOverrides(1000));
    const sentinel = Timestamp.fromMillis(1000);
    await seedOwnership(TRIP_ID, MEMBER_UID, 100, {lastUpdatedAt: sentinel});
    await seedOwnership(TRIP_ID, FRIEND_UID, 900);

    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({type: "withdrawal", amountMinor: 101})
      ),
      "failed-precondition"
    );

    const after = await getOwnershipLastUpdatedAt(MEMBER_UID);
    assert.deepEqual(after, sentinel);
  });

  it("below ceiling succeeds", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, MEMBER_UID, 100);
    await seedOwnership(TRIP_ID, FRIEND_UID, 900);

    const result = await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({type: "withdrawal", amountMinor: 40})
    );
    assert.equal(result.balanceMinor, 960);
    assert.equal(await getOwnership(MEMBER_UID), 60);
    assert.equal(await getOwnership(FRIEND_UID), 900);
  });

  it("exact ceiling succeeds, ownership goes to zero", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, MEMBER_UID, 100);
    await seedOwnership(TRIP_ID, FRIEND_UID, 900);

    const result = await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({type: "withdrawal", amountMinor: 100})
    );
    assert.equal(result.balanceMinor, 900);
    assert.equal(await getOwnership(MEMBER_UID), 0);
  });

  it("the exact frozen example: Daniel=900, Friend=100, aggregate=1000 - Friend may withdraw 100 but not 101", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, OWNER_UID, 900);
    await seedOwnership(TRIP_ID, FRIEND_UID, 100);

    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        FRIEND_UID,
        baseRequest({
          memberUid: FRIEND_UID,
          type: "withdrawal",
          amountMinor: 101,
        })
      ),
      "failed-precondition"
    );
    assert.equal(await getOwnership(FRIEND_UID), 100);
    assert.equal(await getOwnership(OWNER_UID), 900);

    const result = await recordSavingsTransactionCore(
      db,
      FRIEND_UID,
      baseRequest({
        memberUid: FRIEND_UID,
        type: "withdrawal",
        amountMinor: 100,
      })
    );
    assert.equal(result.balanceMinor, 900);
    assert.equal(await getOwnership(FRIEND_UID), 0);
    assert.equal(await getOwnership(OWNER_UID), 900);
  });

  it("one unit over ownership rejects even though the aggregate has plenty", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, MEMBER_UID, 100);
    await seedOwnership(TRIP_ID, FRIEND_UID, 900);

    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({type: "withdrawal", amountMinor: 101})
      ),
      "failed-precondition"
    );
    assert.equal(await getOwnership(MEMBER_UID), 100);
  });

  it("the owner cannot consume another member's ownership - self-only ceiling applies to the owner too", async () => {
    await seedTrip(initializedOverrides(900));
    await seedOwnership(TRIP_ID, OWNER_UID, 0);
    await seedOwnership(TRIP_ID, FRIEND_UID, 900);

    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        OWNER_UID,
        baseRequest({
          memberUid: OWNER_UID,
          type: "withdrawal",
          amountMinor: 1,
        })
      ),
      "failed-precondition"
    );
    assert.equal(await getOwnership(FRIEND_UID), 900);
  });

  it("aggregate insufficient funds still rejects independently of the ownership ceiling", async () => {
    // Contrived mismatch purely to exercise the EXISTING, independent
    // aggregate check as a defense-in-depth layer distinct from the new
    // ownership ceiling: ownership (1000) alone would permit this
    // withdrawal, but the aggregate (500) does not.
    await seedTrip(initializedOverrides(500));
    await seedOwnership(TRIP_ID, MEMBER_UID, 1000);

    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({type: "withdrawal", amountMinor: 600})
      ),
      "failed-precondition"
    );
    assert.equal(await getOwnership(MEMBER_UID), 1000);
  });

  // Checkpoint 5B.3C, §4: a missing row means ownership 0 for
  // withdrawal-ceiling purposes too, but - unlike contribution -
  // withdrawal NEVER lazily creates a row, even for a rejected
  // mutation: no row, no SavingsTransaction, aggregate unchanged.
  it("missing acting ownership row rejects, never treated as zero/unlimited, and no row is created", async () => {
    await seedTrip(initializedOverrides(1000));
    const request = baseRequest({type: "withdrawal", amountMinor: 1});
    await assertRejectsWithCode(
      recordSavingsTransactionCore(db, MEMBER_UID, request),
      "failed-precondition"
    );

    const rowSnap = await db
      .collection("tripMemberOwnership")
      .doc(ownershipId(TRIP_ID, MEMBER_UID))
      .get();
    assert.equal(rowSnap.exists, false);
    const txnSnap = await db
      .collection("savingsTransactions")
      .doc(request.clientRequestId as string)
      .get();
    assert.equal(txnSnap.exists, false);
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.ledgerBalanceMinor, 1000);
  });

  it("malformed ownership row rejects", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, MEMBER_UID, 1.5 as unknown as number);
    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({type: "withdrawal", amountMinor: 1})
      ),
      "failed-precondition"
    );
  });

  it("idempotent replay does not double-debit", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, MEMBER_UID, 100);
    await seedOwnership(TRIP_ID, FRIEND_UID, 900);
    const request = baseRequest({type: "withdrawal", amountMinor: 40});

    const first = await recordSavingsTransactionCore(db, MEMBER_UID, request);
    assert.equal(first.balanceMinor, 960);
    assert.equal(await getOwnership(MEMBER_UID), 60);

    const second = await recordSavingsTransactionCore(db, MEMBER_UID, request);
    assert.equal(second.balanceMinor, 960);
    assert.equal(await getOwnership(MEMBER_UID), 60);
  });

  it("failure is atomic - no partial write on ceiling rejection", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, MEMBER_UID, 100);
    const request = baseRequest({type: "withdrawal", amountMinor: 101});

    await assertRejectsWithCode(
      recordSavingsTransactionCore(db, MEMBER_UID, request),
      "failed-precondition"
    );

    const txnSnap = await db
      .collection("savingsTransactions")
      .doc(request.clientRequestId as string)
      .get();
    assert.equal(txnSnap.exists, false);
    assert.equal(await getOwnership(MEMBER_UID), 100);
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.ledgerBalanceMinor, 1000);
  });
});

// ---------------------------------------------------------------------
// Migrating / needs_reconciliation (Checkpoint 5B.3, items 22/28/29)
// ---------------------------------------------------------------------

describe("migrating - every new mutation rejects", () => {
  it("rejects a new contribution, even with a missing ownership row, and never creates one (Checkpoint 5B.3C)", async () => {
    await seedTrip({ownershipModelState: "migrating"});
    await assertRejectsWithCode(
      recordSavingsTransactionCore(db, MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
    const rowSnap = await db
      .collection("tripMemberOwnership")
      .doc(ownershipId(TRIP_ID, MEMBER_UID))
      .get();
    assert.equal(rowSnap.exists, false);
  });

  it("rejects a new withdrawal", async () => {
    await seedTrip({ownershipModelState: "migrating"});
    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({type: "withdrawal", amountMinor: 10})
      ),
      "failed-precondition"
    );
  });

  it("an exact replay of an already-committed contribution survives the Trip later entering migrating", async () => {
    await seedTrip();
    const request = baseRequest({amountMinor: 250});
    const first = await recordSavingsTransactionCore(db, MEMBER_UID, request);
    assert.equal(first.balanceMinor, 1250);

    await db
      .collection("trips")
      .doc(TRIP_ID)
      .update({ownershipModelState: "migrating"});

    const replay = await recordSavingsTransactionCore(db, MEMBER_UID, request);
    assert.deepEqual(replay, first);

    // A genuinely new request against the same, now-migrating Trip
    // must still reject.
    await assertRejectsWithCode(
      recordSavingsTransactionCore(db, MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
  });

  it("an exact replay of an already-committed withdrawal survives the Trip later entering migrating (Checkpoint 5B.3A, item 2)", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, MEMBER_UID, 500);
    await seedOwnership(TRIP_ID, FRIEND_UID, 500);
    const request = baseRequest({type: "withdrawal", amountMinor: 200});
    const first = await recordSavingsTransactionCore(db, MEMBER_UID, request);
    assert.equal(first.balanceMinor, 800);

    await db
      .collection("trips")
      .doc(TRIP_ID)
      .update({ownershipModelState: "migrating"});

    const replay = await recordSavingsTransactionCore(db, MEMBER_UID, request);
    assert.deepEqual(replay, first);

    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({type: "withdrawal", amountMinor: 1})
      ),
      "failed-precondition"
    );
  });
});

describe("needs_reconciliation - every new mutation rejects, identically to migrating", () => {
  it("rejects a new contribution, even with a missing ownership row, and never creates one (Checkpoint 5B.3C)", async () => {
    await seedTrip({
      ownershipModelState: "needs_reconciliation",
      ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
    });
    await assertRejectsWithCode(
      recordSavingsTransactionCore(db, MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
    const rowSnap = await db
      .collection("tripMemberOwnership")
      .doc(ownershipId(TRIP_ID, MEMBER_UID))
      .get();
    assert.equal(rowSnap.exists, false);
  });

  it("rejects a new withdrawal", async () => {
    await seedTrip({
      ownershipModelState: "needs_reconciliation",
      ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
    });
    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({type: "withdrawal", amountMinor: 10})
      ),
      "failed-precondition"
    );
  });

  it("an exact replay of an already-committed withdrawal survives the Trip later needing reconciliation", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, MEMBER_UID, 500);
    await seedOwnership(TRIP_ID, FRIEND_UID, 500);
    const request = baseRequest({type: "withdrawal", amountMinor: 200});
    const first = await recordSavingsTransactionCore(db, MEMBER_UID, request);
    assert.equal(first.balanceMinor, 800);

    await db
      .collection("trips")
      .doc(TRIP_ID)
      .update({ownershipModelState: "needs_reconciliation"});

    const replay = await recordSavingsTransactionCore(db, MEMBER_UID, request);
    assert.deepEqual(replay, first);

    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({type: "withdrawal", amountMinor: 1})
      ),
      "failed-precondition"
    );
  });

  it("an exact replay of an already-committed contribution survives the Trip later needing reconciliation (Checkpoint 5B.3A, item 2)", async () => {
    await seedTrip();
    const request = baseRequest({amountMinor: 250});
    const first = await recordSavingsTransactionCore(db, MEMBER_UID, request);
    assert.equal(first.balanceMinor, 1250);

    await db
      .collection("trips")
      .doc(TRIP_ID)
      .update({
        ownershipModelState: "needs_reconciliation",
        ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
      });

    const replay = await recordSavingsTransactionCore(db, MEMBER_UID, request);
    assert.deepEqual(replay, first);

    await assertRejectsWithCode(
      recordSavingsTransactionCore(db, MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
  });
});

// ---------------------------------------------------------------------
// Conflicting idempotency payload during quiescence (Checkpoint
// 5B.3A, item 3) - a reused clientRequestId with a CONFLICTING payload
// must never be treated as exact replay, in EITHER quiescence state,
// and must never mutate anything.
// ---------------------------------------------------------------------

describe("conflicting savings-transaction payload during quiescence never counts as replay", () => {
  for (const state of ["migrating", "needs_reconciliation"] as const) {
    it(`a reused clientRequestId with a different amountMinor rejects while ${state}`, async () => {
      await seedTrip();
      const request = baseRequest({amountMinor: 250});
      await recordSavingsTransactionCore(db, MEMBER_UID, request);

      await db
        .collection("trips")
        .doc(TRIP_ID)
        .update({
          ownershipModelState: state,
          ...(state === "needs_reconciliation" ?
            {ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION} :
            {}),
        });

      const conflictingRequest = {...request, amountMinor: 999};
      await assertRejectsWithCode(
        recordSavingsTransactionCore(db, MEMBER_UID, conflictingRequest),
        "already-exists"
      );

      const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
      assert.equal(tripSnap.data()?.ledgerBalanceMinor, 1250);
    });
  }
});

// ---------------------------------------------------------------------
// Corrupt / unsupported state (Checkpoint 5B.3, item 30) - every
// mutation fails closed, never falling back to aggregate-only.
// ---------------------------------------------------------------------

describe("corrupt / unsupported ownership model state - fails closed", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["version present with absent state", {ownershipModelVersion: 1}],
    ["migrating with a version present", {
      ownershipModelState: "migrating",
      ownershipModelVersion: 1,
    }],
    ["initialized without a version", {ownershipModelState: "initialized"}],
    ["initialized with an unsupported version", {
      ownershipModelState: "initialized",
      ownershipModelVersion: 999,
    }],
    ["needs_reconciliation missing a version", {
      ownershipModelState: "needs_reconciliation",
    }],
    ["an unknown state string", {ownershipModelState: "bogus"}],
  ];

  for (const [label, overrides] of cases) {
    it(`${label} rejects a new contribution, and never creates an ownership row (Checkpoint 5B.3C)`, async () => {
      await seedTrip(overrides);
      await assertRejectsWithCode(
        recordSavingsTransactionCore(db, MEMBER_UID, baseRequest()),
        "failed-precondition"
      );
      const rowSnap = await db
        .collection("tripMemberOwnership")
        .doc(ownershipId(TRIP_ID, MEMBER_UID))
        .get();
      assert.equal(rowSnap.exists, false);
    });
  }
});

// ---------------------------------------------------------------------
// Checkpoint 5C.6 - per the frozen docs/audits/
// MULTI_MEMBER_REVERSAL_RECONCILIATION_PREFLIGHT_2026-10-20.md: closing
// the three full-set-reconciliation hardening gaps (existing-row
// contribution, existing-row withdrawal, missing-row contribution).
// Each case proves: failed-precondition; "initialized" ->
// "needs_reconciliation" persisted (exact same version); aggregate
// unchanged; complete ownership set unchanged; no savingsTransactions
// document created.
// ---------------------------------------------------------------------

async function getTripOwnershipState(): Promise<{
  state: unknown;
  version: unknown;
}> {
  const snap = await db.collection("trips").doc(TRIP_ID).get();
  const data = snap.data() ?? {};
  return {
    state: data.ownershipModelState,
    version: data.ownershipModelVersion,
  };
}

describe("5C.6 - existing-row contribution drift", () => {
  it("rejects with failed-precondition, transitions to needs_reconciliation, and mutates nothing", async () => {
    await seedTrip(initializedOverrides(1000));
    // MEMBER_UID has an existing row, but the complete set (50) does not
    // sum to the aggregate (1000) - a genuine drift this hardening pass
    // must now detect for an EXISTING row, not only a missing one.
    await seedOwnership(TRIP_ID, MEMBER_UID, 50);

    const request = baseRequest({amountMinor: 100});
    await assertRejectsWithCode(
      recordSavingsTransactionCore(db, MEMBER_UID, request),
      "failed-precondition"
    );

    const {state, version} = await getTripOwnershipState();
    assert.equal(state, "needs_reconciliation");
    assert.equal(version, CURRENT_TRIP_OWNERSHIP_MODEL_VERSION);
    assert.equal(await getOwnership(MEMBER_UID), 50);
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.ledgerBalanceMinor, 1000);
    const txnSnap = await db
      .collection("savingsTransactions")
      .doc(request.clientRequestId as string)
      .get();
    assert.equal(txnSnap.exists, false);
  });

  it("a healthy (non-drifted) existing-row contribution still succeeds", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, MEMBER_UID, 400);
    await seedOwnership(TRIP_ID, FRIEND_UID, 600);

    const result = await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({amountMinor: 100})
    );
    assert.equal(result.balanceMinor, 1100);
    assert.equal(await getOwnership(MEMBER_UID), 500);
    const {state} = await getTripOwnershipState();
    assert.equal(state, "initialized");
  });

  it("an exact replay of an already-committed existing-row contribution succeeds even after the Trip later becomes needs_reconciliation via this same drift gate", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, MEMBER_UID, 400);
    await seedOwnership(TRIP_ID, FRIEND_UID, 600);
    const request = baseRequest({amountMinor: 100});
    const first = await recordSavingsTransactionCore(db, MEMBER_UID, request);

    // Independently drift the Trip into needs_reconciliation (simulating
    // a later, unrelated out-of-band corruption).
    await db.collection("trips").doc(TRIP_ID).update({
      ownershipModelState: "needs_reconciliation",
    });

    const replay = await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      request
    );
    assert.deepEqual(replay, first);
  });
});

describe("5C.6 - existing-row withdrawal drift", () => {
  it("rejects with failed-precondition, transitions to needs_reconciliation, and mutates nothing", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, MEMBER_UID, 500);
    // Complete set sums to 500, not the aggregate's 1000 - drift.

    const request = baseRequest({
      type: "withdrawal",
      amountMinor: 100,
    });
    await assertRejectsWithCode(
      recordSavingsTransactionCore(db, MEMBER_UID, request),
      "failed-precondition"
    );

    const {state, version} = await getTripOwnershipState();
    assert.equal(state, "needs_reconciliation");
    assert.equal(version, CURRENT_TRIP_OWNERSHIP_MODEL_VERSION);
    assert.equal(await getOwnership(MEMBER_UID), 500);
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.ledgerBalanceMinor, 1000);
    const txnSnap = await db
      .collection("savingsTransactions")
      .doc(request.clientRequestId as string)
      .get();
    assert.equal(txnSnap.exists, false);
  });

  it("a healthy (non-drifted) existing-row withdrawal still succeeds", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, MEMBER_UID, 400);
    await seedOwnership(TRIP_ID, FRIEND_UID, 600);

    const result = await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({type: "withdrawal", amountMinor: 100})
    );
    assert.equal(result.balanceMinor, 900);
    assert.equal(await getOwnership(MEMBER_UID), 300);
  });
});

describe("5C.6 - missing-row contribution drift transitions to needs_reconciliation", () => {
  it("rejects with failed-precondition and now ALSO transitions to needs_reconciliation (closing the frozen deferral)", async () => {
    await seedTrip(initializedOverrides(1000));
    await seedOwnership(TRIP_ID, FRIEND_UID, 50);
    // No row for MEMBER_UID - existing set sums to 50, not 1000.

    const request = baseRequest({amountMinor: 100});
    await assertRejectsWithCode(
      recordSavingsTransactionCore(db, MEMBER_UID, request),
      "failed-precondition"
    );

    const {state, version} = await getTripOwnershipState();
    assert.equal(state, "needs_reconciliation");
    assert.equal(version, CURRENT_TRIP_OWNERSHIP_MODEL_VERSION);
    assert.equal(await getOwnership(MEMBER_UID), undefined);
    assert.equal(await getOwnership(FRIEND_UID), 50);
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.ledgerBalanceMinor, 1000);
    const txnSnap = await db
      .collection("savingsTransactions")
      .doc(request.clientRequestId as string)
      .get();
    assert.equal(txnSnap.exists, false);
  });
});

describe("5C.6 - missing-row withdrawal remains unchanged (no new reconciliation scan)", () => {
  it("rejects immediately on a missing row, without scanning the full ownership set or transitioning the Trip, even while OTHER rows are drifted", async () => {
    await seedTrip(initializedOverrides(1000));
    // The complete set (FRIEND_UID=50) does not sum to the aggregate
    // (1000) - a real drift exists, but a missing-row withdrawal must
    // reject on its own frozen ceiling alone, never running the
    // full-set scan that would otherwise detect and flag this drift.
    await seedOwnership(TRIP_ID, FRIEND_UID, 50);

    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({type: "withdrawal", amountMinor: 1})
      ),
      "failed-precondition"
    );

    const {state} = await getTripOwnershipState();
    assert.equal(state, "initialized");
    assert.equal(await getOwnership(MEMBER_UID), undefined);
    assert.equal(await getOwnership(FRIEND_UID), 50);
  });
});
