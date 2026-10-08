const fixture = require('./fixtures/geography-contract.json');
const countryNames = require('../enrich/countryNames.json');
const { normalizeCountry, normalizeCountryCode, countryFromAddress, resolvePinCountry } = require('../enrich/countryNormalization');
const { extractLocation, extractLocationFromComponents, extractPlaceLocation } = require('../enrich/locationParser');

const component = (long_name, type, short_name = '') => ({ long_name, short_name, types: [type] });

// Both repositories use byte-identical synthetic fixtures. These contracts call
// only pure local helpers; they do not claim to replay verified provider data.

describe('trusted country catalog', () => {
  test('pins every trusted catalog code so removals cannot silently reduce coverage', () => {
    expect(Object.keys(countryNames).sort()).toEqual(fixture.trustedCountries.map(item => item.code).sort());
  });

  test.each(fixture.trustedCountries)
  ('$code recognizes its short code and every pinned name', ({ code, country }) => {
    const names = countryNames[code];
    expect(names?.[0]).toBe(country);
    const fullWidthCode = [...code].map(letter => String.fromCharCode(letter.charCodeAt(0) + 0xFEE0)).join('');
    for (const shortCode of [code, ` ${code.toLowerCase()} `, fullWidthCode]) {
      expect(normalizeCountryCode(shortCode)).toBe(country);
      // An unrecognized/absent long name must not discard a trusted short code.
      for (const longName of ['', 'Synthetic unlisted country label']) {
        expect(extractLocationFromComponents([component(longName, 'country', shortCode)]).country).toBe(country);
      }
      // The same code on an administrative component is not country evidence.
      expect(extractLocationFromComponents([
        component('Synthetic Administrative Area', 'administrative_area_level_1', shortCode),
      ]).country).toBeNull();
    }
    for (const name of names) {
      expect({ name, country: normalizeCountry(name) }).toEqual({ name, country });
      expect(extractLocationFromComponents([component(name, 'country', code)]).country).toBe(country);
    }
  });

  test.each([null, undefined, ...fixture.unknownCodes])('rejects unknown structured short code %j', code => {
    expect(normalizeCountryCode(code)).toBeNull();
    expect(extractLocationFromComponents([
      component('Synthetic unlisted country label', 'country', code || ''),
    ]).country).toBeNull();
  });
});

describe('synthetic representative country and address matrix', () => {
  test.each(fixture.regions.flatMap(row => row.countryInputs.map(input => ({
    code: row.code, country: row.country, input,
  }))))('$code canonicalizes $input', ({ country, input }) => {
    expect(normalizeCountry(input)).toBe(country);
    expect(normalizeCountry(`  ${input}  `)).toBe(country);
    expect(normalizeCountry(input.normalize('NFD'))).toBe(country);
    expect(resolvePinCountry(input, null)).toBe(country);
    expect(normalizeCountry(normalizeCountry(input))).toBe(country);
  });

  test.each(fixture.regions.flatMap(row => row.addresses.map(address => ({
    code: row.code, country: row.country, address,
  }))))('$code recovers country only from an explicit boundary: $address', ({ country, address }) => {
    for (const formatted of [address, `, \n${address}, \n`]) {
      expect(countryFromAddress(formatted)).toBe(country);
      // Country-first freeform addresses do not promise reliable city parsing.
      expect(extractLocation(formatted).country).toBe(country);
      expect(resolvePinCountry(null, formatted)).toBe(country);
      expect(resolvePinCountry('Synthetic Tower 9F', formatted)).toBe(country);
    }
  });

  test.each(fixture.regions)('$code keeps structured city and region independent of component order', row => {
    // Pin expected English identities independently of the production catalog.
    expect(normalizeCountryCode(row.code)).toBe(row.country);
    const before = JSON.stringify(row.components);
    for (const components of [row.components, [...row.components].reverse(), [
      ...row.components.slice(1), row.components[0],
    ]]) {
      expect(extractLocationFromComponents(components)).toEqual(row.expectedLocation);
    }
    expect(JSON.stringify(row.components)).toBe(before);
  });

  test.each(fixture.regions)('$code preserves Search geography when Details are missing or partial', row => {
    const searchResult = { address_components: row.components, formatted_address: row.addresses[0] };
    const variants = [
      null,
      {},
      { address_components: [] },
      { address_components: [component('', 'country')] },
      { address_components: row.components.filter(item => item.types.includes('country')) },
      { address_components: [component('12345', 'postal_code')] },
      // Printed address text must never outrank a real structured city/country.
      { formatted_address: 'France, Synthetic Warehouse, 41 Example Road' },
    ];
    const before = JSON.stringify({ searchResult, variants });
    for (const [variant, details] of variants.entries()) {
      expect({ variant, location: extractPlaceLocation(details, searchResult) })
        .toEqual({ variant, location: row.expectedLocation });
    }
    expect(JSON.stringify({ searchResult, variants })).toBe(before);
  });

  test.each(fixture.placeCases)('$id', ({ details, searchResult, expected }) => {
    expect(extractPlaceLocation(details, searchResult)).toEqual(expected);
  });

  test.each(fixture.obviousFormattedLocations)('retains an obvious formatted city: $address', ({ address, expected }) => {
    expect(extractLocation(address)).toEqual(expected);
    expect(extractPlaceLocation(null, { formatted_address: address })).toEqual(expected);
  });
});

describe('unknown and ambiguous geography', () => {
  test.each([null, undefined, ...fixture.unknownFragments])('does not turn a fragment into a country: %j', fragment => {
    expect(normalizeCountry(fragment)).toBeNull();
    expect(countryFromAddress(fragment)).toBeNull();
    expect(extractLocation(fragment || '').country).toBeNull();
    expect(resolvePinCountry(fragment, fragment)).toBeNull();
  });

  test.each(fixture.unknownAddresses)('keeps uncertain address country null: %s', address => {
    expect(countryFromAddress(address)).toBeNull();
    expect(extractLocation(address).country).toBeNull();
    expect(resolvePinCountry('Synthetic Tower 9F', address)).toBeNull();
    expect(extractPlaceLocation(null, { formatted_address: address }).country).toBeNull();
  });

  test.each(fixture.ambiguousCodes)('$code is a country only on a trusted country component', ({ code, country, state }) => {
    expect(normalizeCountry(code)).toBeNull();
    expect(normalizeCountry(`${code} 12345`)).toBeNull();
    expect(countryFromAddress(`41 Example Road, ${code}`)).toBeNull();
    expect(countryFromAddress(`${code}, 41 Example Road`)).toBeNull();
    expect(extractLocationFromComponents([component(state, 'administrative_area_level_1', code)]).country).toBeNull();
    expect(extractLocationFromComponents([component('', 'country', code)]).country).toBe(country);
    expect(resolvePinCountry(code, `41 Example Road, ${state}, USA`)).toBe('United States');
  });

  test('Georgia requires a trusted country field; a freeform boundary is ambiguous', () => {
    expect(normalizeCountry('Georgia')).toBe('Georgia');
    expect(extractLocationFromComponents([component('', 'country', 'GE')]).country).toBe('Georgia');
    expect(countryFromAddress('41 Example Road, Georgia')).toBeNull();
    expect(countryFromAddress('Georgia, 41 Example Road')).toBeNull();
  });

  test('a valid stored country wins over conflicting printed country text', () => {
    expect(resolvePinCountry('台灣', '41 Example Road, Japan')).toBe('Taiwan');
    expect(resolvePinCountry('USA', 'France, 41 Example Road')).toBe('United States');
  });

  test('repeated equal boundary countries agree; differing countries stay unknown', () => {
    expect(countryFromAddress('日本，41 Example Road，Japan')).toBe('Japan');
    expect(countryFromAddress('日本，41 Example Road，France')).toBeNull();
  });
});


test('Irish country postal suffixes require an actual routing-code shape', () => {
  expect(normalizeCountry('Ireland Shannon')).toBeNull();
  expect(normalizeCountry('Ireland D02 X285')).toBe('Ireland');
  expect(normalizeCountry('Ireland D6W F209')).toBe('Ireland');
});
