// Shared fixtures/helpers for tripExpenseBalances rules tests
// (Checkpoint 6.7A).
const OWNER_UID = 'owner-uid';
const MEMBER_UID = 'member-uid';
const OUTSIDER_UID = 'outsider-uid';
const TRIP_ID = 'test-trip';
const BALANCE_ID = `${TRIP_ID}_${MEMBER_UID}`;

function validBalanceData(overrides = {}) {
  return {
    tripId: TRIP_ID,
    uid: MEMBER_UID,
    netBalanceMinor: 500,
    ...overrides,
  };
}

async function seedTripExpenseBalance(testEnv, id, data) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().collection('tripExpenseBalances').doc(id).set(data);
  });
}

function tripExpenseBalanceDoc(context, id) {
  return context.firestore().collection('tripExpenseBalances').doc(id);
}

function tripExpenseBalanceCollection(context) {
  return context.firestore().collection('tripExpenseBalances');
}

module.exports = {
  OWNER_UID,
  MEMBER_UID,
  OUTSIDER_UID,
  TRIP_ID,
  BALANCE_ID,
  validBalanceData,
  seedTripExpenseBalance,
  tripExpenseBalanceDoc,
  tripExpenseBalanceCollection,
};
