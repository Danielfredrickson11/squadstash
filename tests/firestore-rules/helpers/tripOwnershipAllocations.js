// Shared fixtures/helpers for tripOwnershipAllocations rules tests
// (Checkpoint 5B.1).
const OWNER_UID = 'owner-uid';
const MEMBER_UID = 'member-uid';
const OUTSIDER_UID = 'outsider-uid';
const TRIP_ID = 'test-trip';
const WITHDRAWAL_TRANSACTION_ID = 'withdrawal-1';

function validAllocationData(overrides = {}) {
  return {
    tripId: TRIP_ID,
    expenseId: 'expense-1',
    withdrawalTransactionId: WITHDRAWAL_TRANSACTION_ID,
    amountMinor: 1000,
    currency: 'USD',
    provenance: 'original',
    allocations: [
      { uid: OWNER_UID, amountMinor: 900 },
      { uid: MEMBER_UID, amountMinor: 100 },
    ],
    ...overrides,
  };
}

async function seedTripOwnershipAllocation(testEnv, id, data) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().collection('tripOwnershipAllocations').doc(id).set(data);
  });
}

function tripOwnershipAllocationDoc(context, id) {
  return context.firestore().collection('tripOwnershipAllocations').doc(id);
}

function tripOwnershipAllocationCollection(context) {
  return context.firestore().collection('tripOwnershipAllocations');
}

module.exports = {
  OWNER_UID,
  MEMBER_UID,
  OUTSIDER_UID,
  TRIP_ID,
  WITHDRAWAL_TRANSACTION_ID,
  validAllocationData,
  seedTripOwnershipAllocation,
  tripOwnershipAllocationDoc,
  tripOwnershipAllocationCollection,
};
