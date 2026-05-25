// Derives a normalized cuisine label from Google Places `types[]` and
// `primaryType`. Returns one of CUISINES, 'other', or null:
//   - one of CUISINES: known cuisine for a restaurant/cafe
//   - 'other':         restaurant/cafe but no known cuisine matched
//   - null:            place isn't a restaurant/cafe — no cuisine signal
//
// Consolidations:
//   japanese      ← japanese / sushi / ramen
//   mediterranean ← mediterranean / greek / lebanese / middle_eastern / turkish
//   pizza         ← pizza_restaurant (kept as its own bucket — it's a culturally
//                   distinct intent, not just an Italian variant)
//   bbq           ← barbecue_restaurant

const { isRestaurantType, CAFE_TYPES } = require('./categories');

const CUISINES = [
  'american',
  'bbq',
  'chinese',
  'french',
  'indian',
  'italian',
  'japanese',
  'korean',
  'mediterranean',
  'mexican',
  'pizza',
  'seafood',
  'spanish',
  'thai',
  'vietnamese',
];

// Google `*_restaurant` (and a couple of bare-name) types → cuisine bucket.
// Anything that ends in `_restaurant` but isn't here flows to 'other'.
const TYPE_TO_CUISINE = {
  american_restaurant: 'american',
  barbecue_restaurant: 'bbq',
  chinese_restaurant: 'chinese',
  french_restaurant: 'french',
  greek_restaurant: 'mediterranean',
  indian_restaurant: 'indian',
  italian_restaurant: 'italian',
  japanese_restaurant: 'japanese',
  korean_restaurant: 'korean',
  lebanese_restaurant: 'mediterranean',
  mediterranean_restaurant: 'mediterranean',
  mexican_restaurant: 'mexican',
  middle_eastern_restaurant: 'mediterranean',
  pizza_restaurant: 'pizza',
  ramen_restaurant: 'japanese',
  seafood_restaurant: 'seafood',
  spanish_restaurant: 'spanish',
  steak_house: 'steakhouse',
  sushi_restaurant: 'japanese',
  thai_restaurant: 'thai',
  turkish_restaurant: 'mediterranean',
  vietnamese_restaurant: 'vietnamese',
};

// 'steakhouse' isn't in the 15-cuisine list above on purpose — Google's
// `steak_house` is the only place it appears and we treat it as a bucket
// under restaurant rather than a cuisine. If we ever surface it as a cuisine
// chip, add it to CUISINES.

function isFoodEstablishment(types) {
  if (!Array.isArray(types) || types.length === 0) return false;
  return types.some(isRestaurantType) || types.some((t) => CAFE_TYPES.has(t));
}

function extractCuisine(types, primaryType) {
  const allTypes = Array.isArray(types) ? types : [];
  // primaryType participates in the lookup but isn't treated as authoritative
  // for the food-establishment check — sometimes Google returns a cuisine
  // primaryType alongside non-restaurant types arrays.
  const candidatesInOrder = primaryType ? [primaryType, ...allTypes] : allTypes;

  if (!isFoodEstablishment(allTypes) && !(primaryType && (isRestaurantType(primaryType) || CAFE_TYPES.has(primaryType)))) {
    return null;
  }

  for (const t of candidatesInOrder) {
    if (typeof t === 'string' && TYPE_TO_CUISINE[t]) {
      const cuisine = TYPE_TO_CUISINE[t];
      // steakhouse falls through to 'other' since it's not in the user-facing
      // CUISINES list. Easier to widen later than narrow.
      if (CUISINES.includes(cuisine)) return cuisine;
    }
  }
  return 'other';
}

module.exports = {
  extractCuisine,
  CUISINES,
  TYPE_TO_CUISINE,
};
