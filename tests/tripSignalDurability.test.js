// Trip-signal aggregate durability tests — verifies the Fix 4 contract that
// recordTripSignalSaveIfNew now awaits the aggregate write and attributes
// failures to the job doc via stageFailures, eliminating the silent
// undercount that the old fire-and-forget pattern allowed.

jest.mock('expo-server-sdk', () => ({
  Expo: class {
    static isExpoPushToken() { return true; }
    chunkPushNotifications() { return []; }
    sendPushNotificationsAsync() { return Promise.resolve([]); }
  },
}));

jest.mock('../lib/firestore', () => {
  const { getSharedFirestore, makeAdmin } = require('./helpers/fakeFirestore');
  return { firestore: getSharedFirestore(), admin: makeAdmin() };
});

const { getSharedFirestore, FakeTimestamp } = require('./helpers/fakeFirestore');
const { recordTripSignalSaveIfNew } = require('../enrich');

const fs = getSharedFirestore();

function seedJob(jobId) {
  fs.seed('enrichmentJobs', jobId, {
    status: 'processing',
    userId: 'u1',
    createdAt: FakeTimestamp.fromMillis(Date.now() - 5_000),
    updatedAt: FakeTimestamp.fromMillis(Date.now() - 1_000),
  });
}

beforeEach(() => fs.reset());

describe('recordTripSignalSaveIfNew', () => {
  // Hard-coded ID — computeTripSignalId is positional (userId, city, country)
  // and irrelevant to the durability contract under test.
  const tripSignalId = 'u1_los-angeles_usa';
  const pin = { tripSignalIdAtSave: tripSignalId, category: 'restaurant' };
  const freshWrite = { pinId: 'p1', alreadyExists: false };

  test('writes the aggregate on success and does NOT add a stage failure', async () => {
    seedJob('job-success');
    fs.seed('tripSignals', tripSignalId, {
      pinCount: 5,
      categories: ['cafe'],
    });

    await recordTripSignalSaveIfNew(pin, freshWrite, 'job-success');

    const signal = fs.read('tripSignals', tripSignalId);
    expect(signal.pinCount).toBe(6);
    expect(signal.categories).toEqual(expect.arrayContaining(['cafe', 'restaurant']));

    expect(fs.read('enrichmentJobs', 'job-success').stageFailures).toBeUndefined();
  });

  test('attributes the failure to the job doc when the aggregate write throws', async () => {
    seedJob('job-fail');
    fs.setWriteFailure((col) =>
      col === 'tripSignals' ? new Error('simulated firestore failure') : null
    );

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await recordTripSignalSaveIfNew(pin, freshWrite, 'job-fail');
    warnSpy.mockRestore();

    const job = fs.read('enrichmentJobs', 'job-fail');
    expect(job.stageFailures).toHaveLength(1);
    expect(job.stageFailures[0]).toMatchObject({
      stage: 'trip_signal_aggregate',
      kind: 'dependency_error',
    });
    expect(job.stageFailures[0].message).toContain('simulated firestore failure');
  });

  test('skips when the pin write was a duplicate (no double-count)', async () => {
    seedJob('job-dup');
    fs.seed('tripSignals', tripSignalId, { pinCount: 5, categories: [] });

    await recordTripSignalSaveIfNew(pin, { pinId: 'p1', alreadyExists: true }, 'job-dup');

    expect(fs.read('tripSignals', tripSignalId).pinCount).toBe(5);
  });

  test('skips when the pin has no tripSignalIdAtSave', async () => {
    seedJob('job-no-signal');
    const pinWithoutSignal = { category: 'restaurant' };

    await recordTripSignalSaveIfNew(pinWithoutSignal, freshWrite, 'job-no-signal');

    expect(fs.read('tripSignals', tripSignalId)).toBeUndefined();
    expect(fs.read('enrichmentJobs', 'job-no-signal').stageFailures).toBeUndefined();
  });
});
