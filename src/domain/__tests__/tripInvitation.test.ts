import {
  canCancelTripInvitation,
  canRespondToTripInvitation,
  isPendingTripInvitation,
  isTripInvitationExpired,
} from "../tripInvitation";
import type { TripInvitation } from "../../types/domain/tripInvitation";

// A minimal fake PersistedTimestamp - these pure functions only ever
// call .toDate() on one, so a real Firebase Timestamp instance is never
// needed here (keeping this test file free of any Firestore import,
// matching the production file it tests).
function fakeTimestamp(date: Date) {
  return { toDate: () => date } as unknown as TripInvitation["expiresAt"];
}

function baseInvitation(overrides: Partial<TripInvitation> = {}): TripInvitation {
  return {
    id: "trip-1_invitee-uid",
    tripId: "trip-1",
    inviterUid: "owner-uid",
    inviteeEmail: "friend@example.com",
    inviteeUid: "invitee-uid",
    status: "pending",
    createdAt: fakeTimestamp(new Date("2027-01-01T00:00:00Z")),
    expiresAt: fakeTimestamp(new Date("2027-01-15T00:00:00Z")),
    respondedAt: null,
    ...overrides,
  };
}

describe("isPendingTripInvitation", () => {
  it("is true for a pending invitation", () => {
    expect(isPendingTripInvitation(baseInvitation())).toBe(true);
  });

  it.each(["accepted", "declined", "cancelled"] as const)(
    "is false for a %s invitation",
    (status) => {
      expect(isPendingTripInvitation(baseInvitation({ status }))).toBe(false);
    }
  );
});

describe("isTripInvitationExpired", () => {
  it("is false before expiresAt", () => {
    const invitation = baseInvitation();
    expect(isTripInvitationExpired(invitation, new Date("2027-01-10T00:00:00Z"))).toBe(
      false
    );
  });

  it("is true after expiresAt", () => {
    const invitation = baseInvitation();
    expect(isTripInvitationExpired(invitation, new Date("2027-01-20T00:00:00Z"))).toBe(
      true
    );
  });

  it("is true exactly at expiresAt", () => {
    const invitation = baseInvitation();
    expect(isTripInvitationExpired(invitation, new Date("2027-01-15T00:00:00Z"))).toBe(
      true
    );
  });
});

describe("canRespondToTripInvitation", () => {
  const now = new Date("2027-01-10T00:00:00Z");

  it("allows the invitee to respond to their own pending, unexpired invitation", () => {
    expect(canRespondToTripInvitation(baseInvitation(), "invitee-uid", now)).toBe(true);
  });

  it("denies a different uid", () => {
    expect(canRespondToTripInvitation(baseInvitation(), "someone-else", now)).toBe(
      false
    );
  });

  it("denies the Trip owner (not the invitee) from responding", () => {
    expect(canRespondToTripInvitation(baseInvitation(), "owner-uid", now)).toBe(false);
  });

  it("denies responding to an already-accepted invitation", () => {
    expect(
      canRespondToTripInvitation(
        baseInvitation({ status: "accepted" }),
        "invitee-uid",
        now
      )
    ).toBe(false);
  });

  it("denies responding to an expired invitation", () => {
    expect(
      canRespondToTripInvitation(
        baseInvitation(),
        "invitee-uid",
        new Date("2027-02-01T00:00:00Z")
      )
    ).toBe(false);
  });
});

describe("canCancelTripInvitation", () => {
  it("allows the Trip owner to cancel a pending invitation", () => {
    expect(canCancelTripInvitation(baseInvitation(), "owner-uid", "owner-uid")).toBe(
      true
    );
  });

  it("denies a non-owner (including the invitee) from cancelling", () => {
    expect(canCancelTripInvitation(baseInvitation(), "owner-uid", "invitee-uid")).toBe(
      false
    );
  });

  it("denies cancelling an invitation that is no longer pending", () => {
    expect(
      canCancelTripInvitation(
        baseInvitation({ status: "declined" }),
        "owner-uid",
        "owner-uid"
      )
    ).toBe(false);
  });
});
