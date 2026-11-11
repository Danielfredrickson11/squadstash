// Presentation/lifecycle tests for MemberActivitySection (Checkpoint
// 6.8C). Mirrors components/trips/__tests__/TripMembersSection.test.tsx's
// own react-test-renderer convention (no new test dependency, no
// @testing-library/react-native). fetchTripMembershipActivityPage and
// subscribeToPublicUsersByIdsChunked are mocked at the module boundary.
import React from "react";
import { act, create } from "react-test-renderer";

import { MemberActivitySection } from "../MemberActivitySection";
import { fetchTripMembershipActivityPage } from "../../../src/services/firebase/tripMembershipActivity";
import type { TripMembershipActivityPage } from "../../../src/services/firebase/tripMembershipActivity";
import { subscribeToPublicUsersByIdsChunked } from "../../../src/services/firebase/users";
import type { PublicProfile, TripMembershipActivityEvent } from "../../../src/types/domain";

jest.mock("../../../src/services/firebase/tripMembershipActivity", () => ({
  fetchTripMembershipActivityPage: jest.fn(),
}));

jest.mock("../../../src/services/firebase/users", () => ({
  subscribeToPublicUsersByIdsChunked: jest.fn(),
}));

const mockedFetchPage = fetchTripMembershipActivityPage as jest.MockedFunction<
  typeof fetchTripMembershipActivityPage
>;
const mockedSubscribe = subscribeToPublicUsersByIdsChunked as jest.MockedFunction<
  typeof subscribeToPublicUsersByIdsChunked
>;

type JsonNode = {
  props: Record<string, unknown>;
  children: (JsonNode | string)[] | null;
};
type Instance = { props: Record<string, unknown> };
type RootLike = {
  root: { findAllByProps: (props: Record<string, unknown>) => Instance[] };
};

function collectText(node: JsonNode | string | (JsonNode | string)[] | null): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(collectText).join("");
  return collectText(node.children);
}

function findByLabel(
  tree: ReturnType<typeof create>,
  accessibilityLabel: string
): Instance | null {
  const root = (tree as unknown as RootLike).root;
  const matches = root.findAllByProps({ accessibilityLabel });
  return matches.length === 0 ? null : matches[0];
}

function requireByLabel(tree: ReturnType<typeof create>, accessibilityLabel: string): Instance {
  const found = findByLabel(tree, accessibilityLabel);
  if (!found) {
    throw new Error(`No instance found with accessibilityLabel "${accessibilityLabel}"`);
  }
  return found;
}

function fakeTimestamp(iso: string) {
  return { toDate: () => new Date(iso) };
}

function fakeEvent(
  overrides: Partial<TripMembershipActivityEvent> = {}
): TripMembershipActivityEvent {
  return {
    id: "activity-1",
    tripId: "trip-1",
    type: "trip_created",
    actorUid: "owner-1",
    targetUid: "owner-1",
    createdAt: fakeTimestamp("2026-11-10T12:00:00Z") as never,
    schemaVersion: 1,
    ...overrides,
  } as TripMembershipActivityEvent;
}

function fakePage(
  events: TripMembershipActivityEvent[],
  overrides: { nextCursor?: unknown; hasMore?: boolean } = {}
): TripMembershipActivityPage {
  return {
    events,
    nextCursor: (overrides.nextCursor ?? null) as TripMembershipActivityPage["nextCursor"],
    hasMore: overrides.hasMore ?? false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderSection(tripId = "trip-1") {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<MemberActivitySection tripId={tripId} />);
  });
  return tree;
}

beforeEach(() => {
  mockedFetchPage.mockReset();
  mockedSubscribe.mockReset();
  mockedSubscribe.mockImplementation(() => () => {});
});

describe("MemberActivitySection - initial states", () => {
  it("renders a loading state before the initial page resolves", () => {
    const d = deferred<ReturnType<typeof fakePage>>();
    mockedFetchPage.mockReturnValue(d.promise as never);
    const tree = renderSection();
    expect(collectText(tree.toJSON() as JsonNode)).toContain("Loading activity");
  });

  it("renders the empty state for a Trip with zero activity documents", async () => {
    mockedFetchPage.mockResolvedValue(fakePage([]));
    const tree = renderSection();
    await act(async () => {
      await Promise.resolve();
    });
    expect(collectText(tree.toJSON() as JsonNode)).toContain("No membership activity yet.");
  });

  it("renders a retryable error state when the initial query rejects", async () => {
    mockedFetchPage.mockRejectedValueOnce(new Error("permission-denied: internal detail"));
    const tree = renderSection();
    await act(async () => {
      await Promise.resolve();
    });
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("Member activity couldn’t be loaded.");
    expect(text).not.toContain("permission-denied: internal detail");
    expect(findByLabel(tree, "Retry loading member activity")).not.toBeNull();
  });

  it("Retry re-issues the initial query and recovers on success", async () => {
    mockedFetchPage.mockRejectedValueOnce(new Error("boom"));
    const tree = renderSection();
    await act(async () => {
      await Promise.resolve();
    });
    mockedFetchPage.mockResolvedValueOnce(fakePage([fakeEvent()]));
    await act(async () => {
      (requireByLabel(tree, "Retry loading member activity").props.onPress as () => void)();
      await Promise.resolve();
    });
    expect(collectText(tree.toJSON() as JsonNode)).toContain("created the Trip");
  });

  it("renders a successful initial page's event copy", async () => {
    mockedFetchPage.mockResolvedValue(fakePage([fakeEvent()]));
    const tree = renderSection();
    await act(async () => {
      await Promise.resolve();
    });
    expect(collectText(tree.toJSON() as JsonNode)).toContain("created the Trip");
  });
});

describe("MemberActivitySection - event copy for all 8 event types", () => {
  const CASES: [string, Partial<TripMembershipActivityEvent>, string][] = [
    ["trip_created", { type: "trip_created", actorUid: "owner-1", targetUid: "owner-1" }, "created the Trip"],
    [
      "invitation_created",
      { type: "invitation_created", actorUid: "owner-1", targetUid: "invitee-1", invitationId: "x" } as never,
      "invited",
    ],
    [
      "invitation_accepted",
      { type: "invitation_accepted", actorUid: "invitee-1", targetUid: "invitee-1", invitationId: "x" } as never,
      "joined the Trip",
    ],
    [
      "invitation_declined",
      { type: "invitation_declined", actorUid: "invitee-1", targetUid: "invitee-1", invitationId: "x" } as never,
      "declined the invitation",
    ],
    [
      "invitation_cancelled",
      { type: "invitation_cancelled", actorUid: "owner-1", targetUid: "invitee-1", invitationId: "x" } as never,
      "cancelled",
    ],
    ["member_left", { type: "member_left", actorUid: "invitee-1", targetUid: "invitee-1" }, "left the Trip"],
    [
      "member_removed",
      { type: "member_removed", actorUid: "owner-1", targetUid: "invitee-1" },
      "removed",
    ],
    [
      "history_tracking_started",
      { type: "history_tracking_started", actorUid: null, targetUid: null } as never,
      "Complete membership activity is tracked from this point forward.",
    ],
  ];

  it.each(CASES)("%s renders the expected copy fragment", async (_label, overrides, expectedFragment) => {
    mockedFetchPage.mockResolvedValue(fakePage([fakeEvent(overrides)]));
    const tree = renderSection();
    await act(async () => {
      await Promise.resolve();
    });
    expect(collectText(tree.toJSON() as JsonNode)).toContain(expectedFragment);
  });

  it("invitation_accepted never renders the word 'accepted'", async () => {
    mockedFetchPage.mockResolvedValue(
      fakePage([
        fakeEvent({
          type: "invitation_accepted",
          actorUid: "invitee-1",
          targetUid: "invitee-1",
          invitationId: "x",
        } as never),
      ])
    );
    const tree = renderSection();
    await act(async () => {
      await Promise.resolve();
    });
    expect(collectText(tree.toJSON() as JsonNode).toLowerCase()).not.toContain("accepted");
  });
});

describe("MemberActivitySection - profile resolution", () => {
  it("renders resolved display names in place of raw uids", async () => {
    mockedFetchPage.mockResolvedValue(fakePage([fakeEvent()]));
    let deliver!: (profiles: PublicProfile[]) => void;
    mockedSubscribe.mockImplementation((_uids, onChange) => {
      deliver = onChange;
      return () => {};
    });
    const tree = renderSection();
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      deliver([{ uid: "owner-1", displayName: "Daniel", photoURL: "" }]);
    });
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("Daniel created the Trip");
    expect(text).not.toContain("owner-1");
  });

  it("falls back to a safe neutral label when no profile resolves", async () => {
    mockedFetchPage.mockResolvedValue(fakePage([fakeEvent()]));
    mockedSubscribe.mockImplementation((_uids, onChange) => {
      onChange([]);
      return () => {};
    });
    const tree = renderSection();
    await act(async () => {
      await Promise.resolve();
    });
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("Trip member created the Trip");
    expect(text).not.toContain("owner-1");
  });

  it("the system marker renders no avatar/profile-based identity at all", async () => {
    mockedFetchPage.mockResolvedValue(
      fakePage([fakeEvent({ type: "history_tracking_started", actorUid: null, targetUid: null } as never)])
    );
    const tree = renderSection();
    await act(async () => {
      await Promise.resolve();
    });
    // No profile subscription is even started, since collectUids
    // contributes nothing for a system marker.
    expect(mockedSubscribe).not.toHaveBeenCalled();
    expect(findByLabel(tree, "System")).not.toBeNull();
  });

  it("a profile-subscription error does not corrupt the rendered activity list", async () => {
    mockedFetchPage.mockResolvedValue(fakePage([fakeEvent()]));
    mockedSubscribe.mockImplementation((_uids, _onChange, onError) => {
      onError?.(new Error("profiles down"));
      return () => {};
    });
    const tree = renderSection();
    await act(async () => {
      await Promise.resolve();
    });
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("Trip member created the Trip");
  });
});

describe("MemberActivitySection - pagination", () => {
  it("Load more does not appear when hasMore is false", async () => {
    mockedFetchPage.mockResolvedValue(fakePage([fakeEvent()], { hasMore: false }));
    const tree = renderSection();
    await act(async () => {
      await Promise.resolve();
    });
    expect(findByLabel(tree, "Load more activity")).toBeNull();
  });

  it("Load more appears when hasMore is true", async () => {
    mockedFetchPage.mockResolvedValue(
      fakePage([fakeEvent()], { hasMore: true, nextCursor: { __type: "cursor" } })
    );
    const tree = renderSection();
    await act(async () => {
      await Promise.resolve();
    });
    expect(findByLabel(tree, "Load more activity")).not.toBeNull();
  });

  it("pressing Load more passes the exact prior-page cursor and appends new events without duplicates", async () => {
    const cursor = { __type: "cursor-1" };
    mockedFetchPage.mockResolvedValueOnce(
      fakePage([fakeEvent({ id: "activity-1" })], { hasMore: true, nextCursor: cursor })
    );
    const tree = renderSection();
    await act(async () => {
      await Promise.resolve();
    });

    mockedFetchPage.mockResolvedValueOnce(
      fakePage([fakeEvent({ id: "activity-2", type: "member_left", actorUid: "invitee-1", targetUid: "invitee-1" })], {
        hasMore: false,
      })
    );
    await act(async () => {
      (requireByLabel(tree, "Load more activity").props.onPress as () => void)();
      await Promise.resolve();
    });

    expect(mockedFetchPage).toHaveBeenNthCalledWith(2, "trip-1", { cursor });
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("created the Trip");
    expect(text).toContain("left the Trip");
    // No duplicate row for the first event.
    expect(text.match(/created the Trip/g)?.length).toBe(1);
    expect(findByLabel(tree, "Load more activity")).toBeNull();
  });

  it("shows a loading indicator while a load-more request is in flight", async () => {
    mockedFetchPage.mockResolvedValueOnce(
      fakePage([fakeEvent()], { hasMore: true, nextCursor: { __type: "cursor" } })
    );
    const tree = renderSection();
    await act(async () => {
      await Promise.resolve();
    });

    const d = deferred<ReturnType<typeof fakePage>>();
    mockedFetchPage.mockReturnValueOnce(d.promise as never);
    act(() => {
      (requireByLabel(tree, "Load more activity").props.onPress as () => void)();
    });
    expect(requireByLabel(tree, "Load more activity").props.disabled).toBe(true);

    await act(async () => {
      d.resolve(fakePage([], { hasMore: false }));
      await Promise.resolve();
    });
  });

  it("a duplicate rapid Load more press cannot issue a second simultaneous request", async () => {
    mockedFetchPage.mockResolvedValueOnce(
      fakePage([fakeEvent()], { hasMore: true, nextCursor: { __type: "cursor" } })
    );
    const tree = renderSection();
    await act(async () => {
      await Promise.resolve();
    });

    const d = deferred<ReturnType<typeof fakePage>>();
    mockedFetchPage.mockReturnValueOnce(d.promise as never);
    act(() => {
      const onPress = requireByLabel(tree, "Load more activity").props.onPress as () => void;
      onPress();
      onPress();
    });

    // Exactly 2 total calls: the initial page load + the ONE load-more.
    expect(mockedFetchPage).toHaveBeenCalledTimes(2);

    await act(async () => {
      d.resolve(fakePage([], { hasMore: false }));
      await Promise.resolve();
    });
  });

  it("a pagination failure preserves the already-loaded first page and shows a retryable error", async () => {
    mockedFetchPage.mockResolvedValueOnce(
      fakePage([fakeEvent()], { hasMore: true, nextCursor: { __type: "cursor" } })
    );
    const tree = renderSection();
    await act(async () => {
      await Promise.resolve();
    });

    mockedFetchPage.mockRejectedValueOnce(new Error("network blip"));
    await act(async () => {
      (requireByLabel(tree, "Load more activity").props.onPress as () => void)();
      await Promise.resolve();
    });

    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("created the Trip");
    expect(text).toContain("Couldn’t load more activity.");
    expect(findByLabel(tree, "Retry loading more activity")).not.toBeNull();
  });

  it("retrying a failed pagination load succeeds and appends the recovered page", async () => {
    mockedFetchPage.mockResolvedValueOnce(
      fakePage([fakeEvent({ id: "activity-1" })], { hasMore: true, nextCursor: { __type: "cursor" } })
    );
    const tree = renderSection();
    await act(async () => {
      await Promise.resolve();
    });

    mockedFetchPage.mockRejectedValueOnce(new Error("network blip"));
    await act(async () => {
      (requireByLabel(tree, "Load more activity").props.onPress as () => void)();
      await Promise.resolve();
    });

    mockedFetchPage.mockResolvedValueOnce(
      fakePage(
        [fakeEvent({ id: "activity-2", type: "member_left", actorUid: "invitee-1", targetUid: "invitee-1" })],
        { hasMore: false }
      )
    );
    await act(async () => {
      (requireByLabel(tree, "Retry loading more activity").props.onPress as () => void)();
      await Promise.resolve();
    });

    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("created the Trip");
    expect(text).toContain("left the Trip");
  });
});

describe("MemberActivitySection - lifecycle/unmount safety", () => {
  it("unsubscribes from the profile subscription on unmount", async () => {
    mockedFetchPage.mockResolvedValue(fakePage([fakeEvent()]));
    const unsubscribe = jest.fn();
    mockedSubscribe.mockImplementation(() => unsubscribe);
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<MemberActivitySection tripId="trip-1" />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      tree.unmount();
    });
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("a stale response for a previous tripId never overwrites the current tripId's state", async () => {
    const tripOneDeferred = deferred<ReturnType<typeof fakePage>>();
    mockedFetchPage.mockReturnValueOnce(tripOneDeferred.promise as never);

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<MemberActivitySection tripId="trip-1" />);
    });

    mockedFetchPage.mockResolvedValueOnce(
      fakePage([fakeEvent({ id: "trip-2-event", tripId: "trip-2" })])
    );
    act(() => {
      tree.update(<MemberActivitySection tripId="trip-2" />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // The stale trip-1 request resolves AFTER trip-2's own request has
    // already completed - it must be silently ignored.
    await act(async () => {
      tripOneDeferred.resolve(fakePage([fakeEvent({ id: "trip-1-event", tripId: "trip-1" })]));
      await Promise.resolve();
    });

    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("created the Trip");
    // Only one row should exist (trip-2's), not two.
    expect(text.match(/created the Trip/g)?.length).toBe(1);
  });

  it("Checkpoint 6.8 review fix: a refreshToken bump re-fetches the first page and replaces it with the refreshed result", async () => {
    mockedFetchPage.mockResolvedValueOnce(fakePage([fakeEvent({ id: "a1", type: "trip_created" })]));
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<MemberActivitySection tripId="trip-1" refreshToken={0} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(collectText(tree.toJSON() as JsonNode)).toContain("created the Trip");
    expect(collectText(tree.toJSON() as JsonNode)).not.toContain("invited");

    mockedFetchPage.mockResolvedValueOnce(
      fakePage([
        fakeEvent({ id: "a1", type: "trip_created" }),
        fakeEvent({
          id: "a2",
          type: "invitation_created",
          actorUid: "owner-1",
          targetUid: "invitee-1",
          invitationId: "x",
        } as never),
      ])
    );
    act(() => {
      tree.update(<MemberActivitySection tripId="trip-1" refreshToken={1} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockedFetchPage).toHaveBeenCalledTimes(2);
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("created the Trip");
    expect(text).toContain("invited");
  });

  it("Checkpoint 6.8 review fix: initial mount with a refreshToken prop present issues exactly one fetch", async () => {
    mockedFetchPage.mockResolvedValueOnce(fakePage([fakeEvent()]));
    act(() => {
      create(<MemberActivitySection tripId="trip-1" refreshToken={0} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockedFetchPage).toHaveBeenCalledTimes(1);
  });

  it("Checkpoint 6.8 review fix: a stale prior request cannot overwrite a newer refreshToken-triggered result", async () => {
    const staleDeferred = deferred<ReturnType<typeof fakePage>>();
    mockedFetchPage.mockReturnValueOnce(staleDeferred.promise as never);
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<MemberActivitySection tripId="trip-1" refreshToken={0} />);
    });

    mockedFetchPage.mockResolvedValueOnce(
      fakePage([fakeEvent({ id: "fresh", type: "member_left", actorUid: "invitee-1", targetUid: "invitee-1" })])
    );
    act(() => {
      tree.update(<MemberActivitySection tripId="trip-1" refreshToken={1} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(collectText(tree.toJSON() as JsonNode)).toContain("left the Trip");

    await act(async () => {
      staleDeferred.resolve(fakePage([fakeEvent({ id: "stale", type: "trip_created" })]));
      await Promise.resolve();
    });

    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("left the Trip");
    expect(text).not.toContain("created the Trip");
  });

  it("Checkpoint 6.8 review fix: pagination state (Load more) is preserved correctly after a refreshToken-triggered first-page replacement", async () => {
    mockedFetchPage.mockResolvedValueOnce(
      fakePage([fakeEvent({ id: "a1" })], { hasMore: true, nextCursor: { __type: "cursor-1" } })
    );
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<MemberActivitySection tripId="trip-1" refreshToken={0} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(findByLabel(tree, "Load more activity")).not.toBeNull();

    mockedFetchPage.mockResolvedValueOnce(fakePage([fakeEvent({ id: "a1" })], { hasMore: false }));
    act(() => {
      tree.update(<MemberActivitySection tripId="trip-1" refreshToken={1} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    // The refreshed first page reports hasMore: false - Load More must
    // reflect the NEW page's own cursor/hasMore state, never a stale
    // leftover from before the refresh.
    expect(findByLabel(tree, "Load more activity")).toBeNull();

    mockedFetchPage.mockResolvedValueOnce(
      fakePage([fakeEvent({ id: "a2", type: "member_left", actorUid: "invitee-1", targetUid: "invitee-1" })], {
        hasMore: true,
        nextCursor: { __type: "cursor-2" },
      })
    );
    act(() => {
      tree.update(<MemberActivitySection tripId="trip-1" refreshToken={2} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(findByLabel(tree, "Load more activity")).not.toBeNull();

    mockedFetchPage.mockResolvedValueOnce(
      fakePage([fakeEvent({ id: "a3", type: "member_removed", actorUid: "owner-1", targetUid: "invitee-1" })], {
        hasMore: false,
      })
    );
    await act(async () => {
      (requireByLabel(tree, "Load more activity").props.onPress as () => void)();
      await Promise.resolve();
    });
    expect(mockedFetchPage).toHaveBeenNthCalledWith(4, "trip-1", { cursor: { __type: "cursor-2" } });
  });

  it("a stale profile-resolution error note does not persist once tripId changes to a Trip with no resolvable uids (6.8D lifecycle fix)", async () => {
    mockedFetchPage.mockResolvedValueOnce(fakePage([fakeEvent()]));
    mockedSubscribe.mockImplementation((_uids, _onChange, onError) => {
      onError?.(new Error("profiles down"));
      return () => {};
    });
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<MemberActivitySection tripId="trip-1" />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(collectText(tree.toJSON() as JsonNode)).toContain(
      "Some names couldn’t load."
    );

    // trip-2 has zero activity at all - uidsToResolve becomes empty,
    // which previously skipped resetting the error flag entirely.
    mockedFetchPage.mockResolvedValueOnce(fakePage([]));
    act(() => {
      tree.update(<MemberActivitySection tripId="trip-2" />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).not.toContain("Some names couldn’t load.");
    expect(text).toContain("No membership activity yet.");
  });
});
