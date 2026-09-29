// Tests for recordTripSettlementCore against the local Firestore emulator
// via the Admin SDK - never production, guarded below. Run via
// `npm --prefix functions test`, wrapped in
// `firebase emulators:exec --only firestore "..."` so
// FIRESTORE_EMULATOR_HOST is set automatically (the same mechanism
// recordTripExpenseCore.ts/reverseTripExpenseCore.ts already rely on).
//
// Checkpoint 4E.2 first-pass coverage (docs/audits/
// TRIP_BALANCES_SETTLEMENTS_PREFLIGHT_2026-09-28.md, as hardened by
// 4E.0A/4E.0A.1) - the full multi-checkpoint adversarial hardening sweep
// Expense accumulated across 4C.2A/4C.2B/4C.2C/4C.2D is not reproduced
// here in full; this suite covers every scenario the checkpoint's own
// §21 test matrix names, plus the tripId document-id-safety check the
// checkpoint's own §4 explicitly requires.
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
  recordTripSettlementCore,
  requireAuthenticatedUid,
} from "../src/callables/recordTripSettlement";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "FIRESTORE_EMULATOR_HOST is not set. Run these tests via " +
      '`firebase emulators:exec --only firestore "npm --prefix functions test"` ' +
      "so the Admin SDK talks to the local emulator, never production."
  );
}

const OWNER_UID = "owner-uid";
const MEMBER_UID = "member-uid"; // typically fromUid (the debtor)
const OTHER_MEMBER_UID = "other-member-uid"; // typically toUid (the recipient)
const OUTSIDER_UID = "outsider-uid";
const TRIP_ID = "test-trip";

let app: App;
let db: Firestore;

before(() => {
  // A distinct "demo-" project id from every other functions test file's
  // own test app - Node's test runner executes test FILES concurrently by
  // default, so sharing a project id would let this file's per-test
  // clearFirestore() race with a concurrently-running suite.
  app = initializeApp({
    projectId: "demo-squadstash-functions-test-record-trip-settlement",
  });
  db = getFirestore(app);
});

after(async () => {
  await deleteApp(app);
});

async function clearFirestore(): Promise<void> {
  for (const name of [
    "trips",
    "tripSettlements",
    "tripExpenses",
    "tripExpenseSplits",
    "buckets",
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
      saved: 0,
      imageUrl: "https://example.com/trip.jpg",
      tripStartDate: "2027-06-12",
      ...overrides,
    });
}

function baseSettlementRequest(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    tripId: TRIP_ID,
    fromUid: MEMBER_UID,
    toUid: OTHER_MEMBER_UID,
    amountMinor: 4000,
    currency: "USD",
    method: "venmo",
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

async function getSettlement(
  settlementId: string
): Promise<FirebaseFirestore.DocumentData | undefined> {
  const snap = await db.collection("tripSettlements").doc(settlementId).get();
  return snap.data();
}

describe("recordTripSettlementCore - production auth boundary", () => {
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

  it("returns the exact uid when auth is present", () => {
    const auth = { uid: MEMBER_UID } as CallableRequest["auth"];
    assert.equal(requireAuthenticatedUid(auth), MEMBER_UID);
  });
});

describe("recordTripSettlementCore - success / persisted shape", () => {
  it("current-member fromUid + toUid===current-member recipient persists exactly one Settlement", async () => {
    await seedTrip();
    const result = await recordTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseSettlementRequest()
    );
    assert.equal(result.settlementId.length > 0, true);

    const snap = await db.collection("tripSettlements").get();
    assert.equal(snap.size, 1);
  });

  it("createdBy is derived from auth, never client input", async () => {
    await seedTrip();
    const result = await recordTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseSettlementRequest()
    );
    const data = await getSettlement(result.settlementId);
    assert.equal(data?.createdBy, OTHER_MEMBER_UID);
  });

  it("status is active", async () => {
    await seedTrip();
    const result = await recordTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseSettlementRequest()
    );
    const data = await getSettlement(result.settlementId);
    assert.equal(data?.status, "active");
  });

  it("createdAt is server-generated", async () => {
    await seedTrip();
    const result = await recordTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseSettlementRequest()
    );
    const data = await getSettlement(result.settlementId);
    assert.ok(data?.createdAt, "createdAt should be populated");
  });

  it("no reversal fields are present at creation", async () => {
    await seedTrip();
    const result = await recordTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseSettlementRequest()
    );
    const data = await getSettlement(result.settlementId);
    assert.equal("reversedAt" in (data ?? {}), false);
    assert.equal("reversedBy" in (data ?? {}), false);
    assert.equal("reversalReason" in (data ?? {}), false);
    assert.equal("reversalRequest" in (data ?? {}), false);
  });

  it("clientRequestId is never persisted as an ordinary top-level field", async () => {
    await seedTrip();
    const clientRequestId = randomUUID();
    await recordTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseSettlementRequest({ clientRequestId })
    );
    const data = await getSettlement(clientRequestId);
    assert.equal("clientRequestId" in (data ?? {}), false);
    // clientRequestId is ONLY the Firestore document id - it is
    // deliberately NOT inside creationRequest either (the frozen schema,
    // §6/§7 of the checkpoint prompt, intentionally excludes it there).
    // This assertion just confirms the document actually persisted under
    // that id, via an unrelated field.
    assert.equal(data?.creationRequest.tripId, TRIP_ID);
  });

  it("persisted fields match the exact financial facts submitted", async () => {
    await seedTrip();
    const result = await recordTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseSettlementRequest({ amountMinor: 12345, method: "zelle" })
    );
    const data = await getSettlement(result.settlementId);
    assert.equal(data?.tripId, TRIP_ID);
    assert.equal(data?.fromUid, MEMBER_UID);
    assert.equal(data?.toUid, OTHER_MEMBER_UID);
    assert.equal(data?.amountMinor, 12345);
    assert.equal(data?.currency, "USD");
    assert.equal(data?.method, "zelle");
  });
});

describe("recordTripSettlementCore - creator-bound idempotency", () => {
  it("exact same creator + same clientRequestId + same normalized facts replays successfully without duplicate writes", async () => {
    await seedTrip();
    const request = baseSettlementRequest();

    const first = await recordTripSettlementCore(db, OTHER_MEMBER_UID, request);
    const second = await recordTripSettlementCore(db, OTHER_MEMBER_UID, request);

    assert.equal(first.settlementId, second.settlementId);
    const snap = await db.collection("tripSettlements").get();
    assert.equal(snap.size, 1);
  });

  it("same id + changed amount -> already-exists", async () => {
    await seedTrip();
    const clientRequestId = randomUUID();
    await recordTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseSettlementRequest({ clientRequestId })
    );
    await assertRejectsWithCode(
      recordTripSettlementCore(
        db,
        OTHER_MEMBER_UID,
        baseSettlementRequest({ clientRequestId, amountMinor: 9999 })
      ),
      "already-exists"
    );
  });

  it("same id + changed fromUid -> already-exists", async () => {
    await seedTrip();
    const clientRequestId = randomUUID();
    await recordTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseSettlementRequest({ clientRequestId })
    );
    await assertRejectsWithCode(
      recordTripSettlementCore(
        db,
        OTHER_MEMBER_UID,
        baseSettlementRequest({ clientRequestId, fromUid: OWNER_UID })
      ),
      "already-exists"
    );
  });

  it("same id + changed toUid -> already-exists (isolated: same caller both times, only the toUid FACT differs)", async () => {
    await seedTrip();
    const clientRequestId = randomUUID();
    await recordTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseSettlementRequest({ clientRequestId })
    );
    // The exact-replay/collision branch is evaluated BEFORE new-Settlement
    // authorization is ever reached, so this mismatched-toUid retry never
    // gets as far as needing toUid === authUid to hold - it is caught
    // purely by the creationRequest field comparison.
    await assertRejectsWithCode(
      recordTripSettlementCore(
        db,
        OTHER_MEMBER_UID,
        baseSettlementRequest({ clientRequestId, toUid: OWNER_UID })
      ),
      "already-exists"
    );
  });

  it("same id + changed method -> already-exists", async () => {
    await seedTrip();
    const clientRequestId = randomUUID();
    await recordTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseSettlementRequest({ clientRequestId, method: "venmo" })
    );
    await assertRejectsWithCode(
      recordTripSettlementCore(
        db,
        OTHER_MEMBER_UID,
        baseSettlementRequest({ clientRequestId, method: "cash" })
      ),
      "already-exists"
    );
  });

  it("same id + changed note -> already-exists", async () => {
    await seedTrip();
    const clientRequestId = randomUUID();
    await recordTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseSettlementRequest({ clientRequestId, note: "Trip settle-up" })
    );
    await assertRejectsWithCode(
      recordTripSettlementCore(
        db,
        OTHER_MEMBER_UID,
        baseSettlementRequest({ clientRequestId, note: "Different note" })
      ),
      "already-exists"
    );
  });

  it("same id + changed occurredAt -> already-exists", async () => {
    await seedTrip();
    const clientRequestId = randomUUID();
    await recordTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseSettlementRequest({
        clientRequestId,
        occurredAt: "2027-01-01T00:00:00Z",
      })
    );
    await assertRejectsWithCode(
      recordTripSettlementCore(
        db,
        OTHER_MEMBER_UID,
        baseSettlementRequest({
          clientRequestId,
          occurredAt: "2027-02-01T00:00:00Z",
        })
      ),
      "already-exists"
    );
  });

  it("same id used by a different authenticated caller -> already-exists", async () => {
    await seedTrip();
    const request = baseSettlementRequest();
    await recordTripSettlementCore(db, OTHER_MEMBER_UID, request);

    await assertRejectsWithCode(
      recordTripSettlementCore(db, OWNER_UID, request),
      "already-exists"
    );
  });

  it("exact original creator's replay reconciles successfully even after that creator is later removed from Trip membership", async () => {
    await seedTrip();
    const request = baseSettlementRequest();
    const first = await recordTripSettlementCore(db, OTHER_MEMBER_UID, request);

    await db
      .collection("trips")
      .doc(TRIP_ID)
      .update({ memberIds: [OWNER_UID, MEMBER_UID] });

    const replay = await recordTripSettlementCore(db, OTHER_MEMBER_UID, request);
    assert.equal(replay.settlementId, first.settlementId);
  });

  it("exact replay succeeds even after the parent Trip document is deleted entirely (parent-independent replay)", async () => {
    await seedTrip();
    const request = baseSettlementRequest();
    const first = await recordTripSettlementCore(db, OTHER_MEMBER_UID, request);

    await db.collection("trips").doc(TRIP_ID).delete();

    const replay = await recordTripSettlementCore(db, OTHER_MEMBER_UID, request);
    assert.equal(replay.settlementId, first.settlementId);
    const snap = await db.collection("tripSettlements").get();
    assert.equal(snap.size, 1);
  });

  it("a genuinely NEW Settlement against a missing parent Trip is still not-found, with zero writes", async () => {
    await assertRejectsWithCode(
      recordTripSettlementCore(db, OTHER_MEMBER_UID, baseSettlementRequest()),
      "not-found"
    );
    const snap = await db.collection("tripSettlements").get();
    assert.equal(snap.size, 0);
  });
});

describe("recordTripSettlementCore - authority", () => {
  it("caller != toUid -> permission-denied", async () => {
    await seedTrip();
    await assertRejectsWithCode(
      recordTripSettlementCore(db, MEMBER_UID, baseSettlementRequest()),
      "permission-denied"
    );
  });

  it("caller not a current Trip member -> permission-denied", async () => {
    await seedTrip();
    await assertRejectsWithCode(
      recordTripSettlementCore(
        db,
        OUTSIDER_UID,
        baseSettlementRequest({ toUid: OUTSIDER_UID })
      ),
      "permission-denied"
    );
  });

  it("Trip owner cannot record a settlement on someone else's behalf merely by being owner", async () => {
    await seedTrip();
    // OWNER_UID calls, but toUid names OTHER_MEMBER_UID as the recipient
    // - owner has no special authority unless owner === toUid.
    await assertRejectsWithCode(
      recordTripSettlementCore(db, OWNER_UID, baseSettlementRequest()),
      "permission-denied"
    );
  });

  it("Trip owner succeeds when they ARE the recipient (ownerUid === toUid)", async () => {
    await seedTrip();
    const result = await recordTripSettlementCore(
      db,
      OWNER_UID,
      baseSettlementRequest({ toUid: OWNER_UID })
    );
    assert.ok(result.settlementId.length > 0);
  });

  it("outsider + malformed memberIds -> permission-denied, never disclosing the corruption", async () => {
    await seedTrip({ memberIds: "not-a-list" });
    await assertRejectsWithCode(
      recordTripSettlementCore(
        db,
        OUTSIDER_UID,
        baseSettlementRequest({ toUid: OUTSIDER_UID })
      ),
      "permission-denied"
    );
  });
});

describe("recordTripSettlementCore - membership validation", () => {
  it("fromUid not a current Trip member -> failed-precondition (Checkpoint 4E.0A, never permission-denied)", async () => {
    await seedTrip();
    await assertRejectsWithCode(
      recordTripSettlementCore(
        db,
        OTHER_MEMBER_UID,
        baseSettlementRequest({ fromUid: OUTSIDER_UID })
      ),
      "failed-precondition"
    );
    const snap = await db.collection("tripSettlements").get();
    assert.equal(snap.size, 0);
  });

  it("malformed (non-list) memberIds + the Trip's actual owner-as-recipient -> failed-precondition (the owner may learn their own Trip is corrupt)", async () => {
    await seedTrip({ memberIds: "not-a-list" });
    await assertRejectsWithCode(
      recordTripSettlementCore(
        db,
        OWNER_UID,
        baseSettlementRequest({ toUid: OWNER_UID })
      ),
      "failed-precondition"
    );
  });
});

describe("recordTripSettlementCore - field validation", () => {
  it("fromUid === toUid -> invalid-argument", async () => {
    await assertRejectsWithCode(
      recordTripSettlementCore(
        db,
        MEMBER_UID,
        baseSettlementRequest({ fromUid: MEMBER_UID, toUid: MEMBER_UID })
      ),
      "invalid-argument"
    );
  });

  it("amount 0 -> invalid-argument", async () => {
    await assertRejectsWithCode(
      recordTripSettlementCore(
        db,
        OTHER_MEMBER_UID,
        baseSettlementRequest({ amountMinor: 0 })
      ),
      "invalid-argument"
    );
  });

  it("negative amount -> invalid-argument", async () => {
    await assertRejectsWithCode(
      recordTripSettlementCore(
        db,
        OTHER_MEMBER_UID,
        baseSettlementRequest({ amountMinor: -100 })
      ),
      "invalid-argument"
    );
  });

  it("float amount -> invalid-argument", async () => {
    await assertRejectsWithCode(
      recordTripSettlementCore(
        db,
        OTHER_MEMBER_UID,
        baseSettlementRequest({ amountMinor: 40.5 })
      ),
      "invalid-argument"
    );
  });

  it("unsafe integer amount -> invalid-argument", async () => {
    await assertRejectsWithCode(
      recordTripSettlementCore(
        db,
        OTHER_MEMBER_UID,
        baseSettlementRequest({ amountMinor: Number.MAX_SAFE_INTEGER + 10 })
      ),
      "invalid-argument"
    );
  });

  it("non-USD currency -> invalid-argument", async () => {
    await assertRejectsWithCode(
      recordTripSettlementCore(
        db,
        OTHER_MEMBER_UID,
        baseSettlementRequest({ currency: "EUR" })
      ),
      "invalid-argument"
    );
  });

  it("invalid method -> invalid-argument", async () => {
    await assertRejectsWithCode(
      recordTripSettlementCore(
        db,
        OTHER_MEMBER_UID,
        baseSettlementRequest({ method: "bitcoin" })
      ),
      "invalid-argument"
    );
  });

  it("blank fromUid -> invalid-argument", async () => {
    await assertRejectsWithCode(
      recordTripSettlementCore(
        db,
        OTHER_MEMBER_UID,
        baseSettlementRequest({ fromUid: "   " })
      ),
      "invalid-argument"
    );
  });

  it("blank toUid -> invalid-argument", async () => {
    await assertRejectsWithCode(
      recordTripSettlementCore(
        db,
        OTHER_MEMBER_UID,
        baseSettlementRequest({ toUid: "   " })
      ),
      "invalid-argument"
    );
  });

  it("malformed clientRequestId -> invalid-argument", async () => {
    await assertRejectsWithCode(
      recordTripSettlementCore(
        db,
        OTHER_MEMBER_UID,
        baseSettlementRequest({ clientRequestId: "has space" })
      ),
      "invalid-argument"
    );
  });

  it("unexpected top-level key -> invalid-argument, no write", async () => {
    await seedTrip();
    await assertRejectsWithCode(
      recordTripSettlementCore(db, OTHER_MEMBER_UID, {
        ...baseSettlementRequest(),
        createdBy: "forged-user",
      }),
      "invalid-argument"
    );
    const snap = await db.collection("tripSettlements").get();
    assert.equal(snap.size, 0);
  });

  it("oversized note -> invalid-argument", async () => {
    await assertRejectsWithCode(
      recordTripSettlementCore(
        db,
        OTHER_MEMBER_UID,
        baseSettlementRequest({ note: "x".repeat(501) })
      ),
      "invalid-argument"
    );
  });

  it("note is trimmed on persistence", async () => {
    await seedTrip();
    const result = await recordTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseSettlementRequest({ note: "  Trip settle-up  " })
    );
    const data = await getSettlement(result.settlementId);
    assert.equal(data?.note, "Trip settle-up");
  });

  it("a whitespace-only note normalizes to omitted (never persisted as an empty/whitespace string)", async () => {
    await seedTrip();
    const result = await recordTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseSettlementRequest({ note: "   " })
    );
    const data = await getSettlement(result.settlementId);
    assert.equal("note" in (data ?? {}), false);
    assert.equal(data?.creationRequest.note, null);
  });

  it("tripId containing \"/\" is invalid-argument, not an uncaught Admin SDK exception", async () => {
    await assertRejectsWithCode(
      recordTripSettlementCore(
        db,
        OTHER_MEMBER_UID,
        baseSettlementRequest({ tripId: "a/b" })
      ),
      "invalid-argument"
    );
  });
});

describe("recordTripSettlementCore - occurredAt contract", () => {
  it("accepts an explicit-timezone ISO instant with a trailing Z", async () => {
    await seedTrip();
    await recordTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseSettlementRequest({ occurredAt: "2027-01-01T00:00:00Z" })
    );
  });

  it("accepts an explicit-timezone ISO instant with a numeric offset", async () => {
    await seedTrip();
    await recordTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseSettlementRequest({ occurredAt: "2027-01-01T01:00:00+01:00" })
    );
  });

  it("rejects a date-only ISO string with no time/timezone", async () => {
    await seedTrip();
    await assertRejectsWithCode(
      recordTripSettlementCore(
        db,
        OTHER_MEMBER_UID,
        baseSettlementRequest({ occurredAt: "2027-01-01" })
      ),
      "invalid-argument"
    );
  });

  it("rejects a timezone-less local date-time string", async () => {
    await seedTrip();
    await assertRejectsWithCode(
      recordTripSettlementCore(
        db,
        OTHER_MEMBER_UID,
        baseSettlementRequest({ occurredAt: "2027-01-01T00:00:00" })
      ),
      "invalid-argument"
    );
  });

  it("rejects a locale-formatted date", async () => {
    await seedTrip();
    await assertRejectsWithCode(
      recordTripSettlementCore(
        db,
        OTHER_MEMBER_UID,
        baseSettlementRequest({ occurredAt: "January 1, 2027" })
      ),
      "invalid-argument"
    );
  });

  it("persists occurredAt as a Firestore Timestamp representing the exact supplied instant", async () => {
    await seedTrip();
    const result = await recordTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseSettlementRequest({ occurredAt: "2027-03-15T12:30:00.000Z" })
    );
    const data = await getSettlement(result.settlementId);
    assert.ok(data?.occurredAt);
    assert.equal(
      data?.occurredAt.toMillis(),
      Date.parse("2027-03-15T12:30:00.000Z")
    );
  });

  it("omitted occurredAt succeeds and persists NO occurredAt field (the 4E MVP manual UI's own contract)", async () => {
    await seedTrip();
    const result = await recordTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseSettlementRequest()
    );
    const data = await getSettlement(result.settlementId);
    assert.equal("occurredAt" in (data ?? {}), false);
    assert.equal(data?.creationRequest.occurredAtInstantMs, null);
  });
});

describe("recordTripSettlementCore - Trip state", () => {
  it("missing Trip -> not-found", async () => {
    await assertRejectsWithCode(
      recordTripSettlementCore(db, OTHER_MEMBER_UID, baseSettlementRequest()),
      "not-found"
    );
  });

  it("archived Trip STILL succeeds (Checkpoint 4E preflight §9/§10 - deliberately different from recordTripExpense)", async () => {
    await seedTrip({ archivedAt: new Date(), archivedBy: OWNER_UID });
    const result = await recordTripSettlementCore(
      db,
      OTHER_MEMBER_UID,
      baseSettlementRequest()
    );
    assert.ok(result.settlementId.length > 0);
  });
});

describe("recordTripSettlementCore - persistence isolation", () => {
  it("does not write to tripExpenses/tripExpenseSplits/buckets/savingsTransactions - no cached balance anywhere", async () => {
    await seedTrip();
    await recordTripSettlementCore(db, OTHER_MEMBER_UID, baseSettlementRequest());

    for (const name of [
      "tripExpenses",
      "tripExpenseSplits",
      "buckets",
      "savingsTransactions",
    ]) {
      const snap = await db.collection(name).get();
      assert.equal(snap.size, 0, `expected ${name} to remain empty`);
    }
  });

  it("does not write any balance/debt field onto the Trip document itself", async () => {
    await seedTrip();
    await recordTripSettlementCore(db, OTHER_MEMBER_UID, baseSettlementRequest());

    const tripSnap = await db.collection("trips").doc(TRIP_ID).get();
    const tripData = tripSnap.data() as FirebaseFirestore.DocumentData;
    assert.equal("balanceMinor" in tripData, false);
    assert.equal("debtMinor" in tripData, false);
  });
});

describe("recordTripSettlementCore - same-id concurrency", () => {
  it("concurrent identical requests from the same caller resolve to the same Settlement with no duplicate writes", async () => {
    await seedTrip();
    const request = baseSettlementRequest();

    const [r1, r2] = await Promise.all([
      recordTripSettlementCore(db, OTHER_MEMBER_UID, request),
      recordTripSettlementCore(db, OTHER_MEMBER_UID, request),
    ]);

    assert.equal(r1.settlementId, r2.settlementId);
    const snap = await db.collection("tripSettlements").get();
    assert.equal(snap.size, 1);
  });

  it("concurrent same-caller requests with different facts leave exactly one committed Settlement; the loser sees already-exists", async () => {
    await seedTrip();
    const clientRequestId = randomUUID();
    const reqA = baseSettlementRequest({ clientRequestId, amountMinor: 4000 });
    const reqB = baseSettlementRequest({ clientRequestId, amountMinor: 8000 });

    const results = await Promise.allSettled([
      recordTripSettlementCore(db, OTHER_MEMBER_UID, reqA),
      recordTripSettlementCore(db, OTHER_MEMBER_UID, reqB),
    ]);

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<{ settlementId: string }> =>
        r.status === "fulfilled"
    );
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected"
    );
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]!.reason instanceof HttpsError);
    assert.equal((rejected[0]!.reason as HttpsError).code, "already-exists");

    const snap = await db.collection("tripSettlements").get();
    assert.equal(snap.size, 1);
    const winningAmount = snap.docs[0]!.data().amountMinor;
    assert.ok(winningAmount === 4000 || winningAmount === 8000);
  });
});

// Checkpoint 4E.2A hardening: creationRequestsMatch now requires the
// STORED snapshot to be canonically well-formed before comparing it at
// all - a malformed/corrupted stored creationRequest (however it came to
// exist; tripSettlements has never been deployed, so this always
// represents tampering or a hypothetical future bug, never a legitimate
// legacy shape) must never accidentally count as an exact replay, even
// when every individual field happens to superficially agree with the
// incoming request. Each test below: records a genuine Settlement via
// the real callable, directly corrupts its stored creationRequest via
// the Admin SDK (bypassing the trusted callable entirely - the only way
// to construct this otherwise-unreachable state), then attempts an
// exact-facts replay and asserts it is rejected already-exists (never a
// successful replay) with the corrupted document left byte-for-byte
// unchanged.
describe("recordTripSettlementCore - strict canonical creationRequest replay shape (Checkpoint 4E.2A)", () => {
  async function seedAndCorrupt(
    corrupt: (cr: Record<string, unknown>) => Record<string, unknown>
  ): Promise<{ clientRequestId: string; request: Record<string, unknown> }> {
    await seedTrip();
    const clientRequestId = randomUUID();
    const request = baseSettlementRequest({ clientRequestId });
    await recordTripSettlementCore(db, OTHER_MEMBER_UID, request);

    const ref = db.collection("tripSettlements").doc(clientRequestId);
    const stored = (await ref.get()).data() as FirebaseFirestore.DocumentData;
    await ref.update({
      creationRequest: corrupt({ ...stored.creationRequest }),
    });

    return { clientRequestId, request };
  }

  async function assertReplayRejectedAndUnchanged(
    clientRequestId: string,
    request: Record<string, unknown>
  ): Promise<void> {
    const ref = db.collection("tripSettlements").doc(clientRequestId);
    const before = (await ref.get()).data();

    await assertRejectsWithCode(
      recordTripSettlementCore(db, OTHER_MEMBER_UID, request),
      "already-exists"
    );

    const after = (await ref.get()).data();
    assert.deepEqual(after, before);
  }

  it("missing note key -> already-exists, never a successful replay", async () => {
    const { clientRequestId, request } = await seedAndCorrupt((cr) => {
      delete cr.note;
      return cr;
    });
    await assertReplayRejectedAndUnchanged(clientRequestId, request);
  });

  it("missing occurredAtInstantMs key -> already-exists, never a successful replay", async () => {
    const { clientRequestId, request } = await seedAndCorrupt((cr) => {
      delete cr.occurredAtInstantMs;
      return cr;
    });
    await assertReplayRejectedAndUnchanged(clientRequestId, request);
  });

  it("an extra, unexpected key -> already-exists, never a successful replay", async () => {
    const { clientRequestId, request } = await seedAndCorrupt((cr) => {
      cr.extra = "surprise";
      return cr;
    });
    await assertReplayRejectedAndUnchanged(clientRequestId, request);
  });

  it("wrong type for occurredAtInstantMs (a string, not null/a number) -> already-exists", async () => {
    const { clientRequestId, request } = await seedAndCorrupt((cr) => {
      cr.occurredAtInstantMs = "not-a-number";
      return cr;
    });
    await assertReplayRejectedAndUnchanged(clientRequestId, request);
  });

  it("malformed/blank fromUid -> already-exists, never a successful replay", async () => {
    const { clientRequestId, request } = await seedAndCorrupt((cr) => {
      cr.fromUid = "   ";
      return cr;
    });
    await assertReplayRejectedAndUnchanged(clientRequestId, request);
  });

  it("malformed (negative) amountMinor -> already-exists, never a successful replay", async () => {
    const { clientRequestId, request } = await seedAndCorrupt((cr) => {
      cr.amountMinor = -100;
      return cr;
    });
    await assertReplayRejectedAndUnchanged(clientRequestId, request);
  });

  it("invalid method (not on the SettlementMethod allowlist) -> already-exists", async () => {
    const { clientRequestId, request } = await seedAndCorrupt((cr) => {
      cr.method = "bitcoin";
      return cr;
    });
    await assertReplayRejectedAndUnchanged(clientRequestId, request);
  });

  it("an untrimmed note -> already-exists (the canonical shape is always already-trimmed)", async () => {
    const { clientRequestId, request } = await seedAndCorrupt((cr) => {
      cr.note = " Trip settle-up ";
      return cr;
    });
    await assertReplayRejectedAndUnchanged(clientRequestId, request);
  });

  it("toUid identical to fromUid -> already-exists (a canonical creationRequest can never have equal fromUid/toUid)", async () => {
    const { clientRequestId, request } = await seedAndCorrupt((cr) => {
      cr.toUid = cr.fromUid;
      return cr;
    });
    await assertReplayRejectedAndUnchanged(clientRequestId, request);
  });
});
