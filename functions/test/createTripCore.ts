// Tests for createTripCore against the local Firestore emulator via the
// Admin SDK - never production, guarded below. Run via
// `npm --prefix functions test`, wrapped in
// `firebase emulators:exec --only firestore "..."` so
// FIRESTORE_EMULATOR_HOST is set automatically (the same mechanism
// createBucketCore.ts's own test file already relies on).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import type { App } from "firebase-admin/app";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import type { CallableRequest } from "firebase-functions/v2/https";
import {
  createTripCore,
  requireAuthenticatedUid,
} from "../src/callables/createTrip";
import { recordSavingsTransactionCore } from "../src/callables/recordSavingsTransaction";
import { CURRENT_TRIP_OWNERSHIP_MODEL_VERSION } from "../src/domain/tripOwnershipModel";

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
  // A distinct "demo-" project id from every other test file's own app
  // (see createBucketCore.ts's comment for why this isolation matters -
  // node:test runs files concurrently, and a shared project id would let
  // this file's blanket clearFirestore() race with other files' seeded
  // data).
  app = initializeApp({
    projectId: "demo-squadstash-functions-test-create-trip",
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
    "tripMemberOwnership",
    "tripOwnershipMigrationState",
  ]) {
    const snap = await db.collection(name).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

beforeEach(async () => {
  await clearFirestore();
});

function baseRequest(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    clientRequestId: randomUUID(),
    title: "Canada Trip",
    location: "Banff, Canada",
    target: 5000,
    imageUrl: "https://example.com/canada.jpg",
    tripStartDate: "2027-06-12",
    tripEndDate: null,
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

describe("createTripCore - successful creation", () => {
  it("returns exactly {tripId} and tripId equals the submitted clientRequestId", async () => {
    const clientRequestId = randomUUID();
    const result = await createTripCore(
      db,
      OWNER_UID,
      baseRequest({ clientRequestId })
    );
    assert.deepEqual(Object.keys(result), ["tripId"]);
    assert.equal(result.tripId, clientRequestId);
  });

  it("exact canonical persisted financial state", async () => {
    const clientRequestId = randomUUID();
    await createTripCore(db, OWNER_UID, baseRequest({ clientRequestId }));
    const data = (
      await db.collection("trips").doc(clientRequestId).get()
    ).data()!;
    assert.equal(data.saved, 0);
    assert.equal(data.ledgerOpeningBalanceMinor, 0);
    assert.equal(data.ledgerBalanceMinor, 0);
    assert.equal(data.currency, "USD");
  });

  it("exact canonical persisted ownership-model state", async () => {
    const clientRequestId = randomUUID();
    await createTripCore(db, OWNER_UID, baseRequest({ clientRequestId }));
    const data = (
      await db.collection("trips").doc(clientRequestId).get()
    ).data()!;
    assert.equal(data.ownershipModelState, "initialized");
    assert.equal(
      data.ownershipModelVersion,
      CURRENT_TRIP_OWNERSHIP_MODEL_VERSION
    );
  });

  it("ownerId is derived exclusively from authUid", async () => {
    const clientRequestId = randomUUID();
    await createTripCore(db, OWNER_UID, baseRequest({ clientRequestId }));
    const data = (
      await db.collection("trips").doc(clientRequestId).get()
    ).data()!;
    assert.equal(data.ownerId, OWNER_UID);
  });

  it("memberIds is exactly [authUid]", async () => {
    const clientRequestId = randomUUID();
    await createTripCore(db, OWNER_UID, baseRequest({ clientRequestId }));
    const data = (
      await db.collection("trips").doc(clientRequestId).get()
    ).data()!;
    assert.deepEqual(data.memberIds, [OWNER_UID]);
  });

  it("does not create a tripMemberOwnership row", async () => {
    await createTripCore(db, OWNER_UID, baseRequest());
    const snap = await db.collection("tripMemberOwnership").get();
    assert.equal(snap.size, 0);
  });

  it("does not create a tripOwnershipMigrationState document", async () => {
    const clientRequestId = randomUUID();
    await createTripCore(db, OWNER_UID, baseRequest({ clientRequestId }));
    const snap = await db
      .collection("tripOwnershipMigrationState")
      .doc(clientRequestId)
      .get();
    assert.equal(snap.exists, false);
  });

  it("title/location/target/imageUrl/dates persist exactly as validated", async () => {
    const clientRequestId = randomUUID();
    await createTripCore(
      db,
      OWNER_UID,
      baseRequest({
        clientRequestId,
        title: "  Hawaii Trip  ",
        location: "  Maui, Hawaii  ",
        target: 8000,
        imageUrl: "https://example.com/hawaii.jpg",
        tripStartDate: "2028-01-10",
        tripEndDate: "2028-01-20",
      })
    );
    const data = (
      await db.collection("trips").doc(clientRequestId).get()
    ).data()!;
    assert.equal(data.title, "Hawaii Trip");
    assert.equal(data.location, "Maui, Hawaii");
    assert.equal(data.target, 8000);
    assert.equal(data.imageUrl, "https://example.com/hawaii.jpg");
    assert.equal(data.tripStartDate, "2028-01-10");
    assert.equal(data.tripEndDate, "2028-01-20");
  });

  it("a null location/tripEndDate is accepted and persisted as null", async () => {
    const clientRequestId = randomUUID();
    await createTripCore(
      db,
      OWNER_UID,
      baseRequest({ clientRequestId, location: null, tripEndDate: null })
    );
    const data = (
      await db.collection("trips").doc(clientRequestId).get()
    ).data()!;
    assert.equal(data.location, null);
    assert.equal(data.tripEndDate, null);
  });

  it("an empty-after-trim location is canonicalized to null", async () => {
    const clientRequestId = randomUUID();
    await createTripCore(
      db,
      OWNER_UID,
      baseRequest({ clientRequestId, location: "   " })
    );
    const data = (
      await db.collection("trips").doc(clientRequestId).get()
    ).data()!;
    assert.equal(data.location, null);
  });
});

describe("createTripCore - timestamps", () => {
  it("createdAt/lastUpdatedAt are persisted Timestamps and lastUpdatedBy is the authUid", async () => {
    const clientRequestId = randomUUID();
    await createTripCore(db, OWNER_UID, baseRequest({ clientRequestId }));
    const data = (
      await db.collection("trips").doc(clientRequestId).get()
    ).data()!;
    assert.ok(data.createdAt instanceof Timestamp);
    assert.ok(data.lastUpdatedAt instanceof Timestamp);
    assert.equal(data.lastUpdatedBy, OWNER_UID);
  });
});

describe("createTripCore - creationRequest metadata", () => {
  it("a fresh canonical Trip stores the exact trusted creationRequest metadata", async () => {
    const clientRequestId = randomUUID();
    const request = baseRequest({
      clientRequestId,
      title: "  Canada Trip  ",
    });
    await createTripCore(db, OWNER_UID, request);
    const data = (
      await db.collection("trips").doc(clientRequestId).get()
    ).data()!;
    assert.deepEqual(data.creationRequest, {
      clientRequestId,
      ownerId: OWNER_UID,
      title: "Canada Trip", // trimmed
      location: "Banff, Canada",
      target: 5000,
      imageUrl: "https://example.com/canada.jpg",
      tripStartDate: "2027-06-12",
      tripEndDate: null,
    });
  });
});

describe("createTripCore - exact allowlist: unexpected/trusted fields reject the whole request", () => {
  const disallowedFields: Record<string, unknown> = {
    ownerId: OTHER_UID,
    memberIds: [OTHER_UID],
    saved: 100,
    ledgerOpeningBalanceMinor: 500,
    ledgerBalanceMinor: 500,
    currency: "EUR",
    ownershipModelState: "initialized",
    ownershipModelVersion: 1,
    creationRequest: { clientRequestId: "forged" },
    createdAt: new Date(),
    lastUpdatedAt: new Date(),
    lastUpdatedBy: OTHER_UID,
    archivedAt: new Date(),
    archivedBy: OTHER_UID,
    somethingEntirelyUnrecognized: true,
  };

  for (const [field, value] of Object.entries(disallowedFields)) {
    it(`a request containing "${field}" is rejected with invalid-argument, and no document is created`, async () => {
      const clientRequestId = randomUUID();
      await assertRejectsWithCode(
        createTripCore(
          db,
          OWNER_UID,
          baseRequest({ clientRequestId, [field]: value })
        ),
        "invalid-argument"
      );
      const snap = await db.collection("trips").doc(clientRequestId).get();
      assert.equal(snap.exists, false);
    });
  }
});

describe("createTripCore - clientRequestId validation", () => {
  it("missing clientRequestId is rejected", async () => {
    await assertRejectsWithCode(
      createTripCore(
        db,
        OWNER_UID,
        baseRequest({ clientRequestId: undefined })
      ),
      "invalid-argument"
    );
  });

  it("clientRequestId with disallowed characters is rejected", async () => {
    await assertRejectsWithCode(
      createTripCore(
        db,
        OWNER_UID,
        baseRequest({ clientRequestId: "not/a valid id" })
      ),
      "invalid-argument"
    );
  });

  it("a valid safe clientRequestId is accepted", async () => {
    await assert.doesNotReject(
      createTripCore(
        db,
        OWNER_UID,
        baseRequest({ clientRequestId: "valid_Request-123" })
      )
    );
  });
});

describe("createTripCore - title validation", () => {
  it("missing title is rejected", async () => {
    await assertRejectsWithCode(
      createTripCore(db, OWNER_UID, baseRequest({ title: undefined })),
      "invalid-argument"
    );
  });

  it("non-string title is rejected", async () => {
    await assertRejectsWithCode(
      createTripCore(db, OWNER_UID, baseRequest({ title: 123 })),
      "invalid-argument"
    );
  });

  it("empty/whitespace-only title is rejected", async () => {
    await assertRejectsWithCode(
      createTripCore(db, OWNER_UID, baseRequest({ title: "   " })),
      "invalid-argument"
    );
  });

  it("an oversized title is rejected", async () => {
    await assertRejectsWithCode(
      createTripCore(db, OWNER_UID, baseRequest({ title: "x".repeat(201) })),
      "invalid-argument"
    );
  });

  it("a title at the max length is accepted", async () => {
    await assert.doesNotReject(
      createTripCore(db, OWNER_UID, baseRequest({ title: "x".repeat(200) }))
    );
  });
});

describe("createTripCore - location validation", () => {
  it("non-string/non-null location is rejected", async () => {
    await assertRejectsWithCode(
      createTripCore(db, OWNER_UID, baseRequest({ location: 123 })),
      "invalid-argument"
    );
  });

  it("missing location is rejected", async () => {
    await assertRejectsWithCode(
      createTripCore(db, OWNER_UID, baseRequest({ location: undefined })),
      "invalid-argument"
    );
  });

  it("an oversized location is rejected", async () => {
    await assertRejectsWithCode(
      createTripCore(
        db,
        OWNER_UID,
        baseRequest({ location: "x".repeat(201) })
      ),
      "invalid-argument"
    );
  });
});

describe("createTripCore - target validation", () => {
  it("missing target is rejected", async () => {
    await assertRejectsWithCode(
      createTripCore(db, OWNER_UID, baseRequest({ target: undefined })),
      "invalid-argument"
    );
  });

  it("non-number target is rejected", async () => {
    await assertRejectsWithCode(
      createTripCore(db, OWNER_UID, baseRequest({ target: "5000" })),
      "invalid-argument"
    );
  });

  it("NaN target is rejected", async () => {
    await assertRejectsWithCode(
      createTripCore(db, OWNER_UID, baseRequest({ target: NaN })),
      "invalid-argument"
    );
  });

  it("infinite target is rejected", async () => {
    await assertRejectsWithCode(
      createTripCore(db, OWNER_UID, baseRequest({ target: Infinity })),
      "invalid-argument"
    );
  });

  it("zero target is rejected", async () => {
    await assertRejectsWithCode(
      createTripCore(db, OWNER_UID, baseRequest({ target: 0 })),
      "invalid-argument"
    );
  });

  it("negative target is rejected", async () => {
    await assertRejectsWithCode(
      createTripCore(db, OWNER_UID, baseRequest({ target: -100 })),
      "invalid-argument"
    );
  });
});

describe("createTripCore - imageUrl validation", () => {
  it("missing imageUrl is rejected", async () => {
    await assertRejectsWithCode(
      createTripCore(db, OWNER_UID, baseRequest({ imageUrl: undefined })),
      "invalid-argument"
    );
  });

  it("non-string imageUrl is rejected", async () => {
    await assertRejectsWithCode(
      createTripCore(db, OWNER_UID, baseRequest({ imageUrl: 123 })),
      "invalid-argument"
    );
  });

  it("an imageUrl missing http(s):// is rejected", async () => {
    await assertRejectsWithCode(
      createTripCore(
        db,
        OWNER_UID,
        baseRequest({ imageUrl: "ftp://example.com/x.jpg" })
      ),
      "invalid-argument"
    );
  });

  it("an oversized imageUrl is rejected", async () => {
    await assertRejectsWithCode(
      createTripCore(
        db,
        OWNER_UID,
        baseRequest({
          imageUrl: "https://example.com/" + "x".repeat(2048),
        })
      ),
      "invalid-argument"
    );
  });

  it("a valid https:// imageUrl is accepted", async () => {
    await assert.doesNotReject(
      createTripCore(
        db,
        OWNER_UID,
        baseRequest({ imageUrl: "https://example.com/x.jpg" })
      )
    );
  });

  it("a valid http:// imageUrl is accepted", async () => {
    await assert.doesNotReject(
      createTripCore(
        db,
        OWNER_UID,
        baseRequest({ imageUrl: "http://example.com/x.jpg" })
      )
    );
  });
});

describe("createTripCore - date validation", () => {
  it("a malformed tripStartDate format is rejected", async () => {
    await assertRejectsWithCode(
      createTripCore(
        db,
        OWNER_UID,
        baseRequest({ tripStartDate: "06/12/2027" })
      ),
      "invalid-argument"
    );
  });

  it("an impossible real-calendar tripStartDate is rejected (2027-02-30)", async () => {
    await assertRejectsWithCode(
      createTripCore(
        db,
        OWNER_UID,
        baseRequest({ tripStartDate: "2027-02-30" })
      ),
      "invalid-argument"
    );
  });

  it("an impossible real-calendar tripEndDate is rejected (2027-13-01)", async () => {
    await assertRejectsWithCode(
      createTripCore(
        db,
        OWNER_UID,
        baseRequest({ tripStartDate: "2027-06-01", tripEndDate: "2027-13-01" })
      ),
      "invalid-argument"
    );
  });

  it("a tripEndDate before tripStartDate is rejected", async () => {
    await assertRejectsWithCode(
      createTripCore(
        db,
        OWNER_UID,
        baseRequest({ tripStartDate: "2027-06-12", tripEndDate: "2027-06-01" })
      ),
      "invalid-argument"
    );
  });

  it("a tripEndDate equal to tripStartDate is accepted", async () => {
    await assert.doesNotReject(
      createTripCore(
        db,
        OWNER_UID,
        baseRequest({ tripStartDate: "2027-06-12", tripEndDate: "2027-06-12" })
      )
    );
  });

  it("a non-string, non-null tripEndDate is rejected", async () => {
    await assertRejectsWithCode(
      createTripCore(db, OWNER_UID, baseRequest({ tripEndDate: 123 })),
      "invalid-argument"
    );
  });

  // Checkpoint 5B.5A/amended 5B.5 preflight, item 4: the server must
  // NEVER reject a tripStartDate solely for being chronologically before
  // today - that remains a client-side-only UI guardrail (create.tsx),
  // matching firestore.rules' own long-standing documented decision for
  // the still-open direct-create path.
  it("a tripStartDate far in the past is NOT rejected merely for being in the past", async () => {
    await assert.doesNotReject(
      createTripCore(
        db,
        OWNER_UID,
        baseRequest({ tripStartDate: "2000-01-01", tripEndDate: null })
      )
    );
  });
});

describe("createTripCore - idempotency (no mutation on replay)", () => {
  it("same clientRequestId + same facts returns the same tripId, and exactly one Trip exists", async () => {
    const request = baseRequest();
    const first = await createTripCore(db, OWNER_UID, request);
    const second = await createTripCore(db, OWNER_UID, request);
    assert.equal(first.tripId, second.tripId);

    const snap = await db.collection("trips").get();
    assert.equal(snap.size, 1);
  });

  it("an immediate replay does not alter the stored timestamps", async () => {
    const request = baseRequest();
    await createTripCore(db, OWNER_UID, request);
    const before = (
      await db.collection("trips").doc(request.clientRequestId as string).get()
    ).data()!;

    await createTripCore(db, OWNER_UID, request);
    const after = (
      await db.collection("trips").doc(request.clientRequestId as string).get()
    ).data()!;

    assert.ok(
      (before.createdAt as Timestamp).isEqual(after.createdAt as Timestamp)
    );
    assert.ok(
      (before.lastUpdatedAt as Timestamp).isEqual(
        after.lastUpdatedAt as Timestamp
      )
    );
  });

  it("same clientRequestId with a changed original title is rejected", async () => {
    const clientRequestId = randomUUID();
    await createTripCore(db, OWNER_UID, baseRequest({ clientRequestId }));
    await assertRejectsWithCode(
      createTripCore(
        db,
        OWNER_UID,
        baseRequest({ clientRequestId, title: "Different Trip" })
      ),
      "already-exists"
    );
  });

  it("same clientRequestId with a changed original target is rejected", async () => {
    const clientRequestId = randomUUID();
    await createTripCore(db, OWNER_UID, baseRequest({ clientRequestId }));
    await assertRejectsWithCode(
      createTripCore(
        db,
        OWNER_UID,
        baseRequest({ clientRequestId, target: 99999 })
      ),
      "already-exists"
    );
  });

  it("same clientRequestId with a changed original tripStartDate is rejected", async () => {
    const clientRequestId = randomUUID();
    await createTripCore(db, OWNER_UID, baseRequest({ clientRequestId }));
    await assertRejectsWithCode(
      createTripCore(
        db,
        OWNER_UID,
        baseRequest({ clientRequestId, tripStartDate: "2030-01-01" })
      ),
      "already-exists"
    );
  });

  it("same clientRequestId replayed by a different authUid is rejected", async () => {
    const clientRequestId = randomUUID();
    await createTripCore(db, OWNER_UID, baseRequest({ clientRequestId }));
    await assertRejectsWithCode(
      createTripCore(db, OTHER_UID, baseRequest({ clientRequestId })),
      "already-exists"
    );
  });

  it("two concurrent identical requests produce exactly one document and the same tripId", async () => {
    const request = baseRequest();
    const [first, second] = await Promise.all([
      createTripCore(db, OWNER_UID, request),
      createTripCore(db, OWNER_UID, request),
    ]);
    assert.equal(first.tripId, second.tripId);

    const snap = await db.collection("trips").get();
    assert.equal(snap.size, 1);
  });
});

describe("createTripCore - durable idempotency after legitimate mutation", () => {
  it("retrying the ORIGINAL create request after a legitimate display edit succeeds and does not reset the mutated fields", async () => {
    const clientRequestId = randomUUID();
    const request = baseRequest({ clientRequestId });
    await createTripCore(db, OWNER_UID, request);

    const newLastUpdatedAt = Timestamp.now();
    await db.collection("trips").doc(clientRequestId).update({
      title: "Renamed Trip",
      target: 9000,
      memberIds: [OWNER_UID, OTHER_UID],
      lastUpdatedAt: newLastUpdatedAt,
      lastUpdatedBy: OWNER_UID,
    });

    const replay = await createTripCore(db, OWNER_UID, request);
    assert.equal(replay.tripId, clientRequestId);

    const after = (
      await db.collection("trips").doc(clientRequestId).get()
    ).data()!;
    assert.equal(after.title, "Renamed Trip");
    assert.equal(after.target, 9000);
    assert.deepEqual(after.memberIds, [OWNER_UID, OTHER_UID]);
    assert.ok((after.lastUpdatedAt as Timestamp).isEqual(newLastUpdatedAt));
  });

  it("retrying the ORIGINAL create request after legitimate financial activity succeeds", async () => {
    const clientRequestId = randomUUID();
    const request = baseRequest({ clientRequestId });
    await createTripCore(db, OWNER_UID, request);

    await recordSavingsTransactionCore(db, OWNER_UID, {
      resourceType: "trip",
      resourceId: clientRequestId,
      memberUid: OWNER_UID,
      type: "contribution",
      amountMinor: 10000,
      currency: "USD",
      clientRequestId: randomUUID(),
    });

    const replay = await createTripCore(db, OWNER_UID, request);
    assert.equal(replay.tripId, clientRequestId);
    assert.deepEqual(Object.keys(replay), ["tripId"]);

    const after = (
      await db.collection("trips").doc(clientRequestId).get()
    ).data()!;
    assert.equal(after.ledgerOpeningBalanceMinor, 0); // frozen, unchanged
    assert.equal(after.ledgerBalanceMinor, 10000); // moved on, unaffected by replay
  });

  it("retrying the ORIGINAL create request after the Trip has been archived succeeds", async () => {
    const clientRequestId = randomUUID();
    const request = baseRequest({ clientRequestId });
    await createTripCore(db, OWNER_UID, request);

    await db.collection("trips").doc(clientRequestId).update({
      archivedAt: Timestamp.now(),
      archivedBy: OWNER_UID,
    });

    const replay = await createTripCore(db, OWNER_UID, request);
    assert.equal(replay.tripId, clientRequestId);

    const after = (
      await db.collection("trips").doc(clientRequestId).get()
    ).data()!;
    assert.ok(after.archivedAt, "archivedAt must remain set after replay");
  });

  it("retrying the ORIGINAL create request after the Trip legitimately entered needs_reconciliation succeeds", async () => {
    const clientRequestId = randomUUID();
    const request = baseRequest({ clientRequestId });
    await createTripCore(db, OWNER_UID, request);

    // Simulates a genuinely native Trip later entering reconciliation -
    // the mutable lifecycle state is deliberately NOT an idempotency
    // identity condition (see matchesCreationRequest's own comment).
    await db.collection("trips").doc(clientRequestId).update({
      ownershipModelState: "needs_reconciliation",
    });

    const replay = await createTripCore(db, OWNER_UID, request);
    assert.equal(replay.tripId, clientRequestId);

    const after = (
      await db.collection("trips").doc(clientRequestId).get()
    ).data()!;
    assert.equal(after.ownershipModelState, "needs_reconciliation");
    assert.equal(
      after.ownershipModelVersion,
      CURRENT_TRIP_OWNERSHIP_MODEL_VERSION
    );
  });
});

describe("createTripCore - replay hardening against malformed/forged stored state", () => {
  it("a legacy/direct-created document at the same id (no creationRequest) is rejected as already-exists", async () => {
    const clientRequestId = randomUUID();
    const request = baseRequest({ clientRequestId });

    // Simulates what the still-open direct-create Rules path produces
    // today - a legacy-shaped Trip sharing this document id, with none
    // of the canonical trusted fields (including creationRequest, which
    // those Rules do not permit a client to write at all).
    await db.collection("trips").doc(clientRequestId).set({
      ownerId: OWNER_UID,
      memberIds: [OWNER_UID],
      title: request.title,
      location: request.location,
      target: request.target,
      saved: 0,
      imageUrl: request.imageUrl,
      tripStartDate: request.tripStartDate,
      tripEndDate: request.tripEndDate,
    });

    await assertRejectsWithCode(
      createTripCore(db, OWNER_UID, request),
      "already-exists"
    );
  });

  it("a canonical-looking document with every field present except creationRequest is rejected as already-exists", async () => {
    const clientRequestId = randomUUID();
    const request = baseRequest({ clientRequestId });

    await db.collection("trips").doc(clientRequestId).set({
      ownerId: OWNER_UID,
      memberIds: [OWNER_UID],
      title: request.title,
      location: request.location,
      target: request.target,
      saved: 0,
      imageUrl: request.imageUrl,
      tripStartDate: request.tripStartDate,
      tripEndDate: request.tripEndDate,
      ledgerOpeningBalanceMinor: 0,
      ledgerBalanceMinor: 0,
      currency: "USD",
      ownershipModelState: "initialized",
      ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
      // creationRequest deliberately omitted.
    });

    await assertRejectsWithCode(
      createTripCore(db, OWNER_UID, request),
      "already-exists"
    );
  });

  it("a malformed non-object creationRequest is rejected as already-exists", async () => {
    const clientRequestId = randomUUID();
    const request = baseRequest({ clientRequestId });

    await db.collection("trips").doc(clientRequestId).set({
      ownerId: OWNER_UID,
      memberIds: [OWNER_UID],
      title: request.title,
      location: request.location,
      target: request.target,
      saved: 0,
      imageUrl: request.imageUrl,
      tripStartDate: request.tripStartDate,
      tripEndDate: request.tripEndDate,
      ledgerOpeningBalanceMinor: 0,
      ledgerBalanceMinor: 0,
      currency: "USD",
      ownershipModelState: "initialized",
      ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
      creationRequest: "not-an-object",
    });

    await assertRejectsWithCode(
      createTripCore(db, OWNER_UID, request),
      "already-exists"
    );
  });

  it("wrong immutable stored ownerId is rejected as already-exists", async () => {
    const clientRequestId = randomUUID();
    const request = baseRequest({ clientRequestId });

    await db.collection("trips").doc(clientRequestId).set({
      ownerId: OTHER_UID, // mismatched vs. the incoming caller
      memberIds: [OTHER_UID],
      title: request.title,
      location: request.location,
      target: request.target,
      saved: 0,
      imageUrl: request.imageUrl,
      tripStartDate: request.tripStartDate,
      tripEndDate: request.tripEndDate,
      ledgerOpeningBalanceMinor: 0,
      ledgerBalanceMinor: 0,
      currency: "USD",
      ownershipModelState: "initialized",
      ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
      creationRequest: {
        clientRequestId,
        ownerId: OTHER_UID,
        title: request.title,
        location: request.location,
        target: request.target,
        imageUrl: request.imageUrl,
        tripStartDate: request.tripStartDate,
        tripEndDate: request.tripEndDate,
      },
    });

    await assertRejectsWithCode(
      createTripCore(db, OWNER_UID, request),
      "already-exists"
    );
  });

  it("wrong immutable stored ledgerOpeningBalanceMinor is rejected as already-exists", async () => {
    const clientRequestId = randomUUID();
    const request = baseRequest({ clientRequestId });

    await db.collection("trips").doc(clientRequestId).set({
      ownerId: OWNER_UID,
      memberIds: [OWNER_UID],
      title: request.title,
      location: request.location,
      target: request.target,
      saved: 50,
      imageUrl: request.imageUrl,
      tripStartDate: request.tripStartDate,
      tripEndDate: request.tripEndDate,
      ledgerOpeningBalanceMinor: 5000, // not the canonical 0
      ledgerBalanceMinor: 5000,
      currency: "USD",
      ownershipModelState: "initialized",
      ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
      creationRequest: {
        clientRequestId,
        ownerId: OWNER_UID,
        title: request.title,
        location: request.location,
        target: request.target,
        imageUrl: request.imageUrl,
        tripStartDate: request.tripStartDate,
        tripEndDate: request.tripEndDate,
      },
    });

    await assertRejectsWithCode(
      createTripCore(db, OWNER_UID, request),
      "already-exists"
    );
  });

  it("wrong immutable stored currency is rejected as already-exists", async () => {
    const clientRequestId = randomUUID();
    const request = baseRequest({ clientRequestId });

    await db.collection("trips").doc(clientRequestId).set({
      ownerId: OWNER_UID,
      memberIds: [OWNER_UID],
      title: request.title,
      location: request.location,
      target: request.target,
      saved: 0,
      imageUrl: request.imageUrl,
      tripStartDate: request.tripStartDate,
      tripEndDate: request.tripEndDate,
      ledgerOpeningBalanceMinor: 0,
      ledgerBalanceMinor: 0,
      currency: "EUR", // mismatched
      ownershipModelState: "initialized",
      ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
      creationRequest: {
        clientRequestId,
        ownerId: OWNER_UID,
        title: request.title,
        location: request.location,
        target: request.target,
        imageUrl: request.imageUrl,
        tripStartDate: request.tripStartDate,
        tripEndDate: request.tripEndDate,
      },
    });

    await assertRejectsWithCode(
      createTripCore(db, OWNER_UID, request),
      "already-exists"
    );
  });

  it("wrong/missing immutable stored ownershipModelVersion is rejected as already-exists", async () => {
    const clientRequestId = randomUUID();
    const request = baseRequest({ clientRequestId });

    await db.collection("trips").doc(clientRequestId).set({
      ownerId: OWNER_UID,
      memberIds: [OWNER_UID],
      title: request.title,
      location: request.location,
      target: request.target,
      saved: 0,
      imageUrl: request.imageUrl,
      tripStartDate: request.tripStartDate,
      tripEndDate: request.tripEndDate,
      ledgerOpeningBalanceMinor: 0,
      ledgerBalanceMinor: 0,
      currency: "USD",
      ownershipModelState: "initialized",
      ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION + 1, // wrong
      creationRequest: {
        clientRequestId,
        ownerId: OWNER_UID,
        title: request.title,
        location: request.location,
        target: request.target,
        imageUrl: request.imageUrl,
        tripStartDate: request.tripStartDate,
        tripEndDate: request.tripEndDate,
      },
    });

    await assertRejectsWithCode(
      createTripCore(db, OWNER_UID, request),
      "already-exists"
    );
  });

  it("a replay is never a repair - the malformed stored document remains untouched after rejection", async () => {
    const clientRequestId = randomUUID();
    const request = baseRequest({ clientRequestId });

    await db.collection("trips").doc(clientRequestId).set({
      ownerId: OWNER_UID,
      memberIds: [OWNER_UID],
      title: "Some Legacy Trip",
      saved: 0,
    });
    const before = (
      await db.collection("trips").doc(clientRequestId).get()
    ).data()!;

    await assertRejectsWithCode(
      createTripCore(db, OWNER_UID, request),
      "already-exists"
    );

    const after = (
      await db.collection("trips").doc(clientRequestId).get()
    ).data()!;
    assert.deepEqual(after, before);
  });
});

// Checkpoint 5B.5A hardening, Finding 1: creationRequest is an immutable
// EXACT original-request snapshot - no missing key, no extra key, even
// if every key present otherwise matches.
describe("createTripCore - creationRequest must be the EXACT frozen shape (Finding 1)", () => {
  it("an exact, untampered creationRequest (all 8 keys, nothing else) succeeds as a valid replay", async () => {
    const clientRequestId = randomUUID();
    const request = baseRequest({ clientRequestId });
    const first = await createTripCore(db, OWNER_UID, request);

    const stored = (
      await db.collection("trips").doc(clientRequestId).get()
    ).data()!;
    assert.deepEqual(
      Object.keys(stored.creationRequest as Record<string, unknown>).sort(),
      [
        "clientRequestId",
        "imageUrl",
        "location",
        "ownerId",
        "target",
        "title",
        "tripEndDate",
        "tripStartDate",
      ]
    );

    const replay = await createTripCore(db, OWNER_UID, request);
    assert.equal(replay.tripId, first.tripId);
  });

  it("a creationRequest with one extra key is rejected as already-exists, even though every expected key still matches", async () => {
    const clientRequestId = randomUUID();
    const request = baseRequest({ clientRequestId });
    await createTripCore(db, OWNER_UID, request);

    await db.collection("trips").doc(clientRequestId).update({
      "creationRequest.bogusExtraKey": "unexpected",
    });

    await assertRejectsWithCode(
      createTripCore(db, OWNER_UID, request),
      "already-exists"
    );
  });

  it("a creationRequest missing one expected key is rejected as already-exists, even though every present key still matches", async () => {
    const clientRequestId = randomUUID();
    const request = baseRequest({ clientRequestId });
    await createTripCore(db, OWNER_UID, request);

    // tripEndDate's VALUE is already null in the base request - this
    // removes the KEY entirely, which is a different, stricter violation
    // the exact-shape check must also catch.
    await db.collection("trips").doc(clientRequestId).update({
      "creationRequest.tripEndDate": FieldValue.delete(),
    });

    await assertRejectsWithCode(
      createTripCore(db, OWNER_UID, request),
      "already-exists"
    );
  });

  it("a rejected exact-shape replay does not repair or otherwise mutate the stored document", async () => {
    const clientRequestId = randomUUID();
    const request = baseRequest({ clientRequestId });
    await createTripCore(db, OWNER_UID, request);

    await db.collection("trips").doc(clientRequestId).update({
      "creationRequest.bogusExtraKey": "unexpected",
    });
    const before = (
      await db.collection("trips").doc(clientRequestId).get()
    ).data()!;

    await assertRejectsWithCode(
      createTripCore(db, OWNER_UID, request),
      "already-exists"
    );

    const after = (
      await db.collection("trips").doc(clientRequestId).get()
    ).data()!;
    assert.deepEqual(after, before);
  });
});

describe("createTripCore - unrelated Trips are unaffected", () => {
  it("an existing unrelated legacy Trip (different id) is byte-for-byte unaffected", async () => {
    const legacyTripId = "unrelated-legacy-trip";
    await db.collection("trips").doc(legacyTripId).set({
      ownerId: OTHER_UID,
      memberIds: [OTHER_UID],
      title: "Unrelated Legacy Trip",
      location: null,
      target: 1000,
      saved: 250,
      imageUrl: "https://example.com/legacy.jpg",
      tripStartDate: "2026-01-01",
      tripEndDate: null,
    });
    const before = (
      await db.collection("trips").doc(legacyTripId).get()
    ).data()!;

    await createTripCore(db, OWNER_UID, baseRequest());

    const after = (
      await db.collection("trips").doc(legacyTripId).get()
    ).data()!;
    assert.deepEqual(after, before);
  });

  it("an existing unrelated migrated initialized Trip (different id, with a completed migration-state doc) is byte-for-byte unaffected", async () => {
    const migratedTripId = "unrelated-migrated-trip";
    await db.collection("trips").doc(migratedTripId).set({
      ownerId: OTHER_UID,
      memberIds: [OTHER_UID],
      title: "Unrelated Migrated Trip",
      location: null,
      target: 2000,
      saved: 99,
      ledgerOpeningBalanceMinor: 0,
      ledgerBalanceMinor: 9900,
      currency: "USD",
      ownershipModelState: "initialized",
      ownershipModelVersion: CURRENT_TRIP_OWNERSHIP_MODEL_VERSION,
      imageUrl: "https://example.com/migrated.jpg",
      tripStartDate: "2026-02-01",
      tripEndDate: null,
    });
    await db.collection("tripOwnershipMigrationState").doc(migratedTripId).set({
      tripId: migratedTripId,
      attemptId: "attempt-unrelated",
      phase: "completed",
      completedAt: Timestamp.now(),
    });
    const beforeTrip = (
      await db.collection("trips").doc(migratedTripId).get()
    ).data()!;
    const beforeMigrationState = (
      await db
        .collection("tripOwnershipMigrationState")
        .doc(migratedTripId)
        .get()
    ).data()!;

    await createTripCore(db, OWNER_UID, baseRequest());

    const afterTrip = (
      await db.collection("trips").doc(migratedTripId).get()
    ).data()!;
    const afterMigrationState = (
      await db
        .collection("tripOwnershipMigrationState")
        .doc(migratedTripId)
        .get()
    ).data()!;
    assert.deepEqual(afterTrip, beforeTrip);
    assert.deepEqual(afterMigrationState, beforeMigrationState);
  });
});
