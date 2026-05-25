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
