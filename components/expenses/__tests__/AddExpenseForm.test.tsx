// Presentation-only tests for AddExpenseForm (Checkpoint 4F.4). Mirrors
// components/balances/__tests__/RecordSettlementDialog.test.tsx's own
// react-test-renderer tree-walk convention (no new test dependency, no
// @testing-library/react-native). Focused on the NEW Shared-Stash
// payment-source behavior this checkpoint adds - pre-existing member-
// funded rendering (payer/participant/split-strategy controls
// themselves) is exercised only insofar as it must remain the default
// and must be hidden correctly when Shared Stash is selected.
import React from "react";
import { act, create } from "react-test-renderer";

import { AddExpenseForm, type MemberOption } from "../AddExpenseForm";
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

function renderForm(props: React.ComponentProps<typeof AddExpenseForm>) {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<AddExpenseForm {...props} />);
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

const MEMBERS: MemberOption[] = [
  { uid: "member-1", avatarLabel: "D", nameLabel: "Daniel", isCurrentUser: true },
  { uid: "member-2", avatarLabel: "J", nameLabel: "Jake", isCurrentUser: false },
];

const baseProps: React.ComponentProps<typeof AddExpenseForm> = {
  colors: lightColors,
  members: MEMBERS,
  isOverCapacity: false,
  description: "Groceries",
  onChangeDescription: jest.fn(),
  descriptionError: null,
  amountText: "20.00",
  onChangeAmountText: jest.fn(),
  amountError: null,
  category: "",
  onChangeCategory: jest.fn(),
  categoryError: null,
  payerUid: "member-1",
  onSelectPayer: jest.fn(),
  selectedParticipantUids: new Set(["member-1", "member-2"]),
  onToggleParticipant: jest.fn(),
  onSelectAllParticipants: jest.fn(),
  onClearAllParticipants: jest.fn(),
  participantsError: null,
  profileErrorVisible: false,
  onRetryProfiles: jest.fn(),
  previewAmountMinor: 2000,
  splitStrategy: "equal",
  onChangeSplitStrategy: jest.fn(),
  percentageValues: {},
  onChangePercentageValue: jest.fn(),
  percentageErrors: {},
  percentageAggregateText: null,
  percentageAggregateError: null,
  previewPercentageParticipants: null,
  customValues: {},
  onChangeCustomValue: jest.fn(),
  customErrors: {},
  customAggregateText: null,
  customAggregateError: null,
  previewCustomParticipants: null,
  submitting: false,
  submitError: null,
  onSubmit: jest.fn(),
  onCancel: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("AddExpenseForm - payment-source selector", () => {
  it("1. exposes both supported payment sources when shown", () => {
    const text = collectText(
      renderForm({ ...baseProps, onChangePaymentSource: jest.fn() }).toJSON() as JsonNode
    );
    expect(text).toContain("Paid by a member");
    expect(text).toContain("Paid from Shared Stash");
  });

  it("2. member_out_of_pocket is the default when paymentSource is omitted", () => {
    const tree = renderForm({ ...baseProps, onChangePaymentSource: jest.fn() });
    const json = tree.toJSON() as JsonNode;
    const radios = findAll(json, (n) => n.props?.accessibilityRole === "radio");
    const memberOption = radios.find((r) => r.props.accessibilityLabel === "Paid by a member");
    expect(memberOption?.props.accessibilityState).toEqual(expect.objectContaining({ checked: true }));
    // The member-funded controls are visible by default.
    expect(collectText(json)).toContain("Paid by");
    expect(collectText(json)).toContain("Participants");
  });

  it("is hidden entirely when showPaymentSourceSelector is false (correction mode)", () => {
    const text = collectText(
      renderForm({
        ...baseProps,
        onChangePaymentSource: jest.fn(),
        showPaymentSourceSelector: false,
      }).toJSON() as JsonNode
    );
    expect(text).not.toContain("Payment source");
    expect(text).not.toContain("Paid from Shared Stash");
  });

  it("is hidden when onChangePaymentSource is not supplied, preserving every pre-4F.4 call site unchanged", () => {
    const text = collectText(renderForm(baseProps).toJSON() as JsonNode);
    expect(text).not.toContain("Payment source");
  });

  it("tapping the Shared Stash option invokes onChangePaymentSource with \"shared_stash\"", () => {
    const onChangePaymentSource = jest.fn();
    const tree = renderForm({ ...baseProps, onChangePaymentSource });
    const option = findPressable(tree, { accessibilityLabel: "Paid from Shared Stash" });
    act(() => {
      (option.props.onPress as () => void)();
    });
    expect(onChangePaymentSource).toHaveBeenCalledWith("shared_stash");
  });
});

describe("AddExpenseForm - Shared Stash selection hides member-funded controls", () => {
  const sharedStashProps: React.ComponentProps<typeof AddExpenseForm> = {
    ...baseProps,
    paymentSource: "shared_stash",
    onChangePaymentSource: jest.fn(),
  };

  it("3. hides the payer selector", () => {
    const json = renderForm(sharedStashProps).toJSON() as JsonNode;
    const text = collectText(json);
    expect(text).not.toContain("Paid by Daniel");
    // Neither member's own select-row label (rendered as visible text
    // inside MemberSelectRow) appears anywhere once the payer/participant
    // sections are hidden.
    expect(text).not.toContain("Daniel · You");
    expect(text).not.toContain("Jake");
    const radiogroups = findAll(json, (n) => n.props?.accessibilityRole === "radiogroup");
    // Only the payment-source radiogroup remains - the payer radiogroup
    // (member select rows) is gone.
    expect(radiogroups.length).toBe(1);
  });

  it("4. hides the participant checkbox controls", () => {
    const text = collectText(renderForm(sharedStashProps).toJSON() as JsonNode);
    expect(text).not.toContain("Participants");
    expect(text).not.toContain("Select all");
    expect(text).not.toContain("Clear");
  });

  it("5. hides the split strategy selector and inputs", () => {
    const text = collectText(renderForm(sharedStashProps).toJSON() as JsonNode);
    expect(text).not.toContain("Split strategy");
    expect(text).not.toContain("Equal");
    expect(text).not.toContain("Percentage");
    expect(text).not.toContain("Custom");
  });

  it("never renders a split preview implying anyone owes another member money", () => {
    const text = collectText(renderForm(sharedStashProps).toJSON() as JsonNode);
    expect(text).not.toContain("Split equally between");
    expect(text).not.toContain("Split by percentage");
  });

  it("shows the Shared Stash deduction note", () => {
    const text = collectText(renderForm(sharedStashProps).toJSON() as JsonNode);
    expect(text).toContain("Paid from Shared Stash");
    expect(text).toContain("deducted from the Trip balance");
  });

  it("shows the available Shared Stash balance when supplied, without computing it itself", () => {
    const text = collectText(
      renderForm({ ...sharedStashProps, sharedStashAvailableMinor: 12345 }).toJSON() as JsonNode
    );
    expect(text).toContain("Available in Shared Stash");
    expect(text).toContain("$123.45");
  });

  it("omits the available-balance line when the balance is not supplied", () => {
    const text = collectText(renderForm(sharedStashProps).toJSON() as JsonNode);
    expect(text).not.toContain("Available in Shared Stash");
  });
});

describe("AddExpenseForm - member_out_of_pocket rendering is unaffected", () => {
  it("still renders payer/participants/split-strategy controls when paymentSource is explicitly member_out_of_pocket", () => {
    const text = collectText(
      renderForm({
        ...baseProps,
        paymentSource: "member_out_of_pocket",
        onChangePaymentSource: jest.fn(),
      }).toJSON() as JsonNode
    );
    expect(text).toContain("Paid by");
    expect(text).toContain("Participants");
    expect(text).toContain("Split strategy");
    expect(text).not.toContain("deducted from the Trip balance");
  });
});
