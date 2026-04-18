const axios = require('axios');
const { getCached, setCache } = require('../lib/cache');

const PLACES_API_BASE = 'https://places.googleapis.com/v1';
const SEARCH_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const DETAILS_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

function mapNewToLegacy(place) {
  return {
    place_id: place.id || '',
    name: (place.displayName && place.displayName.text) || '',
    formatted_address: place.formattedAddress || '',
    geometry: {
      location: {
        lat: (place.location && place.location.latitude) || 0,
        lng: (place.location && place.location.longitude) || 0,
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
    console.error('GOOGLE_PLACES_API_KEY not set');
    return [];
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
    const body = { textQuery: query };
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

    const response = await axios.post(
      `${PLACES_API_BASE}/places:searchText`,
      body,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.rating,places.userRatingCount',
        },
        timeout: 10000,
      }
    );

    const places = (response.data && response.data.places) || [];
    const results = places.map(mapNewToLegacy);
    await setCache(normalizedKey, results, SEARCH_CACHE_TTL_SECONDS);
    return results;
  } catch (error) {
    console.error('Google Places search error:', error.message);
    return [];
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

async function getPlaceDetails(placeId) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    console.error('GOOGLE_PLACES_API_KEY not set');
    return null;
  }

  const cacheKey = `places:details:${placeId}`;
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  try {
    const fieldMask = [
      'id',
      'displayName',
      'formattedAddress',
      'shortFormattedAddress',
      'addressComponents',
      'location',
      'types',
      'primaryType',
      'rating',
      'userRatingCount',
      'priceLevel',
      'websiteUri',
      'nationalPhoneNumber',
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
      'servesVegetarianFood',
      'outdoorSeating',
      'goodForChildren',
      'goodForGroups',
      'regularOpeningHours',
      'utcOffsetMinutes',
    ].join(',');

    const response = await axios.get(
      `${PLACES_API_BASE}/places/${placeId}`,
      {
        headers: {
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': fieldMask,
        },
        timeout: 10000,
      }
    );

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
          lat: (location && location.latitude) || 0,
          lng: (location && location.longitude) || 0,
        },
      },
      types: r.types || [],
      primary_type: r.primaryType || null,
      rating: r.rating || null,
      user_ratings_total: r.userRatingCount || null,
      price_level: r.priceLevel || null,
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
      outdoor_seating: r.outdoorSeating == null ? null : r.outdoorSeating,
      good_for_children: r.goodForChildren == null ? null : r.goodForChildren,
      good_for_groups: r.goodForGroups == null ? null : r.goodForGroups,
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
      utc_offset_minutes: typeof r.utcOffsetMinutes === 'number' ? r.utcOffsetMinutes : null,
    };

    await setCache(cacheKey, details, DETAILS_CACHE_TTL_SECONDS);
    return details;
  } catch (error) {
    console.error('Google Places details error:', error.message);
    return null;
  }
}

module.exports = { searchGooglePlaces, getPlaceDetails, findPlaceFromUrl };
