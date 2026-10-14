// Shared fixtures/helpers for tripOwnershipMigrationState rules tests
// (Checkpoint 5B.4B).
const OWNER_UID = 'owner-uid';
const MEMBER_UID = 'member-uid';
const OUTSIDER_UID = 'outsider-uid';
const TRIP_ID = 'test-trip';

function validMigrationStateData(overrides = {}) {
  return {
    tripId: TRIP_ID,
    attemptId: 'attempt-1',
    phase: 'locked',
    lockedAt: new Date(),
    startedAt: new Date(),
    lockedFinancialBasis: {
      ledgerInitializationKind: 'initialized',
      ledgerOpeningBalanceMinor: 0,
      ledgerBalanceMinor: 1000,
      effectiveCurrency: 'USD',
    },
    ...overrides,
  };
}

async function seedTripOwnershipMigrationState(testEnv, id, data) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().collection('tripOwnershipMigrationState').doc(id).set(data);
  });
}

function tripOwnershipMigrationStateDoc(context, id) {
  return context.firestore().collection('tripOwnershipMigrationState').doc(id);
}

function tripOwnershipMigrationStateCollection(context) {
  return context.firestore().collection('tripOwnershipMigrationState');
}

module.exports = {
  OWNER_UID,
  MEMBER_UID,
  OUTSIDER_UID,
  TRIP_ID,
  validMigrationStateData,
  seedTripOwnershipMigrationState,
  tripOwnershipMigrationStateDoc,
  tripOwnershipMigrationStateCollection,
};
