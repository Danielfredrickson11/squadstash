// Presentation + logic tests for CancelTripInvitationDialog (Checkpoint
// 6.5). Mirrors components/trips/__tests__/InviteTripMemberDialog.test.tsx's
// own react-test-renderer tree-walk convention (no new test dependency,
// no @testing-library/react-native). The one Firebase-touching
// dependency (cancelTripInvitation) is mocked at the module boundary.
import React from "react";
import { act, create } from "react-test-renderer";

import {
  CANCEL_STATE_CHANGED_MESSAGE,
  CancelTripInvitationDialog,
} from "../CancelTripInvitationDialog";
import { cancelTripInvitation } from "../../../src/services/firebase/tripInvitations";
import type { TripInvitation } from "../../../src/types/domain";

jest.mock("../../../src/services/firebase/tripInvitations", () => ({
  cancelTripInvitation: jest.fn(),
}));

const mockedCancel = cancelTripInvitation as jest.MockedFunction<typeof cancelTripInvitation>;

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

function makeInvitation(overrides: Partial<TripInvitation> = {}): TripInvitation {
  return {
    id: "trip-1_invitee-1",
    tripId: "trip-1",
    inviterUid: "owner-1",
    inviteeEmail: "testaccount3@gmail.com",
    inviteeUid: "invitee-1",
    status: "pending",
    createdAt: { toDate: () => new Date("2026-10-20T12:00:00Z") } as TripInvitation["createdAt"],
    expiresAt: { toDate: () => new Date("2026-11-11T12:49:46Z") } as TripInvitation["expiresAt"],
    respondedAt: null,
    ...overrides,
  };
}

function renderDialog(props: Partial<React.ComponentProps<typeof CancelTripInvitationDialog>> = {}) {
  const defaults: React.ComponentProps<typeof CancelTripInvitationDialog> = {
    visible: true,
    tripId: "trip-1",
    invitation: makeInvitation(),
    onClose: jest.fn(),
    onCancelled: jest.fn(),
    onStateChanged: jest.fn(),
  };
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<CancelTripInvitationDialog {...defaults} {...props} />);
  });
  return tree;
}

async function pressConfirm(tree: ReturnType<typeof create>) {
  await act(async () => {
    await (findByLabel(tree, "Cancel Invitation").props.onPress as () => Promise<void>)();
  });
}

beforeEach(() => {
  mockedCancel.mockReset();
});

describe("CancelTripInvitationDialog - content", () => {
  it("shows the exact invitee email from the selected invitation", () => {
    const tree = renderDialog({
      invitation: makeInvitation({ inviteeEmail: "someone@example.com" }),
    });
    expect(collectText(tree.toJSON() as JsonNode)).toContain("someone@example.com");
  });

  it("discloses the current re-invite limitation", () => {
    const tree = renderDialog();
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("cannot re-invite this person");
  });
});

describe("CancelTripInvitationDialog - dismiss without confirming", () => {
  it("Keep Invitation closes with no write", () => {
    const onClose = jest.fn();
    const tree = renderDialog({ onClose });
    act(() => {
      (findByLabel(tree, "Keep Invitation").props.onPress as () => void)();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockedCancel).not.toHaveBeenCalled();
  });
});

describe("CancelTripInvitationDialog - confirm flow", () => {
  it("confirm calls cancelTripInvitation exactly once with the correct tripId and inviteeUid", async () => {
    mockedCancel.mockResolvedValue(undefined);
    const tree = renderDialog({
      tripId: "trip-42",
      invitation: makeInvitation({ inviteeUid: "invitee-42" }),
    });
    await pressConfirm(tree);
    expect(mockedCancel).toHaveBeenCalledTimes(1);
    expect(mockedCancel).toHaveBeenCalledWith("trip-42", "invitee-42");
  });

  it("the destructive control is disabled while the request is in flight", async () => {
    let resolveCancel!: () => void;
    mockedCancel.mockImplementation(() => new Promise((resolve) => (resolveCancel = resolve)));
    const tree = renderDialog();

    let confirmPromise!: Promise<void>;
    act(() => {
      confirmPromise = (
        findByLabel(tree, "Cancel Invitation").props.onPress as () => Promise<void>
      )();
    });

    expect(findByLabel(tree, "Cancel Invitation").props.disabled).toBe(true);
    expect(findByLabel(tree, "Keep Invitation").props.disabled).toBe(true);

    await act(async () => {
      resolveCancel();
      await confirmPromise;
    });
  });

  it("a duplicate rapid confirm press cannot double-submit", async () => {
    let resolveCancel!: () => void;
    mockedCancel.mockImplementation(() => new Promise((resolve) => (resolveCancel = resolve)));
    const tree = renderDialog();

    let firstPromise!: Promise<void>;
    act(() => {
      const onPress = findByLabel(tree, "Cancel Invitation").props.onPress as () => Promise<void>;
      firstPromise = onPress();
      onPress();
    });

    await act(async () => {
      resolveCancel();
      await firstPromise;
    });

    expect(mockedCancel).toHaveBeenCalledTimes(1);
  });

  it("the success callback fires exactly once", async () => {
    mockedCancel.mockResolvedValue(undefined);
    const onCancelled = jest.fn();
    const tree = renderDialog({ onCancelled });
    await pressConfirm(tree);
    expect(onCancelled).toHaveBeenCalledTimes(1);
  });
});

describe("CancelTripInvitationDialog - error mapping", () => {
  it("maps permission-denied to the safe state-changed message, via onStateChanged", async () => {
    mockedCancel.mockRejectedValue({ code: "permission-denied" });
    const onStateChanged = jest.fn();
    const tree = renderDialog({ onStateChanged });
    await pressConfirm(tree);
    expect(onStateChanged).toHaveBeenCalledWith(CANCEL_STATE_CHANGED_MESSAGE);
  });

  it("permission-denied never exposes raw Firestore error details", async () => {
    mockedCancel.mockRejectedValue({
      code: "permission-denied",
      message: "FirebaseError: Missing or insufficient permissions (internal detail).",
    });
    const onStateChanged = jest.fn();
    const tree = renderDialog({ onStateChanged });
    await pressConfirm(tree);
    const [[message]] = onStateChanged.mock.calls;
    expect(message).not.toContain("Missing or insufficient permissions");
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).not.toContain("Missing or insufficient permissions");
  });

  it("an unknown/network error uses the generic safe message and keeps the dialog open/retryable", async () => {
    mockedCancel.mockRejectedValueOnce(new Error("network blip: internal detail"));
    const onCancelled = jest.fn();
    const onStateChanged = jest.fn();
    const tree = renderDialog({ onCancelled, onStateChanged });

    await pressConfirm(tree);

    expect(onCancelled).not.toHaveBeenCalled();
    expect(onStateChanged).not.toHaveBeenCalled();
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("Something went wrong cancelling the invitation. Please try again.");
    expect(text).not.toContain("network blip: internal detail");

    // Retryable: the confirm control is enabled again, and a second
    // attempt can succeed.
    expect(findByLabel(tree, "Cancel Invitation").props.disabled).toBe(false);
    mockedCancel.mockResolvedValueOnce(undefined);
    await pressConfirm(tree);
    expect(onCancelled).toHaveBeenCalledTimes(1);
  });

  it("never renders raw Firebase error text for any failure", async () => {
    mockedCancel.mockRejectedValue(new Error("Error: 7 PERMISSION_DENIED: internal"));
    const tree = renderDialog();
    await pressConfirm(tree);
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).not.toContain("PERMISSION_DENIED");
  });
});

describe("CancelTripInvitationDialog - dismissal while submitting", () => {
  it("backdrop/Keep Invitation dismissal is blocked while a request is in flight", async () => {
    let resolveCancel!: () => void;
    mockedCancel.mockImplementation(() => new Promise((resolve) => (resolveCancel = resolve)));
    const onClose = jest.fn();
    const tree = renderDialog({ onClose });

    let confirmPromise!: Promise<void>;
    act(() => {
      confirmPromise = (
        findByLabel(tree, "Cancel Invitation").props.onPress as () => Promise<void>
      )();
    });

    act(() => {
      (findByLabel(tree, "Close").props.onPress as () => void)();
    });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      resolveCancel();
      await confirmPromise;
    });
  });
});
