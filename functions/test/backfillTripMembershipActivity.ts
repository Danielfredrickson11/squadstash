// Tests for the tripMembershipActivity backfill admin tool (Checkpoint
// 6.8D), against the local Firestore emulator via the Admin SDK - NEVER
// production. This tool is never exported/onCall-wrapped and is never
// invoked against production during this checkpoint; see
// functions/src/admin/backfillTripMembershipActivity.ts's own header.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import type { App } from "firebase-admin/app";
import { Timestamp, getFirestore } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import {
  PRODUCTION_PROJECT_ID,
  resolveExecutionTarget,
  runTripMembershipActivityBackfill,
} from "../src/admin/backfillTripMembershipActivity";
import {
  historyTrackingStartedActivityId,
  tripCreatedActivityId,
  invitationCreatedActivityId,
} from "../src/domain/tripMembershipActivity";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "FIRESTORE_EMULATOR_HOST is not set. Run these tests via " +
      '`firebase emulators:exec --only firestore "npm --prefix functions test"` ' +
      "so the Admin SDK talks to the local emulator, never production."
  );
}

const OWNER_UID = "owner-uid";
const MEMBER_UID = "member-uid";
const TRIP_ID = "test-trip";

let app: App;
let db: Firestore;

before(() => {
  app = initializeApp({
    projectId: "demo-squadstash-functions-test-backfill-activity",
  });
  db = getFirestore(app);
});

after(async () => {
  await deleteApp(app);
});

async function clearFirestore(): Promise<void> {
  for (const name of ["trips", "tripMembershipActivity"]) {
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
  const data: Record<string, unknown> = {
    ownerId: OWNER_UID,
    memberIds: [OWNER_UID, MEMBER_UID],
    title: "Test Trip",
    target: 1000,
    saved: 0,
    imageUrl: "https://example.com/trip.jpg",
    tripStartDate: "2027-06-12",
    ...overrides,
  };
  for (const key of Object.keys(data)) {
    if (data[key] === undefined) {
      delete data[key];
    }
  }
  return db.collection("trips").doc(TRIP_ID).set(data);
}

async function seedTripCreatedActivity(): Promise<void> {
  await db
    .collection("tripMembershipActivity")
    .doc(tripCreatedActivityId(TRIP_ID))
    .create({
      tripId: TRIP_ID,
      type: "trip_created",
      actorUid: OWNER_UID,
      targetUid: OWNER_UID,
      schemaVersion: 1,
      createdAt: Timestamp.now(),
    });
}

async function seedGenuineInvitationCreatedActivity(): Promise<void> {
  await db
    .collection("tripMembershipActivity")
    .doc(invitationCreatedActivityId(TRIP_ID, "invitee-uid"))
    .create({
      tripId: TRIP_ID,
      type: "invitation_created",
      actorUid: OWNER_UID,
      targetUid: "invitee-uid",
      invitationId: `${TRIP_ID}_invitee-uid`,
      schemaVersion: 1,
      createdAt: Timestamp.now(),
    });
}

async function getMarkerDoc(): Promise<FirebaseFirestore.DocumentData | undefined> {
  const snap = await db
    .collection("tripMembershipActivity")
    .doc(historyTrackingStartedActivityId(TRIP_ID))
    .get();
  return snap.data();
}

describe("runTripMembershipActivityBackfill - dry run", () => {
  it("an eligible pre-cutover Trip reports would_initialize and makes no write", async () => {
    await seedTrip();
    const result = await runTripMembershipActivityBackfill(db, TRIP_ID, "dry_run");
    assert.equal(result.status, "would_initialize");
    assert.equal(result.wouldWrite, true);
    assert.equal(result.tripTitle, "Test Trip");
    assert.equal(await getMarkerDoc(), undefined);
  });

  it("legitimate existing real activity does NOT block eligibility", async () => {
    await seedTrip();
    await seedGenuineInvitationCreatedActivity();
    const result = await runTripMembershipActivityBackfill(db, TRIP_ID, "dry_run");
    assert.equal(result.status, "would_initialize");
  });

  it("dry-run never writes even when the Trip is otherwise eligible", async () => {
    await seedTrip();
    await runTripMembershipActivityBackfill(db, TRIP_ID, "dry_run");
    const snap = await db.collection("tripMembershipActivity").get();
    assert.equal(snap.size, 0);
  });
});

describe("runTripMembershipActivityBackfill - apply", () => {
  it("writes exactly one correct marker for an eligible Trip", async () => {
    await seedTrip();
    const before = Date.now();
    const result = await runTripMembershipActivityBackfill(db, TRIP_ID, "apply");
    assert.equal(result.status, "initialized");

    const marker = await getMarkerDoc();
    assert.ok(marker, "expected a marker document to exist");
    assert.equal(marker!.tripId, TRIP_ID);
    assert.equal(marker!.type, "history_tracking_started");
    assert.equal(marker!.actorUid, null);
    assert.equal(marker!.targetUid, null);
    assert.equal(marker!.schemaVersion, 1);
    assert.ok(marker!.createdAt instanceof Timestamp);
    assert.ok((marker!.createdAt as Timestamp).toMillis() >= before);
    assert.equal("id" in marker!, false);

    const snap = await db.collection("tripMembershipActivity").get();
    assert.equal(snap.size, 1);
    assert.equal(snap.docs[0].id, `history_tracking_started:${TRIP_ID}`);
  });

  it("apply also succeeds when legitimate real activity already exists", async () => {
    await seedTrip();
    await seedGenuineInvitationCreatedActivity();
    const result = await runTripMembershipActivityBackfill(db, TRIP_ID, "apply");
    assert.equal(result.status, "initialized");
    // Both the genuine activity and the new marker coexist.
    const snap = await db.collection("tripMembershipActivity").get();
    assert.equal(snap.size, 2);
  });
});

describe("runTripMembershipActivityBackfill - idempotency", () => {
  it("re-running apply after a valid marker exists reports already_completed with no second write", async () => {
    await seedTrip();
    const first = await runTripMembershipActivityBackfill(db, TRIP_ID, "apply");
    assert.equal(first.status, "initialized");
    const firstMarker = await getMarkerDoc();

    const second = await runTripMembershipActivityBackfill(db, TRIP_ID, "apply");
    assert.equal(second.status, "already_completed");
    assert.equal(second.wouldWrite, false);

    const secondMarker = await getMarkerDoc();
    assert.ok(
      (firstMarker!.createdAt as Timestamp).isEqual(secondMarker!.createdAt as Timestamp),
      "re-running must not touch the original marker's createdAt"
    );
    const snap = await db.collection("tripMembershipActivity").get();
    assert.equal(snap.size, 1);
  });

  it("dry-run also reports already_completed once a valid marker exists", async () => {
    await seedTrip();
    await runTripMembershipActivityBackfill(db, TRIP_ID, "apply");
    const result = await runTripMembershipActivityBackfill(db, TRIP_ID, "dry_run");
    assert.equal(result.status, "already_completed");
    assert.equal(result.wouldWrite, false);
  });
});

describe("runTripMembershipActivityBackfill - post-cutover protection", () => {
  it("a Trip with a genuine trip_created activity is refused in dry-run", async () => {
    await seedTrip();
    await seedTripCreatedActivity();
    const result = await runTripMembershipActivityBackfill(db, TRIP_ID, "dry_run");
    assert.equal(result.status, "not_eligible_post_cutover");
    assert.equal(result.tripCreatedActivityExists, true);
  });

  it("a Trip with a genuine trip_created activity is refused in apply, and no marker is ever added", async () => {
    await seedTrip();
    await seedTripCreatedActivity();
    const result = await runTripMembershipActivityBackfill(db, TRIP_ID, "apply");
    assert.equal(result.status, "not_eligible_post_cutover");
    assert.equal(await getMarkerDoc(), undefined);
    const snap = await db.collection("tripMembershipActivity").get();
    assert.equal(snap.size, 1); // only the pre-seeded trip_created, nothing added
  });
});

describe("runTripMembershipActivityBackfill - malformed existing marker fails closed", () => {
  it("dry-run reports blocked_malformed and never overwrites it", async () => {
    await seedTrip();
    await db
      .collection("tripMembershipActivity")
      .doc(historyTrackingStartedActivityId(TRIP_ID))
      .set({ tripId: TRIP_ID, type: "history_tracking_started" }); // missing required fields
    const result = await runTripMembershipActivityBackfill(db, TRIP_ID, "dry_run");
    assert.equal(result.status, "blocked_malformed");
    assert.equal(result.existingMarkerExists, true);
  });

  it("apply reports blocked_malformed and never overwrites it", async () => {
    await seedTrip();
    const malformed = { tripId: TRIP_ID, type: "history_tracking_started" };
    await db
      .collection("tripMembershipActivity")
      .doc(historyTrackingStartedActivityId(TRIP_ID))
      .set(malformed);
    const result = await runTripMembershipActivityBackfill(db, TRIP_ID, "apply");
    assert.equal(result.status, "blocked_malformed");
    const after = await getMarkerDoc();
    assert.deepEqual(after, malformed);
  });
});

describe("runTripMembershipActivityBackfill - missing/malformed Trip", () => {
  it("a nonexistent Trip is refused with missing_trip", async () => {
    const result = await runTripMembershipActivityBackfill(db, TRIP_ID, "dry_run");
    assert.equal(result.status, "missing_trip");
  });

  it("a Trip with a missing/malformed ownerId is refused with blocked_malformed", async () => {
    await seedTrip({ ownerId: undefined });
    const result = await runTripMembershipActivityBackfill(db, TRIP_ID, "dry_run");
    assert.equal(result.status, "blocked_malformed");
  });

  it("a Trip with a malformed (non-array) memberIds is refused with blocked_malformed", async () => {
    await seedTrip({ memberIds: "not-a-list" });
    const result = await runTripMembershipActivityBackfill(db, TRIP_ID, "dry_run");
    assert.equal(result.status, "blocked_malformed");
  });

  // Checkpoint 6.8D1 §2: memberIds entries must each be a non-empty
  // string - modestly strengthened from "just an array."
  it("a Trip with a non-string memberIds entry is refused with blocked_malformed", async () => {
    await seedTrip({ memberIds: [OWNER_UID, 123] });
    const result = await runTripMembershipActivityBackfill(db, TRIP_ID, "dry_run");
    assert.equal(result.status, "blocked_malformed");
  });

  it("a Trip with an empty-string memberIds entry is refused with blocked_malformed", async () => {
    await seedTrip({ memberIds: [OWNER_UID, ""] });
    const result = await runTripMembershipActivityBackfill(db, TRIP_ID, "dry_run");
    assert.equal(result.status, "blocked_malformed");
  });
});

// Checkpoint 6.8D1 §1/§3: the apply TRANSACTION itself must
// independently revalidate the Trip - never rely on the earlier,
// non-transactional preflight read for write safety. These two tests
// are deliberately constructed to avoid a brittle timer-based race:
// each starts the apply call (which issues its own first read
// immediately, synchronously, before anything else in this test runs),
// then performs ONE awaited, fully-committed direct mutation to the
// Trip document, and only THEN awaits the apply call's own result. The
// production code path necessarily performs at least two FURTHER
// sequential awaited round trips (tripCreatedRef.get(), markerRef.get())
// after its own first read and before the transaction's own tx.get(
// tripRef) ever runs - by the time that transactional read executes,
// this test's single already-committed mutation is unambiguously
// visible (Firestore's emulator is strongly consistent), regardless of
// real wall-clock scheduling. This is a deterministic causal-ordering
// argument, not a timing-dependent guess.
describe("runTripMembershipActivityBackfill - 6.8D1: the apply transaction itself revalidates the Trip", () => {
  it("refuses (missing_trip) and writes no marker when the Trip is deleted after the preflight checks already passed", async () => {
    await seedTrip();
    const applyPromise = runTripMembershipActivityBackfill(db, TRIP_ID, "apply");
    await db.collection("trips").doc(TRIP_ID).delete();
    const result = await applyPromise;
    assert.equal(result.status, "missing_trip");
    assert.equal(await getMarkerDoc(), undefined);
  });

  it("refuses (blocked_malformed) and writes no marker when the Trip becomes malformed after the preflight checks already passed", async () => {
    await seedTrip();
    const applyPromise = runTripMembershipActivityBackfill(db, TRIP_ID, "apply");
    await db.collection("trips").doc(TRIP_ID).update({ ownerId: "" });
    const result = await applyPromise;
    assert.equal(result.status, "blocked_malformed");
    assert.equal(await getMarkerDoc(), undefined);
  });
});

describe("resolveExecutionTarget - CLI safety", () => {
  it("rejects when no emulator host is set and --project is missing", () => {
    const target = resolveExecutionTarget({
      emulatorHost: undefined,
      tripId: TRIP_ID,
      mode: "dry_run",
      projectFlag: undefined,
      confirmFlag: undefined,
    });
    assert.equal(target.ok, false);
  });

  it("rejects an unexpected (wrong) --project", () => {
    const target = resolveExecutionTarget({
      emulatorHost: undefined,
      tripId: TRIP_ID,
      mode: "dry_run",
      projectFlag: "some-other-project",
      confirmFlag: undefined,
    });
    assert.equal(target.ok, false);
  });

  it("accepts the exact production project id for dry-run with no confirm required", () => {
    const target = resolveExecutionTarget({
      emulatorHost: undefined,
      tripId: TRIP_ID,
      mode: "dry_run",
      projectFlag: PRODUCTION_PROJECT_ID,
      confirmFlag: undefined,
    });
    assert.equal(target.ok, true);
  });

  it("rejects apply mode against production without --confirm", () => {
    const target = resolveExecutionTarget({
      emulatorHost: undefined,
      tripId: TRIP_ID,
      mode: "apply",
      projectFlag: PRODUCTION_PROJECT_ID,
      confirmFlag: undefined,
    });
    assert.equal(target.ok, false);
  });

  it("rejects apply mode against production with an incorrect --confirm", () => {
    const target = resolveExecutionTarget({
      emulatorHost: undefined,
      tripId: TRIP_ID,
      mode: "apply",
      projectFlag: PRODUCTION_PROJECT_ID,
      confirmFlag: "wrong-trip-id",
    });
    assert.equal(target.ok, false);
  });

  it("accepts apply mode against production with the exact --confirm echo", () => {
    const target = resolveExecutionTarget({
      emulatorHost: undefined,
      tripId: TRIP_ID,
      mode: "apply",
      projectFlag: PRODUCTION_PROJECT_ID,
      confirmFlag: TRIP_ID,
    });
    assert.equal(target.ok, true);
  });

  it("always accepts when an emulator host is set, regardless of --project", () => {
    const target = resolveExecutionTarget({
      emulatorHost: "localhost:8080",
      tripId: TRIP_ID,
      mode: "apply",
      projectFlag: undefined,
      confirmFlag: undefined,
    });
    assert.equal(target.ok, true);
    if (target.ok) {
      assert.equal(target.mode, "emulator");
    }
  });
});

describe("runTripMembershipActivityBackfill - concurrency", () => {
  it("two simultaneous apply attempts never create conflicting/duplicate markers", async () => {
    await seedTrip();
    const [first, second] = await Promise.all([
      runTripMembershipActivityBackfill(db, TRIP_ID, "apply"),
      runTripMembershipActivityBackfill(db, TRIP_ID, "apply"),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, ["already_completed", "initialized"]);

    const snap = await db.collection("tripMembershipActivity").get();
    assert.equal(snap.size, 1);
  });
});
