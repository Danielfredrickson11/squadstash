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
import { getFirestore } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { recordTripExpenseCore } from "../src/callables/recordTripExpense";
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
});
