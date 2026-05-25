// Push delivery observability tests — verifies the Fix 2 contract that
// sendPushForJob persists pushDelivery telemetry on the job doc for every
// code path (sent, no_token, dispatch_failed, ticket_error) and that
// attempts increments monotonically across repeated calls.

const mockSendImpl = jest.fn();

jest.mock('expo-server-sdk', () => ({
  Expo: class {
    static isExpoPushToken(token) {
      return typeof token === 'string' && token.length > 0;
    }
    chunkPushNotifications() { return []; }
    sendPushNotificationsAsync(...args) { return mockSendImpl(...args); }
  },
}));

jest.mock('../lib/firestore', () => {
  const { getSharedFirestore, makeAdmin } = require('./helpers/fakeFirestore');
  return { firestore: getSharedFirestore(), admin: makeAdmin() };
});

const { getSharedFirestore, FakeTimestamp } = require('./helpers/fakeFirestore');
const { sendPushForJob } = require('../lib/push');

const fs = getSharedFirestore();

function seedJob(jobId, userId) {
  fs.seed('enrichmentJobs', jobId, {
    status: 'complete',
    userId,
    createdAt: FakeTimestamp.fromMillis(Date.now() - 60_000),
    updatedAt: FakeTimestamp.fromMillis(Date.now() - 5_000),
  });
}

function seedUserWithToken(userId, token) {
  fs.seed('users', userId, { expoPushToken: token });
}

function seedUserNoToken(userId) {
  fs.seed('users', userId, { someOtherField: true });
}

beforeEach(() => {
  fs.reset();
  mockSendImpl.mockReset();
});

describe('sendPushForJob — pushDelivery telemetry', () => {
  test('successful dispatch records status=sent and tokenPresent=true', async () => {
    seedJob('job-sent', 'u1');
    seedUserWithToken('u1', 'ExponentPushToken[abc]');
    mockSendImpl.mockResolvedValueOnce([{ status: 'ok', id: 'tk-1' }]);

    await sendPushForJob('job-sent', 'u1', 'complete', { placeName: 'Joe’s' });

    const pd = fs.read('enrichmentJobs', 'job-sent').pushDelivery;
    expect(pd.status).toBe('sent');
    expect(pd.tokenPresent).toBe(true);
    expect(pd.attempts).toBe(1);
    expect(pd.lastError).toBeNull();
    expect(pd.lastAttemptAt).toBeDefined();
  });

  test('missing token records status=no_token and tokenPresent=false (no push dispatched)', async () => {
    seedJob('job-no-token', 'u2');
    seedUserNoToken('u2');

    await sendPushForJob('job-no-token', 'u2', 'complete');

    const pd = fs.read('enrichmentJobs', 'job-no-token').pushDelivery;
    expect(pd.status).toBe('no_token');
    expect(pd.tokenPresent).toBe(false);
    expect(pd.attempts).toBe(1);
    expect(mockSendImpl).not.toHaveBeenCalled();
  });

  test('dispatch throw records status=dispatch_failed with error message', async () => {
    seedJob('job-throw', 'u3');
    seedUserWithToken('u3', 'ExponentPushToken[xyz]');
    mockSendImpl.mockRejectedValueOnce(new Error('connection refused'));

    // Silence the console.error from the catch so jest output stays clean.
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await sendPushForJob('job-throw', 'u3', 'failed');

    errSpy.mockRestore();

    const pd = fs.read('enrichmentJobs', 'job-throw').pushDelivery;
    expect(pd.status).toBe('dispatch_failed');
    expect(pd.tokenPresent).toBe(true);
    expect(pd.lastError).toContain('connection refused');
    expect(pd.attempts).toBe(1);
  });

  test('ticket-level error records status=ticket_error with detail', async () => {
    seedJob('job-ticket-err', 'u4');
    seedUserWithToken('u4', 'ExponentPushToken[dead]');
    mockSendImpl.mockResolvedValueOnce([
      { status: 'error', message: 'token unregistered', details: { error: 'DeviceNotRegistered' } },
    ]);

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await sendPushForJob('job-ticket-err', 'u4', 'duplicate');

    warnSpy.mockRestore();

    const pd = fs.read('enrichmentJobs', 'job-ticket-err').pushDelivery;
    expect(pd.status).toBe('ticket_error');
    expect(pd.lastError).toBe('DeviceNotRegistered');
    expect(pd.tokenPresent).toBe(true);
    expect(pd.attempts).toBe(1);
  });

  test('attempts increments across multiple sendPushForJob calls', async () => {
    seedJob('job-multi', 'u5');
    seedUserWithToken('u5', 'ExponentPushToken[good]');
    mockSendImpl.mockResolvedValue([{ status: 'ok', id: 'tk' }]);

    await sendPushForJob('job-multi', 'u5', 'complete');
    await sendPushForJob('job-multi', 'u5', 'complete');
    await sendPushForJob('job-multi', 'u5', 'complete');

    const pd = fs.read('enrichmentJobs', 'job-multi').pushDelivery;
    expect(pd.attempts).toBe(3);
    expect(pd.status).toBe('sent');
  });

  test('skips when the enrichment job doc does not exist (no crash)', async () => {
    seedUserWithToken('u6', 'ExponentPushToken[ghost]');
    mockSendImpl.mockResolvedValueOnce([{ status: 'ok', id: 'tk' }]);

    // Should not throw; should not write a phantom job doc.
    await sendPushForJob('job-missing', 'u6', 'complete');

    expect(fs.read('enrichmentJobs', 'job-missing')).toBeUndefined();
  });
});
