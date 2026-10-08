const fixture = require('./fixtures/city-geography-contract.json');
const { normalizeCity, cityFromAddress, resolvePinCity } = require('../enrich/cityNormalization');
const { extractLocation, extractLocationFromComponents, extractPlaceLocation } = require('../enrich/locationParser');

// Synthetic contracts only: exercise real pure helpers without provider calls.
const component = (long_name, type) => ({ long_name, short_name: '', types: [type] });
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(child => deepFreeze(child));
    Object.freeze(value);
  }
  return value;
}
deepFreeze(fixture);

describe('stored city cleanup', () => {
  test.each(fixture.storedCities)('preserves $raw', ({ raw, country, expected }) => {
    expect(normalizeCity(raw, country)).toBe(expected);
    expect(normalizeCity(raw)).toBe(expected);
    expect(normalizeCity(expected, country)).toBe(expected);
    expect(resolvePinCity(raw, null, country)).toBe(expected);
  });

  test.each(fixture.rejectedCities)('rejects address fragment $raw', ({ raw, country }) => {
    expect(normalizeCity(raw, country)).toBeNull();
    expect(normalizeCity(raw)).toBeNull();
    expect(resolvePinCity(raw, null, country)).toBeNull();
  });

  test('missing optional values stay unknown', () => {
    expect(normalizeCity(undefined)).toBeNull();
    expect(cityFromAddress(undefined)).toEqual({ city: null, region: null });
    expect(resolvePinCity(undefined, undefined)).toBeNull();
    expect(resolvePinCity('Ho Chi Minh City', undefined)).toBe('Ho Chi Minh City');
  });
});

describe('conservative address fallback', () => {
  test.each(fixture.addressCases)('$id', ({ address, country, expected }) => {
    expect(cityFromAddress(address)).toEqual(expected);
    expect(cityFromAddress(address, country)).toEqual(expected);
    expect(resolvePinCity(null, address, country)).toBe(expected.city);
    expect(resolvePinCity('Ground Floor', address, country)).toBe(expected.city);
  });

  test.each(fixture.unknownAddresses)('$id stays unresolved', ({ address, country }) => {
    expect(cityFromAddress(address)).toEqual({ city: null, region: null });
    expect(cityFromAddress(address, country)).toEqual({ city: null, region: null });
    expect(resolvePinCity(null, address, country)).toBeNull();
  });

  test.each(fixture.hintedAddresses)('$id', ({ address, country, expected }) => {
    expect(cityFromAddress(address, country)).toEqual(expected);
    expect(resolvePinCity(null, address, country)).toBe(expected.city);
  });

  test('a known US state is retained without inventing a missing city', () => {
    expect(cityFromAddress('Main Street, CA 94704, USA'))
      .toEqual({ city: null, region: 'CA' });
    expect(resolvePinCity(null, 'Main Street, CA 94704, USA')).toBeNull();
  });

  test('multiple untyped labels stay ambiguous even after state ZIP cleanup', () => {
    expect(cityFromAddress('Main Street, Berkeley, Oakland, CA 94704, USA'))
      .toEqual({ city: null, region: 'CA' });
  });

  test('a country hint does not override conflicting printed country evidence', () => {
    expect(cityFromAddress('Rue de Rivoli, Paris, France', 'Japan'))
      .toEqual({ city: null, region: null });
    expect(resolvePinCity(null, 'Rue de Rivoli, Paris, France', 'Japan')).toBeNull();
  });
});

describe('pin city resolution', () => {
  test.each(fixture.resolverCases)('$id', ({ city, address, country, expected }) => {
    expect(resolvePinCity(city, address, country)).toBe(expected);
  });
});

describe('location parser uses the city fallback contract', () => {
  test.each(fixture.addressCases)('$id', ({ address, country, expected }) => {
    const location = { country, ...expected };
    expect(extractLocation(address)).toEqual(location);
    const searchResult = deepFreeze({ formatted_address: address });
    expect(extractPlaceLocation(null, searchResult)).toEqual(location);
    expect(extractPlaceLocation({ address_components: [component(country, 'country')] }, searchResult))
      .toEqual(location);
  });

  test.each(fixture.unknownAddresses)('$id cannot acquire a city while saving', ({ address, country }) => {
    const expected = { country, city: null, region: null };
    expect(extractLocation(address || '')).toEqual(expected);
    expect(extractPlaceLocation(null, { formatted_address: address || '' })).toEqual(expected);
  });
});

describe('typed localities stay authoritative', () => {
  test.each(fixture.typedLocalities)('$id', row => {
    const components = deepFreeze([
      component('Main Street', 'route'),
      component('12345', 'postal_code'),
      component('Synthetic District', 'sublocality_level_1'),
      // The promoted administrative city has no competing county component.
      ...(row.type === 'administrative_area_level_1' ? [] : [component('Synthetic County', 'administrative_area_level_2')]),
      ...(row.region ? [component(row.region, 'administrative_area_level_1')] : []),
      component(row.city, row.type),
      component(row.country, 'country'),
    ]);
    const expected = { country: row.country, city: row.city, region: row.region };
    const before = JSON.stringify(components);
    for (const ordered of [components, [...components].reverse()]) {
      expect(extractLocationFromComponents(ordered)).toEqual(expected);
      const structured = deepFreeze({ address_components: ordered, formatted_address: row.address });
      const untyped = deepFreeze({ formatted_address: row.address });
      // Details and Search both exercise typed locality precedence over text.
      expect(extractPlaceLocation(structured, untyped)).toEqual(expected);
      expect(extractPlaceLocation(untyped, structured)).toEqual(expected);
    }
    expect(JSON.stringify(components)).toBe(before);
  });
});


test('structured country supports a partial printed address without promoting its street', () => {
  const details = { address_components: [{long_name:'Germany',short_name:'DE',types:['country']}],formatted_address:'Unter den Linden 77, 10117 Berlin' };
  expect(extractPlaceLocation(details)).toEqual({country:'Germany',city:'Berlin',region:null});
});
test.each(['Street', '姫路市', '9 de Julio'])('valid municipality survives read normalization: %s', city => {
  expect(resolvePinCity(city, '')).toBe(city);
});


describe('adversarial city regressions', () => {
  test.each([
    ['日本、千葉県市川市市川一丁目','Japan'],
    ['台灣，臺北市市場街','Taiwan'],
    ['France, Tokyo, Japan','France'],
    ['Japan, Tokyo, France','Japan'],
  ])('ambiguous/conflicting printed locality stays unresolved: %s', (address,country) => {
    expect(cityFromAddress(address,country).city).toBeNull();
  });
  test('an Irish town name is not a postal code', () => {
    expect(cityFromAddress('Main Street, Carrick on Shannon, Ireland').city).toBe('Carrick on Shannon');
    expect(cityFromAddress('Main Street, Dublin D6W F209, Ireland').city).toBe('Dublin');
  });
  test.each(['Main Street West','Main St NE','High Road North','Broadway Avenue South'])('directional street %s cannot be a city', city => {
    expect(resolvePinCity(city, `${city}, Berkeley, CA 94704, USA`, 'United States')).toBe('Berkeley');
  });
  test('a building ending in a district suffix is not a municipality', () => {
    expect(normalizeCity('大樓管理區','Taiwan')).toBeNull();
    expect(normalizeCity('姫路市','Japan')).toBe('姫路市');
    expect(normalizeCity('四日市市','Japan')).toBe('四日市市');
    expect(cityFromAddress('四日市市, Japan').city).toBe('四日市市');
  });
});
