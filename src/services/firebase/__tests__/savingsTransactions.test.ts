// Tests for src/services/firebase/savingsTransactions.ts (Checkpoint
// 4F.3) - first test file for this service. Scope is narrow and
// deliberate: the mapper's linkedExpenseId round-trip (the one new piece
// of surface this checkpoint adds here).
//
// "firebase/firestore"/"firebase/functions" and this app's own
// "../../../firebase" module are mocked below for the exact same reason
// src/services/firebase/__tests__/expenses.test.ts already mocks them -
// without this, Jest attempts to parse the real "firebase" package's ESM
// build, which jest-expo's default preset does not transform.
import type { DocumentData } from "firebase/firestore";
import { mapSavingsTransactionDocument } from "../savingsTransactions";

jest.mock("firebase/firestore", () => ({
  Timestamp: class MockTimestamp {},
  collection: jest.fn((..._args: unknown[]) => ({__type: "collection"})),
  doc: jest.fn((..._args: unknown[]) => ({__type: "docRef"})),
  getDocs: jest.fn(),
  limit: jest.fn((..._args: unknown[]) => ({__type: "limit"})),
  onSnapshot: jest.fn(),
  orderBy: jest.fn((..._args: unknown[]) => ({__type: "orderBy"})),
  query: jest.fn((...args: unknown[]) => ({__type: "query", args})),
  where: jest.fn((...args: unknown[]) => ({__type: "where", args})),
}));

jest.mock("firebase/functions", () => ({
  httpsCallable: jest.fn(),
}));

jest.mock("../../../../firebase", () => ({
  db: {__type: "db"},
  functions: {__type: "functions"},
}));

// firebase/firestore's real Timestamp class doesn't transform cleanly
// under this project's jest-expo config for a VALUE import used only as
// a type-shaped placeholder - matching src/domain/__tests__/
// savingsBalance.test.ts's own FIXTURE_CREATED_AT convention, this
// fixture implements PersistedTimestamp's real public shape directly
// rather than constructing a real Timestamp instance. The mapper under
// test never calls any of these methods - it only checks
// `instanceof Timestamp` for other fields, never for linkedExpenseId or
// this fixture's own createdAt, so a plain object is sufficient here.
const FIXTURE_CREATED_AT = {
  seconds: 0,
  nanoseconds: 0,
  toDate: () => new Date(0),
  toMillis: () => 0,
  isEqual: (other: {seconds: number; nanoseconds: number}) =>
    other.seconds === 0 && other.nanoseconds === 0,
  toString: () => "Timestamp(seconds=0, nanoseconds=0)",
  toJSON: () => ({seconds: 0, nanoseconds: 0, type: "firestore/timestamp/1.0"}),
  valueOf: () => "0",
};

function validTransactionData(
  overrides: Record<string, unknown> = {}
): DocumentData {
  return {
    resourceType: "trip",
    resourceId: "trip-1",
    memberUid: "member-1",
    recordedBy: "member-1",
    amountMinor: 2000,
    currency: "USD",
    type: "withdrawal",
    createdAt: FIXTURE_CREATED_AT,
    reversalOf: null,
    ...overrides,
  };
}

describe("mapSavingsTransactionDocument - linkedExpenseId (Checkpoint 4F.3)", () => {
  it("maps linkedExpenseId when present on a Shared-Stash-linked withdrawal", () => {
    const transaction = mapSavingsTransactionDocument(
      "txn-1",
      validTransactionData({linkedExpenseId: "expense-1"})
    );
    expect(transaction.linkedExpenseId).toBe("expense-1");
  });

  it("maps linkedExpenseId when present on a Shared-Stash-linked refund (contribution)", () => {
    const transaction = mapSavingsTransactionDocument(
      "txn-2",
      validTransactionData({
        type: "contribution",
        reversalOf: "txn-1",
        linkedExpenseId: "expense-1",
      })
    );
    expect(transaction.type).toBe("contribution");
    expect(transaction.linkedExpenseId).toBe("expense-1");
  });

  it("leaves linkedExpenseId undefined for an ordinary personal transaction", () => {
    const transaction = mapSavingsTransactionDocument(
      "txn-3",
      validTransactionData()
    );
    expect(transaction.linkedExpenseId).toBeUndefined();
  });

  it("round-trips every other field unaffected by linkedExpenseId's presence", () => {
    const transaction = mapSavingsTransactionDocument(
      "txn-4",
      validTransactionData({linkedExpenseId: "expense-1", amountMinor: 999})
    );
    expect(transaction.resourceType).toBe("trip");
    expect(transaction.resourceId).toBe("trip-1");
    expect(transaction.memberUid).toBe("member-1");
    expect(transaction.recordedBy).toBe("member-1");
    expect(transaction.amountMinor).toBe(999);
    expect(transaction.currency).toBe("USD");
    expect(transaction.reversalOf).toBeNull();
  });
});

// Checkpoint 4F.3A: linkedExpenseId determines whether
// deriveMemberSavingsBalanceMinor excludes a transaction from personal
// savings attribution - a malformed persisted value must fail visibly
// rather than silently being treated as "absent" (which would wrongly
// restore a Shared-Stash-linked transaction to ordinary personal
// attribution).
describe("mapSavingsTransactionDocument - linkedExpenseId malformed-value hardening (Checkpoint 4F.3A)", () => {
  it("1. absent linkedExpenseId still maps normally", () => {
    const transaction = mapSavingsTransactionDocument(
      "txn-5",
      validTransactionData()
    );
    expect(transaction.linkedExpenseId).toBeUndefined();
    expect(transaction.amountMinor).toBe(2000);
  });

  it("2. a valid non-empty linkedExpenseId maps", () => {
    const transaction = mapSavingsTransactionDocument(
      "txn-6",
      validTransactionData({linkedExpenseId: "expense-42"})
    );
    expect(transaction.linkedExpenseId).toBe("expense-42");
  });

  const malformedCases: [string, unknown][] = [
    ["null", null],
    ["empty string", ""],
    ["whitespace-only string", "   "],
    ["a number", 123],
    ["a boolean", true],
    ["an object", {uid: "expense-1"}],
  ];
  for (const [label, badValue] of malformedCases) {
    it(`3. rejects a malformed linkedExpenseId (${label})`, () => {
      expect(() =>
        mapSavingsTransactionDocument(
          "txn-7",
          validTransactionData({linkedExpenseId: badValue})
        )
      ).toThrow(/linkedExpenseId/);
    });
  }
});
