// Concurrent same-URL integration test — verifies the race condition the
// Codex review flagged: two clients posting the same URL near-simultaneously
// must converge on one pin doc, one trip-signal increment, and one
// pushDelivery per job.

jest.mock('expo-server-sdk', () => ({
  Expo: class {
    static isExpoPushToken() { return true; }
    chunkPushNotifications() { return []; }
    sendPushNotificationsAsync() { return Promise.resolve([{ status: 'ok', id: 'tk' }]); }
  },
}));

jest.mock('../lib/firestore', () => {
  const { getSharedFirestore, makeAdmin } = require('./helpers/fakeFirestore');
  return { firestore: getSharedFirestore(), admin: makeAdmin() };
});

const { getSharedFirestore, FakeTimestamp } = require('./helpers/fakeFirestore');
const {
  writePinTransactional,
  recordTripSignalSaveIfNew,
} = require('../enrich');
const { sendPushForJob } = require('../lib/push');

const fs = getSharedFirestore();

const SHARED_URL = 'https://www.tiktok.com/@maker/video/12345';
const PLACE_ID = 'ChIJ_test_place';
const USER_ID = 'u_concurrent';

const basePin = () => ({
  userId: USER_ID,
  url: SHARED_URL,
  placeName: 'Café Nowhere',
  placeId: PLACE_ID,
  ogTitle: 'A tasty post',
  ogImage: 'https://x/y.jpg',
  sourceApp: 'tiktok',
  sourceDomain: 'tiktok.com',
  category: 'cafe',
  tripSignalIdAtSave: 'u_concurrent_san-francisco_usa',
});

function seedJob(jobId) {
  fs.seed('enrichmentJobs', jobId, {
    status: 'processing',
    userId: USER_ID,
    url: SHARED_URL,
    createdAt: FakeTimestamp.fromMillis(Date.now() - 1_000),
    updatedAt: FakeTimestamp.fromMillis(Date.now() - 500),
  });
}

function seedUser() {
  fs.seed('users', USER_ID, { expoPushToken: 'ExponentPushToken[good]' });
}

beforeEach(() => fs.reset());

describe('concurrent same-URL enrichment', () => {
  test('two parallel writePinTransactional calls produce exactly one pin', async () => {
    const [r1, r2] = await Promise.all([
      writePinTransactional(basePin()),
      writePinTransactional(basePin()),
    ]);

    const winners = [r1, r2].filter((r) => !r.alreadyExists);
    const losers = [r1, r2].filter((r) => r.alreadyExists);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].pinId).toBe(winners[0].pinId);

    const pinsMap = fs.collections.get('pins');
    expect(pinsMap.size).toBe(1);
  });

  test('trip-signal aggregate increments exactly once (winner only)', async () => {
    fs.seed('tripSignals', 'u_concurrent_san-francisco_usa', {
      pinCount: 0,
      categories: [],
    });

    const [r1, r2] = await Promise.all([
      writePinTransactional(basePin()),
      writePinTransactional(basePin()),
    ]);
    seedJob('job-A');
    seedJob('job-B');

    await Promise.all([
      recordTripSignalSaveIfNew(basePin(), r1, 'job-A'),
      recordTripSignalSaveIfNew(basePin(), r2, 'job-B'),
    ]);

    const signal = fs.read('tripSignals', 'u_concurrent_san-francisco_usa');
    expect(signal.pinCount).toBe(1);
    expect(signal.categories).toEqual(['cafe']);
  });

  test('both jobs reach a terminal pushDelivery state (one sent, one sent for duplicate)', async () => {
    seedUser();
    seedJob('job-A');
    seedJob('job-B');

    const [r1, r2] = await Promise.all([
      writePinTransactional(basePin()),
      writePinTransactional(basePin()),
    ]);

    const jobAStatus = r1.alreadyExists ? 'duplicate' : 'complete';
    const jobBStatus = r2.alreadyExists ? 'duplicate' : 'complete';

    await Promise.all([
      sendPushForJob('job-A', USER_ID, jobAStatus, { placeName: 'Café Nowhere', pinId: r1.pinId }),
      sendPushForJob('job-B', USER_ID, jobBStatus, { placeName: 'Café Nowhere', pinId: r2.pinId }),
    ]);

    const a = fs.read('enrichmentJobs', 'job-A').pushDelivery;
    const b = fs.read('enrichmentJobs', 'job-B').pushDelivery;
    expect(a.status).toBe('sent');
    expect(b.status).toBe('sent');
    expect(a.attempts).toBe(1);
    expect(b.attempts).toBe(1);

    // Exactly one status is 'complete' across the two jobs.
    const statuses = [jobAStatus, jobBStatus].sort();
    expect(statuses).toEqual(['complete', 'duplicate']);
  });
});
