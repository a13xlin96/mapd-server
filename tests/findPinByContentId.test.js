// findPinByContentId must recognize a video that lives in a pin's sources[]
// array, not just the pin's main url. Once duplicate-place shares append
// sources (fix/duplicate-pin-append-source), a reshare of an appended video
// has to content-ID-match against sources — otherwise it re-runs the full
// AI + Places pipeline and gets wrongly announced as "new link added" again.
// Mirrors the client check in enrichmentTask.ts (pinsFromThisVideo).

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
const { findPinByContentId } = require('../enrich');

const fs = getSharedFirestore();

beforeEach(() => fs.reset());

const USER = 'u_content';

describe('findPinByContentId', () => {
  test('matches via the pin main url (existing behavior)', async () => {
    fs.seed('pins', 'p1', {
      userId: USER,
      url: 'https://www.tiktok.com/@chef/video/7300000000000000001',
      placeName: 'Ramen Spot',
    });

    const hit = await findPinByContentId(USER, 'tiktok:7300000000000000001');
    expect(hit).not.toBeNull();
    expect(hit.id).toBe('p1');
  });

  test('matches via a sources[] entry when pin.url has no content ID', async () => {
    // Pin created from a TikTok short URL (no extractable content ID), with
    // a second video appended as a source by the duplicate-place flow.
    fs.seed('pins', 'p2', {
      userId: USER,
      url: 'https://www.tiktok.com/t/ZTShortAbc/',
      placeName: 'Taco Stand',
      sources: [
        { url: 'https://www.tiktok.com/t/ZTShortAbc/', ogTitle: '', ogImage: '', sourceApp: 'tiktok', sourceDomain: 'tiktok.com' },
        { url: 'https://www.tiktok.com/@foodie/video/7300000000000000002', ogTitle: '', ogImage: '', sourceApp: 'tiktok', sourceDomain: 'tiktok.com' },
      ],
    });

    const hit = await findPinByContentId(USER, 'tiktok:7300000000000000002');
    expect(hit).not.toBeNull();
    expect(hit.id).toBe('p2');
  });

  test('returns null when neither url nor sources match', async () => {
    fs.seed('pins', 'p3', {
      userId: USER,
      url: 'https://www.tiktok.com/@chef/video/7300000000000000003',
      sources: [
        { url: 'https://www.tiktok.com/@chef/video/7300000000000000003' },
      ],
    });

    const hit = await findPinByContentId(USER, 'tiktok:9999999999999999999');
    expect(hit).toBeNull();
  });

  test('ignores other users pins', async () => {
    fs.seed('pins', 'p4', {
      userId: 'someone_else',
      url: 'https://www.tiktok.com/@chef/video/7300000000000000004',
    });

    const hit = await findPinByContentId(USER, 'tiktok:7300000000000000004');
    expect(hit).toBeNull();
  });
});
