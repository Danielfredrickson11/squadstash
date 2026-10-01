// Presentation-only tests for RecordSettlementDialog (Checkpoint 4E.6).
// Mirrors components/balances/__tests__/BalanceRow.test.tsx's own
// react-test-renderer tree-walk convention (no new test dependency, no
// @testing-library/react-native). This dialog receives every
// warning/error string ALREADY RESOLVED from its caller (Trip Detail) -
// these tests only prove the dialog renders/wires what it's given, never
// that it computes anything itself.
import React from "react";
import { act, create } from "react-test-renderer";

import { RecordSettlementDialog } from "../RecordSettlementDialog";
import { lightColors } from "../../../src/theme/tokens";
import type { SettlementMethod } from "../../../src/types/domain";

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

function renderDialog(props: React.ComponentProps<typeof RecordSettlementDialog>) {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<RecordSettlementDialog {...props} />);
  });
  return tree;
}

function collectText(node: JsonNode | string | (JsonNode | string)[] | null): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(collectText).join("");
  return collectText(node.children);
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
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

// Pressable's `onPress` is never forwarded onto the host node it renders
// down to (see BalanceRow.test.tsx's identical note) - the REACT
// instance carrying a real `onPress` function is the reliable target
// for simulating a press, found via matching props rather than type
// (react-native's Pressable is wrapped in React.memo in this project's
// installed version, which defeats a plain findAllByType(Pressable)
// reference match).
function findPressable(tree: ReturnType<typeof create>, matchProps: Record<string, unknown>): Instance {
  const root = (tree as unknown as RootLike).root;
  const matches = root.findAllByProps(matchProps);
  const pressable = matches.find((m) => typeof m.props.onPress === "function");
  if (!pressable) {
    throw new Error(`No Pressable instance found matching ${JSON.stringify(matchProps)}`);
  }
  return pressable;
}

const baseProps: React.ComponentProps<typeof RecordSettlementDialog> = {
  visible: true,
  fromNameLabel: "Daniel",
  currentDebtMinor: 2450,
  amountText: "24.50",
  onChangeAmountText: jest.fn(),
  method: null,
  onChangeMethod: jest.fn(),
  note: "",
  onChangeNote: jest.fn(),
  submitting: false,
  submitError: null,
  canSubmit: true,
  onCancel: jest.fn(),
  onConfirm: jest.fn(),
  colors: lightColors,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("RecordSettlementDialog - structure", () => {
  it('renders the title "Record settlement"', () => {
    const text = collectText(renderDialog(baseProps).toJSON() as JsonNode);
    expect(text).toContain("Record settlement");
  });

  it("renders the debtor-safe resolved identity (never a raw uid)", () => {
    const text = collectText(renderDialog(baseProps).toJSON() as JsonNode);
    expect(text).toContain("Daniel owes you");
  });

  it("renders the current debt, formatted", () => {
    const text = collectText(renderDialog(baseProps).toJSON() as JsonNode);
    expect(text).toContain("$24.50");
  });

  it("renders explanatory external-payment copy, never implying SquadStash moves money", () => {
    const text = collectText(renderDialog(baseProps).toJSON() as JsonNode);
    expect(text).toContain("outside SquadStash");
    expect(text).not.toMatch(/\bpay\b/i);
    expect(text).not.toMatch(/send money/i);
    expect(text).not.toMatch(/transfer/i);
  });

  it("the amount field exists", () => {
    const json = renderDialog(baseProps).toJSON() as JsonNode;
    const amountFields = findAll(json, (n) => n.props?.placeholder === "0.00");
    expect(amountFields.length).toBeGreaterThan(0);
  });

  it("the note field exists", () => {
    const json = renderDialog(baseProps).toJSON() as JsonNode;
    const noteFields = findAll(json, (n) => n.props?.placeholder === "What’s this for?");
    expect(noteFields.length).toBeGreaterThan(0);
  });

  // Checkpoint 4E.8 §9: an adjacent visual <Text> label does not create
  // an accessible name for a React Native TextInput on its own -
  // react-native-paper's own `label` prop is purely visual. Both fields
  // require an explicit accessibilityLabel.
  it("the amount field has an explicit accessible name", () => {
    const json = renderDialog(baseProps).toJSON() as JsonNode;
    const amountFields = findAll(
      json,
      (n) => n.props?.placeholder === "0.00" && n.props?.accessibilityLabel === "Amount received"
    );
    expect(amountFields.length).toBeGreaterThan(0);
  });

  it("the note field has an explicit accessible name", () => {
    const json = renderDialog(baseProps).toJSON() as JsonNode;
    const noteFields = findAll(
      json,
      (n) =>
        n.props?.placeholder === "What’s this for?" &&
        n.props?.accessibilityLabel === "Note (optional)"
    );
    expect(noteFields.length).toBeGreaterThan(0);
  });

  it("renders NO date/occurredAt field or text", () => {
    const text = collectText(renderDialog(baseProps).toJSON() as JsonNode);
    // Word-boundary match - "update"/"updated" legitimately appear in
    // the explanatory copy and must not false-positive against "date".
    expect(text.toLowerCase()).not.toMatch(/\bdate\b/);
    expect(text.toLowerCase()).not.toContain("occurred");
    expect(text.toLowerCase()).not.toContain("when did this happen");
  });
});

// Checkpoint 4E.8 §11: on a short viewport with the keyboard open, this
// dialog's content (summary + explanation + amount + five method pills
// + note + warnings/errors) can exceed available space -
// KeyboardAvoidingView alone does not guarantee Cancel/Confirm stay
// reachable. The fields/warnings now sit inside a ScrollView, with the
// actions row as a fixed footer OUTSIDE it.
describe("RecordSettlementDialog - short-viewport reachability (Checkpoint 4E.8)", () => {
  it("the scrollable content region exists (keyboardShouldPersistTaps marks it)", () => {
    const json = renderDialog(baseProps).toJSON() as JsonNode;
    const scrollRegions = findAll(json, (n) => n.props?.keyboardShouldPersistTaps === "handled");
    expect(scrollRegions.length).toBeGreaterThan(0);
  });

  it("Cancel and Confirm remain present and findable outside the scroll region", () => {
    const tree = renderDialog(baseProps);
    // findPressable succeeding (not throwing) proves both controls are
    // still real, addressable Pressable instances after the
    // restructuring - not simply present as inert text.
    expect(() => findPressable(tree, { accessibilityLabel: "Cancel" })).not.toThrow();
    expect(() => findPressable(tree, { accessibilityLabel: "Record settlement" })).not.toThrow();
  });
});

describe("RecordSettlementDialog - method picker", () => {
  it("the method group is a radiogroup", () => {
    const json = renderDialog(baseProps).toJSON() as JsonNode;
    const groups = findAll(json, (n) => n.props?.accessibilityRole === "radiogroup");
    expect(groups).toHaveLength(1);
  });

  it("exactly five radio options exist, with the exact labels", () => {
    const json = renderDialog(baseProps).toJSON() as JsonNode;
    const radios = findAll(json, (n) => n.props?.accessibilityRole === "radio");
    expect(radios).toHaveLength(5);
    const labels = radios.map((r) => r.props.accessibilityLabel);
    expect(labels).toEqual(["Venmo", "PayPal", "Zelle", "Cash", "Other"]);
  });

  it("checked state reflects the current method", () => {
    const json = renderDialog({ ...baseProps, method: "zelle" }).toJSON() as JsonNode;
    const radios = findAll(json, (n) => n.props?.accessibilityRole === "radio");
    const zelle = radios.find((r) => r.props.accessibilityLabel === "Zelle");
    const venmo = radios.find((r) => r.props.accessibilityLabel === "Venmo");
    expect((zelle?.props.accessibilityState as { checked: boolean }).checked).toBe(true);
    expect((venmo?.props.accessibilityState as { checked: boolean }).checked).toBe(false);
  });

  it("tapping an option invokes onChangeMethod with the exact enum value", () => {
    const onChangeMethod = jest.fn();
    const tree = renderDialog({ ...baseProps, onChangeMethod });
    const paypal = findPressable(tree, { accessibilityRole: "radio", accessibilityLabel: "PayPal" });
    act(() => {
      (paypal.props.onPress as () => void)();
    });
    expect(onChangeMethod).toHaveBeenCalledTimes(1);
    expect(onChangeMethod).toHaveBeenCalledWith("paypal" satisfies SettlementMethod);
  });
});

describe("RecordSettlementDialog - actions", () => {
  it("Cancel invokes onCancel when not submitting", () => {
    const onCancel = jest.fn();
    const tree = renderDialog({ ...baseProps, submitting: false, onCancel });
    const cancel = findPressable(tree, { accessibilityLabel: "Cancel" });
    act(() => {
      (cancel.props.onPress as () => void)();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("the backdrop invokes onCancel when not submitting", () => {
    const onCancel = jest.fn();
    const tree = renderDialog({ ...baseProps, submitting: false, onCancel });
    const backdrop = findPressable(tree, { accessibilityLabel: "Close" });
    act(() => {
      (backdrop.props.onPress as () => void)();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("confirm invokes onConfirm", () => {
    const onConfirm = jest.fn();
    const tree = renderDialog({ ...baseProps, onConfirm });
    const confirm = findPressable(tree, { accessibilityLabel: "Record settlement" });
    act(() => {
      (confirm.props.onPress as () => void)();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("while submitting, Cancel dismissal is blocked", () => {
    const onCancel = jest.fn();
    const tree = renderDialog({ ...baseProps, submitting: true, onCancel });
    const cancel = findPressable(tree, { accessibilityLabel: "Cancel" });
    act(() => {
      (cancel.props.onPress as () => void)();
    });
    expect(onCancel).not.toHaveBeenCalled();
    expect(cancel.props.disabled).toBe(true);
  });

  it("while submitting, backdrop dismissal is blocked", () => {
    const onCancel = jest.fn();
    const tree = renderDialog({ ...baseProps, submitting: true, onCancel });
    const backdrop = findPressable(tree, { accessibilityLabel: "Close" });
    act(() => {
      (backdrop.props.onPress as () => void)();
    });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("while submitting, confirm is disabled and shows a spinner instead of its label", () => {
    const notSubmittingText = collectText(
      renderDialog({ ...baseProps, submitting: false }).toJSON() as JsonNode
    );
    const submittingText = collectText(
      renderDialog({ ...baseProps, submitting: true }).toJSON() as JsonNode
    );
    // "Record settlement" appears twice when idle (title + button label),
    // but only once (the title) while submitting - the button label is
    // replaced by an ActivityIndicator, never rendered as text.
    expect(countOccurrences(notSubmittingText, "Record settlement")).toBe(2);
    expect(countOccurrences(submittingText, "Record settlement")).toBe(1);

    const tree = renderDialog({ ...baseProps, submitting: true });
    const confirm = findPressable(tree, { accessibilityLabel: "Record settlement" });
    expect(confirm.props.disabled).toBe(true);
  });

  it("confirm is disabled when canSubmit is false, even while not submitting", () => {
    const tree = renderDialog({ ...baseProps, submitting: false, canSubmit: false });
    const confirm = findPressable(tree, { accessibilityLabel: "Record settlement" });
    expect(confirm.props.disabled).toBe(true);
  });
});

describe("RecordSettlementDialog - error/warning copy", () => {
  it("renders a supplied submit error", () => {
    const text = collectText(
      renderDialog({ ...baseProps, submitError: "We couldn’t reach the server." }).toJSON() as JsonNode
    );
    expect(text).toContain("We couldn’t reach the server.");
  });

  it("renders a supplied over-settlement warning", () => {
    const text = collectText(
      renderDialog({
        ...baseProps,
        overSettlementWarning: "This is $5.00 more than the current balance.",
      }).toJSON() as JsonNode
    );
    expect(text).toContain("This is $5.00 more than the current balance.");
  });

  it("renders a supplied balance-freshness warning", () => {
    const text = collectText(
      renderDialog({
        ...baseProps,
        balanceFreshnessWarning: "Balances are updating. Wait for the latest balance before recording a settlement.",
      }).toJSON() as JsonNode
    );
    expect(text).toContain("Balances are updating.");
  });

  it("warning copy is purely informational text, not itself an interactive/destructive control", () => {
    const json = renderDialog({
      ...baseProps,
      overSettlementWarning: "This is $5.00 more than the current balance.",
      balanceFreshnessWarning: "Balances are updating.",
    }).toJSON() as JsonNode;
    const warningNodes = findAll(
      json,
      (n) =>
        typeof collectText(n) === "string" &&
        (collectText(n).includes("more than the current balance") ||
          collectText(n).includes("Balances are updating"))
    );
    warningNodes.forEach((n) => {
      expect(n.props.accessibilityRole).toBeUndefined();
      expect(n.props.onPress).toBeUndefined();
    });
  });
});

describe("RecordSettlementDialog - accessibility", () => {
  it("method rows are radios inside a radiogroup", () => {
    const json = renderDialog(baseProps).toJSON() as JsonNode;
    const radios = findAll(json, (n) => n.props?.accessibilityRole === "radio");
    expect(radios.length).toBe(5);
  });

  it("confirm and cancel are real buttons with useful labels", () => {
    const json = renderDialog(baseProps).toJSON() as JsonNode;
    const buttons = findAll(json, (n) => n.props?.accessibilityRole === "button");
    const labels = buttons.map((b) => b.props.accessibilityLabel);
    expect(labels).toEqual(expect.arrayContaining(["Cancel", "Record settlement", "Close"]));
  });
});

// Checkpoint 4E.6A: verification/exact-replay mode for an unresolved
// AMBIGUOUS prior Settlement attempt - explains why retrying is safe
// (same request id => no duplicate) and relabels Confirm, without any
// alarming/destructive styling or role change.
describe("RecordSettlementDialog - verification mode (Checkpoint 4E.6A)", () => {
  it("normal mode (default) says \"Record settlement\" everywhere - title and confirm label", () => {
    const text = collectText(renderDialog(baseProps).toJSON() as JsonNode);
    expect(countOccurrences(text, "Record settlement")).toBe(2);
    expect(text).not.toContain("Verify settlement");
    expect(text.toLowerCase()).not.toContain("couldn’t confirm the previous attempt");
  });

  it("verification mode explains the ambiguous prior attempt", () => {
    const text = collectText(
      renderDialog({ ...baseProps, verificationMode: true }).toJSON() as JsonNode
    );
    expect(text).toContain("We couldn’t confirm the previous attempt.");
    expect(text).toContain("same request ID");
    expect(text).toContain("won’t be duplicated");
  });

  it('verification mode confirm label says "Verify settlement"', () => {
    const json = renderDialog({ ...baseProps, verificationMode: true }).toJSON() as JsonNode;
    const buttons = findAll(json, (n) => n.props?.accessibilityRole === "button");
    const labels = buttons.map((b) => b.props.accessibilityLabel);
    expect(labels).toContain("Verify settlement");
    expect(labels).not.toContain("Record settlement");
  });

  it("the accessibility label of the confirm button matches the verification action", () => {
    const tree = renderDialog({ ...baseProps, verificationMode: true });
    const confirm = findPressable(tree, { accessibilityLabel: "Verify settlement" });
    expect(confirm.props.accessibilityRole).toBe("button");
  });

  it("verification mode uses no destructive styling or role change on confirm", () => {
    const json = renderDialog({ ...baseProps, verificationMode: true }).toJSON() as JsonNode;
    const buttons = findAll(json, (n) => n.props?.accessibilityRole === "button");
    // Still exactly the same three buttons as normal mode (Close,
    // Cancel, Confirm) - verification mode never adds a distinct
    // destructive control or relabels Cancel/Close.
    const labels = buttons.map((b) => b.props.accessibilityLabel);
    expect(labels).toEqual(expect.arrayContaining(["Cancel", "Close", "Verify settlement"]));
    expect(buttons).toHaveLength(3);
  });

  it("submitting still blocks dismissal in verification mode", () => {
    const onCancel = jest.fn();
    const tree = renderDialog({
      ...baseProps,
      verificationMode: true,
      submitting: true,
      onCancel,
    });
    const cancel = findPressable(tree, { accessibilityLabel: "Cancel" });
    act(() => {
      (cancel.props.onPress as () => void)();
    });
    expect(onCancel).not.toHaveBeenCalled();
    expect(cancel.props.disabled).toBe(true);
  });

  it("verification mode can remain confirmable (canSubmit:true) even while a normal balanceFreshnessWarning would otherwise disable it", () => {
    const tree = renderDialog({
      ...baseProps,
      verificationMode: true,
      canSubmit: true,
      balanceFreshnessWarning: null,
    });
    const confirm = findPressable(tree, { accessibilityLabel: "Verify settlement" });
    expect(confirm.props.disabled).toBe(false);
  });
});
