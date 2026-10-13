const {createPlaceMatcher}=require('../enrich/placeMatching');
const component=(long_name,type,short_name=long_name)=>({long_name,short_name,types:[type]});
// Reconstructed caption and Google language variants, not a saved API response.
// Keep transliteration out of ranking: only Google's same-ID localized result
// can bridge these two names, through the existing bounded search dependency.
const source={name:'鮨 うら山 本店',city:'Nagoya',address:'Sakae, Nagoya, Aichi',source:'caption'};
const evidence={description:'鮨 うら山 本店 (Sushi Urayama Honten) in Sakae, Nagoya, Aichi'};
const base={place_id:'reconstructed-urayama',name:'Sushi Urayama Honten',
  formatted_address:'1 Main Street, Sakae, Nagoya, Aichi, Japan',geometry:{location:{lat:35.16,lng:136.9}},
  address_components:[component('1','street_number'),component('Main Street','route'),
    component('Sakae','neighborhood'),component('Nagoya','locality'),component('Aichi','administrative_area_level_1'),
    component('Japan','country','JP')]};
const local={...base,name:source.name};

test('Japanese and English venue names use existing local-language recovery and require confirmation',async()=>{
  const search=jest.fn(async()=>[local]),match=createPlaceMatcher(search);
  const result=await match([base],evidence,source,'reconstructed-query');
  expect(result.place?.place_id).toBe(base.place_id);expect(result.requiresSelection).toBe(true);
  expect(result.place?._matchingVariants).toEqual([local]);
  expect(search.mock.calls).toEqual([['reconstructed-query',undefined,undefined,{languageCode:'ja'}]]);
  await match([base],evidence,source,'reconstructed-query');expect(search).toHaveBeenCalledTimes(1);
});

test.each([
  ['city',{...local,formatted_address:'1 Main Street, Kyoto, Japan',address_components:[component('Kyoto','locality'),component('Japan','country','JP')]}],
  ['country',{...local,formatted_address:'1 Main Street, Nagoya, France',address_components:[component('Nagoya','locality'),component('France','country','FR')]}],
  ['coordinates',{...local,geometry:{location:{lat:34,lng:135}}}],
])('a same-ID localized response with contradictory %s cannot supply the missing name',async(_reason,row)=>{
  const search=jest.fn(async()=>[row]);
  expect((await createPlaceMatcher(search)([base],evidence,source,'reconstructed-query')).place).toBeNull();
});

test('localized native name cannot override a different street number',async()=>{
  const search=jest.fn(async()=>[local]);
  const result=await createPlaceMatcher(search)([base],evidence,{...source,address:'2 Main Street, Nagoya, Aichi'},'reconstructed-query');
  expect(result.place).toBeNull();
  expect(result.ranked[0].evidence.addressReasons).toContain('street_number_conflict');
});

test('an already-matching native name needs no language request',async()=>{
  const search=jest.fn(),result=await createPlaceMatcher(search)([local],evidence,source,'reconstructed-query');
  expect(result.place?.place_id).toBe(base.place_id);expect(search).not.toHaveBeenCalled();
});
