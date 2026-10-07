// Presentation-only tests for ReverseExpenseDialog (Checkpoint 4F.4).
// Mirrors components/balances/__tests__/RecordSettlementDialog.test.tsx's
// own react-test-renderer tree-walk convention. This dialog's FIRST test
// coverage - focused on the new isSharedStash messaging this checkpoint
// adds; the dialog's pre-existing generic reversal copy/behavior is
// exercised only insofar as it must remain unchanged by default.
import React from "react";
import { act, create } from "react-test-renderer";

import { ReverseExpenseDialog } from "../ReverseExpenseDialog";
import { lightColors } from "../../../src/theme/tokens";

type JsonNode = {
  props: Record<string, unknown>;
  children: (JsonNode | string)[] | null;
};

function renderDialog(props: React.ComponentProps<typeof ReverseExpenseDialog>) {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<ReverseExpenseDialog {...props} />);
  });
  return tree;
}

function collectText(node: JsonNode | string | (JsonNode | string)[] | null): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(collectText).join("");
  return collectText(node.children);
}

const baseProps: React.ComponentProps<typeof ReverseExpenseDialog> = {
  visible: true,
  expenseDescription: "Groceries",
  expenseAmountMinor: 2000,
  reasonText: "",
  onChangeReasonText: jest.fn(),
  submitting: false,
  submitError: null,
  onCancel: jest.fn(),
  onConfirm: jest.fn(),
  colors: lightColors,
};

describe("ReverseExpenseDialog - Shared Stash reversal messaging (Checkpoint 4F.4)", () => {
  it("19. names the Shared Stash refund explicitly when isSharedStash is true", () => {
    const text = collectText(renderDialog({ ...baseProps, isSharedStash: true }).toJSON() as JsonNode);
    expect(text).toContain("returned to the Trip’s Shared Stash");
    expect(text).toContain("$20.00");
  });

  it("never describes the effect as restoring an old historical balance", () => {
    const text = collectText(renderDialog({ ...baseProps, isSharedStash: true }).toJSON() as JsonNode);
    expect(text).not.toMatch(/restor(e|ed|ing)/i);
    expect(text).not.toMatch(/historical/i);
  });

  it("omits the Shared Stash line by default (member-funded reversal unchanged)", () => {
    const text = collectText(renderDialog(baseProps).toJSON() as JsonNode);
    expect(text).not.toContain("Shared Stash");
  });

  it("omits the Shared Stash line when isSharedStash is explicitly false", () => {
    const text = collectText(renderDialog({ ...baseProps, isSharedStash: false }).toJSON() as JsonNode);
    expect(text).not.toContain("Shared Stash");
  });

  it("still renders the standard non-destructive explanation regardless of isSharedStash", () => {
    const text = collectText(renderDialog({ ...baseProps, isSharedStash: true }).toJSON() as JsonNode);
    expect(text).toContain("nothing is deleted");
  });
});
