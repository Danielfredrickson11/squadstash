// Presentation-only tests for BalanceRow (Checkpoint 4E.5, extended
// 4E.6 for the optional Settle Up action). Mirrors
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

// Depth-first collection of every node (at any depth) matching a
// predicate - used below to find the debt's own accessible group and
// the Settle Up button independently of exactly how deep either sits in
// the tree.
function findAll(
  node: JsonNode | string | (JsonNode | string)[] | null,
  predicate: (n: JsonNode) => boolean
): JsonNode[] {
  if (!node || typeof node === "string") return [];
  if (Array.isArray(node)) return node.flatMap((n) => findAll(n, predicate));
  const results = predicate(node) ? [node] : [];
  return results.concat(findAll(node.children, predicate));
}

// react-native's Pressable itself defaults `accessible` to true, so a
// plain `accessible === true` match would also catch the Settle Up
// button's own host node - excluding accessibilityRole:"button"
// disambiguates the debt row's OWN accessible group from it.
function findAccessibleDebtGroup(json: JsonNode): JsonNode {
  const groups = findAll(
    json,
    (n) => n.props?.accessible === true && n.props?.accessibilityRole !== "button"
  );
  if (groups.length !== 1) {
    throw new Error(`Expected exactly one accessible debt group, found ${groups.length}`);
  }
  return groups[0];
}

const baseProps: React.ComponentProps<typeof BalanceRow> = {
  from: { avatarLabel: "DL", nameLabel: "Daniel" },
  to: { nameLabel: "Sarah" },
  amountMinor: 2450,
};

describe("BalanceRow - read-only debt presentation", () => {
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

  it("is not a button - no interactive accessibilityRole when onSettleUp is omitted", () => {
    const json = renderRow(baseProps).toJSON() as JsonNode;
    const buttons = findAll(json, (n) => n.props?.accessibilityRole === "button");
    expect(buttons).toHaveLength(0);
  });

  it("accessibility label includes the resolved names and amount, never a raw uid", () => {
    const json = renderRow(baseProps).toJSON() as JsonNode;
    const debtGroup = findAccessibleDebtGroup(json);
    expect(debtGroup.props.accessibilityLabel).toBe("Daniel owes Sarah $24.50");
  });

  it("the identity line uses numberOfLines={1} for long-name truncation", () => {
    const tree = renderRow({
      ...baseProps,
      from: { avatarLabel: "AA", nameLabel: "A".repeat(80) },
    });
    expect(anyNodeHasNumberOfLinesOne(tree.toJSON() as JsonNode)).toBe(true);
  });
});

describe("BalanceRow - optional Settle Up action (Checkpoint 4E.6)", () => {
  it("no Settle Up button renders when the callback is omitted", () => {
    const json = renderRow(baseProps).toJSON() as JsonNode;
    const buttons = findAll(json, (n) => n.props?.accessibilityRole === "button");
    expect(buttons).toHaveLength(0);
  });

  it("Settle Up appears when the callback is supplied", () => {
    const onSettleUp = jest.fn();
    const json = renderRow({ ...baseProps, onSettleUp }).toJSON() as JsonNode;
    const buttons = findAll(json, (n) => n.props?.accessibilityRole === "button");
    expect(buttons).toHaveLength(1);
  });

  it("pressing Settle Up invokes the callback exactly once", () => {
    const onSettleUp = jest.fn();
    const tree = renderRow({ ...baseProps, onSettleUp });
    // Pressable's `onPress` is never forwarded onto the host node it
    // renders down to, so the reliable way to simulate a press is to
    // find the REACT instance that actually carries an `onPress` prop -
    // there is exactly one such instance (this component's single
    // Pressable) among every accessibilityRole:"button"-matching
    // instance. `.root` isn't declared by this project's own
    // react-test-renderer typings, so it's accessed through a small
    // local shape rather than `any`.
    const root = tree as unknown as {
      root: { findAllByProps: (props: Record<string, unknown>) => { props: Record<string, unknown> }[] };
    };
    const matches = root.root.findAllByProps({ accessibilityRole: "button" });
    const pressable = matches.find((m) => typeof m.props.onPress === "function");
    if (!pressable) throw new Error("No Pressable instance with an onPress prop was found.");
    act(() => {
      (pressable.props.onPress as () => void)();
    });
    expect(onSettleUp).toHaveBeenCalledTimes(1);
  });

  it('the button has accessibilityRole="button"', () => {
    const json = renderRow({ ...baseProps, onSettleUp: jest.fn() }).toJSON() as JsonNode;
    const buttons = findAll(json, (n) => n.props?.accessibilityRole === "button");
    expect(buttons[0].props.accessibilityRole).toBe("button");
  });

  it("the button uses the supplied safe accessibility label when provided", () => {
    const json = renderRow({
      ...baseProps,
      onSettleUp: jest.fn(),
      settleUpAccessibilityLabel: "Settle up with Daniel",
    }).toJSON() as JsonNode;
    const buttons = findAll(json, (n) => n.props?.accessibilityRole === "button");
    expect(buttons[0].props.accessibilityLabel).toBe("Settle up with Daniel");
  });

  it("falls back to a safe generated label (never a raw uid) when none is supplied", () => {
    const json = renderRow({ ...baseProps, onSettleUp: jest.fn() }).toJSON() as JsonNode;
    const buttons = findAll(json, (n) => n.props?.accessibilityRole === "button");
    expect(buttons[0].props.accessibilityLabel).toBe("Settle up with Daniel");
  });

  it("the interactive version does not nest the Settle Up button inside the debt's accessible group", () => {
    const json = renderRow({ ...baseProps, onSettleUp: jest.fn() }).toJSON() as JsonNode;
    const debtGroup = findAccessibleDebtGroup(json);
    const buttonsInsideDebtGroup = findAll(debtGroup.children, (n) => n.props?.accessibilityRole === "button");
    expect(buttonsInsideDebtGroup).toHaveLength(0);
  });

  it("existing debt text/amount still render when Settle Up is present", () => {
    const json = renderRow({ ...baseProps, onSettleUp: jest.fn() }).toJSON() as JsonNode;
    const text = collectText(json);
    expect(text).toContain("Daniel");
    expect(text).toContain("owes");
    expect(text).toContain("Sarah");
    expect(text).toContain("$24.50");
  });

  it("long-name one-line behavior remains intact when Settle Up is present", () => {
    const tree = renderRow({
      ...baseProps,
      from: { avatarLabel: "AA", nameLabel: "A".repeat(80) },
      onSettleUp: jest.fn(),
    });
    expect(anyNodeHasNumberOfLinesOne(tree.toJSON() as JsonNode)).toBe(true);
  });
});
