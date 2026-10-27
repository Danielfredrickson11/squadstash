// Presentation/lifecycle tests for TripMembersSection (Checkpoint 6.1).
// Mirrors components/balances/__tests__/BalanceRow.test.tsx's own
// react-test-renderer convention (no new test dependency, no
// @testing-library/react-native). The one Firebase-touching dependency
// (subscribeToPublicUsersByIdsChunked) is mocked at the module boundary -
// this is a standard Jest unit-test technique, unrelated to this
// project's separate emulator/production integration-test surfaces
// (tests/integration/, functions/test/), which this file never touches.
import React from "react";
import { act, create } from "react-test-renderer";

import { TripMembersSection } from "../TripMembersSection";
import { subscribeToPublicUsersByIdsChunked } from "../../../src/services/firebase/users";
import type { PublicProfile } from "../../../src/types/domain";

jest.mock("../../../src/services/firebase/users", () => ({
  subscribeToPublicUsersByIdsChunked: jest.fn(),
}));

const mockedSubscribe = subscribeToPublicUsersByIdsChunked as jest.MockedFunction<
  typeof subscribeToPublicUsersByIdsChunked
>;

type JsonNode = {
  props: Record<string, unknown>;
  children: (JsonNode | string)[] | null;
};

function collectText(node: JsonNode | string | (JsonNode | string)[] | null): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(collectText).join("");
  return collectText(node.children);
}

function renderSection(props: React.ComponentProps<typeof TripMembersSection>) {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<TripMembersSection {...props} />);
  });
  return tree;
}

beforeEach(() => {
  mockedSubscribe.mockReset();
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
