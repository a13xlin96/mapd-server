// Splits Google Places `types[]` into the user-facing category buckets.
// `food` was previously a single bucket covering restaurants, cafes, AND
// bars. Now split into three: `restaurant`, `cafe`, `bar`. Old pins still
// carry `category: 'food'` until the backfill runs; the client treats `food`
// as an alias for any of restaurant/cafe/bar during that window.

const RESTAURANT_TYPES = new Set([
  'restaurant',
  'meal_takeaway',
  'meal_delivery',
  'fast_food_restaurant',
  'food_court',
  'bar_and_grill',
  'steak_house',
  'barbecue_restaurant',
  'pizza_restaurant',
]);

const CAFE_TYPES = new Set([
  'cafe',
  'coffee_shop',
  'bakery',
  'ice_cream_shop',
  'dessert_shop',
  'sandwich_shop',
  'bagel_shop',
]);

const BAR_TYPES = new Set([
  'bar',
  'wine_bar',
  'pub',
  'night_club',
]);

const ACCOMMODATION_TYPES = new Set(['lodging', 'campground', 'motel', 'resort']);
const ATTRACTION_TYPES = new Set([
  'tourist_attraction', 'museum', 'art_gallery', 'amusement_park', 'zoo', 'aquarium', 'stadium',
]);
const NATURE_TYPES = new Set(['park', 'natural_feature', 'hiking_area']);
const SHOPPING_TYPES = new Set([
  'shopping_mall', 'store', 'clothing_store', 'book_store', 'supermarket',
]);
const WELLNESS_TYPES = new Set(['spa', 'gym', 'beauty_salon', 'hair_care']);
// `night_club` moved out of entertainment into `bar`. Remaining entertainment
// types are the non-drinking nightlife/leisure venues.
const ENTERTAINMENT_TYPES = new Set(['movie_theater', 'bowling_alley', 'casino', 'concert_hall']);

// Google's cuisine-specific subtypes (italian_restaurant, sushi_restaurant,
// etc.) aren't enumerated above — the suffix check catches them generically
// so future Google additions land in `restaurant` without code changes.
function isRestaurantType(t) {
  if (typeof t !== 'string') return false;
  return RESTAURANT_TYPES.has(t) || t.endsWith('_restaurant');
}

function mapToCategory(types) {
  if (!Array.isArray(types) || types.length === 0) return 'other';
  if (types.some(isRestaurantType)) return 'restaurant';
  if (types.some((t) => CAFE_TYPES.has(t))) return 'cafe';
  if (types.some((t) => BAR_TYPES.has(t))) return 'bar';
  if (types.some((t) => ACCOMMODATION_TYPES.has(t))) return 'accommodation';
  if (types.some((t) => ATTRACTION_TYPES.has(t))) return 'attraction';
  if (types.some((t) => NATURE_TYPES.has(t))) return 'nature';
  if (types.some((t) => SHOPPING_TYPES.has(t))) return 'shopping';
  if (types.some((t) => WELLNESS_TYPES.has(t))) return 'wellness';
  if (types.some((t) => ENTERTAINMENT_TYPES.has(t))) return 'entertainment';
  return 'other';
}

module.exports = {
  mapToCategory,
  isRestaurantType,
  RESTAURANT_TYPES,
  CAFE_TYPES,
  BAR_TYPES,
};
