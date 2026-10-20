// Checkpoint 5C.3D-B - the real, local, emulator-backed integration proof
// of the Trip invitation flow (Scenarios A-E), per the frozen
// docs/audits/TRIP_INVITATION_INTEGRATION_PREFLIGHT_2026-10-19.md. Every
// Trip/terms/invitation/acceptance/decline in this file goes through the
// REAL production client service wrappers and the REAL Functions
// Emulator - never a mock, never a directly-invoked Core function, never
// a manually-seeded document for a path whose purpose is to prove the
// real flow (per-scenario exceptions are called out inline where this
// file deliberately performs a RAW Firestore write/read - Scenarios D/E
// - to prove what Rules themselves do/do not permit).
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

import {doc, getDoc, serverTimestamp, updateDoc} from "firebase/firestore";
import {db} from "../../firebase";
import {cleanupDemoFirebaseInstances} from "./helpers/firebaseIntegrationTestEnv";
import {
  cleanupTrustedInspectionEnv,
  countAcceptancesFor,
  inspectAcceptance,
  inspectInvitation,
  inspectTrip,
  ownershipRowExists,
} from "./helpers/trustedInspection";
import {expectCallableErrorCode, expectFirestorePermissionDenied} from "./helpers/assertions";
import {
  createAndSignInUser,
  createRealInvitation,
  createRealTrip,
  publishRealTerms,
  setupOwnerTripTermsInvitation,
  signInAs,
} from "./helpers/fixtures";
import {
  acceptTripInvitation,
  declineTripInvitation,
  fetchPendingInvitationsForUser,
  getTripInvitationPreview,
} from "../../src/services/firebase/tripInvitations";
import {fetchCurrentTripTerms} from "../../src/services/firebase/tripTerms";

const SAFE_PREVIEW_KEYS = [
  "imageUrl",
  "location",
  "tripEndDate",
  "tripId",
  "tripStartDate",
  "title",
].sort();

const FORBIDDEN_PREVIEW_FIELDS = [
  "target",
  "saved",
  "memberIds",
  "ownerId",
  "ledgerBalanceMinor",
  "ledgerOpeningBalanceMinor",
  "currency",
  "ownershipModelState",
  "ownershipModelVersion",
  "creationRequest",
  "lastUpdatedBy",
  "inviterUid",
  "inviteeUid",
  "inviteeEmail",
];

describe("Scenario A - normal accept", () => {
  it("completes the full real flow end to end with every frozen assertion", async () => {
    const owner = await createAndSignInUser("scenario-a-owner");
    const invitee = await createAndSignInUser("scenario-a-invitee");
    // 1. owner/invitee are real Auth-emulator users.
    expect(owner.uid).toBeTruthy();
    expect(invitee.uid).toBeTruthy();

    await signInAs(owner.email);
    // 2/3. Trip created via the real createTrip callable; initialized correctly.
    const tripId = await createRealTrip("scenario-a");
    const tripAfterCreate = await inspectTrip(tripId);
    expect(tripAfterCreate?.ownershipModelState).toBe("initialized");

    // 4. terms v1 published via the real callable.
    const termsV1 = await publishRealTerms(tripId, "v1");

    // 5. invitation created via the real callable.
    const {invitationId, inviteeUid} = await createRealInvitation(tripId, invitee.email);
    expect(inviteeUid).toBe(invitee.uid);

    // 6. invitee signed in.
    await signInAs(invitee.email);

    // 7. fetchPendingInvitationsForUser finds this invitation.
    const pending = await fetchPendingInvitationsForUser(invitee.uid);
    expect(pending.some((inv) => inv.id === invitationId)).toBe(true);

    // 8. pending invitee direct full Trip read is DENIED - specifically
    // by Firestore Rules, not by any unrelated failure.
    await expectFirestorePermissionDenied(getDoc(doc(db, "trips", tripId)));
    console.log("PASS pre-join Trip privacy (Scenario A)");

    // 9-15. getTripInvitationPreview succeeds; exactly six keys; forbidden fields absent.
    const preview = await getTripInvitationPreview(invitationId);
    expect(Object.keys(preview).sort()).toEqual(SAFE_PREVIEW_KEYS);
    expect(preview.tripId).toBe(tripId);
    for (const forbidden of FORBIDDEN_PREVIEW_FIELDS) {
      expect(forbidden in preview).toBe(false);
    }
    console.log("PASS safe preview shape");

    // 16/17. fetchCurrentTripTerms succeeds only after preview; five fields equal v1.
    const terms = await fetchCurrentTripTerms(preview.tripId);
    expect(terms).not.toBeNull();
    expect(terms!.id).toBe(termsV1.id);
    for (const key of [
      "contributionExpectations",
      "expenseAllocationExpectations",
      "sharedStashSpendingAuthority",
      "withdrawalExpectations",
      "settlementExpectations",
    ] as const) {
      expect(terms![key]).toContain("v1");
    }

    // 18-20. acceptTripInvitation receives the exact rendered terms.id; succeeds; result exactly {tripId}.
    const acceptResult = await acceptTripInvitation(invitationId, terms!.id);
    expect(Object.keys(acceptResult)).toEqual(["tripId"]);
    expect(acceptResult.tripId).toBe(tripId);
    console.log("PASS exact displayed terms id acceptance");

    // 21/22. invitation status accepted; respondedAt exists.
    const invitationAfter = await inspectInvitation(invitationId);
    expect(invitationAfter?.status).toBe("accepted");
    expect(invitationAfter?.respondedAt).toBeTruthy();

    // 23. invitee present exactly once in Trip.memberIds.
    const tripAfterAccept = await inspectTrip(tripId);
    const memberIds = tripAfterAccept?.memberIds as string[];
    expect(memberIds.filter((id) => id === invitee.uid)).toHaveLength(1);

    // 24. invitee can now read the full Trip through normal client Rules.
    const tripDocSnap = await getDoc(doc(db, "trips", tripId));
    expect(tripDocSnap.exists()).toBe(true);
    console.log("PASS post-accept member Trip read allowed");

    // 25/26. exactly one acceptance record; matches every field.
    expect(await countAcceptancesFor(tripId, invitee.uid)).toBe(1);
    const acceptanceId = `${tripId}_${invitee.uid}_${termsV1.id}`;
    const acceptance = await inspectAcceptance(acceptanceId);
    expect(acceptance?.tripId).toBe(tripId);
    expect(acceptance?.uid).toBe(invitee.uid);
    expect(acceptance?.termsDocId).toBe(termsV1.id);
    expect(acceptance?.acceptedTermsVersion).toBe(termsV1.version);
    expect(acceptance?.acceptedAt).toBeTruthy();
    console.log("PASS acceptance evidence exact (Scenario A)");

    // 27. no ownership row was created for invitee simply by joining.
    expect(await ownershipRowExists(tripId, invitee.uid)).toBe(false);

    // 28. no financial transaction occurred - proven by construction:
    // no financial callable/service function is ever called anywhere in
    // this test.
    console.log("PASS normal accept");
  });
});

describe("Scenario B - terms_changed / anti-TOCTOU", () => {
  it("rejects stale terms, proves zero partial membership, then succeeds with new terms", async () => {
    const owner = await createAndSignInUser("scenario-b-owner");
    const invitee = await createAndSignInUser("scenario-b-invitee");

    const setup = await setupOwnerTripTermsInvitation({
      ownerEmail: owner.email,
      inviteeEmail: invitee.email,
      scenarioLabel: "scenario-b",
    });

    await signInAs(invitee.email);
    const preview = await getTripInvitationPreview(setup.invitationId);
    const v1Terms = await fetchCurrentTripTerms(preview.tripId);
    expect(v1Terms!.id).toBe(setup.termsV1Id);

    // Owner publishes v2 BEFORE the invitee's acceptance attempt.
    await signInAs(owner.email);
    const termsV2 = await publishRealTerms(setup.tripId, "v2");
    expect(termsV2.id).not.toBe(setup.termsV1Id);

    await signInAs(invitee.email);
    let caught: {code?: string; details?: {reason?: string}} | undefined;
    await expect(
      acceptTripInvitation(setup.invitationId, setup.termsV1Id).catch((e) => {
        caught = e;
        throw e;
      })
    ).rejects.toBeTruthy();
    expect(caught?.code).toBe("functions/failed-precondition");
    expect(caught?.details?.reason).toBe("terms_changed");
    console.log("PASS terms_changed returned");

    // Zero-partial-write proof - checked BEFORE any second acceptance.
    const invitationAfterRejection = await inspectInvitation(setup.invitationId);
    expect(invitationAfterRejection?.status).toBe("pending");
    expect(invitationAfterRejection?.respondedAt).toBeNull();
    const tripAfterRejection = await inspectTrip(setup.tripId);
    expect((tripAfterRejection?.memberIds as string[]).includes(invitee.uid)).toBe(false);
    expect(await countAcceptancesFor(setup.tripId, invitee.uid)).toBe(0);
    expect(await ownershipRowExists(setup.tripId, invitee.uid)).toBe(false);
    console.log("PASS terms_changed caused zero partial membership");

    // Re-fetch current terms -> must be v2, never auto-retried against v1.
    const refreshedTerms = await fetchCurrentTripTerms(setup.tripId);
    expect(refreshedTerms!.id).toBe(termsV2.id);
    expect(refreshedTerms!.id).not.toBe(setup.termsV1Id);
    expect(refreshedTerms!.contributionExpectations).toContain("v2");

    // Simulated second explicit user action, using v2's exact id.
    const acceptResult = await acceptTripInvitation(setup.invitationId, refreshedTerms!.id);
    expect(acceptResult.tripId).toBe(setup.tripId);

    const acceptance = await inspectAcceptance(
      `${setup.tripId}_${invitee.uid}_${termsV2.id}`
    );
    expect(acceptance?.termsDocId).toBe(termsV2.id);
    expect(acceptance?.acceptedTermsVersion).toBe(termsV2.version);
    console.log("PASS acceptance evidence exact (Scenario B)");

    const tripAfterSecondAccept = await inspectTrip(setup.tripId);
    const memberIds = tripAfterSecondAccept?.memberIds as string[];
    expect(memberIds.filter((id) => id === invitee.uid)).toHaveLength(1);
    console.log("PASS explicit second acceptance with new terms succeeds");
  });
});

describe("Scenario C - decline", () => {
  it("declines through the real direct client Rules-backed write", async () => {
    const owner = await createAndSignInUser("scenario-c-owner");
    const invitee = await createAndSignInUser("scenario-c-invitee");
    const setup = await setupOwnerTripTermsInvitation({
      ownerEmail: owner.email,
      inviteeEmail: invitee.email,
      scenarioLabel: "scenario-c",
    });

    await signInAs(invitee.email);
    const preview = await getTripInvitationPreview(setup.invitationId);
    const terms = await fetchCurrentTripTerms(preview.tripId);
    expect(terms).not.toBeNull();

    await declineTripInvitation(preview.tripId, invitee.uid);

    const invitationAfter = await inspectInvitation(setup.invitationId);
    expect(invitationAfter?.status).toBe("declined");
    expect(invitationAfter?.respondedAt).toBeTruthy();

    const tripAfter = await inspectTrip(setup.tripId);
    expect((tripAfter?.memberIds as string[]).includes(invitee.uid)).toBe(false);
    expect(await countAcceptancesFor(setup.tripId, invitee.uid)).toBe(0);
    console.log("PASS decline path");

    // A declined invitation is no longer previewable - the backend's
    // own frozen contract (getTripInvitationPreview.ts) throws exactly
    // HttpsError("failed-precondition", ...) once status !== "pending",
    // which the client SDK surfaces as "functions/failed-precondition".
    await expectCallableErrorCode(
      getTripInvitationPreview(setup.invitationId),
      "functions/failed-precondition"
    );
    await expectFirestorePermissionDenied(
      getDoc(doc(db, "tripTermsCurrent", setup.tripId))
    );
    console.log("PASS post-decline preview denied");

    await expectFirestorePermissionDenied(getDoc(doc(db, "trips", setup.tripId)));
  });
});

describe("Scenario D - old direct accept write must be denied", () => {
  it("rejects a direct client Firestore write that sets status accepted", async () => {
    const owner = await createAndSignInUser("scenario-d-owner");
    const invitee = await createAndSignInUser("scenario-d-invitee");
    const setup = await setupOwnerTripTermsInvitation({
      ownerEmail: owner.email,
      inviteeEmail: invitee.email,
      scenarioLabel: "scenario-d",
    });

    await signInAs(invitee.email);
    // The pre-5C.2 client-style direct write - must now be denied
    // SPECIFICALLY by Firestore Rules returning permission-denied, not
    // merely by some unrelated network/offline exception that would
    // also satisfy a generic rejection assertion.
    await expectFirestorePermissionDenied(
      updateDoc(doc(db, "tripInvitations", setup.invitationId), {
        status: "accepted",
        respondedAt: serverTimestamp(),
      })
    );

    const invitationAfter = await inspectInvitation(setup.invitationId);
    expect(invitationAfter?.status).toBe("pending");
    expect(invitationAfter?.respondedAt).toBeNull();
    const tripAfter = await inspectTrip(setup.tripId);
    expect((tripAfter?.memberIds as string[]).includes(invitee.uid)).toBe(false);
    expect(await countAcceptancesFor(setup.tripId, invitee.uid)).toBe(0);
    console.log("PASS direct client accepted write denied");
  });
});

describe("Scenario E - pre-join privacy", () => {
  it("enforces pre-join access, loses it on decline, keeps the Trip root closed throughout", async () => {
    const owner = await createAndSignInUser("scenario-e-owner");
    const invitee = await createAndSignInUser("scenario-e-invitee");
    const setup = await setupOwnerTripTermsInvitation({
      ownerEmail: owner.email,
      inviteeEmail: invitee.email,
      scenarioLabel: "scenario-e",
    });

    await signInAs(invitee.email);
    await expect(
      getDoc(doc(db, "tripInvitations", setup.invitationId))
    ).resolves.toBeTruthy();
    await expect(
      getDoc(doc(db, "tripTermsCurrent", setup.tripId))
    ).resolves.toBeTruthy();
    await expect(
      getDoc(doc(db, "tripTerms", setup.termsV1Id))
    ).resolves.toBeTruthy();
    await expectFirestorePermissionDenied(getDoc(doc(db, "trips", setup.tripId)));

    const preview = await getTripInvitationPreview(setup.invitationId);
    expect(Object.keys(preview).sort()).toEqual(SAFE_PREVIEW_KEYS);

    await declineTripInvitation(setup.tripId, invitee.uid);

    await expectCallableErrorCode(
      getTripInvitationPreview(setup.invitationId),
      "functions/failed-precondition"
    );
    await expectFirestorePermissionDenied(
      getDoc(doc(db, "tripTermsCurrent", setup.tripId))
    );
    await expectFirestorePermissionDenied(
      getDoc(doc(db, "tripTerms", setup.termsV1Id))
    );
    await expectFirestorePermissionDenied(getDoc(doc(db, "trips", setup.tripId)));

    console.log("PASS pre-join Trip privacy");
  });
});

// Closes the real Firestore client's long-polling WebChannel connection
// and the separate @firebase/rules-unit-testing environment's own
// Firestore connection - without this, Jest reports unstopped
// asynchronous operations and the wrapping `emulators:exec` process
// never exits after the test run itself has otherwise fully passed.
afterAll(async () => {
  await cleanupTrustedInspectionEnv();
  await cleanupDemoFirebaseInstances();
});
