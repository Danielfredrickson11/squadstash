// Shared fixtures/helpers for tripMembershipActivity rules tests
// (Checkpoint 6.8B3). Mirrors helpers/tripMembershipDepartures.js's/
// helpers/tripExpenses.js-equivalent structure exactly - stays
// self-contained (not imported from elsewhere) per this checkpoint's
// own scope.
const { Timestamp } = require('firebase/firestore');

const OWNER_UID = 'owner-uid';
const MEMBER_UID = 'member-uid';
const OUTSIDER_UID = 'outsider-uid';
const TRIP_ID = 'test-trip';

// A second, fully independent Trip/actor pair, used only for cross-Trip
// isolation tests - OWNER_B_UID/MEMBER_B_UID have no relationship
// whatsoever to TRIP_ID.
const OWNER_B_UID = 'owner-b-uid';
const MEMBER_B_UID = 'member-b-uid';
const TRIP_B_ID = 'test-trip-b';

const INVITEE_UID = 'invitee-uid';
const FORMER_MEMBER_UID = 'former-member-uid';

function baseActivityData(overrides = {}) {
  return {
    tripId: TRIP_ID,
    type: 'trip_created',
    actorUid: OWNER_UID,
    targetUid: OWNER_UID,
    createdAt: Timestamp.now(),
    schemaVersion: 1,
    ...overrides,
  };
}

// The Rules security decision depends ONLY on Trip membership + the
// activity document's own tripId field - never on event type (6.8B3
// item 5) - so these five builders exist purely to prove that same
// read policy holds uniformly across every representative event
// family, not because any of them needs its own distinct Rules
// treatment.
function tripCreatedActivity(overrides = {}) {
  return baseActivityData({
    type: 'trip_created',
    actorUid: OWNER_UID,
    targetUid: OWNER_UID,
    ...overrides,
  });
}

function invitationCreatedActivity(overrides = {}) {
  return baseActivityData({
    type: 'invitation_created',
    actorUid: OWNER_UID,
    targetUid: INVITEE_UID,
    invitationId: `${TRIP_ID}_${INVITEE_UID}`,
    ...overrides,
  });
}

function invitationAcceptedActivity(overrides = {}) {
  return baseActivityData({
    type: 'invitation_accepted',
    actorUid: MEMBER_UID,
    targetUid: MEMBER_UID,
    invitationId: `${TRIP_ID}_${MEMBER_UID}`,
    ...overrides,
  });
}

function memberLeftActivity(overrides = {}) {
  return baseActivityData({
    type: 'member_left',
    actorUid: FORMER_MEMBER_UID,
    targetUid: FORMER_MEMBER_UID,
    ...overrides,
  });
}

function memberRemovedActivity(overrides = {}) {
  return baseActivityData({
    type: 'member_removed',
    actorUid: OWNER_UID,
    targetUid: FORMER_MEMBER_UID,
    ...overrides,
  });
}

function historyTrackingStartedActivity(overrides = {}) {
  return baseActivityData({
    type: 'history_tracking_started',
    actorUid: null,
    targetUid: null,
    ...overrides,
  });
}

// Seeds bypassing security rules entirely - the only way to seed a
// tripMembershipActivity document, since client create is permanently
// closed. Never a production client-write path.
async function seedTripMembershipActivity(testEnv, id, data) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().collection('tripMembershipActivity').doc(id).set(data);
  });
}

function activityDoc(context, id) {
  return context.firestore().collection('tripMembershipActivity').doc(id);
}

function activityCollection(context) {
  return context.firestore().collection('tripMembershipActivity');
}

module.exports = {
  OWNER_UID,
  MEMBER_UID,
  OUTSIDER_UID,
  TRIP_ID,
  OWNER_B_UID,
  MEMBER_B_UID,
  TRIP_B_ID,
  INVITEE_UID,
  FORMER_MEMBER_UID,
  baseActivityData,
  tripCreatedActivity,
  invitationCreatedActivity,
  invitationAcceptedActivity,
  memberLeftActivity,
  memberRemovedActivity,
  historyTrackingStartedActivity,
  seedTripMembershipActivity,
  activityDoc,
  activityCollection,
};
