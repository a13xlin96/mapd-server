// appendSourceToExistingPin — used by the duplicate branches that locate the
// existing pin via findPinByContentId/findPinByPlaceId (content-ID dedup,
// AI candidate-loop skip, OG-fallback duplicate) rather than inside
// writePinTransactional. Same contract: dedupe by normalized URL OR content
// ID against pin.url + sources[], append the canonical-URL source otherwise,
// upgrade pin.url when it lacks a content ID. Runs in its own transaction so
// a concurrent append can't clobber it.

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
const { appendSourceToExistingPin } = require('../enrich');

const fs = getSharedFirestore();

beforeEach(() => fs.reset());

const VIDEO_A = 'https://www.tiktok.com/@chef/video/7300000000000000001';
const VIDEO_B = 'https://www.tiktok.com/@foodie/video/7300000000000000002';
const SHORT_URL = 'https://www.tiktok.com/t/ZTShortAbc/';

const NEW_SOURCE = {
  url: VIDEO_B,
  ogTitle: 'second video',
  ogImage: 'https://img.example/b.jpg',
  sourceApp: 'tiktok',
  sourceDomain: 'tiktok.com',
};

function seedPin(overrides = {}) {
  fs.seed('pins', 'pin1', {
    userId: 'u1',
    url: VIDEO_A,
    placeId: 'place1',
    placeName: 'Ramen Spot',
    sources: [
      { url: VIDEO_A, ogTitle: 'first', ogImage: '', sourceApp: 'tiktok', sourceDomain: 'tiktok.com', addedAt: new Date(0) },
    ],
    ...overrides,
  });
}

describe('appendSourceToExistingPin', () => {
  test('appends a new video source and returns true', async () => {
    seedPin();

    const added = await appendSourceToExistingPin('pin1', NEW_SOURCE);

    expect(added).toBe(true);
    const doc = fs.read('pins', 'pin1');
    expect(doc.sources).toHaveLength(2);
    expect(doc.sources[1].url).toBe(VIDEO_B);
    expect(doc.sources[1].addedAt).toBeDefined();
  });

  test('no-ops when the same content ID is already a source', async () => {
    seedPin({
      sources: [
        { url: VIDEO_A, ogTitle: 'first', ogImage: '', sourceApp: 'tiktok', sourceDomain: 'tiktok.com', addedAt: new Date(0) },
        { url: `${VIDEO_B}?_t=trackingjunk`, ogTitle: 'variant', ogImage: '', sourceApp: 'tiktok', sourceDomain: 'tiktok.com', addedAt: new Date(0) },
      ],
    });

    const added = await appendSourceToExistingPin('pin1', NEW_SOURCE);

    expect(added).toBe(false);
    expect(fs.read('pins', 'pin1').sources).toHaveLength(2);
  });

  test('no-ops when pin.url itself is the same video', async () => {
    seedPin({ url: VIDEO_B, sources: [] });

    const added = await appendSourceToExistingPin('pin1', NEW_SOURCE);

    expect(added).toBe(false);
    expect(fs.read('pins', 'pin1').sources).toHaveLength(0);
  });

  test('upgrades pin.url to canonical when it has no content ID', async () => {
    seedPin({ url: SHORT_URL, sources: [
      { url: SHORT_URL, ogTitle: 'first', ogImage: '', sourceApp: 'tiktok', sourceDomain: 'tiktok.com', addedAt: new Date(0) },
    ] });

    const added = await appendSourceToExistingPin('pin1', NEW_SOURCE);

    expect(added).toBe(true);
    expect(fs.read('pins', 'pin1').url).toBe(VIDEO_B);
  });

  test('returns false without throwing when the pin is gone', async () => {
    const added = await appendSourceToExistingPin('missing_pin', NEW_SOURCE);
    expect(added).toBe(false);
  });

  test('does NOT rewrite a non-social pin.url (Google Maps origin)', async () => {
    // Codex P2: the upgrade exists to fix social SHORT urls (no content ID).
    // A pin created from a Google Maps link / website must keep its primary
    // URL — rewriting it to a later TikTok video is a hidden data migration.
    const mapsUrl = 'https://maps.google.com/?cid=12345';
    seedPin({ url: mapsUrl, sources: [
      { url: mapsUrl, ogTitle: 'maps', ogImage: '', sourceApp: 'google_maps', sourceDomain: 'google.com', addedAt: new Date(0) },
    ] });

    const added = await appendSourceToExistingPin('pin1', NEW_SOURCE);

    expect(added).toBe(true);
    const doc = fs.read('pins', 'pin1');
    expect(doc.url).toBe(mapsUrl);
    expect(doc.sources).toHaveLength(2);
  });
});
