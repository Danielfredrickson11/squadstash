// Comprehensive Firestore rules coverage for the `trips` collection,
// run against the local Firestore emulator using the real firestore.rules
// file (never weakened to make a test pass - see helpers/trips.js).
const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { deleteField } = require('firebase/firestore');
const { createTestEnv } = require('./helpers/testEnv');
const {
  OWNER_UID,
  MEMBER_UID,
  OUTSIDER_UID,
  TRIP_ID,
  validTripData,
  seedTrip,
  tripDoc,
  tripsCollection,
} = require('./helpers/trips');

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
function asOwner() {
  return testEnv.authenticatedContext(OWNER_UID);
}
function asMember() {
  return testEnv.authenticatedContext(MEMBER_UID);
}
function asOutsider() {
  return testEnv.authenticatedContext(OUTSIDER_UID);
}
function asUnauthenticated() {
  return testEnv.unauthenticatedContext();
}

// Builds a trip payload with no `location` key at all (as opposed to an
// explicit null), to exercise the create rule's "location may be absent"
// branch. Firestore's SDK throws on explicit `undefined` field values, so
// this can't be done via validTripData({ location: undefined }).
function withoutLocation(data) {
  const { location, ...rest } = data;
  return rest;
}

describe('firestore.rules: trips - authentication and reads', () => {
  beforeEach(async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
  });

  it('unauthenticated user: cannot read a trip', async () => {
    await assertFails(tripDoc(asUnauthenticated(), TRIP_ID).get());
  });

  it('owner: can read their trip', async () => {
    await assertSucceeds(tripDoc(asOwner(), TRIP_ID).get());
  });

  it('non-owner member: can read the trip', async () => {
    await assertSucceeds(tripDoc(asMember(), TRIP_ID).get());
  });

  it('outsider: cannot read the trip', async () => {
    await assertFails(tripDoc(asOutsider(), TRIP_ID).get());
  });

  it('authenticated member: a memberIds-scoped query returns trips they belong to', async () => {
    const snap = await assertSucceeds(
      tripsCollection(asMember()).where('memberIds', 'array-contains', MEMBER_UID).get()
    );
    expect(snap.docs.map((d) => d.id)).toContain(TRIP_ID);
  });

  it('outsider: cannot retrieve a protected trip through a query for another user', async () => {
    await assertFails(
      tripsCollection(asOutsider()).where('memberIds', 'array-contains', OWNER_UID).get()
    );
  });
});

describe('firestore.rules: trips - create', () => {
  it('authenticated user: can create a valid trip (ownerId = uid, ownerId in memberIds, valid types)', async () => {
    await assertSucceeds(
      tripDoc(asOwner(), 'new-trip').set(validTripData())
    );
  });

  it('unauthenticated user: cannot create a trip', async () => {
    await assertFails(
      tripDoc(asUnauthenticated(), 'new-trip').set(validTripData())
    );
  });

  it('user: cannot create a trip owned by another user', async () => {
    await assertFails(
      tripDoc(asOwner(), 'new-trip').set(
        validTripData({ ownerId: OUTSIDER_UID })
      )
    );
  });

  it('create: owner must be included in memberIds', async () => {
    await assertFails(
      tripDoc(asOwner(), 'new-trip').set(
        validTripData({ memberIds: [MEMBER_UID] })
      )
    );
  });

  it('create: invalid memberIds type is rejected', async () => {
    await assertFails(
      tripDoc(asOwner(), 'new-trip').set(
        validTripData({ memberIds: OWNER_UID })
      )
    );
  });

  it('create: invalid target type is rejected', async () => {
    await assertFails(
      tripDoc(asOwner(), 'new-trip').set(
        validTripData({ target: '1000' })
      )
    );
  });

  it('create: invalid saved type is rejected', async () => {
    await assertFails(
      tripDoc(asOwner(), 'new-trip').set(
        validTripData({ saved: '0' })
      )
    );
  });

  it('create: invalid title type is rejected', async () => {
    await assertFails(
      tripDoc(asOwner(), 'new-trip').set(
        validTripData({ title: 123 })
      )
    );
  });

  it('create: invalid imageUrl type is rejected', async () => {
    await assertFails(
      tripDoc(asOwner(), 'new-trip').set(
        validTripData({ imageUrl: 123 })
      )
    );
  });

  it('create: location may be an explicit string', async () => {
    await assertSucceeds(
      tripDoc(asOwner(), 'new-trip').set(validTripData({ location: 'Somewhere Else' }))
    );
  });

  it('create: location may be explicit null', async () => {
    await assertSucceeds(
      tripDoc(asOwner(), 'new-trip').set(validTripData({ location: null }))
    );
  });

  it('create: location may be omitted entirely', async () => {
    await assertSucceeds(
      tripDoc(asOwner(), 'new-trip').set(withoutLocation(validTripData()))
    );
  });

  it('create: invalid location type (present but not string/null) is rejected', async () => {
    await assertFails(
      tripDoc(asOwner(), 'new-trip').set(validTripData({ location: 123 }))
    );
  });

  // Milestone 2B Checkpoint 4I: Trip has no Starting Balance concept - a
  // freshly-created Trip must always report a neutral saved: 0. The
  // existing "valid trip create" test above already proves saved: 0
  // succeeds via validTripData()'s default, so no separate zero-saved
  // success test is added here.
  it('create: a nonzero saved is rejected', async () => {
    await assertFails(
      tripDoc(asOwner(), 'new-trip').set(validTripData({ saved: 500 }))
    );
  });

  it('create: a negative saved is rejected', async () => {
    await assertFails(
      tripDoc(asOwner(), 'new-trip').set(validTripData({ saved: -50 }))
    );
  });

  // Milestone 2B Checkpoint 4I: a client must never be able to inject
  // either trusted ledger field, not even at create time - the trusted
  // recordSavingsTransaction backend would otherwise treat a client-
  // forged pair of ledger fields as already-initialized truth, or
  // permanently break the Trip via its partial-ledger guard if only one
  // is present (see firestore.rules's create comment for the full
  // reasoning).
  it('create: ledgerBalanceMinor cannot be injected', async () => {
    await assertFails(
      tripDoc(asOwner(), 'new-trip').set(
        validTripData({ ledgerBalanceMinor: 999999 })
      )
    );
  });

  it('create: ledgerOpeningBalanceMinor cannot be injected', async () => {
    await assertFails(
      tripDoc(asOwner(), 'new-trip').set(
        validTripData({ ledgerOpeningBalanceMinor: 999999 })
      )
    );
  });

  it('create: currency cannot be injected', async () => {
    await assertFails(
      tripDoc(asOwner(), 'new-trip').set(
        validTripData({ currency: 'EUR' })
      )
    );
  });

  it('create: an arbitrary extra field is rejected', async () => {
    await assertFails(
      tripDoc(asOwner(), 'new-trip').set(
        validTripData({ notes: 'hi' })
      )
    );
  });
});

describe('firestore.rules: trips - owner updates', () => {
  beforeEach(async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
  });

  it('owner: can update title', async () => {
    await assertSucceeds(tripDoc(asOwner(), TRIP_ID).update({ title: 'Renamed Trip' }));
  });

  it('owner: can update location', async () => {
    await assertSucceeds(tripDoc(asOwner(), TRIP_ID).update({ location: 'New Place' }));
  });

  it('owner: can update target', async () => {
    await assertSucceeds(tripDoc(asOwner(), TRIP_ID).update({ target: 2000 }));
  });

  // Milestone 2B Checkpoint 4H: existing-Trip saved is now backend-managed
  // only (see recordSavingsTransaction) - the owner can no longer mutate
  // it via a direct client update. Mirrors the Bucket balance lockdown
  // (Checkpoint 4E) exactly.
  it('owner: cannot directly change saved', async () => {
    await assertFails(tripDoc(asOwner(), TRIP_ID).update({ saved: 250 }));
  });

  it('owner: cannot delete saved', async () => {
    await assertFails(
      tripDoc(asOwner(), TRIP_ID).update({ saved: deleteField() })
    );
  });

  it('owner: cannot add ledgerBalanceMinor when absent', async () => {
    await assertFails(
      tripDoc(asOwner(), TRIP_ID).update({ ledgerBalanceMinor: 5000 })
    );
  });

  it('owner: cannot change ledgerBalanceMinor when already present', async () => {
    await seedTrip(
      testEnv,
      TRIP_ID,
      validTripData({ ledgerBalanceMinor: 5000, ledgerOpeningBalanceMinor: 5000 })
    );
    await assertFails(
      tripDoc(asOwner(), TRIP_ID).update({ ledgerBalanceMinor: 9999 })
    );
  });

  it('owner: cannot delete ledgerBalanceMinor when present', async () => {
    await seedTrip(
      testEnv,
      TRIP_ID,
      validTripData({ ledgerBalanceMinor: 5000, ledgerOpeningBalanceMinor: 5000 })
    );
    await assertFails(
      tripDoc(asOwner(), TRIP_ID).update({ ledgerBalanceMinor: deleteField() })
    );
  });

  it('owner: cannot add ledgerOpeningBalanceMinor when absent', async () => {
    await assertFails(
      tripDoc(asOwner(), TRIP_ID).update({ ledgerOpeningBalanceMinor: 5000 })
    );
  });

  it('owner: cannot change ledgerOpeningBalanceMinor when already present', async () => {
    await seedTrip(
      testEnv,
      TRIP_ID,
      validTripData({ ledgerBalanceMinor: 5000, ledgerOpeningBalanceMinor: 5000 })
    );
    await assertFails(
      tripDoc(asOwner(), TRIP_ID).update({ ledgerOpeningBalanceMinor: 9999 })
    );
  });

  it('owner: cannot delete ledgerOpeningBalanceMinor when present', async () => {
    await seedTrip(
      testEnv,
      TRIP_ID,
      validTripData({ ledgerBalanceMinor: 5000, ledgerOpeningBalanceMinor: 5000 })
    );
    await assertFails(
      tripDoc(asOwner(), TRIP_ID).update({ ledgerOpeningBalanceMinor: deleteField() })
    );
  });

  it('owner: can update imageUrl', async () => {
    await assertSucceeds(
      tripDoc(asOwner(), TRIP_ID).update({ imageUrl: 'https://example.com/new.jpg' })
    );
  });

  it('owner: can update memberIds while keeping themselves included', async () => {
    await assertSucceeds(
      tripDoc(asOwner(), TRIP_ID).update({ memberIds: [OWNER_UID, MEMBER_UID, OUTSIDER_UID] })
    );
  });

  it('owner: can update lastUpdatedAt and lastUpdatedBy', async () => {
    await assertSucceeds(
      tripDoc(asOwner(), TRIP_ID).update({
        lastUpdatedAt: new Date(),
        lastUpdatedBy: OWNER_UID,
      })
    );
  });

  it('owner: cannot change ownerId', async () => {
    await assertFails(tripDoc(asOwner(), TRIP_ID).update({ ownerId: MEMBER_UID }));
  });

  it('owner: cannot remove themselves from memberIds', async () => {
    await assertFails(tripDoc(asOwner(), TRIP_ID).update({ memberIds: [MEMBER_UID] }));
  });

  it('owner: cannot add arbitrary fields not in the allowlist', async () => {
    await assertFails(tripDoc(asOwner(), TRIP_ID).update({ notes: 'not allowed' }));
  });

  it('owner: cannot write an invalid field type (saved)', async () => {
    await assertFails(tripDoc(asOwner(), TRIP_ID).update({ saved: 'lots' }));
  });

  // Documents current behavior, not a required security assertion: unlike
  // create, the update rule does not re-check `location`'s type (only
  // title/target/saved/imageUrl/memberIds are unconditionally type-checked
  // on update). See the checkpoint report for this observation.
  it('owner: location type is not re-validated on update (documents current rule behavior)', async () => {
    await assertSucceeds(tripDoc(asOwner(), TRIP_ID).update({ location: 12345 }));
  });
});

describe('firestore.rules: trips - non-owner member updates', () => {
  beforeEach(async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
  });

  it('member: can update title (in the non-owner allowlist)', async () => {
    await assertSucceeds(tripDoc(asMember(), TRIP_ID).update({ title: 'Member Renamed' }));
  });

  it('member: can update location (in the non-owner allowlist)', async () => {
    await assertSucceeds(tripDoc(asMember(), TRIP_ID).update({ location: 'Member Place' }));
  });

  it('member: can update imageUrl (in the non-owner allowlist)', async () => {
    await assertSucceeds(
      tripDoc(asMember(), TRIP_ID).update({ imageUrl: 'https://example.com/member.jpg' })
    );
  });

  it('member: can update lastUpdatedAt and lastUpdatedBy (in the non-owner allowlist)', async () => {
    await assertSucceeds(
      tripDoc(asMember(), TRIP_ID).update({
        lastUpdatedAt: new Date(),
        lastUpdatedBy: MEMBER_UID,
      })
    );
  });

  it('member: cannot change target', async () => {
    await assertFails(tripDoc(asMember(), TRIP_ID).update({ target: 9999 }));
  });

  it('member: cannot change saved', async () => {
    await assertFails(tripDoc(asMember(), TRIP_ID).update({ saved: 9999 }));
  });

  it('member: cannot add/change ledgerBalanceMinor', async () => {
    await assertFails(
      tripDoc(asMember(), TRIP_ID).update({ ledgerBalanceMinor: 5000 })
    );
  });

  it('member: cannot add/change ledgerOpeningBalanceMinor', async () => {
    await assertFails(
      tripDoc(asMember(), TRIP_ID).update({ ledgerOpeningBalanceMinor: 5000 })
    );
  });

  it('member: cannot change ownerId', async () => {
    await assertFails(tripDoc(asMember(), TRIP_ID).update({ ownerId: MEMBER_UID }));
  });

  it('member: cannot change memberIds', async () => {
    await assertFails(
      tripDoc(asMember(), TRIP_ID).update({ memberIds: [OWNER_UID, MEMBER_UID, OUTSIDER_UID] })
    );
  });

  it('member: cannot add arbitrary fields not in the allowlist', async () => {
    await assertFails(tripDoc(asMember(), TRIP_ID).update({ notes: 'not allowed' }));
  });

  it('member: cannot write an invalid field type (title)', async () => {
    await assertFails(tripDoc(asMember(), TRIP_ID).update({ title: 456 }));
  });
});

describe('firestore.rules: trips - outsider and unauthenticated updates', () => {
  beforeEach(async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
  });

  it('outsider: cannot update the trip', async () => {
    await assertFails(tripDoc(asOutsider(), TRIP_ID).update({ title: 'Hijacked' }));
  });

  it('unauthenticated user: cannot update the trip', async () => {
    await assertFails(tripDoc(asUnauthenticated(), TRIP_ID).update({ title: 'Hijacked' }));
  });
});

describe('firestore.rules: trips - deletes', () => {
  beforeEach(async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
  });

  it('owner: can delete the trip', async () => {
    await assertSucceeds(tripDoc(asOwner(), TRIP_ID).delete());
  });

  it('non-owner member: cannot delete the trip', async () => {
    await assertFails(tripDoc(asMember(), TRIP_ID).delete());
  });

  it('outsider: cannot delete the trip', async () => {
    await assertFails(tripDoc(asOutsider(), TRIP_ID).delete());
  });

  it('unauthenticated user: cannot delete the trip', async () => {
    await assertFails(tripDoc(asUnauthenticated(), TRIP_ID).delete());
  });
});
