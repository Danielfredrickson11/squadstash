// Tests for reverseTripExpenseCore against the local Firestore emulator via
// the Admin SDK - never production, guarded below. Run via
// `npm --prefix functions test`, wrapped in
// `firebase emulators:exec --only firestore "..."` so
// FIRESTORE_EMULATOR_HOST is set automatically (the same mechanism
// recordTripExpenseCore.ts already relies on).
//
// Checkpoint 4C.3B first-pass coverage only (docs/audits/
// TRIP_EXPENSE_REVERSAL_CORRECTION_PREFLIGHT_2026-09-17.md, as hardened by
// 4C.3A.1/4C.3A.2) - the full concurrency/race matrix is deferred to
// 4C.3C.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import type { App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import {
  requireAuthenticatedUid,
  reverseTripExpenseCore,
} from "../src/callables/reverseTripExpense";

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
const EXPENSE_ID = "test-expense";

let app: App;
let db: Firestore;

before(() => {
  // A distinct "demo-" project id from every other functions test file's
  // own test app - Node's test runner executes test FILES concurrently by
  // default, so sharing a project id would let this file's per-test
  // clearFirestore() race with and wipe out documents a concurrently-
  // running suite just seeded (and vice versa).
  app = initializeApp({
    projectId: "demo-squadstash-functions-test-reverse-trip-expense",
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

function seedExpense(
  overrides: Record<string, unknown> = {}
): Promise<FirebaseFirestore.WriteResult> {
  return db
    .collection("tripExpenses")
    .doc(EXPENSE_ID)
    .set({
      tripId: TRIP_ID,
      payerUid: MEMBER_UID,
      createdBy: MEMBER_UID,
      amountMinor: 9000,
      currency: "USD",
      description: "Cabin rental",
      splitStrategy: "equal",
      paymentSource: "member_out_of_pocket",
      status: "active",
      createdAt: new Date(),
      creationRequest: {
        tripId: TRIP_ID,
        payerUid: MEMBER_UID,
        amountMinor: 9000,
        currency: "USD",
        description: "Cabin rental",
        category: null,
        splitStrategy: "equal",
        participants: [{ uid: MEMBER_UID }],
        paymentSource: "member_out_of_pocket",
        occurredAtInstantMs: null,
        // Checkpoint 4C.3B.1: replacesExpenseId is a 4C.3D concept that
        // does not exist in production yet - recordTripExpense does not
        // write it today, so this fixture must not fabricate it either.
      },
      ...overrides,
    });
}

// Checkpoint 4C.3B.1: seeds an Expense already in the "reversed" state,
// for tests that need direct control over the STORED reversalRequest
// snapshot's exact shape (replay-fidelity tests below) - never produced
// by going through reverseTripExpenseCore twice, since that would only
// ever write the canonical shape this callable itself already produces.
function seedReversedExpense(
  overrides: Record<string, unknown> = {}
): Promise<FirebaseFirestore.WriteResult> {
  return seedExpense({
    status: "reversed",
    reversedAt: new Date(),
    reversedBy: OWNER_UID,
    reversalRequest: { clientRequestId: "canonical-id", reversalReason: null },
    ...overrides,
  });
}

const SPLIT_ID = "test-expense_member-uid";

function seedSplit(
  overrides: Record<string, unknown> = {}
): Promise<FirebaseFirestore.WriteResult> {
  return db
    .collection("tripExpenseSplits")
    .doc(SPLIT_ID)
    .set({
      expenseId: EXPENSE_ID,
      tripId: TRIP_ID,
      userId: MEMBER_UID,
      amountMinor: 9000,
      createdAt: new Date(),
      ...overrides,
    });
}

function baseReversalRequest(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    expenseId: EXPENSE_ID,
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

describe("reverseTripExpenseCore - authorized reversal", () => {
  it("1. Trip owner reverses an active Expense successfully", async () => {
    await seedTrip();
    await seedExpense();

    const result = await reverseTripExpenseCore(
      db,
      OWNER_UID,
      baseReversalRequest({ reversalReason: "Typo, wrong amount" })
    );
    assert.equal(result.expenseId, EXPENSE_ID);

    const snap = await db.collection("tripExpenses").doc(EXPENSE_ID).get();
    const data = snap.data() as FirebaseFirestore.DocumentData;
    assert.equal(data.status, "reversed");
    assert.equal(data.reversedBy, OWNER_UID);
    assert.ok(data.reversedAt);
    assert.equal(data.reversalReason, "Typo, wrong amount");
    assert.deepEqual(data.reversalRequest, {
      clientRequestId: data.reversalRequest.clientRequestId,
      reversalReason: "Typo, wrong amount",
    });

    // Financial facts unchanged.
    assert.equal(data.tripId, TRIP_ID);
    assert.equal(data.payerUid, MEMBER_UID);
    assert.equal(data.createdBy, MEMBER_UID);
    assert.equal(data.amountMinor, 9000);
    assert.equal(data.currency, "USD");
    assert.equal(data.description, "Cabin rental");
    assert.equal(data.splitStrategy, "equal");

    // No ExpenseSplit document is ever touched.
    const splitsSnap = await db.collection("tripExpenseSplits").get();
    assert.equal(splitsSnap.size, 0);
  });

  it("2. original createdBy, still a current member, reverses successfully", async () => {
    await seedTrip();
    await seedExpense({ createdBy: MEMBER_UID });

    const result = await reverseTripExpenseCore(
      db,
      MEMBER_UID,
      baseReversalRequest()
    );
    assert.equal(result.expenseId, EXPENSE_ID);

    const snap = await db.collection("tripExpenses").doc(EXPENSE_ID).get();
    assert.equal(snap.data()?.status, "reversed");
    assert.equal(snap.data()?.reversedBy, MEMBER_UID);
  });

  it("3. current member who is neither owner nor createdBy is denied", async () => {
    await seedTrip();
    await seedExpense({ createdBy: MEMBER_UID });

    await assertRejectsWithCode(
      reverseTripExpenseCore(db, OTHER_MEMBER_UID, baseReversalRequest()),
      "permission-denied"
    );
  });

  it("4. removed createdBy (no longer a current Trip member) is denied", async () => {
    await seedTrip({ memberIds: [OWNER_UID, OTHER_MEMBER_UID] });
    await seedExpense({ createdBy: MEMBER_UID });

    await assertRejectsWithCode(
      reverseTripExpenseCore(db, MEMBER_UID, baseReversalRequest()),
      "permission-denied"
    );
  });

  it("5. authorized reversal succeeds on an archived Trip", async () => {
    await seedTrip({ archivedAt: new Date() });
    await seedExpense({ createdBy: MEMBER_UID });

    const result = await reverseTripExpenseCore(
      db,
      OWNER_UID,
      baseReversalRequest()
    );
    assert.equal(result.expenseId, EXPENSE_ID);
  });
});

describe("reverseTripExpenseCore - idempotent replay", () => {
  it("6. exact own replay succeeds and does not rewrite any reversal field", async () => {
    await seedTrip();
    await seedExpense();

    const request = baseReversalRequest({ reversalReason: "Wrong amount" });
    await reverseTripExpenseCore(db, OWNER_UID, request);
    const firstSnap = await db.collection("tripExpenses").doc(EXPENSE_ID).get();
    const first = firstSnap.data() as FirebaseFirestore.DocumentData;

    const result = await reverseTripExpenseCore(db, OWNER_UID, request);
    assert.equal(result.expenseId, EXPENSE_ID);

    const secondSnap = await db.collection("tripExpenses").doc(EXPENSE_ID).get();
    const second = secondSnap.data() as FirebaseFirestore.DocumentData;
    assert.deepEqual(second.reversedAt, first.reversedAt);
    assert.equal(second.reversedBy, first.reversedBy);
    assert.equal(second.reversalReason, first.reversalReason);
    assert.deepEqual(second.reversalRequest, first.reversalRequest);
  });

  it("7. same reverser, same Expense, different clientRequestId after reversal fails", async () => {
    await seedTrip();
    await seedExpense();

    await reverseTripExpenseCore(db, OWNER_UID, baseReversalRequest());

    await assertRejectsWithCode(
      reverseTripExpenseCore(db, OWNER_UID, baseReversalRequest()),
      "failed-precondition"
    );
  });

  it("8. same reverser, same clientRequestId, different reversalReason fails", async () => {
    await seedTrip();
    await seedExpense();

    const clientRequestId = randomUUID();
    await reverseTripExpenseCore(
      db,
      OWNER_UID,
      baseReversalRequest({ clientRequestId, reversalReason: "First reason" })
    );

    await assertRejectsWithCode(
      reverseTripExpenseCore(
        db,
        OWNER_UID,
        baseReversalRequest({ clientRequestId, reversalReason: "Different reason" })
      ),
      "failed-precondition"
    );
  });

  it("9. another authorized reverser attempting an already-reversed Expense fails", async () => {
    await seedTrip();
    await seedExpense({ createdBy: MEMBER_UID });

    await reverseTripExpenseCore(db, OWNER_UID, baseReversalRequest());

    await assertRejectsWithCode(
      reverseTripExpenseCore(db, MEMBER_UID, baseReversalRequest()),
      "failed-precondition"
    );
  });
});

describe("reverseTripExpenseCore - input validation", () => {
  it("10. malformed top-level request is rejected invalid-argument", async () => {
    await assertRejectsWithCode(
      reverseTripExpenseCore(db, OWNER_UID, "not-an-object"),
      "invalid-argument"
    );
  });

  it("11. injected forged reversedBy is rejected invalid-argument", async () => {
    await seedTrip();
    await seedExpense();

    await assertRejectsWithCode(
      reverseTripExpenseCore(
        db,
        OWNER_UID,
        baseReversalRequest({ reversedBy: OUTSIDER_UID })
      ),
      "invalid-argument"
    );
  });

  it("11b. every other injected forged field is rejected invalid-argument", async () => {
    await seedTrip();
    await seedExpense();

    for (const field of [
      "status",
      "reversedAt",
      "createdBy",
      "tripId",
      "reversalRequest",
      "amountMinor",
      "payerUid",
    ]) {
      await assertRejectsWithCode(
        reverseTripExpenseCore(
          db,
          OWNER_UID,
          baseReversalRequest({ [field]: "forged" })
        ),
        "invalid-argument"
      );
    }
  });

  it("12. whitespace-only reversalReason normalizes to null and is not persisted", async () => {
    await seedTrip();
    await seedExpense();

    await reverseTripExpenseCore(
      db,
      OWNER_UID,
      baseReversalRequest({ reversalReason: "   " })
    );

    const snap = await db.collection("tripExpenses").doc(EXPENSE_ID).get();
    const data = snap.data() as FirebaseFirestore.DocumentData;
    assert.equal("reversalReason" in data, false);
    assert.equal(data.reversalRequest.reversalReason, null);
  });

  it("13. a trimmed, non-empty reversalReason persists trimmed on both fields", async () => {
    await seedTrip();
    await seedExpense();

    await reverseTripExpenseCore(
      db,
      OWNER_UID,
      baseReversalRequest({ reversalReason: "  Wrong amount  " })
    );

    const snap = await db.collection("tripExpenses").doc(EXPENSE_ID).get();
    const data = snap.data() as FirebaseFirestore.DocumentData;
    assert.equal(data.reversalReason, "Wrong amount");
    assert.equal(data.reversalRequest.reversalReason, "Wrong amount");
  });

  it("14. nonexistent Expense is rejected not-found", async () => {
    await assertRejectsWithCode(
      reverseTripExpenseCore(db, OWNER_UID, baseReversalRequest()),
      "not-found"
    );
  });

  it("15. malformed expenseId is rejected invalid-argument before any Firestore path is built", async () => {
    await assertRejectsWithCode(
      reverseTripExpenseCore(
        db,
        OWNER_UID,
        baseReversalRequest({ expenseId: "a/b" })
      ),
      "invalid-argument"
    );
  });
});

describe("reverseTripExpenseCore - malformed persisted state (defensive)", () => {
  it("16. malformed persisted tripId is rejected failed-precondition", async () => {
    await seedExpense({ tripId: "a/b" });

    await assertRejectsWithCode(
      reverseTripExpenseCore(db, OWNER_UID, baseReversalRequest()),
      "failed-precondition"
    );
  });

  it("17. a missing referenced Trip is rejected failed-precondition", async () => {
    await seedExpense({ tripId: "nonexistent-trip" });

    await assertRejectsWithCode(
      reverseTripExpenseCore(db, OWNER_UID, baseReversalRequest()),
      "failed-precondition"
    );
  });

  it("18. malformed persisted status + outsider is rejected permission-denied, never disclosing status", async () => {
    await seedTrip();
    await seedExpense({ status: "corrupted-value", createdBy: MEMBER_UID });

    await assertRejectsWithCode(
      reverseTripExpenseCore(db, OUTSIDER_UID, baseReversalRequest()),
      "permission-denied"
    );
  });

  it("19. malformed persisted status + authorized owner is rejected failed-precondition", async () => {
    await seedTrip();
    await seedExpense({ status: "corrupted-value", createdBy: MEMBER_UID });

    await assertRejectsWithCode(
      reverseTripExpenseCore(db, OWNER_UID, baseReversalRequest()),
      "failed-precondition"
    );
  });
});

describe("reverseTripExpenseCore - zero writes on rejected NEW reversal attempts", () => {
  // Checkpoint 4C.3B.1: expanded from one combined test into individual,
  // separately-failing tests, each comparing the persisted Expense before
  // vs. after - proving zero mutation, not merely asserting the error
  // code.
  async function expectNoMutation(
    setup: () => Promise<unknown>,
    attempt: () => Promise<unknown>,
    expectedCode: string
  ): Promise<void> {
    await setup();
    const before = (
      await db.collection("tripExpenses").doc(EXPENSE_ID).get()
    ).data();

    await assertRejectsWithCode(attempt(), expectedCode);

    const after = (
      await db.collection("tripExpenses").doc(EXPENSE_ID).get()
    ).data();
    assert.deepEqual(after, before);
  }

  it("20a. permission-denied leaves the Expense unchanged", async () => {
    await expectNoMutation(
      async () => {
        await seedTrip({ memberIds: [OWNER_UID, OTHER_MEMBER_UID] });
        await seedExpense({ createdBy: MEMBER_UID });
      },
      () => reverseTripExpenseCore(db, MEMBER_UID, baseReversalRequest()),
      "permission-denied"
    );
  });

  it("20b. invalid-argument leaves the Expense unchanged", async () => {
    await expectNoMutation(
      async () => {
        await seedTrip();
        await seedExpense();
      },
      () =>
        reverseTripExpenseCore(
          db,
          OWNER_UID,
          baseReversalRequest({ reversalReason: 12345 })
        ),
      "invalid-argument"
    );
  });

  it("20c. malformed persisted tripId (failed-precondition) leaves the Expense unchanged", async () => {
    await expectNoMutation(
      () => seedExpense({ tripId: "a/b" }),
      () => reverseTripExpenseCore(db, OWNER_UID, baseReversalRequest()),
      "failed-precondition"
    );
  });

  it("20d. a missing referenced Trip (failed-precondition) leaves the Expense unchanged", async () => {
    await expectNoMutation(
      () => seedExpense({ tripId: "nonexistent-trip" }),
      () => reverseTripExpenseCore(db, OWNER_UID, baseReversalRequest()),
      "failed-precondition"
    );
  });

  it("20e. malformed persisted status for an authorized caller leaves the Expense unchanged", async () => {
    await expectNoMutation(
      async () => {
        await seedTrip();
        await seedExpense({ status: "corrupted-value", createdBy: MEMBER_UID });
      },
      () => reverseTripExpenseCore(db, OWNER_UID, baseReversalRequest()),
      "failed-precondition"
    );
  });

  it("20f. an already-reversed Expense (conflicting request) leaves the Expense unchanged", async () => {
    await expectNoMutation(
      async () => {
        await seedTrip();
        await seedExpense({ createdBy: MEMBER_UID });
        await reverseTripExpenseCore(db, OWNER_UID, baseReversalRequest());
      },
      () => reverseTripExpenseCore(db, MEMBER_UID, baseReversalRequest()),
      "failed-precondition"
    );
  });

  it("20g. malformed reversed metadata for an authorized caller leaves the Expense unchanged", async () => {
    await expectNoMutation(
      async () => {
        await seedTrip();
        await seedReversedExpense({
          reversalRequest: { clientRequestId: "canonical-id", extra: true },
        });
      },
      () => reverseTripExpenseCore(db, OWNER_UID, baseReversalRequest()),
      "failed-precondition"
    );
  });
});

describe("reverseTripExpenseCore - stored reversalRequest snapshot fidelity (Checkpoint 4C.3B.1)", () => {
  it("an exact canonical stored snapshot replays successfully for the original reverser", async () => {
    await seedTrip();
    await seedReversedExpense({
      reversalRequest: { clientRequestId: "canonical-id", reversalReason: null },
    });

    const result = await reverseTripExpenseCore(
      db,
      OWNER_UID,
      baseReversalRequest({ clientRequestId: "canonical-id" })
    );
    assert.equal(result.expenseId, EXPENSE_ID);
  });

  it("a stored snapshot with an extra property does NOT count as an exact replay", async () => {
    await seedTrip();
    await seedReversedExpense({
      reversalRequest: {
        clientRequestId: "canonical-id",
        reversalReason: null,
        extra: true,
      },
    });

    // Authorized (original reverser): falls through to G and is rejected
    // as malformed reversal metadata, never as a successful replay.
    await assertRejectsWithCode(
      reverseTripExpenseCore(db, OWNER_UID, baseReversalRequest()),
      "failed-precondition"
    );
    // Unauthorized outsider: the identical permission-denied is reached
    // WITHOUT the malformed snapshot ever being inspected or disclosed.
    await assertRejectsWithCode(
      reverseTripExpenseCore(db, OUTSIDER_UID, baseReversalRequest()),
      "permission-denied"
    );
  });

  it("an invalid stored clientRequestId pattern does NOT count as an exact replay", async () => {
    await seedTrip();
    await seedReversedExpense({
      reversalRequest: {
        clientRequestId: "not a valid id!",
        reversalReason: null,
      },
    });

    await assertRejectsWithCode(
      reverseTripExpenseCore(db, OWNER_UID, baseReversalRequest()),
      "failed-precondition"
    );
    await assertRejectsWithCode(
      reverseTripExpenseCore(db, OUTSIDER_UID, baseReversalRequest()),
      "permission-denied"
    );
  });

  it("an untrimmed stored reversalReason does NOT count as an exact replay", async () => {
    await seedTrip();
    await seedReversedExpense({
      reversalRequest: {
        clientRequestId: "canonical-id",
        reversalReason: " Wrong amount ",
      },
    });

    await assertRejectsWithCode(
      reverseTripExpenseCore(
        db,
        OWNER_UID,
        baseReversalRequest({
          clientRequestId: "canonical-id",
          reversalReason: "Wrong amount",
        })
      ),
      "failed-precondition"
    );
  });

  it("a whitespace-only stored reversalReason does NOT count as an exact replay", async () => {
    await seedTrip();
    await seedReversedExpense({
      reversalRequest: { clientRequestId: "canonical-id", reversalReason: "   " },
    });

    await assertRejectsWithCode(
      reverseTripExpenseCore(
        db,
        OWNER_UID,
        baseReversalRequest({ clientRequestId: "canonical-id" })
      ),
      "failed-precondition"
    );
    await assertRejectsWithCode(
      reverseTripExpenseCore(
        db,
        OUTSIDER_UID,
        baseReversalRequest({ clientRequestId: "canonical-id" })
      ),
      "permission-denied"
    );
  });
});

describe("reverseTripExpenseCore - null reversalReason canonicalization (Checkpoint 4C.3B.1)", () => {
  it("removes a stale top-level reversalReason left over on an ACTIVE Expense when reversing with no reason", async () => {
    await seedTrip();
    // A malformed/stale ACTIVE record that already carries a top-level
    // reversalReason it never should have - reversal must still leave
    // the resulting document canonical, not merely leave the stale value
    // untouched.
    await seedExpense({ reversalReason: "stale leftover value" });

    await reverseTripExpenseCore(
      db,
      OWNER_UID,
      baseReversalRequest({ reversalReason: "   " })
    );

    const snap = await db.collection("tripExpenses").doc(EXPENSE_ID).get();
    const data = snap.data() as FirebaseFirestore.DocumentData;
    assert.equal("reversalReason" in data, false);
    assert.equal(data.reversalRequest.reversalReason, null);
  });
});

describe("reverseTripExpenseCore - Split immutability (Checkpoint 4C.3B.1)", () => {
  it("an existing ExpenseSplit document is left byte-for-byte unchanged by reversal", async () => {
    await seedTrip();
    await seedExpense({ createdBy: MEMBER_UID });
    await seedSplit();

    const before = (
      await db.collection("tripExpenseSplits").doc(SPLIT_ID).get()
    ).data();

    await reverseTripExpenseCore(db, OWNER_UID, baseReversalRequest());

    const after = (
      await db.collection("tripExpenseSplits").doc(SPLIT_ID).get()
    ).data();
    assert.deepEqual(after, before);
  });
});

describe("reverseTripExpenseCore - production auth boundary", () => {
  it("requireAuthenticatedUid rejects an absent auth context", () => {
    assert.throws(
      () => requireAuthenticatedUid(undefined),
      (err: unknown) => {
        assert.ok(err instanceof HttpsError);
        assert.equal((err as HttpsError).code, "unauthenticated");
        return true;
      }
    );
  });
});
