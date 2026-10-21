// Milestone 5C.4/5C.5 - shared fixture-building helpers for the multi-
// member financial integration suite. Deliberately thin, mirroring
// tests/integration/helpers/fixtures.ts's own convention exactly: every
// Trip/terms/invitation/acceptance/contribution/withdrawal/expense this
// file creates goes through the REAL production client service wrappers
// (acceptTripInvitation, recordSavingsTransaction,
// recordSharedStashExpense - see src/services/firebase/tripInvitations.ts/
// savingsTransactions.ts/expenses.ts), never a direct Firestore seed and
// never a Core function called directly. memberIds is never manually
// seeded - the only way a second uid becomes a current Trip member here
// is the real, already-proven acceptTripInvitation flow.
//
// This module does NOT call jest.mock itself - that must stay in each
// test file (babel-plugin-jest-hoist only hoists jest.mock calls written
// directly in the file Jest is processing). By the time any function
// here actually runs, the importing test file has already registered
// its own `jest.mock("../../firebase", ...)`, so the imports below
// transparently resolve to the demo Firebase instances.
import {acceptTripInvitation} from "../../../src/services/firebase/tripInvitations";
import {
  generateExpenseClientRequestId,
  recordSharedStashExpense,
} from "../../../src/services/firebase/expenses";
import type {RecordSharedStashExpenseResult} from "../../../src/services/firebase/expenses";
import {
  generateSavingsClientRequestId,
  recordSavingsTransaction,
} from "../../../src/services/firebase/savingsTransactions";
import type {RecordSavingsTransactionResult} from "../../../src/services/firebase/savingsTransactions";
import {
  createAndSignInUser,
  setupOwnerTripTermsInvitation,
  signInAs,
} from "./fixtures";

export type AcceptedTwoMemberTrip = {
  tripId: string;
  termsV1Id: string;
  owner: {email: string; uid: string};
  member: {email: string; uid: string};
};

/**
 * Builds the canonical two-member financially-authorized Trip fixture
 * entirely through real callables: real Auth-emulator sign-ups, a real
 * Trip (which is `"initialized"` from the moment createTrip creates it -
 * see the frozen preflight §4), real terms publication, a real
 * invitation, and a real `acceptTripInvitation` call by the invitee.
 * Immediately after this returns: the member uid is present in
 * `trips.memberIds`, and NO `tripMemberOwnership` row exists for the
 * member yet (acceptance never touches ownership rows) - callers that
 * need to prove zero/absent ownership should do so before calling
 * `contributeReal` for the member.
 *
 * Leaves the demo Auth client signed in as the MEMBER on return (the
 * last real operation this function performs is the member's own
 * acceptance call) - a caller that next needs the owner's context must
 * explicitly `signInAs(result.owner.email)` first, mirroring
 * `setupOwnerTripTermsInvitation`'s own documented sign-in convention.
 * @param {string} scenarioLabel A short, scenario-distinguishing label.
 * @return {Promise<AcceptedTwoMemberTrip>} The fixture's resolved
 *   identities.
 */
export async function createAcceptedTwoMemberTrip(
  scenarioLabel: string
): Promise<AcceptedTwoMemberTrip> {
  const owner = await createAndSignInUser(`${scenarioLabel}-owner`);
  const member = await createAndSignInUser(`${scenarioLabel}-member`);
  const setup = await setupOwnerTripTermsInvitation({
    ownerEmail: owner.email,
    inviteeEmail: member.email,
    scenarioLabel,
  });
  await signInAs(member.email);
  await acceptTripInvitation(setup.invitationId, setup.termsV1Id);
  return {
    tripId: setup.tripId,
    termsV1Id: setup.termsV1Id,
    owner: {email: owner.email, uid: owner.uid},
    member: {email: member.email, uid: member.uid},
  };
}

/**
 * Real contribution via the real `recordSavingsTransaction` client
 * wrapper. The demo Auth client must already be signed in as the uid
 * matching `memberUid` - the backend's self-only authorization check
 * (`authUid === memberUid`) has no owner-on-behalf exception.
 * @param {string} tripId The Trip id.
 * @param {string} memberUid The contributing member's own uid.
 * @param {number} amountMinor The contribution amount, integer minor units.
 * @return {Promise<RecordSavingsTransactionResult>} The real callable result.
 */
export async function contributeReal(
  tripId: string,
  memberUid: string,
  amountMinor: number
): Promise<RecordSavingsTransactionResult> {
  return recordSavingsTransaction({
    resourceType: "trip",
    resourceId: tripId,
    memberUid,
    type: "contribution",
    amountMinor,
    currency: "USD",
    clientRequestId: generateSavingsClientRequestId(),
  });
}

/**
 * Real personal withdrawal via the real `recordSavingsTransaction`
 * client wrapper. Same self-only requirement as `contributeReal`.
 * @param {string} tripId The Trip id.
 * @param {string} memberUid The withdrawing member's own uid.
 * @param {number} amountMinor The withdrawal amount, integer minor units.
 * @return {Promise<RecordSavingsTransactionResult>} The real callable result.
 */
export async function withdrawReal(
  tripId: string,
  memberUid: string,
  amountMinor: number
): Promise<RecordSavingsTransactionResult> {
  return recordSavingsTransaction({
    resourceType: "trip",
    resourceId: tripId,
    memberUid,
    type: "withdrawal",
    amountMinor,
    currency: "USD",
    clientRequestId: generateSavingsClientRequestId(),
  });
}

/**
 * Real pooled Shared Stash expense via the real
 * `recordSharedStashExpense` client wrapper. The demo Auth client must
 * already be signed in as the caller who should be recorded as the
 * expense's `createdBy`/withdrawal `memberUid` - per the frozen
 * preflight §9, this identity never affects the proportional economic
 * allocation itself.
 * @param {string} tripId The Trip id.
 * @param {number} amountMinor The expense amount, integer minor units.
 * @param {string} descriptionLabel A short, scenario-distinguishing label.
 * @return {Promise<RecordSharedStashExpenseResult>} The real callable result.
 */
export async function spendSharedStashReal(
  tripId: string,
  amountMinor: number,
  descriptionLabel: string
): Promise<RecordSharedStashExpenseResult> {
  return recordSharedStashExpense({
    tripId,
    amountMinor,
    currency: "USD",
    description: `5C.4/5C.5 ${descriptionLabel}`,
    clientRequestId: generateExpenseClientRequestId(),
  });
}
