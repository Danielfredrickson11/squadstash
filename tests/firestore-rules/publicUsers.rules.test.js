// Comprehensive Firestore rules coverage for the `publicUsers` collection,
// run against the local Firestore emulator using the real firestore.rules
// file (never weakened to make a test pass - see helpers/publicUsers.js).
//
// Written to describe the DESIRED final-state schema/rules (Milestone 1B
// checkpoint 3B). The first run of this suite is expected to surface
// failures against the current, more permissive rules - see the
// checkpoint report for the recorded before/after results.
const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { createTestEnv } = require('./helpers/testEnv');
const {
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
} = require('./helpers/publicUsers');

let testEnv;

beforeAll(async () => {
  testEnv = await createTestEnv();
});

afterAll(async () => {
  if (testEnv) {
    await testEnv.cleanup();
  }
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

// Small helpers so individual `it` blocks stay focused on actor + action.
function asModernOwner() {
  return testEnv.authenticatedContext(MODERN_OWNER_UID);
}
function asLegacyOwner() {
  return testEnv.authenticatedContext(LEGACY_OWNER_UID);
}
function asCreatedAtOwner() {
  return testEnv.authenticatedContext(LEGACY_CREATED_AT_UID);
}
function asBothLegacyOwner() {
  return testEnv.authenticatedContext(LEGACY_BOTH_UID);
}
function asOther() {
  return testEnv.authenticatedContext(OTHER_UID);
}
function asUnauthenticated() {
  return testEnv.unauthenticatedContext();
}

async function seedModernProfile() {
  await seedPublicUser(testEnv, MODERN_OWNER_UID, validPublicUserData(MODERN_OWNER_UID));
}

async function seedLegacyProfile() {
  await seedPublicUser(testEnv, LEGACY_OWNER_UID, legacyPublicUserData(LEGACY_OWNER_UID));
}

// Represents a document created before checkpoint 5C's fix, when
// register.tsx still sent createdAt to publicUsers.
async function seedLegacyCreatedAtProfile() {
  await seedPublicUser(
    testEnv,
    LEGACY_CREATED_AT_UID,
    validPublicUserData(LEGACY_CREATED_AT_UID, { createdAt: new Date('2025-01-01') })
  );
}

// Represents the oldest-style document: both emailLower (pre-3B) and
// createdAt (pre-5C) still present.
async function seedLegacyBothProfile() {
  await seedPublicUser(
    testEnv,
    LEGACY_BOTH_UID,
    validPublicUserData(LEGACY_BOTH_UID, {
      createdAt: new Date('2024-06-01'),
      emailLower: 'both-legacy@example.com',
    })
  );
}

describe('firestore.rules: publicUsers - reads and queries', () => {
  beforeEach(async () => {
    await seedModernProfile();
  });

  it('unauthenticated user: cannot read a profile', async () => {
    await assertFails(publicUserDoc(asUnauthenticated(), MODERN_OWNER_UID).get());
  });

  it('authenticated user: can read a public profile (current intended behavior)', async () => {
    await assertSucceeds(publicUserDoc(asOther(), MODERN_OWNER_UID).get());
  });

  it('authenticated user: can query/list profiles (current intended behavior)', async () => {
    const snap = await assertSucceeds(publicUsersCollection(asOther()).get());
    expect(snap.docs.map((d) => d.id)).toContain(MODERN_OWNER_UID);
  });
});

describe('firestore.rules: publicUsers - create', () => {
  it('authenticated user: can create their own valid profile', async () => {
    await assertSucceeds(
      publicUserDoc(asModernOwner(), MODERN_OWNER_UID).set(
        validPublicUserData(MODERN_OWNER_UID)
      )
    );
  });

  it('unauthenticated user: cannot create a profile', async () => {
    await assertFails(
      publicUserDoc(asUnauthenticated(), MODERN_OWNER_UID).set(
        validPublicUserData(MODERN_OWNER_UID)
      )
    );
  });

  it('user: cannot create another user\'s document (document ID mismatch)', async () => {
    await assertFails(
      publicUserDoc(asOther(), MODERN_OWNER_UID).set(
        validPublicUserData(MODERN_OWNER_UID)
      )
    );
  });

  it('create: uid field must match auth UID (even if document ID is own)', async () => {
    await assertFails(
      publicUserDoc(asOther(), OTHER_UID).set(
        validPublicUserData(MODERN_OWNER_UID) // uid field points at someone else
      )
    );
  });

  it('create: emailLower is rejected', async () => {
    await assertFails(
      publicUserDoc(asModernOwner(), MODERN_OWNER_UID).set(
        validPublicUserData(MODERN_OWNER_UID, { emailLower: 'me@example.com' })
      )
    );
  });

  it('create: arbitrary fields are rejected', async () => {
    await assertFails(
      publicUserDoc(asModernOwner(), MODERN_OWNER_UID).set(
        validPublicUserData(MODERN_OWNER_UID, { bio: 'not allowed' })
      )
    );
  });

  it('create: invalid displayName type is rejected', async () => {
    await assertFails(
      publicUserDoc(asModernOwner(), MODERN_OWNER_UID).set(
        validPublicUserData(MODERN_OWNER_UID, { displayName: 123 })
      )
    );
  });

  it('create: invalid photoURL type is rejected', async () => {
    await assertFails(
      publicUserDoc(asModernOwner(), MODERN_OWNER_UID).set(
        validPublicUserData(MODERN_OWNER_UID, { photoURL: 123 })
      )
    );
  });

  it('create: createdAt is rejected in a new document', async () => {
    await assertFails(
      publicUserDoc(asModernOwner(), MODERN_OWNER_UID).set(
        validPublicUserData(MODERN_OWNER_UID, { createdAt: new Date() })
      )
    );
  });
});

describe('firestore.rules: publicUsers - update (modern profile)', () => {
  beforeEach(async () => {
    await seedModernProfile();
  });

  it('owner: can update displayName', async () => {
    await assertSucceeds(
      publicUserDoc(asModernOwner(), MODERN_OWNER_UID).update({ displayName: 'Renamed' })
    );
  });

  it('owner: can update photoURL', async () => {
    await assertSucceeds(
      publicUserDoc(asModernOwner(), MODERN_OWNER_UID).update({
        photoURL: 'https://example.com/new.png',
      })
    );
  });

  it('owner: can update updatedAt', async () => {
    await assertSucceeds(
      publicUserDoc(asModernOwner(), MODERN_OWNER_UID).update({ updatedAt: new Date() })
    );
  });

  it('owner: cannot change uid', async () => {
    await assertFails(
      publicUserDoc(asModernOwner(), MODERN_OWNER_UID).update({ uid: OTHER_UID })
    );
  });

  it('owner: cannot add emailLower to a modern profile', async () => {
    await assertFails(
      publicUserDoc(asModernOwner(), MODERN_OWNER_UID).update({
        emailLower: 'sneaky@example.com',
      })
    );
  });

  it('owner: cannot add createdAt to a modern profile', async () => {
    // Reproduces the original write-order bug scenario directly: a
    // document created without createdAt must never be able to gain it
    // via a later update, regardless of which screen attempts the write.
    await assertFails(
      publicUserDoc(asModernOwner(), MODERN_OWNER_UID).update({
        createdAt: new Date(),
      })
    );
  });

  it('owner: cannot add arbitrary fields', async () => {
    await assertFails(
      publicUserDoc(asModernOwner(), MODERN_OWNER_UID).update({ bio: 'not allowed' })
    );
  });

  it('owner: cannot write an invalid field type (displayName)', async () => {
    await assertFails(
      publicUserDoc(asModernOwner(), MODERN_OWNER_UID).update({ displayName: 456 })
    );
  });

  it('another authenticated user: cannot update the profile', async () => {
    await assertFails(
      publicUserDoc(asOther(), MODERN_OWNER_UID).update({ displayName: 'Hijacked' })
    );
  });

  it('unauthenticated user: cannot update the profile', async () => {
    await assertFails(
      publicUserDoc(asUnauthenticated(), MODERN_OWNER_UID).update({ displayName: 'Hijacked' })
    );
  });
});

describe('firestore.rules: publicUsers - update (legacy profile with emailLower)', () => {
  beforeEach(async () => {
    await seedLegacyProfile();
  });

  it('owner: can update a legacy document when emailLower remains unchanged (no live-data migration required)', async () => {
    await assertSucceeds(
      publicUserDoc(asLegacyOwner(), LEGACY_OWNER_UID).update({ displayName: 'Still Legacy' })
    );
  });

  it('owner: cannot change an existing legacy emailLower value', async () => {
    await assertFails(
      publicUserDoc(asLegacyOwner(), LEGACY_OWNER_UID).update({
        emailLower: 'changed@example.com',
      })
    );
  });
});

describe('firestore.rules: publicUsers - AuthContext create-then-merge flow', () => {
  it('a profile created with the AuthContext payload shape (no createdAt) can be created, then later merge-updated with uid, displayName, photoURL, and updatedAt', async () => {
    // Step 1: simulates AuthContext.upsertPublicUser's very first write for
    // a brand-new user - {uid, displayName, photoURL, updatedAt}, no
    // createdAt. This must succeed under the create rule.
    await assertSucceeds(
      publicUserDoc(asModernOwner(), MODERN_OWNER_UID).set({
        ...validPublicUserData(MODERN_OWNER_UID),
        updatedAt: new Date(),
      })
    );

    // Step 2: simulates a later session's AuthContext upsert (merge
    // write) touching the same allowed fields. This is exactly the write
    // that used to fail if a registration write raced with it and had
    // already added createdAt - now neither write ever sends createdAt,
    // so this always succeeds regardless of ordering.
    await assertSucceeds(
      publicUserDoc(asModernOwner(), MODERN_OWNER_UID).update({
        uid: MODERN_OWNER_UID,
        displayName: 'Updated Name',
        photoURL: 'https://example.com/updated.png',
        updatedAt: new Date(),
      })
    );
  });
});

describe('firestore.rules: publicUsers - update (legacy profile with createdAt)', () => {
  beforeEach(async () => {
    await seedLegacyCreatedAtProfile();
  });

  it('owner: can update an allowed field while legacy createdAt remains unchanged (no live-data migration required)', async () => {
    await assertSucceeds(
      publicUserDoc(asCreatedAtOwner(), LEGACY_CREATED_AT_UID).update({
        displayName: 'Still Has CreatedAt',
      })
    );
  });

  it('owner: cannot change the existing legacy createdAt value', async () => {
    await assertFails(
      publicUserDoc(asCreatedAtOwner(), LEGACY_CREATED_AT_UID).update({
        createdAt: new Date('2030-01-01'),
      })
    );
  });

  it('owner: cannot remove the existing legacy createdAt value via full document replacement', async () => {
    // A non-merge set() on an existing document is evaluated under the
    // update rule with the full replacement document as
    // request.resource.data - omitting createdAt here would remove it,
    // which must be blocked the same as changing its value.
    await assertFails(
      publicUserDoc(asCreatedAtOwner(), LEGACY_CREATED_AT_UID).set(
        validPublicUserData(LEGACY_CREATED_AT_UID)
      )
    );
  });
});

describe('firestore.rules: publicUsers - update (legacy profile with both emailLower and createdAt)', () => {
  beforeEach(async () => {
    await seedLegacyBothProfile();
  });

  it('owner: can update an allowed field while both legacy emailLower and createdAt remain unchanged', async () => {
    await assertSucceeds(
      publicUserDoc(asBothLegacyOwner(), LEGACY_BOTH_UID).update({
        displayName: 'Still Has Both Legacy Fields',
      })
    );
  });
});

describe('firestore.rules: publicUsers - deletes', () => {
  beforeEach(async () => {
    await seedModernProfile();
  });

  it('owner: can delete their own profile (current intended self-only delete policy)', async () => {
    await assertSucceeds(publicUserDoc(asModernOwner(), MODERN_OWNER_UID).delete());
  });

  it('another authenticated user: cannot delete the profile', async () => {
    await assertFails(publicUserDoc(asOther(), MODERN_OWNER_UID).delete());
  });

  it('unauthenticated user: cannot delete the profile', async () => {
    await assertFails(publicUserDoc(asUnauthenticated(), MODERN_OWNER_UID).delete());
  });
});
