// Presentation/lifecycle tests for TripTermsSection (Checkpoint 6.3).
// Mirrors components/trips/__tests__/TripMembersSection.test.tsx's own
// react-test-renderer convention (no new test dependency, no
// @testing-library/react-native). The two Firebase/navigation-touching
// dependencies (fetchCurrentTripTerms, expo-router's useRouter/
// useFocusEffect) are mocked at the module boundary - this is a standard
// Jest unit-test technique, unrelated to this project's separate
// emulator/production integration-test surfaces (tests/integration/,
// functions/test/), which this file never touches.
import React from "react";
import { act, create } from "react-test-renderer";

import { TripTermsSection } from "../TripTermsSection";
import { fetchCurrentTripTerms } from "../../../src/services/firebase/tripTerms";
import type { TripTerms } from "../../../src/types/domain";

const mockPush = jest.fn();
// Review-fix mock: real useFocusEffect (expo-router/@react-navigation)
// runs its effect once after initial mount/focus (via its own internal
// effect, never synchronously during render), then again only on each
// later re-focus event - never on every ordinary re-render. This mock
// reproduces that with a real `useEffect([])` (via requireActual("react"),
// so it participates correctly in the test renderer's render/commit
// cycle rather than calling the effect synchronously mid-render), and
// exposes `mockFocusEffectCallback` so a test can manually simulate a
// later re-focus by invoking the SAME registered effect function again
// directly - exactly how a real re-focus event re-invokes it.
let mockFocusEffectCallback: (() => void) | undefined;
jest.mock("expo-router", () => {
  const ReactActual = jest.requireActual("react");
  return {
    useRouter: () => ({ push: mockPush }),
    useFocusEffect: (effect: () => void) => {
      mockFocusEffectCallback = effect;
      ReactActual.useEffect(() => {
        effect();
      }, []);
    },
  };
});

jest.mock("../../../src/services/firebase/tripTerms", () => ({
  fetchCurrentTripTerms: jest.fn(),
}));

const mockedFetch = fetchCurrentTripTerms as jest.MockedFunction<typeof fetchCurrentTripTerms>;

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

function makeTerms(overrides: Partial<TripTerms> = {}): TripTerms {
  return {
    id: "terms-1",
    tripId: "trip-1",
    version: 1,
    createdAt: { toDate: () => new Date("2026-10-26T00:00:00Z") } as TripTerms["createdAt"],
    createdBy: "owner-1",
    contributionExpectations: "Each member contributes $200.",
    expenseAllocationExpectations: "Split evenly.",
    sharedStashSpendingAuthority: "Any member may spend.",
    withdrawalExpectations: "Withdraw anytime.",
    settlementExpectations: "Settle within 7 days.",
    ...overrides,
  };
}

async function renderSection(props: React.ComponentProps<typeof TripTermsSection>) {
  let tree!: ReturnType<typeof create>;
  await act(async () => {
    tree = create(<TripTermsSection {...props} />);
  });
  return tree;
}

beforeEach(() => {
  mockedFetch.mockReset();
  mockPush.mockReset();
  mockFocusEffectCallback = undefined;
});

describe("TripTermsSection - loading/ready/error/no-terms states", () => {
  it("renders a loading state before fetchCurrentTripTerms resolves", () => {
    let resolveFetch!: (terms: TripTerms | null) => void;
    mockedFetch.mockImplementation(
      () => new Promise((resolve) => (resolveFetch = resolve))
    );
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<TripTermsSection tripId="trip-1" isOwner={true} />);
    });
    expect(collectText(tree.toJSON() as JsonNode)).toContain("Loading Trip Terms");
    resolveFetch(null);
  });

  it("no-terms owner state shows Set Up Trip Terms", async () => {
    mockedFetch.mockResolvedValue(null);
    const tree = await renderSection({ tripId: "trip-1", isOwner: true });
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("No terms have been published yet.");
    expect(text).toContain("Set Up Trip Terms");
  });

  it("no-terms non-owner state shows a factual read-only message, never a Set Up control", async () => {
    mockedFetch.mockResolvedValue(null);
    const tree = await renderSection({ tripId: "trip-1", isOwner: false });
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("owner hasn't published Trip Terms yet");
    expect(text).not.toContain("Set Up Trip Terms");
  });

  it("existing terms render a version summary", async () => {
    mockedFetch.mockResolvedValue(makeTerms({ version: 3 }));
    const tree = await renderSection({ tripId: "trip-1", isOwner: false });
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("Version 3");
  });

  it("owner sees View Terms and Edit / Publish New Version actions", async () => {
    mockedFetch.mockResolvedValue(makeTerms());
    const tree = await renderSection({ tripId: "trip-1", isOwner: true });
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("View Terms");
    expect(text).toContain("Edit / Publish New Version");
  });

  it("non-owner sees View Terms but never an edit/publish action", async () => {
    mockedFetch.mockResolvedValue(makeTerms());
    const tree = await renderSection({ tripId: "trip-1", isOwner: false });
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("View Terms");
    expect(text).not.toContain("Edit / Publish New Version");
  });

  it("a fetch error never exposes raw details, and offers a retry", async () => {
    mockedFetch.mockRejectedValue(new Error("corrupt pointer internal detail"));
    const tree = await renderSection({ tripId: "trip-1", isOwner: true });
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).not.toContain("corrupt pointer internal detail");
    expect(text).toContain("retry");
  });
});

describe("TripTermsSection - refetch on regained focus (review fix)", () => {
  it("fetches once on initial focus, then refetches and displays the new version when the screen regains focus", async () => {
    mockedFetch.mockResolvedValueOnce(makeTerms({ version: 1 }));
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TripTermsSection tripId="trip-1" isOwner={false} />);
    });
    expect(collectText(tree.toJSON() as JsonNode)).toContain("Version 1");
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    // Simulate: Trip Detail -> Terms route -> publish -> Back -> Trip
    // Detail regains focus.
    mockedFetch.mockResolvedValueOnce(makeTerms({ version: 2 }));
    await act(async () => {
      mockFocusEffectCallback?.();
    });

    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(collectText(tree.toJSON() as JsonNode)).toContain("Version 2");
  });

  it("retry still works independently of the focus mechanism", async () => {
    mockedFetch.mockRejectedValueOnce(new Error("network blip"));
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TripTermsSection tripId="trip-1" isOwner={true} />);
    });
    expect(collectText(tree.toJSON() as JsonNode)).toContain("retry");

    mockedFetch.mockResolvedValueOnce(makeTerms({ version: 5 }));
    const retryHandle = findRetryHandler(tree);
    await act(async () => {
      retryHandle();
    });

    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(collectText(tree.toJSON() as JsonNode)).toContain("Version 5");
  });
});

type Instance = { props: Record<string, unknown> };
type RootLike = { root: { findAllByProps: (props: Record<string, unknown>) => Instance[] } };

function findRetryHandler(tree: ReturnType<typeof create>): () => void {
  const root = (tree as unknown as RootLike).root;
  const matches = root.findAllByProps({ accessibilityLabel: "Retry loading Trip Terms" });
  const match = matches.find((m) => typeof m.props.onPress === "function");
  if (!match) throw new Error("No retry Pressable found");
  return match.props.onPress as () => void;
}
