// Presentation-only tests for TransactionRow (Checkpoint 4F.4A) - this
// component's FIRST test coverage. Mirrors
// components/expenses/__tests__/ExpenseRow.test.tsx's own
// react-test-renderer tree-walk convention. Focused on the NEW
// linkedExpenseId-aware label this checkpoint adds; ordinary personal
// contribution/withdrawal rendering is exercised only insofar as it must
// remain the unchanged default.
import React from "react";
import { act, create } from "react-test-renderer";

import { TransactionRow } from "../TransactionRow";
import type { SavingsTransaction } from "../../../src/types/domain";

type JsonNode = {
  props: Record<string, unknown>;
  children: (JsonNode | string)[] | null;
};

function renderRow(props: React.ComponentProps<typeof TransactionRow>) {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<TransactionRow {...props} />);
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

function baseTransaction(overrides: Partial<SavingsTransaction> = {}): SavingsTransaction {
  return {
    id: "txn-1",
    resourceType: "bucket",
    resourceId: "bucket-1",
    memberUid: "member-1",
    recordedBy: "member-1",
    amountMinor: 2000,
    currency: "USD",
    type: "withdrawal",
    createdAt: FIXTURE_CREATED_AT as never,
    reversalOf: null,
    ...overrides,
  } as SavingsTransaction;
}

describe("TransactionRow - linked Shared-Stash Expense activity (Checkpoint 4F.4A)", () => {
  it("renders a linked withdrawal as Expense activity when the description is supplied", () => {
    const transaction = baseTransaction({ type: "withdrawal", linkedExpenseId: "expense-1" });
    const text = collectText(
      renderRow({ transaction, linkedExpenseDescription: "Groceries" }).toJSON() as JsonNode
    );
    expect(text).toContain("Spent on Groceries");
    expect(text).not.toContain("Withdrawal");
  });

  it("renders a linked refund as Shared-Stash Expense refund activity when the description is supplied", () => {
    const transaction = baseTransaction({ type: "contribution", linkedExpenseId: "expense-1" });
    const text = collectText(
      renderRow({ transaction, linkedExpenseDescription: "Groceries" }).toJSON() as JsonNode
    );
    expect(text).toContain("Refunded from Groceries");
    expect(text).not.toContain("Contribution");
  });

  it("falls back to a safe institutional label when the linked Expense cannot be resolved", () => {
    const transaction = baseTransaction({ type: "withdrawal", linkedExpenseId: "expense-1" });
    const text = collectText(renderRow({ transaction }).toJSON() as JsonNode);
    expect(text).toContain("Shared Stash expense");
  });

  it("never renders a memberUid-based personal attribution for a linked transaction", () => {
    const transaction = baseTransaction({
      type: "withdrawal",
      linkedExpenseId: "expense-1",
      memberUid: "daniel-uid",
    });
    const text = collectText(renderRow({ transaction }).toJSON() as JsonNode);
    expect(text).not.toContain("daniel-uid");
  });
});

describe("TransactionRow - ordinary unlinked rendering is unchanged (Checkpoint 4F.4A)", () => {
  it("renders an ordinary contribution with its existing generic label", () => {
    const transaction = baseTransaction({ type: "contribution" });
    const text = collectText(renderRow({ transaction }).toJSON() as JsonNode);
    expect(text).toContain("Contribution");
  });

  it("renders an ordinary withdrawal with its existing generic label", () => {
    const transaction = baseTransaction({ type: "withdrawal" });
    const text = collectText(renderRow({ transaction }).toJSON() as JsonNode);
    expect(text).toContain("Withdrawal");
  });

  it("ignores a supplied linkedExpenseDescription when the transaction has no linkedExpenseId", () => {
    const transaction = baseTransaction({ type: "withdrawal" });
    const text = collectText(
      renderRow({ transaction, linkedExpenseDescription: "Should be ignored" }).toJSON() as JsonNode
    );
    expect(text).toContain("Withdrawal");
    expect(text).not.toContain("Should be ignored");
  });
});
