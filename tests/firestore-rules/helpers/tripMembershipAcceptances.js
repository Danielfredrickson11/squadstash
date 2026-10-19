// Shared fixtures/helpers for tripMembershipAcceptances rules tests
// (Checkpoint 5A).
const OWNER_UID = 'owner-uid';
const MEMBER_UID = 'member-uid';
const OUTSIDER_UID = 'outsider-uid';
// Checkpoint 5C.2: a SECOND current Trip member, distinct from
// MEMBER_UID, used to prove one current member cannot forge an
// acceptance record claiming to be ANOTHER member's uid.
const SECOND_MEMBER_UID = 'second-member-uid';
const TRIP_ID = 'test-trip';
const TERMS_ID = 'test-terms-v1';

function acceptanceId(tripId, uid, termsDocId) {
  return `${tripId}_${uid}_${termsDocId}`;
}

function validAcceptanceData(overrides = {}) {
  return {
    tripId: TRIP_ID,
    uid: MEMBER_UID,
    termsDocId: TERMS_ID,
    acceptedTermsVersion: 1,
    acceptedAt: new Date(),
    ...overrides,
  };
}

async function seedTripMembershipAcceptance(testEnv, id, data) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().collection('tripMembershipAcceptances').doc(id).set(data);
  });
}

function tripMembershipAcceptanceDoc(context, id) {
  return context.firestore().collection('tripMembershipAcceptances').doc(id);
}

module.exports = {
  OWNER_UID,
  MEMBER_UID,
  OUTSIDER_UID,
  SECOND_MEMBER_UID,
  TRIP_ID,
  TERMS_ID,
  acceptanceId,
  validAcceptanceData,
  seedTripMembershipAcceptance,
  tripMembershipAcceptanceDoc,
};
