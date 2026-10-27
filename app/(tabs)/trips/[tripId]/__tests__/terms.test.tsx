// Route-level test for the Trip Terms screen (Checkpoint 6.3 review
// fix). Mirrors this project's existing react-test-renderer convention
// (no new test dependency, no @testing-library/react-native) and
// tests/integration/tripInvitationScreen.emulator.test.tsx's own
// expo-router/useAuth mocking style for a navigable screen. Drives the
// REAL TripTermsEditor component underneath (not mocked) so the
// publish -> refresh interaction is exercised end-to-end at the
// presentation layer; only the Firebase-touching service calls
// (fetchTripById, fetchCurrentTripTerms, publishTripTerms) are mocked at
// the module boundary.
import React from "react";
import { act, create } from "react-test-renderer";

import TripTermsScreen from "../terms";
import { TERMS_FIELD_DEFS } from "../../../../../components/trips/TripTermsEditor";
import { fetchTripById } from "../../../../../src/services/firebase/trips";
import {
  fetchCurrentTripTerms,
  publishTripTerms,
} from "../../../../../src/services/firebase/tripTerms";
import type { Trip, TripTerms } from "../../../../../src/types/domain";

const mockPush = jest.fn();
const mockBack = jest.fn();
let mockParams: Record<string, string> = { tripId: "trip-1" };
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, back: mockBack }),
  useLocalSearchParams: () => mockParams,
}));

const mockUser: { uid: string } | null = { uid: "owner-1" };
jest.mock("../../../../../src/contexts/AuthContext", () => ({
  useAuth: () => ({ user: mockUser }),
}));

jest.mock("../../../../../src/services/firebase/trips", () => ({
  fetchTripById: jest.fn(),
}));

jest.mock("../../../../../src/services/firebase/tripTerms", () => ({
  fetchCurrentTripTerms: jest.fn(),
  publishTripTerms: jest.fn(),
}));

const mockedFetchTrip = fetchTripById as jest.MockedFunction<typeof fetchTripById>;
const mockedFetchTerms = fetchCurrentTripTerms as jest.MockedFunction<typeof fetchCurrentTripTerms>;
const mockedPublish = publishTripTerms as jest.MockedFunction<typeof publishTripTerms>;

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

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    id: "trip-1",
    ownerId: "owner-1",
    memberIds: ["owner-1"],
    title: "Canada Trip",
    archivedAt: null,
    ...overrides,
  } as Trip;
}

function makeTerms(overrides: Partial<TripTerms> = {}): TripTerms {
  return {
    id: "terms-1",
    tripId: "trip-1",
    version: 1,
    createdAt: { toDate: () => new Date("2026-10-20T00:00:00Z") } as TripTerms["createdAt"],
    createdBy: "owner-1",
    contributionExpectations: "Each member contributes $200.",
    expenseAllocationExpectations: "Split evenly.",
    sharedStashSpendingAuthority: "Any member may spend.",
    withdrawalExpectations: "Withdraw anytime.",
    settlementExpectations: "Settle within 7 days.",
    ...overrides,
  };
}

beforeEach(() => {
  mockedFetchTrip.mockReset();
  mockedFetchTerms.mockReset();
  mockedPublish.mockReset();
  mockPush.mockReset();
  mockBack.mockReset();
  mockParams = { tripId: "trip-1", mode: "edit" };
});

describe("Trip Terms screen - successful publish, failed post-publish refresh (review fix)", () => {
  async function renderReadyInEditMode() {
    mockedFetchTrip.mockResolvedValue(makeTrip());
    mockedFetchTerms.mockResolvedValueOnce(makeTerms({ version: 1 }));
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TripTermsScreen />);
    });
    return tree;
  }

  async function fillAndSubmit(tree: ReturnType<typeof create>) {
    TERMS_FIELD_DEFS.forEach(({ label }) => {
      const input = findByLabel(tree, label);
      act(() => {
        (input.props.onChangeText as (text: string) => void)("Updated content.");
      });
    });
    act(() => {
      (findByLabel(tree, "Review Terms").props.onPress as () => void)();
    });
    await act(async () => {
      await (findByLabel(tree, "Publish Terms").props.onPress as () => Promise<void>)();
    });
  }

  it("never shows 'No terms have been published yet' when publish succeeds but the refresh fails", async () => {
    const tree = await renderReadyInEditMode();
    mockedPublish.mockResolvedValue({ id: "new-terms-id", version: 2 });
    mockedFetchTerms.mockRejectedValueOnce(new Error("internal firestore detail"));

    await fillAndSubmit(tree);

    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).not.toContain("No terms have been published yet");
    expect(text).not.toContain("internal firestore detail");
  });

  it("acknowledges the successful publication while communicating the refresh failure", async () => {
    const tree = await renderReadyInEditMode();
    mockedPublish.mockResolvedValue({ id: "new-terms-id", version: 2 });
    mockedFetchTerms.mockRejectedValueOnce(new Error("internal firestore detail"));

    await fillAndSubmit(tree);

    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("published successfully");
    expect(text).toContain("couldn't refresh");
  });

  it("Retry after a failed post-publish refresh only refetches current terms, never republishes", async () => {
    const tree = await renderReadyInEditMode();
    mockedPublish.mockResolvedValue({ id: "new-terms-id", version: 2 });
    mockedFetchTerms.mockRejectedValueOnce(new Error("internal firestore detail"));

    await fillAndSubmit(tree);
    expect(mockedPublish).toHaveBeenCalledTimes(1);

    mockedFetchTerms.mockResolvedValueOnce(makeTerms({ version: 2 }));
    await act(async () => {
      await (findByLabel(tree, "Try again").props.onPress as () => Promise<void>)();
    });

    expect(mockedPublish).toHaveBeenCalledTimes(1);
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("Version 2 is now current");
  });

  it("a successful refresh on the first attempt shows the normal success state", async () => {
    const tree = await renderReadyInEditMode();
    mockedPublish.mockResolvedValue({ id: "new-terms-id", version: 2 });
    mockedFetchTerms.mockResolvedValueOnce(makeTerms({ version: 2 }));

    await fillAndSubmit(tree);

    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("Version 2 is now current");
    expect(text).not.toContain("couldn't refresh");
  });
});
