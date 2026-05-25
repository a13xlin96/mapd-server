// Heartbeat lifecycle tests — verifies the Fix 1 contract that runEnrichment's
// heartbeat keeps updatedAt advancing on the configured interval and stops
// cleanly when the returned disposer is invoked.

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

const { getSharedFirestore } = require('./helpers/fakeFirestore');
const { startJobHeartbeat } = require('../enrich');

const fs = getSharedFirestore();

beforeEach(() => {
  fs.reset();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('startJobHeartbeat', () => {
  test('updates updatedAt on each tick', async () => {
    fs.setNow(() => 1000);
    const stop = startJobHeartbeat('h1', 30);
    await sleep(60);
    fs.setNow(() => 2000);
    await sleep(60);
    stop();
    const after = fs.read('enrichmentJobs', 'h1');
    expect(after).toBeDefined();
    expect(after.updatedAt.toMillis()).toBe(2000);
  });

  test('stops writing after stop() is called', async () => {
    fs.setNow(() => 1000);
    const stop = startJobHeartbeat('h2', 30);
    await sleep(60);
    stop();
    const tsAtStop = fs.read('enrichmentJobs', 'h2').updatedAt.toMillis();
    fs.setNow(() => 5000);
    await sleep(150);
    const tsAfter = fs.read('enrichmentJobs', 'h2').updatedAt.toMillis();
    expect(tsAfter).toBe(tsAtStop);
  });

  test('swallows updateJob rejections (no unhandledRejection escape)', async () => {
    fs.setNow(() => 1000);
    const original = fs.collection.bind(fs);
    fs.collection = function () {
      return {
        doc: () => ({
          set: () => Promise.reject(new Error('simulated firestore failure')),
        }),
      };
    };

    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);

    // Silence the warn log from the heartbeat catch so jest output stays clean.
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const stop = startJobHeartbeat('h3', 20);
    await sleep(80);
    stop();
    await sleep(20);

    fs.collection = original;
    process.removeListener('unhandledRejection', onUnhandled);
    warnSpy.mockRestore();

    expect(unhandled).toEqual([]);
  });
});
