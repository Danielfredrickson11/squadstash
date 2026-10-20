// Tests for src/services/firebase/tripInvitations.ts (Checkpoint 5C.3C -
// client cutover of acceptTripInvitation to the trusted Cloud Function,
// plus the new getTripInvitationPreview wrapper). Mirrors
// src/services/firebase/__tests__/trips.test.ts's own httpsCallable-
// wiring convention exactly.
//
// "firebase/firestore"/"firebase/functions" and this app's own
// "../../../../firebase" module are mocked below for the same reason
// trips.test.ts already mocks them - without this, Jest attempts to
// parse the real "firebase" package's ESM build, which jest-expo's
// default preset does not transform.
import {
  doc as mockDoc,
  serverTimestamp as mockServerTimestamp,
  updateDoc as mockUpdateDoc,
} from "firebase/firestore";
import { httpsCallable as mockHttpsCallable } from "firebase/functions";
import {
  acceptTripInvitation,
  cancelTripInvitation,
  createTripInvitation,
  declineTripInvitation,
  getTripInvitationPreview,
} from "../tripInvitations";

jest.mock("firebase/firestore", () => ({
  collection: jest.fn((..._args: unknown[]) => ({ __type: "collection" })),
  doc: jest.fn((..._args: unknown[]) => ({ __type: "docRef" })),
  getDoc: jest.fn(),
  getDocs: jest.fn(),
  query: jest.fn((...args: unknown[]) => ({ __type: "query", args })),
  serverTimestamp: jest.fn(() => ({ __type: "serverTimestamp" })),
  updateDoc: jest.fn(),
  where: jest.fn((...args: unknown[]) => ({ __type: "where", args })),
}));

jest.mock("firebase/functions", () => ({
  httpsCallable: jest.fn(),
}));

jest.mock("../../../../firebase", () => ({
  db: { __type: "db" },
  functions: { __type: "functions" },
}));

const mockDocFn = mockDoc as unknown as jest.Mock;
const mockUpdateDocFn = mockUpdateDoc as unknown as jest.Mock;
const mockServerTimestampFn = mockServerTimestamp as unknown as jest.Mock;
const mockHttpsCallableFn = mockHttpsCallable as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockDocFn.mockReturnValue({ __type: "docRef" });
});

const VALID_PREVIEW_RESPONSE = {
  tripId: "trip-1",
  title: "Iceland Trip",
  location: "Reykjavik, Iceland",
  imageUrl: "https://example.com/iceland.jpg",
  tripStartDate: "2027-09-01",
  tripEndDate: "2027-09-10",
};

describe("getTripInvitationPreview", () => {
  it('invokes the callable named "getTripInvitationPreview"', async () => {
    const callable = jest.fn().mockResolvedValue({ data: VALID_PREVIEW_RESPONSE });
    mockHttpsCallableFn.mockReturnValue(callable);
    await getTripInvitationPreview("trip-1_invitee-uid");
    expect(mockHttpsCallableFn).toHaveBeenCalledWith(
      expect.anything(),
      "getTripInvitationPreview"
    );
  });

  it("sends exactly { invitationId }", async () => {
    const callable = jest.fn().mockResolvedValue({ data: VALID_PREVIEW_RESPONSE });
    mockHttpsCallableFn.mockReturnValue(callable);
    await getTripInvitationPreview("trip-1_invitee-uid");
    expect(callable).toHaveBeenCalledWith({ invitationId: "trip-1_invitee-uid" });
  });

  it("does not send uid/tripId/member fields even if forged into the call site", async () => {
    const callable = jest.fn().mockResolvedValue({ data: VALID_PREVIEW_RESPONSE });
    mockHttpsCallableFn.mockReturnValue(callable);
    await getTripInvitationPreview("trip-1_invitee-uid");
    const sent = callable.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(sent)).toEqual(["invitationId"]);
    expect("uid" in sent).toBe(false);
    expect("tripId" in sent).toBe(false);
    expect("memberIds" in sent).toBe(false);
  });

  it("returns the parsed object for a valid six-field response", async () => {
    const callable = jest.fn().mockResolvedValue({ data: VALID_PREVIEW_RESPONSE });
    mockHttpsCallableFn.mockReturnValue(callable);
    const result = await getTripInvitationPreview("trip-1_invitee-uid");
    expect(result).toEqual(VALID_PREVIEW_RESPONSE);
  });

  it("accepts null for every nullable field", async () => {
    const response = {
      ...VALID_PREVIEW_RESPONSE,
      location: null,
      tripStartDate: null,
      tripEndDate: null,
    };
    const callable = jest.fn().mockResolvedValue({ data: response });
    mockHttpsCallableFn.mockReturnValue(callable);
    const result = await getTripInvitationPreview("trip-1_invitee-uid");
    expect(result).toEqual(response);
  });

  it("rejects a non-object response", async () => {
    const callable = jest.fn().mockResolvedValue({ data: "not-an-object" });
    mockHttpsCallableFn.mockReturnValue(callable);
    await expect(getTripInvitationPreview("trip-1_invitee-uid")).rejects.toThrow(
      /expected an object/
    );
  });

  it("rejects a response missing a required field", async () => {
    const { title, ...withoutTitle } = VALID_PREVIEW_RESPONSE;
    const callable = jest.fn().mockResolvedValue({ data: withoutTitle });
    mockHttpsCallableFn.mockReturnValue(callable);
    await expect(getTripInvitationPreview("trip-1_invitee-uid")).rejects.toThrow(
      /unexpected field shape/
    );
  });

  it("rejects a response with an extra top-level key", async () => {
    const callable = jest.fn().mockResolvedValue({
      data: { ...VALID_PREVIEW_RESPONSE, ownerId: "forged-uid" },
    });
    mockHttpsCallableFn.mockReturnValue(callable);
    await expect(getTripInvitationPreview("trip-1_invitee-uid")).rejects.toThrow(
      /unexpected field shape/
    );
  });

  it("rejects a non-string tripId", async () => {
    const callable = jest.fn().mockResolvedValue({
      data: { ...VALID_PREVIEW_RESPONSE, tripId: 123 },
    });
    mockHttpsCallableFn.mockReturnValue(callable);
    await expect(getTripInvitationPreview("trip-1_invitee-uid")).rejects.toThrow(
      /tripId must be a non-empty string/
    );
  });

  it("rejects an empty-string tripId", async () => {
    const callable = jest.fn().mockResolvedValue({
      data: { ...VALID_PREVIEW_RESPONSE, tripId: "" },
    });
    mockHttpsCallableFn.mockReturnValue(callable);
    await expect(getTripInvitationPreview("trip-1_invitee-uid")).rejects.toThrow(
      /tripId must be a non-empty string/
    );
  });

  it("rejects a wrong-typed title", async () => {
    const callable = jest.fn().mockResolvedValue({
      data: { ...VALID_PREVIEW_RESPONSE, title: 42 },
    });
    mockHttpsCallableFn.mockReturnValue(callable);
    await expect(getTripInvitationPreview("trip-1_invitee-uid")).rejects.toThrow(
      /title must be a string/
    );
  });

  it("rejects a wrong-typed imageUrl", async () => {
    const callable = jest.fn().mockResolvedValue({
      data: { ...VALID_PREVIEW_RESPONSE, imageUrl: 42 },
    });
    mockHttpsCallableFn.mockReturnValue(callable);
    await expect(getTripInvitationPreview("trip-1_invitee-uid")).rejects.toThrow(
      /imageUrl must be a string/
    );
  });

  it("rejects a wrong-typed location", async () => {
    const callable = jest.fn().mockResolvedValue({
      data: { ...VALID_PREVIEW_RESPONSE, location: 42 },
    });
    mockHttpsCallableFn.mockReturnValue(callable);
    await expect(getTripInvitationPreview("trip-1_invitee-uid")).rejects.toThrow(
      /location must be a string or null/
    );
  });

  it("rejects a wrong-typed tripStartDate", async () => {
    const callable = jest.fn().mockResolvedValue({
      data: { ...VALID_PREVIEW_RESPONSE, tripStartDate: 42 },
    });
    mockHttpsCallableFn.mockReturnValue(callable);
    await expect(getTripInvitationPreview("trip-1_invitee-uid")).rejects.toThrow(
      /tripStartDate must be a string or null/
    );
  });

  it("rejects a wrong-typed tripEndDate", async () => {
    const callable = jest.fn().mockResolvedValue({
      data: { ...VALID_PREVIEW_RESPONSE, tripEndDate: 42 },
    });
    mockHttpsCallableFn.mockReturnValue(callable);
    await expect(getTripInvitationPreview("trip-1_invitee-uid")).rejects.toThrow(
      /tripEndDate must be a string or null/
    );
  });

  it("propagates a raw callable error unchanged (no catch-and-rewrite)", async () => {
    const originalError = Object.assign(new Error("not found"), {
      code: "functions/not-found",
    });
    const callable = jest.fn().mockRejectedValue(originalError);
    mockHttpsCallableFn.mockReturnValue(callable);
    await expect(getTripInvitationPreview("trip-1_invitee-uid")).rejects.toBe(
      originalError
    );
  });
});

describe("acceptTripInvitation", () => {
  it('invokes the callable named "acceptTripInvitation"', async () => {
    const callable = jest.fn().mockResolvedValue({ data: { tripId: "trip-1" } });
    mockHttpsCallableFn.mockReturnValue(callable);
    await acceptTripInvitation("trip-1_invitee-uid", "terms-doc-1");
    expect(mockHttpsCallableFn).toHaveBeenCalledWith(
      expect.anything(),
      "acceptTripInvitation"
    );
  });

  it("sends exactly the two allowed keys", async () => {
    const callable = jest.fn().mockResolvedValue({ data: { tripId: "trip-1" } });
    mockHttpsCallableFn.mockReturnValue(callable);
    await acceptTripInvitation("trip-1_invitee-uid", "terms-doc-1");
    const sent = callable.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(
      ["acceptedTermsDocId", "invitationId"].sort()
    );
    expect(sent).toEqual({
      invitationId: "trip-1_invitee-uid",
      acceptedTermsDocId: "terms-doc-1",
    });
  });

  it("resolves with the parsed { tripId } on a valid response", async () => {
    const callable = jest.fn().mockResolvedValue({ data: { tripId: "trip-1" } });
    mockHttpsCallableFn.mockReturnValue(callable);
    const result = await acceptTripInvitation("trip-1_invitee-uid", "terms-doc-1");
    expect(result).toEqual({ tripId: "trip-1" });
  });

  it("rejects a non-object response", async () => {
    const callable = jest.fn().mockResolvedValue({ data: "not-an-object" });
    mockHttpsCallableFn.mockReturnValue(callable);
    await expect(
      acceptTripInvitation("trip-1_invitee-uid", "terms-doc-1")
    ).rejects.toThrow(/expected an object/);
  });

  it("rejects a response missing tripId", async () => {
    const callable = jest.fn().mockResolvedValue({ data: {} });
    mockHttpsCallableFn.mockReturnValue(callable);
    await expect(
      acceptTripInvitation("trip-1_invitee-uid", "terms-doc-1")
    ).rejects.toThrow(/expected exactly/);
  });

  it("rejects an empty-string tripId", async () => {
    const callable = jest.fn().mockResolvedValue({ data: { tripId: "" } });
    mockHttpsCallableFn.mockReturnValue(callable);
    await expect(
      acceptTripInvitation("trip-1_invitee-uid", "terms-doc-1")
    ).rejects.toThrow(/non-empty string/);
  });

  it("rejects a non-string tripId", async () => {
    const callable = jest.fn().mockResolvedValue({ data: { tripId: 123 } });
    mockHttpsCallableFn.mockReturnValue(callable);
    await expect(
      acceptTripInvitation("trip-1_invitee-uid", "terms-doc-1")
    ).rejects.toThrow(/non-empty string/);
  });

  it("rejects a response with an unexpected extra top-level key", async () => {
    const callable = jest.fn().mockResolvedValue({
      data: { tripId: "trip-1", memberIds: ["forged-uid"] },
    });
    mockHttpsCallableFn.mockReturnValue(callable);
    await expect(
      acceptTripInvitation("trip-1_invitee-uid", "terms-doc-1")
    ).rejects.toThrow(/expected exactly/);
  });

  it("propagates a raw callable error unchanged (no catch-and-rewrite)", async () => {
    const originalError = Object.assign(new Error("permission denied"), {
      code: "functions/permission-denied",
    });
    const callable = jest.fn().mockRejectedValue(originalError);
    mockHttpsCallableFn.mockReturnValue(callable);
    await expect(
      acceptTripInvitation("trip-1_invitee-uid", "terms-doc-1")
    ).rejects.toBe(originalError);
  });

  it('preserves details.reason === "terms_changed" as the exact same error object', async () => {
    const originalError = Object.assign(new Error("terms changed"), {
      code: "functions/failed-precondition",
      details: { reason: "terms_changed" },
    });
    const callable = jest.fn().mockRejectedValue(originalError);
    mockHttpsCallableFn.mockReturnValue(callable);

    let caught: unknown;
    try {
      await acceptTripInvitation("trip-1_invitee-uid", "terms-doc-1");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(originalError);
    expect((caught as { details?: { reason?: string } }).details?.reason).toBe(
      "terms_changed"
    );
  });

  it("never calls updateDoc (no direct Firestore acceptance fallback)", async () => {
    const callable = jest.fn().mockResolvedValue({ data: { tripId: "trip-1" } });
    mockHttpsCallableFn.mockReturnValue(callable);
    await acceptTripInvitation("trip-1_invitee-uid", "terms-doc-1");
    expect(mockUpdateDocFn).not.toHaveBeenCalled();
  });
});

describe("declineTripInvitation (unchanged direct write)", () => {
  it("calls updateDoc", async () => {
    await declineTripInvitation("trip-1", "invitee-uid");
    expect(mockUpdateDocFn).toHaveBeenCalledTimes(1);
  });

  it('writes status: "declined"', async () => {
    mockServerTimestampFn.mockReturnValue({ __type: "serverTimestamp" });
    await declineTripInvitation("trip-1", "invitee-uid");
    expect(mockUpdateDocFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "declined" })
    );
  });

  it("never invokes the acceptTripInvitation callable", async () => {
    await declineTripInvitation("trip-1", "invitee-uid");
    expect(mockHttpsCallableFn).not.toHaveBeenCalled();
  });
});

describe("cancelTripInvitation (unchanged direct write)", () => {
  it("calls updateDoc", async () => {
    await cancelTripInvitation("trip-1", "invitee-uid");
    expect(mockUpdateDocFn).toHaveBeenCalledTimes(1);
  });

  it('writes status: "cancelled"', async () => {
    mockServerTimestampFn.mockReturnValue({ __type: "serverTimestamp" });
    await cancelTripInvitation("trip-1", "invitee-uid");
    expect(mockUpdateDocFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "cancelled" })
    );
  });
});

// Regression guard - this checkpoint's scope never intended to touch
// createTripInvitation's own behavior.
describe("createTripInvitation (unaffected by this checkpoint)", () => {
  it('still invokes the callable named "createTripInvitation" and returns its data', async () => {
    const callable = jest
      .fn()
      .mockResolvedValue({ data: { invitationId: "trip-1_invitee-uid", inviteeUid: "invitee-uid" } });
    mockHttpsCallableFn.mockReturnValue(callable);
    const result = await createTripInvitation("trip-1", "friend@example.com");
    expect(mockHttpsCallableFn).toHaveBeenCalledWith(
      expect.anything(),
      "createTripInvitation"
    );
    expect(callable).toHaveBeenCalledWith({
      tripId: "trip-1",
      inviteeEmail: "friend@example.com",
    });
    expect(result).toEqual({ invitationId: "trip-1_invitee-uid", inviteeUid: "invitee-uid" });
  });
});
