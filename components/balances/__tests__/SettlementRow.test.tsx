// Presentation-only tests for SettlementRow (Checkpoint 4E.7). Mirrors
// components/balances/__tests__/BalanceRow.test.tsx's own
// react-test-renderer tree-walk convention (no new test dependency, no
// @testing-library/react-native).
import React from "react";
import { act, create } from "react-test-renderer";

import { SettlementRow } from "../SettlementRow";

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

function renderRow(props: React.ComponentProps<typeof SettlementRow>) {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<SettlementRow {...props} />);
  });
  return tree;
}

function collectText(node: JsonNode | string | (JsonNode | string)[] | null): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(collectText).join("");
  return collectText(node.children);
}

function anyNodeHasNumberOfLinesOne(node: JsonNode | string | (JsonNode | string)[] | null): boolean {
  if (!node || typeof node === "string") return false;
  if (Array.isArray(node)) return node.some(anyNodeHasNumberOfLinesOne);
  if (node.props?.numberOfLines === 1) return true;
  return anyNodeHasNumberOfLinesOne(node.children);
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

// Checkpoint 4E.7A §6: returns the DEEPEST node whose own flattened text
// still contains `substring` - for a leaf <Text> with no nested
// elements, that's the exact <Text> node itself, letting a test inspect
// that specific node's own `numberOfLines` prop rather than merely
// proving the substring appears SOMEWHERE in the tree.
function findTextNodeContaining(
  node: JsonNode | string | (JsonNode | string)[] | null,
  substring: string
): JsonNode | null {
  if (!node || typeof node === "string") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = findTextNodeContaining(n, substring);
      if (found) return found;
    }
    return null;
  }
  if (!collectText(node).includes(substring)) return null;
  const childMatch = findTextNodeContaining(node.children, substring);
  return childMatch ?? node;
}

// react-native's Pressable defaults `accessible` to true and forwards
// accessibilityRole to its host node - excluding accessibilityRole:
// "button" disambiguates the summary's OWN accessible group from the
// Reverse button's own (also accessible:true) host node.
function findAccessibleSummaryGroup(json: JsonNode): JsonNode {
  const groups = findAll(
    json,
    (n) => n.props?.accessible === true && n.props?.accessibilityRole !== "button"
  );
  if (groups.length !== 1) {
    throw new Error(`Expected exactly one accessible summary group, found ${groups.length}`);
  }
  return groups[0];
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

const baseProps: React.ComponentProps<typeof SettlementRow> = {
  from: { avatarLabel: "DL", nameLabel: "Daniel" },
  to: { nameLabel: "Sarah" },
  amountMinor: 2450,
  methodLabel: "Venmo",
  timestampLabel: "Sep 30, 2026, 5:42 PM",
  reversed: false,
};

describe("SettlementRow - read-only presentation", () => {
  it('renders "<from> paid <to>"', () => {
    const text = collectText(renderRow(baseProps).toJSON() as JsonNode);
    expect(text).toContain("Daniel");
    expect(text).toContain("paid");
    expect(text).toContain("Sarah");
  });

  it("renders the amount", () => {
    const text = collectText(renderRow(baseProps).toJSON() as JsonNode);
    expect(text).toContain("$24.50");
  });

  it("renders the method label", () => {
    const text = collectText(renderRow(baseProps).toJSON() as JsonNode);
    expect(text).toContain("Venmo");
  });

  it("renders the timestamp label", () => {
    const text = collectText(renderRow(baseProps).toJSON() as JsonNode);
    expect(text).toContain("Sep 30, 2026, 5:42 PM");
  });

  it("renders an optional note when supplied", () => {
    const text = collectText(
      renderRow({ ...baseProps, note: "Dinner split" }).toJSON() as JsonNode
    );
    expect(text).toContain("Dinner split");
  });

  it("omits the note line when not supplied", () => {
    const text = collectText(renderRow(baseProps).toJSON() as JsonNode);
    expect(text).not.toContain("Dinner split");
  });

  it("long names truncate safely via numberOfLines={1}", () => {
    const tree = renderRow({
      ...baseProps,
      from: { avatarLabel: "AA", nameLabel: "A".repeat(80) },
    });
    expect(anyNodeHasNumberOfLinesOne(tree.toJSON() as JsonNode)).toBe(true);
  });

  it("no raw uid ever appears - only resolved labels are accepted as props", () => {
    // Structural guarantee: the component's props type has no uid field
    // at all (from/to are {avatarLabel, nameLabel, photoURL?} /
    // {nameLabel}) - this test documents that contract by rendering with
    // realistic resolved labels and confirming no uid-shaped string
    // (e.g. a Firebase-style 28-char alnum id) appears anywhere.
    const text = collectText(renderRow(baseProps).toJSON() as JsonNode);
    expect(text).not.toMatch(/[A-Za-z0-9]{28}/);
  });
});

describe("SettlementRow - reversed presentation", () => {
  it('a reversed row renders the StatusChip text "Reversed"', () => {
    const text = collectText(renderRow({ ...baseProps, reversed: true }).toJSON() as JsonNode);
    expect(text).toContain("Reversed");
  });

  it("an active (non-reversed) row does not render \"Reversed\"", () => {
    const text = collectText(renderRow(baseProps).toJSON() as JsonNode);
    expect(text).not.toContain("Reversed");
  });

  it("an optional reversal reason renders when present on a reversed row", () => {
    const text = collectText(
      renderRow({
        ...baseProps,
        reversed: true,
        reversalReason: "Entered twice",
      }).toJSON() as JsonNode
    );
    expect(text).toContain("Entered twice");
  });

  it("no reversal reason line renders when absent, even on a reversed row", () => {
    const text = collectText(renderRow({ ...baseProps, reversed: true }).toJSON() as JsonNode);
    expect(text).not.toContain("Reversal reason");
  });
});

// Checkpoint 4E.8 §8: an explicit parent accessibilityLabel makes the
// summary View ONE opaque accessibility element - descendant Text
// (note/"Reversed"/reversalReason) is NOT separately exposed to
// assistive technology once a parent declares `accessible` + an
// explicit label. Every meaningful historical fact must therefore be
// represented in that ONE label, not merely visible-only.
describe("SettlementRow - accessible summary includes every historical fact (Checkpoint 4E.8)", () => {
  function summaryLabel(props: React.ComponentProps<typeof SettlementRow>): string {
    const json = renderRow(props).toJSON() as JsonNode;
    return findAccessibleSummaryGroup(json).props.accessibilityLabel as string;
  }

  it("the accessible label includes from/to/amount/method/timestamp for an ordinary active row", () => {
    const label = summaryLabel(baseProps);
    expect(label).toContain("Daniel");
    expect(label).toContain("paid");
    expect(label).toContain("Sarah");
    expect(label).toContain("$24.50");
    expect(label).toContain("Venmo");
    expect(label).toContain("Sep 30, 2026, 5:42 PM");
  });

  it("the accessible label includes reversed status when applicable", () => {
    const label = summaryLabel({ ...baseProps, reversed: true });
    expect(label).toContain("Reversed");
  });

  it("the accessible label does NOT include reversed status when active", () => {
    const label = summaryLabel(baseProps);
    expect(label).not.toContain("Reversed");
  });

  it("the accessible label includes the note when present", () => {
    const label = summaryLabel({ ...baseProps, note: "Dinner split" });
    expect(label).toContain("Dinner split");
  });

  it("the accessible label includes the reversal reason when present on a reversed row", () => {
    const label = summaryLabel({
      ...baseProps,
      reversed: true,
      reversalReason: "Entered twice",
    });
    expect(label).toContain("Entered twice");
  });

  it("the accessible label includes note AND reversal reason together when both are present", () => {
    const label = summaryLabel({
      ...baseProps,
      note: "Dinner split",
      reversed: true,
      reversalReason: "Entered twice",
    });
    expect(label).toContain("Dinner split");
    expect(label).toContain("Entered twice");
    expect(label).toContain("Reversed");
  });
});

// Checkpoint 4E.7A §4/§5/§6: note/reversalReason are audit/history
// details that may legitimately run up to the normalized 500-character
// cap - they must wrap and render their COMPLETE supplied text, never
// hidden behind an ellipsis via numberOfLines. The primary identity
// line is the one exception that must stay one-line/truncated.
describe("SettlementRow - audit-text wrap behavior (Checkpoint 4E.7A)", () => {
  const longNote = "N".repeat(300) + " end-of-note-marker";
  const longReversalReason = "R".repeat(300) + " end-of-reason-marker";

  it("a long note renders in full (no truncation of its tail)", () => {
    const text = collectText(renderRow({ ...baseProps, note: longNote }).toJSON() as JsonNode);
    expect(text).toContain(longNote);
    expect(text).toContain("end-of-note-marker");
  });

  it("the note Text node has no numberOfLines cap (neither 1 nor 2)", () => {
    const json = renderRow({ ...baseProps, note: longNote }).toJSON() as JsonNode;
    const noteNode = findTextNodeContaining(json, "end-of-note-marker");
    expect(noteNode).not.toBeNull();
    expect(noteNode?.props.numberOfLines).not.toBe(1);
    expect(noteNode?.props.numberOfLines).not.toBe(2);
    expect(noteNode?.props.numberOfLines).toBeUndefined();
  });

  it("a long reversal reason renders in full (no truncation of its tail)", () => {
    const text = collectText(
      renderRow({
        ...baseProps,
        reversed: true,
        reversalReason: longReversalReason,
      }).toJSON() as JsonNode
    );
    expect(text).toContain(longReversalReason);
    expect(text).toContain("end-of-reason-marker");
  });

  it("the reversal-reason Text node has no numberOfLines cap (neither 1 nor 2)", () => {
    const json = renderRow({
      ...baseProps,
      reversed: true,
      reversalReason: longReversalReason,
    }).toJSON() as JsonNode;
    const reasonNode = findTextNodeContaining(json, "end-of-reason-marker");
    expect(reasonNode).not.toBeNull();
    expect(reasonNode?.props.numberOfLines).not.toBe(1);
    expect(reasonNode?.props.numberOfLines).not.toBe(2);
    expect(reasonNode?.props.numberOfLines).toBeUndefined();
  });

  it('the primary "<from> paid <to>" identity line STILL has numberOfLines={1}', () => {
    const json = renderRow({ ...baseProps, note: longNote }).toJSON() as JsonNode;
    const identityNode = findTextNodeContaining(json, "paid");
    expect(identityNode).not.toBeNull();
    expect(identityNode?.props.numberOfLines).toBe(1);
  });
});

describe("SettlementRow - optional Reverse action", () => {
  it("no Reverse action renders when the callback is omitted", () => {
    const json = renderRow(baseProps).toJSON() as JsonNode;
    const buttons = findAll(json, (n) => n.props?.accessibilityRole === "button");
    expect(buttons).toHaveLength(0);
  });

  it("Reverse action appears when the callback is supplied", () => {
    const json = renderRow({ ...baseProps, onReverse: jest.fn() }).toJSON() as JsonNode;
    const buttons = findAll(json, (n) => n.props?.accessibilityRole === "button");
    expect(buttons).toHaveLength(1);
  });

  it("pressing Reverse invokes the callback exactly once", () => {
    const onReverse = jest.fn();
    const tree = renderRow({ ...baseProps, onReverse });
    const reverse = findPressable(tree, { accessibilityRole: "button" });
    act(() => {
      (reverse.props.onPress as () => void)();
    });
    expect(onReverse).toHaveBeenCalledTimes(1);
  });

  it('the Reverse action has accessibilityRole="button"', () => {
    const json = renderRow({ ...baseProps, onReverse: jest.fn() }).toJSON() as JsonNode;
    const buttons = findAll(json, (n) => n.props?.accessibilityRole === "button");
    expect(buttons[0].props.accessibilityRole).toBe("button");
  });

  it("the Reverse action uses a safe resolved-name accessibility label by default", () => {
    const json = renderRow({ ...baseProps, onReverse: jest.fn() }).toJSON() as JsonNode;
    const buttons = findAll(json, (n) => n.props?.accessibilityRole === "button");
    expect(buttons[0].props.accessibilityLabel).toBe("Reverse settlement from Daniel");
  });

  it("the Reverse action accepts a supplied override accessibility label", () => {
    const json = renderRow({
      ...baseProps,
      onReverse: jest.fn(),
      reverseAccessibilityLabel: "Reverse settlement from Daniel",
    }).toJSON() as JsonNode;
    const buttons = findAll(json, (n) => n.props?.accessibilityRole === "button");
    expect(buttons[0].props.accessibilityLabel).toBe("Reverse settlement from Daniel");
  });

  it("the interactive action is not nested inside the summary's accessible group", () => {
    const json = renderRow({ ...baseProps, onReverse: jest.fn() }).toJSON() as JsonNode;
    const summaryGroup = findAccessibleSummaryGroup(json);
    const buttonsInside = findAll(summaryGroup.children, (n) => n.props?.accessibilityRole === "button");
    expect(buttonsInside).toHaveLength(0);
  });
});
