// Shared fixtures/helpers for trips rules tests. Mirrors the structure of
// helpers/buckets.js but stays self-contained (not imported from there) -
// the two collections' rules are similar but not identical, so duplicating
// this small amount of setup keeps each helper file independently readable.
const OWNER_UID = 'owner-uid';
const MEMBER_UID = 'member-uid';
const OUTSIDER_UID = 'outsider-uid';
const TRIP_ID = 'test-trip';

function validTripData(overrides = {}) {
  return {
    ownerId: OWNER_UID,
    memberIds: [OWNER_UID, MEMBER_UID],
    title: 'Test Trip',
    location: 'Somewhere',
    target: 1000,
    saved: 0,
    imageUrl: 'https://example.com/trip.jpg',
    ...overrides,
  };
}

// Seeds a document bypassing security rules entirely, per Milestone 1B
// instructions - firestore.rules itself must never be weakened just to
// make seeding possible.
async function seedTrip(testEnv, id, data) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().collection('trips').doc(id).set(data);
  });
}

function tripDoc(context, id) {
  return context.firestore().collection('trips').doc(id);
}

function tripsCollection(context) {
  return context.firestore().collection('trips');
}

module.exports = {
  OWNER_UID,
  MEMBER_UID,
  OUTSIDER_UID,
  TRIP_ID,
  validTripData,
  seedTrip,
  tripDoc,
  tripsCollection,
};
