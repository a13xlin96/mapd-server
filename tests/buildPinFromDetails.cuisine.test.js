// Integration: cuisine field is derived and written on every buildPinFromDetails
// path. Locks in the boundary contract so a future refactor that drops the
// cuisine call gets caught by tests rather than by a quiet field absence in
// Firestore.

jest.mock('expo-server-sdk', () => ({
  Expo: class {
    static isExpoPushToken() { return true; }
    chunkPushNotifications() { return []; }
    sendPushNotificationsAsync() { return Promise.resolve([]); }
  },
}));

const { buildPinFromDetails } = require('../enrich');

const baseArgs = {
  url: 'https://example.com/post/123',
  userId: 'u1',
  ogData: { title: 'Test', description: '', image: '' },
  topResult: { place_id: 'ChIJ_test' },
  category: 'restaurant',
  location: { country: 'Italy', region: 'Lazio', city: 'Rome' },
  confidenceScore: 85,
  saveReason: 'enrichment',
};

function makeDetails({ types, primary_type } = {}) {
  return {
    name: 'Test Place',
    formatted_address: 'Some Address',
    geometry: { location: { lat: 41.9028, lng: 12.4964 } },
    types: types || [],
    primary_type: primary_type || null,
  };
}

describe('buildPinFromDetails — cuisine field', () => {
  test('writes cuisine for an italian restaurant', async () => {
    const pin = await buildPinFromDetails({
      ...baseArgs,
      details: makeDetails({ types: ['italian_restaurant', 'restaurant'], primary_type: 'italian_restaurant' }),
    });
    expect(pin.cuisine).toBe('italian');
  });

  test('writes "other" for a restaurant with no cuisine signal', async () => {
    const pin = await buildPinFromDetails({
      ...baseArgs,
      details: makeDetails({ types: ['restaurant', 'establishment'], primary_type: 'restaurant' }),
    });
    expect(pin.cuisine).toBe('other');
  });

  test('writes null cuisine for a non-food place', async () => {
    const pin = await buildPinFromDetails({
      ...baseArgs,
      category: 'attraction',
      details: makeDetails({ types: ['museum', 'tourist_attraction'], primary_type: 'museum' }),
    });
    expect(pin.cuisine).toBeNull();
  });

  test('consolidates sushi_restaurant into japanese', async () => {
    const pin = await buildPinFromDetails({
      ...baseArgs,
      details: makeDetails({ types: ['sushi_restaurant'], primary_type: 'sushi_restaurant' }),
    });
    expect(pin.cuisine).toBe('japanese');
  });

  test('falls back to topResult.types when details has no types', async () => {
    const pin = await buildPinFromDetails({
      ...baseArgs,
      details: makeDetails({ types: [], primary_type: null }),
      topResult: { place_id: 'ChIJ', types: ['mexican_restaurant'] },
    });
    expect(pin.cuisine).toBe('mexican');
  });

  test('cuisine is null when both details and topResult lack types', async () => {
    const pin = await buildPinFromDetails({
      ...baseArgs,
      details: makeDetails({ types: [], primary_type: null }),
      topResult: { place_id: 'ChIJ' },
    });
    expect(pin.cuisine).toBeNull();
  });
});
