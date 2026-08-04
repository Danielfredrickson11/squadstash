// Shared fixtures/helpers for publicUsers rules tests. Mirrors the
// structure of helpers/buckets.js and helpers/trips.js.
//
// Several distinct seeded-document shapes matter for this collection:
// - a "modern" profile that never had emailLower or createdAt
// - a "legacy" profile that still has emailLower from before Milestone 1B
// - a legacy profile that has createdAt (from before checkpoint 5C's fix)
// - a legacy profile with both emailLower and createdAt
// The rules must keep all of these updatable without a live-data
// migration - see the test file for how that's verified.
const MODERN_OWNER_UID = 'modern-owner-uid';
const LEGACY_OWNER_UID = 'legacy-owner-uid';
const LEGACY_CREATED_AT_UID = 'legacy-createdat-uid';
const LEGACY_BOTH_UID = 'legacy-both-uid';
const OTHER_UID = 'other-uid';

function validPublicUserData(uid, overrides = {}) {
  return {
    uid,
    displayName: 'Test User',
    photoURL: 'https://example.com/avatar.png',
    ...overrides,
  };
}

function legacyPublicUserData(uid, overrides = {}) {
  return {
    uid,
    displayName: 'Legacy User',
    photoURL: 'https://example.com/legacy.png',
    emailLower: 'legacy-user@example.com',
    ...overrides,
  };
}

// Seeds a document bypassing security rules entirely, per Milestone 1B
// instructions - firestore.rules itself must never be weakened just to
// make seeding possible.
async function seedPublicUser(testEnv, uid, data) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().collection('publicUsers').doc(uid).set(data);
  });
}

function publicUserDoc(context, uid) {
  return context.firestore().collection('publicUsers').doc(uid);
}

function publicUsersCollection(context) {
  return context.firestore().collection('publicUsers');
}

module.exports = {
  MODERN_OWNER_UID,
  LEGACY_OWNER_UID,
  LEGACY_CREATED_AT_UID,
  LEGACY_BOTH_UID,
  OTHER_UID,
  validPublicUserData,
  legacyPublicUserData,
  seedPublicUser,
  publicUserDoc,
  publicUsersCollection,
};
