// Presentation/lifecycle tests for TripInvitationsSection (Checkpoint
// 6.4). Mirrors components/trips/__tests__/TripTermsSection.test.tsx's
// own react-test-renderer + useFocusEffect-mocking convention exactly
// (no new test dependency, no @testing-library/react-native, and the
// same real-useEffect-via-requireActual("react") mock that correctly
// participates in the render/commit cycle rather than firing
// synchronously mid-render).
import React from "react";
import { act, create } from "react-test-renderer";

import { TripInvitationsSection } from "../TripInvitationsSection";
import { fetchInvitationsForTrip } from "../../../src/services/firebase/tripInvitations";
import type { TripInvitation } from "../../../src/types/domain";

let mockFocusEffectCallback: (() => void) | undefined;
jest.mock("expo-router", () => {
  const ReactActual = jest.requireActual("react");
  return {
    useFocusEffect: (effect: () => void) => {
      mockFocusEffectCallback = effect;
      ReactActual.useEffect(() => {
        effect();
      }, []);
    },
  };
});

jest.mock("../../../src/services/firebase/tripInvitations", () => ({
  fetchInvitationsForTrip: jest.fn(),
}));

const mockedFetch = fetchInvitationsForTrip as jest.MockedFunction<
  typeof fetchInvitationsForTrip
>;

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

function fakeTimestamp(date: Date) {
  return { toDate: () => date } as unknown as TripInvitation["expiresAt"];
}

function makeInvitation(overrides: Partial<TripInvitation> = {}): TripInvitation {
  return {
    id: "trip-1_invitee-1",
    tripId: "trip-1",
    inviterUid: "owner-1",
    inviteeEmail: "invitee@example.com",
    inviteeUid: "invitee-1",
    status: "pending",
    createdAt: fakeTimestamp(new Date("2026-10-20T12:00:00Z")),
    expiresAt: fakeTimestamp(new Date("2026-11-11T12:49:46.264Z")),
    respondedAt: null,
    ...overrides,
  };
}

function renderSection(props: Partial<React.ComponentProps<typeof TripInvitationsSection>> = {}) {
  const defaults: React.ComponentProps<typeof TripInvitationsSection> = {
    tripId: "trip-1",
    isOwner: true,
  };
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<TripInvitationsSection {...defaults} {...props} />);
  });
  return tree;
}

beforeEach(() => {
  mockedFetch.mockReset();
  mockFocusEffectCallback = undefined;
});

describe("TripInvitationsSection - owner-only visibility", () => {
  it("a non-owner renders nothing", () => {
    mockedFetch.mockResolvedValue([makeInvitation()]);
    const tree = renderSection({ isOwner: false });
    expect(tree.toJSON()).toBeNull();
  });

  it("a non-owner never issues the owner-side query", async () => {
    mockedFetch.mockResolvedValue([makeInvitation()]);
    renderSection({ isOwner: false });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});

describe("TripInvitationsSection - loading/empty/error states", () => {
  it("owner sees a loading state before the fetch resolves", () => {
    mockedFetch.mockImplementation(() => new Promise(() => {}));
    const tree = renderSection({ isOwner: true });
    expect(collectText(tree.toJSON() as JsonNode)).toContain("Loading invitations");
  });

  it("owner with zero invitations ever sent sees nothing rendered", async () => {
    mockedFetch.mockResolvedValue([]);
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TripInvitationsSection tripId="trip-1" isOwner={true} />);
    });
    expect(tree.toJSON()).toBeNull();
  });

  it("a load error renders a safe generic message, never raw details", async () => {
    mockedFetch.mockRejectedValue(new Error("permission-denied: internal detail"));
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TripInvitationsSection tripId="trip-1" isOwner={true} />);
    });
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).not.toContain("permission-denied: internal detail");
    expect(text).toContain("retry");
  });

  it("Retry refetches", async () => {
    mockedFetch.mockRejectedValueOnce(new Error("blip"));
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TripInvitationsSection tripId="trip-1" isOwner={true} />);
    });

    mockedFetch.mockResolvedValueOnce([makeInvitation()]);
    act(() => {
      (findByLabel(tree, "Retry loading invitations").props.onPress as () => void)();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(collectText(tree.toJSON() as JsonNode)).toContain("invitee@example.com");
  });
});

describe("TripInvitationsSection - per-status presentation", () => {
  async function renderReady(invitation: TripInvitation) {
    mockedFetch.mockResolvedValue([invitation]);
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TripInvitationsSection tripId="trip-1" isOwner={true} />);
    });
    return tree;
  }

  it("renders a pending row with its expiry date", async () => {
    const tree = await renderReady(
      makeInvitation({ status: "pending", expiresAt: fakeTimestamp(new Date("2026-11-11T12:49:46Z")) })
    );
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("invitee@example.com");
    expect(text).toContain("Pending");
    expect(text).toContain("Nov 11");
  });

  it("renders an accepted row using respondedAt", async () => {
    const tree = await renderReady(
      makeInvitation({
        status: "accepted",
        respondedAt: fakeTimestamp(new Date("2026-10-30T12:00:00Z")),
      })
    );
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("Accepted");
    expect(text).toContain("Oct 30");
  });

  it("renders a declined row using respondedAt", async () => {
    const tree = await renderReady(
      makeInvitation({
        status: "declined",
        respondedAt: fakeTimestamp(new Date("2026-10-30T12:00:00Z")),
      })
    );
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("Declined");
    expect(text).toContain("Oct 30");
  });

  it("renders an expired row using expiresAt (never persisted, purely derived)", async () => {
    const tree = await renderReady(
      makeInvitation({
        status: "pending",
        expiresAt: fakeTimestamp(new Date("2020-01-01T12:00:00Z")),
      })
    );
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("Expired");
    expect(text).toContain("Jan 1");
  });

  it("renders a cancelled row using respondedAt", async () => {
    const tree = await renderReady(
      makeInvitation({
        status: "cancelled",
        respondedAt: fakeTimestamp(new Date("2026-10-30T12:00:00Z")),
      })
    );
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("Cancelled");
    expect(text).toContain("Oct 30");
  });

  it("every terminal status row never implies a current-member row and has no action", async () => {
    const tree = await renderReady(
      makeInvitation({ status: "accepted", respondedAt: fakeTimestamp(new Date("2026-10-30T12:00:00Z")) })
    );
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).not.toMatch(/member/i);
    expect(text).not.toContain("Cancel");
    expect(text).not.toContain("Invite Again");
    // "Accepted" (the status label itself) legitimately contains
    // "Accept" as a substring - assert no actual ACTION phrase exists,
    // never that the word "Accept" is absent outright.
    expect(text).not.toContain("Accept Invitation");
    expect(text).not.toContain("Decline Invitation");
    // No interactive control exists on this row at all (no Pressable/
    // Button other than this component's own error-retry affordance,
    // which isn't rendered in the ready state this test exercises).
    const root = (tree as unknown as RootLike).root;
    expect(root.findAllByProps({ accessibilityRole: "button" })).toHaveLength(0);
  });

  it("an accepted row never displays member-count/current-membership language", async () => {
    const tree = await renderReady(
      makeInvitation({ status: "accepted", respondedAt: fakeTimestamp(new Date("2026-10-30T12:00:00Z")) })
    );
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).not.toMatch(/\d+ members? on this trip/i);
  });
});

describe("TripInvitationsSection - sort order", () => {
  it("pending sorts before every terminal status", async () => {
    mockedFetch.mockResolvedValue([
      makeInvitation({
        id: "a",
        inviteeEmail: "declined@example.com",
        status: "declined",
        createdAt: fakeTimestamp(new Date("2026-10-25T12:00:00Z")),
        respondedAt: fakeTimestamp(new Date("2026-10-26T12:00:00Z")),
      }),
      makeInvitation({
        id: "b",
        inviteeEmail: "pending@example.com",
        status: "pending",
        createdAt: fakeTimestamp(new Date("2026-10-20T12:00:00Z")),
      }),
    ]);
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TripInvitationsSection tripId="trip-1" isOwner={true} />);
    });
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text.indexOf("pending@example.com")).toBeLessThan(text.indexOf("declined@example.com"));
  });

  it("within a comparable group, newest createdAt sorts first", async () => {
    mockedFetch.mockResolvedValue([
      makeInvitation({
        id: "older",
        inviteeEmail: "older@example.com",
        status: "declined",
        createdAt: fakeTimestamp(new Date("2026-10-01T12:00:00Z")),
      }),
      makeInvitation({
        id: "newer",
        inviteeEmail: "newer@example.com",
        status: "declined",
        createdAt: fakeTimestamp(new Date("2026-10-20T12:00:00Z")),
      }),
    ]);
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TripInvitationsSection tripId="trip-1" isOwner={true} />);
    });
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text.indexOf("newer@example.com")).toBeLessThan(text.indexOf("older@example.com"));
  });
});

describe("TripInvitationsSection - focus refresh and async safety (review-fix pattern)", () => {
  it("a focus refresh can update a pending row to another status", async () => {
    mockedFetch.mockResolvedValueOnce([makeInvitation({ status: "pending" })]);
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TripInvitationsSection tripId="trip-1" isOwner={true} />);
    });
    expect(collectText(tree.toJSON() as JsonNode)).toContain("Pending");

    mockedFetch.mockResolvedValueOnce([
      makeInvitation({ status: "accepted", respondedAt: fakeTimestamp(new Date("2026-10-30T12:00:00Z")) }),
    ]);
    await act(async () => {
      mockFocusEffectCallback?.();
    });

    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("Accepted");
    expect(text).not.toContain("Pending");
  });

  it("a stale fetch cannot overwrite a newer focus-refresh result", async () => {
    let resolveStale!: (invitations: TripInvitation[]) => void;
    mockedFetch.mockImplementationOnce(
      () => new Promise((resolve) => (resolveStale = resolve))
    );
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TripInvitationsSection tripId="trip-1" isOwner={true} />);
    });

    mockedFetch.mockResolvedValueOnce([
      makeInvitation({ inviteeEmail: "fresh@example.com", status: "pending" }),
    ]);
    await act(async () => {
      mockFocusEffectCallback?.();
    });
    expect(collectText(tree.toJSON() as JsonNode)).toContain("fresh@example.com");

    await act(async () => {
      resolveStale([makeInvitation({ inviteeEmail: "stale@example.com" })]);
      await Promise.resolve();
    });

    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("fresh@example.com");
    expect(text).not.toContain("stale@example.com");
  });

  it("resolving a pending request after unmount never calls setState or logs a React warning", async () => {
    let resolvePending!: (invitations: TripInvitation[]) => void;
    mockedFetch.mockImplementationOnce(
      () => new Promise((resolve) => (resolvePending = resolve))
    );
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TripInvitationsSection tripId="trip-1" isOwner={true} />);
    });

    act(() => {
      tree.unmount();
    });

    await act(async () => {
      resolvePending([makeInvitation()]);
      await Promise.resolve();
    });

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
