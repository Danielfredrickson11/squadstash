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

    const result = await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({amountMinor: 50})
    );

    assert.equal(result.balanceMinor, 1050);
    assert.equal(await getOwnership(MEMBER_UID), 50);
  });

  it("missing acting ownership row rejects (never silently invented)", async () => {
    await seedTrip(initializedOverrides(1000));
    // No ownership row seeded for MEMBER_UID.
    await assertRejectsWithCode(
      recordSavingsTransactionCore(db, MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()?.ledgerBalanceMinor, 1000);
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
    // No ownership row - this contribution must fail closed.
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

  it("missing acting ownership row rejects, never treated as zero/unlimited", async () => {
    await seedTrip(initializedOverrides(1000));
    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({type: "withdrawal", amountMinor: 1})
      ),
      "failed-precondition"
    );
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
  it("rejects a new contribution", async () => {
    await seedTrip({ownershipModelState: "migrating"});
    await assertRejectsWithCode(
      recordSavingsTransactionCore(db, MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
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
  it("rejects a new contribution", async () => {
    await seedTrip({
      ownershipModelState: "needs_reconciliation",
      ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
    });
    await assertRejectsWithCode(
      recordSavingsTransactionCore(db, MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
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
    it(`${label} rejects a new contribution`, async () => {
      await seedTrip(overrides);
      await assertRejectsWithCode(
        recordSavingsTransactionCore(db, MEMBER_UID, baseRequest()),
        "failed-precondition"
      );
    });
  }
});
