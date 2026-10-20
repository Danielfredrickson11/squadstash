// Checkpoint 5C.3D-B - shared fixture-building helpers for the Trip
// invitation integration suite. Deliberately thin: every Trip/terms/
// invitation this file creates goes through the REAL production client
// service wrappers (createTrip, publishTripTerms, createTripInvitation -
// see src/services/firebase/trips.ts/tripTerms.ts/tripInvitations.ts),
// never a direct Firestore seed and never a Core function called
// directly - this file never re-implements any service logic, it only
// sequences real calls and real Auth sign-in/sign-up.
//
// This module does NOT call jest.mock itself - that must stay in each
// test file (babel-plugin-jest-hoist only hoists jest.mock calls written
// directly in the file Jest is processing). By the time any function
// here actually runs, the importing test file has already registered its
// own `jest.mock("../../firebase", ...)`, so the imports below
// transparently resolve to the demo Firebase instances.
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  type User,
} from "firebase/auth";
import {auth} from "../../../firebase";
import {createTrip, generateTripClientRequestId} from "../../../src/services/firebase/trips";
import {createTripInvitation} from "../../../src/services/firebase/tripInvitations";
import {publishTripTerms} from "../../../src/services/firebase/tripTerms";
import type {CreateTripTermsInput} from "../../../src/types/domain";

let uniqueCounter = 0;

/** A unique, run-local email - defense-in-depth per preflight §17. */
export function uniqueEmail(label: string): string {
  uniqueCounter += 1;
  return `5c3d-${label}-${Date.now()}-${uniqueCounter}@example.com`;
}

const PASSWORD = "integration-test-password-1";

/** Creates a fresh Auth-emulator user via the real Web SDK and signs in. */
export async function createAndSignInUser(label: string): Promise<{
  email: string;
  uid: string;
  user: User;
}> {
  const email = uniqueEmail(label);
  const cred = await createUserWithEmailAndPassword(auth, email, PASSWORD);
  return {email, uid: cred.user.uid, user: cred.user};
}

/** Switches the single shared demo Auth client to an already-created user. */
export async function signInAs(email: string): Promise<User> {
  const cred = await signInWithEmailAndPassword(auth, email, PASSWORD);
  return cred.user;
}

/**
 * Creates a Trip through the REAL createTrip client wrapper (which
 * itself invokes the REAL createTrip Cloud Function via httpsCallable).
 * Caller must already be signed in as the intended owner.
 */
export async function createRealTrip(titleLabel: string): Promise<string> {
  const clientRequestId = generateTripClientRequestId();
  const result = await createTrip({
    clientRequestId,
    title: `5C.3D ${titleLabel} ${Date.now()}`,
    location: "Integration Test Location",
    target: 1000,
    imageUrl: "https://example.com/5c3d-integration.jpg",
    tripStartDate: "2030-01-01",
    tripEndDate: null,
  });
  return result.tripId;
}

const BASE_TERMS_FIELDS: Omit<CreateTripTermsInput, "tripId"> = {
  contributionExpectations: "5C.3D base - contribution text.",
  expenseAllocationExpectations: "5C.3D base - expense allocation text.",
  sharedStashSpendingAuthority: "5C.3D base - spending authority text.",
  withdrawalExpectations: "5C.3D base - withdrawal text.",
  settlementExpectations: "5C.3D base - settlement text.",
};

/**
 * Publishes a distinctively-labeled terms version through the REAL
 * publishTripTerms client wrapper. Caller must already be signed in as
 * the Trip owner.
 */
export async function publishRealTerms(
  tripId: string,
  versionLabel: string
): Promise<{id: string; version: number}> {
  const stamped = Object.fromEntries(
    Object.entries(BASE_TERMS_FIELDS).map(([key, value]) => [
      key,
      `5C.3D ${versionLabel} - ${value}`,
    ])
  ) as Omit<CreateTripTermsInput, "tripId">;
  return publishTripTerms({tripId, ...stamped});
}

/**
 * Creates an invitation through the REAL createTripInvitation client
 * wrapper, which invokes the REAL Cloud Function - this is the function
 * that performs server-side getAuth().getUserByEmail(...) against the
 * Auth Emulator (preflight §2 Finding 1). Caller must already be signed
 * in as the Trip owner.
 */
export async function createRealInvitation(
  tripId: string,
  inviteeEmail: string
): Promise<{invitationId: string; inviteeUid: string}> {
  return createTripInvitation(tripId, inviteeEmail);
}

/**
 * Convenience: the full owner-side setup for one scenario - sign in as
 * owner, create Trip, publish v1 terms, invite the given invitee email -
 * entirely through real callables. Returns every id/identity a scenario
 * needs, and leaves the demo Auth client signed in as the OWNER (callers
 * that need the invitee next must explicitly sign in as them).
 */
export async function setupOwnerTripTermsInvitation(input: {
  ownerEmail: string;
  inviteeEmail: string;
  scenarioLabel: string;
}): Promise<{
  tripId: string;
  termsV1Id: string;
  termsV1Version: number;
  invitationId: string;
  inviteeUid: string;
}> {
  await signInAs(input.ownerEmail);
  const tripId = await createRealTrip(input.scenarioLabel);
  const termsV1 = await publishRealTerms(tripId, "v1");
  const {invitationId, inviteeUid} = await createRealInvitation(
    tripId,
    input.inviteeEmail
  );
  return {
    tripId,
    termsV1Id: termsV1.id,
    termsV1Version: termsV1.version,
    invitationId,
    inviteeUid,
  };
}
