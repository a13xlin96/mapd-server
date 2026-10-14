const {extractLocationFromComponents, extractPlaceLocation, extractLocation} = require('../enrich/locationParser');
const component = (long_name, type) => ({long_name, types:[type]});
const taipei = [component('Shilin District','sublocality_level_1'), component('11160','postal_code'), component('Taipei City','administrative_area_level_1'), component('Taiwan','country')];
test.each([null, {}, {address_components:[]}, {address_components:[{types:['country'],long_name:''}]}])('keeps structured Search geography when Details are unavailable/empty: %j', details => {
  expect(extractPlaceLocation(details,{address_components:taipei,formatted_address:'10 Road, Shilin District, Taipei City, Taiwan 11160'})).toEqual({country:'Taiwan',city:'Taipei City',region:null});
});
test('partial details are supplemented by Search components, not printed address parsing', () => {
  expect(extractPlaceLocation({address_components:[component('Taiwan','country')]},{address_components:taipei})).toEqual({country:'Taiwan',city:'Taipei City',region:null});
});
test('locality wins over county regardless of component order', () => {
  const components = [component('Alameda County','administrative_area_level_2'),component('California','administrative_area_level_1'),component('Berkeley','locality'),component('United States','country')];
  for (const rows of [components,[...components].reverse()]) expect(extractLocationFromComponents(rows)).toEqual({country:'United States',region:'California',city:'Berkeley'});
});
test('postal town precedes county; localized names remain intact', () => {
  expect(extractLocationFromComponents([component('Greater London','administrative_area_level_2'),component('London','postal_town')]).city).toBe('London');
  expect(extractLocationFromComponents([component('京都市','locality'),component('日本','country')])).toEqual({country:'Japan',region:null,city:'京都市'});
});
test('malformed components cannot fail a save', () => {
  expect(extractLocationFromComponents([null,{}, {types:[]},component('Kyoto','locality')]).city).toBe('Kyoto');
});
test.each(['Taiwan 111','Taiwan 11160','taiwan 111','TW','Taiwan11160'])('legacy formatted fallback strips postal suffix: %s', country => {
  expect(extractLocation(`1 Main Road, Taipei City, ${country}`).country).toBe('Taiwan');
});
test('country aliases and postal cleanup do not mutilate real multiword names', () => {
  expect(extractLocation('London, UK SW1A 1AA').country).toBe('United Kingdom');
  expect(extractLocation("Abidjan, Côte d'Ivoire").country).toBe("Côte d'Ivoire");
  expect(extractPlaceLocation(null,{})).toEqual({country:null,region:null,city:null});
});

test('country-only Search components preserve cached formatted city and region', () => {
  expect(extractPlaceLocation({formatted_address:'1 Main Street, Berkeley, CA, USA'}, {address_components:[component('United States','country')]}))
    .toEqual({country:'United States',city:'Berkeley',region:'CA'});
});
test('structured city keeps its priority and never acquires a district as its region from printed text', () => {
  expect(extractPlaceLocation(null,{address_components:taipei,formatted_address:'10 Road, Shilin District, Taipei City, Taiwan 11160'}))
    .toEqual({country:'Taiwan',city:'Taipei City',region:null});
});

test.each(['Japan 〒100','Japan〒100','Japan100'])('postal markers remain attached to the code during normalization: %s', country => {
  expect(extractLocation(`Tokyo, ${country}`).country).toBe('Japan');
});

test.each(['2-chōme-8-１ ３ KHビル 1F','70號B1','8-chōme-2-１６ FPG links GINZA Corridor B1F'])('never saves a building fragment as country: %s', fragment => {
  expect(extractLocation(fragment).country).toBeNull();
  expect(extractLocation(`Japan, Tokyo, ${fragment}`).country).toBe('Japan');
});
test('country-first Japanese-script and Taiwan country-last addresses recover only explicit country names', () => {
  expect(extractLocation('日本、〒100-0001 東京都、2-chōme-8-１ ３ KHビル 1F').country).toBe('Japan');
  expect(extractLocation('70號B1, Taipei City, Taiwan 11160').country).toBe('Taiwan');
  expect(extractLocation('1 Main Street, CA 90210').country).toBeNull();
  expect(extractLocation('Japan Road, London').country).toBeNull();
  expect(extractLocation('Japan, 1 Main Street, France').country).toBeNull();
});
test('structured ISO country code supports localized country names outside the pinned display languages', () => {
  expect(extractLocationFromComponents([{long_name:'Allemagne',short_name:'DE',types:['country']}]).country).toBe('Germany');
});
test('structured country wins over old formatted text, including when only a short code is available', () => {
  expect(extractPlaceLocation(null,{address_components:[{long_name:'',short_name:'JP',types:['country']}],formatted_address:'1 Main Street, France'}).country).toBe('Japan');
});

test.each(['Japan 1F','Japan B1F','CA 90210','CA90210','constructor','__proto__'])('does not mistake floor labels or state codes for countries: %s', fragment => {
  expect(extractLocation(`1 Main Street, ${fragment}`).country).toBeNull();
});

const { normalizeCountry, countryFromAddress, resolvePinCountry } = require('../enrich/countryNormalization');

test.each(['CA', 'IN', 'AL', 'MA'])('legacy state codes must not become countries: %s', code => {
  expect(normalizeCountry(code)).toBeNull();
  expect(resolvePinCountry(code, `1 Main Street, ${code}, USA`)).toBe('United States');
});
test.each([
  ['Myanmar', 'Myanmar'],
  ['Burma', 'Myanmar'],
  ['Democratic Republic of the Congo', 'Democratic Republic of the Congo'],
  ['Republic of the Congo', 'Republic of the Congo'],
  ['Saint Vincent and the Grenadines', 'Saint Vincent and the Grenadines'],
  ['St. Vincent & Grenadines', 'Saint Vincent and the Grenadines'],
])('preserves alternate country names: %s', (raw, country) => {
  expect(normalizeCountry(raw)).toBe(country);
  expect(countryFromAddress(`1 Main Street, ${raw}`)).toBe(country);
});
test.each([
  ['Poland 00-001', 'Poland'], ['Sweden 111 22', 'Sweden'],
  ['Slovakia 811 01', 'Slovakia'], ['Czechia 110 00', 'Czechia'],
])('preserves countries with grouped numeric postcodes: %s', (raw, country) => {
  expect(normalizeCountry(raw)).toBe(country);
  expect(countryFromAddress(`1 Main Street, ${raw}`)).toBe(country);
});

test.each(['Luxembourg', 'Singapore'])('keeps a city with the same name as its country: %s', country => {
  expect(extractLocation(`${country}, ${country}`)).toEqual({country, city:country, region:null});
});
test('only structured country components may translate otherwise ambiguous short codes', () => {
  expect(extractLocationFromComponents([{long_name:'', short_name:'CA', types:['country']}]).country).toBe('Canada');
  expect(extractLocationFromComponents([{long_name:'Indiana', short_name:'IN', types:['administrative_area_level_1']}]).country).toBeNull();
});

test.each(['Paris, France\n', 'Paris, France,', ',Paris, France', 'France, Paris,'])('empty address segments do not displace the city: %s', address => {
  expect(extractLocation(address)).toEqual({country:'France', city:'Paris', region:null});
});


test('partial Details text cannot hide complete Search geography', () => {
  expect(extractPlaceLocation({formatted_address:'10 Main Street, Springfield'}, {formatted_address:'10 Main Street, Springfield, IL, USA'}))
    .toEqual({country:'United States',city:'Springfield',region:'IL'});
});
test('country-only components never promote a numbered street to city', () => {
  expect(extractPlaceLocation({address_components:[{long_name:'Germany',short_name:'DE',types:['country']}],formatted_address:'Unter den Linden 77, 10117 Berlin, Germany'}))
    .toEqual({country:'Germany',city:'Berlin',region:null});
});
test('structured numeric city names stay intact; conflicting fallback countries are not mixed', () => {
  expect(extractPlaceLocation({address_components:[{long_name:'District 1',short_name:'District 1',types:['locality']},{long_name:'Vietnam',short_name:'VN',types:['country']}]}).city).toBe('District 1');
  expect(extractPlaceLocation({address_components:[{long_name:'Germany',short_name:'DE',types:['country']}]},{formatted_address:'Paris, France'}))
    .toEqual({country:'Germany',city:null,region:null});
});
