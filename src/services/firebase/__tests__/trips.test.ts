// Tests for src/services/firebase/trips.ts's createTrip/
// generateTripClientRequestId (Checkpoint 5B.5B - client cutover to the
// trusted createTrip Cloud Function). Mirrors
// src/services/firebase/__tests__/expenses.test.ts's own httpsCallable-
// wiring convention exactly.
//
// "firebase/firestore"/"firebase/functions" and this app's own
// "../../../../firebase" module are mocked below for the same reason
// expenses.test.ts already mocks them - without this, Jest attempts to
// parse the real "firebase" package's ESM build, which jest-expo's
// default preset does not transform.
import {
  addDoc as mockAddDoc,
  doc as mockDoc,
} from "firebase/firestore";
import { httpsCallable as mockHttpsCallable } from "firebase/functions";
import { createTrip, generateTripClientRequestId } from "../trips";
import type { CreateTripInput } from "../../../types/domain";

jest.mock("firebase/firestore", () => ({
  addDoc: jest.fn(),
  collection: jest.fn((..._args: unknown[]) => ({__type: "collection"})),
  doc: jest.fn((..._args: unknown[]) => ({__type: "docRef"})),
  getDoc: jest.fn(),
  getDocs: jest.fn(),
  onSnapshot: jest.fn(),
  orderBy: jest.fn((..._args: unknown[]) => ({__type: "orderBy"})),
  query: jest.fn((...args: unknown[]) => ({__type: "query", args})),
  serverTimestamp: jest.fn(() => ({__type: "serverTimestamp"})),
  updateDoc: jest.fn(),
  where: jest.fn((...args: unknown[]) => ({__type: "where", args})),
}));

jest.mock("firebase/functions", () => ({
  httpsCallable: jest.fn(),
}));

jest.mock("../../../../firebase", () => ({
  db: {__type: "db"},
  functions: {__type: "functions"},
}));

// jest.Mock-typed aliases, matching expenses.test.ts's own convention.
const mockDocFn = mockDoc as unknown as jest.Mock;
const mockAddDocFn = mockAddDoc as unknown as jest.Mock;
const mockHttpsCallableFn = mockHttpsCallable as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

const BASE_INPUT: CreateTripInput = {
  clientRequestId: "req-1",
  title: "Canada Trip",
  location: "Banff, Canada",
  target: 5000,
  imageUrl: "https://example.com/canada.jpg",
  tripStartDate: "2027-06-12",
  tripEndDate: null,
};

describe("generateTripClientRequestId", () => {
  it("returns a non-empty safe id read off a fresh Firestore auto-id DocumentReference", () => {
    mockDocFn.mockReturnValue({id: "auto-generated-id-123"});
    const id = generateTripClientRequestId();
    expect(id).toBe("auto-generated-id-123");
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("performs no network write and creates no Trip document", () => {
    mockDocFn.mockReturnValue({id: "auto-generated-id-123"});
    generateTripClientRequestId();
    expect(mockAddDocFn).not.toHaveBeenCalled();
    expect(mockHttpsCallableFn).not.toHaveBeenCalled();
  });
});

describe("createTrip", () => {
  it("invokes the callable named \"createTrip\"", async () => {
    const callable = jest.fn().mockResolvedValue({data: {tripId: "req-1"}});
    mockHttpsCallableFn.mockReturnValue(callable);
    await createTrip(BASE_INPUT);
    expect(mockHttpsCallableFn).toHaveBeenCalledWith(
      expect.anything(),
      "createTrip"
    );
  });

  it("sends exactly the seven allowed keys", async () => {
    const callable = jest.fn().mockResolvedValue({data: {tripId: "req-1"}});
    mockHttpsCallableFn.mockReturnValue(callable);
    await createTrip(BASE_INPUT);
    const sent = callable.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(
      [
        "clientRequestId",
        "imageUrl",
        "location",
        "target",
        "title",
        "tripEndDate",
        "tripStartDate",
      ].sort()
    );
  });

  it("never sends ownerId, even if present on the input object", async () => {
    const callable = jest.fn().mockResolvedValue({data: {tripId: "req-1"}});
    mockHttpsCallableFn.mockReturnValue(callable);
    const forged = {
      ...BASE_INPUT,
      ownerId: "forged-uid",
    } as unknown as CreateTripInput;
    await createTrip(forged);
    const sent = callable.mock.calls[0][0] as Record<string, unknown>;
    expect("ownerId" in sent).toBe(false);
  });

  it("never sends memberIds, even if present on the input object", async () => {
    const callable = jest.fn().mockResolvedValue({data: {tripId: "req-1"}});
    mockHttpsCallableFn.mockReturnValue(callable);
    const forged = {
      ...BASE_INPUT,
      memberIds: ["forged-uid"],
    } as unknown as CreateTripInput;
    await createTrip(forged);
    const sent = callable.mock.calls[0][0] as Record<string, unknown>;
    expect("memberIds" in sent).toBe(false);
  });

  it("never sends any financial/ownership trusted field, even if present on the input object", async () => {
    const callable = jest.fn().mockResolvedValue({data: {tripId: "req-1"}});
    mockHttpsCallableFn.mockReturnValue(callable);
    const forged = {
      ...BASE_INPUT,
      saved: 100,
      ledgerOpeningBalanceMinor: 500,
      ledgerBalanceMinor: 500,
      currency: "EUR",
      ownershipModelState: "initialized",
      ownershipModelVersion: 1,
      creationRequest: {clientRequestId: "req-1"},
      createdAt: new Date(),
      lastUpdatedAt: new Date(),
      lastUpdatedBy: "forged-uid",
    } as unknown as CreateTripInput;
    await createTrip(forged);
    const sent = callable.mock.calls[0][0] as Record<string, unknown>;
    for (const key of [
      "saved",
      "ledgerOpeningBalanceMinor",
      "ledgerBalanceMinor",
      "currency",
      "ownershipModelState",
      "ownershipModelVersion",
      "creationRequest",
      "createdAt",
      "lastUpdatedAt",
      "lastUpdatedBy",
    ]) {
      expect(key in sent).toBe(false);
    }
  });

  it("resolves with the parsed { tripId } on a valid response", async () => {
    const callable = jest.fn().mockResolvedValue({data: {tripId: "req-1"}});
    mockHttpsCallableFn.mockReturnValue(callable);
    const result = await createTrip(BASE_INPUT);
    expect(result).toEqual({tripId: "req-1"});
  });

  it("rejects when the returned tripId does not equal the submitted clientRequestId", async () => {
    const callable = jest.fn().mockResolvedValue({
      data: {tripId: "a-different-id"},
    });
    mockHttpsCallableFn.mockReturnValue(callable);
    await expect(createTrip(BASE_INPUT)).rejects.toThrow(/did not match/);
  });

  it("rejects a response missing tripId", async () => {
    const callable = jest.fn().mockResolvedValue({data: {}});
    mockHttpsCallableFn.mockReturnValue(callable);
    await expect(createTrip(BASE_INPUT)).rejects.toThrow(/expected exactly/);
  });

  it("rejects a non-string tripId", async () => {
    const callable = jest.fn().mockResolvedValue({data: {tripId: 123}});
    mockHttpsCallableFn.mockReturnValue(callable);
    await expect(createTrip(BASE_INPUT)).rejects.toThrow(/non-empty string/);
  });

  it("rejects an empty-string tripId", async () => {
    const callable = jest.fn().mockResolvedValue({data: {tripId: ""}});
    mockHttpsCallableFn.mockReturnValue(callable);
    await expect(createTrip(BASE_INPUT)).rejects.toThrow(/non-empty string/);
  });

  it("rejects a response with an unexpected extra top-level key", async () => {
    const callable = jest.fn().mockResolvedValue({
      data: {tripId: "req-1", ownershipModelState: "initialized"},
    });
    mockHttpsCallableFn.mockReturnValue(callable);
    await expect(createTrip(BASE_INPUT)).rejects.toThrow(/expected exactly/);
  });

  it("rejects a non-object response", async () => {
    const callable = jest.fn().mockResolvedValue({data: "not-an-object"});
    mockHttpsCallableFn.mockReturnValue(callable);
    await expect(createTrip(BASE_INPUT)).rejects.toThrow(/expected an object/);
  });

  it("propagates a raw callable error unchanged (no catch-and-rewrite)", async () => {
    const originalError = Object.assign(new Error("already-exists"), {
      code: "functions/already-exists",
    });
    const callable = jest.fn().mockRejectedValue(originalError);
    mockHttpsCallableFn.mockReturnValue(callable);
    await expect(createTrip(BASE_INPUT)).rejects.toBe(originalError);
  });

  it("never performs a direct Firestore addDoc create", async () => {
    const callable = jest.fn().mockResolvedValue({data: {tripId: "req-1"}});
    mockHttpsCallableFn.mockReturnValue(callable);
    await createTrip(BASE_INPUT);
    expect(mockAddDocFn).not.toHaveBeenCalled();
  });
});
