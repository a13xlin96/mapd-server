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
test.each(['Taiwan 111','Taiwan 11160','taiwan 111','TW'])('legacy formatted fallback strips postal suffix: %s', country => {
  expect(extractLocation(`1 Main Road, Taipei City, ${country}`).country).toBe('Taiwan');
});
test('country aliases and postal cleanup do not mutilate real multiword names', () => {
  expect(extractLocation('London, UK SW1A 1AA').country).toBe('United Kingdom');
  expect(extractLocation("Abidjan, Côte d'Ivoire").country).toBe("Côte d'Ivoire");
  expect(extractPlaceLocation(null,{})).toEqual({country:null,region:null,city:null});
});
