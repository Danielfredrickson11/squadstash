// Tests for recordSavingsTransactionCore against the local Firestore
// emulator via the Admin SDK - never production, guarded below. Run via
// `npm --prefix functions test`, wrapped in
// `firebase emulators:exec --only firestore "..."` so
// FIRESTORE_EMULATOR_HOST is set automatically (the same mechanism the
// root test:rules script already relies on).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import type { App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import type { CallableRequest } from "firebase-functions/v2/https";
import {
  recordSavingsTransactionCore,
  requireAuthenticatedUid,
} from "../src/callables/recordSavingsTransaction";

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
const BUCKET_ID = "test-bucket";
const TRIP_ID = "test-trip";

let app: App;
let db: Firestore;

before(() => {
  app = initializeApp({ projectId: "demo-squadstash-functions-test" });
  db = getFirestore(app);
});

after(async () => {
  await deleteApp(app);
});

async function clearFirestore(): Promise<void> {
  for (const name of ["buckets", "trips", "savingsTransactions"]) {
    const snap = await db.collection(name).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

beforeEach(async () => {
  await clearFirestore();
});

function seedBucket(
  overrides: Record<string, unknown> = {}
): Promise<FirebaseFirestore.WriteResult> {
  return db
    .collection("buckets")
    .doc(BUCKET_ID)
    .set({
      ownerId: OWNER_UID,
      memberIds: [OWNER_UID, MEMBER_UID],
      name: "Test Bucket",
      target: 1000,
      balance: 100,
      ...overrides,
    });
}

function seedTrip(
  overrides: Record<string, unknown> = {}
): Promise<FirebaseFirestore.WriteResult> {
  return db
    .collection("trips")
    .doc(TRIP_ID)
    .set({
      ownerId: OWNER_UID,
      memberIds: [OWNER_UID, MEMBER_UID],
      title: "Test Trip",
      target: 1000,
      saved: 0,
      imageUrl: "https://example.com/trip.jpg",
      ...overrides,
    });
}

function baseRequest(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    resourceType: "bucket",
    resourceId: BUCKET_ID,
    memberUid: MEMBER_UID,
    type: "contribution",
    amountMinor: 500,
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

describe("recordSavingsTransactionCore - self-recorded success", () => {
  it("1. self Bucket contribution succeeds", async () => {
    await seedBucket();
    const result = await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest()
    );
    assert.equal(result.balanceMinor, 10500); // 100.00 legacy -> 10000 + 500
  });

  it("2. self Trip contribution succeeds", async () => {
    await seedTrip();
    const result = await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({ resourceType: "trip", resourceId: TRIP_ID })
    );
    assert.equal(result.balanceMinor, 500); // legacy saved 0 -> 0 + 500
  });

  it("3. self withdrawal succeeds with sufficient balance", async () => {
    await seedBucket({ balance: 100 }); // 10000 minor
    const result = await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({ type: "withdrawal", amountMinor: 400 })
    );
    assert.equal(result.balanceMinor, 9600);
  });

  it("owner can record for themselves", async () => {
    await seedBucket();
    const result = await recordSavingsTransactionCore(
      db,
      OWNER_UID,
      baseRequest({ memberUid: OWNER_UID })
    );
    assert.equal(result.balanceMinor, 10500);
  });
});

describe("recordSavingsTransactionCore - permission", () => {
  // Milestone 2C Checkpoint 2C-1: owner-on-behalf recording is
  // intentionally disabled until trusted, accepted membership exists -
  // see the security note on recordSavingsTransaction. A Bucket owner can
  // unilaterally add another uid to memberIds with no acceptance step, so
  // membership alone is not (yet) a trustworthy basis for attributing a
  // transaction to someone other than the caller.
  it("4. owner attempting to record for another current member is rejected", async () => {
    await seedBucket();
    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        OWNER_UID,
        baseRequest({ memberUid: MEMBER_UID })
      ),
      "permission-denied"
    );
  });

  it("5. ordinary member cannot record for another member", async () => {
    await seedBucket({ memberIds: [OWNER_UID, MEMBER_UID, OTHER_MEMBER_UID] });
    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({ memberUid: OTHER_MEMBER_UID })
      ),
      "permission-denied"
    );
  });

  it("6. nonmember is rejected", async () => {
    await seedBucket();
    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        OUTSIDER_UID,
        baseRequest({ memberUid: OUTSIDER_UID })
      ),
      "permission-denied"
    );
  });
});

// 7. Missing-auth rejection: requireAuthenticatedUid is the exact
// function the real onCall wrapper calls (see recordSavingsTransaction),
// not a separate/duplicated check - testing it directly tests the
// production auth boundary without needing the heavier Functions-
// emulator/HTTPS callable machinery this checkpoint avoids defaulting to.
describe("requireAuthenticatedUid - the production auth boundary", () => {
  it("7. throws HttpsError(\"unauthenticated\") when auth is missing", () => {
    assert.throws(
      () => requireAuthenticatedUid(undefined),
      (err: unknown) => {
        assert.ok(err instanceof HttpsError, "expected an HttpsError");
        assert.equal((err as HttpsError).code, "unauthenticated");
        return true;
      }
    );
  });

  it("returns the uid when auth is present", () => {
    const auth = { uid: MEMBER_UID } as CallableRequest["auth"];
    assert.equal(requireAuthenticatedUid(auth), MEMBER_UID);
  });
});

describe("recordSavingsTransactionCore - input validation", () => {
  it("8. amountMinor = 0 is rejected", async () => {
    await seedBucket();
    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({ amountMinor: 0 })
      ),
      "invalid-argument"
    );
  });

  it("9. negative amountMinor is rejected", async () => {
    await seedBucket();
    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({ amountMinor: -100 })
      ),
      "invalid-argument"
    );
  });

  it("10. fractional amountMinor is rejected", async () => {
    await seedBucket();
    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({ amountMinor: 12.34 })
      ),
      "invalid-argument"
    );
  });

  it("11. unsafe-integer amountMinor is rejected", async () => {
    await seedBucket();
    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({ amountMinor: 1e21 })
      ),
      "invalid-argument"
    );
  });

  it("12. currency mismatch is rejected", async () => {
    await seedBucket(); // no currency field -> effective USD
    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({ currency: "EUR" })
      ),
      "failed-precondition"
    );
  });

  it("13. missing parent resource is rejected", async () => {
    await assertRejectsWithCode(
      recordSavingsTransactionCore(db, MEMBER_UID, baseRequest()),
      "not-found"
    );
  });

  it("14. malformed parent currency fails loudly instead of defaulting to USD", async () => {
    await seedBucket({ currency: 12345 });
    await assertRejectsWithCode(
      recordSavingsTransactionCore(db, MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
  });
});

describe("recordSavingsTransactionCore - legacy initialization", () => {
  it("15. legacy Bucket opening balance initializes correctly", async () => {
    await seedBucket({ balance: 12.34 }); // -> 1234 minor
    await recordSavingsTransactionCore(db, MEMBER_UID, baseRequest());

    const snap = await db.collection("buckets").doc(BUCKET_ID).get();
    const data = snap.data()!;
    assert.equal(data.ledgerOpeningBalanceMinor, 1234);
    assert.equal(data.ledgerBalanceMinor, 1734); // 1234 + 500
  });

  it("16. legacy Trip saved initializes correctly", async () => {
    await seedTrip({ saved: 5 }); // -> 500 minor
    await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({ resourceType: "trip", resourceId: TRIP_ID })
    );

    const snap = await db.collection("trips").doc(TRIP_ID).get();
    const data = snap.data()!;
    assert.equal(data.ledgerOpeningBalanceMinor, 500);
    assert.equal(data.ledgerBalanceMinor, 1000); // 500 + 500
  });

  it("17. opening balance remains unattributed to any member", async () => {
    await seedBucket({ balance: 100 }); // 10000 minor, no history yet
    await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({ amountMinor: 300 })
    );

    const txnSnap = await db
      .collection("savingsTransactions")
      .where("resourceType", "==", "bucket")
      .where("resourceId", "==", BUCKET_ID)
      .get();

    // The only recorded transaction is the new contribution - the 10000
    // legacy opening balance never appears as anyone's transaction.
    assert.equal(txnSnap.size, 1);
    assert.equal(txnSnap.docs[0]?.data().amountMinor, 300);
  });

  it("18. ledgerBalanceMinor updates correctly on a normal write", async () => {
    await seedBucket({
      ledgerOpeningBalanceMinor: 1000,
      ledgerBalanceMinor: 1000,
    });
    const result = await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({ amountMinor: 250 })
    );
    assert.equal(result.balanceMinor, 1250);
  });

  it("19. Bucket.balance compatibility cache updates correctly", async () => {
    await seedBucket({ balance: 10 }); // 1000 minor
    await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({ amountMinor: 250 })
    );
    const snap = await db.collection("buckets").doc(BUCKET_ID).get();
    assert.equal(snap.data()!.balance, 12.5); // (1000 + 250) / 100
  });

  it("20. Trip.saved compatibility cache updates correctly", async () => {
    await seedTrip({ saved: 10 }); // 1000 minor
    await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({
        resourceType: "trip",
        resourceId: TRIP_ID,
        amountMinor: 250,
      })
    );
    const snap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(snap.data()!.saved, 12.5);
  });
});

describe("recordSavingsTransactionCore - non-negative enforcement", () => {
  it("21. a withdrawal that would make the balance negative is rejected", async () => {
    await seedBucket({ balance: 1 }); // 100 minor
    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({ type: "withdrawal", amountMinor: 200 })
      ),
      "failed-precondition"
    );
  });

  it("22. a failed withdrawal creates no ledger document", async () => {
    await seedBucket({ balance: 1 });
    await assert.rejects(
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({ type: "withdrawal", amountMinor: 200 })
      )
    );
    const snap = await db.collection("savingsTransactions").get();
    assert.equal(snap.size, 0);
  });

  it("23. a failed withdrawal does not change parent caches", async () => {
    await seedBucket({ balance: 1 });
    await assert.rejects(
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({ type: "withdrawal", amountMinor: 200 })
      )
    );
    const snap = await db.collection("buckets").doc(BUCKET_ID).get();
    const data = snap.data()!;
    assert.equal(data.balance, 1);
    assert.equal("ledgerBalanceMinor" in data, false);
  });
});

describe("recordSavingsTransactionCore - trusted ledger vs legacy cache", () => {
  it("24. a second write uses ledgerBalanceMinor, not the (possibly stale) legacy dollar cache", async () => {
    await seedBucket({ balance: 10 }); // initializes to 1000 minor
    await recordSavingsTransactionCore(db, MEMBER_UID, baseRequest({ amountMinor: 500 })); // -> 1500 minor / $15.00 cache

    // Directly corrupt the dollar cache out-of-band (simulating drift/a
    // bug), without touching the trusted minor field.
    await db.collection("buckets").doc(BUCKET_ID).update({ balance: 999999 });

    const result = await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({ amountMinor: 100 })
    );
    // Must be 1500 + 100, derived from ledgerBalanceMinor - NOT anything
    // derived from the corrupted 999999 dollar cache.
    assert.equal(result.balanceMinor, 1600);
  });
});

describe("recordSavingsTransactionCore - idempotency", () => {
  it("25. an idempotent retry with the same request id does not double-apply", async () => {
    await seedBucket({ balance: 10 }); // 1000 minor
    const request = baseRequest({ amountMinor: 250 });

    const first = await recordSavingsTransactionCore(db, MEMBER_UID, request);
    const second = await recordSavingsTransactionCore(db, MEMBER_UID, request);

    assert.equal(first.balanceMinor, 1250);
    assert.equal(second.balanceMinor, 1250);
    assert.equal(first.transactionId, second.transactionId);

    const txnSnap = await db.collection("savingsTransactions").get();
    assert.equal(txnSnap.size, 1);
  });

  it("26. the same request id with a different amount is rejected", async () => {
    await seedBucket({ balance: 10 });
    const clientRequestId = randomUUID();
    await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({ clientRequestId, amountMinor: 250 })
    );

    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({ clientRequestId, amountMinor: 999 })
      ),
      "already-exists"
    );
  });

  it("27. the same request id with a different resource/member/type is rejected", async () => {
    await seedBucket({ balance: 10 });
    await seedTrip();
    const clientRequestId = randomUUID();
    await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({ clientRequestId })
    );

    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({
          clientRequestId,
          resourceType: "trip",
          resourceId: TRIP_ID,
        })
      ),
      "already-exists"
    );
  });
});

describe("recordSavingsTransactionCore - ambiguous/partial ledger state", () => {
  it("28. existing transaction history with no ledger initialization fields fails", async () => {
    await seedBucket({ balance: 10 });
    // Simulate a historical/admin-created ledger record predating this
    // Function, with no corresponding ledger init on the parent.
    await db.collection("savingsTransactions").add({
      resourceType: "bucket",
      resourceId: BUCKET_ID,
      memberUid: MEMBER_UID,
      recordedBy: MEMBER_UID,
      amountMinor: 100,
      currency: "USD",
      type: "contribution",
      createdAt: new Date(),
      reversalOf: null,
    });

    await assertRejectsWithCode(
      recordSavingsTransactionCore(db, MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
  });

  it("29a. partial ledger state (opening only) fails", async () => {
    await seedBucket({ balance: 10, ledgerOpeningBalanceMinor: 1000 });
    await assertRejectsWithCode(
      recordSavingsTransactionCore(db, MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
  });

  it("29b. partial ledger state (balance only) fails", async () => {
    await seedBucket({ balance: 10, ledgerBalanceMinor: 1000 });
    await assertRejectsWithCode(
      recordSavingsTransactionCore(db, MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
  });

  it("30. an invalid/malformed legacy balance fails rather than becoming zero", async () => {
    await seedBucket({ balance: "not-a-number" });
    await assertRejectsWithCode(
      recordSavingsTransactionCore(db, MEMBER_UID, baseRequest()),
      "failed-precondition"
    );
  });
});

// Checkpoint 4B.5C (docs/audits/TRIP_ARCHIVE_DELETE_SAFETY_PREFLIGHT_
// 2026-09-13.md, as hardened by its 4B.5A.1 amendment): the trusted
// enforcement half of the archive lifecycle - 4B.5B already built the
// Rules/UI half. `archivedAt`/`archivedBy` are the same fields
// firestore.rules' `tripIsActive()` checks, so seeding them here directly
// (bypassing Rules entirely via the Admin SDK, same as every other seed
// in this file) exercises exactly the shape the trusted backend must
// reason about independently of any client enforcement.
describe("recordSavingsTransactionCore - archived Trip enforcement (Checkpoint 4B.5C)", () => {
  it("1. active Trip contribution succeeds", async () => {
    await seedTrip();
    const result = await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({ resourceType: "trip", resourceId: TRIP_ID })
    );
    assert.equal(result.balanceMinor, 500);
  });

  it("2. archived Trip NEW contribution fails with failed-precondition", async () => {
    await seedTrip({ archivedAt: new Date(), archivedBy: OWNER_UID });
    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({ resourceType: "trip", resourceId: TRIP_ID })
      ),
      "failed-precondition"
    );
  });

  // Checkpoint 4B.5C.1: authorization must be resolved BEFORE the archive
  // precondition is ever evaluated, so an unauthorized caller learns only
  // permission-denied - never whether the Trip they're not authorized for
  // happens to be archived.
  it("4B.5C.1-1. archived Trip + authenticated non-member using their own uid fails with permission-denied, not failed-precondition", async () => {
    await seedTrip({ archivedAt: new Date(), archivedBy: OWNER_UID });
    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        OUTSIDER_UID,
        baseRequest({
          resourceType: "trip",
          resourceId: TRIP_ID,
          memberUid: OUTSIDER_UID,
        })
      ),
      "permission-denied"
    );
  });

  it("4B.5C.1-2. archived Trip + memberUid names a real member but authUid differs fails with permission-denied (self-only), not archive failed-precondition", async () => {
    await seedTrip({ archivedAt: new Date(), archivedBy: OWNER_UID });
    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        OWNER_UID,
        baseRequest({
          resourceType: "trip",
          resourceId: TRIP_ID,
          memberUid: MEMBER_UID,
        })
      ),
      "permission-denied"
    );
  });

  it("3. archived Trip withdrawal succeeds when balance is sufficient", async () => {
    await seedTrip({
      archivedAt: new Date(),
      archivedBy: OWNER_UID,
      saved: 10, // -> 1000 minor
    });
    const result = await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({
        resourceType: "trip",
        resourceId: TRIP_ID,
        type: "withdrawal",
        amountMinor: 400,
      })
    );
    assert.equal(result.balanceMinor, 600);
  });

  it("4. archived Trip withdrawal still fails when balance is insufficient", async () => {
    await seedTrip({
      archivedAt: new Date(),
      archivedBy: OWNER_UID,
      saved: 1, // -> 100 minor
    });
    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({
          resourceType: "trip",
          resourceId: TRIP_ID,
          type: "withdrawal",
          amountMinor: 200,
        })
      ),
      "failed-precondition"
    );
  });

  it("5. legacy Trip with no archivedAt key contribution succeeds", async () => {
    await seedTrip();
    const snap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal("archivedAt" in snap.data()!, false);
    const result = await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({ resourceType: "trip", resourceId: TRIP_ID })
    );
    assert.equal(result.balanceMinor, 500);
  });

  it("6. Trip with archivedAt: null contribution succeeds", async () => {
    await seedTrip({ archivedAt: null });
    const result = await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({ resourceType: "trip", resourceId: TRIP_ID })
    );
    assert.equal(result.balanceMinor, 500);
  });

  it("7. ordinary Bucket contribution is unchanged", async () => {
    await seedBucket();
    const result = await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest()
    );
    assert.equal(result.balanceMinor, 10500);
  });

  it("8. ordinary Bucket withdrawal is unchanged", async () => {
    await seedBucket({ balance: 100 });
    const result = await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({ type: "withdrawal", amountMinor: 400 })
    );
    assert.equal(result.balanceMinor, 9600);
  });

  it("9. trip_personal Bucket contribution is unchanged even when the linked Trip is archived", async () => {
    await seedTrip({ archivedAt: new Date(), archivedBy: OWNER_UID });
    const personalBucketId = "test-trip-personal-bucket";
    await db.collection("buckets").doc(personalBucketId).set({
      ownerId: MEMBER_UID,
      memberIds: [MEMBER_UID],
      bucketType: "trip_personal",
      linkedTripId: TRIP_ID,
      name: "My Stash",
      target: 500,
      balance: 5,
    });
    const result = await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({
        resourceType: "bucket",
        resourceId: personalBucketId,
        amountMinor: 200,
      })
    );
    assert.equal(result.balanceMinor, 700); // 500 legacy + 200
  });

  it("10. trip_personal Bucket withdrawal is unchanged even when the linked Trip is archived", async () => {
    await seedTrip({ archivedAt: new Date(), archivedBy: OWNER_UID });
    const personalBucketId = "test-trip-personal-bucket";
    await db.collection("buckets").doc(personalBucketId).set({
      ownerId: MEMBER_UID,
      memberIds: [MEMBER_UID],
      bucketType: "trip_personal",
      linkedTripId: TRIP_ID,
      name: "My Stash",
      target: 500,
      balance: 5, // -> 500 minor
    });
    const result = await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({
        resourceType: "bucket",
        resourceId: personalBucketId,
        type: "withdrawal",
        amountMinor: 200,
      })
    );
    assert.equal(result.balanceMinor, 300);
  });

  it("11. an exact successful Trip contribution replay still reconciles idempotently after the Trip later archives", async () => {
    await seedTrip();
    const request = baseRequest({
      resourceType: "trip",
      resourceId: TRIP_ID,
      amountMinor: 250,
    });

    const first = await recordSavingsTransactionCore(db, MEMBER_UID, request);
    assert.equal(first.balanceMinor, 250);

    await db.collection("trips").doc(TRIP_ID).update({
      archivedAt: new Date(),
      archivedBy: OWNER_UID,
    });

    const replay = await recordSavingsTransactionCore(db, MEMBER_UID, request);
    assert.equal(replay.balanceMinor, 250);
    assert.equal(replay.transactionId, first.transactionId);

    const txnSnap = await db.collection("savingsTransactions").get();
    assert.equal(txnSnap.size, 1);
  });

  it("12. a NEW request id against a Trip that archived after an earlier contribution fails", async () => {
    await seedTrip();
    await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({
        resourceType: "trip",
        resourceId: TRIP_ID,
        amountMinor: 250,
      })
    );

    await db.collection("trips").doc(TRIP_ID).update({
      archivedAt: new Date(),
      archivedBy: OWNER_UID,
    });

    await assertRejectsWithCode(
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({
          resourceType: "trip",
          resourceId: TRIP_ID,
          amountMinor: 100,
        })
      ),
      "failed-precondition"
    );
  });

  it("13. an archived Trip contribution creates no savingsTransactions document", async () => {
    await seedTrip({ archivedAt: new Date(), archivedBy: OWNER_UID });
    await assert.rejects(
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({ resourceType: "trip", resourceId: TRIP_ID })
      )
    );
    const snap = await db.collection("savingsTransactions").get();
    assert.equal(snap.size, 0);
  });

  it("14. an archived Trip contribution does not mutate ledgerBalanceMinor", async () => {
    await seedTrip({
      archivedAt: new Date(),
      archivedBy: OWNER_UID,
      ledgerOpeningBalanceMinor: 1000,
      ledgerBalanceMinor: 1000,
    });
    await assert.rejects(
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({ resourceType: "trip", resourceId: TRIP_ID })
      )
    );
    const snap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(snap.data()!.ledgerBalanceMinor, 1000);
  });

  it("15. an archived Trip contribution does not mutate Trip.saved", async () => {
    await seedTrip({
      archivedAt: new Date(),
      archivedBy: OWNER_UID,
      saved: 10,
    });
    await assert.rejects(
      recordSavingsTransactionCore(
        db,
        MEMBER_UID,
        baseRequest({ resourceType: "trip", resourceId: TRIP_ID })
      )
    );
    const snap = await db.collection("trips").doc(TRIP_ID).get();
    assert.equal(snap.data()!.saved, 10);
    assert.equal("ledgerBalanceMinor" in snap.data()!, false);
  });
});

describe("recordSavingsTransactionCore - persisted transaction shape", () => {
  it("records memberUid, recordedBy, reversalOf, createdAt, and no stored id field for a valid self write", async () => {
    await seedBucket();
    const result = await recordSavingsTransactionCore(
      db,
      MEMBER_UID,
      baseRequest({ memberUid: MEMBER_UID })
    );

    const snap = await db
      .collection("savingsTransactions")
      .doc(result.transactionId)
      .get();
    const data = snap.data()!;

    assert.equal(data.memberUid, MEMBER_UID);
    assert.equal(data.recordedBy, MEMBER_UID);
    assert.equal(data.reversalOf, null);
    assert.ok(data.createdAt, "createdAt should be populated");
    assert.equal("id" in data, false);
  });
});
