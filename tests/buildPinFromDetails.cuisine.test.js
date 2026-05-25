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

  // Round-2 hotfix regression: a place where top.types is generic
  // (['establishment']) but details.types has the rich classification
  // (['italian_restaurant']) and primaryType is null. Pre-fix, the call
  // site would pass only top.types to mapToCategory and classify as 'other'.
  test('union of top.types + details.types: generic top must not shadow specific details', async () => {
    const pin = await buildPinFromDetails({
      ...baseArgs,
      details: makeDetails({ types: ['italian_restaurant'], primary_type: null }),
      topResult: { place_id: 'ChIJ', types: ['establishment', 'point_of_interest'] },
    });
    expect(pin.cuisine).toBe('italian');
    expect(pin.types).toContain('italian_restaurant');
  });

  // Round-3 hotfix regression: cuisine must derive from the SAME unioned
  // type set as category. Otherwise category could land on 'restaurant'
  // (via union) while cuisine stays null (because details.types alone has
  // only 'museum'). The pin would be internally inconsistent.
  test('cuisine + category derive from the SAME union of top/details types', async () => {
    const pin = await buildPinFromDetails({
      ...baseArgs,
      category: 'restaurant',
      details: makeDetails({ types: ['museum', 'establishment'], primary_type: null }),
      topResult: { place_id: 'ChIJ', types: ['italian_restaurant'] },
    });
    expect(pin.category).toBe('restaurant');
    expect(pin.cuisine).toBe('italian');
  });

  // Round-4 hotfix regression: persisted pin.types must equal the union
  // used for category/cuisine derivation, so downstream re-derivation
  // (backfill, repair jobs) sees the same input that produced the original
  // classification. Pre-fix, pin.types would be ['museum','establishment']
  // and a backfill re-run would mis-derive category back to 'attraction'.
  test('persisted pin.types is the union — supports stable re-derivation downstream', async () => {
    const pin = await buildPinFromDetails({
      ...baseArgs,
      details: makeDetails({ types: ['museum', 'establishment'], primary_type: null }),
      topResult: { place_id: 'ChIJ', types: ['italian_restaurant'] },
    });
    expect(pin.types).toEqual(['museum', 'establishment', 'italian_restaurant']);
    // Invariant: any pin where category != 'other' must have at least one
    // token in pin.types that justifies it (or a non-null primaryType).
    const { mapToCategory } = require('../enrich/categories');
    expect(mapToCategory(pin.types, pin.primaryType)).toBe('restaurant');
  });
});
