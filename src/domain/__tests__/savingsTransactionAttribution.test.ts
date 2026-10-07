import {
  buildExpenseDescriptionIndex,
  resolveSavingsTransactionLabel,
} from "../savingsTransactionAttribution";

describe("resolveSavingsTransactionLabel - linked Shared-Stash Expense activity (Checkpoint 4F.4A)", () => {
  it("15. a linked withdrawal renders as Expense activity, not a personal withdrawal", () => {
    const label = resolveSavingsTransactionLabel(
      { type: "withdrawal", linkedExpenseId: "expense-1" },
      "Groceries"
    );
    expect(label).toBe("Spent on Groceries");
    expect(label).not.toMatch(/withdr/i);
  });

  it("16. a linked refund (contribution) renders as Shared-Stash Expense refund activity, not a personal contribution", () => {
    const label = resolveSavingsTransactionLabel(
      { type: "contribution", linkedExpenseId: "expense-1" },
      "Groceries"
    );
    expect(label).toBe("Refunded from Groceries");
    expect(label).not.toBe("Contribution");
  });

  it("17. the Expense description is used when resolvable, for both withdrawal and refund", () => {
    expect(
      resolveSavingsTransactionLabel({ type: "withdrawal", linkedExpenseId: "e1" }, "Cabin rental")
    ).toBe("Spent on Cabin rental");
    expect(
      resolveSavingsTransactionLabel({ type: "contribution", linkedExpenseId: "e1" }, "Cabin rental")
    ).toBe("Refunded from Cabin rental");
  });

  it("18. falls back to a safe institutional label when the Expense cannot be resolved (undefined)", () => {
    expect(
      resolveSavingsTransactionLabel({ type: "withdrawal", linkedExpenseId: "e1" }, undefined)
    ).toBe("Shared Stash expense");
    expect(
      resolveSavingsTransactionLabel({ type: "contribution", linkedExpenseId: "e1" }, undefined)
    ).toBe("Shared Stash expense refund");
  });

  it("falls back to the same safe institutional label when the resolved description is null", () => {
    expect(resolveSavingsTransactionLabel({ type: "withdrawal", linkedExpenseId: "e1" }, null)).toBe(
      "Shared Stash expense"
    );
  });

  it("falls back to the safe institutional label when the resolved description is whitespace-only", () => {
    expect(resolveSavingsTransactionLabel({ type: "withdrawal", linkedExpenseId: "e1" }, "   ")).toBe(
      "Shared Stash expense"
    );
  });

  it("never falls back to any form of memberUid/recordedBy-based personal attribution", () => {
    const label = resolveSavingsTransactionLabel(
      { type: "withdrawal", linkedExpenseId: "e1" },
      undefined
    );
    expect(label).not.toMatch(/daniel/i);
    expect(label).not.toContain("member-");
  });
});

// Note: this codebase's existing TransactionRow/RecentActivityRow
// components never render a member's NAME for any savingsTransaction
// (confirmed by audit - only the generic "Contribution"/"Withdrawal"
// label, resource-scoped, has ever been shown). "Normal member
// attribution" here means exactly that existing, unchanged generic
// label - these tests prove this checkpoint's new linkedExpenseId
// handling never alters it for an ordinary, unlinked transaction.
describe("resolveSavingsTransactionLabel - ordinary unlinked personal transactions (Checkpoint 4F.4A)", () => {
  it("19. an ordinary unlinked contribution still shows its normal (generic, unchanged) label", () => {
    const label = resolveSavingsTransactionLabel({ type: "contribution" }, "irrelevant");
    expect(label).toBe("Contribution");
  });

  it("20. an ordinary unlinked withdrawal still shows its normal (generic, unchanged) label", () => {
    const label = resolveSavingsTransactionLabel({ type: "withdrawal" }, "irrelevant");
    expect(label).toBe("Withdrawal");
  });

  it("ignores any supplied linkedExpenseDescription when linkedExpenseId is absent", () => {
    expect(resolveSavingsTransactionLabel({ type: "withdrawal" }, "Groceries")).toBe("Withdrawal");
  });
});

// Checkpoint 4F.4B: the "no N+1" resolution strategy - a single O(n) pass
// over an already-loaded Expense list, never one fetch per transaction
// row.
describe("buildExpenseDescriptionIndex", () => {
  it("10. maps every Expense's id to its description in one pass", () => {
    const index = buildExpenseDescriptionIndex([
      { id: "expense-1", description: "Groceries" },
      { id: "expense-2", description: "Cabin rental" },
    ]);
    expect(index.get("expense-1")).toBe("Groceries");
    expect(index.get("expense-2")).toBe("Cabin rental");
    expect(index.size).toBe(2);
  });

  it("returns an empty index for an empty input list", () => {
    expect(buildExpenseDescriptionIndex([]).size).toBe(0);
  });

  it("returns undefined for an id not present in the source list", () => {
    const index = buildExpenseDescriptionIndex([{ id: "expense-1", description: "Groceries" }]);
    expect(index.get("some-other-expense")).toBeUndefined();
  });
});
