const {withProvider} = require('../lib/providerRuntime');
const {EngineError,asEngineError} = require('../lib/engineError');
const axios = require('axios');
const { getCached, setCache } = require('../lib/cache');
const {runSharedAiOperation,SERVER_PUBLIC_SCOPE}=require('../lib/sharedAiOperation');
const context=require('../lib/jobContext');

const PLACES_API_BASE = 'https://places.googleapis.com/v1';
const SEARCH_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const DETAILS_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

function validPlaceDetails(value) {
  const location = value?.geometry?.location;
  return !!value && typeof value.name === 'string' && value.name.trim().length > 0
    && Number.isFinite(location?.lat) && Math.abs(location.lat) <= 90
    && Number.isFinite(location?.lng) && Math.abs(location.lng) <= 180
    && (value.types == null || (Array.isArray(value.types) && value.types.every(type => typeof type === 'string')));
}

function mapNewToLegacy(place) {
  return {
    place_id: place.id || '',
    name: (place.displayName && place.displayName.text) || '',
    formatted_address: place.formattedAddress || '',
    geometry: {
      location: {
        lat: place.location?.latitude ?? null,
        lng: place.location?.longitude ?? null,
      },
    },
    types: place.types || [],
    rating: place.rating,
    user_ratings_total: place.userRatingCount,
  };
}

function mapAddressComponents(components) {
  return components.map((c) => ({
    long_name: c.longText || '',
    short_name: c.shortText || '',
    types: c.types || [],
  }));
}

async function searchGooglePlaces(query, locationBias, locationRestriction) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new EngineError('dependency_error',{stage:'places_search',provider:'google'});
  }

  const cacheKey = locationRestriction
    ? `places:search:${query}#rect:${locationRestriction.low.lat.toFixed(2)},${locationRestriction.low.lng.toFixed(2)}-${locationRestriction.high.lat.toFixed(2)},${locationRestriction.high.lng.toFixed(2)}`
    : locationBias
      ? `places:search:${query}@${locationBias.lat},${locationBias.lng}`
      : `places:search:${query}`;
  const normalizedKey = cacheKey.toLowerCase().trim();

  const cached = await getCached(normalizedKey);
  if (cached) return cached;

  try {
    const body = { textQuery: query, pageSize:5 };
    if (locationRestriction) {
      body.locationRestriction = {
        rectangle: {
          low: { latitude: locationRestriction.low.lat, longitude: locationRestriction.low.lng },
          high: { latitude: locationRestriction.high.lat, longitude: locationRestriction.high.lng },
        },
      };
    } else if (locationBias) {
      body.locationBias = {
        circle: {
          center: { latitude: locationBias.lat, longitude: locationBias.lng },
          radius: locationBias.radiusMeters || 5000,
        },
      };
    }

    const response = await withProvider('google',({signal,deadline})=>axios.post(
      `${PLACES_API_BASE}/places:searchText`,
      body,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.types',
        },
        signal,
        timeout: Math.max(1,Math.min(10000,(deadline || Infinity)-Date.now())),
        maxContentLength: 1024*1024,
      }
    ),4,{stage:'matching',rateKey:'places_search',descriptor:{model:'text-search-pro'}});

    const places = (response.data && response.data.places) || [];
    const results = places.map(mapNewToLegacy);
    await setCache(normalizedKey, results, SEARCH_CACHE_TTL_SECONDS);
    return results;
  } catch (error) {
    throw asEngineError(error,{stage:'places_search',provider:'google'});
  }
}

async function findPlaceFromUrl(googleMapsUrl) {
  const placeMatch = googleMapsUrl.match(/\/place\/([^/@]+)/);
  const placeName = placeMatch ? decodeURIComponent(placeMatch[1]).replace(/\+/g, ' ') : null;

  const ftidMatch = googleMapsUrl.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i);
  const ftid = ftidMatch ? ftidMatch[1] : null;

  const coordMatch = googleMapsUrl.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  const locationBias = coordMatch
    ? { lat: parseFloat(coordMatch[1]), lng: parseFloat(coordMatch[2]), radiusMeters: 2000 }
    : undefined;

  if (!placeName && !ftid) return null;

  if (placeName && ftid) {
    const results = await searchGooglePlaces(`${placeName} ${ftid}`, locationBias);
    if (results.length > 0) return results[0];
  }

  if (placeName) {
    const results = await searchGooglePlaces(placeName, locationBias);
    if (results.length > 0) return results[0];
  }

  return null;
}

async function getCachedPlaceDetails(placeId) {
  if (typeof placeId !== 'string' || !placeId.trim()) return null;
  const cached = await getCached(`places:details:v3:${placeId}`);
  return validPlaceDetails(cached) ? cached : null;
}

async function getPlaceDetails(placeId, options = {}) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    if (options.strict) throw new EngineError('dependency_error',{stage:'details',provider:'google'});
    console.error('GOOGLE_PLACES_API_KEY not set');
    return null;
  }

  // Schema-versioned cache key. Bump the `v<N>` segment whenever the
  // mapped payload shape changes (new fields, changed nesting). Old
  // entries orphan in Redis and expire via TTL — readers never see them.
  // Avoids brittle per-field presence checks that have to be updated for
  // every future schema bump.
  //   v2: added priceRange.start_price.nanos / end_price.nanos
  //   v3: full Atmosphere tier — businessStatus, editorialSummary,
  //       viewport, paymentOptions, parkingOptions, accessibilityOptions,
  //       currentOpeningHours, allowsDogs, restroom, menuForChildren,
  //       liveMusic, servesCoffee, servesDessert
  const cacheKey = `places:details:v3:${placeId}`;
  const cached = await getCachedPlaceDetails(placeId);
  if (cached) return cached;

  try {
    // The durable pin task authorizes joining independently. Shared execution
    // then has its own lifetime; cancelling one pin cannot cancel other saves.
    await context.current()?.beforeProviderDispatch?.();
    return await runSharedAiOperation({kind:'place-details',stage:'details',provider:'google',input:{placeId},model:'places-enterprise-atmosphere',
      promptVersion:'none',schemaVersion:3,optionsVersion:'full-mask-v3',scope:SERVER_PUBLIC_SCOPE,
      bypassCache:options.refresh === true,ttlSeconds:86400,timeoutMs:30000,
      validate:validPlaceDetails}, async () => {
    const fresh=await getCachedPlaceDetails(placeId);
    if(fresh) return fresh;
    // Field mask. Every Place Details call is billed at the highest SKU
    // touched here; we're on Place Details Enterprise + Atmosphere
    // (~$0.025/call) because of the dineIn / takeout / serves* / etc.
    // fields below. Anything else in the same tier is FREE to add — so
    // we pull the full Atmosphere field set rather than leaving paid-for
    // data on the table. See CLAUDE.md "Cost Optimization" section.
    //
    // To drop the SKU tier (and per-call cost) in the future, strip the
    // Atmosphere fields first (the bottom block), then Enterprise fields
    // (rating, priceLevel, etc.), and so on. Each block removal moves us
    // down one tier.
    const fieldMask = [
      // Essentials IDs Only
      'id',
      // Essentials
      'formattedAddress',
      'shortFormattedAddress',
      'addressComponents',
      'location',
      'types',
      'viewport',
      // Pro
      'displayName',
      'primaryType',
      'utcOffsetMinutes',
      'accessibilityOptions',
      // Enterprise
      'rating',
      'userRatingCount',
      'priceLevel',
      'priceRange',
      'websiteUri',
      'nationalPhoneNumber',
      'regularOpeningHours',
      'currentOpeningHours',
      'businessStatus',
      // Enterprise + Atmosphere
      'dineIn',
      'takeout',
      'delivery',
      'reservable',
      'servesBreakfast',
      'servesBrunch',
      'servesLunch',
      'servesDinner',
      'servesBeer',
      'servesWine',
      'servesCocktails',
      'servesCoffee',
      'servesDessert',
      'servesVegetarianFood',
      'outdoorSeating',
      'goodForChildren',
      'goodForGroups',
      'allowsDogs',
      'restroom',
      'menuForChildren',
      'liveMusic',
      'editorialSummary',
      'paymentOptions',
      'parkingOptions',
    ].join(',');

    const response = await withProvider('google',({signal,deadline})=>axios.get(
      `${PLACES_API_BASE}/places/${placeId}`,
      {
        headers: {
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': fieldMask,
        },
        signal,
        timeout: Math.max(1,Math.min(10000,(deadline || Infinity)-Date.now())),
        maxContentLength: 1024*1024,
      }
    ),4,{stage:'details',rateKey:'places_details',descriptor:{model:'places-enterprise-atmosphere'}});

    const r = response.data;
    const displayName = r.displayName;
    const location = r.location;

    const details = {
      name: (displayName && displayName.text) || '',
      formatted_address: r.formattedAddress || '',
      short_formatted_address: r.shortFormattedAddress || null,
      address_components: r.addressComponents ? mapAddressComponents(r.addressComponents) : null,
      geometry: {
        location: {
          lat: location?.latitude ?? null,
          lng: location?.longitude ?? null,
        },
      },
      types: r.types || [],
      primary_type: r.primaryType || null,
      rating: r.rating || null,
      user_ratings_total: r.userRatingCount || null,
      price_level: r.priceLevel || null,
      // Google's PriceRange uses the Money proto: { units: int64, nanos: int32, currencyCode }.
      // `units` is the integer part; `nanos` is 10^-9 of a unit (so 0.50 → nanos = 500000000).
      // Dropping nanos would truncate any fractional amount and corrupt the cached payload.
      price_range: r.priceRange
        ? {
            start_price: r.priceRange.startPrice
              ? {
                  units: r.priceRange.startPrice.units,
                  nanos: r.priceRange.startPrice.nanos,
                  currency_code: r.priceRange.startPrice.currencyCode,
                }
              : null,
            end_price: r.priceRange.endPrice
              ? {
                  units: r.priceRange.endPrice.units,
                  nanos: r.priceRange.endPrice.nanos,
                  currency_code: r.priceRange.endPrice.currencyCode,
                }
              : null,
          }
        : null,
      website: r.websiteUri || null,
      formatted_phone_number: r.nationalPhoneNumber || null,
      dine_in: r.dineIn == null ? null : r.dineIn,
      takeout: r.takeout == null ? null : r.takeout,
      delivery: r.delivery == null ? null : r.delivery,
      reservable: r.reservable == null ? null : r.reservable,
      serves_breakfast: r.servesBreakfast == null ? null : r.servesBreakfast,
      serves_brunch: r.servesBrunch == null ? null : r.servesBrunch,
      serves_lunch: r.servesLunch == null ? null : r.servesLunch,
      serves_dinner: r.servesDinner == null ? null : r.servesDinner,
      serves_beer: r.servesBeer == null ? null : r.servesBeer,
      serves_wine: r.servesWine == null ? null : r.servesWine,
      serves_cocktails: r.servesCocktails == null ? null : r.servesCocktails,
      serves_vegetarian_food: r.servesVegetarianFood == null ? null : r.servesVegetarianFood,
      serves_coffee: r.servesCoffee == null ? null : r.servesCoffee,
      serves_dessert: r.servesDessert == null ? null : r.servesDessert,
      outdoor_seating: r.outdoorSeating == null ? null : r.outdoorSeating,
      good_for_children: r.goodForChildren == null ? null : r.goodForChildren,
      good_for_groups: r.goodForGroups == null ? null : r.goodForGroups,
      allows_dogs: r.allowsDogs == null ? null : r.allowsDogs,
      restroom: r.restroom == null ? null : r.restroom,
      menu_for_children: r.menuForChildren == null ? null : r.menuForChildren,
      live_music: r.liveMusic == null ? null : r.liveMusic,
      business_status: r.businessStatus || null,
      editorial_summary: r.editorialSummary
        ? {
            text: r.editorialSummary.text || null,
            language_code: r.editorialSummary.languageCode || null,
          }
        : null,
      viewport: r.viewport
        ? {
            low: r.viewport.low
              ? { latitude: r.viewport.low.latitude, longitude: r.viewport.low.longitude }
              : null,
            high: r.viewport.high
              ? { latitude: r.viewport.high.latitude, longitude: r.viewport.high.longitude }
              : null,
          }
        : null,
      payment_options: r.paymentOptions
        ? {
            accepts_credit_cards: r.paymentOptions.acceptsCreditCards ?? null,
            accepts_debit_cards: r.paymentOptions.acceptsDebitCards ?? null,
            accepts_cash_only: r.paymentOptions.acceptsCashOnly ?? null,
            accepts_nfc: r.paymentOptions.acceptsNfc ?? null,
          }
        : null,
      parking_options: r.parkingOptions
        ? {
            free_parking_lot: r.parkingOptions.freeParkingLot ?? null,
            paid_parking_lot: r.parkingOptions.paidParkingLot ?? null,
            free_street_parking: r.parkingOptions.freeStreetParking ?? null,
            paid_street_parking: r.parkingOptions.paidStreetParking ?? null,
            valet_parking: r.parkingOptions.valetParking ?? null,
            free_garage_parking: r.parkingOptions.freeGarageParking ?? null,
            paid_garage_parking: r.parkingOptions.paidGarageParking ?? null,
          }
        : null,
      accessibility_options: r.accessibilityOptions
        ? {
            wheelchair_accessible_parking:
              r.accessibilityOptions.wheelchairAccessibleParking ?? null,
            wheelchair_accessible_entrance:
              r.accessibilityOptions.wheelchairAccessibleEntrance ?? null,
            wheelchair_accessible_restroom:
              r.accessibilityOptions.wheelchairAccessibleRestroom ?? null,
            wheelchair_accessible_seating:
              r.accessibilityOptions.wheelchairAccessibleSeating ?? null,
          }
        : null,
      opening_periods: (r.regularOpeningHours && Array.isArray(r.regularOpeningHours.periods))
        ? r.regularOpeningHours.periods.map((p) => ({
            open: {
              day: (p.open && p.open.day) || 0,
              hour: (p.open && p.open.hour) || 0,
              minute: (p.open && p.open.minute) || 0,
            },
            close: {
              day: (p.close && p.close.day) || 0,
              hour: (p.close && p.close.hour) || 0,
              minute: (p.close && p.close.minute) || 0,
            },
          }))
        : null,
      weekday_descriptions: (r.regularOpeningHours && Array.isArray(r.regularOpeningHours.weekdayDescriptions))
        ? r.regularOpeningHours.weekdayDescriptions
        : null,
      current_opening_periods: (r.currentOpeningHours && Array.isArray(r.currentOpeningHours.periods))
        ? r.currentOpeningHours.periods.map((p) => ({
            open: p.open
              ? {
                  day: p.open.day || 0,
                  hour: p.open.hour || 0,
                  minute: p.open.minute || 0,
                  date: p.open.date
                    ? { year: p.open.date.year, month: p.open.date.month, day: p.open.date.day }
                    : null,
                }
              : null,
            // Google omits `close` for places that never close on that
            // period (24/7 venues). Preserve the absence as null rather
            // than synthesizing a fake Sunday-midnight close event.
            // Downstream open-now / next-close consumers must treat a
            // null close as "no scheduled close on this period".
            close: p.close
              ? {
                  day: p.close.day || 0,
                  hour: p.close.hour || 0,
                  minute: p.close.minute || 0,
                  date: p.close.date
                    ? { year: p.close.date.year, month: p.close.date.month, day: p.close.date.day }
                    : null,
                }
              : null,
          }))
        : null,
      current_weekday_descriptions: (r.currentOpeningHours && Array.isArray(r.currentOpeningHours.weekdayDescriptions))
        ? r.currentOpeningHours.weekdayDescriptions
        : null,
      utc_offset_minutes: typeof r.utcOffsetMinutes === 'number' ? r.utcOffsetMinutes : null,
    };

    // The legacy cache is also consumed outside shared execution. Validate
    // before writing so rejected HTTP successes cannot complete a later retry.
    if (!validPlaceDetails(details)) throw new EngineError('invalid_response',{stage:'details',provider:'google'});
    await setCache(cacheKey, details, DETAILS_CACHE_TTL_SECONDS);
    return details;
    });
  } catch (error) {
    if (options.strict) throw asEngineError(error,{stage:'details',provider:'google'});
    console.error('Google Places details error:', error.message);
    return null;
  }
}

module.exports = { searchGooglePlaces, getPlaceDetails, getCachedPlaceDetails, findPlaceFromUrl };
