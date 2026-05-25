// extractCuisine — taxonomy mapping verifier. Locks in the consolidations
// (japanese ← sushi/ramen, mediterranean ← greek/lebanese/etc.) and the
// null-vs-'other'-vs-cuisine return contract.

const { extractCuisine, CUISINES } = require('../enrich/cuisine');

describe('extractCuisine', () => {
  test('returns null for non-food places', () => {
    expect(extractCuisine(['park', 'natural_feature'], 'park')).toBeNull();
    expect(extractCuisine(['lodging'], 'lodging')).toBeNull();
    expect(extractCuisine(['museum', 'tourist_attraction'], 'museum')).toBeNull();
  });

  test('returns null for empty or invalid input', () => {
    expect(extractCuisine([], null)).toBeNull();
    expect(extractCuisine(null, null)).toBeNull();
    expect(extractCuisine(undefined, undefined)).toBeNull();
  });

  test('returns "other" for restaurants without a known cuisine', () => {
    // bar_and_grill is a restaurant by category but not in TYPE_TO_CUISINE.
    expect(extractCuisine(['restaurant', 'bar_and_grill'], 'bar_and_grill')).toBe('other');
    // Generic restaurant with no cuisine tag.
    expect(extractCuisine(['restaurant', 'establishment'], 'restaurant')).toBe('other');
    // Cafe-style place — qualifies as food, no cuisine match.
    expect(extractCuisine(['cafe', 'food'], 'cafe')).toBe('other');
  });

  test.each([
    ['italian_restaurant', 'italian'],
    ['mexican_restaurant', 'mexican'],
    ['chinese_restaurant', 'chinese'],
    ['american_restaurant', 'american'],
    ['thai_restaurant', 'thai'],
    ['french_restaurant', 'french'],
    ['indian_restaurant', 'indian'],
    ['korean_restaurant', 'korean'],
    ['vietnamese_restaurant', 'vietnamese'],
    ['spanish_restaurant', 'spanish'],
    ['seafood_restaurant', 'seafood'],
    ['pizza_restaurant', 'pizza'],
  ])('direct mapping %s → %s', (type, expected) => {
    expect(extractCuisine([type], type)).toBe(expected);
  });

  test('japanese consolidation: japanese / sushi / ramen all map to japanese', () => {
    expect(extractCuisine(['japanese_restaurant'], 'japanese_restaurant')).toBe('japanese');
    expect(extractCuisine(['sushi_restaurant'], 'sushi_restaurant')).toBe('japanese');
    expect(extractCuisine(['ramen_restaurant'], 'ramen_restaurant')).toBe('japanese');
  });

  test('mediterranean consolidation: greek / lebanese / middle_eastern / turkish map to mediterranean', () => {
    expect(extractCuisine(['greek_restaurant'], 'greek_restaurant')).toBe('mediterranean');
    expect(extractCuisine(['lebanese_restaurant'], 'lebanese_restaurant')).toBe('mediterranean');
    expect(extractCuisine(['middle_eastern_restaurant'], 'middle_eastern_restaurant')).toBe('mediterranean');
    expect(extractCuisine(['turkish_restaurant'], 'turkish_restaurant')).toBe('mediterranean');
    expect(extractCuisine(['mediterranean_restaurant'], 'mediterranean_restaurant')).toBe('mediterranean');
  });

  test('bbq consolidation: barbecue_restaurant maps to bbq', () => {
    expect(extractCuisine(['barbecue_restaurant'], 'barbecue_restaurant')).toBe('bbq');
  });

  test('steak_house falls through to "other" (not in CUISINES list)', () => {
    expect(extractCuisine(['steak_house'], 'steak_house')).toBe('other');
  });

  test('prefers primaryType over types[] order when both match', () => {
    // types[] has italian first, but primaryType is japanese — japanese wins.
    expect(extractCuisine(
      ['italian_restaurant', 'japanese_restaurant'],
      'japanese_restaurant',
    )).toBe('japanese');
  });

  test('falls back to types[] order when primaryType has no cuisine', () => {
    expect(extractCuisine(
      ['restaurant', 'italian_restaurant'],
      'restaurant',
    )).toBe('italian');
  });

  test('handles primaryType being a known cuisine when types is empty', () => {
    expect(extractCuisine([], 'italian_restaurant')).toBe('italian');
  });

  test('CUISINES list matches plan: 15 named cuisines', () => {
    expect(CUISINES).toHaveLength(15);
    expect(CUISINES).toEqual(expect.arrayContaining([
      'american', 'bbq', 'chinese', 'french', 'indian', 'italian', 'japanese',
      'korean', 'mediterranean', 'mexican', 'pizza', 'seafood', 'spanish',
      'thai', 'vietnamese',
    ]));
  });
});
