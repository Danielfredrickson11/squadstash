// Shared fixtures/helpers for tripTerms rules tests (Checkpoint 5A).
const OWNER_UID = 'owner-uid';
const MEMBER_UID = 'member-uid';
const OUTSIDER_UID = 'outsider-uid';
const TRIP_ID = 'test-trip';
const TERMS_ID = 'test-terms-v1';

function validTripTermsData(overrides = {}) {
  return {
    tripId: TRIP_ID,
    version: 1,
    createdBy: OWNER_UID,
    contributionExpectations: 'Each member contributes $200 by June 1.',
    expenseAllocationExpectations: 'Shared expenses split evenly.',
    sharedStashSpendingAuthority: 'Any member may record a Shared Stash expense.',
    withdrawalExpectations: 'Uncommitted funds may be withdrawn at any time.',
    settlementExpectations: 'Debts settle within 7 days of trip end.',
    ...overrides,
  };
}

// Seeds a document bypassing security rules entirely, matching every
// other rules-test helper's own seed convention.
async function seedTripTerms(testEnv, id, data) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().collection('tripTerms').doc(id).set(data);
  });
}

// Checkpoint 5A.1: seeds the tripTermsCurrent/{tripId} pointer document,
// bypassing security rules (that collection is permanently write-closed
// to every client, including in tests - only publishTripTerms.ts's own
// trusted transaction ever writes it in production).
async function seedTripTermsCurrent(testEnv, tripId, overrides = {}) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context
      .firestore()
      .collection('tripTermsCurrent')
      .doc(tripId)
      .set({
        tripId,
        currentVersion: 1,
        currentTermsDocId: TERMS_ID,
        updatedAt: new Date(),
        ...overrides,
      });
  });
}

function tripTermsDoc(context, id) {
  return context.firestore().collection('tripTerms').doc(id);
}

function tripTermsCollection(context) {
  return context.firestore().collection('tripTerms');
}

function tripTermsCurrentDoc(context, tripId) {
  return context.firestore().collection('tripTermsCurrent').doc(tripId);
}

module.exports = {
  OWNER_UID,
  MEMBER_UID,
  OUTSIDER_UID,
  TRIP_ID,
  TERMS_ID,
  validTripTermsData,
  seedTripTerms,
  seedTripTermsCurrent,
  tripTermsDoc,
  tripTermsCollection,
  tripTermsCurrentDoc,
};
