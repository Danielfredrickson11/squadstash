// Tests for reverseTripSettlementCore against the local Firestore emulator
// via the Admin SDK - never production, guarded below. Run via
// `npm --prefix functions test`, wrapped in
// `firebase emulators:exec --only firestore "..."` so
// FIRESTORE_EMULATOR_HOST is set automatically (the same mechanism
// reverseTripExpenseCore.ts already relies on).
//
// Checkpoint 4E.2 first-pass coverage (docs/audits/
// TRIP_BALANCES_SETTLEMENTS_PREFLIGHT_2026-09-28.md §11/§13, as hardened
// by 4E.0A).
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
  reverseTripSettlementCore,
} from "../src/callables/reverseTripSettlement";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "FIRESTORE_EMULATOR_HOST is not set. Run these tests via " +
      '`firebase emulators:exec --only firestore "npm --prefix functions test"` ' +
      "so the Admin SDK talks to the local emulator, never production."
  );
}

const OWNER_UID = "owner-uid";
const MEMBER_UID = "member-uid"; // fromUid (the debtor) - no reversal authority
const OTHER_MEMBER_UID = "other-member-uid"; // toUid (the recipient) - the only reverser
const OUTSIDER_UID = "outsider-uid";
const TRIP_ID = "test-trip";
const SETTLEMENT_ID = "test-settlement";

let app: App;
let db: Firestore;

before(() => {
  // A distinct "demo-" project id from every other functions test file's
  // own test app - Node's test runner executes test FILES concurrently by
  // default.
  app = initializeApp({
    projectId: "demo-squadstash-functions-test-reverse-trip-settlement",
  });
  db = getFirestore(app);
});

after(async () => {
  await deleteApp(app);
});

async function clearFirestore(): Promise<void> {
  for (const name of ["trips", "tripSettlements"]) {
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

function seedSettlement(
  overrides: Record<string, unknown> = {}
): Promise<FirebaseFirestore.WriteResult> {
  return db
    .collection("tripSettlements")
    .doc(SETTLEMENT_ID)
    .set({
      tripId: TRIP_ID,
      fromUid: MEMBER_UID,
      toUid: OTHER_MEMBER_UID,
      amountMinor: 4000,
      currency: "USD",
      method: "venmo",
      createdAt: new Date(),
      createdBy: OTHER_MEMBER_UID,
      status: "active",
      creationRequest: {
        tripId: TRIP_ID,
        fromUid: MEMBER_UID,
        toUid: OTHER_MEMBER_UID,
        amountMinor: 4000,
        currency: "USD",
        method: "venmo",
        note: null,
        occurredAtInstantMs: null,
      },
      ...overrides,
    });
}

// Checkpoint: seeds a Settlement already in the "reversed" state, for
// tests that need direct control over the STORED reversalRequest
// snapshot's exact shape (replay-fidelity tests below) - never produced
// by going through reverseTripSettlementCore twice, since that would
// only ever write the canonical shape this callable itself already
// produces.
function seedReversedSettlement(
  overrides: Record<string, unknown> = {}
): Promise<FirebaseFirestore.WriteResult> {
  return seedSettlement({
    status: "reversed",
    reversedAt: new Date(),
    reversedBy: OTHER_MEMBER_UID,
    reversalRequest: { clientRequestId: "canonical-id", reversalReason: null },
    ...overrides,
  });
}

function baseReversalRequest(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    settlementId: SETTLEMENT_ID,
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

async function getSettlementData(): Promise<
  FirebaseFirestore.DocumentData | undefined
> {
  const snap = await db.collection("tripSettlements").doc(SETTLEMENT_ID).get();
  return snap.data();
}

async function expectNoMutation(
  setup: () => Promise<unknown>,
  attempt: () => Promise<unknown>,
  expectedCode: string
): Promise<void> {
  await setup();
  const before = await getSettlementData();

  await assertRejectsWithCode(attempt(), expectedCode);

  const after = await getSettlementData();
  assert.deepEqual(after, before);
}

describe("reverseTripSettlementCore - production auth boundary", () => {
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

describe("reverseTripSettlementCore - authorized reversal", () => {
  it("the Settlement's own toUid reverses an active Settlement successfully", async () => {
    await seedTrip();
    await seedSettlement();

    const result = await reverseTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseReversalRequest({ reversalReason: "Recorded by mistake" })
    );
    assert.equal(result.settlementId, SETTLEMENT_ID);

    const data = await getSettlementData();
    assert.equal(data?.status, "reversed");
    assert.equal(data?.reversedBy, OTHER_MEMBER_UID);
    assert.ok(data?.reversedAt);
    assert.equal(data?.reversalReason, "Recorded by mistake");
    assert.deepEqual(data?.reversalRequest, {
      clientRequestId: data?.reversalRequest.clientRequestId,
      reversalReason: "Recorded by mistake",
    });
  });

  it("only reversal metadata changes - every other financial fact is byte-for-byte identical before and after", async () => {
    await seedTrip();
    await seedSettlement({ note: "Trip settle-up" });
    const before = await getSettlementData();

    await reverseTripSettlementCore(db, OTHER_MEMBER_UID, baseReversalRequest());

    const after = await getSettlementData();
    assert.equal(after?.tripId, before?.tripId);
    assert.equal(after?.fromUid, before?.fromUid);
    assert.equal(after?.toUid, before?.toUid);
    assert.equal(after?.amountMinor, before?.amountMinor);
    assert.equal(after?.currency, before?.currency);
    assert.equal(after?.method, before?.method);
    assert.equal(after?.note, before?.note);
    assert.deepEqual(after?.createdAt, before?.createdAt);
    assert.equal(after?.createdBy, before?.createdBy);
    assert.deepEqual(after?.creationRequest, before?.creationRequest);
  });
});

describe("reverseTripSettlementCore - authorization (narrower than Expense reversal)", () => {
  it("fromUid (the debtor) cannot reverse", async () => {
    await seedTrip();
    await seedSettlement();
    await assertRejectsWithCode(
      reverseTripSettlementCore(db, MEMBER_UID, baseReversalRequest()),
      "permission-denied"
    );
  });

  it("an unrelated current member cannot reverse", async () => {
    await seedTrip({
      memberIds: [OWNER_UID, MEMBER_UID, OTHER_MEMBER_UID, "fourth-member"],
    });
    await seedSettlement();
    await assertRejectsWithCode(
      reverseTripSettlementCore(db, "fourth-member", baseReversalRequest()),
      "permission-denied"
    );
  });

  it("the Trip owner cannot reverse merely by being owner (unlike Expense reversal)", async () => {
    await seedTrip();
    await seedSettlement();
    await assertRejectsWithCode(
      reverseTripSettlementCore(db, OWNER_UID, baseReversalRequest()),
      "permission-denied"
    );
  });

  it("the Trip owner DOES succeed when they are also the Settlement's own toUid", async () => {
    await seedTrip();
    await seedSettlement({ toUid: OWNER_UID, createdBy: OWNER_UID });
    const result = await reverseTripSettlementCore(
      db,
      OWNER_UID,
      baseReversalRequest()
    );
    assert.equal(result.settlementId, SETTLEMENT_ID);
  });

  it("toUid removed from Trip membership cannot perform a NEW reversal", async () => {
    await seedTrip({ memberIds: [OWNER_UID, MEMBER_UID] }); // OTHER_MEMBER_UID removed
    await seedSettlement();
    await assertRejectsWithCode(
      reverseTripSettlementCore(db, OTHER_MEMBER_UID, baseReversalRequest()),
      "permission-denied"
    );
  });

  it("outsider vs. an active Settlement -> permission-denied, without disclosing status", async () => {
    await expectNoMutation(
      async () => {
        await seedTrip();
        await seedSettlement();
      },
      () => reverseTripSettlementCore(db, OUTSIDER_UID, baseReversalRequest()),
      "permission-denied"
    );
  });

  it("outsider vs. an already-reversed Settlement -> the identical permission-denied", async () => {
    await seedTrip();
    await seedReversedSettlement();
    await assertRejectsWithCode(
      reverseTripSettlementCore(db, OUTSIDER_UID, baseReversalRequest()),
      "permission-denied"
    );
  });
});

describe("reverseTripSettlementCore - idempotent replay", () => {
  it("exact own replay succeeds and does not rewrite reversedAt again", async () => {
    await seedTrip();
    await seedSettlement();
    const request = baseReversalRequest({ reversalReason: "Wrong amount" });

    await reverseTripSettlementCore(db, OTHER_MEMBER_UID, request);
    const first = await getSettlementData();

    const result = await reverseTripSettlementCore(db, OTHER_MEMBER_UID, request);
    assert.equal(result.settlementId, SETTLEMENT_ID);

    const second = await getSettlementData();
    assert.deepEqual(second?.reversedAt, first?.reversedAt);
    assert.equal(second?.reversedBy, first?.reversedBy);
    assert.equal(second?.reversalReason, first?.reversalReason);
  });

  it("same reverser, same Settlement, DIFFERENT clientRequestId after reversal fails failed-precondition", async () => {
    await seedTrip();
    await seedSettlement();
    await reverseTripSettlementCore(db, OTHER_MEMBER_UID, baseReversalRequest());

    await assertRejectsWithCode(
      reverseTripSettlementCore(db, OTHER_MEMBER_UID, baseReversalRequest()),
      "failed-precondition"
    );
  });

  it("same reverser, same clientRequestId, CHANGED reversalReason fails failed-precondition", async () => {
    await seedTrip();
    await seedSettlement();
    const clientRequestId = randomUUID();
    await reverseTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseReversalRequest({ clientRequestId, reversalReason: "First reason" })
    );

    await assertRejectsWithCode(
      reverseTripSettlementCore(
        db,
        OTHER_MEMBER_UID,
        baseReversalRequest({ clientRequestId, reversalReason: "Different" })
      ),
      "failed-precondition"
    );
  });

  it("exact replay remains parent-independent once genuinely committed (Trip deleted)", async () => {
    await seedTrip();
    await seedSettlement();
    const request = baseReversalRequest({ reversalReason: "Wrong amount" });
    await reverseTripSettlementCore(db, OTHER_MEMBER_UID, request);

    await db.collection("trips").doc(TRIP_ID).delete();

    const result = await reverseTripSettlementCore(db, OTHER_MEMBER_UID, request);
    assert.equal(result.settlementId, SETTLEMENT_ID);
  });
});

describe("reverseTripSettlementCore - status validation", () => {
  it("malformed persisted status + authorized caller -> failed-precondition", async () => {
    await seedTrip();
    await seedSettlement({ status: "corrupted-value" });
    await assertRejectsWithCode(
      reverseTripSettlementCore(db, OTHER_MEMBER_UID, baseReversalRequest()),
      "failed-precondition"
    );
  });

  it("malformed persisted status + outsider -> permission-denied, never disclosing status", async () => {
    await seedTrip();
    await seedSettlement({ status: "corrupted-value" });
    await assertRejectsWithCode(
      reverseTripSettlementCore(db, OUTSIDER_UID, baseReversalRequest()),
      "permission-denied"
    );
  });

  it("already reversed by a non-matching request -> failed-precondition, Settlement unchanged", async () => {
    await expectNoMutation(
      async () => {
        await seedTrip();
        await seedSettlement();
        await reverseTripSettlementCore(
          db,
          OTHER_MEMBER_UID,
          baseReversalRequest({ reversalReason: "First" })
        );
      },
      () =>
        reverseTripSettlementCore(
          db,
          OTHER_MEMBER_UID,
          baseReversalRequest({ reversalReason: "Different" })
        ),
      "failed-precondition"
    );
  });

  it("malformed stored reversal metadata for an authorized caller -> failed-precondition, Settlement unchanged", async () => {
    await expectNoMutation(
      async () => {
        await seedTrip();
        await seedReversedSettlement({
          reversalRequest: { clientRequestId: "canonical-id", extra: true },
        });
      },
      () => reverseTripSettlementCore(db, OTHER_MEMBER_UID, baseReversalRequest()),
      "failed-precondition"
    );
  });
});

describe("reverseTripSettlementCore - archive behavior", () => {
  it("authorized reversal succeeds on an archived Trip (deliberately no archive gate)", async () => {
    await seedTrip({ archivedAt: new Date() });
    await seedSettlement();

    const result = await reverseTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseReversalRequest()
    );
    assert.equal(result.settlementId, SETTLEMENT_ID);
  });
});

describe("reverseTripSettlementCore - missing/malformed routing", () => {
  it("missing Settlement -> not-found", async () => {
    await assertRejectsWithCode(
      reverseTripSettlementCore(db, OTHER_MEMBER_UID, baseReversalRequest()),
      "not-found"
    );
  });

  it("malformed persisted tripId -> failed-precondition", async () => {
    await seedSettlement({ tripId: "a/b" });
    await assertRejectsWithCode(
      reverseTripSettlementCore(db, OTHER_MEMBER_UID, baseReversalRequest()),
      "failed-precondition"
    );
  });

  it("a missing referenced Trip -> failed-precondition", async () => {
    await seedSettlement({ tripId: "nonexistent-trip" });
    await assertRejectsWithCode(
      reverseTripSettlementCore(db, OTHER_MEMBER_UID, baseReversalRequest()),
      "failed-precondition"
    );
  });

  it("malformed settlementId is rejected invalid-argument before any Firestore path is built", async () => {
    await assertRejectsWithCode(
      reverseTripSettlementCore(
        db,
        OTHER_MEMBER_UID,
        baseReversalRequest({ settlementId: "a/b" })
      ),
      "invalid-argument"
    );
  });
});

describe("reverseTripSettlementCore - reversalReason normalization", () => {
  it("a trimmed, non-empty reversalReason persists trimmed on both fields", async () => {
    await seedTrip();
    await seedSettlement();
    await reverseTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseReversalRequest({ reversalReason: "  Wrong amount  " })
    );
    const data = await getSettlementData();
    assert.equal(data?.reversalReason, "Wrong amount");
    assert.equal(data?.reversalRequest.reversalReason, "Wrong amount");
  });

  it("a whitespace-only reversalReason normalizes to null and is not persisted at the top level", async () => {
    await seedTrip();
    await seedSettlement();
    await reverseTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseReversalRequest({ reversalReason: "   " })
    );
    const data = await getSettlementData();
    assert.equal("reversalReason" in (data ?? {}), false);
    assert.equal(data?.reversalRequest.reversalReason, null);
  });

  it("removes a stale top-level reversalReason left over on an ACTIVE Settlement when reversing with no reason", async () => {
    await seedTrip();
    await seedSettlement({ reversalReason: "stale leftover value" });
    await reverseTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseReversalRequest({ reversalReason: "   " })
    );
    const data = await getSettlementData();
    assert.equal("reversalReason" in (data ?? {}), false);
  });

  it("an oversized reversalReason is rejected invalid-argument", async () => {
    await seedTrip();
    await seedSettlement();
    await assertRejectsWithCode(
      reverseTripSettlementCore(
        db,
        OTHER_MEMBER_UID,
        baseReversalRequest({ reversalReason: "x".repeat(501) })
      ),
      "invalid-argument"
    );
  });
});

describe("reverseTripSettlementCore - immutability of financial facts", () => {
  it("reversal never alters tripId/fromUid/toUid/amountMinor/currency/method/note/occurredAt/createdAt/createdBy/creationRequest", async () => {
    await seedTrip();
    await seedSettlement({
      note: "Trip settle-up",
      occurredAt: new Date("2027-01-01T00:00:00Z"),
    });
    const before = await getSettlementData();

    await reverseTripSettlementCore(db, OTHER_MEMBER_UID, baseReversalRequest());

    const after = await getSettlementData();
    for (const field of [
      "tripId",
      "fromUid",
      "toUid",
      "amountMinor",
      "currency",
      "method",
      "note",
      "createdBy",
    ]) {
      assert.equal(after?.[field], before?.[field], `${field} must be unchanged`);
    }
    assert.deepEqual(after?.occurredAt, before?.occurredAt);
    assert.deepEqual(after?.createdAt, before?.createdAt);
    assert.deepEqual(after?.creationRequest, before?.creationRequest);
  });
});
