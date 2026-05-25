// Sweeper lifecycle tests — verifies the Fix 1 contract:
//   - jobs with fresh updatedAt are left alone
//   - jobs with stale updatedAt get marked failed + push fires
//   - terminal-state guard prevents overwriting a live-worker terminal write
//   - absolute-deadline backstop catches runaway-heartbeat jobs

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

const mockSendPush = jest.fn().mockResolvedValue();
jest.mock('../lib/push', () => ({
  sendPushForJob: (...args) => mockSendPush(...args),
}));

const { getSharedFirestore, FakeTimestamp } = require('./helpers/fakeFirestore');
const { sweep } = require('../lib/enrichmentSweeper');

const fs = getSharedFirestore();

beforeEach(() => {
  fs.reset();
  mockSendPush.mockClear();
});

describe('enrichmentSweeper.sweep', () => {
  // Anchor each test to real wall-clock time. The sweeper itself calls
  // Date.now() for its cutoffs, so seed timestamps need to be relative to
  // real time, not a frozen constant — otherwise everything looks stale.
  let NOW;
  beforeEach(() => {
    NOW = Date.now();
    fs.setNow(() => NOW);
  });

  test('skips jobs with a fresh updatedAt', async () => {
    fs.seed('enrichmentJobs', 'fresh', {
      status: 'processing',
      userId: 'u1',
      createdAt: FakeTimestamp.fromMillis(NOW - 60_000),
      updatedAt: FakeTimestamp.fromMillis(NOW - 30_000),
    });

    await sweep();

    expect(fs.read('enrichmentJobs', 'fresh').status).toBe('processing');
    expect(mockSendPush).not.toHaveBeenCalled();
  });

  test('marks failed when updatedAt is older than the heartbeat threshold', async () => {
    fs.seed('enrichmentJobs', 'stale', {
      status: 'processing',
      userId: 'u1',
      createdAt: FakeTimestamp.fromMillis(NOW - 5 * 60_000),
      updatedAt: FakeTimestamp.fromMillis(NOW - 3 * 60_000),
    });

    await sweep();

    const after = fs.read('enrichmentJobs', 'stale');
    expect(after.status).toBe('failed');
    expect(after.failureReason).toBe('timeout');
    expect(after.failureSource).toBe('sweeper');
    expect(mockSendPush).toHaveBeenCalledWith('stale', 'u1', 'failed');
  });

  test('terminal-state guard: leaves complete alone when status changed mid-transaction', async () => {
    fs.seed('enrichmentJobs', 'racing', {
      status: 'processing',
      userId: 'u1',
      createdAt: FakeTimestamp.fromMillis(NOW - 5 * 60_000),
      updatedAt: FakeTimestamp.fromMillis(NOW - 3 * 60_000),
    });

    // Simulates: between the sweeper's query and the txn.get, a live worker
    // finishes and writes 'complete'. The guard must NOT overwrite.
    fs.setTxnReadHook(async (ref) => {
      if (ref.id === 'racing') {
        await ref._setSync(
          { status: 'complete', completedAt: FakeTimestamp.fromMillis(NOW) },
          { merge: true }
        );
        fs.setTxnReadHook(null);
      }
    });

    await sweep();

    expect(fs.read('enrichmentJobs', 'racing').status).toBe('complete');
    expect(mockSendPush).not.toHaveBeenCalled();
  });

  test('absolute deadline backstop: createdAt > 30min still swept even if updatedAt is fresh', async () => {
    fs.seed('enrichmentJobs', 'runaway', {
      status: 'processing',
      userId: 'u1',
      createdAt: FakeTimestamp.fromMillis(NOW - 35 * 60_000),
      updatedAt: FakeTimestamp.fromMillis(NOW - 30_000),
    });

    await sweep();

    const after = fs.read('enrichmentJobs', 'runaway');
    expect(after.status).toBe('failed');
    expect(after.failureSource).toBe('sweeper');
    expect(mockSendPush).toHaveBeenCalledWith('runaway', 'u1', 'failed');
  });

  test('does not push when userId is missing', async () => {
    fs.seed('enrichmentJobs', 'no-user', {
      status: 'processing',
      createdAt: FakeTimestamp.fromMillis(NOW - 5 * 60_000),
      updatedAt: FakeTimestamp.fromMillis(NOW - 3 * 60_000),
    });

    await sweep();

    expect(fs.read('enrichmentJobs', 'no-user').status).toBe('failed');
    expect(mockSendPush).not.toHaveBeenCalled();
  });
});
