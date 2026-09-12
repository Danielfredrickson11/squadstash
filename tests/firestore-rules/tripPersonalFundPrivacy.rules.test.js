// Checkpoint 3F.3B.4: cross-collection privacy coverage for a
// trip_personal Bucket ("My Stash") - a dedicated file (rather than
// folding into trips.rules.test.js or buckets.rules.test.js) since these
// scenarios inherently span BOTH collections at once (a Trip and a
// Bucket linked to it, read by different actors relative to each).
//
// The core assertion firestore.rules already makes (unchanged by this
// checkpoint - see buckets' "allow list, get" rule): a Bucket's read/
// write access is governed SOLELY by that Bucket's own ownerId/
// memberIds, never by anything about a Trip it happens to be
// linkedTripId-linked to. Owning or being a member of the linked Trip
// grants NO special visibility into another member's trip_personal fund.
const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { createTestEnv } = require('./helpers/testEnv');
const {
  OWNER_UID: TRIP_OWNER_UID,
  MEMBER_UID: TRIP_MEMBER_UID,
  TRIP_ID,
  validTripData,
  seedTrip,
} = require('./helpers/trips');
const {
  OUTSIDER_UID,
  validBucketData,
  seedBucket,
  bucketDoc,
  bucketsCollection,
} = require('./helpers/buckets');

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

function asTripOwner() {
  return testEnv.authenticatedContext(TRIP_OWNER_UID);
}
function asTripMember() {
  return testEnv.authenticatedContext(TRIP_MEMBER_UID);
}
function asOutsider() {
  return testEnv.authenticatedContext(OUTSIDER_UID);
}

// A trip_personal Bucket "owned" by the Trip's own MEMBER_UID (not its
// owner) - the realistic shape createBucketCore produces: memberIds is
// self-only, regardless of how many members the linked Trip has.
function tripPersonalBucketData(overrides = {}) {
  return validBucketData({
    ownerId: TRIP_MEMBER_UID,
    memberIds: [TRIP_MEMBER_UID],
    name: 'Canada Trip — My Stash',
    bucketType: 'trip_personal',
    linkedTripId: TRIP_ID,
    ...overrides,
  });
}

describe('firestore.rules: trip_personal fund privacy', () => {
  const FUND_ID = 'tripfund_canada-trip_member-uid';

  beforeEach(async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
    await seedBucket(testEnv, FUND_ID, tripPersonalBucketData());
  });

  it("the fund's own owner (a Trip member, not the Trip owner) can read it", async () => {
    await assertSucceeds(bucketDoc(asTripMember(), FUND_ID).get());
  });

  it('the Trip OWNER cannot read another member\'s trip_personal fund merely by owning the linked Trip', async () => {
    await assertFails(bucketDoc(asTripOwner(), FUND_ID).get());
  });

  it('a total outsider (not even a Trip member) cannot read the fund', async () => {
    await assertFails(bucketDoc(asOutsider(), FUND_ID).get());
  });

  it('the Trip owner cannot list/query their way to another member\'s trip_personal fund', async () => {
    await assertFails(
      bucketsCollection(asTripOwner())
        .where('linkedTripId', '==', TRIP_ID)
        .get()
    );
  });

  it('the Trip owner cannot update another member\'s trip_personal fund', async () => {
    await assertFails(
      bucketDoc(asTripOwner(), FUND_ID).update({ name: 'Hijacked' })
    );
  });

  it('the Trip owner cannot delete another member\'s trip_personal fund', async () => {
    await assertFails(bucketDoc(asTripOwner(), FUND_ID).delete());
  });
});

describe('firestore.rules: bucketType/linkedTripId cannot be forged by direct client write', () => {
  it('direct client create is denied entirely (bucketType/linkedTripId or otherwise) - the trusted callable is the only path', async () => {
    await assertFails(
      bucketDoc(asTripMember(), 'new-trip-fund').set(tripPersonalBucketData())
    );
  });

  it("the fund's own owner cannot add bucketType via update", async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
    await seedBucket(testEnv, 'plain-bucket', validBucketData({
      ownerId: TRIP_MEMBER_UID,
      memberIds: [TRIP_MEMBER_UID],
    }));
    await assertFails(
      bucketDoc(asTripMember(), 'plain-bucket').update({ bucketType: 'trip_personal' })
    );
  });

  it("the fund's own owner cannot add linkedTripId via update", async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
    await seedBucket(testEnv, 'plain-bucket', validBucketData({
      ownerId: TRIP_MEMBER_UID,
      memberIds: [TRIP_MEMBER_UID],
    }));
    await assertFails(
      bucketDoc(asTripMember(), 'plain-bucket').update({ linkedTripId: TRIP_ID })
    );
  });

  it('an existing trip_personal fund\'s own owner cannot change its linkedTripId via update', async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
    await seedBucket(testEnv, 'tripfund_x', tripPersonalBucketData());
    await assertFails(
      bucketDoc(asTripMember(), 'tripfund_x').update({ linkedTripId: 'a-different-trip' })
    );
  });

  it('an existing trip_personal fund\'s own owner cannot change its bucketType back to personal via update', async () => {
    await seedTrip(testEnv, TRIP_ID, validTripData());
    await seedBucket(testEnv, 'tripfund_x', tripPersonalBucketData());
    await assertFails(
      bucketDoc(asTripMember(), 'tripfund_x').update({ bucketType: 'personal' })
    );
  });
});
