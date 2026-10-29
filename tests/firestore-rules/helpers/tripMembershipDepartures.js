// Shared fixtures/helpers for tripMembershipDepartures rules tests
// (Checkpoint 6.7B1).
const OWNER_UID = 'owner-uid';
const MEMBER_UID = 'member-uid';
const DEPARTED_UID = 'departed-uid';
const OUTSIDER_UID = 'outsider-uid';
const TRIP_ID = 'test-trip';
const DEPARTURE_ID = `${TRIP_ID}_${DEPARTED_UID}`;

function validDepartureData(overrides = {}) {
  return {
    tripId: TRIP_ID,
    uid: DEPARTED_UID,
    departureType: 'left',
    departedByUid: DEPARTED_UID,
    tripTitleSnapshot: 'Test Trip',
    ...overrides,
  };
}

async function seedTripMembershipDeparture(testEnv, id, data) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().collection('tripMembershipDepartures').doc(id).set(data);
  });
}

function tripMembershipDepartureDoc(context, id) {
  return context.firestore().collection('tripMembershipDepartures').doc(id);
}

function tripMembershipDepartureCollection(context) {
  return context.firestore().collection('tripMembershipDepartures');
}

module.exports = {
  OWNER_UID,
  MEMBER_UID,
  DEPARTED_UID,
  OUTSIDER_UID,
  TRIP_ID,
  DEPARTURE_ID,
  validDepartureData,
  seedTripMembershipDeparture,
  tripMembershipDepartureDoc,
  tripMembershipDepartureCollection,
};
