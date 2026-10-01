// Presentation-only tests for ReverseSettlementDialog (Checkpoint 4E.7).
// Mirrors components/balances/__tests__/RecordSettlementDialog.test.tsx's
// own react-test-renderer tree-walk convention (no new test dependency,
// no @testing-library/react-native).
import React from "react";
import { act, create } from "react-test-renderer";

import { ReverseSettlementDialog } from "../ReverseSettlementDialog";
import { lightColors } from "../../../src/theme/tokens";

type JsonNode = {
  props: Record<string, unknown>;
  children: (JsonNode | string)[] | null;
};

type Instance = { props: Record<string, unknown> };
type RootLike = {
  root: {
    findAllByProps: (props: Record<string, unknown>) => Instance[];
  };
};

function renderDialog(props: React.ComponentProps<typeof ReverseSettlementDialog>) {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<ReverseSettlementDialog {...props} />);
  });
  return tree;
}

function collectText(node: JsonNode | string | (JsonNode | string)[] | null): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(collectText).join("");
  return collectText(node.children);
}

function findAll(
  node: JsonNode | string | (JsonNode | string)[] | null,
  predicate: (n: JsonNode) => boolean
): JsonNode[] {
  if (!node || typeof node === "string") return [];
  if (Array.isArray(node)) return node.flatMap((n) => findAll(n, predicate));
  const results = predicate(node) ? [node] : [];
  return results.concat(findAll(node.children, predicate));
}

function findPressable(tree: ReturnType<typeof create>, matchProps: Record<string, unknown>): Instance {
  const root = (tree as unknown as RootLike).root;
  const matches = root.findAllByProps(matchProps);
  const pressable = matches.find((m) => typeof m.props.onPress === "function");
  if (!pressable) {
    throw new Error(`No Pressable instance found matching ${JSON.stringify(matchProps)}`);
  }
  return pressable;
}

const baseProps: React.ComponentProps<typeof ReverseSettlementDialog> = {
  visible: true,
  fromNameLabel: "Daniel",
  toNameLabel: "Sarah",
  amountMinor: 2450,
  reasonText: "",
  onChangeReasonText: jest.fn(),
  submitting: false,
  submitError: null,
  onCancel: jest.fn(),
  onConfirm: jest.fn(),
  colors: lightColors,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("ReverseSettlementDialog - structure", () => {
  it('renders the title "Reverse settlement?"', () => {
    const text = collectText(renderDialog(baseProps).toJSON() as JsonNode);
    expect(text).toContain("Reverse settlement?");
  });

  it("renders the safe resolved pair summary (never a raw uid)", () => {
    const text = collectText(renderDialog(baseProps).toJSON() as JsonNode);
    expect(text).toContain("Daniel paid Sarah");
  });

  it("renders the formatted amount", () => {
    const text = collectText(renderDialog(baseProps).toJSON() as JsonNode);
    expect(text).toContain("$24.50");
  });

  it("renders the historical/non-delete explanation", () => {
    const text = collectText(renderDialog(baseProps).toJSON() as JsonNode);
    expect(text).toContain("nothing is deleted");
  });

  it("renders the optional reason field", () => {
    const json = renderDialog(baseProps).toJSON() as JsonNode;
    const reasonFields = findAll(json, (n) => n.props?.placeholder === "What happened?");
    expect(reasonFields.length).toBeGreaterThan(0);
  });

  // Checkpoint 4E.8 §10: a visual `label` alone does not create an
  // accessible name for a React Native TextInput - explicit
  // accessibilityLabel required.
  it("the reason field has an explicit accessible name", () => {
    const json = renderDialog(baseProps).toJSON() as JsonNode;
    const reasonFields = findAll(
      json,
      (n) =>
        n.props?.placeholder === "What happened?" &&
        n.props?.accessibilityLabel === "Reason (optional)"
    );
    expect(reasonFields.length).toBeGreaterThan(0);
  });
});

describe("ReverseSettlementDialog - actions", () => {
  it("Cancel invokes onCancel when idle", () => {
    const onCancel = jest.fn();
    const tree = renderDialog({ ...baseProps, onCancel });
    const cancel = findPressable(tree, { accessibilityLabel: "Cancel" });
    act(() => {
      (cancel.props.onPress as () => void)();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("the backdrop invokes onCancel when idle", () => {
    const onCancel = jest.fn();
    const tree = renderDialog({ ...baseProps, onCancel });
    const backdrop = findPressable(tree, { accessibilityLabel: "Close" });
    act(() => {
      (backdrop.props.onPress as () => void)();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("confirm invokes onConfirm", () => {
    const onConfirm = jest.fn();
    const tree = renderDialog({ ...baseProps, onConfirm });
    const confirm = findPressable(tree, { accessibilityLabel: "Reverse settlement" });
    act(() => {
      (confirm.props.onPress as () => void)();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("submitting blocks Cancel", () => {
    const onCancel = jest.fn();
    const tree = renderDialog({ ...baseProps, submitting: true, onCancel });
    const cancel = findPressable(tree, { accessibilityLabel: "Cancel" });
    act(() => {
      (cancel.props.onPress as () => void)();
    });
    expect(onCancel).not.toHaveBeenCalled();
    expect(cancel.props.disabled).toBe(true);
  });

  it("submitting blocks the backdrop", () => {
    const onCancel = jest.fn();
    const tree = renderDialog({ ...baseProps, submitting: true, onCancel });
    const backdrop = findPressable(tree, { accessibilityLabel: "Close" });
    act(() => {
      (backdrop.props.onPress as () => void)();
    });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("submitting disables confirm and shows a spinner instead of its text", () => {
    const tree = renderDialog({ ...baseProps, submitting: true });
    const confirm = findPressable(tree, { accessibilityLabel: "Reverse settlement" });
    expect(confirm.props.disabled).toBe(true);
    const text = collectText(tree.toJSON() as JsonNode);
    // "Reverse settlement?" (title) and "Reverse settlement" (button)
    // overlap textually - confirm the BUTTON's own text is absent by
    // checking the exact non-titled phrase count.
    const bareOccurrences = text.split("Reverse settlement").length - 1;
    expect(bareOccurrences).toBe(1); // only the title (as a substring) remains
  });
});

describe("ReverseSettlementDialog - error", () => {
  it("renders a supplied error", () => {
    const text = collectText(
      renderDialog({ ...baseProps, submitError: "We couldn’t reach the server." }).toJSON() as JsonNode
    );
    expect(text).toContain("We couldn’t reach the server.");
  });
});

describe("ReverseSettlementDialog - accessibility", () => {
  it("Close, Cancel, and Reverse settlement are all real buttons", () => {
    const json = renderDialog(baseProps).toJSON() as JsonNode;
    const buttons = findAll(json, (n) => n.props?.accessibilityRole === "button");
    const labels = buttons.map((b) => b.props.accessibilityLabel);
    expect(labels).toEqual(expect.arrayContaining(["Close", "Cancel", "Reverse settlement"]));
  });

  it("no button uses a destructive/alert role - every interactive control is accessibilityRole=\"button\"", () => {
    const json = renderDialog(baseProps).toJSON() as JsonNode;
    const roles = findAll(json, (n) => "accessibilityRole" in n.props).map((n) => n.props.accessibilityRole);
    roles.forEach((role) => expect(role).toBe("button"));
  });
});
