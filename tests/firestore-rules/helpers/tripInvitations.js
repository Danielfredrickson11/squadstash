// Shared fixtures/helpers for tripInvitations rules tests (Checkpoint 5A).
const { Timestamp } = require('firebase/firestore');

const OWNER_UID = 'owner-uid';
const INVITEE_UID = 'invitee-uid';
const OUTSIDER_UID = 'outsider-uid';
const TRIP_ID = 'test-trip';

function invitationId(tripId, inviteeUid) {
  return `${tripId}_${inviteeUid}`;
}

function validInvitationData(overrides = {}) {
  return {
    tripId: TRIP_ID,
    inviterUid: OWNER_UID,
    inviteeEmail: 'friend@example.com',
    inviteeUid: INVITEE_UID,
    status: 'pending',
    createdAt: Timestamp.now(),
    expiresAt: Timestamp.fromMillis(Date.now() + 14 * 24 * 60 * 60 * 1000),
    respondedAt: null,
    ...overrides,
  };
}

async function seedTripInvitation(testEnv, id, data) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().collection('tripInvitations').doc(id).set(data);
  });
}

function tripInvitationDoc(context, id) {
  return context.firestore().collection('tripInvitations').doc(id);
}

function tripInvitationsCollection(context) {
  return context.firestore().collection('tripInvitations');
}

module.exports = {
  OWNER_UID,
  INVITEE_UID,
  OUTSIDER_UID,
  TRIP_ID,
  invitationId,
  validInvitationData,
  seedTripInvitation,
  tripInvitationDoc,
  tripInvitationsCollection,
};
