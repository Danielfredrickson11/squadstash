// Presentation/lifecycle tests for LeaveTripDialog (Checkpoint 6.7C).
// Mirrors CancelTripInvitationDialog.test.tsx's own react-test-renderer
// convention (no new test dependency, no @testing-library/react-native).
// Only the trusted leaveTrip service call is mocked at the module
// boundary - this dialog's own Modal/submitting/error state is exercised
// for real.
import React from "react";
import { act, create } from "react-test-renderer";

import { LeaveTripDialog, LEAVE_TRIP_NOT_READY_MESSAGE } from "../LeaveTripDialog";
import { leaveTrip } from "../../../src/services/firebase/trips";

jest.mock("../../../src/services/firebase/trips", () => ({
  leaveTrip: jest.fn(),
}));

const mockedLeaveTrip = leaveTrip as jest.MockedFunction<typeof leaveTrip>;

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
const onLeft = jest.fn();

function renderDialog(overrides: Partial<React.ComponentProps<typeof LeaveTripDialog>> = {}) {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(
      <LeaveTripDialog
        visible
        tripId="trip-1"
        onClose={onClose}
        onLeft={onLeft}
        {...overrides}
      />
    );
  });
  return tree;
}

beforeEach(() => {
  mockedLeaveTrip.mockReset();
  onClose.mockReset();
  onLeft.mockReset();
});

describe("LeaveTripDialog", () => {
  it("discloses the Shared Stash requirement, the balance requirement, the rejoin limitation, and the My Stash reassurance", () => {
    const tree = renderDialog();
    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("Shared Stash ownership is fully");
    expect(text).toContain("trip balance is fully settled");
    expect(text).toContain("cannot rejoin this trip");
    expect(text).toContain("My Stash savings for this trip are not affected");
  });

  it("calls leaveTrip with the tripId and navigates away on success", async () => {
    mockedLeaveTrip.mockResolvedValue({ tripId: "trip-1", uid: "member-1", departureType: "left" });
    const tree = renderDialog();

    await act(async () => {
      await (findByLabel(tree, "Leave Trip").props.onPress as () => Promise<void>)();
    });

    expect(mockedLeaveTrip).toHaveBeenCalledWith("trip-1");
    expect(onLeft).toHaveBeenCalledTimes(1);
  });

  it("treats a replayed exact-match success identically to a first-time success", async () => {
    mockedLeaveTrip.mockResolvedValue({ tripId: "trip-1", uid: "member-1", departureType: "left" });
    const tree = renderDialog();

    await act(async () => {
      await (findByLabel(tree, "Leave Trip").props.onPress as () => Promise<void>)();
    });

    expect(onLeft).toHaveBeenCalledTimes(1);
  });

  it("shows the safe generic message for functions/failed-precondition, never raw backend text", async () => {
    mockedLeaveTrip.mockRejectedValue({ code: "functions/failed-precondition", message: "internal detail about ownership row X" });
    const tree = renderDialog();

    await act(async () => {
      await (findByLabel(tree, "Leave Trip").props.onPress as () => Promise<void>)();
    });

    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain(LEAVE_TRIP_NOT_READY_MESSAGE);
    expect(text).not.toContain("internal detail about ownership row X");
    expect(onLeft).not.toHaveBeenCalled();
  });

  it("maps functions/permission-denied to a safe message", async () => {
    mockedLeaveTrip.mockRejectedValue({ code: "functions/permission-denied" });
    const tree = renderDialog();

    await act(async () => {
      await (findByLabel(tree, "Leave Trip").props.onPress as () => Promise<void>)();
    });

    const text = collectText(tree.toJSON() as JsonNode);
    expect(text).toContain("don't have permission to leave");
  });

  it("prevents double submission", async () => {
    let resolveCall!: () => void;
    mockedLeaveTrip.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCall = () => resolve({ tripId: "trip-1", uid: "member-1", departureType: "left" });
        })
    );
    const tree = renderDialog();

    act(() => {
      (findByLabel(tree, "Leave Trip").props.onPress as () => void)();
      (findByLabel(tree, "Leave Trip").props.onPress as () => void)();
    });

    await act(async () => {
      resolveCall();
      await Promise.resolve();
    });

    expect(mockedLeaveTrip).toHaveBeenCalledTimes(1);
  });

  it("blocks dismissal while submitting", async () => {
    let resolveCall!: () => void;
    mockedLeaveTrip.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCall = () => resolve({ tripId: "trip-1", uid: "member-1", departureType: "left" });
        })
    );
    const tree = renderDialog();

    act(() => {
      (findByLabel(tree, "Leave Trip").props.onPress as () => void)();
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
