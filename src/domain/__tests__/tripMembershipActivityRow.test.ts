// Tests for src/domain/tripMembershipActivityRow.ts (Checkpoint 6.8C) -
// pure row-view-model/copy-building logic, no React/Firestore needed.
import {
  HISTORY_TRACKING_STARTED_COPY,
  buildTripMembershipActivityRowViewModel,
  buildTripMembershipActivityRowViewModels,
  collectTripMembershipActivityProfileUids,
} from "../tripMembershipActivityRow";
import type { TripMembershipActivityEvent } from "../../types/domain";

// Mirrors savingsTransactions.test.ts's own FIXTURE_CREATED_AT
// convention - formatTransactionTimestamp only ever calls toDate(), so
// a plain object implementing that is sufficient; never a real
// Firestore Timestamp instance.
function fixtureTimestamp(isoString: string) {
  const date = new Date(isoString);
  return { toDate: () => date };
}

const CREATED_AT = fixtureTimestamp("2026-11-10T15:30:00Z");

function baseEvent(
  overrides: Partial<TripMembershipActivityEvent> = {}
): TripMembershipActivityEvent {
  return {
    id: "activity-1",
    tripId: "trip-1",
    type: "trip_created",
    actorUid: "owner-1",
    targetUid: "owner-1",
    createdAt: CREATED_AT as never,
    schemaVersion: 1,
    ...overrides,
  } as TripMembershipActivityEvent;
}

const PROFILES = new Map([
  ["owner-1", { uid: "owner-1", displayName: "Daniel", photoURL: "https://example.com/d.jpg" }],
  ["invitee-1", { uid: "invitee-1", displayName: "Alex", photoURL: "" }],
]);

describe("buildTripMembershipActivityRowViewModel - copy per event type", () => {
  it("trip_created: '{actor} created the Trip'", () => {
    const row = buildTripMembershipActivityRowViewModel(baseEvent(), PROFILES);
    expect(row.copy).toBe("Daniel created the Trip");
  });

  it("invitation_created: '{actor} invited {target}'", () => {
    const row = buildTripMembershipActivityRowViewModel(
      baseEvent({
        type: "invitation_created",
        actorUid: "owner-1",
        targetUid: "invitee-1",
        invitationId: "trip-1_invitee-1",
      } as Partial<TripMembershipActivityEvent>),
      PROFILES
    );
    expect(row.copy).toBe("Daniel invited Alex");
  });

  it("invitation_accepted: '{actor} joined the Trip' (never 'accepted invitation')", () => {
    const row = buildTripMembershipActivityRowViewModel(
      baseEvent({
        type: "invitation_accepted",
        actorUid: "invitee-1",
        targetUid: "invitee-1",
        invitationId: "trip-1_invitee-1",
      } as Partial<TripMembershipActivityEvent>),
      PROFILES
    );
    expect(row.copy).toBe("Alex joined the Trip");
    expect(row.copy).not.toMatch(/accepted/i);
  });

  it("invitation_declined: '{actor} declined the invitation'", () => {
    const row = buildTripMembershipActivityRowViewModel(
      baseEvent({
        type: "invitation_declined",
        actorUid: "invitee-1",
        targetUid: "invitee-1",
        invitationId: "trip-1_invitee-1",
      } as Partial<TripMembershipActivityEvent>),
      PROFILES
    );
    expect(row.copy).toBe("Alex declined the invitation");
  });

  it("invitation_cancelled: \"{actor} cancelled {target}'s invitation\"", () => {
    const row = buildTripMembershipActivityRowViewModel(
      baseEvent({
        type: "invitation_cancelled",
        actorUid: "owner-1",
        targetUid: "invitee-1",
        invitationId: "trip-1_invitee-1",
      } as Partial<TripMembershipActivityEvent>),
      PROFILES
    );
    expect(row.copy).toBe("Daniel cancelled Alex's invitation");
  });

  it("member_left: '{actor} left the Trip'", () => {
    const row = buildTripMembershipActivityRowViewModel(
      baseEvent({ type: "member_left", actorUid: "invitee-1", targetUid: "invitee-1" }),
      PROFILES
    );
    expect(row.copy).toBe("Alex left the Trip");
  });

  it("member_removed: '{actor} removed {target} from the Trip'", () => {
    const row = buildTripMembershipActivityRowViewModel(
      baseEvent({ type: "member_removed", actorUid: "owner-1", targetUid: "invitee-1" }),
      PROFILES
    );
    expect(row.copy).toBe("Daniel removed Alex from the Trip");
  });

  it("history_tracking_started: the exact approved boundary-marker copy, never 'starts here'", () => {
    const row = buildTripMembershipActivityRowViewModel(
      baseEvent({ type: "history_tracking_started", actorUid: null, targetUid: null }),
      PROFILES
    );
    expect(row.copy).toBe(HISTORY_TRACKING_STARTED_COPY);
    expect(row.copy).toBe(
      "Complete membership activity is tracked from this point forward."
    );
    expect(row.copy.toLowerCase()).not.toContain("starts here");
  });
});

describe("buildTripMembershipActivityRowViewModel - row shape", () => {
  it("a real event's row is kind 'event' and carries actor identity/avatar fields", () => {
    const row = buildTripMembershipActivityRowViewModel(baseEvent(), PROFILES);
    expect(row.kind).toBe("event");
    if (row.kind === "event") {
      expect(row.actorUid).toBe("owner-1");
      expect(row.actorNameLabel).toBe("Daniel");
      expect(row.actorPhotoURL).toBe("https://example.com/d.jpg");
    }
  });

  it("the system marker's row is kind 'system' and never pretends to have an actor", () => {
    const row = buildTripMembershipActivityRowViewModel(
      baseEvent({ type: "history_tracking_started", actorUid: null, targetUid: null }),
      PROFILES
    );
    expect(row.kind).toBe("system");
    expect("actorUid" in row).toBe(false);
    expect("actorNameLabel" in row).toBe(false);
  });

  it("an empty-string photoURL is treated as absent (never rendered as a broken image)", () => {
    const row = buildTripMembershipActivityRowViewModel(
      baseEvent({ actorUid: "invitee-1", targetUid: "invitee-1" }),
      PROFILES
    );
    expect(row.kind).toBe("event");
    if (row.kind === "event") {
      expect(row.actorPhotoURL).toBeUndefined();
    }
  });

  it("every row carries a non-empty formatted timestampLabel", () => {
    const row = buildTripMembershipActivityRowViewModel(baseEvent(), PROFILES);
    expect(typeof row.timestampLabel).toBe("string");
    expect(row.timestampLabel.length).toBeGreaterThan(0);
  });
});

describe("buildTripMembershipActivityRowViewModel - missing-profile fallback", () => {
  it("falls back to 'Trip member' for an unresolved actor", () => {
    const row = buildTripMembershipActivityRowViewModel(
      baseEvent({ actorUid: "unknown-uid", targetUid: "unknown-uid" }),
      PROFILES
    );
    expect(row.copy).toBe("Trip member created the Trip");
  });

  it("falls back for BOTH actor and target when neither resolves, remaining readable", () => {
    const row = buildTripMembershipActivityRowViewModel(
      baseEvent({
        type: "member_removed",
        actorUid: "unknown-owner",
        targetUid: "unknown-target",
      }),
      PROFILES
    );
    expect(row.copy).toBe("Trip member removed Trip member from the Trip");
  });

  it("falls back when the profiles map is entirely empty", () => {
    const row = buildTripMembershipActivityRowViewModel(baseEvent(), new Map());
    expect(row.copy).toBe("Trip member created the Trip");
  });

  it("falls back when a resolved profile has a blank/whitespace-only displayName", () => {
    const profiles = new Map([["owner-1", { uid: "owner-1", displayName: "   ", photoURL: "" }]]);
    const row = buildTripMembershipActivityRowViewModel(baseEvent(), profiles);
    expect(row.copy).toBe("Trip member created the Trip");
  });
});

describe("buildTripMembershipActivityRowViewModels - ordering", () => {
  it("preserves the input order exactly, never re-sorting", () => {
    const events = [
      baseEvent({ id: "a" }),
      baseEvent({ id: "b", type: "member_left", actorUid: "invitee-1", targetUid: "invitee-1" }),
    ];
    const rows = buildTripMembershipActivityRowViewModels(events, PROFILES);
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("returns an empty array for an empty input", () => {
    expect(buildTripMembershipActivityRowViewModels([], PROFILES)).toEqual([]);
  });
});

describe("collectTripMembershipActivityProfileUids", () => {
  it("collects and deduplicates actorUid/targetUid across events", () => {
    const events = [
      baseEvent({ id: "a", actorUid: "owner-1", targetUid: "owner-1" }),
      baseEvent({
        id: "b",
        type: "invitation_created",
        actorUid: "owner-1",
        targetUid: "invitee-1",
      } as Partial<TripMembershipActivityEvent>),
    ];
    const uids = collectTripMembershipActivityProfileUids(events);
    expect(new Set(uids)).toEqual(new Set(["owner-1", "invitee-1"]));
    expect(uids.filter((u) => u === "owner-1")).toHaveLength(1);
  });

  it("contributes nothing for a history_tracking_started event (both fields null)", () => {
    const events = [
      baseEvent({ id: "sys", type: "history_tracking_started", actorUid: null, targetUid: null }),
    ];
    expect(collectTripMembershipActivityProfileUids(events)).toEqual([]);
  });

  it("returns an empty array for an empty input", () => {
    expect(collectTripMembershipActivityProfileUids([])).toEqual([]);
  });
});
