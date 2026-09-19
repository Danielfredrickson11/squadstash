// Tests for src/services/firebase/expenses.ts (Checkpoint 4D.1B). Two
// groups:
// 1. Pure functions (mappers, sort, route-integrity check, request
//    builder, response parsers) - exercised directly.
// 2. Firebase-SDK-dependent wiring (subscriptions, one-shot reads, the
//    trusted callables) - exercised against focused jest.mock()s below,
//    never a real Firestore/network call (matching this codebase's own
//    "never contact production Firebase from tests" convention already
//    established for the Rules-emulator suite, applied here at the unit
//    level instead).
//
// "firebase/firestore"/"firebase/functions" and this app's own
// "../../../firebase" module are mocked below (via jest.mock(), which
// babel-plugin-jest-hoist relocates above every import in this file
// regardless of its own textual position - so writing the imports first
// here is only a readability/lint-rule (import/first) reordering, not a
// change in what actually mocks what) so the same mocks are used
// transitively by expenses.ts itself - this is the only way to avoid Jest
// attempting to parse the real "firebase" package's ESM build, which
// jest-expo's default preset does not transform (no dependency/config
// change required to work around it).
import type { Expense, ExpenseSplit } from "../../../types/domain";
import {
  buildRecordTripExpenseRequest,
  expenseBelongsToTrip,
  fetchExpenseById,
  fetchExpenseSplitsForExpense,
  generateExpenseClientRequestId,
  mapExpenseDocument,
  mapExpenseSplitDocument,
  parseRecordTripExpenseResponse,
  parseReverseTripExpenseResponse,
  recordTripExpense,
  reverseTripExpense,
  sortExpensesForHistory,
  subscribeToExpenseById,
  subscribeToExpensesForTrip,
  type RecordTripExpenseInput,
} from "../expenses";
import {
  Timestamp as MockTimestampCtor,
  doc as mockDoc,
  getDoc as mockGetDoc,
  getDocs as mockGetDocs,
  onSnapshot as mockOnSnapshot,
  where as mockWhere,
} from "firebase/firestore";
import { httpsCallable as mockHttpsCallable } from "firebase/functions";

// Every mock in these two jest.mock() factories must be fully
// self-contained (no reference to an outer-scope variable) - since
// jest.mock() calls are hoisted above this file's own imports, an outer
// `const mockFoo = jest.fn()` would not yet be assigned when the factory
// first runs (it runs the first time something - including "../expenses"
// itself - requires the mocked module, which for a hoisted `import`
// happens before later same-file statements execute). The mocked
// jest.fn()s are retrieved for per-test configuration via the imports
// above instead - Jest resolves those to the exact same mock instance
// "../expenses" uses internally.
jest.mock("firebase/firestore", () => {
  class MockTimestamp {
    millisValue: number;
    constructor(ms: number) {
      this.millisValue = ms;
    }
    toMillis(): number {
      return this.millisValue;
    }
    toDate(): Date {
      return new Date(this.millisValue);
    }
    static now(): MockTimestamp {
      return new MockTimestamp(Date.now());
    }
    static fromMillis(ms: number): MockTimestamp {
      return new MockTimestamp(ms);
    }
    static fromDate(d: Date): MockTimestamp {
      return new MockTimestamp(d.getTime());
    }
  }
  return {
    Timestamp: MockTimestamp,
    collection: jest.fn((..._args: unknown[]) => ({__type: "collection"})),
    doc: jest.fn((..._args: unknown[]) => ({__type: "docRef"})),
    getDoc: jest.fn(),
    getDocs: jest.fn(),
    onSnapshot: jest.fn(),
    query: jest.fn((...args: unknown[]) => ({__type: "query", args})),
    where: jest.fn((...args: unknown[]) => ({__type: "where", args})),
  };
});

jest.mock("firebase/functions", () => ({
  httpsCallable: jest.fn(),
}));

jest.mock("../../../../firebase", () => ({
  db: {__type: "db"},
  functions: {__type: "functions"},
}));

const MockTimestamp = MockTimestampCtor as unknown as {
  fromMillis(ms: number): import("firebase/firestore").Timestamp;
};

const T1 = MockTimestamp.fromMillis(1_700_000_000_000);
const T2 = MockTimestamp.fromMillis(1_700_000_100_000); // later than T1
const T3 = MockTimestamp.fromMillis(1_700_000_200_000); // later than T2

// jest.Mock-typed aliases of the same mocked functions imported above, so
// call sites below can use jest's mock-configuration API
// (.mockResolvedValue/.mockImplementation/.mock.calls/etc.) without
// repeating an `as jest.Mock` cast everywhere.
const mockDocFn = mockDoc as unknown as jest.Mock;
const mockGetDocFn = mockGetDoc as unknown as jest.Mock;
const mockGetDocsFn = mockGetDocs as unknown as jest.Mock;
const mockOnSnapshotFn = mockOnSnapshot as unknown as jest.Mock;
const mockWhereFn = mockWhere as unknown as jest.Mock;
const mockHttpsCallableFn = mockHttpsCallable as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

function validActiveExpenseData(overrides: Record<string, unknown> = {}) {
  return {
    tripId: "trip-1",
    payerUid: "member-1",
    createdBy: "member-1",
    amountMinor: 9000,
    currency: "USD",
    description: "Cabin rental",
    splitStrategy: "equal",
    paymentSource: "member_out_of_pocket",
    status: "active",
    createdAt: T1,
    creationRequest: {tripId: "trip-1"}, // trusted-internal, must not pollute/reject
    ...overrides,
  };
}

function validReversedExpenseData(overrides: Record<string, unknown> = {}) {
  return {
    ...validActiveExpenseData(),
    status: "reversed",
    reversedAt: T2,
    reversedBy: "owner-1",
    reversalRequest: {clientRequestId: "abc"}, // trusted-internal
    ...overrides,
  };
}

// =======================================================================
// GROUP 1: pure functions
// =======================================================================

describe("mapExpenseDocument", () => {
  it("maps a valid active member_out_of_pocket Expense", () => {
    const expense = mapExpenseDocument("expense-1", validActiveExpenseData());
    expect(expense).toMatchObject({
      id: "expense-1",
      tripId: "trip-1",
      payerUid: "member-1",
      createdBy: "member-1",
      amountMinor: 9000,
      currency: "USD",
      description: "Cabin rental",
      splitStrategy: "equal",
      paymentSource: "member_out_of_pocket",
      status: "active",
    });
    expect(expense.createdAt).toBe(T1);
  });

  it("maps a valid reversed Expense, including reversal metadata", () => {
    const expense = mapExpenseDocument(
      "expense-1",
      validReversedExpenseData({reversalReason: "Wrong amount"})
    );
    expect(expense.status).toBe("reversed");
    expect(expense.reversedAt).toBe(T2);
    expect(expense.reversedBy).toBe("owner-1");
    expect(expense.reversalReason).toBe("Wrong amount");
  });

  it("rejects a malformed status", () => {
    expect(() =>
      mapExpenseDocument("expense-1", validActiveExpenseData({status: "bogus"}))
    ).toThrow(/status/);
  });

  it("rejects a malformed amountMinor (zero)", () => {
    expect(() =>
      mapExpenseDocument("expense-1", validActiveExpenseData({amountMinor: 0}))
    ).toThrow(/amountMinor/);
  });

  it("rejects a malformed amountMinor (negative)", () => {
    expect(() =>
      mapExpenseDocument("expense-1", validActiveExpenseData({amountMinor: -100}))
    ).toThrow(/amountMinor/);
  });

  it("rejects a malformed amountMinor (non-integer)", () => {
    expect(() =>
      mapExpenseDocument("expense-1", validActiveExpenseData({amountMinor: 12.5}))
    ).toThrow(/amountMinor/);
  });

  it("rejects a malformed createdAt (not a real Firestore Timestamp)", () => {
    expect(() =>
      mapExpenseDocument(
        "expense-1",
        validActiveExpenseData({createdAt: new Date().toISOString()})
      )
    ).toThrow(/createdAt/);
  });

  it("rejects a missing payerUid for member_out_of_pocket", () => {
    expect(() =>
      mapExpenseDocument("expense-1", validActiveExpenseData({payerUid: null}))
    ).toThrow(/payerUid/);
  });

  it("rejects a non-empty payerUid for shared_stash", () => {
    expect(() =>
      mapExpenseDocument(
        "expense-1",
        validActiveExpenseData({
          paymentSource: "shared_stash",
          payerUid: "member-1",
          sharedStashTransactionId: "txn-1",
        })
      )
    ).toThrow(/payerUid/);
  });

  it("maps a valid shared_stash Expense with payerUid null", () => {
    const expense = mapExpenseDocument(
      "expense-1",
      validActiveExpenseData({
        paymentSource: "shared_stash",
        payerUid: null,
        sharedStashTransactionId: "txn-1",
      })
    );
    expect(expense.payerUid).toBeNull();
    expect(expense.sharedStashTransactionId).toBe("txn-1");
  });

  it("rejects a malformed correction-link id (contains a slash)", () => {
    expect(() =>
      mapExpenseDocument(
        "expense-1",
        validActiveExpenseData({replacesExpenseId: "a/b"})
      )
    ).toThrow(/replacesExpenseId/);
  });

  it("rejects an empty-string correction-link id", () => {
    expect(() =>
      mapExpenseDocument(
        "expense-1",
        validActiveExpenseData({replacedByExpenseId: ""})
      )
    ).toThrow(/replacedByExpenseId/);
  });

  it("accepts a valid correction-link id", () => {
    const expense = mapExpenseDocument(
      "expense-1",
      validActiveExpenseData({replacesExpenseId: "old-expense-1"})
    );
    expect(expense.replacesExpenseId).toBe("old-expense-1");
  });

  it("rejects a reversed Expense missing reversedBy", () => {
    const data = validReversedExpenseData();
    delete (data as Record<string, unknown>).reversedBy;
    expect(() => mapExpenseDocument("expense-1", data)).toThrow(/reversedBy/);
  });

  it("rejects an active Expense that still carries a reversedAt", () => {
    expect(() =>
      mapExpenseDocument("expense-1", validActiveExpenseData({reversedAt: T2}))
    ).toThrow(/reversedAt/);
  });

  it("trusted internal creationRequest/reversalRequest do not pollute the mapped Expense and do not themselves cause rejection", () => {
    const expense = mapExpenseDocument(
      "expense-1",
      validReversedExpenseData({
        creationRequest: {anything: "goes here"},
        reversalRequest: {anything: "goes here too"},
      })
    );
    expect((expense as unknown as Record<string, unknown>).creationRequest).toBeUndefined();
    expect((expense as unknown as Record<string, unknown>).reversalRequest).toBeUndefined();
  });

  it("unknown/backend-internal extra fields never cause rejection on their own", () => {
    expect(() =>
      mapExpenseDocument(
        "expense-1",
        validActiveExpenseData({someFutureBackendField: 42})
      )
    ).not.toThrow();
  });
});

// Checkpoint 4D.1B.1 §2: the trusted backend (recordTripExpense.ts) never
// requires category to be non-empty and never trims it - a persisted
// category of "" is a legitimate document, not a malformed one. The
// reader must match that writer contract exactly.
describe("mapExpenseDocument - category reader/writer contract (4D.1B.1 §2)", () => {
  it("category absent maps with category undefined", () => {
    const expense = mapExpenseDocument("expense-1", validActiveExpenseData());
    expect(expense.category).toBeUndefined();
  });

  it('category "" maps as ""', () => {
    const expense = mapExpenseDocument(
      "expense-1",
      validActiveExpenseData({category: ""})
    );
    expect(expense.category).toBe("");
  });

  it('category "Food" maps as "Food"', () => {
    const expense = mapExpenseDocument(
      "expense-1",
      validActiveExpenseData({category: "Food"})
    );
    expect(expense.category).toBe("Food");
  });

  it("category of exactly 100 characters maps", () => {
    const category = "x".repeat(100);
    const expense = mapExpenseDocument(
      "expense-1",
      validActiveExpenseData({category})
    );
    expect(expense.category).toBe(category);
  });

  it("category of 101 characters rejects", () => {
    const category = "x".repeat(101);
    expect(() =>
      mapExpenseDocument("expense-1", validActiveExpenseData({category}))
    ).toThrow(/category/);
  });

  it("non-string category rejects", () => {
    expect(() =>
      mapExpenseDocument("expense-1", validActiveExpenseData({category: 42}))
    ).toThrow(/category/);
  });
});

// Checkpoint 4D.1B.1 §3: reversal metadata belongs only to a "reversed"
// Expense - reversedAt/reversedBy/reversalReason must ALL fail closed when
// present on an "active" record.
describe("mapExpenseDocument - active reversal metadata fails closed (4D.1B.1 §3)", () => {
  it("active + reversedAt rejects", () => {
    expect(() =>
      mapExpenseDocument("expense-1", validActiveExpenseData({reversedAt: T2}))
    ).toThrow(/reversedAt/);
  });

  it("active + reversedBy rejects", () => {
    expect(() =>
      mapExpenseDocument(
        "expense-1",
        validActiveExpenseData({reversedBy: "owner-1"})
      )
    ).toThrow(/reversedBy/);
  });

  it("active + reversalReason rejects", () => {
    expect(() =>
      mapExpenseDocument(
        "expense-1",
        validActiveExpenseData({reversalReason: "Wrong amount"})
      )
    ).toThrow(/reversalReason/);
  });
});

// Checkpoint 4D.1B.1 §4: when present, reversalReason must match
// reverseTripExpense.ts's own trusted persisted contract exactly - a
// non-empty, already-trimmed string of at most 500 characters. A null
// reason is never persisted (the field is deleted instead), so absence
// remains valid.
describe("mapExpenseDocument - reversalReason matches trusted writer shape (4D.1B.1 §4)", () => {
  it("reversed + reversalReason absent maps with reversalReason undefined", () => {
    const expense = mapExpenseDocument("expense-1", validReversedExpenseData());
    expect(expense.reversalReason).toBeUndefined();
  });

  it("reversed + valid reversalReason maps", () => {
    const expense = mapExpenseDocument(
      "expense-1",
      validReversedExpenseData({reversalReason: "Wrong amount"})
    );
    expect(expense.reversalReason).toBe("Wrong amount");
  });

  it("reversed + blank/whitespace-only reversalReason rejects", () => {
    expect(() =>
      mapExpenseDocument(
        "expense-1",
        validReversedExpenseData({reversalReason: "   "})
      )
    ).toThrow(/reversalReason/);
  });

  it("reversed + leading/trailing-whitespace reversalReason rejects", () => {
    expect(() =>
      mapExpenseDocument(
        "expense-1",
        validReversedExpenseData({reversalReason: " Wrong amount "})
      )
    ).toThrow(/reversalReason/);
  });

  it("reversed + reversalReason over 500 characters rejects", () => {
    expect(() =>
      mapExpenseDocument(
        "expense-1",
        validReversedExpenseData({reversalReason: "x".repeat(501)})
      )
    ).toThrow(/reversalReason/);
  });

  it("reversed + reversalReason of exactly 500 characters maps", () => {
    const reversalReason = "x".repeat(500);
    const expense = mapExpenseDocument(
      "expense-1",
      validReversedExpenseData({reversalReason})
    );
    expect(expense.reversalReason).toBe(reversalReason);
  });

  it("reversed + non-string reversalReason rejects", () => {
    expect(() =>
      mapExpenseDocument(
        "expense-1",
        validReversedExpenseData({reversalReason: 42})
      )
    ).toThrow(/reversalReason/);
  });
});

// Checkpoint 4D.1B.1 §5: a stray sharedStashTransactionId on a
// member_out_of_pocket Expense contradicts the persisted domain contract
// and must fail closed rather than being silently dropped.
describe("mapExpenseDocument - payment-source metadata consistency (4D.1B.1 §5)", () => {
  it("member_out_of_pocket + absent sharedStashTransactionId maps", () => {
    const expense = mapExpenseDocument("expense-1", validActiveExpenseData());
    expect(expense.sharedStashTransactionId).toBeUndefined();
  });

  it("member_out_of_pocket + stray sharedStashTransactionId rejects", () => {
    expect(() =>
      mapExpenseDocument(
        "expense-1",
        validActiveExpenseData({sharedStashTransactionId: "txn-1"})
      )
    ).toThrow(/sharedStashTransactionId/);
  });

  it("shared_stash + null payerUid + sharedStashTransactionId maps", () => {
    const expense = mapExpenseDocument(
      "expense-1",
      validActiveExpenseData({
        paymentSource: "shared_stash",
        payerUid: null,
        sharedStashTransactionId: "txn-1",
      })
    );
    expect(expense.payerUid).toBeNull();
    expect(expense.sharedStashTransactionId).toBe("txn-1");
  });

  it("shared_stash + missing sharedStashTransactionId rejects", () => {
    expect(() =>
      mapExpenseDocument(
        "expense-1",
        validActiveExpenseData({paymentSource: "shared_stash", payerUid: null})
      )
    ).toThrow(/sharedStashTransactionId/);
  });
});

// Checkpoint 4D.1B.1 §6 / 4D.1B.2 §2: description must match
// recordTripExpense.ts's own trusted persisted contract exactly - a
// non-empty, ALREADY-TRIMMED string of at most MAX_DESCRIPTION_LENGTH
// (500) characters. The mapper is a validator, not a normalizer: an
// un-trimmed persisted value is itself a malformed document and must be
// rejected, never silently re-trimmed.
describe("mapExpenseDocument - description reader/writer parity (4D.1B.1 §6 / 4D.1B.2 §2)", () => {
  it('"Hotel" maps', () => {
    const expense = mapExpenseDocument(
      "expense-1",
      validActiveExpenseData({description: "Hotel"})
    );
    expect(expense.description).toBe("Hotel");
  });

  it("exactly 500 already-trimmed characters maps", () => {
    const description = "x".repeat(500);
    const expense = mapExpenseDocument(
      "expense-1",
      validActiveExpenseData({description})
    );
    expect(expense.description).toBe(description);
  });

  it("501 characters rejects", () => {
    expect(() =>
      mapExpenseDocument(
        "expense-1",
        validActiveExpenseData({description: "x".repeat(501)})
      )
    ).toThrow(/description/);
  });

  it('"" rejects', () => {
    expect(() =>
      mapExpenseDocument("expense-1", validActiveExpenseData({description: ""}))
    ).toThrow(/description/);
  });

  it('"   " (whitespace-only) rejects', () => {
    expect(() =>
      mapExpenseDocument(
        "expense-1",
        validActiveExpenseData({description: "   "})
      )
    ).toThrow(/description/);
  });

  it('" Hotel" (leading whitespace) rejects', () => {
    expect(() =>
      mapExpenseDocument(
        "expense-1",
        validActiveExpenseData({description: " Hotel"})
      )
    ).toThrow(/description/);
  });

  it('"Hotel " (trailing whitespace) rejects', () => {
    expect(() =>
      mapExpenseDocument(
        "expense-1",
        validActiveExpenseData({description: "Hotel "})
      )
    ).toThrow(/description/);
  });

  it('"\\tHotel" (leading tab) rejects', () => {
    expect(() =>
      mapExpenseDocument(
        "expense-1",
        validActiveExpenseData({description: "\tHotel"})
      )
    ).toThrow(/description/);
  });

  it('"Taxi\\n" (trailing newline) rejects', () => {
    expect(() =>
      mapExpenseDocument(
        "expense-1",
        validActiveExpenseData({description: "Taxi\n"})
      )
    ).toThrow(/description/);
  });
});

// Checkpoint 4D.1B.1 §7: document-id byte-boundary coverage for
// isValidFirestoreDocumentIdShape, exercised indirectly through
// correction-link mapping (the helper itself is not exported).
describe("mapExpenseDocument - correction-link document-id shape boundaries (4D.1B.1 §7)", () => {
  it("an ordinary ASCII id is valid", () => {
    const expense = mapExpenseDocument(
      "expense-1",
      validActiveExpenseData({replacesExpenseId: "old-expense-42"})
    );
    expect(expense.replacesExpenseId).toBe("old-expense-42");
  });

  it('an id containing "/" is invalid', () => {
    expect(() =>
      mapExpenseDocument(
        "expense-1",
        validActiveExpenseData({replacesExpenseId: "a/b"})
      )
    ).toThrow(/replacesExpenseId/);
  });

  it('an id of exactly "." is invalid', () => {
    expect(() =>
      mapExpenseDocument(
        "expense-1",
        validActiveExpenseData({replacesExpenseId: "."})
      )
    ).toThrow(/replacesExpenseId/);
  });

  it('an id of exactly ".." is invalid', () => {
    expect(() =>
      mapExpenseDocument(
        "expense-1",
        validActiveExpenseData({replacesExpenseId: ".."})
      )
    ).toThrow(/replacesExpenseId/);
  });

  it("a clearly oversized multi-byte id (>1500 UTF-8 bytes) is rejected", () => {
    // Each "€" is a 3-byte UTF-8 character - 600 of them is 1800 bytes,
    // safely over the 1500-byte Firestore document-id cap.
    const oversizedId = "€".repeat(600);
    expect(() =>
      mapExpenseDocument(
        "expense-1",
        validActiveExpenseData({replacesExpenseId: oversizedId})
      )
    ).toThrow(/replacesExpenseId/);
  });
});

describe("mapExpenseSplitDocument", () => {
  function validSplitData(overrides: Record<string, unknown> = {}) {
    return {
      expenseId: "expense-1",
      tripId: "trip-1",
      userId: "member-1",
      amountMinor: 4500,
      createdAt: T1,
      ...overrides,
    };
  }

  it("maps a valid positive Split", () => {
    const split = mapExpenseSplitDocument("split-1", validSplitData());
    expect(split).toEqual<ExpenseSplit>({
      expenseId: "expense-1",
      tripId: "trip-1",
      userId: "member-1",
      amountMinor: 4500,
      createdAt: T1,
    });
  });

  it("maps a valid zero-dollar custom Split (intentional $0 share)", () => {
    const split = mapExpenseSplitDocument(
      "split-1",
      validSplitData({amountMinor: 0})
    );
    expect(split.amountMinor).toBe(0);
  });

  it("rejects a negative amountMinor", () => {
    expect(() =>
      mapExpenseSplitDocument("split-1", validSplitData({amountMinor: -1}))
    ).toThrow(/amountMinor/);
  });

  it("rejects a malformed createdAt", () => {
    expect(() =>
      mapExpenseSplitDocument(
        "split-1",
        validSplitData({createdAt: "not-a-timestamp"})
      )
    ).toThrow(/createdAt/);
  });

  it("rejects an out-of-range percentageBasisPoints", () => {
    expect(() =>
      mapExpenseSplitDocument(
        "split-1",
        validSplitData({percentageBasisPoints: 10001})
      )
    ).toThrow(/percentageBasisPoints/);
  });

  it("accepts a valid percentageBasisPoints", () => {
    const split = mapExpenseSplitDocument(
      "split-1",
      validSplitData({percentageBasisPoints: 5000})
    );
    expect(split.percentageBasisPoints).toBe(5000);
  });
});

describe("expenseBelongsToTrip (route integrity)", () => {
  it("returns true when the Expense's own tripId matches", () => {
    const expense = mapExpenseDocument("expense-1", validActiveExpenseData());
    expect(expenseBelongsToTrip(expense, "trip-1")).toBe(true);
  });

  it("returns false when the Expense belongs to a different Trip", () => {
    const expense = mapExpenseDocument("expense-1", validActiveExpenseData());
    expect(expenseBelongsToTrip(expense, "trip-2")).toBe(false);
  });
});

describe("sortExpensesForHistory", () => {
  function expenseWith(id: string, overrides: Partial<Expense> = {}): Expense {
    return {
      id,
      tripId: "trip-1",
      payerUid: "member-1",
      createdBy: "member-1",
      amountMinor: 100,
      currency: "USD",
      description: "x",
      splitStrategy: "equal",
      paymentSource: "member_out_of_pocket",
      status: "active",
      createdAt: T1,
      ...overrides,
    };
  }

  it("sorts by occurredAt ?? createdAt, descending", () => {
    const oldest = expenseWith("a", {createdAt: T1});
    const newest = expenseWith("b", {createdAt: T3});
    const middle = expenseWith("c", {createdAt: T2});
    const sorted = sortExpensesForHistory([oldest, newest, middle]);
    expect(sorted.map((e) => e.id)).toEqual(["b", "c", "a"]);
  });

  it("prefers occurredAt over createdAt when both are present", () => {
    const earlyCreatedLateOccurred = expenseWith("a", {
      createdAt: T1,
      occurredAt: T3,
    });
    const lateCreatedEarlyOccurred = expenseWith("b", {
      createdAt: T3,
      occurredAt: T1,
    });
    const sorted = sortExpensesForHistory([
      earlyCreatedLateOccurred,
      lateCreatedEarlyOccurred,
    ]);
    // "a" occurred later (T3) even though created earlier - it must sort first.
    expect(sorted.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("breaks an exact timestamp tie deterministically by ascending id", () => {
    const b = expenseWith("b", {createdAt: T1});
    const a = expenseWith("a", {createdAt: T1});
    const sorted = sortExpensesForHistory([b, a]);
    expect(sorted.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const input = [expenseWith("a", {createdAt: T1}), expenseWith("b", {createdAt: T2})];
    const inputCopy = [...input];
    sortExpensesForHistory(input);
    expect(input).toEqual(inputCopy);
  });
});

describe("buildRecordTripExpenseRequest", () => {
  const baseEqual: RecordTripExpenseInput = {
    tripId: "trip-1",
    payerUid: "member-1",
    amountMinor: 9000,
    currency: "USD",
    description: "Cabin rental",
    clientRequestId: "req-1",
    splitStrategy: "equal",
    participants: [{uid: "member-1"}, {uid: "member-2"}],
  };

  it("always sends paymentSource: member_out_of_pocket, never as a user choice", () => {
    const request = buildRecordTripExpenseRequest(baseEqual);
    expect(request.paymentSource).toBe("member_out_of_pocket");
  });

  it("omits occurredAt when not supplied", () => {
    const request = buildRecordTripExpenseRequest(baseEqual);
    expect("occurredAt" in request).toBe(false);
  });

  it("serializes a valid occurredAt Date to a full ISO instant", () => {
    const request = buildRecordTripExpenseRequest({
      ...baseEqual,
      occurredAt: new Date("2027-06-01T12:00:00.000Z"),
    });
    expect(request.occurredAt).toBe("2027-06-01T12:00:00.000Z");
  });

  it("rejects an invalid Date for occurredAt", () => {
    expect(() =>
      buildRecordTripExpenseRequest({
        ...baseEqual,
        occurredAt: new Date("not-a-real-date"),
      })
    ).toThrow(/occurredAt/);
  });

  it("omits category/replacesExpenseId when not supplied", () => {
    const request = buildRecordTripExpenseRequest(baseEqual);
    expect("category" in request).toBe(false);
    expect("replacesExpenseId" in request).toBe(false);
  });

  it("includes replacesExpenseId when supplied (correction mode)", () => {
    const request = buildRecordTripExpenseRequest({
      ...baseEqual,
      replacesExpenseId: "old-expense-1",
    });
    expect(request.replacesExpenseId).toBe("old-expense-1");
  });

  it("never accepts/sends createdBy, status, or any other trusted field (not expressible by the input type)", () => {
    const request = buildRecordTripExpenseRequest(baseEqual) as Record<string, unknown>;
    expect(request.createdBy).toBeUndefined();
    expect(request.status).toBeUndefined();
    expect(request.reversedAt).toBeUndefined();
  });
});

describe("parseRecordTripExpenseResponse", () => {
  it("accepts a valid { expenseId } response", () => {
    expect(parseRecordTripExpenseResponse({expenseId: "expense-1"})).toEqual({
      expenseId: "expense-1",
    });
  });

  it("rejects a non-object response", () => {
    expect(() => parseRecordTripExpenseResponse("nope")).toThrow();
  });

  it("rejects a response missing expenseId", () => {
    expect(() => parseRecordTripExpenseResponse({})).toThrow();
  });

  it("rejects a response with an empty-string expenseId", () => {
    expect(() => parseRecordTripExpenseResponse({expenseId: ""})).toThrow();
  });
});

describe("parseReverseTripExpenseResponse", () => {
  it("accepts a valid { expenseId } response", () => {
    expect(parseReverseTripExpenseResponse({expenseId: "expense-1"})).toEqual({
      expenseId: "expense-1",
    });
  });

  it("rejects a malformed response", () => {
    expect(() => parseReverseTripExpenseResponse(null)).toThrow();
  });
});

// =======================================================================
// GROUP 2: Firebase-SDK-dependent wiring (mocked)
// =======================================================================

function fakeDocSnap(exists: boolean, id: string, data?: Record<string, unknown>) {
  return {
    exists: () => exists,
    id,
    data: () => data,
  };
}

describe("fetchExpenseById (route-tripId integrity)", () => {
  it("returns the mapped Expense when its tripId matches the caller's expected tripId", async () => {
    mockGetDocFn.mockResolvedValue(
      fakeDocSnap(true, "expense-1", validActiveExpenseData())
    );
    const expense = await fetchExpenseById("trip-1", "expense-1");
    expect(expense).not.toBeNull();
    expect(expense?.tripId).toBe("trip-1");
  });

  it("returns null when the Expense belongs to a DIFFERENT Trip than the route's own tripId", async () => {
    mockGetDocFn.mockResolvedValue(
      fakeDocSnap(true, "expense-1", validActiveExpenseData({tripId: "trip-2"}))
    );
    const expense = await fetchExpenseById("trip-1", "expense-1");
    expect(expense).toBeNull();
  });

  it("returns null when the Expense does not exist", async () => {
    mockGetDocFn.mockResolvedValue(fakeDocSnap(false, "expense-1"));
    const expense = await fetchExpenseById("trip-1", "expense-1");
    expect(expense).toBeNull();
  });
});

describe("subscribeToExpenseById (route-tripId integrity, live)", () => {
  it("emits the mapped Expense when its tripId matches", () => {
    const onChange = jest.fn();
    mockOnSnapshotFn.mockImplementation((_ref, onNext) => {
      onNext(fakeDocSnap(true, "expense-1", validActiveExpenseData()));
      return () => {};
    });
    subscribeToExpenseById("trip-1", "expense-1", onChange);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]?.tripId).toBe("trip-1");
  });

  it("emits null for a cross-Trip Expense", () => {
    const onChange = jest.fn();
    mockOnSnapshotFn.mockImplementation((_ref, onNext) => {
      onNext(
        fakeDocSnap(true, "expense-1", validActiveExpenseData({tripId: "trip-2"}))
      );
      return () => {};
    });
    subscribeToExpenseById("trip-1", "expense-1", onChange);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("routes a mapping failure to onError, never emitting malformed data", () => {
    const onChange = jest.fn();
    const onError = jest.fn();
    mockOnSnapshotFn.mockImplementation((_ref, onNext) => {
      onNext(fakeDocSnap(true, "expense-1", validActiveExpenseData({amountMinor: -1})));
      return () => {};
    });
    subscribeToExpenseById("trip-1", "expense-1", onChange, onError);
    expect(onChange).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("subscribeToExpensesForTrip", () => {
  it("maps and sorts the snapshot's documents", () => {
    const onChange = jest.fn();
    mockOnSnapshotFn.mockImplementation((_q, onNext) => {
      onNext({
        forEach: (cb: (docSnap: ReturnType<typeof fakeDocSnap>) => void) => {
          cb(fakeDocSnap(true, "a", validActiveExpenseData({createdAt: T1})));
          cb(fakeDocSnap(true, "b", validActiveExpenseData({createdAt: T2})));
        },
      });
      return () => {};
    });
    subscribeToExpensesForTrip("trip-1", onChange);
    expect(onChange).toHaveBeenCalledTimes(1);
    const emitted = onChange.mock.calls[0][0] as Expense[];
    expect(emitted.map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("does NOT emit a partial list when one document fails to map - routes to onError instead", () => {
    const onChange = jest.fn();
    const onError = jest.fn();
    mockOnSnapshotFn.mockImplementation((_q, onNext) => {
      onNext({
        forEach: (cb: (docSnap: ReturnType<typeof fakeDocSnap>) => void) => {
          cb(fakeDocSnap(true, "good", validActiveExpenseData()));
          cb(fakeDocSnap(true, "bad", validActiveExpenseData({amountMinor: -1})));
        },
      });
      return () => {};
    });
    subscribeToExpensesForTrip("trip-1", onChange, onError);
    expect(onChange).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("fetchExpenseSplitsForExpense", () => {
  function fakeSplitsSnap(docs: {id: string; data: Record<string, unknown>}[]) {
    return {
      forEach: (cb: (docSnap: {id: string; data: () => Record<string, unknown>}) => void) => {
        docs.forEach((d) => cb({id: d.id, data: () => d.data}));
      },
    };
  }

  it("maps and sorts Splits by ascending userId", async () => {
    mockGetDocsFn.mockResolvedValue(
      fakeSplitsSnap([
        {
          id: "split-z",
          data: {expenseId: "expense-1", tripId: "trip-1", userId: "zzz", amountMinor: 100, createdAt: T1},
        },
        {
          id: "split-a",
          data: {expenseId: "expense-1", tripId: "trip-1", userId: "aaa", amountMinor: 100, createdAt: T1},
        },
      ])
    );
    const splits = await fetchExpenseSplitsForExpense("trip-1", "expense-1");
    expect(splits.map((s) => s.userId)).toEqual(["aaa", "zzz"]);
  });

  it("uses the two-filter query shape: tripId and expenseId, both passed to where()", async () => {
    mockGetDocsFn.mockResolvedValue(fakeSplitsSnap([]));
    await fetchExpenseSplitsForExpense("trip-1", "expense-1");
    const whereCalls = mockWhereFn.mock.calls;
    expect(whereCalls).toContainEqual(["tripId", "==", "trip-1"]);
    expect(whereCalls).toContainEqual(["expenseId", "==", "expense-1"]);
  });
});

describe("recordTripExpense / reverseTripExpense callable wrappers", () => {
  const baseEqual: RecordTripExpenseInput = {
    tripId: "trip-1",
    payerUid: "member-1",
    amountMinor: 9000,
    currency: "USD",
    description: "Cabin rental",
    clientRequestId: "req-1",
    splitStrategy: "equal",
    participants: [{uid: "member-1"}],
  };

  it("recordTripExpense resolves with the parsed { expenseId } on a valid response", async () => {
    const callable = jest.fn().mockResolvedValue({data: {expenseId: "expense-1"}});
    mockHttpsCallableFn.mockReturnValue(callable);
    const result = await recordTripExpense(baseEqual);
    expect(result).toEqual({expenseId: "expense-1"});
    expect(callable).toHaveBeenCalledWith(
      expect.objectContaining({paymentSource: "member_out_of_pocket"})
    );
  });

  it("recordTripExpense propagates a raw callable error unchanged (no catch-and-rewrite)", async () => {
    const originalError = Object.assign(new Error("permission-denied"), {
      code: "functions/permission-denied",
    });
    const callable = jest.fn().mockRejectedValue(originalError);
    mockHttpsCallableFn.mockReturnValue(callable);
    await expect(recordTripExpense(baseEqual)).rejects.toBe(originalError);
  });

  it("reverseTripExpense resolves with the parsed { expenseId } on a valid response", async () => {
    const callable = jest.fn().mockResolvedValue({data: {expenseId: "expense-1"}});
    mockHttpsCallableFn.mockReturnValue(callable);
    const result = await reverseTripExpense({
      expenseId: "expense-1",
      clientRequestId: "req-1",
    });
    expect(result).toEqual({expenseId: "expense-1"});
  });

  it("reverseTripExpense propagates a raw callable error unchanged", async () => {
    const originalError = Object.assign(new Error("not-found"), {
      code: "functions/not-found",
    });
    const callable = jest.fn().mockRejectedValue(originalError);
    mockHttpsCallableFn.mockReturnValue(callable);
    await expect(
      reverseTripExpense({expenseId: "expense-1", clientRequestId: "req-1"})
    ).rejects.toBe(originalError);
  });

  it("reverseTripExpense never sends tripId - the backend derives it from the persisted Expense", async () => {
    const callable = jest.fn().mockResolvedValue({data: {expenseId: "expense-1"}});
    mockHttpsCallableFn.mockReturnValue(callable);
    await reverseTripExpense({expenseId: "expense-1", clientRequestId: "req-1"});
    const sentPayload = callable.mock.calls[0][0] as Record<string, unknown>;
    expect("tripId" in sentPayload).toBe(false);
  });
});

describe("generateExpenseClientRequestId", () => {
  it("returns the id read off a fresh Firestore auto-id DocumentReference, with no network call", () => {
    mockDocFn.mockReturnValue({id: "auto-generated-id-123"});
    const id = generateExpenseClientRequestId();
    expect(id).toBe("auto-generated-id-123");
    expect(mockGetDocFn).not.toHaveBeenCalled();
    expect(mockHttpsCallableFn).not.toHaveBeenCalled();
  });
});
