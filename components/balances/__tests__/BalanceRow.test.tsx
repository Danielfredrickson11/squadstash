// Presentation-only tests for BalanceRow (Checkpoint 4E.5). Mirrors
// components/__tests__/StyledText-test.js's own react-test-renderer
// convention (no new test dependency, no @testing-library/react-native)
// - a plain toJSON() tree walk is enough to prove this component's
// contract without snapshotting the whole tree.
import React from "react";
import { act, create } from "react-test-renderer";

import { BalanceRow } from "../BalanceRow";

// react-test-renderer ships no bundled/@types declaration for its JSON
// tree shape in this project - a small local type is enough for what
// this test actually inspects (props + children), never `any`.
type JsonNode = {
  props: Record<string, unknown>;
  children: (JsonNode | string)[] | null;
};

function renderRow(props: React.ComponentProps<typeof BalanceRow>) {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<BalanceRow {...props} />);
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

const baseProps: React.ComponentProps<typeof BalanceRow> = {
  from: { avatarLabel: "DL", nameLabel: "Daniel" },
  to: { nameLabel: "Sarah" },
  amountMinor: 2450,
};

describe("BalanceRow", () => {
  it('renders "<from> owes <to>"', () => {
    const text = collectText(renderRow(baseProps).toJSON() as JsonNode);
    expect(text).toContain("Daniel");
    expect(text).toContain("owes");
    expect(text).toContain("Sarah");
  });

  it("renders the formatted amount", () => {
    const text = collectText(renderRow(baseProps).toJSON() as JsonNode);
    expect(text).toContain("$24.50");
  });

  it("is not a button - no interactive accessibilityRole", () => {
    const root = renderRow(baseProps).toJSON() as JsonNode;
    expect(root.props.accessibilityRole).toBeUndefined();
  });

  it("accessibility label includes the resolved names and amount, never a raw uid", () => {
    const root = renderRow(baseProps).toJSON() as JsonNode;
    expect(root.props.accessibilityLabel).toBe("Daniel owes Sarah $24.50");
  });

  it("the identity line uses numberOfLines={1} for long-name truncation", () => {
    const tree = renderRow({
      ...baseProps,
      from: { avatarLabel: "AA", nameLabel: "A".repeat(80) },
    });
    expect(anyNodeHasNumberOfLinesOne(tree.toJSON() as JsonNode)).toBe(true);
  });
});
