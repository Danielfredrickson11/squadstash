// Presentation/lifecycle tests for RemoveTripMemberDialog (Checkpoint
// 6.7C). Mirrors CancelTripInvitationDialog.test.tsx's own
// react-test-renderer convention. Only the trusted removeTripMember
// service call is mocked at the module boundary.
import React from "react";
import { act, create } from "react-test-renderer";

import {
  RemoveTripMemberDialog,
  REMOVE_MEMBER_NOT_READY_MESSAGE,
} from "../RemoveTripMemberDialog";
import { removeTripMember } from "../../../src/services/firebase/trips";

jest.mock("../../../src/services/firebase/trips", () => ({
  removeTripMember: jest.fn(),
}));

const mockedRemoveTripMember = removeTripMember as jest.MockedFunction<typeof removeTripMember>;

type Instance = { props: Record<string, unknown> };
type RootLike = { root: { findAllByProps: (props: Record<string, unknown>) => Instance[] } };
type JsonNode = { props: Record<string, unknown>; children: (JsonNode | string)[] | null };

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

const onClose = jest.fn();
const onRemoved = jest.fn();

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof RemoveTripMemberDialog>> = {}
) {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(
      <RemoveTripMemberDialog
        visible
        tripId="trip-1"
        targetUid="member-2"
        targetNameLabel="Sam Member"
        onClose={onClose}
        onRemoved={onRemoved}
        {...overrides}
      />
    );
  });
  return tree;
}

beforeEach(() => {
  mockedRemoveTripMember.mockReset();
  onClose.mockReset();
  onRemoved.mockReset();
});

describe("RemoveTripMemberDialog", () => {
  it("identifies the target member and discloses the financial-clearance requirement and the rejoin limitation", () => {
    const tree = renderDialog();
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("Sam Member");
    expect(text).toContain("Shared Stash ownership is");
    expect(text).toContain("trip balance is fully settled");
    expect(text).toContain("cannot rejoin this trip");
  });

  it("never states an exact balance amount or a creditor/debtor direction", () => {
    const tree = renderDialog();
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).not.toMatch(/\$\d/);
    expect(text).not.toMatch(/owes|is owed/i);
  });

  it("calls removeTripMember with the exact tripId and targetUid, and triggers the parent callback on success", async () => {
    mockedRemoveTripMember.mockResolvedValue({
      tripId: "trip-1",
      uid: "member-2",
      departureType: "removed",
    });
    const tree = renderDialog();

    await act(async () => {
      await (findByLabel(tree, "Remove Member").props.onPress as () => Promise<void>)();
    });

    expect(mockedRemoveTripMember).toHaveBeenCalledWith("trip-1", "member-2");
    expect(onRemoved).toHaveBeenCalledWith("member-2");
  });

  it("treats a replayed exact-match success identically to a first-time success", async () => {
    mockedRemoveTripMember.mockResolvedValue({
      tripId: "trip-1",
      uid: "member-2",
      departureType: "removed",
    });
    const tree = renderDialog();

    await act(async () => {
      await (findByLabel(tree, "Remove Member").props.onPress as () => Promise<void>)();
    });

    expect(onRemoved).toHaveBeenCalledTimes(1);
  });

  it("shows the safe generic message for functions/failed-precondition, never raw backend text", async () => {
    mockedRemoveTripMember.mockRejectedValue({
      code: "functions/failed-precondition",
      message: "internal detail about balance row Y",
    });
    const tree = renderDialog();

    await act(async () => {
      await (findByLabel(tree, "Remove Member").props.onPress as () => Promise<void>)();
    });

    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain(REMOVE_MEMBER_NOT_READY_MESSAGE);
    expect(text).not.toContain("internal detail about balance row Y");
    expect(onRemoved).not.toHaveBeenCalled();
  });

  it("maps functions/permission-denied to a safe message", async () => {
    mockedRemoveTripMember.mockRejectedValue({ code: "functions/permission-denied" });
    const tree = renderDialog();

    await act(async () => {
      await (findByLabel(tree, "Remove Member").props.onPress as () => Promise<void>)();
    });

    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("Only the trip owner can remove a member");
  });

  it("prevents double submission", async () => {
    let resolveCall!: () => void;
    mockedRemoveTripMember.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCall = () =>
            resolve({ tripId: "trip-1", uid: "member-2", departureType: "removed" });
        })
    );
    const tree = renderDialog();

    act(() => {
      (findByLabel(tree, "Remove Member").props.onPress as () => void)();
      (findByLabel(tree, "Remove Member").props.onPress as () => void)();
    });

    await act(async () => {
      resolveCall();
      await Promise.resolve();
    });

    expect(mockedRemoveTripMember).toHaveBeenCalledTimes(1);
  });

  it("blocks dismissal while submitting", async () => {
    let resolveCall!: () => void;
    mockedRemoveTripMember.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCall = () =>
            resolve({ tripId: "trip-1", uid: "member-2", departureType: "removed" });
        })
    );
    const tree = renderDialog();

    act(() => {
      (findByLabel(tree, "Remove Member").props.onPress as () => void)();
    });
    act(() => {
      (findByLabel(tree, "Close").props.onPress as () => void)();
    });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      resolveCall();
      await Promise.resolve();
    });
  });
});
