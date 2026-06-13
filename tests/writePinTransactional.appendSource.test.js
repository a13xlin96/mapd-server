// When writePinTransactional finds the place already pinned (placeId or URL
// match inside the txn), it must append the new share's source entry to the
// existing pin instead of silently dropping it — that's the "unique video
// about an already-pinned place" bug. Mirrors client addSourceToPin semantics
// (pinsStore.ts:765): dedupe by normalized URL OR content ID before append,
// and upgrade pin.url to the canonical URL when pin.url lacks a content ID.

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
const { writePinTransactional } = require('../enrich');

const fs = getSharedFirestore();

beforeEach(() => fs.reset());

const USER = 'u_append';
const PLACE = 'place_ramen_1';

const VIDEO_A = 'https://www.tiktok.com/@chef/video/7300000000000000001';
const VIDEO_B = 'https://www.tiktok.com/@foodie/video/7300000000000000002';
const SHORT_URL = 'https://www.tiktok.com/t/ZTShortAbc/';

function makePin(overrides = {}) {
  return {
    userId: USER,
    url: VIDEO_B,
    placeId: PLACE,
    placeName: 'Ramen Spot',
    ogTitle: 'new video title',
    ogImage: 'https://img.example/b.jpg',
    sourceApp: 'tiktok',
    sourceDomain: 'tiktok.com',
    ...overrides,
  };
}

function seedExistingPin(overrides = {}) {
  fs.seed('pins', 'existing1', {
    userId: USER,
    url: VIDEO_A,
    placeId: PLACE,
    placeName: 'Ramen Spot',
    sources: [
      { url: VIDEO_A, ogTitle: 'old', ogImage: '', sourceApp: 'tiktok', sourceDomain: 'tiktok.com', addedAt: new Date(0) },
    ],
    ...overrides,
  });
}

describe('writePinTransactional — duplicate place, new video', () => {
  test('appends the new source and reports sourceAdded', async () => {
    seedExistingPin();

    const result = await writePinTransactional(makePin(), {});

    expect(result.alreadyExists).toBe(true);
    expect(result.pinId).toBe('existing1');
    expect(result.sourceAdded).toBe(true);

    const doc = fs.read('pins', 'existing1');
    expect(doc.sources).toHaveLength(2);
    const added = doc.sources[1];
    expect(added.url).toBe(VIDEO_B);
    expect(added.ogTitle).toBe('new video title');
    expect(added.sourceApp).toBe('tiktok');
    expect(added.addedAt).toBeDefined();
  });

  test('same video already in sources → no duplicate append', async () => {
    seedExistingPin({
      sources: [
        { url: VIDEO_A, ogTitle: 'old', ogImage: '', sourceApp: 'tiktok', sourceDomain: 'tiktok.com', addedAt: new Date(0) },
        { url: VIDEO_B, ogTitle: 'already here', ogImage: '', sourceApp: 'tiktok', sourceDomain: 'tiktok.com', addedAt: new Date(0) },
      ],
    });

    const result = await writePinTransactional(makePin(), {});

    expect(result.alreadyExists).toBe(true);
    expect(result.sourceAdded).toBe(false);
    expect(fs.read('pins', 'existing1').sources).toHaveLength(2);
  });

  test('same content ID under a different URL form → no duplicate append', async () => {
    // Same video ID reachable via a tracking-param variant — content-ID
    // match must catch it even though raw strings differ.
    seedExistingPin();
    const variant = makePin({ url: `${VIDEO_A}?_t=xyz123&_r=1` });

    const result = await writePinTransactional(variant, {});

    expect(result.alreadyExists).toBe(true);
    expect(result.sourceAdded).toBe(false);
    expect(fs.read('pins', 'existing1').sources).toHaveLength(1);
  });

  test('upgrades pin.url to canonical when existing url has no content ID', async () => {
    // Existing pin created from a short URL (pre-canonical era or server gap).
    seedExistingPin({ url: SHORT_URL, sources: [
      { url: SHORT_URL, ogTitle: 'old', ogImage: '', sourceApp: 'tiktok', sourceDomain: 'tiktok.com', addedAt: new Date(0) },
    ] });

    const result = await writePinTransactional(makePin(), {});

    expect(result.sourceAdded).toBe(true);
    const doc = fs.read('pins', 'existing1');
    expect(doc.url).toBe(VIDEO_B);
  });

  test('does NOT rewrite pin.url when it already has a content ID', async () => {
    seedExistingPin();

    await writePinTransactional(makePin(), {});

    expect(fs.read('pins', 'existing1').url).toBe(VIDEO_A);
  });

  test('new place still creates a pin with the source seeded', async () => {
    const result = await writePinTransactional(makePin(), {});

    expect(result.alreadyExists).toBe(false);
    const doc = fs.read('pins', result.pinId);
    expect(doc.sources).toHaveLength(1);
    expect(doc.sources[0].url).toBe(VIDEO_B);
  });
});
