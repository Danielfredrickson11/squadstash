// Tests for the pure Trip membership-activity domain primitives
// (Checkpoint 6.8B1). No Firestore emulator needed - pure logic only.
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {HttpsError} from "firebase-functions/v2/https";
import {
  buildHistoryTrackingStartedActivity,
  buildInvitationAcceptedActivity,
  buildInvitationCancelledActivity,
  buildInvitationCreatedActivity,
  buildInvitationDeclinedActivity,
  buildMemberDepartureActivity,
  buildTripCreatedActivity,
  historyTrackingStartedActivityId,
  invitationAcceptedActivityId,
  invitationCancelledActivityId,
  invitationCreatedActivityId,
  invitationDeclinedActivityId,
  isWellFormedTripMembershipActivityDocumentData,
  isWellFormedTripMembershipActivityEvent,
  memberLeftActivityId,
  memberRemovedActivityId,
  tripCreatedActivityId,
} from "../src/domain/tripMembershipActivity";

describe("tripCreatedActivityId", () => {
  it("builds the deterministic trip_created:{tripId} id", () => {
    assert.equal(tripCreatedActivityId("trip-1"), "trip_created:trip-1");
  });

  it("rejects an empty tripId", () => {
    assert.throws(
      () => tripCreatedActivityId(""),
      (err: unknown) => err instanceof HttpsError && err.code === "invalid-argument"
    );
  });
});

describe("historyTrackingStartedActivityId", () => {
  it("builds the deterministic history_tracking_started:{tripId} id", () => {
    assert.equal(
      historyTrackingStartedActivityId("trip-1"),
      "history_tracking_started:trip-1"
    );
  });

  it("rejects an empty tripId", () => {
    assert.throws(
      () => historyTrackingStartedActivityId(""),
      (err: unknown) => err instanceof HttpsError && err.code === "invalid-argument"
    );
  });
});

describe("invitationCreatedActivityId", () => {
  it("builds the deterministic invitation_created:{tripId}_{inviteeUid} id", () => {
    assert.equal(
      invitationCreatedActivityId("trip-1", "invitee-1"),
      "invitation_created:trip-1_invitee-1"
    );
  });

  it("rejects a tripId containing the delimiter (via the reused guard)", () => {
    assert.throws(
      () => invitationCreatedActivityId("trip_1", "invitee-1"),
      (err: unknown) => err instanceof HttpsError && err.code === "internal"
    );
  });
});

describe("invitationAcceptedActivityId", () => {
  it("builds the deterministic invitation_accepted:{tripId}_{uid}_{termsDocId} id", () => {
    assert.equal(
      invitationAcceptedActivityId("trip-1", "uid-1", "terms-1"),
      "invitation_accepted:trip-1_uid-1_terms-1"
    );
  });

  it("rejects a termsDocId containing the delimiter (via the reused tripMembershipAcceptanceId guard)", () => {
    assert.throws(
      () => invitationAcceptedActivityId("trip-1", "uid-1", "terms_1"),
      (err: unknown) => err instanceof HttpsError && err.code === "internal"
    );
  });
});

describe("invitationDeclinedActivityId / invitationCancelledActivityId", () => {
  it("both build the same {tripId}_{inviteeUid} authoritativeId, under their own event-type prefix", () => {
    assert.equal(
      invitationDeclinedActivityId("trip-1", "invitee-1"),
      "invitation_declined:trip-1_invitee-1"
    );
    assert.equal(
      invitationCancelledActivityId("trip-1", "invitee-1"),
      "invitation_cancelled:trip-1_invitee-1"
    );
  });

  it("never collide with each other for the same (tripId, inviteeUid)", () => {
    assert.notEqual(
      invitationDeclinedActivityId("trip-1", "invitee-1"),
      invitationCancelledActivityId("trip-1", "invitee-1")
    );
  });
});

describe("memberLeftActivityId / memberRemovedActivityId", () => {
  it("both build the same {tripId}_{uid} authoritativeId, under their own event-type prefix", () => {
    assert.equal(memberLeftActivityId("trip-1", "uid-1"), "member_left:trip-1_uid-1");
    assert.equal(
      memberRemovedActivityId("trip-1", "uid-1"),
      "member_removed:trip-1_uid-1"
    );
  });

  it("never collide with each other for the same (tripId, uid)", () => {
    assert.notEqual(
      memberLeftActivityId("trip-1", "uid-1"),
      memberRemovedActivityId("trip-1", "uid-1")
    );
  });
});

describe("cross-type id collision safety", () => {
  it("every event-type prefix is distinct and none is a prefix of another", () => {
    const ids = [
      tripCreatedActivityId("x"),
      invitationCreatedActivityId("x", "y"),
      invitationAcceptedActivityId("x", "y", "z"),
      invitationDeclinedActivityId("x", "y"),
      invitationCancelledActivityId("x", "y"),
      memberLeftActivityId("x", "y"),
      memberRemovedActivityId("x", "y"),
      historyTrackingStartedActivityId("x"),
    ];
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe("buildTripCreatedActivity", () => {
  it("actorUid and targetUid both equal ownerId; no invitationId field", () => {
    const write = buildTripCreatedActivity("trip-1", "owner-1");
    assert.equal(write.id, "trip_created:trip-1");
    assert.deepEqual(write.data, {
      tripId: "trip-1",
      type: "trip_created",
      actorUid: "owner-1",
      targetUid: "owner-1",
      schemaVersion: 1,
    });
    assert.equal("invitationId" in write.data, false);
  });
});

describe("buildInvitationCreatedActivity", () => {
  it("actorUid = inviterUid, targetUid = inviteeUid, invitationId present", () => {
    const write = buildInvitationCreatedActivity("trip-1", "owner-1", "invitee-1");
    assert.equal(write.id, "invitation_created:trip-1_invitee-1");
    assert.deepEqual(write.data, {
      tripId: "trip-1",
      type: "invitation_created",
      actorUid: "owner-1",
      targetUid: "invitee-1",
      invitationId: "trip-1_invitee-1",
      schemaVersion: 1,
    });
  });
});

describe("buildInvitationAcceptedActivity", () => {
  it("actorUid = targetUid = the accepting uid, invitationId present", () => {
    const write = buildInvitationAcceptedActivity("trip-1", "invitee-1", "terms-1");
    assert.equal(write.id, "invitation_accepted:trip-1_invitee-1_terms-1");
    assert.deepEqual(write.data, {
      tripId: "trip-1",
      type: "invitation_accepted",
      actorUid: "invitee-1",
      targetUid: "invitee-1",
      invitationId: "trip-1_invitee-1",
      schemaVersion: 1,
    });
  });
});

describe("buildInvitationDeclinedActivity", () => {
  it("actorUid = targetUid = the declining invitee, invitationId present", () => {
    const write = buildInvitationDeclinedActivity("trip-1", "invitee-1");
    assert.equal(write.id, "invitation_declined:trip-1_invitee-1");
    assert.deepEqual(write.data, {
      tripId: "trip-1",
      type: "invitation_declined",
      actorUid: "invitee-1",
      targetUid: "invitee-1",
      invitationId: "trip-1_invitee-1",
      schemaVersion: 1,
    });
  });
});

describe("buildInvitationCancelledActivity", () => {
  it("actorUid = the Trip owner, targetUid = the invitee, invitationId present", () => {
    const write = buildInvitationCancelledActivity("trip-1", "owner-1", "invitee-1");
    assert.equal(write.id, "invitation_cancelled:trip-1_invitee-1");
    assert.deepEqual(write.data, {
      tripId: "trip-1",
      type: "invitation_cancelled",
      actorUid: "owner-1",
      targetUid: "invitee-1",
      invitationId: "trip-1_invitee-1",
      schemaVersion: 1,
    });
  });
});

describe("buildMemberDepartureActivity", () => {
  it("\"left\": actorUid = targetUid = the departing uid; no invitationId", () => {
    const write = buildMemberDepartureActivity("trip-1", "left", "uid-1", "uid-1");
    assert.equal(write.id, "member_left:trip-1_uid-1");
    assert.deepEqual(write.data, {
      tripId: "trip-1",
      type: "member_left",
      actorUid: "uid-1",
      targetUid: "uid-1",
      schemaVersion: 1,
    });
    assert.equal("invitationId" in write.data, false);
  });

  it("\"removed\": actorUid = the owner (departedByUid), targetUid = the removed uid", () => {
    const write = buildMemberDepartureActivity(
      "trip-1",
      "removed",
      "owner-1",
      "removed-uid"
    );
    assert.equal(write.id, "member_removed:trip-1_removed-uid");
    assert.deepEqual(write.data, {
      tripId: "trip-1",
      type: "member_removed",
      actorUid: "owner-1",
      targetUid: "removed-uid",
      schemaVersion: 1,
    });
  });

  it("fails closed (never silently defaults to member_removed) for an unrecognized departureType value bypassing the compile-time guarantee", () => {
    assert.throws(
      () =>
        buildMemberDepartureActivity(
          "trip-1",
          "bogus" as never,
          "owner-1",
          "uid-1"
        ),
      (err: unknown) => err instanceof HttpsError && err.code === "internal"
    );
  });
});

describe("buildHistoryTrackingStartedActivity", () => {
  it("actorUid and targetUid are both null - never attributed to a human uid", () => {
    const write = buildHistoryTrackingStartedActivity("trip-1");
    assert.equal(write.id, "history_tracking_started:trip-1");
    assert.deepEqual(write.data, {
      tripId: "trip-1",
      type: "history_tracking_started",
      actorUid: null,
      targetUid: null,
      schemaVersion: 1,
    });
  });
});

describe("isWellFormedTripMembershipActivityDocumentData (Checkpoint 6.8B1R)", () => {
  it("accepts a well-formed trip_created document - WITHOUT an id field, exactly as snapshot.data() returns it", () => {
    const data = {
      tripId: "trip-1",
      type: "trip_created",
      actorUid: "owner-1",
      targetUid: "owner-1",
      schemaVersion: 1,
      createdAt: {/* a real Timestamp in production - opaque here */},
    };
    assert.equal("id" in data, false);
    assert.equal(isWellFormedTripMembershipActivityDocumentData(data), true);
  });

  it("accepts a well-formed invitation_accepted document (invitationId present)", () => {
    assert.equal(
      isWellFormedTripMembershipActivityDocumentData({
        tripId: "trip-1",
        type: "invitation_accepted",
        actorUid: "invitee-1",
        targetUid: "invitee-1",
        invitationId: "trip-1_invitee-1",
        schemaVersion: 1,
        createdAt: {},
      }),
      true
    );
  });

  it("accepts a well-formed history_tracking_started document (null actor/target)", () => {
    assert.equal(
      isWellFormedTripMembershipActivityDocumentData({
        tripId: "trip-1",
        type: "history_tracking_started",
        actorUid: null,
        targetUid: null,
        schemaVersion: 1,
        createdAt: {},
      }),
      true
    );
  });

  it("rejects null/non-object values", () => {
    assert.equal(isWellFormedTripMembershipActivityDocumentData(null), false);
    assert.equal(isWellFormedTripMembershipActivityDocumentData("string"), false);
    assert.equal(isWellFormedTripMembershipActivityDocumentData(undefined), false);
  });

  it("rejects a missing/empty tripId", () => {
    assert.equal(
      isWellFormedTripMembershipActivityDocumentData({
        tripId: "",
        type: "trip_created",
        actorUid: "owner-1",
        targetUid: "owner-1",
        schemaVersion: 1,
        createdAt: {},
      }),
      false
    );
  });

  it("rejects a missing createdAt (even though every other field is well-formed)", () => {
    assert.equal(
      isWellFormedTripMembershipActivityDocumentData({
        tripId: "trip-1",
        type: "trip_created",
        actorUid: "owner-1",
        targetUid: "owner-1",
        schemaVersion: 1,
        // createdAt deliberately omitted.
      }),
      false
    );
  });

  it("rejects an unknown type", () => {
    assert.equal(
      isWellFormedTripMembershipActivityDocumentData({
        tripId: "trip-1",
        type: "bogus_event",
        actorUid: "owner-1",
        targetUid: "owner-1",
        schemaVersion: 1,
        createdAt: {},
      }),
      false
    );
  });

  it("rejects invitation_expired and member_role_changed (never-approved types)", () => {
    for (const type of ["invitation_expired", "member_role_changed"]) {
      assert.equal(
        isWellFormedTripMembershipActivityDocumentData({
          tripId: "trip-1",
          type,
          actorUid: "owner-1",
          targetUid: "owner-1",
          schemaVersion: 1,
          createdAt: {},
        }),
        false
      );
    }
  });

  it("rejects a wrong schemaVersion", () => {
    assert.equal(
      isWellFormedTripMembershipActivityDocumentData({
        tripId: "trip-1",
        type: "trip_created",
        actorUid: "owner-1",
        targetUid: "owner-1",
        schemaVersion: 2,
        createdAt: {},
      }),
      false
    );
  });

  it("rejects a non-invitation event type that carries an invitationId", () => {
    assert.equal(
      isWellFormedTripMembershipActivityDocumentData({
        tripId: "trip-1",
        type: "trip_created",
        actorUid: "owner-1",
        targetUid: "owner-1",
        invitationId: "should-not-be-here",
        schemaVersion: 1,
        createdAt: {},
      }),
      false
    );
  });

  it("rejects an invitation event type missing its required invitationId", () => {
    assert.equal(
      isWellFormedTripMembershipActivityDocumentData({
        tripId: "trip-1",
        type: "invitation_created",
        actorUid: "owner-1",
        targetUid: "invitee-1",
        schemaVersion: 1,
        createdAt: {},
      }),
      false
    );
  });

  it("rejects a real event type with a null actorUid/targetUid", () => {
    assert.equal(
      isWellFormedTripMembershipActivityDocumentData({
        tripId: "trip-1",
        type: "trip_created",
        actorUid: null,
        targetUid: null,
        schemaVersion: 1,
        createdAt: {},
      }),
      false
    );
  });

  it("rejects history_tracking_started with a non-null actorUid/targetUid", () => {
    assert.equal(
      isWellFormedTripMembershipActivityDocumentData({
        tripId: "trip-1",
        type: "history_tracking_started",
        actorUid: "owner-1",
        targetUid: "owner-1",
        schemaVersion: 1,
        createdAt: {},
      }),
      false
    );
  });
});

describe("isWellFormedTripMembershipActivityEvent (hydrated - Checkpoint 6.8B1R)", () => {
  it("accepts a well-formed hydrated event (document-data fields PLUS a non-empty id)", () => {
    assert.equal(
      isWellFormedTripMembershipActivityEvent({
        id: "trip_created:trip-1",
        tripId: "trip-1",
        type: "trip_created",
        actorUid: "owner-1",
        targetUid: "owner-1",
        schemaVersion: 1,
        createdAt: {},
      }),
      true
    );
  });

  it("rejects an otherwise-well-formed document with a missing id - raw snapshot.data() alone is never a valid hydrated event", () => {
    assert.equal(
      isWellFormedTripMembershipActivityEvent({
        tripId: "trip-1",
        type: "trip_created",
        actorUid: "owner-1",
        targetUid: "owner-1",
        schemaVersion: 1,
        createdAt: {},
      }),
      false
    );
  });

  it("rejects an empty-string id", () => {
    assert.equal(
      isWellFormedTripMembershipActivityEvent({
        id: "",
        tripId: "trip-1",
        type: "trip_created",
        actorUid: "owner-1",
        targetUid: "owner-1",
        schemaVersion: 1,
        createdAt: {},
      }),
      false
    );
  });

  it("rejects a non-string id", () => {
    assert.equal(
      isWellFormedTripMembershipActivityEvent({
        id: 12345,
        tripId: "trip-1",
        type: "trip_created",
        actorUid: "owner-1",
        targetUid: "owner-1",
        schemaVersion: 1,
        createdAt: {},
      }),
      false
    );
  });

  it("still rejects an otherwise-malformed document even with a valid id present", () => {
    assert.equal(
      isWellFormedTripMembershipActivityEvent({
        id: "trip_created:trip-1",
        tripId: "trip-1",
        type: "trip_created",
        actorUid: "owner-1",
        targetUid: "owner-1",
        schemaVersion: 1,
        // createdAt deliberately omitted - still rejected.
      }),
      false
    );
  });
});
