// Presentation + logic tests for InviteTripMemberDialog (Checkpoint
// 6.2). Mirrors components/trips/__tests__/TripTermsEditor.test.tsx's
// own react-test-renderer tree-walk convention (no new test dependency,
// no @testing-library/react-native). The Firebase/navigation/auth
// dependencies (fetchCurrentTripTerms, createTripInvitation, useRouter,
// useAuth) are mocked at the module boundary; lookupUserByEmail is also
// mocked so a test can prove it is never called (Checkpoint 6.2
// preflight §10's explicit prohibition - reintroducing it would recreate
// the email-enumeration oracle the trusted createTripInvitation callable
// was specifically hardened against).
import React from "react";
import { act, create } from "react-test-renderer";

import {
  InviteTripMemberDialog,
  inviteTripMemberErrorMessage,
} from "../InviteTripMemberDialog";
import { fetchCurrentTripTerms } from "../../../src/services/firebase/tripTerms";
import { createTripInvitation } from "../../../src/services/firebase/tripInvitations";
import { lookupUserByEmail } from "../../../src/services/firebase/functions";
import type { TripTerms } from "../../../src/types/domain";

jest.mock("../../../src/services/firebase/tripTerms", () => ({
  fetchCurrentTripTerms: jest.fn(),
}));

jest.mock("../../../src/services/firebase/tripInvitations", () => ({
  createTripInvitation: jest.fn(),
}));

jest.mock("../../../src/services/firebase/functions", () => ({
  lookupUserByEmail: jest.fn(),
}));

const mockPush = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockAuthUser: { uid: string; email: string } | null = {
  uid: "owner-1",
  email: "owner@example.com",
};
jest.mock("../../../src/contexts/AuthContext", () => ({
  useAuth: () => ({ user: mockAuthUser }),
}));

const mockedFetchTerms = fetchCurrentTripTerms as jest.MockedFunction<
  typeof fetchCurrentTripTerms
>;
const mockedCreateInvitation = createTripInvitation as jest.MockedFunction<
  typeof createTripInvitation
>;
const mockedLookupUserByEmail = lookupUserByEmail as jest.MockedFunction<
  typeof lookupUserByEmail
>;

type JsonNode = {
  props: Record<string, unknown>;
  children: (JsonNode | string)[] | null;
};
type Instance = { props: Record<string, unknown> };
type RootLike = { root: { findAllByProps: (props: Record<string, unknown>) => Instance[] } };

function collectText(node: JsonNode | string | (JsonNode | string)[] | null): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(collectText).join("");
  return collectText(node.children);
}

function findByLabel(tree: ReturnType<typeof create>, accessibilityLabel: string): Instance {
  const root = (tree as unknown as RootLike).root;
  const matches = root.findAllByProps({ accessibilityLabel });
  if (matches.length === 0) {
    throw new Error(`No instance found with accessibilityLabel "${accessibilityLabel}"`);
  }
  return matches[0];
}

function queryByLabel(tree: ReturnType<typeof create>, accessibilityLabel: string): Instance | null {
  const root = (tree as unknown as RootLike).root;
  const matches = root.findAllByProps({ accessibilityLabel });
  return matches.length > 0 ? matches[0] : null;
}

function makeTerms(overrides: Partial<TripTerms> = {}): TripTerms {
  return {
    id: "terms-1",
    tripId: "trip-1",
    version: 1,
    createdAt: { toDate: () => new Date("2026-10-20T00:00:00Z") } as TripTerms["createdAt"],
    createdBy: "owner-1",
    contributionExpectations: "x",
    expenseAllocationExpectations: "x",
    sharedStashSpendingAuthority: "x",
    withdrawalExpectations: "x",
    settlementExpectations: "x",
    ...overrides,
  };
}

async function renderOpenDialog(
  props: Partial<React.ComponentProps<typeof InviteTripMemberDialog>> = {}
) {
  const defaults: React.ComponentProps<typeof InviteTripMemberDialog> = {
    visible: true,
    tripId: "trip-1",
    onClose: jest.fn(),
    onSent: jest.fn(),
  };
  let tree!: ReturnType<typeof create>;
  await act(async () => {
    tree = create(<InviteTripMemberDialog {...defaults} {...props} />);
  });
  return tree;
}

function setEmail(tree: ReturnType<typeof create>, value: string) {
  act(() => {
    (findByLabel(tree, "Email address").props.onChangeText as (t: string) => void)(value);
  });
}

async function pressSend(tree: ReturnType<typeof create>) {
  await act(async () => {
    await (findByLabel(tree, "Send Invitation").props.onPress as () => Promise<void>)();
  });
}

beforeEach(() => {
  mockedFetchTerms.mockReset();
  mockedCreateInvitation.mockReset();
  mockedLookupUserByEmail.mockReset();
  mockPush.mockReset();
});

describe("InviteTripMemberDialog - Terms prerequisite gate", () => {
  it("fetches current terms before any invitation can be created", async () => {
    mockedFetchTerms.mockResolvedValue(makeTerms());
    await renderOpenDialog();
    expect(mockedFetchTerms).toHaveBeenCalledWith("trip-1");
    expect(mockedCreateInvitation).not.toHaveBeenCalled();
  });

  it("no terms: createTripInvitation is never called, and no email form is even offered", async () => {
    mockedFetchTerms.mockResolvedValue(null);
    const tree = await renderOpenDialog();
    expect(queryByLabel(tree, "Email address")).toBeNull();
    expect(queryByLabel(tree, "Send Invitation")).toBeNull();
    expect(mockedCreateInvitation).not.toHaveBeenCalled();
  });

  it("no terms: shows the Set Up Trip Terms guidance", async () => {
    mockedFetchTerms.mockResolvedValue(null);
    const tree = await renderOpenDialog();
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("Trip Terms are required before inviting members.");
    expect(text).toContain("Set Up Trip Terms");
  });

  it("pressing Set Up Trip Terms navigates to the 6.3 terms route and closes the dialog", async () => {
    mockedFetchTerms.mockResolvedValue(null);
    const onClose = jest.fn();
    const tree = await renderOpenDialog({ onClose });
    act(() => {
      (findByLabel(tree, "Set Up Trip Terms").props.onPress as () => void)();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/(tabs)/trips/[tripId]/terms",
      params: { tripId: "trip-1", mode: "edit" },
    });
  });

  it("current terms exist: the email form is offered and submission is possible", async () => {
    mockedFetchTerms.mockResolvedValue(makeTerms());
    const tree = await renderOpenDialog();
    expect(() => findByLabel(tree, "Email address")).not.toThrow();
    expect(() => findByLabel(tree, "Send Invitation")).not.toThrow();
  });
});

describe("InviteTripMemberDialog - client validation", () => {
  beforeEach(() => {
    mockedFetchTerms.mockResolvedValue(makeTerms());
  });

  it("blank email is blocked", async () => {
    const tree = await renderOpenDialog();
    setEmail(tree, "");
    await pressSend(tree);
    expect(mockedCreateInvitation).not.toHaveBeenCalled();
    expect(collectText(tree.toJSON() as JsonNode)).toContain(
      "Please enter a valid email address."
    );
  });

  it("whitespace-only email is blocked", async () => {
    const tree = await renderOpenDialog();
    setEmail(tree, "    ");
    await pressSend(tree);
    expect(mockedCreateInvitation).not.toHaveBeenCalled();
  });

  it("malformed email (no @) is rejected", async () => {
    const tree = await renderOpenDialog();
    setEmail(tree, "not-an-email");
    await pressSend(tree);
    expect(mockedCreateInvitation).not.toHaveBeenCalled();
    expect(collectText(tree.toJSON() as JsonNode)).toContain(
      "Please enter a valid email address."
    );
  });

  it("the submitted email is trimmed", async () => {
    mockedCreateInvitation.mockResolvedValue({ invitationId: "x", inviteeUid: "y" });
    const tree = await renderOpenDialog();
    setEmail(tree, "  sam@example.com  ");
    await pressSend(tree);
    expect(mockedCreateInvitation).toHaveBeenCalledWith("trip-1", "sam@example.com");
  });

  it("the submitted email is lowercased", async () => {
    mockedCreateInvitation.mockResolvedValue({ invitationId: "x", inviteeUid: "y" });
    const tree = await renderOpenDialog();
    setEmail(tree, "SAM@EXAMPLE.COM");
    await pressSend(tree);
    expect(mockedCreateInvitation).toHaveBeenCalledWith("trip-1", "sam@example.com");
  });
});

describe("InviteTripMemberDialog - submit flow", () => {
  beforeEach(() => {
    mockedFetchTerms.mockResolvedValue(makeTerms());
  });

  it("a valid submit calls createTripInvitation exactly once", async () => {
    mockedCreateInvitation.mockResolvedValue({ invitationId: "x", inviteeUid: "y" });
    const tree = await renderOpenDialog();
    setEmail(tree, "sam@example.com");
    await pressSend(tree);
    expect(mockedCreateInvitation).toHaveBeenCalledTimes(1);
  });

  it("calls onSent with the normalized email on success", async () => {
    mockedCreateInvitation.mockResolvedValue({ invitationId: "x", inviteeUid: "y" });
    const onSent = jest.fn();
    const tree = await renderOpenDialog({ onSent });
    setEmail(tree, "  SAM@example.com  ");
    await pressSend(tree);
    expect(onSent).toHaveBeenCalledWith("sam@example.com");
  });

  it("controls are disabled while the request is in flight", async () => {
    let resolveInvite!: (v: { invitationId: string; inviteeUid: string }) => void;
    mockedCreateInvitation.mockImplementation(
      () => new Promise((resolve) => (resolveInvite = resolve))
    );
    const tree = await renderOpenDialog();
    setEmail(tree, "sam@example.com");

    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = (findByLabel(tree, "Send Invitation").props.onPress as () => Promise<void>)();
    });

    expect(findByLabel(tree, "Send Invitation").props.disabled).toBe(true);
    expect(findByLabel(tree, "Cancel").props.disabled).toBe(true);

    await act(async () => {
      resolveInvite({ invitationId: "x", inviteeUid: "y" });
      await sendPromise;
    });
  });

  it("a duplicate press while in flight cannot double-submit", async () => {
    let resolveInvite!: (v: { invitationId: string; inviteeUid: string }) => void;
    mockedCreateInvitation.mockImplementation(
      () => new Promise((resolve) => (resolveInvite = resolve))
    );
    const tree = await renderOpenDialog();
    setEmail(tree, "sam@example.com");

    let firstPromise!: Promise<void>;
    act(() => {
      const onPress = findByLabel(tree, "Send Invitation").props.onPress as () => Promise<void>;
      firstPromise = onPress();
      // Fire a second press synchronously, before the first resolves -
      // the in-flight mutex must make this a no-op.
      onPress();
    });

    await act(async () => {
      resolveInvite({ invitationId: "x", inviteeUid: "y" });
      await firstPromise;
    });

    expect(mockedCreateInvitation).toHaveBeenCalledTimes(1);
  });
});

describe("InviteTripMemberDialog - self-invite", () => {
  beforeEach(() => {
    mockedFetchTerms.mockResolvedValue(makeTerms());
  });

  it("inviting your own email is blocked client-side, without calling createTripInvitation", async () => {
    const tree = await renderOpenDialog();
    setEmail(tree, "  Owner@Example.com  ");
    await pressSend(tree);
    expect(mockedCreateInvitation).not.toHaveBeenCalled();
    expect(collectText(tree.toJSON() as JsonNode)).toContain(
      "You can't invite yourself to your own trip."
    );
  });
});

describe("InviteTripMemberDialog - backend error mapping", () => {
  beforeEach(() => {
    mockedFetchTerms.mockResolvedValue(makeTerms());
  });

  async function submitAndGetText(code: string | undefined, email = "sam@example.com") {
    mockedCreateInvitation.mockRejectedValue(code ? { code } : new Error("network blip"));
    const tree = await renderOpenDialog();
    setEmail(tree, email);
    await pressSend(tree);
    return collectText(tree.toJSON() as JsonNode);
  }

  it("maps a backend self-invite invalid-argument (distinct from the client's own email)", async () => {
    const text = await submitAndGetText("functions/invalid-argument", "someone-else@example.com");
    expect(text).toContain("You can't invite yourself to your own trip.");
  });

  it("maps not-found to a safe account-not-found message", async () => {
    const text = await submitAndGetText("functions/not-found");
    expect(text).toContain("We couldn't find a SquadStash account with that email.");
  });

  it("maps already-exists to one truthful generic message (no structured reason exists to distinguish cases)", async () => {
    const text = await submitAndGetText("functions/already-exists");
    expect(text).toContain(
      "This person is already a member of this trip, or has already been invited."
    );
  });

  it("maps permission-denied to the owner-only message", async () => {
    const text = await submitAndGetText("functions/permission-denied");
    expect(text).toContain("Only the trip owner can invite members.");
  });

  it("maps failed-precondition to the archived-Trip message", async () => {
    const text = await submitAndGetText("functions/failed-precondition");
    expect(text).toContain("This trip is archived and can no longer accept new members.");
  });

  it("maps an unrecognized/network error to the generic fallback, never raw details", async () => {
    const text = await submitAndGetText(undefined);
    expect(text).toContain("Something went wrong sending the invitation. Please try again.");
    expect(text).not.toContain("network blip");
  });

  it("never renders raw backend error text for any mapped code", async () => {
    const text = await submitAndGetText("functions/internal");
    expect(text).not.toContain("functions/internal");
  });
});

describe("InviteTripMemberDialog - inviteTripMemberErrorMessage (pure mapper)", () => {
  it("maps every known code to its documented message", () => {
    expect(inviteTripMemberErrorMessage({ code: "functions/unauthenticated" })).toBe(
      "Please sign in and try again."
    );
    expect(inviteTripMemberErrorMessage({ code: "functions/invalid-argument" })).toBe(
      "You can't invite yourself to your own trip."
    );
    expect(inviteTripMemberErrorMessage({ code: "functions/permission-denied" })).toBe(
      "Only the trip owner can invite members."
    );
    expect(inviteTripMemberErrorMessage({ code: "functions/failed-precondition" })).toBe(
      "This trip is archived and can no longer accept new members."
    );
    expect(inviteTripMemberErrorMessage({ code: "functions/not-found" })).toBe(
      "We couldn't find a SquadStash account with that email."
    );
    expect(inviteTripMemberErrorMessage({ code: "functions/already-exists" })).toBe(
      "This person is already a member of this trip, or has already been invited."
    );
    expect(inviteTripMemberErrorMessage(new Error("anything"))).toBe(
      "Something went wrong sending the invitation. Please try again."
    );
  });
});

describe("InviteTripMemberDialog - privacy/security", () => {
  it("never calls lookupUserByEmail, in any flow", async () => {
    mockedFetchTerms.mockResolvedValue(makeTerms());
    mockedCreateInvitation.mockResolvedValue({ invitationId: "x", inviteeUid: "y" });
    const tree = await renderOpenDialog();
    setEmail(tree, "sam@example.com");
    await pressSend(tree);
    expect(mockedLookupUserByEmail).not.toHaveBeenCalled();
  });

  it("never renders an email that was never entered (no residual state leak)", async () => {
    mockedFetchTerms.mockResolvedValue(null);
    const tree = await renderOpenDialog();
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).not.toMatch(/@/);
  });
});

describe("InviteTripMemberDialog - Terms-gate async safety (review fix)", () => {
  const defaultProps: React.ComponentProps<typeof InviteTripMemberDialog> = {
    visible: true,
    tripId: "trip-1",
    onClose: jest.fn(),
    onSent: jest.fn(),
  };

  it("a stale terms-gate result from a closed/reopened cycle cannot overwrite the latest open's gate state", async () => {
    // Request A - from the FIRST open - never resolves until later.
    let resolveA!: (terms: TripTerms | null) => void;
    mockedFetchTerms.mockImplementationOnce(
      () => new Promise((resolve) => (resolveA = resolve))
    );

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<InviteTripMemberDialog {...defaultProps} />);
    });

    // Close before request A ever resolves.
    await act(async () => {
      tree.update(<InviteTripMemberDialog {...defaultProps} visible={false} />);
    });

    // Reopen - triggers request B, which resolves immediately with
    // current terms.
    mockedFetchTerms.mockResolvedValueOnce(makeTerms());
    await act(async () => {
      tree.update(<InviteTripMemberDialog {...defaultProps} visible={true} />);
    });

    expect(() => findByLabel(tree, "Email address")).not.toThrow();

    // Request A finally resolves now, with null (as if terms had been
    // removed) - this must be a complete no-op: the dialog must remain
    // exactly in request B's "ready" state, never reverted to "missing".
    await act(async () => {
      resolveA(null);
      await Promise.resolve();
    });

    expect(() => findByLabel(tree, "Email address")).not.toThrow();
    expect(queryByLabel(tree, "Set Up Trip Terms")).toBeNull();
  });

  it("resolving a pending terms-gate request after unmount never calls setState or logs a React warning", async () => {
    let resolvePending!: (terms: TripTerms | null) => void;
    mockedFetchTerms.mockImplementationOnce(
      () => new Promise((resolve) => (resolvePending = resolve))
    );
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<InviteTripMemberDialog {...defaultProps} />);
    });

    act(() => {
      tree.unmount();
    });

    await act(async () => {
      resolvePending(makeTerms());
      await Promise.resolve();
    });

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("Retry after a terms-gate check error still works", async () => {
    mockedFetchTerms.mockRejectedValueOnce(new Error("network blip"));
    const tree = await renderOpenDialog();
    expect(collectText(tree.toJSON() as JsonNode)).toContain(
      "We couldn't check this trip's Terms safely."
    );

    mockedFetchTerms.mockResolvedValueOnce(makeTerms());
    act(() => {
      (findByLabel(tree, "Try again").props.onPress as () => void)();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(() => findByLabel(tree, "Email address")).not.toThrow();
  });
});
