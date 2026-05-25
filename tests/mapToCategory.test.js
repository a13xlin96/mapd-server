// mapToCategory — locks in the new 3-way food split and the night_club move
// from entertainment to bar. The cuisine-specific *_restaurant suffix catch
// is what makes new Google cuisine types automatically land in `restaurant`.

const { mapToCategory, isRestaurantType } = require('../enrich/categories');

describe('mapToCategory — 3-way food split', () => {
  test('restaurant bucket: plain restaurant + all cuisine subtypes', () => {
    expect(mapToCategory(['restaurant'])).toBe('restaurant');
    expect(mapToCategory(['italian_restaurant'])).toBe('restaurant');
    expect(mapToCategory(['sushi_restaurant', 'japanese_restaurant'])).toBe('restaurant');
    expect(mapToCategory(['pizza_restaurant'])).toBe('restaurant');
    expect(mapToCategory(['barbecue_restaurant'])).toBe('restaurant');
    expect(mapToCategory(['steak_house'])).toBe('restaurant');
    expect(mapToCategory(['meal_takeaway'])).toBe('restaurant');
    expect(mapToCategory(['fast_food_restaurant'])).toBe('restaurant');
    expect(mapToCategory(['bar_and_grill'])).toBe('restaurant');
  });

  test('cafe bucket: cafe, coffee_shop, bakery, dessert variants', () => {
    expect(mapToCategory(['cafe'])).toBe('cafe');
    expect(mapToCategory(['coffee_shop'])).toBe('cafe');
    expect(mapToCategory(['bakery'])).toBe('cafe');
    expect(mapToCategory(['ice_cream_shop'])).toBe('cafe');
    expect(mapToCategory(['dessert_shop'])).toBe('cafe');
    expect(mapToCategory(['sandwich_shop'])).toBe('cafe');
    expect(mapToCategory(['bagel_shop'])).toBe('cafe');
  });

  test('bar bucket: bar, wine_bar, pub, and night_club (moved from entertainment)', () => {
    expect(mapToCategory(['bar'])).toBe('bar');
    expect(mapToCategory(['wine_bar'])).toBe('bar');
    expect(mapToCategory(['pub'])).toBe('bar');
    expect(mapToCategory(['night_club'])).toBe('bar');
  });

  test('ordering: bar_and_grill resolves to restaurant (not bar)', () => {
    // bar_and_grill is more food-leaning. Order in mapToCategory checks
    // restaurant before bar, so this lands in restaurant.
    expect(mapToCategory(['bar_and_grill', 'restaurant'])).toBe('restaurant');
  });

  test('mixed types: first matching bucket wins', () => {
    // A place tagged restaurant + cafe lands in restaurant.
    expect(mapToCategory(['cafe', 'restaurant'])).toBe('restaurant');
    // A place tagged cafe + bar lands in cafe.
    expect(mapToCategory(['cafe', 'bar'])).toBe('cafe');
  });

  test('non-food buckets unchanged from prior taxonomy', () => {
    expect(mapToCategory(['lodging'])).toBe('accommodation');
    expect(mapToCategory(['museum'])).toBe('attraction');
    expect(mapToCategory(['park'])).toBe('nature');
    expect(mapToCategory(['shopping_mall'])).toBe('shopping');
    expect(mapToCategory(['spa'])).toBe('wellness');
    expect(mapToCategory(['movie_theater'])).toBe('entertainment');
    expect(mapToCategory(['bowling_alley'])).toBe('entertainment');
  });

  test('falls through to "other" for unknown types', () => {
    expect(mapToCategory(['random_unknown_type'])).toBe('other');
    expect(mapToCategory([])).toBe('other');
    expect(mapToCategory(null)).toBe('other');
    expect(mapToCategory(undefined)).toBe('other');
  });

  test('unknown *_restaurant suffix lands in restaurant via the generic check', () => {
    // Hypothetical future Google cuisine type — no code change needed to catch.
    expect(mapToCategory(['ethiopian_restaurant'])).toBe('restaurant');
    expect(mapToCategory(['afghan_restaurant'])).toBe('restaurant');
  });

  // Regression: pre-v3 backfilled pins have types:[] but a valid primaryType.
  // The 2026-05-25 dry-run found 80% of the legacy food cohort hit this
  // pattern. Without the primaryType fallback, all of them get misclassified
  // as 'other' and skipped by the backfill.
  test('primaryType fallback: classifies pins whose types[] is empty', () => {
    expect(mapToCategory([], 'italian_restaurant')).toBe('restaurant');
    expect(mapToCategory([], 'bakery')).toBe('cafe');
    expect(mapToCategory([], 'coffee_shop')).toBe('cafe');
    expect(mapToCategory([], 'wine_bar')).toBe('bar');
    expect(mapToCategory([], 'asian_restaurant')).toBe('restaurant');
    expect(mapToCategory([], 'museum')).toBe('attraction');
  });

  test('primaryType fallback: null when both types and primaryType are unhelpful', () => {
    expect(mapToCategory([], null)).toBe('other');
    expect(mapToCategory([], '')).toBe('other');
    expect(mapToCategory([], undefined)).toBe('other');
    expect(mapToCategory(null, null)).toBe('other');
    expect(mapToCategory([], 'totally_unknown_type')).toBe('other');
  });

  test('primaryType fills in only when types[] is empty OR returns "other"', () => {
    // types[] has only generic tokens → classification is 'other' → fall back.
    expect(mapToCategory(['point_of_interest', 'establishment'], 'italian_restaurant')).toBe('restaurant');
    // Both agree — types still classifies first; outcome same.
    expect(mapToCategory(['cafe'], 'coffee_shop')).toBe('cafe');
    // De-dup harmless even with fallback semantics.
    expect(mapToCategory(['restaurant'], 'restaurant')).toBe('restaurant');
  });

  test('CONFLICT: types[] wins when it produces a definite classification', () => {
    // The crux of the R1 hotfix-review finding: do NOT silently re-migrate
    // a clear bar into a restaurant just because primaryType says otherwise.
    expect(mapToCategory(['wine_bar'], 'italian_restaurant')).toBe('bar');
    expect(mapToCategory(['cafe'], 'sushi_restaurant')).toBe('cafe');
    expect(mapToCategory(['museum'], 'italian_restaurant')).toBe('attraction');
    // Multiple types — restaurant has internal precedence over bar, but only
    // because BOTH come from types[]. primaryType doesn't change that.
    expect(mapToCategory(['bar', 'restaurant'], 'wine_bar')).toBe('restaurant');
  });
});

describe('isRestaurantType', () => {
  test('matches enumerated restaurant types', () => {
    expect(isRestaurantType('restaurant')).toBe(true);
    expect(isRestaurantType('meal_takeaway')).toBe(true);
    expect(isRestaurantType('steak_house')).toBe(true);
  });

  test('matches any string ending in _restaurant', () => {
    expect(isRestaurantType('italian_restaurant')).toBe(true);
    expect(isRestaurantType('hypothetical_future_restaurant')).toBe(true);
  });

  test('rejects non-restaurant types', () => {
    expect(isRestaurantType('cafe')).toBe(false);
    expect(isRestaurantType('bar')).toBe(false);
    expect(isRestaurantType('park')).toBe(false);
  });

  test('handles non-string input safely', () => {
    expect(isRestaurantType(null)).toBe(false);
    expect(isRestaurantType(undefined)).toBe(false);
    expect(isRestaurantType(42)).toBe(false);
  });
});
