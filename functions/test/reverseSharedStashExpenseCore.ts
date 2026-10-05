// Tests for reverseSharedStashExpenseCore against the local Firestore
// emulator via the Admin SDK - never production, guarded below. Run via
// `npm --prefix functions test`, wrapped in
// `firebase emulators:exec --only firestore "..."` so
// FIRESTORE_EMULATOR_HOST is set automatically (the same mechanism every
// other functions test file in this package already relies on).
//
// Checkpoint 4F.2 coverage only (docs/audits/
// TRIP_SHARED_STASH_EXPENSE_PREFLIGHT_2026-09-30.md, as corrected by its
// 4F.0A amendment) - UI/client service work is a separate, not-yet-built
// checkpoint.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import type { App } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { recordSharedStashExpenseCore } from "../src/callables/recordSharedStashExpense";
import {
  requireAuthenticatedUid,
  reverseSharedStashExpenseCore,
} from "../src/callables/reverseSharedStashExpense";

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
    projectId: "demo-squadstash-functions-test-reverse-shared-stash",
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
    "savingsTransactions",
  ]) {
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
      saved: 100, // -> legacy-derives to 10000 minor on first ledger write
      imageUrl: "https://example.com/trip.jpg",
      tripStartDate: "2027-06-12",
      ...overrides,
    });
}

function createRequest(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    tripId: TRIP_ID,
    amountMinor: 2000,
    currency: "USD",
    description: "Groceries for the cabin",
    clientRequestId: randomUUID(),
    ...overrides,
  };
}

function baseReversalRequest(
  expenseId: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    expenseId,
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

// Creates a genuine, fully realistic active shared_stash Expense + its
// linked withdrawal via the real create callable, rather than hand-seeding
// - so every field (sharedStashTransactionId, creationRequest, the
// withdrawal's own shape) is exactly what production would actually
// produce. Returns the create result plus the Trip's balance immediately
// after this create.
async function createActiveExpense(
  creatorUid: string,
  overrides: Record<string, unknown> = {}
): Promise<{
  expenseId: string;
  sharedStashTransactionId: string;
  tripBalanceAfterCreate: number;
}> {
  const result = await recordSharedStashExpenseCore(
    db,
    creatorUid,
    createRequest(overrides)
  );
  const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
  return {
    expenseId: result.expenseId,
    sharedStashTransactionId: result.sharedStashTransactionId,
    tripBalanceAfterCreate: tripSnap.data()!.ledgerBalanceMinor,
  };
}

describe("reverseSharedStashExpenseCore - requireAuthenticatedUid", () => {
  it("throws unauthenticated when auth is absent", () => {
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

describe("reverseSharedStashExpenseCore - successful reversal", () => {
  it("1. reverses the Expense and adds the amount back to the current balance (no intervening activity, so this also equals the pre-expense value)", async () => {
    await seedTrip();
    const { expenseId, sharedStashTransactionId, tripBalanceAfterCreate } =
      await createActiveExpense(MEMBER_UID, { amountMinor: 2000 });
    assert.equal(tripBalanceAfterCreate, 8000); // 10000 legacy - 2000

    const result = await reverseSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseReversalRequest(expenseId)
    );
    assert.equal(result.expenseId, expenseId);

    const expenseSnap = await db.collection("tripExpenses").doc(expenseId).get();
    const expense = expenseSnap.data()!;
    assert.equal(expense.status, "reversed");
    assert.equal(expense.reversedBy, MEMBER_UID);
    assert.equal(expense.refundTransactionId, result.refundTransactionId);

    const refundSnap = await db
      .collection("savingsTransactions")
      .doc(result.refundTransactionId)
      .get();
    const refund = refundSnap.data()!;
    assert.equal(refund.resourceType, "trip");
    assert.equal(refund.resourceId, TRIP_ID);
    assert.equal(refund.type, "contribution");
    assert.equal(refund.amountMinor, 2000);
    assert.equal(refund.currency, "USD");
    assert.equal(refund.reversalOf, sharedStashTransactionId);
    assert.equal(refund.linkedExpenseId, expenseId);
    assert.equal(refund.memberUid, MEMBER_UID);
    assert.equal(refund.recordedBy, MEMBER_UID);

    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    const trip = tripSnap.data()!;
    // current balance (8000) + the original Expense amount (2000) = 10000
    // - the invariant is "add to the current balance," which coincides
    // with the pre-expense value only because nothing intervened here.
    assert.equal(trip.ledgerBalanceMinor, 10000);
    assert.equal(trip.saved, 100);
  });

  it("2. the original withdrawal is never mutated or deleted by reversal", async () => {
    await seedTrip();
    const { expenseId, sharedStashTransactionId } = await createActiveExpense(
      MEMBER_UID
    );
    const before = (
      await db.collection("savingsTransactions").doc(sharedStashTransactionId).get()
    ).data();

    await reverseSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseReversalRequest(expenseId)
    );

    const after = (
      await db.collection("savingsTransactions").doc(sharedStashTransactionId).get()
    ).data();
    assert.deepEqual(after, before);
  });

  it("3. zero tripExpenseSplits are read or written by reversal", async () => {
    await seedTrip();
    const { expenseId } = await createActiveExpense(MEMBER_UID);
    await reverseSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseReversalRequest(expenseId)
    );
    const splitsSnap = await db.collection("tripExpenseSplits").get();
    assert.equal(splitsSnap.size, 0);
  });

  it("4. the Trip's current owner may reverse an Expense created by another member", async () => {
    await seedTrip();
    const { expenseId } = await createActiveExpense(MEMBER_UID);
    const result = await reverseSharedStashExpenseCore(
      db,
      OWNER_UID,
      baseReversalRequest(expenseId)
    );
    assert.equal(result.expenseId, expenseId);
  });
});

describe("reverseSharedStashExpenseCore - balance restoration against CURRENT balance", () => {
  it("5. an unrelated intervening Shared Stash transaction is preserved - reversal adds back against the CURRENT balance, not the historical pre-expense balance", async () => {
    await seedTrip();
    const { expenseId } = await createActiveExpense(MEMBER_UID, {
      amountMinor: 2000,
    }); // 10000 -> 8000

    // An unrelated, later, legitimate Shared Stash contribution - directly
    // simulating what recordSavingsTransactionCore would have done, since
    // this test only needs the LEDGER side effect, not that callable's
    // own authorization machinery.
    await db.collection("savingsTransactions").doc(randomUUID()).set({
      resourceType: "trip",
      resourceId: TRIP_ID,
      memberUid: OTHER_MEMBER_UID,
      recordedBy: OTHER_MEMBER_UID,
      amountMinor: 1000,
      currency: "USD",
      type: "contribution",
      createdAt: FieldValue.serverTimestamp(),
      reversalOf: null,
    });
    await db.collection("trips").doc(TRIP_ID).update({
      ledgerBalanceMinor: 9000, // 8000 + 1000
      saved: 90,
    });

    await reverseSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseReversalRequest(expenseId)
    );

    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    const trip = tripSnap.data()!;
    // Correct: 9000 (current balance right before reversal) + 2000
    // (original Expense amount) = 11000. NOT the historical pre-Expense
    // balance of 10000.
    assert.equal(trip.ledgerBalanceMinor, 11000);
    assert.equal(trip.saved, 110);
  });
});

describe("reverseSharedStashExpenseCore - idempotent exact replay", () => {
  it("6. an exact replay succeeds idempotently with unchanged counts/balance", async () => {
    await seedTrip();
    const { expenseId } = await createActiveExpense(MEMBER_UID, {
      amountMinor: 2000,
    });
    const reversalRequest = baseReversalRequest(expenseId, {
      reversalReason: "Double-booked",
    });

    const first = await reverseSharedStashExpenseCore(db, MEMBER_UID, reversalRequest);
    const second = await reverseSharedStashExpenseCore(db, MEMBER_UID, reversalRequest);
    assert.deepEqual(first, second);

    const refundsSnap = await db
      .collection("savingsTransactions")
      .where("type", "==", "contribution")
      .get();
    assert.equal(refundsSnap.size, 1); // exactly one refund, never two

    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()!.ledgerBalanceMinor, 10000); // refund applied only once
  });
});

describe("reverseSharedStashExpenseCore - different-request collision", () => {
  it("7. a different reversalReason under a reused clientRequestId fails failed-precondition, with no double refund", async () => {
    await seedTrip();
    const { expenseId } = await createActiveExpense(MEMBER_UID, {
      amountMinor: 2000,
    });
    const clientRequestId = randomUUID();
    await reverseSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseReversalRequest(expenseId, { clientRequestId, reversalReason: "A" })
    );

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseReversalRequest(expenseId, { clientRequestId, reversalReason: "B" })
      ),
      "failed-precondition"
    );

    const refundsSnap = await db
      .collection("savingsTransactions")
      .where("type", "==", "contribution")
      .get();
    assert.equal(refundsSnap.size, 1);
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()!.ledgerBalanceMinor, 10000);
  });
});

describe("reverseSharedStashExpenseCore - already reversed", () => {
  it("8. a reversal by a DIFFERENT authorized caller after the original is rejected, with no second refund", async () => {
    await seedTrip();
    const { expenseId } = await createActiveExpense(MEMBER_UID, {
      amountMinor: 2000,
    });
    await reverseSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseReversalRequest(expenseId)
    );

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        OWNER_UID,
        baseReversalRequest(expenseId)
      ),
      "failed-precondition"
    );

    const refundsSnap = await db
      .collection("savingsTransactions")
      .where("type", "==", "contribution")
      .get();
    assert.equal(refundsSnap.size, 1);
  });
});

describe("reverseSharedStashExpenseCore - unauthorized caller", () => {
  it("9. a non-owner, non-creator member is rejected and nothing is written", async () => {
    await seedTrip();
    const { expenseId } = await createActiveExpense(MEMBER_UID);

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        OTHER_MEMBER_UID,
        baseReversalRequest(expenseId)
      ),
      "permission-denied"
    );

    const expenseSnap = await db.collection("tripExpenses").doc(expenseId).get();
    assert.equal(expenseSnap.data()!.status, "active");
  });

  it("10. an outsider is rejected and nothing is written", async () => {
    await seedTrip();
    const { expenseId } = await createActiveExpense(MEMBER_UID);
    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        OUTSIDER_UID,
        baseReversalRequest(expenseId)
      ),
      "permission-denied"
    );
  });
});

describe("reverseSharedStashExpenseCore - creator removed / owner behavior", () => {
  it("11. the original creator, removed from the Trip, can no longer reverse their own expense", async () => {
    await seedTrip();
    const { expenseId } = await createActiveExpense(MEMBER_UID);
    await db.collection("trips").doc(TRIP_ID).update({
      memberIds: [OWNER_UID, OTHER_MEMBER_UID], // MEMBER_UID removed
    });

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseReversalRequest(expenseId)
      ),
      "permission-denied"
    );
  });

  it("12. the Trip owner can still reverse even after the original creator is removed", async () => {
    await seedTrip();
    const { expenseId } = await createActiveExpense(MEMBER_UID);
    await db.collection("trips").doc(TRIP_ID).update({
      memberIds: [OWNER_UID, OTHER_MEMBER_UID],
    });

    const result = await reverseSharedStashExpenseCore(
      db,
      OWNER_UID,
      baseReversalRequest(expenseId)
    );
    assert.equal(result.expenseId, expenseId);
  });
});

describe("reverseSharedStashExpenseCore - missing/malformed linked withdrawal", () => {
  it("13. a missing linked withdrawal is rejected and nothing is written", async () => {
    await seedTrip();
    const { expenseId, sharedStashTransactionId } = await createActiveExpense(
      MEMBER_UID
    );
    await db.collection("savingsTransactions").doc(sharedStashTransactionId).delete();

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseReversalRequest(expenseId)
      ),
      "failed-precondition"
    );
    const expenseSnap = await db.collection("tripExpenses").doc(expenseId).get();
    assert.equal(expenseSnap.data()!.status, "active");
  });

  it("14. a malformed sharedStashTransactionId on the Expense is rejected", async () => {
    await seedTrip();
    const { expenseId } = await createActiveExpense(MEMBER_UID);
    await db.collection("tripExpenses").doc(expenseId).update({
      sharedStashTransactionId: "",
    });

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseReversalRequest(expenseId)
      ),
      "failed-precondition"
    );
  });
});

// Checkpoint 4F.2A fix: reversal must reproduce the SAME
// savingsTransactions-history-emptiness guard recordSavingsTransaction.ts/
// recordSharedStashExpense.ts already use, rather than silently
// legacy-deriving an opening balance whenever both canonical ledger fields
// happen to be missing from the Trip.
describe("reverseSharedStashExpenseCore - missing ledger state with existing history (Checkpoint 4F.2A)", () => {
  it("25. both ledger fields missing but the original withdrawal/history still exists rejects rather than silently reconstructing the ledger", async () => {
    await seedTrip();
    const { expenseId } = await createActiveExpense(MEMBER_UID, {
      amountMinor: 2000,
    });

    // Remove both trusted ledger fields from the Trip, simulating
    // corruption/rollback, while leaving the original withdrawal (and
    // therefore savingsTransactions history for this Trip) fully intact.
    await db.collection("trips").doc(TRIP_ID).update({
      ledgerOpeningBalanceMinor: FieldValue.delete(),
      ledgerBalanceMinor: FieldValue.delete(),
    });
    const tripBefore = (await db.collection("trips").doc(TRIP_ID).get()).data()!;
    assert.equal("ledgerOpeningBalanceMinor" in tripBefore, false);
    assert.equal("ledgerBalanceMinor" in tripBefore, false);

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseReversalRequest(expenseId)
      ),
      "failed-precondition"
    );

    // No refund was written.
    const refundsSnap = await db
      .collection("savingsTransactions")
      .where("type", "==", "contribution")
      .get();
    assert.equal(refundsSnap.size, 0);

    // The Expense remains active - reversal did not partially apply.
    const expenseSnap = await db.collection("tripExpenses").doc(expenseId).get();
    assert.equal(expenseSnap.data()!.status, "active");

    // The Trip was not financially mutated, and the ledger fields were
    // NOT silently reconstructed as a side effect of the rejected attempt.
    const tripAfter = (await db.collection("trips").doc(TRIP_ID).get()).data()!;
    assert.equal("ledgerOpeningBalanceMinor" in tripAfter, false);
    assert.equal("ledgerBalanceMinor" in tripAfter, false);
    assert.equal(tripAfter.saved, tripBefore.saved);
  });
});

describe("reverseSharedStashExpenseCore - wrong amount/currency/resource/type on the linked withdrawal", () => {
  async function corruptWithdrawalAndExpectRejection(
    corruption: Record<string, unknown>
  ): Promise<void> {
    await seedTrip();
    const { expenseId, sharedStashTransactionId } = await createActiveExpense(
      MEMBER_UID,
      { amountMinor: 2000 }
    );
    const withdrawalRef = db
      .collection("savingsTransactions")
      .doc(sharedStashTransactionId);
    const withdrawalData = (await withdrawalRef.get()).data()!;
    await withdrawalRef.set({ ...withdrawalData, ...corruption });

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseReversalRequest(expenseId)
      ),
      "failed-precondition"
    );

    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()!.ledgerBalanceMinor, 8000); // unchanged
    const expenseSnap = await db.collection("tripExpenses").doc(expenseId).get();
    assert.equal(expenseSnap.data()!.status, "active"); // unchanged
  }

  it("15. wrong amount on the linked withdrawal is rejected", async () => {
    await corruptWithdrawalAndExpectRejection({ amountMinor: 9999 });
  });

  it("16. wrong currency on the linked withdrawal is rejected", async () => {
    await corruptWithdrawalAndExpectRejection({ currency: "EUR" });
  });

  it("17. wrong resourceId on the linked withdrawal is rejected", async () => {
    await corruptWithdrawalAndExpectRejection({ resourceId: "some-other-trip" });
  });

  it("18. wrong type on the linked withdrawal is rejected", async () => {
    await corruptWithdrawalAndExpectRejection({ type: "contribution" });
  });

  it("19. wrong linkedExpenseId on the linked withdrawal is rejected", async () => {
    await corruptWithdrawalAndExpectRejection({
      linkedExpenseId: "some-other-expense",
    });
  });
});

describe("reverseSharedStashExpenseCore - double-refund prevention", () => {
  it("20. a corrupted refund slot (pre-existing document at the deterministic refund id) blocks a genuinely new reversal", async () => {
    await seedTrip();
    const { expenseId } = await createActiveExpense(MEMBER_UID, {
      amountMinor: 2000,
    });
    const reversalRequest = baseReversalRequest(expenseId);

    // Double-refund prevention path: reverse once successfully,
    // then manually flip the Expense back to "active" (simulating a bug
    // elsewhere) and attempt to reverse again with the SAME
    // clientRequestId - the refund slot is already occupied, so this must
    // be rejected rather than writing a second refund.
    await reverseSharedStashExpenseCore(db, MEMBER_UID, reversalRequest);
    await db.collection("tripExpenses").doc(expenseId).update({
      status: "active",
    });

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(db, MEMBER_UID, reversalRequest),
      "failed-precondition"
    );

    const refundsSnap = await db
      .collection("savingsTransactions")
      .where("type", "==", "contribution")
      .get();
    assert.equal(refundsSnap.size, 1); // still only one refund ever written
  });
});

describe("reverseSharedStashExpenseCore - archived Trip", () => {
  it("21. an archived Trip still permits reversal", async () => {
    await seedTrip();
    const { expenseId } = await createActiveExpense(MEMBER_UID, {
      amountMinor: 2000,
    });
    await db.collection("trips").doc(TRIP_ID).update({
      archivedAt: new Date(),
      archivedBy: OWNER_UID,
    });

    const result = await reverseSharedStashExpenseCore(
      db,
      MEMBER_UID,
      baseReversalRequest(expenseId)
    );
    assert.equal(result.expenseId, expenseId);

    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()!.ledgerBalanceMinor, 10000);
  });
});

describe("reverseSharedStashExpenseCore - wrong-callable guard", () => {
  it("22. a member_out_of_pocket Expense cannot be reversed through this callable", async () => {
    await seedTrip();
    await db.collection("tripExpenses").doc("out-of-pocket-expense").set({
      tripId: TRIP_ID,
      payerUid: MEMBER_UID,
      createdBy: MEMBER_UID,
      amountMinor: 5000,
      currency: "USD",
      description: "Dinner",
      splitStrategy: "equal",
      paymentSource: "member_out_of_pocket",
      status: "active",
      createdAt: new Date(),
      creationRequest: {
        tripId: TRIP_ID,
        payerUid: MEMBER_UID,
        amountMinor: 5000,
        currency: "USD",
        description: "Dinner",
        category: null,
        splitStrategy: "equal",
        participants: [{ uid: MEMBER_UID }],
        paymentSource: "member_out_of_pocket",
        occurredAtInstantMs: null,
      },
    });

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        MEMBER_UID,
        baseReversalRequest("out-of-pocket-expense")
      ),
      "failed-precondition"
    );
  });
});

describe("reverseSharedStashExpenseCore - atomic failure leaves no partial state", () => {
  it("23. a rejected reversal (unauthorized) leaves zero refund/Expense/Trip-mutation side effects", async () => {
    await seedTrip();
    const { expenseId } = await createActiveExpense(MEMBER_UID, {
      amountMinor: 2000,
    });

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(
        db,
        OUTSIDER_UID,
        baseReversalRequest(expenseId)
      ),
      "permission-denied"
    );

    const refundsSnap = await db
      .collection("savingsTransactions")
      .where("type", "==", "contribution")
      .get();
    assert.equal(refundsSnap.size, 0);
    const expenseSnap = await db.collection("tripExpenses").doc(expenseId).get();
    assert.equal(expenseSnap.data()!.status, "active");
    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(tripSnap.data()!.ledgerBalanceMinor, 8000); // unchanged
  });

  it("24. a rejected reversal (missing withdrawal) leaves the deterministic refund id unused for a later legitimate retry", async () => {
    await seedTrip();
    const { expenseId, sharedStashTransactionId } = await createActiveExpense(
      MEMBER_UID,
      { amountMinor: 2000 }
    );
    const reversalRequest = baseReversalRequest(expenseId);

    // Temporarily hide the linked withdrawal to force a rejection.
    const withdrawalRef = db
      .collection("savingsTransactions")
      .doc(sharedStashTransactionId);
    const withdrawalData = (await withdrawalRef.get()).data()!;
    await withdrawalRef.delete();

    await assertRejectsWithCode(
      reverseSharedStashExpenseCore(db, MEMBER_UID, reversalRequest),
      "failed-precondition"
    );

    // Restore the withdrawal and retry the SAME reversal request - it
    // must not have been poisoned by the earlier rejection.
    await withdrawalRef.set(withdrawalData);
    const result = await reverseSharedStashExpenseCore(
      db,
      MEMBER_UID,
      reversalRequest
    );
    assert.equal(result.expenseId, expenseId);
  });
});
