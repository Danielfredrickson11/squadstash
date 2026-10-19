// Comprehensive Firestore rules coverage for the `trips` collection,
// run against the local Firestore emulator using the real firestore.rules
// file (never weakened to make a test pass - see helpers/trips.js).
const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { deleteField, serverTimestamp, Timestamp } = require('firebase/firestore');
const { createTestEnv } = require('./helpers/testEnv');
const {
  OWNER_UID,
  MEMBER_UID,
  OUTSIDER_UID,
  TRIP_ID,
  validTripData,
  validNativeTripData,
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

// Checkpoint 5B.5D: direct client Trip creation is now permanently
// closed (`allow create: if false` in firestore.rules, no exception for
// any role or payload shape - the trusted createTrip Cloud Function,
// which bypasses these rules via the Admin SDK, is the sole creation
// path). The old large "some direct creates succeed" suite this
// replaced is obsolete by construction - its premise (a client-facing
// create allowlist worth type/shape-testing field-by-field) no longer
// exists. This suite instead proves the actual security boundary:
// unconditional denial, regardless of actor, payload shape, or how
// closely a forged payload mimics either the legacy or the native
// trusted backend shape.
describe('firestore.rules: trips - create (Checkpoint 5B.5D: permanently closed)', () => {
  it('A. authenticated owner cannot directly create a valid legacy-shaped Trip', async () => {
    await assertFails(
      tripDoc(asOwner(), 'new-trip').set(validTripData())
    );
  });

  it('B. unauthenticated client cannot create a Trip', async () => {
    await assertFails(
      tripDoc(asUnauthenticated(), 'new-trip').set(validTripData())
    );
  });

  it('C. authenticated client cannot directly create a perfectly-shaped native ownership-ready Trip', async () => {
    await assertFails(
      tripDoc(asOwner(), 'new-trip').set(validNativeTripData())
    );
  });

  it('D1. a forged ownerId does not create an escape hatch', async () => {
    await assertFails(
      tripDoc(asOwner(), 'new-trip').set(
        validTripData({ ownerId: OUTSIDER_UID })
      )
    );
  });

  it('D2. an extra/unexpected field does not create an escape hatch', async () => {
    await assertFails(
      tripDoc(asOwner(), 'new-trip').set(validTripData({ notes: 'hi' }))
    );
  });

  it('D3. an otherwise-malformed/incomplete request still fails (not merely shape-rejected)', async () => {
    await assertFails(
      tripDoc(asOwner(), 'new-trip').set({ title: 'Incomplete' })
    );
  });

  it('D4. a non-owner member cannot create a Trip on someone else\'s behalf either', async () => {
    await assertFails(
      tripDoc(asMember(), 'new-trip').set(validTripData())
    );
  });

  it('D5. an outsider cannot create a Trip', async () => {
    await assertFails(
      tripDoc(asOutsider(), 'new-trip').set(validTripData())
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

  // Checkpoint 5C.2 (frozen docs/audits/
  // TRIP_FINANCIAL_MEMBERSHIP_ACCEPTANCE_PREFLIGHT_2026-10-16.md §18 item
  // 1): this test used to assert the OPPOSITE - that the owner COULD
  // directly add a uid to memberIds. That direct-mutation path is now
  // permanently closed; the trusted acceptTripInvitation Cloud Function
  // is the only path that may add a member. This is an intentional
  // reversal, not a weakening - see also "owner: cannot directly remove
  // an existing member from memberIds" below.
  it('owner: cannot directly add a new uid to memberIds', async () => {
    await assertFails(
      tripDoc(asOwner(), TRIP_ID).update({ memberIds: [OWNER_UID, MEMBER_UID, OUTSIDER_UID] })
    );
  });

  // Checkpoint 5C.2: removing an EXISTING member (as opposed to removing
  // the owner themselves, already covered below) must also be closed -
  // §5/§15 of the preflight requires addition and removal to close
  // together, with trusted removal deferred to a future checkpoint.
  it('owner: cannot directly remove an existing member from memberIds', async () => {
    await assertFails(
      tripDoc(asOwner(), TRIP_ID).update({ memberIds: [OWNER_UID] })
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

  // Checkpoint 3F.3B.3: the Trip Detail date-edit flow is now real -
  // tripStartDate/tripEndDate join the owner-only update allowlist.
  describe('trip date edits (Checkpoint 3F.3B.3)', () => {
    it('owner: can change tripStartDate to a new valid canonical date', async () => {
      // A different value than the seeded default's tripStartDate
      // ('2027-06-12') - otherwise the write is a same-value no-op with
      // an empty diff, which would trivially (and unhelpfully) pass.
      await assertSucceeds(
        tripDoc(asOwner(), TRIP_ID).update({ tripStartDate: '2028-01-01' })
      );
    });

    it('owner: can add tripEndDate on/after the existing tripStartDate', async () => {
      await assertSucceeds(
        tripDoc(asOwner(), TRIP_ID).update({ tripEndDate: '2027-06-18' })
      );
    });

    it('owner: can update both dates together', async () => {
      await assertSucceeds(
        tripDoc(asOwner(), TRIP_ID).update({
          tripStartDate: '2028-03-01',
          tripEndDate: '2028-03-10',
        })
      );
    });

    it('owner: can clear an existing tripEndDate back to null', async () => {
      await seedTrip(
        testEnv,
        TRIP_ID,
        validTripData({ tripStartDate: '2027-06-12', tripEndDate: '2027-06-18' })
      );
      await assertSucceeds(
        tripDoc(asOwner(), TRIP_ID).update({ tripEndDate: null })
      );
    });

    it('owner: cannot set tripStartDate to a locale-formatted string', async () => {
      await assertFails(
        tripDoc(asOwner(), TRIP_ID).update({ tripStartDate: '01/01/2028' })
      );
    });

    it('owner: cannot set tripStartDate to an invalid type', async () => {
      await assertFails(
        tripDoc(asOwner(), TRIP_ID).update({ tripStartDate: 20280101 })
      );
    });

    it('owner: cannot set tripEndDate before the resulting tripStartDate', async () => {
      await assertFails(
        tripDoc(asOwner(), TRIP_ID).update({
          tripStartDate: '2028-06-12',
          tripEndDate: '2028-06-01',
        })
      );
    });

    it('owner: cannot set tripEndDate before the ALREADY-STORED tripStartDate when only changing tripEndDate', async () => {
      // Seeded tripStartDate is '2027-06-12' - an end date before it must
      // still be rejected even though this update doesn't touch start.
      await assertFails(
        tripDoc(asOwner(), TRIP_ID).update({ tripEndDate: '2027-01-01' })
      );
    });

    it('owner: cannot clear tripStartDate to null (a dated trip cannot revert to dateless)', async () => {
      await assertFails(
        tripDoc(asOwner(), TRIP_ID).update({ tripStartDate: null })
      );
    });

    // Member-side date-immutability assertions live in the "non-owner
    // member updates" describe below, alongside every other field's
    // equivalent coverage.

    it('unrelated owner update (title rename) on a trip with existing dates leaves them intact and still succeeds', async () => {
      await assertSucceeds(
        tripDoc(asOwner(), TRIP_ID).update({ title: 'Renamed Trip With Dates' })
      );
    });

    it('unrelated owner update on a legacy trip with NO dates at all still succeeds without requiring dates', async () => {
      const { tripStartDate, ...legacyTrip } = validTripData();
      await seedTrip(testEnv, TRIP_ID, legacyTrip);
      await assertSucceeds(tripDoc(asOwner(), TRIP_ID).update({ title: 'Legacy Renamed' }));
    });
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

  // Checkpoint 3F.3B.3: tripStartDate/tripEndDate joined the OWNER-only
  // update allowlist (the Trip Detail date-edit flow is owner-only) -
  // a member still cannot touch either, exactly like target/ownerId.
  it('member: cannot change tripStartDate', async () => {
    // A different value than the seeded default's tripStartDate
    // ('2027-06-12') - otherwise the write is a same-value no-op with an
    // empty diff, which would trivially (and incorrectly) pass.
    await assertFails(
      tripDoc(asMember(), TRIP_ID).update({ tripStartDate: '2028-01-01' })
    );
  });

  it('member: cannot change tripEndDate', async () => {
    await assertFails(
      tripDoc(asMember(), TRIP_ID).update({ tripEndDate: '2027-06-18' })
    );
  });

  it('member: cannot write an invalid field type (title)', async () => {
    await assertFails(tripDoc(asMember(), TRIP_ID).update({ title: 456 }));
  });
});

describe('firestore.rules: trips - outsider and unauthenticated updates', () => {
  beforeEach(async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
  });

  // Checkpoint 5C.2: an outsider was already blocked from updating the
  // Trip at all (the test immediately below), but memberIds closure is
  // an independent allowlist check - this makes the "outsider cannot
  // alter memberIds either" assertion explicit rather than implicit.
  it('outsider: cannot alter memberIds', async () => {
    await assertFails(
      tripDoc(asOutsider(), TRIP_ID).update({
        memberIds: [OWNER_UID, MEMBER_UID, OUTSIDER_UID],
      })
    );
  });

  it('outsider: cannot update the trip', async () => {
    await assertFails(tripDoc(asOutsider(), TRIP_ID).update({ title: 'Hijacked' }));
  });

  it('unauthenticated user: cannot update the trip', async () => {
    await assertFails(tripDoc(asUnauthenticated(), TRIP_ID).update({ title: 'Hijacked' }));
  });
});

// Checkpoint 4B.5B: hard-delete is now permanently closed for every actor,
// including the former owner-can-delete permission this block used to
// assert - per the approved archive-delete-safety preflight, "Delete
// Trip" is archiving instead (see the new archive-lifecycle describe
// block below). This block keeps its original name/shape (all four
// actors, one `.delete()` each) so the "nobody can hard-delete, not even
// the owner" regression stays a single obvious diff from the pre-4B.5B
// version rather than a rewrite.
describe('firestore.rules: trips - deletes (hard delete permanently closed)', () => {
  beforeEach(async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
  });

  it('owner: can no longer hard-delete the trip', async () => {
    await assertFails(tripDoc(asOwner(), TRIP_ID).delete());
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

// Checkpoint 4B.5B: the archive transition itself, per the approved
// docs/audits/TRIP_ARCHIVE_DELETE_SAFETY_PREFLIGHT_2026-09-13.md (as
// hardened by its 4B.5A.1 amendment) and firestore.rules'
// tripIsActive()/archive-transition `allow update` clause.
describe('firestore.rules: trips - archive lifecycle', () => {
  beforeEach(async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
  });

  function validArchiveUpdate(overrides = {}) {
    return {
      archivedAt: serverTimestamp(),
      archivedBy: OWNER_UID,
      ...overrides,
    };
  }

  it('owner: can archive an active trip', async () => {
    await assertSucceeds(tripDoc(asOwner(), TRIP_ID).update(validArchiveUpdate()));
  });

  it('non-owner member: cannot archive the trip', async () => {
    await assertFails(
      tripDoc(asMember(), TRIP_ID).update(validArchiveUpdate({ archivedBy: MEMBER_UID }))
    );
  });

  it('outsider: cannot archive the trip', async () => {
    await assertFails(
      tripDoc(asOutsider(), TRIP_ID).update(validArchiveUpdate({ archivedBy: OUTSIDER_UID }))
    );
  });

  it('unauthenticated user: cannot archive the trip', async () => {
    await assertFails(tripDoc(asUnauthenticated(), TRIP_ID).update(validArchiveUpdate()));
  });

  it('owner: cannot forge archivedBy as someone else', async () => {
    await assertFails(
      tripDoc(asOwner(), TRIP_ID).update(validArchiveUpdate({ archivedBy: MEMBER_UID }))
    );
  });

  it('owner: cannot set an arbitrary archivedAt timestamp instead of the server time', async () => {
    await assertFails(
      tripDoc(asOwner(), TRIP_ID).update(
        validArchiveUpdate({ archivedAt: Timestamp.fromDate(new Date('2020-01-01')) })
      )
    );
  });

  it('owner: archiving cannot be combined with any other field change in the same write', async () => {
    await assertFails(
      tripDoc(asOwner(), TRIP_ID).update(validArchiveUpdate({ title: 'Sneaky rename' }))
    );
  });

  describe('once already archived', () => {
    beforeEach(async () => {
      await seedTrip(
        testEnv,
        TRIP_ID,
        validTripData({ archivedAt: Timestamp.now(), archivedBy: OWNER_UID })
      );
    });

    it('owner: cannot archive an already-archived trip again', async () => {
      await assertFails(tripDoc(asOwner(), TRIP_ID).update(validArchiveUpdate()));
    });

    it('owner: cannot remove archivedAt once archived', async () => {
      await assertFails(
        tripDoc(asOwner(), TRIP_ID).update({ archivedAt: deleteField() })
      );
    });

    it('owner: cannot change archivedBy once archived', async () => {
      await assertFails(
        tripDoc(asOwner(), TRIP_ID).update({ archivedBy: MEMBER_UID })
      );
    });

    it('owner: cannot update title on an archived trip', async () => {
      await assertFails(tripDoc(asOwner(), TRIP_ID).update({ title: 'Renamed' }));
    });

    it('owner: cannot update trip dates on an archived trip', async () => {
      await assertFails(
        tripDoc(asOwner(), TRIP_ID).update({ tripStartDate: '2028-01-01' })
      );
    });

    it('owner: cannot update memberIds on an archived trip', async () => {
      await assertFails(
        tripDoc(asOwner(), TRIP_ID).update({ memberIds: [OWNER_UID, MEMBER_UID, OUTSIDER_UID] })
      );
    });

    it('non-owner member: cannot update an archived trip either', async () => {
      await assertFails(tripDoc(asMember(), TRIP_ID).update({ location: 'New Place' }));
    });
  });

  describe('legacy trip with no archivedAt key at all', () => {
    beforeEach(async () => {
      // withoutLocation-style: seedTrip/validTripData already omit
      // archivedAt/archivedBy entirely by default (validTripData has no
      // such keys) - this describe block exists just to make that
      // legacy-document assumption explicit and independently verified,
      // matching the missing-safe tripIsActive() `.get('archivedAt', null)`
      // check in firestore.rules.
      await seedTrip(testEnv, TRIP_ID, validTripData());
    });

    it('a legacy trip with no archivedAt key can still be updated normally', async () => {
      await assertSucceeds(tripDoc(asOwner(), TRIP_ID).update({ title: 'Still active' }));
    });

    it('a legacy trip with no archivedAt key can be archived', async () => {
      await assertSucceeds(tripDoc(asOwner(), TRIP_ID).update(validArchiveUpdate()));
    });
  });
});

// Checkpoint 5B.1: ownershipModelState/ownershipModelVersion are
// backend-only fields (docs/audits/
// TRIP_WALLET_OWNERSHIP_WITHDRAWAL_PREFLIGHT_2026-10-08.md §12A). No new
// Rules clause was added to block them - the existing create/update
// allowlists are already exhaustive `keys().hasOnly(...)`/
// `affectedKeys().hasOnly(...)` lists, so any write touching either
// field already fails the whole rule. These tests PROVE that, rather
// than merely relying on it.
describe('firestore.rules: trips - ownership-model-state fields are backend-only', () => {
  beforeEach(async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
  });

  it('owner cannot set ownershipModelState via an ordinary update', async () => {
    await assertFails(
      tripDoc(asOwner(), TRIP_ID).update({ ownershipModelState: 'initialized' })
    );
  });

  it('owner cannot set ownershipModelVersion via an ordinary update', async () => {
    await assertFails(tripDoc(asOwner(), TRIP_ID).update({ ownershipModelVersion: 1 }));
  });

  it('non-owner member cannot set ownershipModelState', async () => {
    await assertFails(
      tripDoc(asMember(), TRIP_ID).update({ ownershipModelState: 'initialized' })
    );
  });

  it('non-owner member cannot set ownershipModelVersion', async () => {
    await assertFails(tripDoc(asMember(), TRIP_ID).update({ ownershipModelVersion: 1 }));
  });

  it('owner cannot set ownershipModelState even when combined with an otherwise-legitimate field change', async () => {
    await assertFails(
      tripDoc(asOwner(), TRIP_ID).update({
        title: 'Sneaky Rename',
        ownershipModelState: 'initialized',
      })
    );
  });

  it('a client cannot create a new Trip with ownershipModelState already set', async () => {
    await assertFails(
      tripDoc(asOwner(), 'new-trip-with-ownership').set(
        validTripData({ ownershipModelState: 'initialized', ownershipModelVersion: 1 })
      )
    );
  });

  // Checkpoint 5B.5D, item 4: seeded with the FULL canonical native shape
  // (validNativeTripData - every backend-only field together: ledger/
  // currency/ownership-model/creationRequest), not just the two ownership
  // fields the rest of this describe block otherwise tests in isolation.
  // Proves closing CREATE did not accidentally break legitimate client
  // behavior on an already-existing native Trip, and that every
  // backend-only field on the REAL native shape (not just ownership
  // state/version) remains client-immutable on update.
  describe('on a native initialized Trip the trusted createTrip backend has already created', () => {
    beforeEach(async () => {
      await seedTrip(testEnv, TRIP_ID, validNativeTripData());
    });

    it('owner can read the Trip', async () => {
      await assertSucceeds(tripDoc(asOwner(), TRIP_ID).get());
    });

    it('a member included in memberIds can read the Trip', async () => {
      await assertSucceeds(tripDoc(asMember(), TRIP_ID).get());
    });

    it('an outsider still cannot read the Trip', async () => {
      await assertFails(tripDoc(asOutsider(), TRIP_ID).get());
    });

    it('owner can perform an ordinary allowed metadata update (title)', async () => {
      await assertSucceeds(tripDoc(asOwner(), TRIP_ID).update({ title: 'Renamed Trip' }));
    });

    it('owner can perform the existing allowed date update (tripStartDate)', async () => {
      await assertSucceeds(
        tripDoc(asOwner(), TRIP_ID).update({ tripStartDate: '2028-02-02' })
      );
    });

    it('owner can archive the Trip through the existing archive transition', async () => {
      await assertSucceeds(
        tripDoc(asOwner(), TRIP_ID).update({
          archivedAt: serverTimestamp(),
          archivedBy: OWNER_UID,
        })
      );
    });

    it('owner cannot remove the backend-set ownershipModelState', async () => {
      await assertFails(
        tripDoc(asOwner(), TRIP_ID).update({ ownershipModelState: deleteField() })
      );
    });

    it('owner cannot remove the backend-set ownershipModelVersion', async () => {
      await assertFails(
        tripDoc(asOwner(), TRIP_ID).update({ ownershipModelVersion: deleteField() })
      );
    });

    it('owner cannot change the backend-set ownershipModelState to a different value', async () => {
      await assertFails(
        tripDoc(asOwner(), TRIP_ID).update({ ownershipModelState: 'needs_reconciliation' })
      );
    });

    it('owner cannot change ledgerBalanceMinor on the native Trip', async () => {
      await assertFails(
        tripDoc(asOwner(), TRIP_ID).update({ ledgerBalanceMinor: 99999 })
      );
    });

    it('owner cannot change creationRequest on the native Trip', async () => {
      await assertFails(
        tripDoc(asOwner(), TRIP_ID).update({
          creationRequest: { clientRequestId: 'forged' },
        })
      );
    });

    it('owner cannot remove creationRequest on the native Trip', async () => {
      await assertFails(
        tripDoc(asOwner(), TRIP_ID).update({ creationRequest: deleteField() })
      );
    });

    it('an unrelated, otherwise-legitimate Trip update still succeeds unchanged', async () => {
      await assertSucceeds(tripDoc(asOwner(), TRIP_ID).update({ title: 'Renamed Trip' }));
    });

    it('a non-owner member\'s otherwise-legitimate update still succeeds unchanged', async () => {
      await assertSucceeds(tripDoc(asMember(), TRIP_ID).update({ location: 'New Place' }));
    });

    it('the Trip remains archivable normally, ownership fields untouched by that transition', async () => {
      await assertSucceeds(
        tripDoc(asOwner(), TRIP_ID).update({
          archivedAt: serverTimestamp(),
          archivedBy: OWNER_UID,
        })
      );
    });
  });
});
