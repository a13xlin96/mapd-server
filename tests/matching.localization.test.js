const {createPlaceMatcher, mergeLocalizedResults} = require('../enrich/placeMatching');
const context = require('../lib/jobContext');
const {EngineError} = require('../lib/engineError');
const google = (id, name, address, lat = 25, lng = 121) => ({place_id:id,name,formatted_address:address,geometry:{location:{lat,lng}}});
const extracted = {name:'上好雞肉',city:'新北市中和區',address:'235新北市中和區民治街8巷1號',source:'caption'};
const english = google('chicken', 'Shang Hao', 'No. 1, Lane 8, Minzhi St, Zhonghe District, New Taipei City, Taiwan 235');
const localized = {...require('./engine/matching-localized-google.json'),place_id:'chicken',geometry:english.geometry};
const evidence = {description:extracted.name+' '+extracted.address};

test('Chinese source and English Google result recover through one localized lookup with mandatory confirmation', async () => {
  const search = jest.fn(async () => [localized]);
  const match = createPlaceMatcher(search);
  const result = await match([english],evidence,extracted,'query');
  expect(result.place?.place_id).toBe('chicken');expect(result.requiresSelection).toBe(true);
  expect(search.mock.calls).toEqual([['query',undefined,undefined,{languageCode:'zh-TW'}]]);
  await match([english],evidence,extracted,'query');
  expect(search).toHaveBeenCalledTimes(1);
});

test('a useful primary result, Latin query, or empty result never adds a localization request',async()=>{
  const search=jest.fn(),match=createPlaceMatcher(search);
  const cafe=google('cafe','Craft Ramen BiT','106 1-chōme-12-25 Shitaya, Taito City, Tokyo 110-0004, Japan',35.7,139.8);
  expect((await match([cafe],{description:'Craft Ramen BiT in Tokyo'}, {name:cafe.name,city:'Tokyo, Japan'},'cafe')).place?.place_id).toBe('cafe');
  await match([cafe],{}, {name:'Different Cafe',city:'Miami'},'no-match');
  await match([],evidence,extracted,'empty');expect(search).not.toHaveBeenCalled();
});

test('localized wrong-city result is rejected and cannot turn a matching name into a save',async()=>{
  const search=jest.fn(async()=>[google('other','上好雞肉','台灣台南市1號')]);
  expect((await createPlaceMatcher(search)([english],evidence,extracted,'query')).place).toBeNull();
});

test('matching-language geographic failure does not spend on a second language search',async()=>{
  const search=jest.fn();
  await createPlaceMatcher(search)([google('other','上好雞肉','台灣台南市1號')],evidence,extracted,'query');
  expect(search).not.toHaveBeenCalled();
});

test('same-ID language variant with inconsistent coordinates cannot lend its address',()=>{
  const merged=mergeLocalizedResults([english],[{...localized,geometry:{location:{lat:35,lng:139}}}]);
  expect(merged).toHaveLength(1);expect(merged[0]._matchingVariants).toBeUndefined();
});

test('six extra lookups per link is a hard bound, including failed requests; no automatic retries',async()=>{
  const search=jest.fn(async()=>{throw new EngineError('rate_limited',{provider:'google',stage:'matching'});});
  const match=createPlaceMatcher(search);
  for(let i=0;i<9;i++)await match([english],evidence,extracted,`query-${i}`);
  expect(search).toHaveBeenCalledTimes(6);
  const same=await match([english],evidence,extracted,'query-0');
  expect(same.localizationFailure.code).toBe('rate_limited');expect(search).toHaveBeenCalledTimes(6);
});

test('revoked attempt is never converted into a matching failure or new lookup',async()=>{
  const search=jest.fn(),controller=new AbortController();controller.abort();
  await expect(context.run({signal:controller.signal,deadline:Date.now()+10000},()=>createPlaceMatcher(search)([english],evidence,extracted,'query'))).rejects.toMatchObject({code:'attempt_stopped'});
  expect(search).not.toHaveBeenCalled();
});

test('new localized place IDs are considered even when five primary results are rejected',async()=>{
  const primary=Array.from({length:5},(_,i)=>google(`wrong-${i}`,'Unrelated Restaurant','Miami, FL, USA'));
  const result=await createPlaceMatcher(jest.fn(async()=>[localized]))(primary,evidence,extracted,'query');
  expect(result.place?.place_id).toBe('chicken');expect(result.requiresSelection).toBe(true);
});

test('a country-only language mismatch gets the same bounded localization recovery',async()=>{
  const primary=google('coffee','Starbucks','Athens, Greece',37.9,23.7);
  const local={...primary,formatted_address:'Αθήνα, Ελλάδα',address_components:[
    {long_name:'Αθήνα',short_name:'Αθήνα',types:['locality']},
    {long_name:'Ελλάδα',short_name:'GR',types:['country']},
  ]};
  const search=jest.fn(async()=>[local]);
  const match=await createPlaceMatcher(search)([primary],{description:'Starbucks στην Ελλάδα'},
    {name:'Starbucks',country:'Ελλάδα',source:'caption'},'Starbucks');
  expect(search).toHaveBeenCalledWith('Starbucks',undefined,undefined,{languageCode:'el'});
  expect(match.place?.place_id).toBe('coffee');expect(match.requiresSelection).toBe(true);
});
