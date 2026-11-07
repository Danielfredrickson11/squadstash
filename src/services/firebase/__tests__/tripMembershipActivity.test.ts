// Tests for src/services/firebase/tripMembershipActivity.ts (Checkpoint
// 6.8B2) - the client parser/validator for a persisted
// tripMembershipActivity document, and the paginated read-only query
// service. "firebase/firestore" is mocked below for the same reason
// every other service test file in this directory mocks it (see
// savingsTransactions.test.ts's own comment) - without this, Jest
// attempts to parse the real "firebase" package's ESM build, which
// jest-expo's default preset does not transform.
import type { DocumentData } from "firebase/firestore";
import {
  getDocs as mockGetDocs,
  limit as mockLimit,
  orderBy as mockOrderBy,
  query as mockQuery,
  startAfter as mockStartAfter,
  Timestamp,
  where as mockWhere,
} from "firebase/firestore";
import {
  fetchTripMembershipActivityPage,
  parseTripMembershipActivityDocument,
} from "../tripMembershipActivity";

jest.mock("firebase/firestore", () => ({
  Timestamp: class MockTimestamp {},
  collection: jest.fn((..._args: unknown[]) => ({ __type: "collection" })),
  getDocs: jest.fn(),
  limit: jest.fn((...args: unknown[]) => ({ __type: "limit", args })),
  orderBy: jest.fn((...args: unknown[]) => ({ __type: "orderBy", args })),
  query: jest.fn((...args: unknown[]) => ({ __type: "query", args })),
  startAfter: jest.fn((...args: unknown[]) => ({ __type: "startAfter", args })),
  where: jest.fn((...args: unknown[]) => ({ __type: "where", args })),
}));

jest.mock("../../../../firebase", () => ({
  db: { __type: "db" },
}));

const mockGetDocsFn = mockGetDocs as unknown as jest.Mock;
const mockLimitFn = mockLimit as unknown as jest.Mock;
const mockOrderByFn = mockOrderBy as unknown as jest.Mock;
const mockQueryFn = mockQuery as unknown as jest.Mock;
const mockStartAfterFn = mockStartAfter as unknown as jest.Mock;
const mockWhereFn = mockWhere as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

const VALID_CREATED_AT = new Timestamp(0, 0);

function validActivityData(
  overrides: Record<string, unknown> = {}
): DocumentData {
  return {
    tripId: "trip-1",
    type: "trip_created",
    actorUid: "owner-1",
    targetUid: "owner-1",
    schemaVersion: 1,
    createdAt: VALID_CREATED_AT,
    ...overrides,
  };
}

function fakeDoc(id: string, data: DocumentData) {
  return { id, data: () => data };
}

describe("parseTripMembershipActivityDocument - each supported event family", () => {
  it("parses a well-formed trip_created document, hydrating id from the document id", () => {
    const event = parseTripMembershipActivityDocument(
      "trip_created:trip-1",
      validActivityData()
    );
    expect(event).toEqual({
      id: "trip_created:trip-1",
      tripId: "trip-1",
      type: "trip_created",
      actorUid: "owner-1",
      targetUid: "owner-1",
      schemaVersion: 1,
      createdAt: VALID_CREATED_AT,
    });
  });

  it.each([
    "invitation_created",
    "invitation_accepted",
    "invitation_declined",
    "invitation_cancelled",
  ])("parses a well-formed %s document (invitationId present)", (type) => {
    const event = parseTripMembershipActivityDocument(
      `${type}:trip-1_invitee-1`,
      validActivityData({
        type,
        actorUid: "owner-1",
        targetUid: "invitee-1",
        invitationId: "trip-1_invitee-1",
      })
    );
    expect(event.type).toBe(type);
    expect((event as { invitationId: string }).invitationId).toBe(
      "trip-1_invitee-1"
    );
  });

  it.each(["member_left", "member_removed"])(
    "parses a well-formed %s document (no invitationId)",
    (type) => {
      const event = parseTripMembershipActivityDocument(
        `${type}:trip-1_uid-1`,
        validActivityData({ type, actorUid: "owner-1", targetUid: "uid-1" })
      );
      expect(event.type).toBe(type);
      expect("invitationId" in event).toBe(false);
    }
  );

  it("parses a well-formed history_tracking_started document (null actor/target)", () => {
    const event = parseTripMembershipActivityDocument(
      "history_tracking_started:trip-1",
      validActivityData({
        type: "history_tracking_started",
        actorUid: null,
        targetUid: null,
      })
    );
    expect(event.type).toBe("history_tracking_started");
    expect(event.actorUid).toBeNull();
    expect(event.targetUid).toBeNull();
  });
});

describe("parseTripMembershipActivityDocument - document id hydration", () => {
  it("uses the exact id argument, never a field from data", () => {
    const event = parseTripMembershipActivityDocument(
      "exact-doc-id-123",
      validActivityData()
    );
    expect(event.id).toBe("exact-doc-id-123");
  });
});

describe("parseTripMembershipActivityDocument - createdAt validation", () => {
  it("rejects a missing createdAt", () => {
    const data = validActivityData();
    delete (data as Record<string, unknown>).createdAt;
    expect(() =>
      parseTripMembershipActivityDocument("doc-1", data)
    ).toThrow(/createdAt must be a real Firestore Timestamp/);
  });

  it("rejects a non-Timestamp createdAt (plain object)", () => {
    expect(() =>
      parseTripMembershipActivityDocument(
        "doc-1",
        validActivityData({ createdAt: { seconds: 0, nanoseconds: 0 } })
      )
    ).toThrow(/createdAt must be a real Firestore Timestamp/);
  });

  it("accepts a genuine Timestamp instance", () => {
    expect(() =>
      parseTripMembershipActivityDocument(
        "doc-1",
        validActivityData({ createdAt: new Timestamp(0, 0) })
      )
    ).not.toThrow();
  });
});

describe("parseTripMembershipActivityDocument - malformed documents fail closed", () => {
  it("rejects a missing/empty tripId", () => {
    expect(() =>
      parseTripMembershipActivityDocument(
        "doc-1",
        validActivityData({ tripId: "" })
      )
    ).toThrow(/tripId must be a non-empty string/);
  });

  it("rejects an unknown type", () => {
    expect(() =>
      parseTripMembershipActivityDocument(
        "doc-1",
        validActivityData({ type: "bogus_event" })
      )
    ).toThrow(/unrecognized type/);
  });

  it("rejects invitation_expired and member_role_changed (never-approved types)", () => {
    for (const type of ["invitation_expired", "member_role_changed"]) {
      expect(() =>
        parseTripMembershipActivityDocument(
          "doc-1",
          validActivityData({ type })
        )
      ).toThrow(/unrecognized type/);
    }
  });

  it("rejects a wrong schemaVersion", () => {
    expect(() =>
      parseTripMembershipActivityDocument(
        "doc-1",
        validActivityData({ schemaVersion: 2 })
      )
    ).toThrow(/unsupported schemaVersion/);
  });

  it("rejects an invitation type missing its required invitationId", () => {
    expect(() =>
      parseTripMembershipActivityDocument(
        "doc-1",
        validActivityData({ type: "invitation_created" })
      )
    ).toThrow(/requires a non-empty invitationId/);
  });

  it("rejects a non-invitation type carrying an invitationId", () => {
    expect(() =>
      parseTripMembershipActivityDocument(
        "doc-1",
        validActivityData({ invitationId: "should-not-be-here" })
      )
    ).toThrow(/unexpected persisted field "invitationId"/);
  });

  it("rejects a real event type with a null actorUid", () => {
    expect(() =>
      parseTripMembershipActivityDocument(
        "doc-1",
        validActivityData({ actorUid: null })
      )
    ).toThrow(/requires non-empty string actorUid\/targetUid/);
  });

  it("rejects a real event type with an empty-string targetUid", () => {
    expect(() =>
      parseTripMembershipActivityDocument(
        "doc-1",
        validActivityData({ targetUid: "" })
      )
    ).toThrow(/requires non-empty string actorUid\/targetUid/);
  });

  it("rejects a real event type with a non-string actorUid", () => {
    expect(() =>
      parseTripMembershipActivityDocument(
        "doc-1",
        validActivityData({ actorUid: 12345 })
      )
    ).toThrow(/requires non-empty string actorUid\/targetUid/);
  });

  it("rejects history_tracking_started with a non-null actorUid", () => {
    expect(() =>
      parseTripMembershipActivityDocument(
        "doc-1",
        validActivityData({
          type: "history_tracking_started",
          actorUid: "owner-1",
          targetUid: null,
        })
      )
    ).toThrow(/requires actorUid and targetUid to both be null/);
  });
});

describe("parseTripMembershipActivityDocument - 6.8B2R hardening: persisted id rejection", () => {
  it("rejects a document that persists an id field, even if it would otherwise be well-formed", () => {
    expect(() =>
      parseTripMembershipActivityDocument(
        "trusted-doc-id",
        validActivityData({ id: "forged-id" })
      )
    ).toThrow(/must not contain an id field/);
  });

  it("the hydrated id comes ONLY from the function's id argument, never from data - proven by the rejection above applying regardless of what the forged id value is", () => {
    expect(() =>
      parseTripMembershipActivityDocument(
        "trusted-doc-id",
        validActivityData({ id: "trusted-doc-id" }) // even a MATCHING forged id is still rejected
      )
    ).toThrow(/must not contain an id field/);
  });

  it("rejects an empty-string id argument", () => {
    expect(() =>
      parseTripMembershipActivityDocument("", validActivityData())
    ).toThrow(/id must be a non-empty string/);
  });

  it("rejects a non-string id argument", () => {
    expect(() =>
      parseTripMembershipActivityDocument(
        12345 as unknown as string,
        validActivityData()
      )
    ).toThrow(/id must be a non-empty string/);
  });
});

describe("parseTripMembershipActivityDocument - 6.8B2R hardening: exact persisted schema", () => {
  it("rejects an arbitrary unexpected persisted field on an otherwise well-formed trip_created document", () => {
    expect(() =>
      parseTripMembershipActivityDocument(
        "doc-1",
        validActivityData({ unexpectedField: "forged" })
      )
    ).toThrow(/unexpected persisted field "unexpectedField"/);
  });

  it("rejects an arbitrary unexpected persisted field on an otherwise well-formed invitation_created document", () => {
    expect(() =>
      parseTripMembershipActivityDocument(
        "doc-1",
        validActivityData({
          type: "invitation_created",
          targetUid: "invitee-1",
          invitationId: "trip-1_invitee-1",
          legacyField: "forged",
        })
      )
    ).toThrow(/unexpected persisted field "legacyField"/);
  });

  it("still accepts a well-formed document carrying exactly the common allowed fields", () => {
    expect(() =>
      parseTripMembershipActivityDocument("doc-1", validActivityData())
    ).not.toThrow();
  });

  it("still accepts a well-formed invitation document carrying exactly the common fields plus invitationId", () => {
    expect(() =>
      parseTripMembershipActivityDocument(
        "doc-1",
        validActivityData({
          type: "invitation_accepted",
          invitationId: "trip-1_owner-1",
        })
      )
    ).not.toThrow();
  });
});

describe("fetchTripMembershipActivityPage - query shape", () => {
  it("filters by exact tripId", async () => {
    mockGetDocsFn.mockResolvedValue({ docs: [] });
    await fetchTripMembershipActivityPage("trip-1");
    expect(mockWhereFn).toHaveBeenCalledWith("tripId", "==", "trip-1");
  });

  it("orders newest-first by createdAt", async () => {
    mockGetDocsFn.mockResolvedValue({ docs: [] });
    await fetchTripMembershipActivityPage("trip-1");
    expect(mockOrderByFn).toHaveBeenCalledWith("createdAt", "desc");
  });

  it("requests pageSize + 1 documents (default pageSize 20 -> limit(21))", async () => {
    mockGetDocsFn.mockResolvedValue({ docs: [] });
    await fetchTripMembershipActivityPage("trip-1");
    expect(mockLimitFn).toHaveBeenCalledWith(21);
  });

  it("respects a custom pageSize", async () => {
    mockGetDocsFn.mockResolvedValue({ docs: [] });
    await fetchTripMembershipActivityPage("trip-1", { pageSize: 5 });
    expect(mockLimitFn).toHaveBeenCalledWith(6);
  });

  it("does not call startAfter on the first page (no cursor)", async () => {
    mockGetDocsFn.mockResolvedValue({ docs: [] });
    await fetchTripMembershipActivityPage("trip-1");
    expect(mockStartAfterFn).not.toHaveBeenCalled();
  });

  it("calls startAfter with the provided cursor on a subsequent page", async () => {
    mockGetDocsFn.mockResolvedValue({ docs: [] });
    const cursor = fakeDoc("cursor-doc", validActivityData()) as never;
    await fetchTripMembershipActivityPage("trip-1", { cursor });
    expect(mockStartAfterFn).toHaveBeenCalledWith(cursor);
  });
});

describe("fetchTripMembershipActivityPage - 6.8B2R hardening: input validation", () => {
  it("rejects an empty-string tripId before issuing any Firestore query", async () => {
    await expect(fetchTripMembershipActivityPage("")).rejects.toThrow(
      /tripId must be a non-empty string/
    );
    expect(mockGetDocsFn).not.toHaveBeenCalled();
    expect(mockQueryFn).not.toHaveBeenCalled();
  });

  it("rejects a non-string tripId before issuing any Firestore query", async () => {
    await expect(
      fetchTripMembershipActivityPage(12345 as unknown as string)
    ).rejects.toThrow(/tripId must be a non-empty string/);
    expect(mockGetDocsFn).not.toHaveBeenCalled();
  });

  it("rejects pageSize 0", async () => {
    await expect(
      fetchTripMembershipActivityPage("trip-1", { pageSize: 0 })
    ).rejects.toThrow(/pageSize must be a positive integer/);
    expect(mockGetDocsFn).not.toHaveBeenCalled();
  });

  it("rejects a negative pageSize", async () => {
    await expect(
      fetchTripMembershipActivityPage("trip-1", { pageSize: -5 })
    ).rejects.toThrow(/pageSize must be a positive integer/);
    expect(mockGetDocsFn).not.toHaveBeenCalled();
  });

  it("rejects a fractional pageSize", async () => {
    await expect(
      fetchTripMembershipActivityPage("trip-1", { pageSize: 2.5 })
    ).rejects.toThrow(/pageSize must be a positive integer/);
    expect(mockGetDocsFn).not.toHaveBeenCalled();
  });

  it("still accepts the default page size (20)", async () => {
    mockGetDocsFn.mockResolvedValue({ docs: [] });
    await expect(fetchTripMembershipActivityPage("trip-1")).resolves.toEqual({
      events: [],
      nextCursor: null,
      hasMore: false,
    });
    expect(mockLimitFn).toHaveBeenCalledWith(21);
  });

  it("still accepts a valid custom positive integer page size", async () => {
    mockGetDocsFn.mockResolvedValue({ docs: [] });
    await expect(
      fetchTripMembershipActivityPage("trip-1", { pageSize: 1 })
    ).resolves.toEqual({ events: [], nextCursor: null, hasMore: false });
    expect(mockLimitFn).toHaveBeenCalledWith(2);
  });
});

describe("fetchTripMembershipActivityPage - pagination behavior", () => {
  it("returns an empty page with hasMore false and nextCursor null when there are no documents", async () => {
    mockGetDocsFn.mockResolvedValue({ docs: [] });
    const page = await fetchTripMembershipActivityPage("trip-1");
    expect(page).toEqual({ events: [], nextCursor: null, hasMore: false });
  });

  it("hasMore is false and nextCursor is null when exactly pageSize documents are returned", async () => {
    const docs = Array.from({ length: 3 }, (_, i) =>
      fakeDoc(`doc-${i}`, validActivityData())
    );
    mockGetDocsFn.mockResolvedValue({ docs });
    const page = await fetchTripMembershipActivityPage("trip-1", { pageSize: 3 });
    expect(page.events).toHaveLength(3);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("hasMore is true and the extra (pageSize+1-th) document is trimmed, with nextCursor set to the last RETURNED doc", async () => {
    const docs = Array.from({ length: 4 }, (_, i) =>
      fakeDoc(`doc-${i}`, validActivityData())
    );
    mockGetDocsFn.mockResolvedValue({ docs });
    const page = await fetchTripMembershipActivityPage("trip-1", { pageSize: 3 });
    expect(page.events).toHaveLength(3);
    expect(page.events.map((e) => e.id)).toEqual(["doc-0", "doc-1", "doc-2"]);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(docs[2]);
  });

  it("second-page behavior: the nextCursor from page one can be passed as page two's cursor", async () => {
    const pageOneDocs = Array.from({ length: 3 }, (_, i) =>
      fakeDoc(`doc-${i}`, validActivityData())
    );
    mockGetDocsFn.mockResolvedValueOnce({ docs: pageOneDocs });
    const pageOne = await fetchTripMembershipActivityPage("trip-1", {
      pageSize: 2,
    });
    expect(pageOne.hasMore).toBe(true);
    expect(pageOne.nextCursor).toBe(pageOneDocs[1]);

    mockGetDocsFn.mockResolvedValueOnce({ docs: [] });
    await fetchTripMembershipActivityPage("trip-1", {
      pageSize: 2,
      cursor: pageOne.nextCursor,
    });
    expect(mockStartAfterFn).toHaveBeenCalledWith(pageOneDocs[1]);
  });

  it("a malformed document fails the WHOLE page fetch (never silently skipped)", async () => {
    const docs = [
      fakeDoc("good-doc", validActivityData()),
      fakeDoc("bad-doc", validActivityData({ type: "bogus_event" })),
    ];
    mockGetDocsFn.mockResolvedValue({ docs });
    await expect(
      fetchTripMembershipActivityPage("trip-1", { pageSize: 10 })
    ).rejects.toThrow(/unrecognized type/);
  });

  it("propagates a read/query error rather than swallowing it", async () => {
    mockGetDocsFn.mockRejectedValue(new Error("permission-denied"));
    await expect(fetchTripMembershipActivityPage("trip-1")).rejects.toThrow(
      "permission-denied"
    );
  });
});

// Regression guard: query() must be called at all (sanity-checking the
// mocks above are wired through the real call chain, not bypassed).
describe("fetchTripMembershipActivityPage - sanity", () => {
  it("calls query() exactly once per page fetch", async () => {
    mockGetDocsFn.mockResolvedValue({ docs: [] });
    await fetchTripMembershipActivityPage("trip-1");
    expect(mockQueryFn).toHaveBeenCalledTimes(1);
  });
});
