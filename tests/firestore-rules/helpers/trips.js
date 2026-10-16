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
    // Checkpoint 3F.3B.2: tripStartDate is now required by the create
    // rule, so every existing "valid trip" fixture needs one by default.
    tripStartDate: '2027-06-12',
    ...overrides,
  };
}

// Checkpoint 5B.5D: the exact canonical shape the trusted createTrip
// Cloud Function actually writes (functions/src/callables/createTrip.ts)
// - every backend-only field present together (ledger/currency/
// ownership-model/creationRequest), used both to prove a client cannot
// directly create this exact shape (the create-denial suite) and to
// seed a realistic native-initialized Trip fixture for update/read/
// archive coverage on an already-created native document.
function validNativeTripData(overrides = {}) {
  const base = validTripData();
  return {
    ...base,
    tripEndDate: null,
    ledgerOpeningBalanceMinor: 0,
    ledgerBalanceMinor: 0,
    currency: 'USD',
    ownershipModelState: 'initialized',
    ownershipModelVersion: 1,
    creationRequest: {
      clientRequestId: TRIP_ID,
      ownerId: base.ownerId,
      title: base.title,
      location: base.location,
      target: base.target,
      imageUrl: base.imageUrl,
      tripStartDate: base.tripStartDate,
      tripEndDate: null,
    },
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
  validNativeTripData,
  seedTrip,
  tripDoc,
  tripsCollection,
};
