// Tests for recordTripExpenseCore against the local Firestore emulator via
// the Admin SDK - never production, guarded below. Run via
// `npm --prefix functions test`, wrapped in
// `firebase emulators:exec --only firestore "..."` so
// FIRESTORE_EMULATOR_HOST is set automatically (the same mechanism
// createBucketCore.ts/recordSavingsTransactionCore.ts already rely on).
//
// Checkpoint 4C.2A first-pass coverage only (docs/audits/
// TRIP_OUT_OF_POCKET_EXPENSE_PERSISTENCE_PREFLIGHT_2026-09-15.md, as
// hardened by 4C.1A/4C.1B) - the full threat-model sweep is deferred to
// 4C.2C.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import type { App } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import type { CallableRequest } from "firebase-functions/v2/https";
import {
  recordTripExpenseCore,
  requireAuthenticatedUid,
} from "../src/callables/recordTripExpense";
import { splitDocumentId } from "../src/domain/tripExpenseSplits";

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
  // A distinct "demo-" project id from every other functions test file's
  // own test app (createBucketCore.ts, recordSavingsTransactionCore.ts) -
  // Node's test runner executes test FILES concurrently by default, so
  // sharing a project id would let this file's per-test clearFirestore()
  // race with and wipe out documents a concurrently-running suite just
  // seeded (and vice versa).
  app = initializeApp({
    projectId: "demo-squadstash-functions-test-record-trip-expense",
  });
  db = getFirestore(app);
});

after(async () => {
  await deleteApp(app);
});

async function clearFirestore(): Promise<void> {
  for (const name of ["trips", "tripExpenses", "tripExpenseSplits"]) {
    const snap = await db.collection(name).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

beforeEach(async () => {
  await clearFirestore();
});

function seedTrip(
  overrides: Record<string, unknown> = {}
): Promise<FirebaseFirestore.WriteResult> {
  return db
    .collection("trips")
    .doc(TRIP_ID)
    .set({
      ownerId: OWNER_UID,
      memberIds: [OWNER_UID, MEMBER_UID, OTHER_MEMBER_UID],
      title: "Test Trip",
      location: "Somewhere",
      target: 1000,
      saved: 0,
      imageUrl: "https://example.com/trip.jpg",
      tripStartDate: "2027-06-12",
      ...overrides,
    });
}

function baseEqualRequest(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    tripId: TRIP_ID,
    payerUid: MEMBER_UID,
    amountMinor: 9000,
    currency: "USD",
    description: "Cabin rental",
    splitStrategy: "equal",
    participants: [
      { uid: OWNER_UID },
      { uid: MEMBER_UID },
      { uid: OTHER_MEMBER_UID },
    ],
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

// Checkpoint 4C.3D helpers - correction-link (replacesExpenseId /
// replacedByExpenseId) test fixtures.
const FOURTH_MEMBER_UID = "fourth-member-uid";
const SECOND_TRIP_ID = "test-trip-2";

function seedSecondTrip(
  overrides: Record<string, unknown> = {}
): Promise<FirebaseFirestore.WriteResult> {
  return db
    .collection("trips")
    .doc(SECOND_TRIP_ID)
    .set({
      ownerId: OWNER_UID,
      memberIds: [OWNER_UID, MEMBER_UID],
      title: "Second Trip",
      location: "Elsewhere",
      target: 500,
      saved: 0,
      imageUrl: "https://example.com/trip2.jpg",
      tripStartDate: "2027-07-01",
      ...overrides,
    });
}

// Builds an ordinary Expense via the real recordTripExpenseCore (so its
// creationRequest/financial facts are fully realistic), then directly
// flips it to "reversed" via the Admin SDK - reverseTripExpense.ts itself
// is deliberately NOT touched or imported in this checkpoint, so this is
// the self-contained way to construct a correction TARGET fixture.
async function createAndReverseExpense(
  creatorUid: string,
  reverserUid: string,
  requestOverrides: Record<string, unknown> = {}
): Promise<string> {
  const result = await recordTripExpenseCore(
    db,
    creatorUid,
    baseEqualRequest(requestOverrides)
  );
  await db
    .collection("tripExpenses")
    .doc(result.expenseId)
    .update({
      status: "reversed",
      reversedAt: new Date(),
      reversedBy: reverserUid,
      reversalRequest: {clientRequestId: randomUUID(), reversalReason: null},
    });
  return result.expenseId;
}

function baseCorrectionRequest(
  oldExpenseId: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return baseEqualRequest({
    replacesExpenseId: oldExpenseId,
    clientRequestId: randomUUID(),
    ...overrides,
  });
}

async function getExpense(
  expenseId: string
): Promise<FirebaseFirestore.DocumentData | undefined> {
  const snap = await db.collection("tripExpenses").doc(expenseId).get();
  return snap.data();
}

describe("recordTripExpenseCore - persisted Expense/Split shape", () => {
  it("1. active Trip + valid equal split persists Expense + all Splits", async () => {
    await seedTrip();
    const result = await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseEqualRequest()
    );
    assert.equal(result.expenseId.length > 0, true);

    const expenseSnap = await db
      .collection("tripExpenses")
      .doc(result.expenseId)
      .get();
    assert.equal(expenseSnap.exists, true);

    const splitsSnap = await db.collection("tripExpenseSplits").get();
    assert.equal(splitsSnap.size, 3);
    const amounts = splitsSnap.docs.map((d) => d.data().amountMinor).sort();
    assert.deepEqual(amounts, [3000, 3000, 3000]);
    // Checkpoint 4C.2A.1 (§6): every persisted Split has its own
    // server-populated createdAt, not just the parent Expense.
    assert.equal(
      splitsSnap.docs.every((d) => !!d.data().createdAt),
      true
    );
  });

  it("6b. Expense.occurredAt persists as a Firestore Timestamp representing the supplied instant (Checkpoint 4C.2A.1)", async () => {
    await seedTrip();
    const result = await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseEqualRequest({ occurredAt: "2027-03-15T12:30:00.000Z" })
    );
    const snap = await db.collection("tripExpenses").doc(result.expenseId).get();
    const occurredAt = snap.data()!.occurredAt;
    assert.ok(occurredAt, "occurredAt should be populated");
    assert.equal(
      typeof occurredAt.toMillis === "function",
      true,
      "occurredAt should be a Firestore Timestamp"
    );
    assert.equal(occurredAt.toMillis(), Date.parse("2027-03-15T12:30:00.000Z"));
  });

  it("2. percentage split persists deterministic largest-remainder results", async () => {
    await seedTrip();
    const result = await recordTripExpenseCore(db, MEMBER_UID, {
      ...baseEqualRequest(),
      amountMinor: 100,
      splitStrategy: "percentage",
      participants: [
        { uid: OWNER_UID, percentageBasisPoints: 3333 },
        { uid: MEMBER_UID, percentageBasisPoints: 3333 },
        { uid: OTHER_MEMBER_UID, percentageBasisPoints: 3334 },
      ],
    });

    const splitsSnap = await db
      .collection("tripExpenseSplits")
      .where("expenseId", "==", result.expenseId)
      .get();
    const byUser = new Map(
      splitsSnap.docs.map((d) => [d.data().userId, d.data().amountMinor])
    );
    // 3333bps -> floor(333300/10000)=33, remainder 3300 (x2).
    // 3334bps -> floor(333400/10000)=33, remainder 3400 (largest) -> +1.
    assert.equal(byUser.get(OWNER_UID), 33);
    assert.equal(byUser.get(MEMBER_UID), 33);
    assert.equal(byUser.get(OTHER_MEMBER_UID), 34);
    assert.equal(
      splitsSnap.docs.find((d) => d.data().userId === OTHER_MEMBER_UID)
        ?.data().percentageBasisPoints,
      3334
    );
  });

  it("3. custom split persists exact custom values", async () => {
    await seedTrip();
    const result = await recordTripExpenseCore(db, MEMBER_UID, {
      ...baseEqualRequest(),
      amountMinor: 1000,
      splitStrategy: "custom",
      participants: [
        { uid: OWNER_UID, amountMinor: 400 },
        { uid: MEMBER_UID, amountMinor: 600 },
      ],
    });

    const splitsSnap = await db
      .collection("tripExpenseSplits")
      .where("expenseId", "==", result.expenseId)
      .get();
    const byUser = new Map(
      splitsSnap.docs.map((d) => [d.data().userId, d.data().amountMinor])
    );
    assert.equal(byUser.get(OWNER_UID), 400);
    assert.equal(byUser.get(MEMBER_UID), 600);
    assert.equal(
      splitsSnap.docs.every((d) => !("percentageBasisPoints" in d.data())),
      true
    );
  });

  it("4./8. persisted createdBy is authUid, never client-controlled, even when payer differs from creator", async () => {
    await seedTrip();
    const result = await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseEqualRequest({ payerUid: OTHER_MEMBER_UID })
    );
    const snap = await db.collection("tripExpenses").doc(result.expenseId).get();
    const data = snap.data()!;
    assert.equal(data.createdBy, MEMBER_UID);
    assert.equal(data.payerUid, OTHER_MEMBER_UID);
  });

  it("5. createdAt exists server-side", async () => {
    await seedTrip();
    const result = await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseEqualRequest()
    );
    const snap = await db.collection("tripExpenses").doc(result.expenseId).get();
    assert.ok(snap.data()!.createdAt, "createdAt should be populated");
  });

  it("6. status is active", async () => {
    await seedTrip();
    const result = await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseEqualRequest()
    );
    const snap = await db.collection("tripExpenses").doc(result.expenseId).get();
    assert.equal(snap.data()!.status, "active");
  });

  it("7. paymentSource persists member_out_of_pocket", async () => {
    await seedTrip();
    const result = await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseEqualRequest()
    );
    const snap = await db.collection("tripExpenses").doc(result.expenseId).get();
    assert.equal(snap.data()!.paymentSource, "member_out_of_pocket");
  });
});

describe("recordTripExpenseCore - creator-bound idempotency (Checkpoint 4C.1A)", () => {
  it("9. exact same creator + same clientRequestId + same normalized facts replays successfully without duplicate writes", async () => {
    await seedTrip();
    const request = baseEqualRequest();

    const first = await recordTripExpenseCore(db, MEMBER_UID, request);
    const second = await recordTripExpenseCore(db, MEMBER_UID, request);

    assert.equal(first.expenseId, second.expenseId);
    const expensesSnap = await db.collection("tripExpenses").get();
    assert.equal(expensesSnap.size, 1);
    const splitsSnap = await db.collection("tripExpenseSplits").get();
    assert.equal(splitsSnap.size, 3);
  });

  it("10. same id + different facts -> already-exists", async () => {
    await seedTrip();
    const clientRequestId = randomUUID();
    await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseEqualRequest({ clientRequestId })
    );

    await assertRejectsWithCode(
      recordTripExpenseCore(
        db,
        MEMBER_UID,
        baseEqualRequest({ clientRequestId, amountMinor: 12000 })
      ),
      "already-exists"
    );
  });

  it("11. different authenticated member + same id + identical facts -> already-exists", async () => {
    await seedTrip();
    const request = baseEqualRequest();
    await recordTripExpenseCore(db, MEMBER_UID, request);

    await assertRejectsWithCode(
      recordTripExpenseCore(db, OTHER_MEMBER_UID, request),
      "already-exists"
    );
  });

  it("20. equivalent occurredAt ISO strings representing the same instant replay as identical facts", async () => {
    await seedTrip();
    const clientRequestId = randomUUID();
    await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseEqualRequest({
        clientRequestId,
        occurredAt: "2027-01-01T00:00:00.000Z",
      })
    );

    // Same instant, different textual ISO representation.
    const replay = await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseEqualRequest({
        clientRequestId,
        occurredAt: "2027-01-01T00:00:00+00:00",
      })
    );
    assert.equal(replay.expenseId, clientRequestId);

    const expensesSnap = await db.collection("tripExpenses").get();
    assert.equal(expensesSnap.size, 1);
  });
});

describe("recordTripExpenseCore - participant order normalization (Checkpoint 4C.2A.1)", () => {
  it("25. equal split: reordering the participants array does not change request identity", async () => {
    await seedTrip();
    const clientRequestId = randomUUID();
    await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseEqualRequest({
        clientRequestId,
        participants: [
          { uid: OWNER_UID },
          { uid: MEMBER_UID },
          { uid: OTHER_MEMBER_UID },
        ],
      })
    );

    // Same logical set, different array order - harmless client-side
    // ordering must reconcile as the identical request, not already-exists.
    const replay = await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseEqualRequest({
        clientRequestId,
        participants: [
          { uid: OTHER_MEMBER_UID },
          { uid: OWNER_UID },
          { uid: MEMBER_UID },
        ],
      })
    );
    assert.equal(replay.expenseId, clientRequestId);

    const expensesSnap = await db.collection("tripExpenses").get();
    assert.equal(expensesSnap.size, 1);
    const splitsSnap = await db.collection("tripExpenseSplits").get();
    assert.equal(splitsSnap.size, 3);
  });

  it("26. percentage split: uid/value pairing survives reordering (a value must never follow its position instead of its uid)", async () => {
    await seedTrip();
    const clientRequestId = randomUUID();
    await recordTripExpenseCore(db, MEMBER_UID, {
      ...baseEqualRequest({ clientRequestId }),
      amountMinor: 100,
      splitStrategy: "percentage",
      participants: [
        { uid: OWNER_UID, percentageBasisPoints: 3000 },
        { uid: MEMBER_UID, percentageBasisPoints: 3000 },
        { uid: OTHER_MEMBER_UID, percentageBasisPoints: 4000 },
      ],
    });

    // Same uids and same per-uid values, reordered - if the
    // implementation ever sorted a bare uid array and a bare value array
    // independently instead of sorting whole participant objects, this
    // reordering would silently reassign OTHER_MEMBER_UID's 4000bps to a
    // different uid and this replay would incorrectly fail as
    // already-exists (or worse, succeed with corrupted facts).
    const replay = await recordTripExpenseCore(db, MEMBER_UID, {
      ...baseEqualRequest({ clientRequestId }),
      amountMinor: 100,
      splitStrategy: "percentage",
      participants: [
        { uid: OTHER_MEMBER_UID, percentageBasisPoints: 4000 },
        { uid: OWNER_UID, percentageBasisPoints: 3000 },
        { uid: MEMBER_UID, percentageBasisPoints: 3000 },
      ],
    });
    assert.equal(replay.expenseId, clientRequestId);

    const expensesSnap = await db.collection("tripExpenses").get();
    assert.equal(expensesSnap.size, 1);
    const splitsSnap = await db
      .collection("tripExpenseSplits")
      .where("expenseId", "==", clientRequestId)
      .get();
    assert.equal(splitsSnap.size, 3);
    const byUser = new Map(
      splitsSnap.docs.map((d) => [
        d.data().userId,
        d.data().percentageBasisPoints,
      ])
    );
    assert.equal(byUser.get(OTHER_MEMBER_UID), 4000);
    assert.equal(byUser.get(OWNER_UID), 3000);
    assert.equal(byUser.get(MEMBER_UID), 3000);
  });
});

describe("recordTripExpenseCore - archive interaction (Checkpoint 4C.1A/4C.1B ordering)", () => {
  it("12. exact original creator replay after Trip later archives -> success", async () => {
    await seedTrip();
    const request = baseEqualRequest();
    const first = await recordTripExpenseCore(db, MEMBER_UID, request);

    await db.collection("trips").doc(TRIP_ID).update({
      archivedAt: new Date(),
      archivedBy: OWNER_UID,
    });

    const replay = await recordTripExpenseCore(db, MEMBER_UID, request);
    assert.equal(replay.expenseId, first.expenseId);
    const expensesSnap = await db.collection("tripExpenses").get();
    assert.equal(expensesSnap.size, 1);
  });

  it("13. new request against archived Trip -> failed-precondition", async () => {
    await seedTrip({ archivedAt: new Date(), archivedBy: OWNER_UID });
    await assertRejectsWithCode(
      recordTripExpenseCore(db, MEMBER_UID, baseEqualRequest()),
      "failed-precondition"
    );
  });

  it("14. non-member caller -> permission-denied before archive disclosure", async () => {
    await seedTrip({ archivedAt: new Date(), archivedBy: OWNER_UID });
    await assertRejectsWithCode(
      recordTripExpenseCore(db, OUTSIDER_UID, baseEqualRequest()),
      "permission-denied"
    );
  });

  it("24. original creator's exact replay reconciles successfully even after that creator is later removed from Trip membership (Checkpoint 4C.2A.1)", async () => {
    await seedTrip();
    const request = baseEqualRequest();
    const first = await recordTripExpenseCore(db, MEMBER_UID, request);

    // Remove MEMBER_UID (the original creator) from the Trip roster -
    // replay must still succeed for THEM, since this is historical
    // reconciliation ("did my request already commit"), never a fresh
    // authorization decision re-evaluated against today's membership.
    await db.collection("trips").doc(TRIP_ID).update({
      memberIds: [OWNER_UID, OTHER_MEMBER_UID],
    });

    const replay = await recordTripExpenseCore(db, MEMBER_UID, request);
    assert.equal(replay.expenseId, first.expenseId);

    const expensesSnap = await db.collection("tripExpenses").get();
    assert.equal(expensesSnap.size, 1);
    const splitsSnap = await db.collection("tripExpenseSplits").get();
    assert.equal(splitsSnap.size, 3);
  });
});

// Checkpoint 4C.2D: the previous transaction ordering required
// tripSnap.exists UNCONDITIONALLY, before the existing-Expense replay/
// collision branch was ever evaluated - so a caller reconciling their own
// already-committed request against an unexpectedly missing parent Trip
// incorrectly received not-found instead of their own successful replay
// (or the generic already-exists a facts/creator mismatch already
// produces). Corrected: the existing-Expense branch now runs first,
// unconditionally on parent Trip existence; only a GENUINELY NEW Expense
// (no existing document for this clientRequestId) requires the parent
// Trip to exist at all.
describe("recordTripExpenseCore - parent-independent replay (Checkpoint 4C.2D)", () => {
  it("A. exact replay succeeds even after the parent Trip document is deleted entirely", async () => {
    await seedTrip();
    const request = baseEqualRequest();
    const first = await recordTripExpenseCore(db, MEMBER_UID, request);

    const expenseBefore = (
      await db.collection("tripExpenses").doc(first.expenseId).get()
    ).data();
    const splitsBefore = (await db.collection("tripExpenseSplits").get()).docs
      .map((d) => ({id: d.id, data: d.data()}))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    await db.collection("trips").doc(TRIP_ID).delete();

    const replay = await recordTripExpenseCore(db, MEMBER_UID, request);
    assert.equal(replay.expenseId, first.expenseId);

    const expensesSnap = await db.collection("tripExpenses").get();
    assert.equal(expensesSnap.size, 1);
    const expenseAfter = (
      await db.collection("tripExpenses").doc(first.expenseId).get()
    ).data();
    assert.deepEqual(expenseAfter, expenseBefore);

    const splitsAfter = (await db.collection("tripExpenseSplits").get()).docs
      .map((d) => ({id: d.id, data: d.data()}))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    assert.deepEqual(splitsAfter, splitsBefore);
  });

  it("B. same creator + same clientRequestId + a changed normalized fact, after the parent Trip is deleted, is already-exists (never not-found), and writes nothing", async () => {
    await seedTrip();
    const clientRequestId = randomUUID();
    await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseEqualRequest({clientRequestId})
    );
    const expenseBefore = (
      await db.collection("tripExpenses").doc(clientRequestId).get()
    ).data();
    const splitsBefore = (await db.collection("tripExpenseSplits").get())
      .size;

    await db.collection("trips").doc(TRIP_ID).delete();

    await assertRejectsWithCode(
      recordTripExpenseCore(
        db,
        MEMBER_UID,
        baseEqualRequest({clientRequestId, amountMinor: 12000})
      ),
      "already-exists"
    );

    const expenseAfter = (
      await db.collection("tripExpenses").doc(clientRequestId).get()
    ).data();
    assert.deepEqual(expenseAfter, expenseBefore);
    const expensesSnap = await db.collection("tripExpenses").get();
    assert.equal(expensesSnap.size, 1);
    const splitsAfter = (await db.collection("tripExpenseSplits").get())
      .size;
    assert.equal(splitsAfter, splitsBefore);
  });

  it("C. a DIFFERENT creator submitting the same clientRequestId and otherwise identical facts, after the parent Trip is deleted, is already-exists (never not-found), disclosing nothing about which fact mismatched", async () => {
    await seedTrip();
    const clientRequestId = randomUUID();
    const request = baseEqualRequest({clientRequestId});
    await recordTripExpenseCore(db, MEMBER_UID, request);
    const expenseBefore = (
      await db.collection("tripExpenses").doc(clientRequestId).get()
    ).data();

    await db.collection("trips").doc(TRIP_ID).delete();

    await assertRejectsWithCode(
      recordTripExpenseCore(db, OTHER_MEMBER_UID, request),
      "already-exists"
    );

    const expenseAfter = (
      await db.collection("tripExpenses").doc(clientRequestId).get()
    ).data();
    assert.deepEqual(expenseAfter, expenseBefore);
    const expensesSnap = await db.collection("tripExpenses").get();
    assert.equal(expensesSnap.size, 1);
  });

  it("D. a genuinely NEW Expense (no existing document for this clientRequestId) against a missing parent Trip is still not-found, with zero Expense/Split writes - the fix does not make new creation tolerant of a missing parent", async () => {
    // Deliberately no seedTrip() at all - the Trip never existed, and no
    // Expense with this clientRequestId exists either.
    await assertRejectsWithCode(
      recordTripExpenseCore(db, MEMBER_UID, baseEqualRequest()),
      "not-found"
    );

    const expensesSnap = await db.collection("tripExpenses").get();
    assert.equal(expensesSnap.size, 0);
    const splitsSnap = await db.collection("tripExpenseSplits").get();
    assert.equal(splitsSnap.size, 0);
  });
});

describe("recordTripExpenseCore - membership validation", () => {
  it("15. non-member payer -> rejected", async () => {
    await seedTrip();
    await assertRejectsWithCode(
      recordTripExpenseCore(
        db,
        MEMBER_UID,
        baseEqualRequest({ payerUid: OUTSIDER_UID })
      ),
      "failed-precondition"
    );
  });

  it("16. non-member participant -> rejected, writing NEITHER an Expense NOR any Split (Checkpoint 4C.2A.1 atomicity assertion)", async () => {
    await seedTrip();
    await assertRejectsWithCode(
      recordTripExpenseCore(
        db,
        MEMBER_UID,
        baseEqualRequest({
          participants: [{ uid: MEMBER_UID }, { uid: OUTSIDER_UID }],
        })
      ),
      "failed-precondition"
    );
    const expensesSnap = await db.collection("tripExpenses").get();
    assert.equal(expensesSnap.size, 0);
    const splitsSnap = await db.collection("tripExpenseSplits").get();
    assert.equal(splitsSnap.size, 0);
  });
});

describe("recordTripExpenseCore - input validation", () => {
  it("17. split-math invalid input -> invalid-argument", async () => {
    await seedTrip();
    await assertRejectsWithCode(
      recordTripExpenseCore(db, MEMBER_UID, {
        ...baseEqualRequest(),
        splitStrategy: "percentage",
        participants: [
          { uid: OWNER_UID, percentageBasisPoints: 4000 },
          { uid: MEMBER_UID, percentageBasisPoints: 4000 },
        ], // sums to 8000, not 10000
      }),
      "invalid-argument"
    );
  });

  it("18. receiptImageUrl injection -> invalid-argument", async () => {
    await seedTrip();
    await assertRejectsWithCode(
      recordTripExpenseCore(db, MEMBER_UID, {
        ...baseEqualRequest(),
        receiptImageUrl: "https://example.com/receipt.jpg",
      }),
      "invalid-argument"
    );
  });

  it("19. shared_stash paymentSource -> invalid-argument", async () => {
    await seedTrip();
    await assertRejectsWithCode(
      recordTripExpenseCore(db, MEMBER_UID, {
        ...baseEqualRequest(),
        paymentSource: "shared_stash",
      }),
      "invalid-argument"
    );
  });

  it("27. createdBy injection -> invalid-argument, no Expense or Split written (Checkpoint 4C.2A.1)", async () => {
    await seedTrip();
    await assertRejectsWithCode(
      recordTripExpenseCore(db, MEMBER_UID, {
        ...baseEqualRequest(),
        createdBy: "forged-user",
      }),
      "invalid-argument"
    );
    const expensesSnap = await db.collection("tripExpenses").get();
    assert.equal(expensesSnap.size, 0);
    const splitsSnap = await db.collection("tripExpenseSplits").get();
    assert.equal(splitsSnap.size, 0);
  });
});

describe("recordTripExpenseCore - occurredAt contract hardening (Checkpoint 4C.2A.1)", () => {
  it("28a. accepts an explicit-timezone ISO instant with milliseconds and a trailing Z", async () => {
    await seedTrip();
    await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseEqualRequest({ occurredAt: "2027-01-01T00:00:00.000Z" })
    );
  });

  it("28b. accepts an explicit-timezone ISO instant with a bare trailing Z", async () => {
    await seedTrip();
    await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseEqualRequest({ occurredAt: "2027-01-01T00:00:00Z" })
    );
  });

  it("28c. accepts an explicit-timezone ISO instant with a numeric UTC offset", async () => {
    await seedTrip();
    await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseEqualRequest({ occurredAt: "2027-01-01T01:00:00+01:00" })
    );
  });

  it("29a. rejects a slash-delimited date -> invalid-argument", async () => {
    await seedTrip();
    await assertRejectsWithCode(
      recordTripExpenseCore(
        db,
        MEMBER_UID,
        baseEqualRequest({ occurredAt: "01/01/2027" })
      ),
      "invalid-argument"
    );
  });

  it("29b. rejects a locale-formatted date -> invalid-argument", async () => {
    await seedTrip();
    await assertRejectsWithCode(
      recordTripExpenseCore(
        db,
        MEMBER_UID,
        baseEqualRequest({ occurredAt: "January 1, 2027" })
      ),
      "invalid-argument"
    );
  });

  it("29c. rejects a date-only ISO string with no time/timezone -> invalid-argument", async () => {
    await seedTrip();
    await assertRejectsWithCode(
      recordTripExpenseCore(
        db,
        MEMBER_UID,
        baseEqualRequest({ occurredAt: "2027-01-01" })
      ),
      "invalid-argument"
    );
  });

  it("30. a syntactically valid but Firestore-unrepresentable instant is invalid-argument, not an uncaught exception", async () => {
    await seedTrip();
    // Matches the 4-digit-year ISO pattern and parses via Date.parse, but
    // year 0000 predates Firestore's minimum representable Timestamp
    // (0001-01-01T00:00:00Z) - Timestamp.fromDate must throw, and that
    // throw must be caught and surfaced as invalid-argument, not leak an
    // unexpected internal exception out of recordTripExpenseCore.
    await assertRejectsWithCode(
      recordTripExpenseCore(
        db,
        MEMBER_UID,
        baseEqualRequest({ occurredAt: "0000-01-01T00:00:00Z" })
      ),
      "invalid-argument"
    );
  });
});

describe("recordTripExpenseCore - atomic all-or-nothing writes (Checkpoint 4C.2A.1)", () => {
  it("31. invalid split math writes NEITHER an Expense NOR any Split document", async () => {
    await seedTrip();
    await assertRejectsWithCode(
      recordTripExpenseCore(db, MEMBER_UID, {
        ...baseEqualRequest(),
        splitStrategy: "percentage",
        participants: [
          { uid: OWNER_UID, percentageBasisPoints: 4000 },
          { uid: MEMBER_UID, percentageBasisPoints: 4000 },
        ], // sums to 8000, not 10000
      }),
      "invalid-argument"
    );
    const expensesSnap = await db.collection("tripExpenses").get();
    assert.equal(expensesSnap.size, 0);
    const splitsSnap = await db.collection("tripExpenseSplits").get();
    assert.equal(splitsSnap.size, 0);
  });
});

describe("splitDocumentId - collision-safe derivation (Checkpoint 4C.1B)", () => {
  it("21. same pair -> same splitDocumentId", () => {
    const a = splitDocumentId("expense-1", "uid-1");
    const b = splitDocumentId("expense-1", "uid-1");
    assert.equal(a, b);
  });

  it('22. ("abc_def","ghi") and ("abc","def_ghi") -> DIFFERENT ids', () => {
    const idA = splitDocumentId("abc_def", "ghi");
    const idB = splitDocumentId("abc", "def_ghi");
    assert.notEqual(idA, idB);
  });

  it("23. stable across repeated calls", () => {
    const expected = splitDocumentId("expense-7", "uid-9");
    for (let i = 0; i < 5; i++) {
      assert.equal(splitDocumentId("expense-7", "uid-9"), expected);
    }
  });

  it("25. the SAME participant uid across two DIFFERENT Expense ids produces two DIFFERENT split document ids (Checkpoint 4C.2D evidence gap)", () => {
    const idOnExpenseA = splitDocumentId("expense-A", "member-1");
    const idOnExpenseB = splitDocumentId("expense-B", "member-1");
    assert.notEqual(idOnExpenseA, idOnExpenseB);
  });
});

// Checkpoint 4C.2C: deep security/concurrency/resource-boundary hardening
// pass - the final backend checkpoint before deployment consideration for
// out-of-pocket Expense creation.
describe("recordTripExpenseCore - same-id concurrency (Checkpoint 4C.2C §3)", () => {
  it("A. concurrent identical requests from the same creator resolve to the same Expense with no duplicate writes", async () => {
    await seedTrip();
    const request = baseEqualRequest();

    const [r1, r2] = await Promise.all([
      recordTripExpenseCore(db, MEMBER_UID, request),
      recordTripExpenseCore(db, MEMBER_UID, request),
    ]);

    assert.equal(r1.expenseId, r2.expenseId);
    const expensesSnap = await db.collection("tripExpenses").get();
    assert.equal(expensesSnap.size, 1);
    assert.equal(expensesSnap.docs[0]!.data().createdBy, MEMBER_UID);
    const splitsSnap = await db.collection("tripExpenseSplits").get();
    assert.equal(splitsSnap.size, 3);
  });

  it("B. concurrent same-creator requests with different facts leave exactly one committed Expense; the loser sees already-exists", async () => {
    await seedTrip();
    const clientRequestId = randomUUID();
    const reqA = baseEqualRequest({ clientRequestId, amountMinor: 9000 });
    const reqB = baseEqualRequest({ clientRequestId, amountMinor: 12000 });

    const results = await Promise.allSettled([
      recordTripExpenseCore(db, MEMBER_UID, reqA),
      recordTripExpenseCore(db, MEMBER_UID, reqB),
    ]);

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<{ expenseId: string }> =>
        r.status === "fulfilled"
    );
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected"
    );
    // Do NOT assume which request wins - only that exactly one does.
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]!.reason instanceof HttpsError);
    assert.equal((rejected[0]!.reason as HttpsError).code, "already-exists");

    const expensesSnap = await db.collection("tripExpenses").get();
    assert.equal(expensesSnap.size, 1);
    const winningAmount = expensesSnap.docs[0]!.data().amountMinor;
    assert.ok(winningAmount === 9000 || winningAmount === 12000);

    // Final Split records must exactly match the winning Expense, never a
    // mix of both versions.
    const splitsSnap = await db.collection("tripExpenseSplits").get();
    assert.equal(splitsSnap.size, 3);
    const splitTotal = splitsSnap.docs.reduce(
      (sum, d) => sum + (d.data().amountMinor as number),
      0
    );
    assert.equal(splitTotal, winningAmount);
  });

  it("C. concurrent identical-fact requests from two DIFFERENT creators leave exactly one canonical Expense; the loser sees already-exists", async () => {
    await seedTrip();
    const clientRequestId = randomUUID();
    const request = baseEqualRequest({ clientRequestId });

    const results = await Promise.allSettled([
      recordTripExpenseCore(db, MEMBER_UID, request),
      recordTripExpenseCore(db, OTHER_MEMBER_UID, request),
    ]);

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<{ expenseId: string }> =>
        r.status === "fulfilled"
    );
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected"
    );
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]!.reason instanceof HttpsError);
    assert.equal((rejected[0]!.reason as HttpsError).code, "already-exists");
    assert.equal(fulfilled[0]!.value.expenseId, clientRequestId);

    const expensesSnap = await db.collection("tripExpenses").get();
    assert.equal(expensesSnap.size, 1);
    const winningCreatedBy = expensesSnap.docs[0]!.data().createdBy;
    assert.ok(
      winningCreatedBy === MEMBER_UID || winningCreatedBy === OTHER_MEMBER_UID
    );
    const splitsSnap = await db.collection("tripExpenseSplits").get();
    assert.equal(splitsSnap.size, 3);
  });

  it("D. reusing the same clientRequestId for a DIFFERENT Trip is already-exists, never a second Expense (the id namespace is global by design)", async () => {
    await seedTrip();
    const secondTripId = "test-trip-2";
    await db
      .collection("trips")
      .doc(secondTripId)
      .set({
        ownerId: OWNER_UID,
        memberIds: [OWNER_UID, MEMBER_UID],
        title: "Second Trip",
        location: "Elsewhere",
        target: 500,
        saved: 0,
        imageUrl: "https://example.com/trip2.jpg",
        tripStartDate: "2027-07-01",
      });

    const clientRequestId = randomUUID();
    await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseEqualRequest({ clientRequestId })
    );

    await assertRejectsWithCode(
      recordTripExpenseCore(
        db,
        MEMBER_UID,
        baseEqualRequest({ clientRequestId, tripId: secondTripId })
      ),
      "already-exists"
    );

    const expensesSnap = await db.collection("tripExpenses").get();
    assert.equal(expensesSnap.size, 1);
    assert.equal(expensesSnap.docs[0]!.data().tripId, TRIP_ID);
  });
});

// Checkpoint 4C.2C §4: the Trip document is read INSIDE the same
// transaction that writes the Expense/Splits (recordTripExpenseCore's own
// db.runTransaction body). Firestore's transaction semantics guarantee
// that if the Trip document this transaction already read is modified by
// another COMMITTED write before this transaction itself commits,
// Firestore aborts and transparently retries the transaction body - which
// re-reads the Trip fresh and re-evaluates membership/archive state
// against the NEW data before ever attempting to commit again. This makes
// a stale-authorization commit structurally impossible: by the time an
// Expense transaction actually commits, it has necessarily read a Trip
// state that was still current at commit time, never a state a
// concurrent write later invalidated out from under it.
//
// No production test hook was added to manufacture a deterministic
// winner (the checkpoint explicitly forbids that) - each test below
// fires the Expense transaction and the conflicting Trip mutation via
// Promise.allSettled (both start in the same tick, genuinely
// concurrently) and asserts the INVARIANT that holds under EITHER
// acceptable linearization, never a specific winner. This is why these
// assertions are not flaky despite the real nondeterministic timing:
// nothing here depends on knowing in advance which operation "wins".
describe("recordTripExpenseCore - Trip-state concurrency (Checkpoint 4C.2C §4)", () => {
  it("archive race: an Expense either commits while the Trip was still active, or is rejected failed-precondition - never a stale-active commit", async () => {
    await seedTrip();
    const request = baseEqualRequest();

    const [expenseResult, archiveResult] = await Promise.allSettled([
      recordTripExpenseCore(db, MEMBER_UID, request),
      db
        .collection("trips")
        .doc(TRIP_ID)
        .update({ archivedAt: new Date(), archivedBy: OWNER_UID }),
    ]);

    // The archive update itself is an unconditional Admin SDK write - it
    // always succeeds regardless of how the race resolves.
    assert.equal(archiveResult.status, "fulfilled");

    if (expenseResult.status === "fulfilled") {
      const snap = await db
        .collection("tripExpenses")
        .doc(expenseResult.value.expenseId)
        .get();
      assert.equal(snap.exists, true);
      assert.equal(snap.data()!.status, "active");
    } else {
      assert.ok(expenseResult.reason instanceof HttpsError);
      assert.equal(
        (expenseResult.reason as HttpsError).code,
        "failed-precondition"
      );
      const expensesSnap = await db.collection("tripExpenses").get();
      assert.equal(expensesSnap.size, 0);
    }

    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.ok(tripSnap.data()!.archivedAt);
  });

  it("creator-membership-removal race: an Expense either commits while the creator was still a member, or is rejected permission-denied", async () => {
    await seedTrip();
    const request = baseEqualRequest();

    const [expenseResult] = await Promise.allSettled([
      recordTripExpenseCore(db, MEMBER_UID, request),
      db
        .collection("trips")
        .doc(TRIP_ID)
        .update({ memberIds: [OWNER_UID, OTHER_MEMBER_UID] }),
    ]);

    if (expenseResult.status === "fulfilled") {
      const snap = await db
        .collection("tripExpenses")
        .doc(expenseResult.value.expenseId)
        .get();
      assert.equal(snap.exists, true);
    } else {
      assert.ok(expenseResult.reason instanceof HttpsError);
      assert.equal(
        (expenseResult.reason as HttpsError).code,
        "permission-denied"
      );
      const expensesSnap = await db.collection("tripExpenses").get();
      assert.equal(expensesSnap.size, 0);
    }
  });

  it("payer-membership-removal race: an Expense either commits with a payer who was still a member, or is rejected failed-precondition", async () => {
    await seedTrip();
    const request = baseEqualRequest({ payerUid: OTHER_MEMBER_UID });

    const [expenseResult] = await Promise.allSettled([
      recordTripExpenseCore(db, MEMBER_UID, request),
      db
        .collection("trips")
        .doc(TRIP_ID)
        .update({ memberIds: [OWNER_UID, MEMBER_UID] }), // OTHER_MEMBER_UID removed
    ]);

    if (expenseResult.status === "fulfilled") {
      const snap = await db
        .collection("tripExpenses")
        .doc(expenseResult.value.expenseId)
        .get();
      assert.equal(snap.data()!.payerUid, OTHER_MEMBER_UID);
    } else {
      assert.ok(expenseResult.reason instanceof HttpsError);
      assert.equal(
        (expenseResult.reason as HttpsError).code,
        "failed-precondition"
      );
      const expensesSnap = await db.collection("tripExpenses").get();
      assert.equal(expensesSnap.size, 0);
    }
  });

  it("participant-removal race: an Expense either commits with its original participant set intact, or is rejected failed-precondition with zero Splits written", async () => {
    await seedTrip();
    const request = baseEqualRequest();

    const [expenseResult] = await Promise.allSettled([
      recordTripExpenseCore(db, MEMBER_UID, request),
      db
        .collection("trips")
        .doc(TRIP_ID)
        .update({ memberIds: [OWNER_UID, MEMBER_UID] }), // OTHER_MEMBER_UID (a participant) removed
    ]);

    if (expenseResult.status === "fulfilled") {
      const splitsSnap = await db.collection("tripExpenseSplits").get();
      assert.equal(splitsSnap.size, 3);
    } else {
      assert.ok(expenseResult.reason instanceof HttpsError);
      assert.equal(
        (expenseResult.reason as HttpsError).code,
        "failed-precondition"
      );
      const expensesSnap = await db.collection("tripExpenses").get();
      assert.equal(expensesSnap.size, 0);
      const splitsSnap = await db.collection("tripExpenseSplits").get();
      assert.equal(splitsSnap.size, 0);
    }
  });
});

describe("recordTripExpenseCore - authorization-order information-leak hardening (Checkpoint 4C.2C §5)", () => {
  it("normal Trip + outsider -> permission-denied", async () => {
    await seedTrip();
    await assertRejectsWithCode(
      recordTripExpenseCore(db, OUTSIDER_UID, baseEqualRequest()),
      "permission-denied"
    );
    const expensesSnap = await db.collection("tripExpenses").get();
    assert.equal(expensesSnap.size, 0);
  });

  it("archived Trip + outsider -> permission-denied, not failed-precondition (archive state not disclosed to an unauthorized caller)", async () => {
    await seedTrip({ archivedAt: new Date(), archivedBy: OWNER_UID });
    await assertRejectsWithCode(
      recordTripExpenseCore(db, OUTSIDER_UID, baseEqualRequest()),
      "permission-denied"
    );
  });

  it("malformed (non-list) memberIds + outsider -> permission-denied, not failed-precondition (data-corruption state not disclosed to an unauthorized caller)", async () => {
    await seedTrip({ memberIds: "not-a-list" });
    await assertRejectsWithCode(
      recordTripExpenseCore(db, OUTSIDER_UID, baseEqualRequest()),
      "permission-denied"
    );
    const expensesSnap = await db.collection("tripExpenses").get();
    assert.equal(expensesSnap.size, 0);
  });

  it("malformed (non-list) memberIds + the Trip's actual owner -> failed-precondition (the owner may learn their own Trip is corrupt)", async () => {
    await seedTrip({ memberIds: "not-a-list" });
    await assertRejectsWithCode(
      recordTripExpenseCore(db, OWNER_UID, baseEqualRequest()),
      "failed-precondition"
    );
    const expensesSnap = await db.collection("tripExpenses").get();
    assert.equal(expensesSnap.size, 0);
  });
});

describe('requireAuthenticatedUid - the production auth boundary (Checkpoint 4C.2C §6)', () => {
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

  it("returns the exact uid when auth is present", () => {
    const auth = { uid: MEMBER_UID } as CallableRequest["auth"];
    assert.equal(requireAuthenticatedUid(auth), MEMBER_UID);
  });
});

describe("recordTripExpenseCore - participant count bound (Checkpoint 4C.2C §7, MAX_EXPENSE_PARTICIPANTS = 100)", () => {
  it("exactly 100 participants passes the count bound (fails later for an unrelated, expected reason - never the count itself)", async () => {
    await seedTrip();
    const participants = Array.from({ length: 100 }, (_, i) => ({
      uid: `fake-uid-${i}`,
    }));
    await assertRejectsWithCode(
      recordTripExpenseCore(
        db,
        MEMBER_UID,
        baseEqualRequest({ participants })
      ),
      "failed-precondition"
    );
  });

  it("101 participants is rejected invalid-argument before ever touching Firestore", async () => {
    await seedTrip();
    const participants = Array.from({ length: 101 }, (_, i) => ({
      uid: `fake-uid-${i}`,
    }));
    await assertRejectsWithCode(
      recordTripExpenseCore(
        db,
        MEMBER_UID,
        baseEqualRequest({ participants })
      ),
      "invalid-argument"
    );
    const expensesSnap = await db.collection("tripExpenses").get();
    assert.equal(expensesSnap.size, 0);
  });
});

describe("recordTripExpenseCore - tripId Firestore document-id safety (Checkpoint 4C.2C §8)", () => {
  it("tripId containing \"/\" is invalid-argument, not an uncaught Admin SDK exception", async () => {
    await assertRejectsWithCode(
      recordTripExpenseCore(
        db,
        MEMBER_UID,
        baseEqualRequest({ tripId: "a/b" })
      ),
      "invalid-argument"
    );
  });

  it('tripId === "." is invalid-argument', async () => {
    await assertRejectsWithCode(
      recordTripExpenseCore(db, MEMBER_UID, baseEqualRequest({ tripId: "." })),
      "invalid-argument"
    );
  });

  it('tripId === ".." is invalid-argument', async () => {
    await assertRejectsWithCode(
      recordTripExpenseCore(
        db,
        MEMBER_UID,
        baseEqualRequest({ tripId: ".." })
      ),
      "invalid-argument"
    );
  });

  it("an oversized tripId (over Firestore's 1500-byte document-id limit) is invalid-argument", async () => {
    await assertRejectsWithCode(
      recordTripExpenseCore(
        db,
        MEMBER_UID,
        baseEqualRequest({ tripId: "a".repeat(1501) })
      ),
      "invalid-argument"
    );
  });
});

describe("recordTripExpenseCore - idempotency normalization edge cases (Checkpoint 4C.2C §12)", () => {
  it('paymentSource omitted, then replayed with it explicit "member_out_of_pocket" -> exact replay success', async () => {
    await seedTrip();
    const clientRequestId = randomUUID();
    const first = await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseEqualRequest({ clientRequestId }) // no paymentSource key at all
    );
    const replay = await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseEqualRequest({
        clientRequestId,
        paymentSource: "member_out_of_pocket",
      })
    );
    assert.equal(replay.expenseId, first.expenseId);
    const expensesSnap = await db.collection("tripExpenses").get();
    assert.equal(expensesSnap.size, 1);
  });

  it("a description with surrounding whitespace replays as identical to its already-trimmed form", async () => {
    await seedTrip();
    const clientRequestId = randomUUID();
    await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseEqualRequest({ clientRequestId, description: "Cabin rental" })
    );
    const replay = await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseEqualRequest({ clientRequestId, description: "  Cabin rental  " })
    );
    assert.equal(replay.expenseId, clientRequestId);
    const expensesSnap = await db.collection("tripExpenses").get();
    assert.equal(expensesSnap.size, 1);
    assert.equal(expensesSnap.docs[0]!.data().description, "Cabin rental");
  });

  it("category omitted on both requests -> exact replay success", async () => {
    await seedTrip();
    const clientRequestId = randomUUID();
    const first = await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseEqualRequest({ clientRequestId })
    );
    const replay = await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseEqualRequest({ clientRequestId })
    );
    assert.equal(replay.expenseId, first.expenseId);
    const expensesSnap = await db.collection("tripExpenses").get();
    assert.equal(expensesSnap.size, 1);
  });

  it("category changed on replay -> already-exists, original category unchanged", async () => {
    await seedTrip();
    const clientRequestId = randomUUID();
    await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseEqualRequest({ clientRequestId, category: "Food" })
    );
    await assertRejectsWithCode(
      recordTripExpenseCore(
        db,
        MEMBER_UID,
        baseEqualRequest({ clientRequestId, category: "Lodging" })
      ),
      "already-exists"
    );
    const expensesSnap = await db.collection("tripExpenses").get();
    assert.equal(expensesSnap.size, 1);
    assert.equal(expensesSnap.docs[0]!.data().category, "Food");
  });
});

// Checkpoint 4C.3D: replacesExpenseId / replacedByExpenseId two-way
// correction-link addition to recordTripExpense, per docs/audits/
// TRIP_EXPENSE_REVERSAL_CORRECTION_PREFLIGHT_2026-09-17.md §9. The frozen
// 19-item test matrix from the checkpoint's own §20, numbered to match.
describe("recordTripExpenseCore - correction linking, frozen 19-item matrix (Checkpoint 4C.3D §20)", () => {
  it("1. ordinary Expense creation with NO replacesExpenseId remains fully unaffected", async () => {
    await seedTrip();
    const result = await recordTripExpenseCore(db, MEMBER_UID, baseEqualRequest());

    const data = await getExpense(result.expenseId);
    assert.equal("replacesExpenseId" in (data ?? {}), false);
    assert.equal(data?.creationRequest.replacesExpenseId, null);
  });

  it("2. old Expense's original creator, still a current member, creates the replacement -> SUCCESS", async () => {
    await seedTrip();
    const oldId = await createAndReverseExpense(MEMBER_UID, OWNER_UID);

    const result = await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseCorrectionRequest(oldId)
    );
    assert.ok(result.expenseId.length > 0);
  });

  it("3. current Trip owner, not the original creator/reverser -> SUCCESS", async () => {
    await seedTrip();
    const oldId = await createAndReverseExpense(MEMBER_UID, OTHER_MEMBER_UID);

    const result = await recordTripExpenseCore(
      db,
      OWNER_UID,
      baseCorrectionRequest(oldId)
    );
    assert.ok(result.expenseId.length > 0);
  });

  it("4. oldExpense.reversedBy, still a current member and not the original creator -> SUCCESS", async () => {
    await seedTrip();
    const oldId = await createAndReverseExpense(MEMBER_UID, OTHER_MEMBER_UID);

    const result = await recordTripExpenseCore(
      db,
      OTHER_MEMBER_UID,
      baseCorrectionRequest(oldId)
    );
    assert.ok(result.expenseId.length > 0);
  });

  it("5. an unrelated current Trip member with NO role on the old Expense -> permission-denied before old state disclosure", async () => {
    await seedTrip({
      memberIds: [OWNER_UID, MEMBER_UID, OTHER_MEMBER_UID, FOURTH_MEMBER_UID],
    });
    const oldId = await createAndReverseExpense(OWNER_UID, OWNER_UID, {
      payerUid: MEMBER_UID,
      participants: [{uid: OWNER_UID}, {uid: MEMBER_UID}],
    });
    const oldBefore = await getExpense(oldId);

    const request = baseCorrectionRequest(oldId);
    await assertRejectsWithCode(
      recordTripExpenseCore(db, FOURTH_MEMBER_UID, request),
      "permission-denied"
    );

    const oldAfter = await getExpense(oldId);
    assert.deepEqual(oldAfter, oldBefore);
    const newSnap = await db
      .collection("tripExpenses")
      .doc(request.clientRequestId as string)
      .get();
    assert.equal(newSnap.exists, false);
  });

  it("6. the old Expense's payerUid ALONE, with no other qualifying role -> permission-denied", async () => {
    await seedTrip();
    const oldId = await createAndReverseExpense(OWNER_UID, OWNER_UID, {
      payerUid: MEMBER_UID,
      participants: [{uid: OWNER_UID}, {uid: OTHER_MEMBER_UID}],
    });
    const oldBefore = await getExpense(oldId);

    const request = baseCorrectionRequest(oldId);
    await assertRejectsWithCode(
      recordTripExpenseCore(db, MEMBER_UID, request),
      "permission-denied"
    );

    const oldAfter = await getExpense(oldId);
    assert.deepEqual(oldAfter, oldBefore);
  });

  it("7. a MERE participant alone, with no other qualifying role -> permission-denied", async () => {
    await seedTrip();
    const oldId = await createAndReverseExpense(OWNER_UID, OWNER_UID, {
      payerUid: MEMBER_UID,
      participants: [
        {uid: OWNER_UID},
        {uid: MEMBER_UID},
        {uid: OTHER_MEMBER_UID},
      ],
    });
    const oldBefore = await getExpense(oldId);

    const request = baseCorrectionRequest(oldId);
    await assertRejectsWithCode(
      recordTripExpenseCore(db, OTHER_MEMBER_UID, request),
      "permission-denied"
    );

    const oldAfter = await getExpense(oldId);
    assert.deepEqual(oldAfter, oldBefore);
  });

  it("8. both directional link fields persist atomically", async () => {
    await seedTrip();
    const oldId = await createAndReverseExpense(MEMBER_UID, OWNER_UID);

    const result = await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseCorrectionRequest(oldId)
    );

    const newData = await getExpense(result.expenseId);
    const oldData = await getExpense(oldId);
    assert.equal(newData?.replacesExpenseId, oldId);
    assert.equal(oldData?.replacedByExpenseId, result.expenseId);
  });

  it("9. an ACTIVE old Expense cannot be replaced -> failed-precondition, only after correction authorization succeeds", async () => {
    await seedTrip();
    const first = await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseEqualRequest()
    );
    // Deliberately never reversed - still "active".

    const request = baseCorrectionRequest(first.expenseId);
    await assertRejectsWithCode(
      recordTripExpenseCore(db, MEMBER_UID, request), // MEMBER_UID is createdBy - authorized
      "failed-precondition"
    );

    const oldAfter = await getExpense(first.expenseId);
    assert.equal(oldAfter?.status, "active");
    assert.equal("replacedByExpenseId" in (oldAfter ?? {}), false);
  });

  it("10. a cross-Trip replacement target -> failed-precondition", async () => {
    await seedTrip();
    await seedSecondTrip();
    const oldIdOnSecondTrip = await createAndReverseExpense(
      OWNER_UID,
      OWNER_UID,
      {
        tripId: SECOND_TRIP_ID,
        // SECOND_TRIP_ID's own membership is only OWNER_UID/MEMBER_UID -
        // the default participants list (which includes OTHER_MEMBER_UID)
        // would otherwise fail this fixture's own setup.
        payerUid: MEMBER_UID,
        participants: [{uid: OWNER_UID}, {uid: MEMBER_UID}],
      }
    );
    const oldBefore = await getExpense(oldIdOnSecondTrip);

    await assertRejectsWithCode(
      recordTripExpenseCore(
        db,
        OWNER_UID,
        baseCorrectionRequest(oldIdOnSecondTrip)
      ), // tripId defaults to TRIP_ID, old Expense belongs to SECOND_TRIP_ID
      "failed-precondition"
    );

    const oldAfter = await getExpense(oldIdOnSecondTrip);
    assert.deepEqual(oldAfter, oldBefore);
  });

  it("11. a nonexistent old Expense reference -> failed-precondition", async () => {
    await seedTrip();
    const request = baseCorrectionRequest("nonexistent-old-expense-id");

    await assertRejectsWithCode(
      recordTripExpenseCore(db, MEMBER_UID, request),
      "failed-precondition"
    );

    const newSnap = await db
      .collection("tripExpenses")
      .doc(request.clientRequestId as string)
      .get();
    assert.equal(newSnap.exists, false);
  });

  it("12. an already-replaced old Expense cannot receive a second replacement -> failed-precondition", async () => {
    await seedTrip();
    const oldId = await createAndReverseExpense(MEMBER_UID, OWNER_UID);
    await recordTripExpenseCore(db, MEMBER_UID, baseCorrectionRequest(oldId));
    const oldAfterFirst = await getExpense(oldId);

    const secondRequest = baseCorrectionRequest(oldId);
    await assertRejectsWithCode(
      recordTripExpenseCore(db, MEMBER_UID, secondRequest),
      "failed-precondition"
    );

    const oldAfterSecond = await getExpense(oldId);
    assert.deepEqual(oldAfterSecond, oldAfterFirst);
    const secondNewSnap = await db
      .collection("tripExpenses")
      .doc(secondRequest.clientRequestId as string)
      .get();
    assert.equal(secondNewSnap.exists, false);
  });

  it("13. two concurrent DIFFERENT replacement attempts targeting the same reversed Expense: exactly one winner, zero loser artifacts", async () => {
    await seedTrip();
    const oldId = await createAndReverseExpense(MEMBER_UID, OWNER_UID);
    const requestA = baseCorrectionRequest(oldId);
    const requestB = baseCorrectionRequest(oldId);

    const results = await Promise.allSettled([
      recordTripExpenseCore(db, MEMBER_UID, requestA),
      recordTripExpenseCore(db, OWNER_UID, requestB),
    ]);

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<{expenseId: string}> =>
        r.status === "fulfilled"
    );
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected"
    );
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]!.reason instanceof HttpsError);
    assert.equal((rejected[0]!.reason as HttpsError).code, "failed-precondition");

    const winnerId = fulfilled[0]!.value.expenseId;
    const loserRequest = winnerId === requestA.clientRequestId ? requestB : requestA;

    const oldData = await getExpense(oldId);
    assert.equal(oldData?.replacedByExpenseId, winnerId);
    const winnerData = await getExpense(winnerId);
    assert.equal(winnerData?.replacesExpenseId, oldId);

    const loserSnap = await db
      .collection("tripExpenses")
      .doc(loserRequest.clientRequestId as string)
      .get();
    assert.equal(loserSnap.exists, false);
    const loserSplitsSnap = await db
      .collection("tripExpenseSplits")
      .where("expenseId", "==", loserRequest.clientRequestId as string)
      .get();
    assert.equal(loserSplitsSnap.size, 0);
  });

  it("14. exact replacement replay: success, no duplicate Splits, no rewrite of either link field", async () => {
    await seedTrip();
    const oldId = await createAndReverseExpense(MEMBER_UID, OWNER_UID);
    const request = baseCorrectionRequest(oldId);
    const first = await recordTripExpenseCore(db, MEMBER_UID, request);

    const oldBefore = await getExpense(oldId);
    const newBefore = await getExpense(first.expenseId);
    const splitsBefore = (
      await db
        .collection("tripExpenseSplits")
        .where("expenseId", "==", first.expenseId)
        .get()
    ).size;

    const replay = await recordTripExpenseCore(db, MEMBER_UID, request);
    assert.equal(replay.expenseId, first.expenseId);

    const oldAfter = await getExpense(oldId);
    const newAfter = await getExpense(first.expenseId);
    assert.deepEqual(oldAfter, oldBefore);
    assert.deepEqual(newAfter, newBefore);
    const splitsAfter = (
      await db
        .collection("tripExpenseSplits")
        .where("expenseId", "==", first.expenseId)
        .get()
    ).size;
    assert.equal(splitsAfter, splitsBefore);
  });

  it("15. same new clientRequestId + same ordinary facts + DIFFERENT replacesExpenseId -> already-exists, through the generic conflicting-request path", async () => {
    await seedTrip();
    const oldId = await createAndReverseExpense(OTHER_MEMBER_UID, OWNER_UID);
    const clientRequestId = randomUUID();
    await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseEqualRequest({clientRequestId})
    );

    await assertRejectsWithCode(
      recordTripExpenseCore(
        db,
        MEMBER_UID,
        baseEqualRequest({clientRequestId, replacesExpenseId: oldId})
      ),
      "already-exists"
    );

    const expensesSnap = await db.collection("tripExpenses").get();
    assert.equal(
      expensesSnap.docs.filter((d) => d.id === clientRequestId).length,
      1
    );
    const stored = await getExpense(clientRequestId);
    assert.equal("replacesExpenseId" in (stored ?? {}), false);
  });

  it("16. omitted replacesExpenseId stores creationRequest.replacesExpenseId === null; ordinary replay remains successful", async () => {
    await seedTrip();
    const request = baseEqualRequest();
    const first = await recordTripExpenseCore(db, MEMBER_UID, request);

    const data = await getExpense(first.expenseId);
    assert.equal(data?.creationRequest.replacesExpenseId, null);

    const replay = await recordTripExpenseCore(db, MEMBER_UID, request);
    assert.equal(replay.expenseId, first.expenseId);
    const expensesSnap = await db.collection("tripExpenses").get();
    assert.equal(expensesSnap.size, 1);
  });

  it("17. archived Trip replacement attempt -> failed-precondition through the existing, unmodified archive gate", async () => {
    await seedTrip();
    const oldId = await createAndReverseExpense(MEMBER_UID, OWNER_UID);
    await db
      .collection("trips")
      .doc(TRIP_ID)
      .update({archivedAt: new Date(), archivedBy: OWNER_UID});

    await assertRejectsWithCode(
      recordTripExpenseCore(db, OWNER_UID, baseCorrectionRequest(oldId)),
      "failed-precondition"
    );

    const oldAfter = await getExpense(oldId);
    assert.equal("replacedByExpenseId" in (oldAfter ?? {}), false);
  });

  it("18. old.createdBy removed from the Trip before replacement loses creator-based authority unless independently owner or current-member reversedBy", async () => {
    await seedTrip();
    const oldId = await createAndReverseExpense(MEMBER_UID, OTHER_MEMBER_UID);
    await db
      .collection("trips")
      .doc(TRIP_ID)
      .update({memberIds: [OWNER_UID, OTHER_MEMBER_UID]}); // MEMBER_UID removed

    const request = baseCorrectionRequest(oldId);
    await assertRejectsWithCode(
      recordTripExpenseCore(db, MEMBER_UID, request),
      "permission-denied"
    );
  });

  it("19. old.reversedBy removed from the Trip before replacement loses reverser-based authority unless independently owner or current-member createdBy", async () => {
    await seedTrip();
    const oldId = await createAndReverseExpense(OTHER_MEMBER_UID, MEMBER_UID);
    await db
      .collection("trips")
      .doc(TRIP_ID)
      .update({memberIds: [OWNER_UID, OTHER_MEMBER_UID]}); // MEMBER_UID removed

    const request = baseCorrectionRequest(oldId);
    await assertRejectsWithCode(
      recordTripExpenseCore(db, MEMBER_UID, request),
      "permission-denied"
    );
  });
});

describe("recordTripExpenseCore - legacy replay compatibility (Checkpoint 4C.3D §21)", () => {
  it("LEGACY A: a pre-4C.3D Expense with NO stored replacesExpenseId key replays successfully with an omitted (null) incoming value, zero rewrite", async () => {
    await seedTrip();
    const clientRequestId = randomUUID();
    const first = await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseEqualRequest({clientRequestId})
    );
    // Simulate a document created before this checkpoint - no
    // replacesExpenseId key at all in the stored creationRequest.
    await db
      .collection("tripExpenses")
      .doc(first.expenseId)
      .update({"creationRequest.replacesExpenseId": FieldValue.delete()});

    const beforeExpense = await getExpense(first.expenseId);
    assert.equal("replacesExpenseId" in beforeExpense!.creationRequest, false);
    const beforeSplits = (
      await db
        .collection("tripExpenseSplits")
        .where("expenseId", "==", first.expenseId)
        .get()
    ).size;

    const replay = await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseEqualRequest({clientRequestId})
    );
    assert.equal(replay.expenseId, first.expenseId);

    const afterExpense = await getExpense(first.expenseId);
    assert.deepEqual(afterExpense, beforeExpense);
    // No migration/rewrite - the key is still absent, not backfilled.
    assert.equal("replacesExpenseId" in afterExpense!.creationRequest, false);
    const afterSplits = (
      await db
        .collection("tripExpenseSplits")
        .where("expenseId", "==", first.expenseId)
        .get()
    ).size;
    assert.equal(afterSplits, beforeSplits);
  });

  it("LEGACY B: the same legacy stored Expense with a NON-NULL incoming replacesExpenseId is already-exists, never a replay", async () => {
    await seedTrip();
    const clientRequestId = randomUUID();
    const first = await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseEqualRequest({clientRequestId})
    );
    await db
      .collection("tripExpenses")
      .doc(first.expenseId)
      .update({"creationRequest.replacesExpenseId": FieldValue.delete()});
    const before = await getExpense(first.expenseId);

    await assertRejectsWithCode(
      recordTripExpenseCore(
        db,
        MEMBER_UID,
        baseEqualRequest({
          clientRequestId,
          replacesExpenseId: "some-old-expense-id",
        })
      ),
      "already-exists"
    );

    const after = await getExpense(first.expenseId);
    assert.deepEqual(after, before);
  });

  it("LEGACY C: a malformed stored replacesExpenseId is NEVER normalized to null and always fails exact-match -> already-exists", async () => {
    await seedTrip();
    const malformedValues: unknown[] = [123, {nested: true}, "a/b"];
    for (const malformed of malformedValues) {
      const clientRequestId = randomUUID();
      const first = await recordTripExpenseCore(
        db,
        MEMBER_UID,
        baseEqualRequest({clientRequestId})
      );
      await db
        .collection("tripExpenses")
        .doc(first.expenseId)
        .update({"creationRequest.replacesExpenseId": malformed});
      const before = await getExpense(first.expenseId);

      // Ordinary (omitted -> null) replay must NOT match a malformed
      // stored value.
      await assertRejectsWithCode(
        recordTripExpenseCore(
          db,
          MEMBER_UID,
          baseEqualRequest({clientRequestId})
        ),
        "already-exists"
      );

      const after = await getExpense(first.expenseId);
      assert.deepEqual(after, before);
    }
  });
});

describe("recordTripExpenseCore - correction-link information-leak matrix (Checkpoint 4C.3D §22)", () => {
  it("unrelated current member vs. an ACTIVE old target -> permission-denied", async () => {
    await seedTrip({
      memberIds: [OWNER_UID, MEMBER_UID, OTHER_MEMBER_UID, FOURTH_MEMBER_UID],
    });
    const first = await recordTripExpenseCore(
      db,
      MEMBER_UID,
      baseEqualRequest()
    );

    await assertRejectsWithCode(
      recordTripExpenseCore(
        db,
        FOURTH_MEMBER_UID,
        baseCorrectionRequest(first.expenseId)
      ),
      "permission-denied"
    );
  });

  it("unrelated current member vs. a validly-REVERSED old target -> the identical permission-denied", async () => {
    await seedTrip({
      memberIds: [OWNER_UID, MEMBER_UID, OTHER_MEMBER_UID, FOURTH_MEMBER_UID],
    });
    const oldId = await createAndReverseExpense(MEMBER_UID, OWNER_UID);

    await assertRejectsWithCode(
      recordTripExpenseCore(
        db,
        FOURTH_MEMBER_UID,
        baseCorrectionRequest(oldId)
      ),
      "permission-denied"
    );
  });

  it("unrelated current member vs. an ALREADY-REPLACED old target -> the identical permission-denied", async () => {
    await seedTrip({
      memberIds: [OWNER_UID, MEMBER_UID, OTHER_MEMBER_UID, FOURTH_MEMBER_UID],
    });
    const oldId = await createAndReverseExpense(MEMBER_UID, OWNER_UID);
    await recordTripExpenseCore(db, MEMBER_UID, baseCorrectionRequest(oldId));

    await assertRejectsWithCode(
      recordTripExpenseCore(
        db,
        FOURTH_MEMBER_UID,
        baseCorrectionRequest(oldId)
      ),
      "permission-denied"
    );
  });

  it("a nonexistent target and a cross-Trip target remain failed-precondition per the frozen 5A/5B ordering, regardless of caller authorization", async () => {
    await seedTrip();
    await seedSecondTrip();
    const crossTripOldId = await createAndReverseExpense(
      OWNER_UID,
      OWNER_UID,
      {
        tripId: SECOND_TRIP_ID,
        payerUid: MEMBER_UID,
        participants: [{uid: OWNER_UID}, {uid: MEMBER_UID}],
      }
    );

    // OWNER_UID is the Trip's own owner - fully authorized for ordinary
    // creation, and would even qualify for correction-link authority on
    // SECOND_TRIP_ID's own Expense - yet 5A/5B still reject first.
    await assertRejectsWithCode(
      recordTripExpenseCore(
        db,
        OWNER_UID,
        baseCorrectionRequest("nonexistent-old-expense-id")
      ),
      "failed-precondition"
    );
    await assertRejectsWithCode(
      recordTripExpenseCore(
        db,
        OWNER_UID,
        baseCorrectionRequest(crossTripOldId)
      ),
      "failed-precondition"
    );
  });
});

describe("recordTripExpenseCore - replacesExpenseId input validation (Checkpoint 4C.3D §24)", () => {
  const invalidCases: Array<[string, unknown]> = [
    ["empty string", ""],
    ['"."', "."],
    ['".."', ".."],
    ['contains "/"', "a/b"],
    ["exceeds 1500 UTF-8 bytes", "x".repeat(1501)],
    ["non-string (number)", 123],
    ["non-string (object)", {foo: "bar"}],
  ];
  for (const [label, badValue] of invalidCases) {
    it(`replacesExpenseId (${label}) is rejected invalid-argument before any transaction mutation`, async () => {
      await seedTrip();
      const request = baseEqualRequest({replacesExpenseId: badValue});

      await assertRejectsWithCode(
        recordTripExpenseCore(db, MEMBER_UID, request),
        "invalid-argument"
      );

      const snap = await db
        .collection("tripExpenses")
        .doc(request.clientRequestId as string)
        .get();
      assert.equal(snap.exists, false);
    });
  }
});

// Checkpoint 4C.3D.1: test-fidelity follow-up only - proves that exact
// replay of an ALREADY-CREATED replacement Expense is entirely
// self-contained, exactly like ordinary (non-correction) replay already
// is. The replay branch (recordTripExpenseCore's existing-Expense check)
// runs BEFORE the D2 correction-target block is ever reached, so none of
// these state changes to the old correction target or the Trip should be
// able to affect a caller reconciling their own already-committed
// replacement request.
describe("recordTripExpenseCore - exact replacement replay independence (Checkpoint 4C.3D.1)", () => {
  it("A. exact replay succeeds even after the old correction target is deleted entirely", async () => {
    await seedTrip();
    const oldId = await createAndReverseExpense(MEMBER_UID, OWNER_UID);
    const request = baseCorrectionRequest(oldId);
    const first = await recordTripExpenseCore(db, MEMBER_UID, request);

    const oldAfterCreate = await getExpense(oldId);
    assert.equal(oldAfterCreate?.replacedByExpenseId, first.expenseId);
    const newBefore = await getExpense(first.expenseId);
    assert.equal(newBefore?.replacesExpenseId, oldId);
    const splitsBefore = (
      await db
        .collection("tripExpenseSplits")
        .where("expenseId", "==", first.expenseId)
        .get()
    ).size;

    // TEST-ONLY: delete the old correction target entirely. A genuinely
    // NEW request against this same replacesExpenseId would now fail
    // failed-precondition at step 5A - but this is a replay, which must
    // never reach 5A at all.
    await db.collection("tripExpenses").doc(oldId).delete();

    const replay = await recordTripExpenseCore(db, MEMBER_UID, request);
    assert.equal(replay.expenseId, first.expenseId);

    const newAfter = await getExpense(first.expenseId);
    assert.deepEqual(newAfter, newBefore);
    const splitsAfter = (
      await db
        .collection("tripExpenseSplits")
        .where("expenseId", "==", first.expenseId)
        .get()
    ).size;
    assert.equal(splitsAfter, splitsBefore);
    const expensesSnap = await db.collection("tripExpenses").get();
    // Only B remains - A was deleted, and no duplicate/second B exists.
    assert.equal(expensesSnap.size, 1);
    assert.equal(expensesSnap.docs[0]!.id, first.expenseId);
  });

  it("B. exact replay succeeds even after the Trip becomes archived", async () => {
    await seedTrip();
    const oldId = await createAndReverseExpense(MEMBER_UID, OWNER_UID);
    const request = baseCorrectionRequest(oldId);
    const first = await recordTripExpenseCore(db, MEMBER_UID, request);

    const newBefore = await getExpense(first.expenseId);
    const oldBefore = await getExpense(oldId);
    const splitsBefore = (
      await db
        .collection("tripExpenseSplits")
        .where("expenseId", "==", first.expenseId)
        .get()
    ).size;

    await db
      .collection("trips")
      .doc(TRIP_ID)
      .update({archivedAt: new Date(), archivedBy: OWNER_UID});

    const replay = await recordTripExpenseCore(db, MEMBER_UID, request);
    assert.equal(replay.expenseId, first.expenseId);

    const newAfter = await getExpense(first.expenseId);
    const oldAfter = await getExpense(oldId);
    assert.deepEqual(newAfter, newBefore);
    assert.deepEqual(oldAfter, oldBefore);
    assert.equal(oldAfter?.replacedByExpenseId, first.expenseId);
    const splitsAfter = (
      await db
        .collection("tripExpenseSplits")
        .where("expenseId", "==", first.expenseId)
        .get()
    ).size;
    assert.equal(splitsAfter, splitsBefore);
  });

  it("C. exact replay succeeds even after the replacement's own creator is removed from the Trip", async () => {
    await seedTrip();
    // MEMBER_UID's authority to claim the correction slot comes from
    // being the OLD Expense's createdBy while still a current member -
    // exactly the kind of authority the checkpoint asks to prove does
    // NOT get re-evaluated on replay.
    const oldId = await createAndReverseExpense(MEMBER_UID, OWNER_UID);
    const request = baseCorrectionRequest(oldId);
    const first = await recordTripExpenseCore(db, MEMBER_UID, request);

    const newBefore = await getExpense(first.expenseId);
    const oldBefore = await getExpense(oldId);

    await db
      .collection("trips")
      .doc(TRIP_ID)
      .update({memberIds: [OWNER_UID, OTHER_MEMBER_UID]}); // MEMBER_UID removed

    const replay = await recordTripExpenseCore(db, MEMBER_UID, request);
    assert.equal(replay.expenseId, first.expenseId);

    const newAfter = await getExpense(first.expenseId);
    const oldAfter = await getExpense(oldId);
    assert.deepEqual(newAfter, newBefore);
    assert.deepEqual(oldAfter, oldBefore);
  });

  it("comparison: after Trip archive, a NON-EXACT request against the same replacement does NOT inherit replay behavior", async () => {
    await seedTrip();
    const oldId = await createAndReverseExpense(MEMBER_UID, OWNER_UID);
    // A second, independent reversed Expense to serve as a DIFFERENT
    // correction target - created before archiving, since ordinary
    // creation (inside createAndReverseExpense) is itself blocked on an
    // archived Trip.
    const oldId2 = await createAndReverseExpense(OWNER_UID, OWNER_UID, {
      payerUid: MEMBER_UID,
      participants: [
        {uid: OWNER_UID},
        {uid: MEMBER_UID},
        {uid: OTHER_MEMBER_UID},
      ],
    });
    const request = baseCorrectionRequest(oldId);
    const first = await recordTripExpenseCore(db, MEMBER_UID, request);

    await db
      .collection("trips")
      .doc(TRIP_ID)
      .update({archivedAt: new Date(), archivedBy: OWNER_UID});

    // Same creator, same clientRequestId, same ordinary facts, but a
    // DIFFERENT replacesExpenseId - a genuine conflict, never a replay -
    // resolved through the existing generic already-exists path.
    await assertRejectsWithCode(
      recordTripExpenseCore(db, MEMBER_UID, {
        ...request,
        replacesExpenseId: oldId2,
      }),
      "already-exists"
    );

    // A genuinely NEW clientRequestId against the archived Trip remains
    // blocked by the existing, unmodified archive gate - replay's own
    // narrowness never leaks into ordinary new-request handling.
    await assertRejectsWithCode(
      recordTripExpenseCore(db, MEMBER_UID, baseCorrectionRequest(oldId)),
      "failed-precondition"
    );

    const bAfter = await getExpense(first.expenseId);
    assert.equal(bAfter?.replacesExpenseId, oldId);
  });
});
