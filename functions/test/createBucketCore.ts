// Tests for createBucketCore against the local Firestore emulator via the
// Admin SDK - never production, guarded below. Run via
// `npm --prefix functions test`, wrapped in
// `firebase emulators:exec --only firestore "..."` so
// FIRESTORE_EMULATOR_HOST is set automatically (the same mechanism the
// root test:rules script and recordSavingsTransactionCore.ts already
// rely on).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import type { App } from "firebase-admin/app";
import { Timestamp, getFirestore } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import type { CallableRequest } from "firebase-functions/v2/https";
import {
  createBucketCore,
  requireAuthenticatedUid,
} from "../src/callables/createBucket";
import { recordSavingsTransactionCore } from "../src/callables/recordSavingsTransaction";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "FIRESTORE_EMULATOR_HOST is not set. Run these tests via " +
      '`firebase emulators:exec --only firestore "npm --prefix functions test"` ' +
      "so the Admin SDK talks to the local emulator, never production."
  );
}

const OWNER_UID = "owner-uid";
const OTHER_UID = "other-uid";

let app: App;
let db: Firestore;

before(() => {
  // A distinct "demo-" project id from recordSavingsTransactionCore.ts's
  // own test app - both files' Firestore emulator databases are fully
  // isolated from each other this way. Node's test runner executes test
  // FILES concurrently by default (unlike this repo's Jest-based rules
  // tests, which force --runInBand), so sharing one project id would let
  // this file's blanket per-test clearFirestore() race with and wipe out
  // documents the other file's concurrently-running tests just seeded
  // (and vice versa) - this was observed directly (spurious
  // "No bucket found for the given resourceId." failures in the
  // unrelated recordSavingsTransactionCore suite) before this fix.
  app = initializeApp({
    projectId: "demo-squadstash-functions-test-create-bucket",
  });
  db = getFirestore(app);
});

after(async () => {
  await deleteApp(app);
});

async function clearFirestore(): Promise<void> {
  for (const name of ["buckets", "savingsTransactions", "trips"]) {
    const snap = await db.collection(name).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

// Checkpoint 3F.3B.4 trip_personal fixtures.
const TRIP_ID = "canada-trip";
const OTHER_TRIP_ID = "hawaii-trip";

function baseTripData(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ownerId: OWNER_UID,
    memberIds: [OWNER_UID, OTHER_UID],
    title: "Canada Trip",
    location: "Banff, Canada",
    target: 5000,
    saved: 0,
    imageUrl: "https://example.com/canada.jpg",
    tripStartDate: "2027-06-12",
    tripEndDate: null,
    ...overrides,
  };
}

async function seedTrip(
  tripId: string,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  await db.collection("trips").doc(tripId).set(baseTripData(overrides));
}

function tripPersonalRequest(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return baseRequest({
    name: "Canada Trip — My Stash",
    target: 1000,
    startingBalanceMinor: 0,
    bucketType: "trip_personal",
    linkedTripId: TRIP_ID,
    ...overrides,
  });
}

beforeEach(async () => {
  await clearFirestore();
});

function baseRequest(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    name: "Emergency Fund",
    target: 10000,
    startingBalanceMinor: 200000,
    color: "#2563EB",
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

describe("requireAuthenticatedUid - the production auth boundary", () => {
  it("throws HttpsError(\"unauthenticated\") when auth is missing", () => {
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
    const auth = { uid: OWNER_UID } as CallableRequest["auth"];
    assert.equal(requireAuthenticatedUid(auth), OWNER_UID);
  });
});

describe("createBucketCore - name validation", () => {
  it("missing name is rejected", async () => {
    await assertRejectsWithCode(
      createBucketCore(db, OWNER_UID, baseRequest({ name: undefined })),
      "invalid-argument"
    );
  });

  it("non-string name is rejected", async () => {
    await assertRejectsWithCode(
      createBucketCore(db, OWNER_UID, baseRequest({ name: 123 })),
      "invalid-argument"
    );
  });

  it("whitespace-only name is rejected", async () => {
    await assertRejectsWithCode(
      createBucketCore(db, OWNER_UID, baseRequest({ name: "   " })),
      "invalid-argument"
    );
  });

  it("name is trimmed and the trimmed value is stored/returned as canonical", async () => {
    const clientRequestId = randomUUID();
    await createBucketCore(
      db,
      OWNER_UID,
      baseRequest({ name: "  Emergency Fund  ", clientRequestId })
    );
    const snap = await db.collection("buckets").doc(clientRequestId).get();
    assert.equal(snap.data()!.name, "Emergency Fund");
  });
});

describe("createBucketCore - target validation", () => {
  it("missing target is rejected", async () => {
    await assertRejectsWithCode(
      createBucketCore(db, OWNER_UID, baseRequest({ target: undefined })),
      "invalid-argument"
    );
  });

  it("non-number target is rejected", async () => {
    await assertRejectsWithCode(
      createBucketCore(db, OWNER_UID, baseRequest({ target: "10000" })),
      "invalid-argument"
    );
  });

  it("NaN target is rejected", async () => {
    await assertRejectsWithCode(
      createBucketCore(db, OWNER_UID, baseRequest({ target: NaN })),
      "invalid-argument"
    );
  });

  it("infinite target is rejected", async () => {
    await assertRejectsWithCode(
      createBucketCore(db, OWNER_UID, baseRequest({ target: Infinity })),
      "invalid-argument"
    );
  });

  it("zero target is rejected", async () => {
    await assertRejectsWithCode(
      createBucketCore(db, OWNER_UID, baseRequest({ target: 0 })),
      "invalid-argument"
    );
  });

  it("negative target is rejected", async () => {
    await assertRejectsWithCode(
      createBucketCore(db, OWNER_UID, baseRequest({ target: -100 })),
      "invalid-argument"
    );
  });

  it("valid positive target is accepted", async () => {
    const clientRequestId = randomUUID();
    await createBucketCore(
      db,
      OWNER_UID,
      baseRequest({ target: 5000, clientRequestId })
    );
    const snap = await db.collection("buckets").doc(clientRequestId).get();
    assert.equal(snap.data()!.target, 5000);
  });
});

describe("createBucketCore - startingBalanceMinor validation", () => {
  it("missing startingBalanceMinor is rejected", async () => {
    await assertRejectsWithCode(
      createBucketCore(
        db,
        OWNER_UID,
        baseRequest({ startingBalanceMinor: undefined })
      ),
      "invalid-argument"
    );
  });

  it("non-number startingBalanceMinor is rejected", async () => {
    await assertRejectsWithCode(
      createBucketCore(
        db,
        OWNER_UID,
        baseRequest({ startingBalanceMinor: "200000" })
      ),
      "invalid-argument"
    );
  });

  it("negative startingBalanceMinor is rejected", async () => {
    await assertRejectsWithCode(
      createBucketCore(
        db,
        OWNER_UID,
        baseRequest({ startingBalanceMinor: -1 })
      ),
      "invalid-argument"
    );
  });

  it("non-integer startingBalanceMinor is rejected", async () => {
    await assertRejectsWithCode(
      createBucketCore(
        db,
        OWNER_UID,
        baseRequest({ startingBalanceMinor: 12.34 })
      ),
      "invalid-argument"
    );
  });

  it("unsafe-integer startingBalanceMinor is rejected", async () => {
    await assertRejectsWithCode(
      createBucketCore(
        db,
        OWNER_UID,
        baseRequest({ startingBalanceMinor: 1e21 })
      ),
      "invalid-argument"
    );
  });

  it("zero startingBalanceMinor is accepted", async () => {
    await assert.doesNotReject(
      createBucketCore(
        db,
        OWNER_UID,
        baseRequest({ startingBalanceMinor: 0 })
      )
    );
  });

  it("valid nonzero startingBalanceMinor is accepted", async () => {
    await assert.doesNotReject(
      createBucketCore(
        db,
        OWNER_UID,
        baseRequest({ startingBalanceMinor: 200000 })
      )
    );
  });
});

describe("createBucketCore - color validation", () => {
  it("invalid non-null/non-string color is rejected", async () => {
    await assertRejectsWithCode(
      createBucketCore(db, OWNER_UID, baseRequest({ color: 12345 })),
      "invalid-argument"
    );
  });

  it("null color is accepted", async () => {
    const clientRequestId = randomUUID();
    await createBucketCore(
      db,
      OWNER_UID,
      baseRequest({ color: null, clientRequestId })
    );
    const snap = await db.collection("buckets").doc(clientRequestId).get();
    assert.equal(snap.data()!.color, null);
  });

  it("a valid string color is accepted", async () => {
    const clientRequestId = randomUUID();
    await createBucketCore(
      db,
      OWNER_UID,
      baseRequest({ color: "#EF4444", clientRequestId })
    );
    const snap = await db.collection("buckets").doc(clientRequestId).get();
    assert.equal(snap.data()!.color, "#EF4444");
  });
});

describe("createBucketCore - clientRequestId validation", () => {
  it("missing clientRequestId is rejected", async () => {
    await assertRejectsWithCode(
      createBucketCore(
        db,
        OWNER_UID,
        baseRequest({ clientRequestId: undefined })
      ),
      "invalid-argument"
    );
  });

  it("clientRequestId with disallowed characters is rejected", async () => {
    await assertRejectsWithCode(
      createBucketCore(
        db,
        OWNER_UID,
        baseRequest({ clientRequestId: "not/a valid id" })
      ),
      "invalid-argument"
    );
  });

  it("a valid safe clientRequestId is accepted", async () => {
    await assert.doesNotReject(
      createBucketCore(
        db,
        OWNER_UID,
        baseRequest({ clientRequestId: "valid_Request-123" })
      )
    );
  });
});

describe("createBucketCore - canonical financial state", () => {
  it("a zero Starting Balance writes balance/ledgerOpeningBalanceMinor/ledgerBalanceMinor all as 0", async () => {
    const clientRequestId = randomUUID();
    const result = await createBucketCore(
      db,
      OWNER_UID,
      baseRequest({ startingBalanceMinor: 0, clientRequestId })
    );
    assert.equal(result.ledgerBalanceMinor, 0);

    const snap = await db.collection("buckets").doc(clientRequestId).get();
    const data = snap.data()!;
    assert.equal(data.balance, 0);
    assert.equal(data.ledgerOpeningBalanceMinor, 0);
    assert.equal(data.ledgerBalanceMinor, 0);
  });

  it("a nonzero Starting Balance ($2,000) writes the exact canonical financial state", async () => {
    const clientRequestId = randomUUID();
    const result = await createBucketCore(
      db,
      OWNER_UID,
      baseRequest({ startingBalanceMinor: 200000, clientRequestId })
    );
    assert.equal(result.ledgerBalanceMinor, 200000);

    const snap = await db.collection("buckets").doc(clientRequestId).get();
    const data = snap.data()!;
    assert.equal(data.balance, 2000);
    assert.equal(data.ledgerOpeningBalanceMinor, 200000);
    assert.equal(data.ledgerBalanceMinor, 200000);
  });
});

describe("createBucketCore - ownership and defaults", () => {
  it("ownerId equals the authenticated uid, never any client-supplied value", async () => {
    const clientRequestId = randomUUID();
    await createBucketCore(
      db,
      OWNER_UID,
      // ownerId in raw input must never override the authenticated owner.
      baseRequest({ clientRequestId, ownerId: OTHER_UID })
    );
    const snap = await db.collection("buckets").doc(clientRequestId).get();
    assert.equal(snap.data()!.ownerId, OWNER_UID);
  });

  it("memberIds is exactly [authUid], never any client-supplied value", async () => {
    const clientRequestId = randomUUID();
    await createBucketCore(
      db,
      OWNER_UID,
      baseRequest({ clientRequestId, memberIds: [OTHER_UID, OWNER_UID] })
    );
    const snap = await db.collection("buckets").doc(clientRequestId).get();
    assert.deepEqual(snap.data()!.memberIds, [OWNER_UID]);
  });

  it("currency is backend-set to USD, ignoring any client-supplied value", async () => {
    const clientRequestId = randomUUID();
    await createBucketCore(
      db,
      OWNER_UID,
      baseRequest({ clientRequestId, currency: "EUR" })
    );
    const snap = await db.collection("buckets").doc(clientRequestId).get();
    assert.equal(snap.data()!.currency, "USD");
  });

  it("bucketType defaults to personal when omitted", async () => {
    const clientRequestId = randomUUID();
    await createBucketCore(db, OWNER_UID, baseRequest({ clientRequestId }));
    const snap = await db.collection("buckets").doc(clientRequestId).get();
    assert.equal(snap.data()!.bucketType, "personal");
  });

  // Checkpoint 3F.3B.4: previously linkedTripId was silently ignored for
  // an ordinary create (bucketType always hardcoded to "personal", full
  // stop). Now that bucketType/linkedTripId are real, validated inputs,
  // supplying linkedTripId without bucketType: "trip_personal" is an
  // explicit product/security rule ("PERSONAL: linkedTripId must be
  // null/absent") and must be REJECTED, not silently dropped - see the
  // dedicated trip_personal describe block below for that coverage.
  // targetDate/imageUrl/archivedAt remain simply-unread/ignored fields,
  // unaffected by this checkpoint.
  it("targetDate/imageUrl/archivedAt are absent, ignoring any client-supplied value", async () => {
    const clientRequestId = randomUUID();
    await createBucketCore(
      db,
      OWNER_UID,
      baseRequest({
        clientRequestId,
        targetDate: new Date(),
        imageUrl: "https://example.com/x.jpg",
        archivedAt: new Date(),
      })
    );
    const snap = await db.collection("buckets").doc(clientRequestId).get();
    const data = snap.data()!;
    assert.equal("linkedTripId" in data, false);
    assert.equal("targetDate" in data, false);
    assert.equal("imageUrl" in data, false);
    assert.equal("archivedAt" in data, false);
  });

  it("does not create a buckets/{id}/members subdocument", async () => {
    const clientRequestId = randomUUID();
    await createBucketCore(db, OWNER_UID, baseRequest({ clientRequestId }));
    const membersSnap = await db
      .collection("buckets")
      .doc(clientRequestId)
      .collection("members")
      .get();
    assert.equal(membersSnap.size, 0);
  });
});

describe("createBucketCore - timestamps", () => {
  it("createdAt/lastUpdatedAt are persisted Timestamps and lastUpdatedBy is the authUid", async () => {
    const clientRequestId = randomUUID();
    await createBucketCore(db, OWNER_UID, baseRequest({ clientRequestId }));
    const snap = await db.collection("buckets").doc(clientRequestId).get();
    const data = snap.data()!;

    assert.ok(data.createdAt instanceof Timestamp, "createdAt should be a Timestamp");
    assert.ok(
      data.lastUpdatedAt instanceof Timestamp,
      "lastUpdatedAt should be a Timestamp"
    );
    assert.equal(data.lastUpdatedBy, OWNER_UID);
  });
});

describe("createBucketCore - creationRequest metadata", () => {
  it("a fresh canonical Bucket stores the exact trusted creationRequest metadata", async () => {
    const clientRequestId = randomUUID();
    const request = baseRequest({
      clientRequestId,
      name: "  Emergency Fund  ",
      target: 10000,
      startingBalanceMinor: 200000,
      color: "#2563EB",
    });
    await createBucketCore(db, OWNER_UID, request);

    const snap = await db.collection("buckets").doc(clientRequestId).get();
    assert.deepEqual(snap.data()!.creationRequest, {
      clientRequestId,
      ownerId: OWNER_UID,
      name: "Emergency Fund", // trimmed
      target: 10000,
      startingBalanceMinor: 200000,
      color: "#2563EB",
      bucketType: "personal",
      linkedTripId: null,
    });
  });
});

describe("createBucketCore - no savingsTransaction for Starting Balance", () => {
  it("creating a Bucket with a nonzero Starting Balance creates zero savingsTransactions documents", async () => {
    await createBucketCore(db, OWNER_UID, baseRequest({ startingBalanceMinor: 200000 }));
    const snap = await db.collection("savingsTransactions").get();
    assert.equal(snap.size, 0);
  });
});

describe("createBucketCore - idempotency (no mutation yet)", () => {
  it("same requestId + same facts returns the same bucketId, and exactly one Bucket exists", async () => {
    const request = baseRequest();
    const first = await createBucketCore(db, OWNER_UID, request);
    const second = await createBucketCore(db, OWNER_UID, request);

    assert.equal(first.bucketId, second.bucketId);
    assert.equal(first.ledgerBalanceMinor, second.ledgerBalanceMinor);

    const snap = await db.collection("buckets").get();
    assert.equal(snap.size, 1);
  });

  it("an immediate replay does not alter the stored timestamps", async () => {
    const request = baseRequest();
    await createBucketCore(db, OWNER_UID, request);
    const before = (
      await db.collection("buckets").doc(request.clientRequestId as string).get()
    ).data()!;

    await createBucketCore(db, OWNER_UID, request);
    const after = (
      await db.collection("buckets").doc(request.clientRequestId as string).get()
    ).data()!;

    assert.ok((before.createdAt as Timestamp).isEqual(after.createdAt as Timestamp));
    assert.ok(
      (before.lastUpdatedAt as Timestamp).isEqual(after.lastUpdatedAt as Timestamp)
    );
  });

  it("same requestId with a changed original name is rejected (detected via creationRequest)", async () => {
    const clientRequestId = randomUUID();
    await createBucketCore(db, OWNER_UID, baseRequest({ clientRequestId }));
    await assertRejectsWithCode(
      createBucketCore(
        db,
        OWNER_UID,
        baseRequest({ clientRequestId, name: "Different Name" })
      ),
      "already-exists"
    );
  });

  it("same requestId with a changed original target is rejected", async () => {
    const clientRequestId = randomUUID();
    await createBucketCore(db, OWNER_UID, baseRequest({ clientRequestId }));
    await assertRejectsWithCode(
      createBucketCore(
        db,
        OWNER_UID,
        baseRequest({ clientRequestId, target: 99999 })
      ),
      "already-exists"
    );
  });

  it("same requestId with a changed original startingBalanceMinor is rejected", async () => {
    const clientRequestId = randomUUID();
    await createBucketCore(db, OWNER_UID, baseRequest({ clientRequestId }));
    await assertRejectsWithCode(
      createBucketCore(
        db,
        OWNER_UID,
        baseRequest({ clientRequestId, startingBalanceMinor: 1 })
      ),
      "already-exists"
    );
  });

  it("same requestId with a changed original color is rejected", async () => {
    const clientRequestId = randomUUID();
    await createBucketCore(db, OWNER_UID, baseRequest({ clientRequestId }));
    await assertRejectsWithCode(
      createBucketCore(
        db,
        OWNER_UID,
        baseRequest({ clientRequestId, color: "#000000" })
      ),
      "already-exists"
    );
  });

  it("same requestId replayed by a different authUid is rejected", async () => {
    const clientRequestId = randomUUID();
    await createBucketCore(db, OWNER_UID, baseRequest({ clientRequestId }));
    await assertRejectsWithCode(
      createBucketCore(db, OTHER_UID, baseRequest({ clientRequestId })),
      "already-exists"
    );
  });
});

describe("createBucketCore - durable idempotency after legitimate mutation", () => {
  it("retrying the ORIGINAL create request after a trusted contribution succeeds and returns the CURRENT balance", async () => {
    const clientRequestId = randomUUID();
    const request = baseRequest({
      clientRequestId,
      startingBalanceMinor: 200000,
    });
    await createBucketCore(db, OWNER_UID, request);

    await recordSavingsTransactionCore(db, OWNER_UID, {
      resourceType: "bucket",
      resourceId: clientRequestId,
      memberUid: OWNER_UID,
      type: "contribution",
      amountMinor: 10000,
      currency: "USD",
      clientRequestId: randomUUID(),
    });

    const before = (
      await db.collection("buckets").doc(clientRequestId).get()
    ).data()!;

    // Retry the exact ORIGINAL create request - must succeed as a valid
    // replay, not fail, even though the Bucket's current state has
    // legitimately moved on since creation.
    const replay = await createBucketCore(db, OWNER_UID, request);

    assert.equal(replay.bucketId, clientRequestId);
    assert.equal(replay.ledgerBalanceMinor, 210000); // CURRENT, not original 200000

    const after = (
      await db.collection("buckets").doc(clientRequestId).get()
    ).data()!;
    assert.equal(after.ledgerOpeningBalanceMinor, 200000); // unchanged
    assert.equal(after.ledgerBalanceMinor, 210000); // unchanged by the replay
    assert.equal(after.balance, 2100);
    assert.ok(
      (before.createdAt as Timestamp).isEqual(after.createdAt as Timestamp),
      "replay must not reset createdAt"
    );
    assert.ok(
      (before.lastUpdatedAt as Timestamp).isEqual(after.lastUpdatedAt as Timestamp),
      "replay must not reset lastUpdatedAt"
    );

    const txnSnap = await db
      .collection("savingsTransactions")
      .where("resourceType", "==", "bucket")
      .where("resourceId", "==", clientRequestId)
      .get();
    assert.equal(txnSnap.size, 1); // still only the one contribution
    assert.equal(txnSnap.docs[0]?.data().amountMinor, 10000);
  });

  it("retrying the ORIGINAL create request after legitimate metadata/membership mutation succeeds and does not reset the mutated fields", async () => {
    const clientRequestId = randomUUID();
    const request = baseRequest({ clientRequestId });
    await createBucketCore(db, OWNER_UID, request);

    // Admin test setup only, simulating legitimate later changes (an
    // owner metadata edit and a member addition) - not a claim about
    // what a client is allowed to do; Firestore Rules coverage already
    // separately governs that.
    const newLastUpdatedAt = Timestamp.now();
    await db.collection("buckets").doc(clientRequestId).update({
      name: "Renamed Fund",
      target: 25000,
      color: "#10B981",
      memberIds: [OWNER_UID, OTHER_UID],
      lastUpdatedAt: newLastUpdatedAt,
      lastUpdatedBy: OWNER_UID,
    });

    const replay = await createBucketCore(db, OWNER_UID, request);
    assert.equal(replay.bucketId, clientRequestId);

    const after = (
      await db.collection("buckets").doc(clientRequestId).get()
    ).data()!;
    assert.equal(after.name, "Renamed Fund");
    assert.equal(after.target, 25000);
    assert.equal(after.color, "#10B981");
    assert.deepEqual(after.memberIds, [OWNER_UID, OTHER_UID]);
    assert.ok((after.lastUpdatedAt as Timestamp).isEqual(newLastUpdatedAt));
  });
});

describe("createBucketCore - canonical-state protection against legacy/direct-created or forged documents", () => {
  it("a legacy/direct-created document at the same id (no creationRequest) is rejected as already-exists rather than treated as a replay", async () => {
    const clientRequestId = randomUUID();
    const request = baseRequest({ clientRequestId });

    // Simulates what the hardened Checkpoint 4F direct-create rules
    // still permit today: a legacy-shaped Bucket sharing this same
    // document id and superficially similar user-entered facts, but
    // with none of the canonical fields (including creationRequest,
    // which those rules do not permit a client to write at all).
    await db
      .collection("buckets")
      .doc(clientRequestId)
      .set({
        ownerId: OWNER_UID,
        memberIds: [OWNER_UID],
        name: request.name,
        target: request.target,
        color: request.color,
        balance: (request.startingBalanceMinor as number) / 100,
      });

    await assertRejectsWithCode(
      createBucketCore(db, OWNER_UID, request),
      "already-exists"
    );
  });

  it("a canonical-looking document with every field present except creationRequest is still rejected as already-exists", async () => {
    const clientRequestId = randomUUID();
    const request = baseRequest({ clientRequestId, startingBalanceMinor: 200000 });

    await db
      .collection("buckets")
      .doc(clientRequestId)
      .set({
        ownerId: OWNER_UID,
        memberIds: [OWNER_UID],
        name: request.name,
        target: request.target,
        color: request.color,
        balance: 2000,
        ledgerOpeningBalanceMinor: 200000,
        ledgerBalanceMinor: 200000,
        currency: "USD",
        bucketType: "personal",
        // creationRequest deliberately omitted.
      });

    await assertRejectsWithCode(
      createBucketCore(db, OWNER_UID, request),
      "already-exists"
    );
  });

  it("a creationRequest with a mismatched startingBalanceMinor is rejected as already-exists", async () => {
    const clientRequestId = randomUUID();
    const request = baseRequest({ clientRequestId, startingBalanceMinor: 200000 });

    await db.collection("buckets").doc(clientRequestId).set({
      ownerId: OWNER_UID,
      memberIds: [OWNER_UID],
      name: request.name,
      target: request.target,
      color: request.color,
      balance: 1,
      ledgerOpeningBalanceMinor: 100,
      ledgerBalanceMinor: 100,
      currency: "USD",
      bucketType: "personal",
      creationRequest: {
        clientRequestId,
        ownerId: OWNER_UID,
        name: request.name,
        target: request.target,
        startingBalanceMinor: 100, // mismatched vs. the incoming 200000
        color: request.color,
      },
    });

    await assertRejectsWithCode(
      createBucketCore(db, OWNER_UID, request),
      "already-exists"
    );
  });

  it("a creationRequest with a mismatched ownerId is rejected as already-exists", async () => {
    const clientRequestId = randomUUID();
    const request = baseRequest({ clientRequestId });

    await db.collection("buckets").doc(clientRequestId).set({
      ownerId: OTHER_UID,
      memberIds: [OTHER_UID],
      name: request.name,
      target: request.target,
      color: request.color,
      balance: 2000,
      ledgerOpeningBalanceMinor: 200000,
      ledgerBalanceMinor: 200000,
      currency: "USD",
      bucketType: "personal",
      creationRequest: {
        clientRequestId,
        ownerId: OTHER_UID, // mismatched vs. the incoming caller
        name: request.name,
        target: request.target,
        startingBalanceMinor: request.startingBalanceMinor,
        color: request.color,
      },
    });

    await assertRejectsWithCode(
      createBucketCore(db, OWNER_UID, request),
      "already-exists"
    );
  });

  it("a malformed non-object creationRequest is rejected as already-exists", async () => {
    const clientRequestId = randomUUID();
    const request = baseRequest({ clientRequestId });

    await db.collection("buckets").doc(clientRequestId).set({
      ownerId: OWNER_UID,
      memberIds: [OWNER_UID],
      name: request.name,
      target: request.target,
      color: request.color,
      balance: 2000,
      ledgerOpeningBalanceMinor: 200000,
      ledgerBalanceMinor: 200000,
      currency: "USD",
      bucketType: "personal",
      creationRequest: "not-an-object",
    });

    await assertRejectsWithCode(
      createBucketCore(db, OWNER_UID, request),
      "already-exists"
    );
  });

  it("a mismatched immutable ledgerOpeningBalanceMinor is rejected as already-exists", async () => {
    const clientRequestId = randomUUID();
    const request = baseRequest({ clientRequestId, startingBalanceMinor: 200000 });

    await db.collection("buckets").doc(clientRequestId).set({
      ownerId: OWNER_UID,
      memberIds: [OWNER_UID],
      name: request.name,
      target: request.target,
      color: request.color,
      balance: 999,
      ledgerOpeningBalanceMinor: 99900, // mismatched vs. startingBalanceMinor
      ledgerBalanceMinor: 99900,
      currency: "USD",
      bucketType: "personal",
      creationRequest: {
        clientRequestId,
        ownerId: OWNER_UID,
        name: request.name,
        target: request.target,
        startingBalanceMinor: 200000,
        color: request.color,
      },
    });

    await assertRejectsWithCode(
      createBucketCore(db, OWNER_UID, request),
      "already-exists"
    );
  });
});

describe("createBucketCore - canonical replay with corrupted current ledger state", () => {
  it("a valid canonical replay whose CURRENT ledgerBalanceMinor is malformed fails loudly with failed-precondition", async () => {
    const clientRequestId = randomUUID();
    const request = baseRequest({ clientRequestId, startingBalanceMinor: 200000 });
    await createBucketCore(db, OWNER_UID, request);

    // Corrupt the CURRENT ledger balance out-of-band, leaving every
    // creation-identity fact (including ledgerOpeningBalanceMinor) intact
    // - this must be distinguished from a creation-identity mismatch.
    await db.collection("buckets").doc(clientRequestId).update({
      ledgerBalanceMinor: "not-a-number",
    });

    await assertRejectsWithCode(
      createBucketCore(db, OWNER_UID, request),
      "failed-precondition"
    );
  });

  it("a valid canonical replay whose CURRENT ledgerBalanceMinor is negative fails loudly with failed-precondition", async () => {
    const clientRequestId = randomUUID();
    const request = baseRequest({ clientRequestId, startingBalanceMinor: 200000 });
    await createBucketCore(db, OWNER_UID, request);

    await db.collection("buckets").doc(clientRequestId).update({
      ledgerBalanceMinor: -500,
    });

    await assertRejectsWithCode(
      createBucketCore(db, OWNER_UID, request),
      "failed-precondition"
    );
  });

  // A valid ledgerBalanceMinor alone is not sufficient - the balance
  // compatibility cache must also agree with it. Deliberately compares
  // CURRENT balance against CURRENT ledgerBalanceMinor / 100, never
  // against the original startingBalanceMinor - the latter would
  // reintroduce the exact durable-idempotency bug the creationRequest
  // redesign fixed, since balance legitimately diverges from the
  // starting amount after any subsequent trusted contribution/
  // withdrawal (see the "durable idempotency after legitimate mutation"
  // suite, which proves a stale-relative-to-ORIGINAL balance must still
  // replay successfully).
  it("a valid canonical replay whose CURRENT balance cache is stale relative to the CURRENT ledger fails loudly with failed-precondition", async () => {
    const clientRequestId = randomUUID();
    const request = baseRequest({ clientRequestId, startingBalanceMinor: 200000 });
    await createBucketCore(db, OWNER_UID, request);

    // Simulate drift: ledgerBalanceMinor moved on (e.g. via a trusted
    // contribution) but balance was corrupted/left stale out-of-band,
    // rather than kept in sync at 2100.
    await db.collection("buckets").doc(clientRequestId).update({
      ledgerBalanceMinor: 210000,
      balance: 2000,
    });

    await assertRejectsWithCode(
      createBucketCore(db, OWNER_UID, request),
      "failed-precondition"
    );
  });

  it("a valid canonical replay whose CURRENT balance cache is malformed fails loudly with failed-precondition", async () => {
    const clientRequestId = randomUUID();
    const request = baseRequest({ clientRequestId, startingBalanceMinor: 200000 });
    await createBucketCore(db, OWNER_UID, request);

    await db.collection("buckets").doc(clientRequestId).update({
      balance: "not-a-number",
    });

    await assertRejectsWithCode(
      createBucketCore(db, OWNER_UID, request),
      "failed-precondition"
    );
  });
});

describe("createBucketCore - first savings transaction after canonical creation", () => {
  it("a canonically-created nonzero Bucket's first contribution uses the initialized ledger branch correctly", async () => {
    const clientRequestId = randomUUID();
    await createBucketCore(
      db,
      OWNER_UID,
      baseRequest({ clientRequestId, startingBalanceMinor: 200000 })
    );

    const result = await recordSavingsTransactionCore(db, OWNER_UID, {
      resourceType: "bucket",
      resourceId: clientRequestId,
      memberUid: OWNER_UID,
      type: "contribution",
      amountMinor: 10000,
      currency: "USD",
      clientRequestId: randomUUID(),
    });
    assert.equal(result.balanceMinor, 210000);

    const snap = await db.collection("buckets").doc(clientRequestId).get();
    const data = snap.data()!;
    assert.equal(data.ledgerOpeningBalanceMinor, 200000); // unchanged
    assert.equal(data.ledgerBalanceMinor, 210000);
    assert.equal(data.balance, 2100);

    const txnSnap = await db
      .collection("savingsTransactions")
      .where("resourceType", "==", "bucket")
      .where("resourceId", "==", clientRequestId)
      .get();
    // The opening balance was never recorded as a transaction - only the
    // new contribution is.
    assert.equal(txnSnap.size, 1);
    assert.equal(txnSnap.docs[0]?.data().amountMinor, 10000);
  });
});

describe("createBucketCore - legacy coexistence", () => {
  it("a legacy-shaped Bucket (not created via createBucketCore) still legacy-initializes correctly on its first trusted transaction", async () => {
    // Not created through createBucketCore at all - simulates a bucket
    // created via the still-open 4F direct client path, with no ledger
    // fields, exactly like recordSavingsTransactionCore.ts's own
    // "legacy initialization" suite already covers exhaustively.
    const bucketId = randomUUID();
    await db.collection("buckets").doc(bucketId).set({
      ownerId: OWNER_UID,
      memberIds: [OWNER_UID],
      name: "Legacy Bucket",
      target: 1000,
      balance: 12.34, // -> 1234 minor
    });

    await recordSavingsTransactionCore(db, OWNER_UID, {
      resourceType: "bucket",
      resourceId: bucketId,
      memberUid: OWNER_UID,
      type: "contribution",
      amountMinor: 100,
      currency: "USD",
      clientRequestId: randomUUID(),
    });

    const snap = await db.collection("buckets").doc(bucketId).get();
    const data = snap.data()!;
    assert.equal(data.ledgerOpeningBalanceMinor, 1234);
    assert.equal(data.ledgerBalanceMinor, 1334);
  });
});

// ==========================================================================
// Checkpoint 3F.3B.4: trip_personal ("My Stash") fund creation
// ==========================================================================
describe("createBucketCore - trip_personal: normal personal creation is unaffected", () => {
  it("an ordinary personal Bucket create (bucketType omitted) still succeeds exactly as before", async () => {
    const clientRequestId = randomUUID();
    const result = await createBucketCore(
      db,
      OWNER_UID,
      baseRequest({ clientRequestId })
    );
    assert.equal(result.bucketId, clientRequestId);

    const snap = await db.collection("buckets").doc(clientRequestId).get();
    const data = snap.data()!;
    assert.equal(data.bucketType, "personal");
    assert.equal("linkedTripId" in data, false);
  });

  it("linkedTripId supplied for bucketType: personal is rejected", async () => {
    await assertRejectsWithCode(
      createBucketCore(
        db,
        OWNER_UID,
        baseRequest({ bucketType: "personal", linkedTripId: TRIP_ID })
      ),
      "invalid-argument"
    );
  });

  it("linkedTripId supplied with bucketType omitted (defaults to personal) is rejected", async () => {
    await assertRejectsWithCode(
      createBucketCore(db, OWNER_UID, baseRequest({ linkedTripId: TRIP_ID })),
      "invalid-argument"
    );
  });

  it("an invalid bucketType value is rejected", async () => {
    await assertRejectsWithCode(
      createBucketCore(db, OWNER_UID, baseRequest({ bucketType: "shared" })),
      "invalid-argument"
    );
  });
});

describe("createBucketCore - trip_personal: input validation", () => {
  it("missing linkedTripId is rejected", async () => {
    await seedTrip(TRIP_ID);
    await assertRejectsWithCode(
      createBucketCore(
        db,
        OWNER_UID,
        tripPersonalRequest({ linkedTripId: undefined })
      ),
      "invalid-argument"
    );
  });

  it("empty-string linkedTripId is rejected", async () => {
    await assertRejectsWithCode(
      createBucketCore(db, OWNER_UID, tripPersonalRequest({ linkedTripId: "" })),
      "invalid-argument"
    );
  });

  it("non-string linkedTripId is rejected", async () => {
    await assertRejectsWithCode(
      createBucketCore(db, OWNER_UID, tripPersonalRequest({ linkedTripId: 123 })),
      "invalid-argument"
    );
  });
});

describe("createBucketCore - trip_personal: trip existence and membership", () => {
  it("a nonexistent linked Trip is rejected with not-found", async () => {
    await assertRejectsWithCode(
      createBucketCore(
        db,
        OWNER_UID,
        tripPersonalRequest({ linkedTripId: "does-not-exist" })
      ),
      "not-found"
    );
  });

  it("a non-member of the Trip is rejected with permission-denied", async () => {
    await seedTrip(TRIP_ID); // memberIds: [OWNER_UID, OTHER_UID]
    const OUTSIDER_UID = "outsider-uid";
    await assertRejectsWithCode(
      createBucketCore(db, OUTSIDER_UID, tripPersonalRequest()),
      "permission-denied"
    );
  });

  it("the Trip owner (also in memberIds, per real Trip creation) succeeds", async () => {
    await seedTrip(TRIP_ID);
    const result = await createBucketCore(db, OWNER_UID, tripPersonalRequest());
    assert.ok(result.bucketId.length > 0);
  });

  it("a non-owner Trip member succeeds", async () => {
    await seedTrip(TRIP_ID);
    const result = await createBucketCore(
      db,
      OTHER_UID,
      tripPersonalRequest({ clientRequestId: randomUUID() })
    );
    assert.ok(result.bucketId.length > 0);
  });

  it("membership derived solely from the Trip's OWN current memberIds/ownerId - never trusted from client input", async () => {
    await seedTrip(TRIP_ID);
    const OUTSIDER_UID = "outsider-uid";
    // A client cannot forge membership by claiming it in the request -
    // there is no such input field at all, but this proves the rejection
    // holds even when the request otherwise looks identical to a valid
    // member's request.
    await assertRejectsWithCode(
      createBucketCore(
        db,
        OUTSIDER_UID,
        tripPersonalRequest({ memberIds: [OUTSIDER_UID] })
      ),
      "permission-denied"
    );
  });
});

describe("createBucketCore - trip_personal: resulting document shape", () => {
  it("ownerId is the authenticated caller, never any client-supplied value", async () => {
    await seedTrip(TRIP_ID);
    await createBucketCore(
      db,
      OWNER_UID,
      tripPersonalRequest({ ownerId: OTHER_UID })
    );
    const bucketId = `tripfund_${TRIP_ID}_${OWNER_UID}`;
    const snap = await db.collection("buckets").doc(bucketId).get();
    assert.equal(snap.data()!.ownerId, OWNER_UID);
  });

  it("memberIds is exactly [authUid] - self-only, never the Trip's memberIds", async () => {
    await seedTrip(TRIP_ID); // Trip has TWO members
    await createBucketCore(db, OWNER_UID, tripPersonalRequest());
    const bucketId = `tripfund_${TRIP_ID}_${OWNER_UID}`;
    const snap = await db.collection("buckets").doc(bucketId).get();
    assert.deepEqual(snap.data()!.memberIds, [OWNER_UID]);
  });

  it("linkedTripId and bucketType are stored correctly", async () => {
    await seedTrip(TRIP_ID);
    await createBucketCore(db, OWNER_UID, tripPersonalRequest());
    const bucketId = `tripfund_${TRIP_ID}_${OWNER_UID}`;
    const snap = await db.collection("buckets").doc(bucketId).get();
    const data = snap.data()!;
    assert.equal(data.bucketType, "trip_personal");
    assert.equal(data.linkedTripId, TRIP_ID);
  });

  it("uses the same trusted ledger opening/balance fields as an ordinary personal Bucket", async () => {
    await seedTrip(TRIP_ID);
    const result = await createBucketCore(
      db,
      OWNER_UID,
      tripPersonalRequest({ startingBalanceMinor: 50000 })
    );
    assert.equal(result.ledgerBalanceMinor, 50000);

    const bucketId = `tripfund_${TRIP_ID}_${OWNER_UID}`;
    const snap = await db.collection("buckets").doc(bucketId).get();
    const data = snap.data()!;
    assert.equal(data.ledgerOpeningBalanceMinor, 50000);
    assert.equal(data.ledgerBalanceMinor, 50000);
    assert.equal(data.balance, 500);
    assert.equal(data.currency, "USD");
  });

  it("the deterministic bucket id is tripfund_{tripId}_{uid}, not the clientRequestId", async () => {
    await seedTrip(TRIP_ID);
    const clientRequestId = randomUUID();
    const result = await createBucketCore(
      db,
      OWNER_UID,
      tripPersonalRequest({ clientRequestId })
    );
    assert.equal(result.bucketId, `tripfund_${TRIP_ID}_${OWNER_UID}`);
    assert.notEqual(result.bucketId, clientRequestId);
  });
});

describe("createBucketCore - trip_personal: at-most-one-per-(owner,trip) uniqueness", () => {
  it("a second create for the same (owner, trip) with a DIFFERENT clientRequestId but identical facts replays idempotently to the SAME bucket", async () => {
    await seedTrip(TRIP_ID);
    const first = await createBucketCore(db, OWNER_UID, tripPersonalRequest());
    const second = await createBucketCore(
      db,
      OWNER_UID,
      tripPersonalRequest({ clientRequestId: randomUUID() })
    );

    assert.equal(first.bucketId, second.bucketId);
    const snap = await db
      .collection("buckets")
      .where("bucketType", "==", "trip_personal")
      .where("linkedTripId", "==", TRIP_ID)
      .where("ownerId", "==", OWNER_UID)
      .get();
    assert.equal(snap.size, 1);
  });

  it("replaying the EXACT same creation request (same clientRequestId, same facts) is a true idempotent replay", async () => {
    await seedTrip(TRIP_ID);
    const request = tripPersonalRequest();
    const first = await createBucketCore(db, OWNER_UID, request);
    const second = await createBucketCore(db, OWNER_UID, request);
    assert.equal(first.bucketId, second.bucketId);
    assert.equal(first.ledgerBalanceMinor, second.ledgerBalanceMinor);
  });

  it("a second create for the same (owner, trip) with DIFFERENT facts (different target) is rejected as already-exists, never overwritten or duplicated", async () => {
    await seedTrip(TRIP_ID);
    await createBucketCore(db, OWNER_UID, tripPersonalRequest({ target: 1000 }));
    await assertRejectsWithCode(
      createBucketCore(
        db,
        OWNER_UID,
        tripPersonalRequest({ clientRequestId: randomUUID(), target: 2000 })
      ),
      "already-exists"
    );

    // Still exactly one document, with the ORIGINAL target - the failed
    // second attempt must not have mutated anything.
    const bucketId = `tripfund_${TRIP_ID}_${OWNER_UID}`;
    const snap = await db.collection("buckets").doc(bucketId).get();
    assert.equal(snap.data()!.target, 1000);
  });

  it("two DIFFERENT members can each create their own fund for the SAME trip without colliding", async () => {
    await seedTrip(TRIP_ID);
    const ownerResult = await createBucketCore(db, OWNER_UID, tripPersonalRequest());
    const memberResult = await createBucketCore(
      db,
      OTHER_UID,
      tripPersonalRequest({ clientRequestId: randomUUID() })
    );
    assert.notEqual(ownerResult.bucketId, memberResult.bucketId);

    const snap = await db
      .collection("buckets")
      .where("bucketType", "==", "trip_personal")
      .where("linkedTripId", "==", TRIP_ID)
      .get();
    assert.equal(snap.size, 2);
  });

  it("reusing the same clientRequestId for a DIFFERENT linked Trip creates a separate, valid fund for that trip", async () => {
    // Document identity for trip_personal is (linkedTripId, ownerUid) -
    // deliberately NOT clientRequestId (see tripPersonalBucketId's own
    // comment in src/callables/createBucket.ts) - so reusing the same
    // clientRequestId value across two genuinely different trips is safe
    // and correctly produces two independent funds, not a collision or a
    // rejection. clientRequestId is only ever compared WITHIN a single
    // deterministic document's own creationRequest identity check.
    await seedTrip(TRIP_ID);
    await seedTrip(OTHER_TRIP_ID);
    const sharedClientRequestId = randomUUID();

    const first = await createBucketCore(
      db,
      OWNER_UID,
      tripPersonalRequest({ clientRequestId: sharedClientRequestId, linkedTripId: TRIP_ID })
    );
    const second = await createBucketCore(
      db,
      OWNER_UID,
      tripPersonalRequest({ clientRequestId: sharedClientRequestId, linkedTripId: OTHER_TRIP_ID })
    );

    assert.notEqual(first.bucketId, second.bucketId);
    assert.equal(first.bucketId, `tripfund_${TRIP_ID}_${OWNER_UID}`);
    assert.equal(second.bucketId, `tripfund_${OTHER_TRIP_ID}_${OWNER_UID}`);
  });

  it("a stored document with a mismatched linkedTripId at the same id is rejected as already-exists (defensive identity check)", async () => {
    // Simulates a hand-crafted/corrupted document at the deterministic id
    // whose stored linkedTripId disagrees with the incoming request -
    // matchesCreationRequest's explicit linkedTripId comparison must
    // catch this rather than trusting the id alone.
    await seedTrip(TRIP_ID);
    const bucketId = `tripfund_${TRIP_ID}_${OWNER_UID}`;
    await db.collection("buckets").doc(bucketId).set({
      ownerId: OWNER_UID,
      memberIds: [OWNER_UID],
      name: "Canada Trip — My Stash",
      target: 1000,
      color: null,
      balance: 0,
      ledgerOpeningBalanceMinor: 0,
      ledgerBalanceMinor: 0,
      currency: "USD",
      bucketType: "trip_personal",
      linkedTripId: OTHER_TRIP_ID, // mismatched vs. the incoming TRIP_ID
      creationRequest: {
        clientRequestId: randomUUID(),
        ownerId: OWNER_UID,
        name: "Canada Trip — My Stash",
        target: 1000,
        startingBalanceMinor: 0,
        color: null,
        bucketType: "trip_personal",
        linkedTripId: OTHER_TRIP_ID,
      },
    });

    await assertRejectsWithCode(
      createBucketCore(db, OWNER_UID, tripPersonalRequest()),
      "already-exists"
    );
  });
});
