// Tests for the F3 fix — server-side buildPinFromDetails must write the
// full v3+ Atmosphere field set into the returned candidate (camelCase,
// matching Pin schema). Without these fields the client's
// enrichmentJobsListener treats every candidate as "pre-v3 server" and
// forces a redundant Place Details refetch on every save, which is what
// caused Bug 2 (Flushing dumplings — 3 of 7 saves failed because the
// refetch failed transiently).
//
// Also covers mapAtmosphereFields + mapPriceRange directly so the
// camelCase shape is locked in for the @a13xlin96/mapd-shared migration.

jest.mock('expo-server-sdk', () => ({
  Expo: class {
    static isExpoPushToken() { return true; }
    chunkPushNotifications() { return []; }
    async sendPushNotificationsAsync() { return []; }
  },
}));

const {
  buildPinFromDetails,
  mapAtmosphereFields,
  mapPriceRange,
} = require('../enrich.js');

const placesV3Details = {
  name: 'Dumpling Xi',
  formatted_address: '37-02 Prince St, Flushing, NY 11354, USA',
  geometry: { location: { lat: 40.7607, lng: -73.8330 } },
  rating: 4.6,
  user_ratings_total: 294,
  price_level: null,
  types: ['dumpling_restaurant', 'restaurant'],
  primary_type: 'dumpling_restaurant',
  dine_in: true,
  takeout: true,
  delivery: null,
  reservable: null,
  // Atmosphere v3+ booleans
  serves_breakfast: false,
  serves_lunch: true,
  serves_dinner: true,
  serves_brunch: false,
  serves_beer: false,
  serves_wine: false,
  serves_cocktails: false,
  serves_coffee: false,
  serves_dessert: false,
  serves_vegetarian_food: true,
  outdoor_seating: false,
  good_for_children: true,
  good_for_groups: true,
  allows_dogs: false,
  restroom: true,
  menu_for_children: false,
  live_music: false,
  business_status: 'OPERATIONAL',
  editorial_summary: { text: 'Cozy dumpling spot', language_code: 'en' },
  viewport: {
    low: { latitude: 40.7595, longitude: -73.8345 },
    high: { latitude: 40.7620, longitude: -73.8315 },
  },
  payment_options: {
    accepts_credit_cards: true,
    accepts_debit_cards: true,
    accepts_cash_only: null,
    accepts_nfc: true,
  },
  parking_options: {
    free_parking_lot: null,
    paid_parking_lot: null,
    free_street_parking: true,
    paid_street_parking: null,
    valet_parking: null,
    free_garage_parking: null,
    paid_garage_parking: null,
  },
  accessibility_options: {
    wheelchair_accessible_parking: null,
    wheelchair_accessible_entrance: true,
    wheelchair_accessible_restroom: true,
    wheelchair_accessible_seating: true,
  },
  current_opening_periods: [],
  current_weekday_descriptions: [
    'Monday: 11:00 AM – 11:00 PM',
    'Tuesday: 11:00 AM – 11:00 PM',
  ],
  opening_periods: [],
  weekday_descriptions: [],
};

const baseBuildArgs = {
  url: 'https://www.instagram.com/p/DYC-gyPlgkT',
  userId: 'user-1',
  ogData: { title: 'Flushing dumpling crawl', description: '', image: '' },
  details: placesV3Details,
  topResult: { place_id: 'ChIJmYBPXgBhwokRdDPA-2MFXR4' },
  category: 'food',
  location: { country: 'United States', region: 'New York', city: 'Queens County' },
  confidenceScore: 85,
  saveReason: 'enrichment',
};

describe('mapAtmosphereFields (F3 unit test)', () => {
  test('transforms snake_case Places API shape into camelCase Pin shape', () => {
    const out = mapAtmosphereFields(placesV3Details);
    expect(out.servesBreakfast).toBe(false);
    expect(out.servesLunch).toBe(true);
    expect(out.businessStatus).toBe('OPERATIONAL');
    expect(out.outdoorSeating).toBe(false);
    expect(out.allowsDogs).toBe(false);
    expect(out.restroom).toBe(true);
  });

  test('shapes nested editorialSummary into camelCase', () => {
    const out = mapAtmosphereFields(placesV3Details);
    expect(out.editorialSummary).toEqual({
      text: 'Cozy dumpling spot',
      languageCode: 'en',
    });
  });

  test('shapes nested paymentOptions into camelCase', () => {
    const out = mapAtmosphereFields(placesV3Details);
    expect(out.paymentOptions).toEqual({
      acceptsCreditCards: true,
      acceptsDebitCards: true,
      acceptsCashOnly: null,
      acceptsNfc: true,
    });
  });

  test('shapes nested parkingOptions into camelCase', () => {
    const out = mapAtmosphereFields(placesV3Details);
    expect(out.parkingOptions.freeStreetParking).toBe(true);
    expect(out.parkingOptions.paidGarageParking).toBeNull();
  });

  test('shapes nested accessibilityOptions into camelCase', () => {
    const out = mapAtmosphereFields(placesV3Details);
    expect(out.accessibilityOptions.wheelchairAccessibleEntrance).toBe(true);
    expect(out.accessibilityOptions.wheelchairAccessibleSeating).toBe(true);
  });

  test('returns null for missing nested objects (defensive)', () => {
    const sparse = { ...placesV3Details };
    delete sparse.editorial_summary;
    delete sparse.payment_options;
    delete sparse.parking_options;
    delete sparse.accessibility_options;
    delete sparse.viewport;
    const out = mapAtmosphereFields(sparse);
    expect(out.editorialSummary).toBeNull();
    expect(out.paymentOptions).toBeNull();
    expect(out.parkingOptions).toBeNull();
    expect(out.accessibilityOptions).toBeNull();
    expect(out.viewport).toBeNull();
  });
});

describe('mapPriceRange (F3 unit test)', () => {
  test('returns null for missing priceRange', () => {
    expect(mapPriceRange(null)).toBeNull();
    expect(mapPriceRange(undefined)).toBeNull();
  });

  test('transforms snake_case Places price_range into flat camelCase Pin shape', () => {
    const placesRaw = {
      start_price: { units: 10, nanos: 500000000, currency_code: 'USD' },
      end_price: { units: 20, nanos: 0, currency_code: 'USD' },
    };
    expect(mapPriceRange(placesRaw)).toEqual({
      startUnits: 10,
      startNanos: 500000000,
      endUnits: 20,
      endNanos: 0,
      currencyCode: 'USD',
    });
  });

  test('falls back to end_price currency_code when start is missing', () => {
    const placesRaw = {
      end_price: { units: 5, currency_code: 'EUR' },
    };
    expect(mapPriceRange(placesRaw).currencyCode).toBe('EUR');
  });

  test('coerces string nanos (bigint protobuf) into number', () => {
    const placesRaw = {
      start_price: { units: '1', nanos: '500000000', currency_code: 'USD' },
    };
    const out = mapPriceRange(placesRaw);
    expect(out.startUnits).toBe(1);
    expect(out.startNanos).toBe(500000000);
    expect(typeof out.startUnits).toBe('number');
  });
});

describe('buildPinFromDetails (F3 integration — v3 fields land on candidate)', () => {
  test('writes all v3+ Atmosphere booleans to the candidate', async () => {
    const pin = await buildPinFromDetails(baseBuildArgs);
    // The client's looksLikePreV3Server check fires when these are undefined.
    // Bug 2's root cause hypothesis: the server never wrote these, so the
    // client always refetched, and the refetch failed for the dumpling places.
    expect(pin.businessStatus).toBe('OPERATIONAL');
    expect(pin.servesLunch).toBe(true);
    expect(pin.servesDinner).toBe(true);
    expect(pin.servesVegetarianFood).toBe(true);
    expect(pin.goodForChildren).toBe(true);
    expect(pin.goodForGroups).toBe(true);
    expect(pin.allowsDogs).toBe(false);
    expect(pin.restroom).toBe(true);
  });

  test('writes nested v3+ objects in camelCase', async () => {
    const pin = await buildPinFromDetails(baseBuildArgs);
    expect(pin.editorialSummary).toEqual({
      text: 'Cozy dumpling spot',
      languageCode: 'en',
    });
    expect(pin.paymentOptions.acceptsCreditCards).toBe(true);
    expect(pin.parkingOptions.freeStreetParking).toBe(true);
    expect(pin.accessibilityOptions.wheelchairAccessibleEntrance).toBe(true);
  });

  test('writes priceRange in client Pin camelCase shape', async () => {
    const args = {
      ...baseBuildArgs,
      details: {
        ...placesV3Details,
        price_range: {
          start_price: { units: 15, nanos: 0, currency_code: 'USD' },
          end_price: { units: 30, nanos: 0, currency_code: 'USD' },
        },
      },
    };
    const pin = await buildPinFromDetails(args);
    expect(pin.priceRange).toEqual({
      startUnits: 15,
      startNanos: 0,
      endUnits: 30,
      endNanos: 0,
      currencyCode: 'USD',
    });
  });

  test('priceRange is null when details lacks price_range', async () => {
    const pin = await buildPinFromDetails(baseBuildArgs);
    expect(pin.priceRange).toBeNull();
  });

  test('businessStatus is NOT undefined (would trigger client refetch)', async () => {
    const pin = await buildPinFromDetails(baseBuildArgs);
    // The literal bug condition from enrichmentJobsListener.ts:108:
    //   const looksLikePreV3Server = candidate.businessStatus === undefined && candidate.placeId;
    // If this check fires, every save triggers a redundant Place Details
    // refetch — defeating F3 entirely.
    expect(pin.businessStatus).not.toBeUndefined();
  });

  test('REGRESSION (implementation-review 1a): writes all v3+ fields as null when details is null', async () => {
    // The single-place fallback paths (e.g. when Places Details fetch
    // returns nothing) previously spread `{}` here, leaving businessStatus
    // === undefined. That re-armed the client's pre-v3 detection branch
    // and Bug 2 came back. With the fix, all v3 fields land as null —
    // which the client's `=== undefined` check correctly skips.
    const pin = await buildPinFromDetails({ ...baseBuildArgs, details: null });
    expect(pin.businessStatus).toBeNull();
    expect(pin.businessStatus).not.toBeUndefined();
    expect(pin.servesBreakfast).toBeNull();
    expect(pin.servesLunch).toBeNull();
    expect(pin.servesDinner).toBeNull();
    expect(pin.outdoorSeating).toBeNull();
    expect(pin.editorialSummary).toBeNull();
    expect(pin.viewport).toBeNull();
    expect(pin.paymentOptions).toBeNull();
    expect(pin.parkingOptions).toBeNull();
    expect(pin.accessibilityOptions).toBeNull();
    expect(pin.priceRange).toBeNull();
  });

  test('mapAtmosphereFields does not throw on null/undefined details (defensive)', () => {
    // The module exports this function for the upcoming @a13xlin96/mapd-shared
    // migration — future callers may invoke with bad input.
    expect(() => mapAtmosphereFields(null)).not.toThrow();
    expect(() => mapAtmosphereFields(undefined)).not.toThrow();
    const out = mapAtmosphereFields(null);
    expect(out.businessStatus).toBeNull();
    expect(out.servesBreakfast).toBeNull();
  });
});

describe('mapPriceRange (additional edge cases — implementation-review 2f, 3b)', () => {
  test('handles asymmetric input: start_price only', () => {
    const out = mapPriceRange({
      start_price: { units: 10, nanos: 0, currency_code: 'USD' },
    });
    expect(out.startUnits).toBe(10);
    expect(out.endUnits).toBeNull();
    expect(out.endNanos).toBeNull();
    expect(out.currencyCode).toBe('USD');
  });

  test('handles asymmetric input: end_price only', () => {
    const out = mapPriceRange({
      end_price: { units: 20, nanos: 500000000, currency_code: 'EUR' },
    });
    expect(out.startUnits).toBeNull();
    expect(out.endUnits).toBe(20);
    expect(out.endNanos).toBe(500000000);
    expect(out.currencyCode).toBe('EUR');
  });

  test('returns null instead of NaN for non-numeric units/nanos (implementation-review 2f)', () => {
    // Number('abc') and Number({}) both produce NaN, which Firestore rejects.
    // The guard with Number.isFinite must catch these.
    const out = mapPriceRange({
      start_price: { units: 'not-a-number', nanos: undefined, currency_code: 'USD' },
    });
    expect(out.startUnits).toBeNull();
    expect(out.startNanos).toBeNull();
    expect(out.startUnits).not.toBeNaN();
  });
});
