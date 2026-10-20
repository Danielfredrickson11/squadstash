// Checkpoint 5C.3D-B §17 - renders the REAL
// app/(tabs)/trips/invitations/[invitationId].tsx screen with
// react-test-renderer (already used throughout this repository's own
// component tests - no new rendering dependency) against the REAL local
// emulators, to prove the shipped screen itself - not a harness-owned
// reimplementation - never calls fetchCurrentTripTerms before
// getTripInvitationPreview resolves, and never uses any tripId but the
// one the real preview response actually returned.
//
// Permitted test-only mocks (navigation plumbing + auth presentation
// only - see the frozen preflight §10/§17): expo-router's
// useLocalSearchParams/useRouter, and AuthContext's useAuth (returning
// the already-real Auth-emulator invitee identity). getTripInvitationPreview
// and fetchCurrentTripTerms are instrumented, never behaviorally mocked -
// each wrapper below calls jest.requireActual and forwards the call and
// its real result/thrown error unchanged, only recording a timestamped
// event either side of the real call.
//
// `babel-plugin-jest-hoist` hoists jest.mock(...) above every import in
// this file, and its factory can only reference `require(...)` (not an
// enclosing-scope import) - that is what the two rules below flag, and
// why every other import in this file is unavoidably pushed below this
// statement. Disabled for exactly these two structural rules, nothing
// else in this file is exempted from any other check.
/* eslint-disable @typescript-eslint/no-require-imports, import/first */
jest.mock("../../firebase", () =>
  require("./helpers/firebaseIntegrationTestEnv").buildDemoFirebaseInstances()
);

let mockScreenInvitationId = "";
let mockScreenUser: {uid: string} | null = null;
const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockBack = jest.fn();

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({invitationId: mockScreenInvitationId}),
  useRouter: () => ({push: mockPush, replace: mockReplace, back: mockBack}),
}));

jest.mock("../../src/contexts/AuthContext", () => ({
  useAuth: () => ({user: mockScreenUser, loading: false, logout: jest.fn()}),
}));

type EventLogEntry = {event: string; at: number; tripId?: string};
const mockEventLog: EventLogEntry[] = [];

jest.mock("../../src/services/firebase/tripInvitations", () => {
  const real = jest.requireActual("../../src/services/firebase/tripInvitations");
  return {
    ...real,
    getTripInvitationPreview: async (...args: unknown[]) => {
      mockEventLog.push({event: "preview:start", at: Date.now()});
      const result = await real.getTripInvitationPreview(...args);
      mockEventLog.push({event: "preview:resolved", at: Date.now(), tripId: result.tripId});
      return result;
    },
  };
});

jest.mock("../../src/services/firebase/tripTerms", () => {
  const real = jest.requireActual("../../src/services/firebase/tripTerms");
  return {
    ...real,
    fetchCurrentTripTerms: async (...args: unknown[]) => {
      mockEventLog.push({event: "terms:start", at: Date.now(), tripId: args[0] as string});
      const result = await real.fetchCurrentTripTerms(...args);
      mockEventLog.push({event: "terms:resolved", at: Date.now()});
      return result;
    },
  };
});

import React from "react";
import {act, create} from "react-test-renderer";
import type {TestRenderer} from "react-test-renderer";
import InvitationReviewScreen from "../../app/(tabs)/trips/invitations/[invitationId]";
import {cleanupDemoFirebaseInstances} from "./helpers/firebaseIntegrationTestEnv";
import {
  createAndSignInUser,
  setupOwnerTripTermsInvitation,
  signInAs,
} from "./helpers/fixtures";

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 15000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitUntil: timed out waiting for the expected event log state.");
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
}

describe("Real screen render - loading-order proof", () => {
  it("proves strict preview-before-terms sequencing and tripId provenance from the actual shipped screen", async () => {
    const owner = await createAndSignInUser("screen-owner");
    const invitee = await createAndSignInUser("screen-invitee");
    const setup = await setupOwnerTripTermsInvitation({
      ownerEmail: owner.email,
      inviteeEmail: invitee.email,
      scenarioLabel: "screen-proof",
    });

    // The invitee must actually be signed in to the demo Auth client so
    // the screen's own real network calls authenticate correctly - the
    // mocked useAuth() below only supplies `user.uid` for the Decline
    // handler, it does not drive request authentication.
    await signInAs(invitee.email);

    mockScreenInvitationId = setup.invitationId;
    mockScreenUser = {uid: invitee.uid};
    mockEventLog.length = 0;

    let tree: TestRenderer;
    await act(async () => {
      tree = create(<InvitationReviewScreen />);
    });

    await waitUntil(() => mockEventLog.some((e) => e.event === "terms:resolved"));

    const events = mockEventLog.map((e) => e.event);
    const previewStartIdx = events.indexOf("preview:start");
    const previewResolvedIdx = events.indexOf("preview:resolved");
    const termsStartIdx = events.indexOf("terms:start");
    const termsResolvedIdx = events.indexOf("terms:resolved");

    expect(previewStartIdx).toBeGreaterThanOrEqual(0);
    expect(previewResolvedIdx).toBeGreaterThan(previewStartIdx);
    expect(termsStartIdx).toBeGreaterThan(previewResolvedIdx);
    expect(termsResolvedIdx).toBeGreaterThan(termsStartIdx);

    const previewResolvedEvent = mockEventLog.find((e) => e.event === "preview:resolved");
    const termsStartEvent = mockEventLog.find((e) => e.event === "terms:start");
    expect(previewResolvedEvent?.tripId).toBe(setup.tripId);
    expect(termsStartEvent?.tripId).toBe(previewResolvedEvent?.tripId);

    console.log("PASS preview-before-terms ordering");

    await act(async () => {
      tree!.unmount();
    });
  });
});

// Tears down this file's own demo App/Auth/Firestore instances - without
// this, Jest reports unstopped asynchronous operations and the wrapping
// `emulators:exec` process never exits after the test run itself has
// otherwise fully passed.
afterAll(async () => {
  await cleanupDemoFirebaseInstances();
});
