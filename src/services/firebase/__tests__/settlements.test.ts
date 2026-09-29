// Tests for src/services/firebase/settlements.ts (Checkpoint 4E.3).
// Mirrors src/services/firebase/__tests__/expenses.test.ts's own
// structure/mocking strategy exactly. Two groups:
// 1. Pure functions (mapper, sort, route-integrity check, request
//    builder, response parsers) - exercised directly.
// 2. Firebase-SDK-dependent wiring (subscriptions, one-shot reads, the
//    trusted callables) - exercised against focused jest.mock()s below,
//    never a real Firestore/network call.
import type { Settlement } from "../../../types/domain";
import {
  buildRecordTripSettlementRequest,
  fetchSettlementById,
  generateSettlementClientRequestId,
  mapSettlementDocument,
  parseRecordTripSettlementResponse,
  parseReverseTripSettlementResponse,
  recordTripSettlement,
  reverseTripSettlement,
  settlementBelongsToTrip,
  sortSettlementsForHistory,
  subscribeToSettlementById,
  subscribeToSettlementsForTrip,
  type RecordTripSettlementInput,
} from "../settlements";
import {
  Timestamp as MockTimestampCtor,
  collection as mockCollection,
  doc as mockDoc,
  getDoc as mockGetDoc,
  onSnapshot as mockOnSnapshot,
  where as mockWhere,
} from "firebase/firestore";
import { httpsCallable as mockHttpsCallable } from "firebase/functions";

// Every mock in these two jest.mock() factories must be fully
// self-contained (no reference to an outer-scope variable) - since
// jest.mock() calls are hoisted above this file's own imports. The
// mocked jest.fn()s are retrieved for per-test configuration via the
// imports above instead - Jest resolves those to the exact same mock
// instance "../settlements" uses internally. Matches expenses.test.ts's
// own mock factories exactly.
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
    collection: jest.fn((..._args: unknown[]) => ({ __type: "collection" })),
    doc: jest.fn((..._args: unknown[]) => ({ __type: "docRef" })),
    getDoc: jest.fn(),
    onSnapshot: jest.fn(),
    query: jest.fn((...args: unknown[]) => ({ __type: "query", args })),
    where: jest.fn((...args: unknown[]) => ({ __type: "where", args })),
  };
});

jest.mock("firebase/functions", () => ({
  httpsCallable: jest.fn(),
}));

jest.mock("../../../../firebase", () => ({
  db: { __type: "db" },
  functions: { __type: "functions" },
}));

const MockTimestamp = MockTimestampCtor as unknown as {
  fromMillis(ms: number): import("firebase/firestore").Timestamp;
};

const T1 = MockTimestamp.fromMillis(1_700_000_000_000);
const T2 = MockTimestamp.fromMillis(1_700_000_100_000); // later than T1
const T3 = MockTimestamp.fromMillis(1_700_000_200_000); // later than T2

const mockCollectionFn = mockCollection as unknown as jest.Mock;
const mockDocFn = mockDoc as unknown as jest.Mock;
const mockGetDocFn = mockGetDoc as unknown as jest.Mock;
const mockOnSnapshotFn = mockOnSnapshot as unknown as jest.Mock;
const mockWhereFn = mockWhere as unknown as jest.Mock;
const mockHttpsCallableFn = mockHttpsCallable as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

function validActiveSettlementData(overrides: Record<string, unknown> = {}) {
  return {
    tripId: "trip-1",
    fromUid: "debtor-1",
    toUid: "recipient-1",
    amountMinor: 4000,
    currency: "USD",
    method: "venmo",
    createdAt: T1,
    createdBy: "recipient-1",
    status: "active",
    creationRequest: { tripId: "trip-1" }, // trusted-internal, must not pollute/reject
    ...overrides,
  };
}

function validReversedSettlementData(overrides: Record<string, unknown> = {}) {
  return {
    ...validActiveSettlementData(),
    status: "reversed",
    reversedAt: T2,
    reversedBy: "recipient-1",
    reversalRequest: { clientRequestId: "abc" }, // trusted-internal
    ...overrides,
  };
}

// =======================================================================
// GROUP 1: pure functions
// =======================================================================

describe("mapSettlementDocument", () => {
  it("maps a valid active Settlement", () => {
    const settlement = mapSettlementDocument(
      "settlement-1",
      validActiveSettlementData()
    );
    expect(settlement).toMatchObject({
      id: "settlement-1",
      tripId: "trip-1",
      fromUid: "debtor-1",
      toUid: "recipient-1",
      amountMinor: 4000,
      currency: "USD",
      method: "venmo",
      createdBy: "recipient-1",
      status: "active",
    });
    expect(settlement.createdAt).toBe(T1);
  });

  it("createdAt identity is retained (not copied/re-wrapped)", () => {
    const settlement = mapSettlementDocument(
      "settlement-1",
      validActiveSettlementData()
    );
    expect(settlement.createdAt).toBe(T1);
  });

  it("optional note maps", () => {
    const settlement = mapSettlementDocument(
      "settlement-1",
      validActiveSettlementData({ note: "Venmo @friend" })
    );
    expect(settlement.note).toBe("Venmo @friend");
  });

  it("optional occurredAt maps", () => {
    const settlement = mapSettlementDocument(
      "settlement-1",
      validActiveSettlementData({ occurredAt: T2 })
    );
    expect(settlement.occurredAt).toBe(T2);
  });

  it("maps a valid reversed Settlement, including reversal metadata", () => {
    const settlement = mapSettlementDocument(
      "settlement-1",
      validReversedSettlementData({ reversalReason: "Wrong amount" })
    );
    expect(settlement.status).toBe("reversed");
    expect(settlement.reversedAt).toBe(T2);
    expect(settlement.reversedBy).toBe("recipient-1");
    expect(settlement.reversalReason).toBe("Wrong amount");
  });

  it("reversed Settlement without reversalReason is valid", () => {
    const settlement = mapSettlementDocument(
      "settlement-1",
      validReversedSettlementData()
    );
    expect(settlement.status).toBe("reversed");
    expect(settlement.reversalReason).toBeUndefined();
  });

  it("trusted internal creationRequest/reversalRequest do not pollute the mapped Settlement and do not themselves cause rejection", () => {
    const settlement = mapSettlementDocument(
      "settlement-1",
      validReversedSettlementData({
        creationRequest: { anything: "goes here" },
        reversalRequest: { anything: "goes here too" },
      })
    );
    expect(
      (settlement as unknown as Record<string, unknown>).creationRequest
    ).toBeUndefined();
    expect(
      (settlement as unknown as Record<string, unknown>).reversalRequest
    ).toBeUndefined();
  });

  it("unknown/backend-internal extra fields never cause rejection on their own", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validActiveSettlementData({ someFutureBackendField: 42 })
      )
    ).not.toThrow();
  });
});

describe("mapSettlementDocument - base validation failures", () => {
  it("missing tripId rejects", () => {
    const data = validActiveSettlementData();
    delete (data as Record<string, unknown>).tripId;
    expect(() => mapSettlementDocument("settlement-1", data)).toThrow(
      /tripId/
    );
  });

  it("blank tripId rejects", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validActiveSettlementData({ tripId: "" })
      )
    ).toThrow(/tripId/);
  });

  it("whitespace-only tripId rejects (Checkpoint 4E.3A)", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validActiveSettlementData({ tripId: "   " })
      )
    ).toThrow(/tripId/);
  });

  it("missing fromUid rejects", () => {
    const data = validActiveSettlementData();
    delete (data as Record<string, unknown>).fromUid;
    expect(() => mapSettlementDocument("settlement-1", data)).toThrow(
      /fromUid/
    );
  });

  it("blank fromUid rejects", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validActiveSettlementData({ fromUid: "" })
      )
    ).toThrow(/fromUid/);
  });

  it("whitespace-only fromUid rejects (Checkpoint 4E.3A)", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validActiveSettlementData({ fromUid: "\t" })
      )
    ).toThrow(/fromUid/);
  });

  it("missing toUid rejects", () => {
    const data = validActiveSettlementData();
    delete (data as Record<string, unknown>).toUid;
    expect(() => mapSettlementDocument("settlement-1", data)).toThrow(
      /toUid/
    );
  });

  it("blank toUid rejects", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validActiveSettlementData({ toUid: "" })
      )
    ).toThrow(/toUid/);
  });

  it("whitespace-only toUid rejects (Checkpoint 4E.3A)", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validActiveSettlementData({ toUid: "\n" })
      )
    ).toThrow(/toUid/);
  });

  it("amount 0 rejects", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validActiveSettlementData({ amountMinor: 0 })
      )
    ).toThrow(/amountMinor/);
  });

  it("negative amount rejects", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validActiveSettlementData({ amountMinor: -100 })
      )
    ).toThrow(/amountMinor/);
  });

  it("float amount rejects", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validActiveSettlementData({ amountMinor: 12.5 })
      )
    ).toThrow(/amountMinor/);
  });

  it("unsafe integer amount rejects", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validActiveSettlementData({ amountMinor: Number.MAX_SAFE_INTEGER + 10 })
      )
    ).toThrow(/amountMinor/);
  });

  it("non-USD currency rejects", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validActiveSettlementData({ currency: "EUR" })
      )
    ).toThrow(/currency/);
  });

  it("invalid method rejects", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validActiveSettlementData({ method: "bitcoin" })
      )
    ).toThrow(/method/);
  });

  it("malformed createdAt (not a real Firestore Timestamp) rejects", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validActiveSettlementData({ createdAt: new Date().toISOString() })
      )
    ).toThrow(/createdAt/);
  });

  it("blank createdBy rejects", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validActiveSettlementData({ createdBy: "" })
      )
    ).toThrow(/createdBy/);
  });

  it("whitespace-only createdBy rejects (Checkpoint 4E.3A)", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validActiveSettlementData({ createdBy: "   " })
      )
    ).toThrow(/createdBy/);
  });

  it("malformed status rejects", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validActiveSettlementData({ status: "bogus" })
      )
    ).toThrow(/status/);
  });

  it("malformed occurredAt rejects", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validActiveSettlementData({ occurredAt: "not-a-timestamp" })
      )
    ).toThrow(/occurredAt/);
  });
});

// Checkpoint 4E.3A: the trusted backend guarantees these persisted
// invariants (fromUid !== toUid always; createdBy === toUid because
// recordTripSettlement only authorizes authUid === toUid; reversedBy ===
// toUid because reverseTripSettlement only authorizes
// authUid === settlement.toUid) - the mapper enforces the same
// invariants rather than accepting a document that could never have been
// legitimately persisted by the trusted callables.
describe("mapSettlementDocument - 4E.3A: party/creator/reverser invariants", () => {
  it("fromUid === toUid rejects", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validActiveSettlementData({ fromUid: "same-uid", toUid: "same-uid" })
      )
    ).toThrow(/fromUid and toUid/);
  });

  it("createdBy different from toUid rejects", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validActiveSettlementData({ createdBy: "someone-else" })
      )
    ).toThrow(/createdBy/);
  });

  it("reversedBy different from toUid rejects", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validReversedSettlementData({ reversedBy: "someone-else" })
      )
    ).toThrow(/reversedBy/);
  });

  it("whitespace-only reversedBy rejects", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validReversedSettlementData({ reversedBy: "   " })
      )
    ).toThrow(/reversedBy/);
  });
});

describe("mapSettlementDocument - note reader/writer parity", () => {
  it("valid trimmed note maps", () => {
    const settlement = mapSettlementDocument(
      "settlement-1",
      validActiveSettlementData({ note: "Paid via Venmo" })
    );
    expect(settlement.note).toBe("Paid via Venmo");
  });

  it("exactly 500 chars maps", () => {
    const note = "x".repeat(500);
    const settlement = mapSettlementDocument(
      "settlement-1",
      validActiveSettlementData({ note })
    );
    expect(settlement.note).toBe(note);
  });

  it("501 chars rejects", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validActiveSettlementData({ note: "x".repeat(501) })
      )
    ).toThrow(/note/);
  });

  it("empty note rejects if persisted", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validActiveSettlementData({ note: "" })
      )
    ).toThrow(/note/);
  });

  it("whitespace-only note rejects", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validActiveSettlementData({ note: "   " })
      )
    ).toThrow(/note/);
  });

  it("leading/trailing whitespace note rejects", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validActiveSettlementData({ note: " Paid via Venmo " })
      )
    ).toThrow(/note/);
  });

  it("non-string note rejects", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validActiveSettlementData({ note: 42 })
      )
    ).toThrow(/note/);
  });
});

describe("mapSettlementDocument - reversal conditional shape", () => {
  it("active + reversedAt rejects", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validActiveSettlementData({ reversedAt: T2 })
      )
    ).toThrow(/reversedAt/);
  });

  it("active + reversedBy rejects", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validActiveSettlementData({ reversedBy: "recipient-1" })
      )
    ).toThrow(/reversedBy/);
  });

  it("active + reversalReason rejects", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validActiveSettlementData({ reversalReason: "Wrong amount" })
      )
    ).toThrow(/reversalReason/);
  });

  it("reversed + missing reversedAt rejects", () => {
    const data = validReversedSettlementData();
    delete (data as Record<string, unknown>).reversedAt;
    expect(() => mapSettlementDocument("settlement-1", data)).toThrow(
      /reversedAt/
    );
  });

  it("reversed + malformed reversedAt rejects", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validReversedSettlementData({ reversedAt: "not-a-timestamp" })
      )
    ).toThrow(/reversedAt/);
  });

  it("reversed + missing reversedBy rejects", () => {
    const data = validReversedSettlementData();
    delete (data as Record<string, unknown>).reversedBy;
    expect(() => mapSettlementDocument("settlement-1", data)).toThrow(
      /reversedBy/
    );
  });

  it("reversed + blank reversedBy rejects", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validReversedSettlementData({ reversedBy: "" })
      )
    ).toThrow(/reversedBy/);
  });

  it("reversed + malformed reversalReason (non-string) rejects", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validReversedSettlementData({ reversalReason: 42 })
      )
    ).toThrow(/reversalReason/);
  });

  it("reversed + whitespace-only reversalReason rejects", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validReversedSettlementData({ reversalReason: "   " })
      )
    ).toThrow(/reversalReason/);
  });

  it("reversed + untrimmed reversalReason rejects", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validReversedSettlementData({ reversalReason: " Wrong amount " })
      )
    ).toThrow(/reversalReason/);
  });

  it("reversed + reversalReason over 500 chars rejects", () => {
    expect(() =>
      mapSettlementDocument(
        "settlement-1",
        validReversedSettlementData({ reversalReason: "x".repeat(501) })
      )
    ).toThrow(/reversalReason/);
  });

  it("reversed + reversalReason of exactly 500 chars maps", () => {
    const reversalReason = "x".repeat(500);
    const settlement = mapSettlementDocument(
      "settlement-1",
      validReversedSettlementData({ reversalReason })
    );
    expect(settlement.reversalReason).toBe(reversalReason);
  });
});

describe("settlementBelongsToTrip (route integrity)", () => {
  it("returns true when the Settlement's own tripId matches", () => {
    const settlement = mapSettlementDocument(
      "settlement-1",
      validActiveSettlementData()
    );
    expect(settlementBelongsToTrip(settlement, "trip-1")).toBe(true);
  });

  it("returns false when the Settlement belongs to a different Trip", () => {
    const settlement = mapSettlementDocument(
      "settlement-1",
      validActiveSettlementData()
    );
    expect(settlementBelongsToTrip(settlement, "trip-2")).toBe(false);
  });
});

describe("sortSettlementsForHistory", () => {
  function settlementWith(
    id: string,
    overrides: Partial<Settlement> = {}
  ): Settlement {
    return {
      id,
      tripId: "trip-1",
      fromUid: "debtor-1",
      toUid: "recipient-1",
      amountMinor: 4000,
      currency: "USD",
      method: "venmo",
      createdAt: T1,
      createdBy: "recipient-1",
      status: "active",
      ...overrides,
    };
  }

  it("sorts by occurredAt ?? createdAt, descending (createdAt descending)", () => {
    const oldest = settlementWith("a", { createdAt: T1 });
    const newest = settlementWith("b", { createdAt: T3 });
    const middle = settlementWith("c", { createdAt: T2 });
    const sorted = sortSettlementsForHistory([oldest, newest, middle]);
    expect(sorted.map((s) => s.id)).toEqual(["b", "c", "a"]);
  });

  it("occurredAt takes precedence over createdAt when both are present", () => {
    const earlyCreatedLateOccurred = settlementWith("a", {
      createdAt: T1,
      occurredAt: T3,
    });
    const lateCreatedEarlyOccurred = settlementWith("b", {
      createdAt: T3,
      occurredAt: T1,
    });
    const sorted = sortSettlementsForHistory([
      earlyCreatedLateOccurred,
      lateCreatedEarlyOccurred,
    ]);
    expect(sorted.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("breaks an exact-time tie deterministically by ascending id", () => {
    const b = settlementWith("b", { createdAt: T1 });
    const a = settlementWith("a", { createdAt: T1 });
    const sorted = sortSettlementsForHistory([b, a]);
    expect(sorted.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const input = [
      settlementWith("a", { createdAt: T1 }),
      settlementWith("b", { createdAt: T2 }),
    ];
    const inputCopy = [...input];
    sortSettlementsForHistory(input);
    expect(input).toEqual(inputCopy);
  });
});

describe("buildRecordTripSettlementRequest", () => {
  const base: RecordTripSettlementInput = {
    tripId: "trip-1",
    fromUid: "debtor-1",
    toUid: "recipient-1",
    amountMinor: 4000,
    currency: "USD",
    method: "venmo",
    clientRequestId: "req-1",
  };

  it("required fields preserved", () => {
    const request = buildRecordTripSettlementRequest(base);
    expect(request).toMatchObject({
      tripId: "trip-1",
      fromUid: "debtor-1",
      toUid: "recipient-1",
      amountMinor: 4000,
      currency: "USD",
      method: "venmo",
      clientRequestId: "req-1",
    });
  });

  it("omits note when absent", () => {
    const request = buildRecordTripSettlementRequest(base);
    expect("note" in request).toBe(false);
  });

  it("includes note faithfully when supplied", () => {
    const request = buildRecordTripSettlementRequest({
      ...base,
      note: "  Paid via Venmo  ",
    });
    expect(request.note).toBe("  Paid via Venmo  ");
  });

  it("omits occurredAt when absent", () => {
    const request = buildRecordTripSettlementRequest(base);
    expect("occurredAt" in request).toBe(false);
  });

  it("serializes a valid occurredAt Date to the exact ISO instant", () => {
    const request = buildRecordTripSettlementRequest({
      ...base,
      occurredAt: new Date("2027-06-01T12:00:00.000Z"),
    });
    expect(request.occurredAt).toBe("2027-06-01T12:00:00.000Z");
  });

  it("rejects an invalid Date for occurredAt", () => {
    expect(() =>
      buildRecordTripSettlementRequest({
        ...base,
        occurredAt: new Date("not-a-real-date"),
      })
    ).toThrow(/occurredAt/);
  });

  it("never sends createdBy/status/reversal/internal fields (not expressible by the input type)", () => {
    const request = buildRecordTripSettlementRequest(base) as Record<
      string,
      unknown
    >;
    expect(request.createdBy).toBeUndefined();
    expect(request.status).toBeUndefined();
    expect(request.reversedAt).toBeUndefined();
    expect(request.creationRequest).toBeUndefined();
  });
});

describe("parseRecordTripSettlementResponse", () => {
  it("accepts a valid { settlementId } response", () => {
    expect(
      parseRecordTripSettlementResponse({ settlementId: "settlement-1" })
    ).toEqual({ settlementId: "settlement-1" });
  });

  it("rejects a null response", () => {
    expect(() => parseRecordTripSettlementResponse(null)).toThrow();
  });

  it("rejects a non-object response", () => {
    expect(() => parseRecordTripSettlementResponse("nope")).toThrow();
  });

  it("rejects a response missing settlementId", () => {
    expect(() => parseRecordTripSettlementResponse({})).toThrow();
  });

  it("rejects a response with an empty-string settlementId", () => {
    expect(() =>
      parseRecordTripSettlementResponse({ settlementId: "" })
    ).toThrow();
  });
});

describe("parseReverseTripSettlementResponse", () => {
  it("accepts a valid { settlementId } response", () => {
    expect(
      parseReverseTripSettlementResponse({ settlementId: "settlement-1" })
    ).toEqual({ settlementId: "settlement-1" });
  });

  it("rejects a malformed response", () => {
    expect(() => parseReverseTripSettlementResponse(null)).toThrow();
  });
});

// =======================================================================
// GROUP 2: Firebase-SDK-dependent wiring (mocked)
// =======================================================================

function fakeDocSnap(
  exists: boolean,
  id: string,
  data?: Record<string, unknown>
) {
  return {
    exists: () => exists,
    id,
    data: () => data,
  };
}

describe("fetchSettlementById (route-tripId integrity)", () => {
  it("returns the mapped Settlement when its tripId matches the caller's expected tripId", async () => {
    mockGetDocFn.mockResolvedValue(
      fakeDocSnap(true, "settlement-1", validActiveSettlementData())
    );
    const settlement = await fetchSettlementById("trip-1", "settlement-1");
    expect(settlement).not.toBeNull();
    expect(settlement?.tripId).toBe("trip-1");
  });

  it("returns null when the Settlement belongs to a DIFFERENT Trip than the route's own tripId", async () => {
    mockGetDocFn.mockResolvedValue(
      fakeDocSnap(
        true,
        "settlement-1",
        validActiveSettlementData({ tripId: "trip-2" })
      )
    );
    const settlement = await fetchSettlementById("trip-1", "settlement-1");
    expect(settlement).toBeNull();
  });

  it("returns null when the Settlement does not exist", async () => {
    mockGetDocFn.mockResolvedValue(fakeDocSnap(false, "settlement-1"));
    const settlement = await fetchSettlementById("trip-1", "settlement-1");
    expect(settlement).toBeNull();
  });

  it("rejects (throws) when the document is malformed", async () => {
    mockGetDocFn.mockResolvedValue(
      fakeDocSnap(
        true,
        "settlement-1",
        validActiveSettlementData({ amountMinor: -1 })
      )
    );
    await expect(fetchSettlementById("trip-1", "settlement-1")).rejects.toThrow();
  });
});

describe("subscribeToSettlementById (route-tripId integrity, live)", () => {
  it("emits the mapped Settlement when its tripId matches", () => {
    const onChange = jest.fn();
    mockOnSnapshotFn.mockImplementation((_ref, onNext) => {
      onNext(fakeDocSnap(true, "settlement-1", validActiveSettlementData()));
      return () => {};
    });
    subscribeToSettlementById("trip-1", "settlement-1", onChange);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]?.tripId).toBe("trip-1");
  });

  it("emits null for a cross-Trip Settlement", () => {
    const onChange = jest.fn();
    mockOnSnapshotFn.mockImplementation((_ref, onNext) => {
      onNext(
        fakeDocSnap(
          true,
          "settlement-1",
          validActiveSettlementData({ tripId: "trip-2" })
        )
      );
      return () => {};
    });
    subscribeToSettlementById("trip-1", "settlement-1", onChange);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("emits null when the document is missing", () => {
    const onChange = jest.fn();
    mockOnSnapshotFn.mockImplementation((_ref, onNext) => {
      onNext(fakeDocSnap(false, "settlement-1"));
      return () => {};
    });
    subscribeToSettlementById("trip-1", "settlement-1", onChange);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("routes a mapping failure to onError, never emitting malformed data (no partial/fake object)", () => {
    const onChange = jest.fn();
    const onError = jest.fn();
    mockOnSnapshotFn.mockImplementation((_ref, onNext) => {
      onNext(
        fakeDocSnap(
          true,
          "settlement-1",
          validActiveSettlementData({ amountMinor: -1 })
        )
      );
      return () => {};
    });
    subscribeToSettlementById("trip-1", "settlement-1", onChange, onError);
    expect(onChange).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("subscribeToSettlementsForTrip", () => {
  it("constructs the query with a tripId equality filter", () => {
    mockOnSnapshotFn.mockImplementation((_q, onNext) => {
      onNext({ forEach: () => {} });
      return () => {};
    });
    subscribeToSettlementsForTrip("trip-1", jest.fn());
    const whereCalls = mockWhereFn.mock.calls;
    expect(whereCalls).toContainEqual(["tripId", "==", "trip-1"]);
  });

  it("maps and sorts the snapshot's documents", () => {
    const onChange = jest.fn();
    mockOnSnapshotFn.mockImplementation((_q, onNext) => {
      onNext({
        forEach: (cb: (docSnap: ReturnType<typeof fakeDocSnap>) => void) => {
          cb(
            fakeDocSnap(
              true,
              "a",
              validActiveSettlementData({ createdAt: T1 })
            )
          );
          cb(
            fakeDocSnap(
              true,
              "b",
              validActiveSettlementData({ createdAt: T2 })
            )
          );
        },
      });
      return () => {};
    });
    subscribeToSettlementsForTrip("trip-1", onChange);
    expect(onChange).toHaveBeenCalledTimes(1);
    const emitted = onChange.mock.calls[0][0] as Settlement[];
    expect(emitted.map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("does NOT emit a partial list when one document fails to map - routes to onError instead", () => {
    const onChange = jest.fn();
    const onError = jest.fn();
    mockOnSnapshotFn.mockImplementation((_q, onNext) => {
      onNext({
        forEach: (cb: (docSnap: ReturnType<typeof fakeDocSnap>) => void) => {
          cb(fakeDocSnap(true, "good", validActiveSettlementData()));
          cb(
            fakeDocSnap(
              true,
              "bad",
              validActiveSettlementData({ amountMinor: -1 })
            )
          );
        },
      });
      return () => {};
    });
    subscribeToSettlementsForTrip("trip-1", onChange, onError);
    expect(onChange).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("wrong-Trip defensive mismatch fails rather than silently rendering (routes to onError, no partial list)", () => {
    const onChange = jest.fn();
    const onError = jest.fn();
    mockOnSnapshotFn.mockImplementation((_q, onNext) => {
      onNext({
        forEach: (cb: (docSnap: ReturnType<typeof fakeDocSnap>) => void) => {
          cb(fakeDocSnap(true, "good", validActiveSettlementData()));
          cb(
            fakeDocSnap(
              true,
              "wrong-trip",
              validActiveSettlementData({ tripId: "trip-2" })
            )
          );
        },
      });
      return () => {};
    });
    subscribeToSettlementsForTrip("trip-1", onChange, onError);
    expect(onChange).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("Firestore listener error forwards unchanged to onError", () => {
    const onChange = jest.fn();
    const onError = jest.fn();
    const listenerError = new Error("listener failed");
    mockOnSnapshotFn.mockImplementation((_q, _onNext, onErr) => {
      onErr(listenerError);
      return () => {};
    });
    subscribeToSettlementsForTrip("trip-1", onChange, onError);
    expect(onError).toHaveBeenCalledWith(listenerError);
  });
});

describe("generateSettlementClientRequestId", () => {
  it("returns the mocked Firestore auto-id", () => {
    mockDocFn.mockReturnValue({ id: "auto-generated-id-123" });
    const id = generateSettlementClientRequestId();
    expect(id).toBe("auto-generated-id-123");
  });

  it("performs no direct write API (no getDoc/httpsCallable call)", () => {
    mockDocFn.mockReturnValue({ id: "auto-generated-id-123" });
    generateSettlementClientRequestId();
    expect(mockGetDocFn).not.toHaveBeenCalled();
    expect(mockHttpsCallableFn).not.toHaveBeenCalled();
  });

  it("uses the tripSettlements collection (Checkpoint 4E.3A: proves the exact collection name, not just that a collection() result was passed to doc())", () => {
    mockDocFn.mockReturnValue({ id: "auto-generated-id-123" });
    generateSettlementClientRequestId();
    // collection(db, "tripSettlements") - assert the mocked collection()
    // itself was called with the "tripSettlements" name, not merely that
    // doc() received *some* collection-shaped object.
    expect(mockCollectionFn).toHaveBeenCalledWith(
      { __type: "db" },
      "tripSettlements"
    );
  });
});

describe("recordTripSettlement / reverseTripSettlement callable wrappers", () => {
  const baseInput: RecordTripSettlementInput = {
    tripId: "trip-1",
    fromUid: "debtor-1",
    toUid: "recipient-1",
    amountMinor: 4000,
    currency: "USD",
    method: "venmo",
    clientRequestId: "req-1",
  };

  it("recordTripSettlement calls the callable named exactly recordTripSettlement", async () => {
    const callable = jest
      .fn()
      .mockResolvedValue({ data: { settlementId: "settlement-1" } });
    mockHttpsCallableFn.mockReturnValue(callable);
    await recordTripSettlement(baseInput);
    expect(mockHttpsCallableFn).toHaveBeenCalledWith(
      { __type: "functions" },
      "recordTripSettlement"
    );
  });

  it("recordTripSettlement sends the exact payload", async () => {
    const callable = jest
      .fn()
      .mockResolvedValue({ data: { settlementId: "settlement-1" } });
    mockHttpsCallableFn.mockReturnValue(callable);
    await recordTripSettlement(baseInput);
    expect(callable).toHaveBeenCalledWith({
      tripId: "trip-1",
      fromUid: "debtor-1",
      toUid: "recipient-1",
      amountMinor: 4000,
      currency: "USD",
      method: "venmo",
      clientRequestId: "req-1",
    });
  });

  it("recordTripSettlement resolves with the parsed { settlementId } on a valid response", async () => {
    const callable = jest
      .fn()
      .mockResolvedValue({ data: { settlementId: "settlement-1" } });
    mockHttpsCallableFn.mockReturnValue(callable);
    const result = await recordTripSettlement(baseInput);
    expect(result).toEqual({ settlementId: "settlement-1" });
  });

  it("recordTripSettlement rejects a malformed response", async () => {
    const callable = jest.fn().mockResolvedValue({ data: {} });
    mockHttpsCallableFn.mockReturnValue(callable);
    await expect(recordTripSettlement(baseInput)).rejects.toThrow();
  });

  it("recordTripSettlement propagates a raw callable rejection unchanged (no catch-and-rewrite)", async () => {
    const originalError = Object.assign(new Error("permission-denied"), {
      code: "functions/permission-denied",
    });
    const callable = jest.fn().mockRejectedValue(originalError);
    mockHttpsCallableFn.mockReturnValue(callable);
    await expect(recordTripSettlement(baseInput)).rejects.toBe(originalError);
  });

  it("reverseTripSettlement calls the callable named exactly reverseTripSettlement", async () => {
    const callable = jest
      .fn()
      .mockResolvedValue({ data: { settlementId: "settlement-1" } });
    mockHttpsCallableFn.mockReturnValue(callable);
    await reverseTripSettlement({
      settlementId: "settlement-1",
      clientRequestId: "req-1",
    });
    expect(mockHttpsCallableFn).toHaveBeenCalledWith(
      { __type: "functions" },
      "reverseTripSettlement"
    );
  });

  it("reverseTripSettlement payload contains settlementId + clientRequestId, and NO tripId", async () => {
    const callable = jest
      .fn()
      .mockResolvedValue({ data: { settlementId: "settlement-1" } });
    mockHttpsCallableFn.mockReturnValue(callable);
    await reverseTripSettlement({
      settlementId: "settlement-1",
      clientRequestId: "req-1",
    });
    const sentPayload = callable.mock.calls[0][0] as Record<string, unknown>;
    expect(sentPayload).toEqual({
      settlementId: "settlement-1",
      clientRequestId: "req-1",
    });
    expect("tripId" in sentPayload).toBe(false);
  });

  it("reverseTripSettlement omits reversalReason when absent", async () => {
    const callable = jest
      .fn()
      .mockResolvedValue({ data: { settlementId: "settlement-1" } });
    mockHttpsCallableFn.mockReturnValue(callable);
    await reverseTripSettlement({
      settlementId: "settlement-1",
      clientRequestId: "req-1",
    });
    const sentPayload = callable.mock.calls[0][0] as Record<string, unknown>;
    expect("reversalReason" in sentPayload).toBe(false);
  });

  it("reverseTripSettlement transmits reversalReason faithfully when present", async () => {
    const callable = jest
      .fn()
      .mockResolvedValue({ data: { settlementId: "settlement-1" } });
    mockHttpsCallableFn.mockReturnValue(callable);
    await reverseTripSettlement({
      settlementId: "settlement-1",
      clientRequestId: "req-1",
      reversalReason: "  Wrong amount  ",
    });
    const sentPayload = callable.mock.calls[0][0] as Record<string, unknown>;
    expect(sentPayload.reversalReason).toBe("  Wrong amount  ");
  });

  it("reverseTripSettlement resolves with the parsed { settlementId } on a valid response", async () => {
    const callable = jest
      .fn()
      .mockResolvedValue({ data: { settlementId: "settlement-1" } });
    mockHttpsCallableFn.mockReturnValue(callable);
    const result = await reverseTripSettlement({
      settlementId: "settlement-1",
      clientRequestId: "req-1",
    });
    expect(result).toEqual({ settlementId: "settlement-1" });
  });

  it("reverseTripSettlement rejects a malformed response", async () => {
    const callable = jest.fn().mockResolvedValue({ data: null });
    mockHttpsCallableFn.mockReturnValue(callable);
    await expect(
      reverseTripSettlement({
        settlementId: "settlement-1",
        clientRequestId: "req-1",
      })
    ).rejects.toThrow();
  });

  it("reverseTripSettlement propagates a raw callable rejection unchanged", async () => {
    const originalError = Object.assign(new Error("not-found"), {
      code: "functions/not-found",
    });
    const callable = jest.fn().mockRejectedValue(originalError);
    mockHttpsCallableFn.mockReturnValue(callable);
    await expect(
      reverseTripSettlement({
        settlementId: "settlement-1",
        clientRequestId: "req-1",
      })
    ).rejects.toBe(originalError);
  });
});
