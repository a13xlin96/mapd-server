// Stage failure attribution tests — verifies the Fix 3 contract that
// silent pipeline fallbacks (vision/IG/etc.) get attributed on the job doc
// via stageFailures arrayUnion, and that classifyError picks the right
// kind for common dependency-error message shapes.

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
const { recordStageFailure, classifyError } = require('../enrich');

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

describe('classifyError', () => {
  test.each([
    ['ETIMEDOUT: socket timeout', 'dependency_timeout'],
    ['Request timeout after 10s', 'dependency_timeout'],
    ['429 Too Many Requests', 'quota_exhausted'],
    ['Rate limit exceeded', 'quota_exhausted'],
    ['quota exceeded', 'quota_exhausted'],
    ['403 Forbidden', 'blocked'],
    ['Access denied by Instagram', 'blocked'],
    ['Failed to parse JSON response', 'parse_error'],
    ['Invalid response format', 'parse_error'],
    ['getaddrinfo ENOTFOUND graph.instagram.com', 'dependency_error'],
    ['ECONNREFUSED 127.0.0.1:443', 'dependency_error'],
    ['Some unexpected garbage', 'dependency_error'],
    [null, 'dependency_error'],
    [undefined, 'dependency_error'],
  ])('%s → %s', (input, expected) => {
    const err = typeof input === 'string' ? new Error(input) : input;
    expect(classifyError(err)).toBe(expected);
  });
});

describe('recordStageFailure', () => {
  test('writes a stageFailures entry with stage, kind, message, and at', async () => {
    seedJob('job-1');

    await recordStageFailure('job-1', {
      stage: 'vision',
      kind: 'dependency_error',
      message: 'Anthropic API returned 500',
    });

    const after = fs.read('enrichmentJobs', 'job-1');
    expect(after.stageFailures).toHaveLength(1);
    expect(after.stageFailures[0]).toMatchObject({
      stage: 'vision',
      kind: 'dependency_error',
      message: 'Anthropic API returned 500',
    });
    expect(after.stageFailures[0].at).toBeDefined();
  });

  test('accumulates multiple stage failures via arrayUnion', async () => {
    seedJob('job-multi');

    await recordStageFailure('job-multi', { stage: 'vision', kind: 'dependency_timeout', message: 't' });
    await recordStageFailure('job-multi', { stage: 'instagram_carousel', kind: 'blocked', message: 'b' });
    await recordStageFailure('job-multi', { stage: 'social_extraction', kind: 'dependency_error', message: 'e' });

    const after = fs.read('enrichmentJobs', 'job-multi');
    expect(after.stageFailures).toHaveLength(3);
    expect(after.stageFailures.map((f) => f.stage)).toEqual([
      'vision',
      'instagram_carousel',
      'social_extraction',
    ]);
  });

  test('truncates oversized messages to 500 chars', async () => {
    seedJob('job-long');
    const huge = 'x'.repeat(2000);

    await recordStageFailure('job-long', { stage: 'vision', kind: 'parse_error', message: huge });

    const entry = fs.read('enrichmentJobs', 'job-long').stageFailures[0];
    expect(entry.message.length).toBe(500);
  });

  test('no-ops on missing jobId without throwing', async () => {
    await expect(
      recordStageFailure(null, { stage: 'vision', kind: 'dependency_error', message: 'x' })
    ).resolves.toBeUndefined();
  });

  test('updates the job updatedAt as a side effect', async () => {
    seedJob('job-touched');
    const before = fs.read('enrichmentJobs', 'job-touched').updatedAt.toMillis();

    fs.setNow(() => before + 5000);
    await recordStageFailure('job-touched', { stage: 'vision', kind: 'dependency_error', message: 'x' });

    const after = fs.read('enrichmentJobs', 'job-touched').updatedAt.toMillis();
    expect(after).toBeGreaterThan(before);
  });
});
