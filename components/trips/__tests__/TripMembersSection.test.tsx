// Presentation/lifecycle tests for TripMembersSection (Checkpoint 6.1,
// extended by 6.2's Invite Member entry point). Mirrors components/
// balances/__tests__/BalanceRow.test.tsx's own react-test-renderer
// convention (no new test dependency, no @testing-library/react-native).
// This component now always mounts InviteTripMemberDialog (invisible
// unless opened), so its own Firebase/navigation/auth dependencies
// (fetchCurrentTripTerms, createTripInvitation, useRouter, useAuth) must
// be mocked here too, alongside subscribeToPublicUsersByIdsChunked -
// standard Jest unit-test technique, unrelated to this project's
// separate emulator/production integration-test surfaces (tests/
// integration/, functions/test/), which this file never touches.
import React from "react";
import { act, create } from "react-test-renderer";

import { TripMembersSection } from "../TripMembersSection";
import { subscribeToPublicUsersByIdsChunked } from "../../../src/services/firebase/users";
import { fetchCurrentTripTerms } from "../../../src/services/firebase/tripTerms";
import { createTripInvitation } from "../../../src/services/firebase/tripInvitations";
import { removeTripMember } from "../../../src/services/firebase/trips";
import type { PublicProfile, TripTerms } from "../../../src/types/domain";

jest.mock("../../../src/services/firebase/users", () => ({
  subscribeToPublicUsersByIdsChunked: jest.fn(),
}));

jest.mock("../../../src/services/firebase/tripTerms", () => ({
  fetchCurrentTripTerms: jest.fn(),
}));

jest.mock("../../../src/services/firebase/tripInvitations", () => ({
  createTripInvitation: jest.fn(),
}));

jest.mock("../../../src/services/firebase/trips", () => ({
  removeTripMember: jest.fn(),
}));

const mockPush = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockAuthUser: { uid: string; email: string } | null = {
  uid: "owner-1",
  email: "owner@example.com",
};
jest.mock("../../../src/contexts/AuthContext", () => ({
  useAuth: () => ({ user: mockAuthUser }),
}));

const mockedSubscribe = subscribeToPublicUsersByIdsChunked as jest.MockedFunction<
  typeof subscribeToPublicUsersByIdsChunked
>;
const mockedFetchTerms = fetchCurrentTripTerms as jest.MockedFunction<
  typeof fetchCurrentTripTerms
>;
const mockedCreateInvitation = createTripInvitation as jest.MockedFunction<
  typeof createTripInvitation
>;
const mockedRemoveTripMember = removeTripMember as jest.MockedFunction<typeof removeTripMember>;

type JsonNode = {
  props: Record<string, unknown>;
  children: (JsonNode | string)[] | null;
};
type Instance = { props: Record<string, unknown> };
type RootLike = { root: { findAllByProps: (props: Record<string, unknown>) => Instance[] } };

function collectText(node: JsonNode | string | (JsonNode | string)[] | null): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(collectText).join("");
  return collectText(node.children);
}

function findByLabel(tree: ReturnType<typeof create>, accessibilityLabel: string): Instance {
  const root = (tree as unknown as RootLike).root;
  const matches = root.findAllByProps({ accessibilityLabel });
  if (matches.length === 0) {
    throw new Error(`No instance found with accessibilityLabel "${accessibilityLabel}"`);
  }
  return matches[0];
}

const DEFAULT_PROPS: React.ComponentProps<typeof TripMembersSection> = {
  tripId: "trip-1",
  ownerId: "owner-1",
  memberIds: [],
  isOwner: false,
  isArchived: false,
};

function renderSection(props: Partial<React.ComponentProps<typeof TripMembersSection>>) {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<TripMembersSection {...DEFAULT_PROPS} {...props} />);
  });
  return tree;
}

function makeTerms(overrides: Partial<TripTerms> = {}): TripTerms {
  return {
    id: "terms-1",
    tripId: "trip-1",
    version: 1,
    createdAt: { toDate: () => new Date("2026-10-20T00:00:00Z") } as TripTerms["createdAt"],
    createdBy: "owner-1",
    contributionExpectations: "x",
    expenseAllocationExpectations: "x",
    sharedStashSpendingAuthority: "x",
    withdrawalExpectations: "x",
    settlementExpectations: "x",
    ...overrides,
  };
}

beforeEach(() => {
  mockedSubscribe.mockReset();
  mockedFetchTerms.mockReset();
  mockedCreateInvitation.mockReset();
  mockedRemoveTripMember.mockReset();
  mockPush.mockReset();
});

describe("TripMembersSection - loading/ready/error lifecycle", () => {
  it("renders a loading state before the profile subscription delivers its first snapshot", () => {
    mockedSubscribe.mockImplementation(() => () => {});
    const tree = renderSection({ ownerId: "owner-1", memberIds: ["owner-1", "member-2"] });
    expect(collectText(tree.toJSON() as JsonNode)).toContain("Loading members");
  });

  it("renders member count and both rows once the subscription delivers resolved profiles", () => {
    let deliver!: (profiles: PublicProfile[]) => void;
    mockedSubscribe.mockImplementation((_uids, onChange) => {
      deliver = onChange;
      return () => {};
    });
    const tree = renderSection({ ownerId: "owner-1", memberIds: ["owner-1", "member-2"] });
    act(() => {
      deliver([
        { uid: "owner-1", displayName: "Dana Owner", photoURL: "" },
        { uid: "member-2", displayName: "Sam Member", photoURL: "" },
      ]);
    });
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("2 members on this trip");
    expect(text).toContain("Dana Owner");
    expect(text).toContain("Sam Member");
  });

  it("the avatar receives initials computed (in this component) from each member's resolved nameLabel, never a literal from the domain layer", () => {
    let deliver!: (profiles: PublicProfile[]) => void;
    mockedSubscribe.mockImplementation((_uids, onChange) => {
      deliver = onChange;
      return () => {};
    });
    const tree = renderSection({ ownerId: "owner-1", memberIds: ["owner-1", "member-2"] });
    act(() => {
      deliver([
        { uid: "owner-1", displayName: "Dana Owner", photoURL: "" },
        { uid: "member-2", displayName: "Sam Member", photoURL: "" },
      ]);
    });
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("DO");
    expect(text).toContain("SM");
  });

  it("the avatar still receives initials derived from the fallback name when no profile resolves", () => {
    mockedSubscribe.mockImplementation((_uids, onChange) => {
      onChange([]);
      return () => {};
    });
    const tree = renderSection({ ownerId: "owner-1", memberIds: [] });
    const text = collectText(tree.toJSON() as JsonNode);
    // initialsFromName("Trip member") === "TM" - computed by the
    // component from the fallback nameLabel, never a literal the
    // domain layer invents on its own.
    expect(text).toContain("TM");
  });

  it("renders the Owner badge only for the owner's row, never for a non-owner member", () => {
    let deliver!: (profiles: PublicProfile[]) => void;
    mockedSubscribe.mockImplementation((_uids, onChange) => {
      deliver = onChange;
      return () => {};
    });
    const tree = renderSection({ ownerId: "owner-1", memberIds: ["owner-1", "member-2"] });
    act(() => {
      deliver([
        { uid: "owner-1", displayName: "Dana Owner", photoURL: "" },
        { uid: "member-2", displayName: "Sam Member", photoURL: "" },
      ]);
    });
    const text = collectText(tree.toJSON() as JsonNode);
    const ownerOccurrences = text.split("Owner").length - 1;
    // "Owner" appears once inside "Dana Owner" and once as the badge
    // itself - never a second badge attached to Sam Member's row.
    expect(ownerOccurrences).toBe(2);
  });

  it("a single-member (owner-only) Trip renders singular copy", () => {
    mockedSubscribe.mockImplementation((_uids, onChange) => {
      onChange([{ uid: "owner-1", displayName: "Dana Owner", photoURL: "" }]);
      return () => {};
    });
    const tree = renderSection({ ownerId: "owner-1", memberIds: [] });
    expect(collectText(tree.toJSON() as JsonNode)).toContain("1 member on this trip");
  });

  it("a failed profile subscription still renders every known member, via safe fallback labels, never an empty list", () => {
    mockedSubscribe.mockImplementation((_uids, _onChange, onError) => {
      onError?.(new Error("boom"));
      return () => {};
    });
    const tree = renderSection({ ownerId: "owner-1", memberIds: ["owner-1", "member-2"] });
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("Trip member 1");
    expect(text).toContain("Trip member 2");
  });

  it("unsubscribes the active profile listener on unmount", () => {
    const unsubscribe = jest.fn();
    mockedSubscribe.mockImplementation(() => unsubscribe);
    const tree = renderSection({ ownerId: "owner-1", memberIds: ["owner-1"] });
    act(() => {
      tree.unmount();
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("never renders a member email address", () => {
    mockedSubscribe.mockImplementation((_uids, onChange) => {
      onChange([
        { uid: "owner-1", displayName: "Dana Owner", photoURL: "" },
      ]);
      return () => {};
    });
    const tree = renderSection({ ownerId: "owner-1", memberIds: ["owner-1"] });
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).not.toMatch(/@/);
  });
});

describe("TripMembersSection - Invite Member entry point (Checkpoint 6.2)", () => {
  it("owner sees the Invite Member control", () => {
    mockedSubscribe.mockImplementation(() => () => {});
    const tree = renderSection({ isOwner: true, isArchived: false });
    expect(() => findByLabel(tree, "Invite Member")).not.toThrow();
  });

  it("non-owner never sees the Invite Member control", () => {
    mockedSubscribe.mockImplementation(() => () => {});
    const tree = renderSection({ isOwner: false, isArchived: false });
    expect(() => findByLabel(tree, "Invite Member")).toThrow();
  });

  it("an archived Trip never exposes an active Invite Member control, even for the owner", () => {
    mockedSubscribe.mockImplementation(() => () => {});
    const tree = renderSection({ isOwner: true, isArchived: true });
    expect(() => findByLabel(tree, "Invite Member")).toThrow();
  });

  it("a successful invitation shows a confirmation with the normalized email, without changing member rendering", async () => {
    mockedSubscribe.mockImplementation((_uids, onChange) => {
      onChange([{ uid: "owner-1", displayName: "Dana Owner", photoURL: "" }]);
      return () => {};
    });
    mockedFetchTerms.mockResolvedValue(makeTerms());
    mockedCreateInvitation.mockResolvedValue({
      invitationId: "trip-1_invitee-uid",
      inviteeUid: "invitee-uid",
    });

    const tree = renderSection({ isOwner: true, isArchived: false, memberIds: ["owner-1"] });

    act(() => {
      (findByLabel(tree, "Invite Member").props.onPress as () => void)();
    });
    // Let the dialog's terms-gate check resolve.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      (findByLabel(tree, "Email address").props.onChangeText as (t: string) => void)(
        "  SAM@Example.com  "
      );
    });
    await act(async () => {
      await (findByLabel(tree, "Send Invitation").props.onPress as () => Promise<void>)();
    });

    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("Invitation sent to sam@example.com");
    // Member rendering is unaffected by sending an invitation - still
    // exactly the one pre-existing owner row, no new member/count.
    expect(text).toContain("1 member on this trip");
    expect(text).toContain("Dana Owner");
  });
});

describe("TripMembersSection - Remove Member entry point (Checkpoint 6.7C)", () => {
  it("owner sees a Remove action for a non-owner member, never for their own row", () => {
    mockedSubscribe.mockImplementation((_uids, onChange) => {
      onChange([
        { uid: "owner-1", displayName: "Dana Owner", photoURL: "" },
        { uid: "member-2", displayName: "Sam Member", photoURL: "" },
      ]);
      return () => {};
    });
    const tree = renderSection({
      isOwner: true,
      ownerId: "owner-1",
      memberIds: ["owner-1", "member-2"],
    });

    expect(() => findByLabel(tree, "Remove Sam Member from trip")).not.toThrow();
    expect(() => findByLabel(tree, "Remove Dana Owner from trip")).toThrow();
  });

  it("a non-owner member never sees any Remove control", () => {
    mockedSubscribe.mockImplementation((_uids, onChange) => {
      onChange([
        { uid: "owner-1", displayName: "Dana Owner", photoURL: "" },
        { uid: "member-2", displayName: "Sam Member", photoURL: "" },
      ]);
      return () => {};
    });
    const tree = renderSection({
      isOwner: false,
      ownerId: "owner-1",
      memberIds: ["owner-1", "member-2"],
    });

    expect(() => findByLabel(tree, "Remove Sam Member from trip")).toThrow();
    expect(() => findByLabel(tree, "Remove Dana Owner from trip")).toThrow();
  });

  it("an archived Trip still permits the Remove action for the owner", () => {
    mockedSubscribe.mockImplementation((_uids, onChange) => {
      onChange([
        { uid: "owner-1", displayName: "Dana Owner", photoURL: "" },
        { uid: "member-2", displayName: "Sam Member", photoURL: "" },
      ]);
      return () => {};
    });
    const tree = renderSection({
      isOwner: true,
      isArchived: true,
      ownerId: "owner-1",
      memberIds: ["owner-1", "member-2"],
    });

    expect(() => findByLabel(tree, "Remove Sam Member from trip")).not.toThrow();
  });

  it("pressing Remove opens the dialog naming the correct target member", () => {
    mockedSubscribe.mockImplementation((_uids, onChange) => {
      onChange([
        { uid: "owner-1", displayName: "Dana Owner", photoURL: "" },
        { uid: "member-2", displayName: "Sam Member", photoURL: "" },
      ]);
      return () => {};
    });
    const tree = renderSection({
      isOwner: true,
      ownerId: "owner-1",
      memberIds: ["owner-1", "member-2"],
    });

    act(() => {
      (findByLabel(tree, "Remove Sam Member from trip").props.onPress as () => void)();
    });

    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("Remove Sam Member?");
  });

  it("a successful removal calls removeTripMember with the exact tripId/targetUid and notifies the parent", async () => {
    mockedSubscribe.mockImplementation((_uids, onChange) => {
      onChange([
        { uid: "owner-1", displayName: "Dana Owner", photoURL: "" },
        { uid: "member-2", displayName: "Sam Member", photoURL: "" },
      ]);
      return () => {};
    });
    mockedRemoveTripMember.mockResolvedValue({
      tripId: "trip-1",
      uid: "member-2",
      departureType: "removed",
    });
    const onRemoved = jest.fn();
    const tree = renderSection({
      isOwner: true,
      ownerId: "owner-1",
      memberIds: ["owner-1", "member-2"],
      onRemoved,
    });

    act(() => {
      (findByLabel(tree, "Remove Sam Member from trip").props.onPress as () => void)();
    });
    await act(async () => {
      await (findByLabel(tree, "Remove Member").props.onPress as () => Promise<void>)();
    });

    expect(mockedRemoveTripMember).toHaveBeenCalledWith("trip-1", "member-2");
    expect(onRemoved).toHaveBeenCalledWith("member-2");
  });
});
