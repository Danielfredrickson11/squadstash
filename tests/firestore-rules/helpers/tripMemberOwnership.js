// Shared fixtures/helpers for tripMemberOwnership rules tests
// (Checkpoint 5B.1).
const OWNER_UID = 'owner-uid';
const MEMBER_UID = 'member-uid';
const OUTSIDER_UID = 'outsider-uid';
const TRIP_ID = 'test-trip';

function ownershipId(tripId, uid) {
  return `${tripId}_${uid}`;
}

function validOwnershipData(overrides = {}) {
  return {
    tripId: TRIP_ID,
    uid: OWNER_UID,
    ownershipMinor: 90000,
    lastUpdatedAt: new Date(),
    ...overrides,
  };
}

async function seedTripMemberOwnership(testEnv, id, data) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().collection('tripMemberOwnership').doc(id).set(data);
  });
}

function tripMemberOwnershipDoc(context, id) {
  return context.firestore().collection('tripMemberOwnership').doc(id);
}

function tripMemberOwnershipCollection(context) {
  return context.firestore().collection('tripMemberOwnership');
}

module.exports = {
  OWNER_UID,
  MEMBER_UID,
  OUTSIDER_UID,
  TRIP_ID,
  ownershipId,
  validOwnershipData,
  seedTripMemberOwnership,
  tripMemberOwnershipDoc,
  tripMemberOwnershipCollection,
};
