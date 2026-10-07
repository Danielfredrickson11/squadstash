// Presentation-only tests for ExpenseRow (Checkpoint 4F.4). Mirrors
// components/balances/__tests__/RecordSettlementDialog.test.tsx's own
// react-test-renderer tree-walk convention. ExpenseRow's Shared-Stash
// rendering already existed before this checkpoint (ExpenseRowPayer's own
// "shared_stash" variant) - this file is this component's FIRST test
// coverage, added because Checkpoint 4F.4 explicitly requires proving the
// funding-source label/no-fake-payer/member-rendering-unchanged
// behaviors, not because the underlying behavior was newly written here.
import React from "react";
import { act, create } from "react-test-renderer";

import { ExpenseRow, type ExpenseRowPayer } from "../ExpenseRow";
import type { Expense } from "../../../src/types/domain";

type JsonNode = {
  props: Record<string, unknown>;
  children: (JsonNode | string)[] | null;
};

function renderRow(props: React.ComponentProps<typeof ExpenseRow>) {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<ExpenseRow {...props} />);
  });
  return tree;
}

function collectText(node: JsonNode | string | (JsonNode | string)[] | null): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(collectText).join("");
  return collectText(node.children);
}

const FIXTURE_CREATED_AT = {
  seconds: 1_700_000_000,
  nanoseconds: 0,
  toDate: () => new Date(1_700_000_000_000),
  toMillis: () => 1_700_000_000_000,
  isEqual: () => false,
  toString: () => "Timestamp",
  toJSON: () => ({ seconds: 1_700_000_000, nanoseconds: 0, type: "firestore/timestamp/1.0" }),
  valueOf: () => "1700000000",
};

function baseExpense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: "expense-1",
    tripId: "trip-1",
    payerUid: "member-1",
    createdBy: "member-1",
    amountMinor: 2000,
    currency: "USD",
    description: "Groceries",
    splitStrategy: "equal",
    paymentSource: "member_out_of_pocket",
    createdAt: FIXTURE_CREATED_AT as never,
    status: "active",
    ...overrides,
  };
}

const MEMBER_PAYER: ExpenseRowPayer = {
  kind: "member",
  avatarLabel: "D",
  nameLabel: "Daniel",
};

const SHARED_STASH_PAYER: ExpenseRowPayer = { kind: "shared_stash" };

describe("ExpenseRow - Shared-Stash funding label (Checkpoint 4F.4)", () => {
  it("13. displays the Shared Stash funding label for a shared_stash Expense", () => {
    const expense = baseExpense({ paymentSource: "shared_stash", payerUid: null });
    const text = collectText(renderRow({ expense, payer: SHARED_STASH_PAYER }).toJSON() as JsonNode);
    expect(text).toContain("Paid from Shared Stash");
  });

  it("14. never renders a fake payer name for payerUid === null", () => {
    const expense = baseExpense({ paymentSource: "shared_stash", payerUid: null });
    const text = collectText(renderRow({ expense, payer: SHARED_STASH_PAYER }).toJSON() as JsonNode);
    expect(text).not.toContain("Paid by null");
    expect(text).not.toContain("Paid by undefined");
    // The creator must never be presented as though they personally paid.
    expect(text).not.toContain(`Paid by ${expense.createdBy}`);
  });

  it("never attributes a shared_stash Expense to its createdBy as a personal payer", () => {
    const expense = baseExpense({
      paymentSource: "shared_stash",
      payerUid: null,
      createdBy: "member-2",
    });
    const text = collectText(renderRow({ expense, payer: SHARED_STASH_PAYER }).toJSON() as JsonNode);
    expect(text).not.toContain("Paid by member-2");
    expect(text).toContain("Paid from Shared Stash");
  });
});

describe("ExpenseRow - member-funded rendering is unchanged (Checkpoint 4F.4)", () => {
  it("15. renders \"Paid by <name>\" for a member_out_of_pocket Expense", () => {
    const expense = baseExpense();
    const text = collectText(renderRow({ expense, payer: MEMBER_PAYER }).toJSON() as JsonNode);
    expect(text).toContain("Paid by Daniel");
    expect(text).not.toContain("Shared Stash");
  });

  it("renders the Reversed chip for a reversed member_out_of_pocket Expense", () => {
    const expense = baseExpense({ status: "reversed" });
    const text = collectText(renderRow({ expense, payer: MEMBER_PAYER }).toJSON() as JsonNode);
    expect(text).toContain("Reversed");
  });
});
