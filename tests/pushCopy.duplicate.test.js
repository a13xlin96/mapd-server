// Duplicate-push copy: when the share's link was appended to the existing
// pin as a new source (sourceAdded), the push must say "new link added" —
// telling the user their video was saved — instead of the plain
// "already saved" copy that made it look like the share was dropped.

const captured = [];

jest.mock('expo-server-sdk', () => ({
  Expo: class {
    static isExpoPushToken(token) {
      return typeof token === 'string' && token.length > 0;
    }
    chunkPushNotifications(messages) { return [messages]; }
    sendPushNotificationsAsync(messages) {
      captured.push(...messages);
      return Promise.resolve([]);
    }
  },
}));

jest.mock('../lib/firestore', () => {
  const { getSharedFirestore, makeAdmin } = require('./helpers/fakeFirestore');
  return { firestore: getSharedFirestore(), admin: makeAdmin() };
});

const { getSharedFirestore, FakeTimestamp } = require('./helpers/fakeFirestore');
const { sendPushForJob } = require('../lib/push');

const fs = getSharedFirestore();

function seedJobAndUser(jobId, userId) {
  fs.seed('enrichmentJobs', jobId, {
    status: 'duplicate',
    userId,
    createdAt: FakeTimestamp.fromMillis(Date.now() - 60_000),
    updatedAt: FakeTimestamp.fromMillis(Date.now() - 5_000),
  });
  fs.seed('users', userId, { expoPushToken: 'ExponentPushToken[abc]' });
}

beforeEach(() => {
  fs.reset();
  captured.length = 0;
});

describe('sendPushForJob — duplicate copy', () => {
  test('plain duplicate keeps the "already saved" copy', async () => {
    seedJobAndUser('job-d1', 'u1');

    await sendPushForJob('job-d1', 'u1', 'duplicate', { placeName: 'Ramen Spot', pinId: 'p1' });

    expect(captured).toHaveLength(1);
    expect(captured[0].title).toBe('Already on your map');
    expect(captured[0].body).toBe('Ramen Spot — already saved');
  });

  test('sourceAdded duplicate says "new link added"', async () => {
    seedJobAndUser('job-d2', 'u2');

    await sendPushForJob('job-d2', 'u2', 'duplicate', { placeName: 'Ramen Spot', pinId: 'p1', sourceAdded: true });

    expect(captured).toHaveLength(1);
    expect(captured[0].title).toBe('Already on your map');
    expect(captured[0].body).toBe('Ramen Spot — new link added');
  });

  test('sourceAdded duplicate without placeName still says a link was added', async () => {
    seedJobAndUser('job-d3', 'u3');

    await sendPushForJob('job-d3', 'u3', 'duplicate', { pinId: 'p1', sourceAdded: true });

    expect(captured).toHaveLength(1);
    expect(captured[0].body).toBe('New link added to a place you saved');
  });
});
