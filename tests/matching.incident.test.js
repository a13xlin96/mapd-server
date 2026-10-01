const {createPlaceMatcher} = require('../enrich/placeMatching');
const {rankPlaces} = require('../enrich/confidence');

const component = (long_name, type, short_name = long_name) => ({long_name, short_name, types:[type]});
// Public cached Maps record for the rejected Taipei venue. Identity/coordinates
// are synthetic; mixed-script name/address and component shapes are preserved.
const englishTaipei = {
  place_id:'taipei-venue', name:'清河鵝肉',
  formatted_address:'No. 10號, Lane 129, Dexing E Rd, Shilin District, Taipei City, Taiwan 111',
  geometry:{location:{lat:25.10845,lng:121.52924}},
  address_components:[component('10號','street_number'),component('Lane 129, Dexing East Road','route'),
    component('Sanyu Village','administrative_area_level_3'),component('Shilin District','administrative_area_level_2'),
    component('Taipei City','administrative_area_level_1'),component('Taiwan','country','TW'),component('111','postal_code')],
};
const localTaipei = {...englishTaipei, formatted_address:'111台灣台北市士林區德行東路129巷10號',
  address_components:[component('10號','street_number'),component('德行東路129巷','route'),
    component('三玉里','administrative_area_level_3'),component('士林區','administrative_area_level_2'),
    component('台北市','administrative_area_level_1'),component('台灣','country','TW'),component('111','postal_code')]};
const source = {name:'清河鵝肉',city:'臺北市',source:'caption'};
const evidence = {description:'清河鵝肉 臺北市美食'};

test('a Chinese street-number suffix cannot hide English city components from language recovery',async()=>{
  const search=jest.fn(async()=>[localTaipei]);
  const match=await createPlaceMatcher(search)([englishTaipei],evidence,source,'清河鵝肉 臺北市');
  expect(search).toHaveBeenCalledTimes(1);
  expect(match.place?.place_id).toBe('taipei-venue');
  expect(match.requiresSelection).toBe(true);
});

test.each([localTaipei,{...localTaipei,address_components:undefined}])('Taiwan locality spelling variants retain confirmation without altering venue names',row=>{
  const result=rankPlaces([row],evidence,source);
  expect(result.place?.place_id).toBe('taipei-venue');
  expect(result.requiresSelection).toBe(true);
  expect(result.ranked[0].evidence.aliasRecovery).toBe(true);
});

test('Taiwan locality spelling recovery never maps Taipei to New Taipei or rewrites a venue name',()=>{
  const otherCity={...localTaipei,formatted_address:'台灣新北市中和區民治街10號',
    address_components:[component('新北市','administrative_area_level_1'),component('台灣','country','TW')]};
  expect(rankPlaces([otherCity],evidence,source).place).toBeNull();
  expect(rankPlaces([{...localTaipei,name:'另一家鵝肉'}],evidence,source).place).toBeNull();
});

test('native city mismatch does not buy another lookup simply because the source names Taiwan',async()=>{
  const search=jest.fn();
  const row={...localTaipei,formatted_address:'台灣台南市中西區民治街10號',
    address_components:[component('台南市','administrative_area_level_1'),component('台灣','country','TW')]};
  expect((await createPlaceMatcher(search)([row],evidence,source,'query')).place).toBeNull();
  expect(search).not.toHaveBeenCalled();
});

test.each([
  ['Banh Cuon Hong Kong 189','Hong Kong rice rolls','Bánh Cuốn Hong Kong','caption',undefined],
  ['ruemiche','Rue Miche clothing store','Rue Miche','handle','ruemiche'],
])('romanized Vietnamese clue %s can recover a localized name within the existing budget',async(name,english,local,source,handle)=>{
  const row={place_id:'vn-venue',name:english,formatted_address:'Ho Chi Minh City, Vietnam',
    geometry:{location:{lat:10.78,lng:106.7}},address_components:[
      component('Ho Chi Minh City','locality'),component('Vietnam','country','VN')]};
  const search=jest.fn(async()=>[{...row,name:local}]);
  const matcher=createPlaceMatcher(search);
  const place={name,city:'Ho Chi Minh City',source,handle};
  const result=await matcher([row],{description:name+' in Ho Chi Minh City'},place,'query');
  expect(search).toHaveBeenCalledWith('query',undefined,undefined,{languageCode:'vi'});
  expect(result.place?.place_id).toBe('vn-venue');expect(result.requiresSelection).toBe(true);
  await matcher([row],{},place,'query');expect(search).toHaveBeenCalledTimes(1);
});

test('romanized-name recovery cannot spend on an unrelated result or a conflicting city/country',async()=>{
  const search=jest.fn();const matcher=createPlaceMatcher(search);
  const base={place_id:'other',name:'Hong Kong rice rolls',formatted_address:'Paris, France',
    geometry:{location:{lat:48.8,lng:2.3}},address_components:[component('Paris','locality'),component('France','country','FR')]};
  const place={name:'Banh Cuon Hong Kong 189',city:'Ho Chi Minh City',source:'caption'};
  for (const row of [base,{...base,formatted_address:'Hanoi, Vietnam',address_components:[component('Hanoi','locality'),component('Vietnam','country','VN')]}]) {
    expect((await matcher([row],{},place,'query')).place).toBeNull();
  }
  expect(search).not.toHaveBeenCalled();
});

test.each([{country:'Japan'},{address:'1 Main Street, Ho Chi Minh City, Japan'}])(
  'contradictory country %j cannot consume the shared localized-search budget',async override=>{
    const row={place_id:'vn-venue',name:'Hong Kong rice rolls',formatted_address:'Ho Chi Minh City, Vietnam',
      geometry:{location:{lat:10.78,lng:106.7}},address_components:[
        component('Ho Chi Minh City','locality'),component('Vietnam','country','VN')]};
    const search=jest.fn(async()=>[{...row,name:'Bánh Cuốn Hong Kong'}]);
    const matcher=createPlaceMatcher(search,{maxLocalizedLookups:1});
    const place={name:'Banh Cuon Hong Kong 189',city:'Ho Chi Minh City',source:'caption'};
    expect((await matcher([row],{}, {...place,...override},'contradictory')).place).toBeNull();
    expect(search).not.toHaveBeenCalled();
    expect((await matcher([row],{},place,'valid')).place?.place_id).toBe('vn-venue');
    expect(search).toHaveBeenCalledTimes(1);
  });
