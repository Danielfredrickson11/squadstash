// Presentation + logic tests for TripTermsEditor (Checkpoint 6.3).
// Mirrors components/trips/__tests__/TripMembersSection.test.tsx's own
// react-test-renderer tree-walk convention (no new test dependency, no
// @testing-library/react-native). The one Firebase-touching dependency
// (publishTripTerms) is mocked at the module boundary.
import React from "react";
import { act, create } from "react-test-renderer";

import {
  MAX_FIELD_LENGTH,
  TERMS_FIELD_DEFS,
  TripTermsEditor,
} from "../TripTermsEditor";
import { publishTripTerms } from "../../../src/services/firebase/tripTerms";
import type { TripTerms } from "../../../src/types/domain";

jest.mock("../../../src/services/firebase/tripTerms", () => ({
  publishTripTerms: jest.fn(),
}));

const mockedPublish = publishTripTerms as jest.MockedFunction<typeof publishTripTerms>;

type Instance = { props: Record<string, unknown> };
type RootLike = { root: { findAllByProps: (props: Record<string, unknown>) => Instance[] } };

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

function findByLabel(tree: ReturnType<typeof create>, accessibilityLabel: string): Instance {
  const root = (tree as unknown as RootLike).root;
  const matches = root.findAllByProps({ accessibilityLabel });
  if (matches.length === 0) {
    throw new Error(`No instance found with accessibilityLabel "${accessibilityLabel}"`);
  }
  return matches[0];
}

function makeTerms(overrides: Partial<TripTerms> = {}): TripTerms {
  return {
    id: "terms-1",
    tripId: "trip-1",
    version: 2,
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

function renderEditor(props: Partial<React.ComponentProps<typeof TripTermsEditor>> = {}) {
  const defaults: React.ComponentProps<typeof TripTermsEditor> = {
    tripId: "trip-1",
    initialTerms: null,
    isArchived: false,
    onCancel: jest.fn(),
    onPublished: jest.fn(),
  };
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<TripTermsEditor {...defaults} {...props} />);
  });
  return tree;
}

function setField(tree: ReturnType<typeof create>, label: string, value: string) {
  const input = findByLabel(tree, label);
  act(() => {
    (input.props.onChangeText as (text: string) => void)(value);
  });
}

function fillAllFields(tree: ReturnType<typeof create>, value: string) {
  TERMS_FIELD_DEFS.forEach(({ label }) => setField(tree, label, value));
}

beforeEach(() => {
  mockedPublish.mockReset();
});

describe("TripTermsEditor - prepopulation", () => {
  it("renders all five current fields' values when editing existing terms", () => {
    const terms = makeTerms();
    const tree = renderEditor({ initialTerms: terms });
    TERMS_FIELD_DEFS.forEach(({ key, label }) => {
      const input = findByLabel(tree, label);
      expect(input.props.value).toBe(terms[key]);
    });
  });

  it("starts with empty fields when there are no current terms", () => {
    const tree = renderEditor({ initialTerms: null });
    TERMS_FIELD_DEFS.forEach(({ label }) => {
      const input = findByLabel(tree, label);
      expect(input.props.value).toBe("");
    });
  });
});

describe("TripTermsEditor - validation", () => {
  it("Review Terms is disabled while any field is blank", () => {
    const tree = renderEditor();
    fillAllFields(tree, "Some real content.");
    setField(tree, "Settlement Expectations", "");
    const reviewBtn = findByLabel(tree, "Review Terms");
    expect(reviewBtn.props.disabled).toBe(true);
  });

  it("whitespace-only field blocks Review Terms", () => {
    const tree = renderEditor();
    fillAllFields(tree, "Some real content.");
    setField(tree, "Settlement Expectations", "    ");
    const reviewBtn = findByLabel(tree, "Review Terms");
    expect(reviewBtn.props.disabled).toBe(true);
  });

  it("exactly 2,000 characters is accepted", () => {
    const tree = renderEditor();
    fillAllFields(tree, "x".repeat(MAX_FIELD_LENGTH));
    const reviewBtn = findByLabel(tree, "Review Terms");
    expect(reviewBtn.props.disabled).toBe(false);
  });

  it("2,001 characters blocks Review Terms", () => {
    const tree = renderEditor();
    fillAllFields(tree, "x".repeat(MAX_FIELD_LENGTH + 1));
    const reviewBtn = findByLabel(tree, "Review Terms");
    expect(reviewBtn.props.disabled).toBe(true);
  });
});

describe("TripTermsEditor - review flow", () => {
  it("trims leading/trailing whitespace before entering Review, and Review shows the normalized values", () => {
    const tree = renderEditor();
    fillAllFields(tree, "  padded value  ");
    act(() => {
      (findByLabel(tree, "Review Terms").props.onPress as () => void)();
    });
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("padded value");
    expect(text).not.toContain("  padded value  ");
  });

  it("Review shows the correct next-version message", () => {
    const tree = renderEditor({ initialTerms: makeTerms({ version: 2 }) });
    fillAllFields(tree, "Updated content.");
    act(() => {
      (findByLabel(tree, "Review Terms").props.onPress as () => void)();
    });
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("Version 3 will become the current Trip Terms");
  });

  it("Back returns to editing without publishing", () => {
    const tree = renderEditor();
    fillAllFields(tree, "Some content.");
    act(() => {
      (findByLabel(tree, "Review Terms").props.onPress as () => void)();
    });
    act(() => {
      (findByLabel(tree, "Back").props.onPress as () => void)();
    });
    expect(mockedPublish).not.toHaveBeenCalled();
    // Back in edit mode - the five inputs are present again, prepopulated
    // with the normalized values from before Review.
    const input = findByLabel(tree, "Contribution Expectations");
    expect(input.props.value).toBe("Some content.");
  });
});

describe("TripTermsEditor - publish flow", () => {
  async function reviewAndPublish(tree: ReturnType<typeof create>) {
    act(() => {
      (findByLabel(tree, "Review Terms").props.onPress as () => void)();
    });
    await act(async () => {
      await (findByLabel(tree, "Publish Terms").props.onPress as () => Promise<void>)();
    });
  }

  it("Publish calls publishTripTerms exactly once with the correct five trimmed values", async () => {
    mockedPublish.mockResolvedValue({ id: "new-terms-id", version: 1 });
    const tree = renderEditor({ tripId: "trip-42" });
    TERMS_FIELD_DEFS.forEach(({ label }) => setField(tree, label, `  value for ${label}  `));

    await reviewAndPublish(tree);

    expect(mockedPublish).toHaveBeenCalledTimes(1);
    const [[input]] = mockedPublish.mock.calls;
    expect(input.tripId).toBe("trip-42");
    TERMS_FIELD_DEFS.forEach(({ key, label }) => {
      expect((input as Record<string, unknown>)[key]).toBe(`value for ${label}`);
    });
  });

  it("successful publication calls onPublished with the server's result", async () => {
    mockedPublish.mockResolvedValue({ id: "new-terms-id", version: 4 });
    const onPublished = jest.fn();
    const tree = renderEditor({ onPublished });
    fillAllFields(tree, "Content for all fields.");

    await reviewAndPublish(tree);

    expect(onPublished).toHaveBeenCalledWith({ id: "new-terms-id", version: 4 });
  });

  it("publish controls are disabled while the request is in flight", async () => {
    let resolvePublish!: (value: { id: string; version: number }) => void;
    mockedPublish.mockImplementation(
      () => new Promise((resolve) => (resolvePublish = resolve))
    );
    const tree = renderEditor();
    fillAllFields(tree, "Content for all fields.");
    act(() => {
      (findByLabel(tree, "Review Terms").props.onPress as () => void)();
    });

    let publishPromise!: Promise<void>;
    act(() => {
      publishPromise = (
        findByLabel(tree, "Publish Terms").props.onPress as () => Promise<void>
      )();
    });

    expect(findByLabel(tree, "Publish Terms").props.disabled).toBe(true);
    expect(findByLabel(tree, "Back").props.disabled).toBe(true);

    await act(async () => {
      resolvePublish({ id: "x", version: 1 });
      await publishPromise;
    });
  });

  it("maps a permission-denied backend error to the correct user-facing message", async () => {
    mockedPublish.mockRejectedValue({ code: "functions/permission-denied" });
    const tree = renderEditor();
    fillAllFields(tree, "Content for all fields.");

    await reviewAndPublish(tree);

    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("Only the trip owner can publish Trip Terms.");
  });

  it("maps a failed-precondition error on an archived trip to the archived-specific message", async () => {
    mockedPublish.mockRejectedValue({ code: "functions/failed-precondition" });
    const tree = renderEditor({ isArchived: true });
    fillAllFields(tree, "Content for all fields.");

    await reviewAndPublish(tree);

    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("This trip is archived and can no longer publish new terms.");
  });

  it("maps a failed-precondition error on a non-archived trip to the generic corruption-safe message, never raw details", async () => {
    mockedPublish.mockRejectedValue({ code: "functions/failed-precondition" });
    const tree = renderEditor({ isArchived: false });
    fillAllFields(tree, "Content for all fields.");

    await reviewAndPublish(tree);

    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("We couldn't load the current Trip Terms safely");
  });

  it("an unknown error never leaks raw internal details", async () => {
    mockedPublish.mockRejectedValue(new Error("internal firestore detail xyz"));
    const tree = renderEditor();
    fillAllFields(tree, "Content for all fields.");

    await reviewAndPublish(tree);

    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).not.toContain("internal firestore detail xyz");
    expect(text).toContain("Something went wrong publishing Trip Terms");
  });
});
