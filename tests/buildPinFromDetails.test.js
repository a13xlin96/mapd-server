// Integration test for buildPinFromDetails — the server-side pin
// construction path that runs at the end of every enrichment pipeline.
// Locks in the Task K + Task 33 boundary contract:
//   - assertSaveReason is invoked BEFORE any pin construction work
//   - saveReason → saveOrigin on the returned pin shape
//   - Phase 1 fields (types, saveOrigin, tripSignalIdAtSave,
//     savedAtTripStatus, distanceFromUserAtSaveKm, distanceFromHomeCityKm,
//     recAttributionId) land on the output even when Firestore is offline
//     (in-test default — they coerce to null instead of being absent)
//
// Firestore is intentionally NOT mocked: enrich.js's lib/firestore
// initializer leaves `firestore = null` when FIREBASE_SERVICE_ACCOUNT_JSON
// is unset, which short-circuits trip-signal lookup and home-distance
// reads to null. That gives us a clean unit-level test surface without
// having to mock the admin SDK.

// expo-server-sdk ships ESM which jest can't parse out of the box, and
// enrich.js -> lib/push.js -> expo-server-sdk transitively pulls it in
// at module load. The push code is unreachable from buildPinFromDetails,
// so a no-op mock unblocks the import chain without affecting the
// behavior under test.
jest.mock('expo-server-sdk', () => ({
  Expo: class {
    static isExpoPushToken() { return true; }
    chunkPushNotifications() { return []; }
    async sendPushNotificationsAsync() { return []; }
  },
}));

const { buildPinFromDetails } = require('../enrich.js');

const baseArgs = {
  url: 'https://www.instagram.com/p/abc123',
  userId: 'user-1',
  ogData: { title: 'Test Place', description: 'A test', image: '' },
  details: {
    name: 'Test Place',
    formatted_address: '123 Test St, Tokyo, Japan',
    geometry: { location: { lat: 35.6762, lng: 139.6503 } },
    rating: 4.5,
    user_ratings_total: 100,
    price_level: 2,
    types: ['restaurant', 'food', 'establishment'],
    primary_type: 'restaurant',
    dine_in: true,
    takeout: false,
  },
  topResult: { place_id: 'ChIJ-test-place' },
  category: 'food',
  location: { country: 'Japan', region: 'Tokyo', city: 'Shibuya' },
  confidenceScore: 85,
};

describe('buildPinFromDetails (Task 33 — Phase 1 server wiring)', () => {
  test.each(['manual', 'clone', 'enrichment'])(
    'accepts valid saveReason %s and stamps it as saveOrigin',
    async (saveReason) => {
      const pin = await buildPinFromDetails({ ...baseArgs, saveReason });
      expect(pin.saveOrigin).toBe(saveReason);
    },
  );

  test.each([null, undefined, '', 'shareExtension', 'MANUAL', 42, {}])(
    'rejects invalid saveReason %p BEFORE constructing any pin shape',
    async (saveReason) => {
      await expect(buildPinFromDetails({ ...baseArgs, saveReason })).rejects.toThrow(
        /Invalid saveReason/,
      );
    },
  );

  test('threads types[] from details onto the pin', async () => {
    const pin = await buildPinFromDetails({ ...baseArgs, saveReason: 'enrichment' });
    expect(pin.types).toEqual(['restaurant', 'food', 'establishment']);
  });

  test('falls back to topResult.types when details.types is missing', async () => {
    const args = {
      ...baseArgs,
      details: { ...baseArgs.details, types: undefined },
      topResult: { place_id: 'ChIJ-x', types: ['cafe', 'food'] },
    };
    const pin = await buildPinFromDetails({ ...args, saveReason: 'enrichment' });
    expect(pin.types).toEqual(['cafe', 'food']);
  });

  test('types is null when both details and topResult lack types[]', async () => {
    const args = {
      ...baseArgs,
      details: { ...baseArgs.details, types: undefined },
      topResult: { place_id: 'ChIJ-x' },
    };
    const pin = await buildPinFromDetails({ ...args, saveReason: 'enrichment' });
    expect(pin.types).toBeNull();
  });

  test('Phase 1 trip + distance fields coerce to null when Firestore is offline', async () => {
    const pin = await buildPinFromDetails({ ...baseArgs, saveReason: 'enrichment' });
    expect(pin.tripSignalIdAtSave).toBeNull();
    expect(pin.savedAtTripStatus).toBeNull();
    expect(pin.distanceFromHomeCityKm).toBeNull();
    // Server never has transient user location — always null per matrix
    expect(pin.distanceFromUserAtSaveKm).toBeNull();
    // Phase 1 reservation field — set only by Phase 2 algorithm
    expect(pin.recAttributionId).toBeNull();
  });

  test('serverEnriched flag is still set (existing invariant)', async () => {
    const pin = await buildPinFromDetails({ ...baseArgs, saveReason: 'enrichment' });
    expect(pin.serverEnriched).toBe(true);
  });
});
