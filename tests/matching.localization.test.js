const {createPlaceMatcher, matchingLanguage, mergeLocalizedResults} = require('../enrich/placeMatching');
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

describe('Vietnamese language recovery', () => {
  const component = (long_name, short_name, type) => ({long_name, short_name, types:[type]});
  const primary = {...google('ngam', 'Immersion Coffee', 'Hanoi, Vietnam', 21.03, 105.85), address_components:[
    component('Hanoi', 'Hanoi', 'locality'), component('Vietnam', 'VN', 'country'),
  ]};
  const local = {...primary, name:'ngâm CAFE', formatted_address:'Hanoi, Việt Nam', address_components:[
    component('Hanoi', 'Hanoi', 'locality'), component('Việt Nam', 'VN', 'country'),
  ]};
  const source = {name:'ngâm CAFE', city:'Hanoi', country:'VN', source:'caption'};
  const caption = {description:'ngâm CAFE in Hanoi, Vietnam'};

  test.each(['VN', 'vn', 'Vietnam', 'Viet Nam', 'Việt Nam', 'ViệtNam'])('explicit country %s selects Vietnamese', country => {
    expect(matchingLanguage({...source, country}, [])).toBe('vi');
  });

  test.each(['Phở Sen', 'Cà phê Sương', 'Bún Đồi Sen', 'PHỞ SEN', 'Phở Sen'.normalize('NFD')])(
    'distinctive Vietnamese spelling selects recovery without guessing from generic accents: %s', name => {
      expect(matchingLanguage({name}, [])).toBe('vi');
    });

  test.each([
    {name:'Café Central', city:'Paris'},
    {name:'Pâtisserie du Marché', country:'France'},
    {name:'São Bento', country:'Portugal'},
    {name:'Đorđe', country:'Serbia'},
    {name:'ngâm CAFE'},
    {name:'Vietnam Kitchen', city:'Paris'},
    {name:'Cafe', country:'Vanuatu'},
  ])('ordinary Latin names and country-like venue names are not Vietnamese evidence: %p', place => {
    expect(matchingLanguage(place, [])).toBeNull();
  });

  test('shared letters need Vietnamese country corroboration from structured or cached results', () => {
    expect(matchingLanguage({name:'ngâm CAFE'}, [primary])).toBe('vi');
    expect(matchingLanguage({name:'ngâm CAFE'}, [{...primary, address_components:undefined}])).toBe('vi');
    expect(matchingLanguage({name:'ngâm CAFE'}, [{...primary, formatted_address:'Hanoi, Việt Nam', address_components:undefined}])).toBe('vi');
    expect(matchingLanguage({name:'ngâm CAFE'}, [{...primary, address_components:[component('France', 'FR', 'country')]}])).toBeNull();
    expect(matchingLanguage({name:'ngâm CAFE'}, [google('other', 'Vietnam Cafe', 'Vietnam Road, Paris, France')])).toBeNull();
    expect(matchingLanguage({name:'Café Central'}, [primary])).toBeNull();
  });

  test.each([{}, 'country', null, undefined, 42])('country scans ignore malformed component types: %p', types => {
    const malformed = {long_name:'France', short_name:'FR', types};
    expect(matchingLanguage({name:source.name}, [{...primary, address_components:[null, malformed]}])).toBe('vi');
    expect(matchingLanguage({name:source.name}, [{...primary, address_components:[malformed, component('Vietnam', 'VN', 'country')]}])).toBe('vi');
    expect(matchingLanguage({name:source.name}, [{...primary, address_components:[malformed, component('France', 'FR', 'country')]}])).toBeNull();
  });

  test('country evidence in source geography also supports shared Vietnamese letters', () => {
    expect(matchingLanguage({name:'ngâm CAFE', city:'Hanoi, Vietnam'}, [])).toBe('vi');
    expect(matchingLanguage({name:'ngâm CAFE', address:'1 Main Street, Hanoi, Việt Nam'}, [])).toBe('vi');
  });

  test.each(['VN', 'Vietnam', 'Việt Nam'])('same-ID recovery preserves ISO country evidence for %s and requires selection', async country => {
    const search = jest.fn(async () => [local]);
    const match = createPlaceMatcher(search);
    const result = await match([primary], caption, {...source, country}, 'ngam Hanoi');
    expect(search.mock.calls).toEqual([['ngam Hanoi', undefined, undefined, {languageCode:'vi'}]]);
    expect(result.place?.place_id).toBe('ngam');
    expect(result.place?.name).toBe(primary.name);
    expect(result.requiresSelection).toBe(true);
    expect(result.place?._matchingVariants).toEqual([local]);
    await match([primary], caption, {...source, country}, 'ngam Hanoi');
    expect(search).toHaveBeenCalledTimes(1);
    expect(primary._matchingVariants).toBeUndefined();
  });

  test('new-ID Vietnamese recovery also requires selection', async () => {
    const search = jest.fn(async () => [{...local, place_id:'new-ngam'}]);
    const result = await createPlaceMatcher(search)([primary], caption, source, 'ngam Hanoi');
    expect(result.place?.place_id).toBe('new-ngam');
    expect(result.requiresSelection).toBe(true);
  });

  test.each(['Immersion Café', 'Immersion Café'.normalize('NFD'), 'Caffè Immersion', 'São Coffee',
    'Pâtisserie', 'Le Dôme', 'Crêpes', 'Pâtisserie'.normalize('NFD')])(
    'ordinary Latin accents in the Google name do not suppress Vietnamese recovery: %s', async name => {
      const accented = {...primary, name};
      const search = jest.fn(async () => [local]);
      const match = createPlaceMatcher(search);
      const result = await match([accented], caption, source, 'ngam Hanoi');
      expect(search.mock.calls).toEqual([['ngam Hanoi', undefined, undefined, {languageCode:'vi'}]]);
      expect(result.place?.place_id).toBe(primary.place_id);
      expect(result.requiresSelection).toBe(true);
      expect(result.place?._matchingVariants).toEqual([local]);
      await match([accented], caption, source, 'ngam Hanoi');
      expect(search).toHaveBeenCalledTimes(1);
    });

  test('Vietnamese Google geography does not hide a name language mismatch', async () => {
    const search = jest.fn(async () => [local]);
    const result = await createPlaceMatcher(search)(
      [{...local, name:'Immersion Café'}], caption, source, 'ngam Hanoi');
    expect(result.place?.place_id).toBe(primary.place_id);
    expect(result.requiresSelection).toBe(true);
    expect(search).toHaveBeenCalledTimes(1);
  });

  test.each(['Café Central', 'Caffè Luna', 'São Coffee'])(
    'Vietnam country evidence and generic source accents alone do not spend a lookup: %s', async name => {
      const search = jest.fn();
      const result = await createPlaceMatcher(search)([primary], {}, {...source, name}, 'unrelated');
      expect(result.place).toBeNull();
      expect(search).not.toHaveBeenCalled();
    });

  test.each(['ngâm CAFE', 'Cà phê Sương', 'Cà phê Sương'.normalize('NFD'), 'Hoa Đan', 'Hoa Văn'])(
    'actual Vietnamese Google names need no lookup for a geographic mismatch: %s', async name => {
      const search = jest.fn();
      const result = await createPlaceMatcher(search)([{...primary, name}], caption, {...source, city:'Saigon'}, 'wrong-city');
      expect(result.place).toBeNull();
      expect(search).not.toHaveBeenCalled();
    });

  test.each(['VN', 'Vietnam', 'Viet Nam', 'Việt Nam', 'ViệtNam'])('strong primary matches with country %s need no localized lookup even when spelling loses accents', async country => {
    const search = jest.fn();
    const result = await createPlaceMatcher(search)([{...primary, name:'ngam CAFE'}], caption, {...source, country}, 'ngam Hanoi');
    expect(result.place?.place_id).toBe('ngam');
    expect(result.requiresSelection).toBe(false);
    expect(search).not.toHaveBeenCalled();
  });

  test('a strong primary with the shared Vietnamese source spelling still needs no lookup', async () => {
    const search = jest.fn();
    const result = await createPlaceMatcher(search)([{...primary, name:source.name}], caption, source, 'ngam Hanoi');
    expect(result.place?.place_id).toBe(primary.place_id);
    expect(result.requiresSelection).toBe(false);
    expect(search).not.toHaveBeenCalled();
  });

  test('Vietnamese city spelling can recover an exact ASCII venue name', async () => {
    const place = {name:'Lotus Cafe', city:'Thành phố Thủ Đức', country:'VN', source:'caption'};
    const englishCity = {...primary, name:place.name, formatted_address:'Thu Duc City, Vietnam', address_components:[
      component('Thu Duc City', 'Thu Duc City', 'locality'), component('Vietnam', 'VN', 'country'),
    ]};
    const vietnameseCity = {...englishCity, formatted_address:'Thành phố Thủ Đức, Việt Nam', address_components:[
      component(place.city, place.city, 'locality'), component('Việt Nam', 'VN', 'country'),
    ]};
    const search = jest.fn(async () => [vietnameseCity]);
    const result = await createPlaceMatcher(search)([englishCity], {description:'Lotus Cafe Thành phố Thủ Đức'}, place, 'Lotus Cafe');
    expect(search).toHaveBeenCalledWith('Lotus Cafe', undefined, undefined, {languageCode:'vi'});
    expect(result.place?.place_id).toBe(primary.place_id);
    expect(result.requiresSelection).toBe(true);
  });

  test.each(['Café', 'Pâtisserie', 'Le Dôme', 'Crêpes'])(
    'Vietnamese Google name and a generic address accent do not hide a geography language mismatch: %s', async street => {
    const place = {name:'Cà phê Sương', city:'Thành phố Thủ Đức', country:'VN', source:'caption'};
    const englishCity = {...primary, name:place.name, formatted_address:`1 ${street} Road, Thu Duc City, Vietnam`, address_components:[
      component('Thu Duc City', 'Thu Duc City', 'locality'), component('Vietnam', 'VN', 'country'),
    ]};
    const vietnameseCity = {...englishCity, formatted_address:'Thành phố Thủ Đức, Việt Nam', address_components:[
      component(place.city, place.city, 'locality'), component('Việt Nam', 'VN', 'country'),
    ]};
    const search = jest.fn(async () => [vietnameseCity]);
    const result = await createPlaceMatcher(search)([englishCity], {description:place.name+' '+place.city}, place, 'coffee Thu Duc');
    expect(search.mock.calls).toEqual([['coffee Thu Duc', undefined, undefined, {languageCode:'vi'}]]);
    expect(result.place?.place_id).toBe(primary.place_id);
    expect(result.requiresSelection).toBe(true);
  });

  test('a recovered confirmed ID still requires selection', async () => {
    const result = await createPlaceMatcher(jest.fn(async () => [local]))(
      [primary], caption, {...source, confirmedPlaceId:primary.place_id}, 'ngam Hanoi');
    expect(result.place?.place_id).toBe(primary.place_id);
    expect(result.requiresSelection).toBe(true);
  });

  test('Vietnam country evidence alone does not imply a language mismatch', async () => {
    const search = jest.fn();
    const result = await createPlaceMatcher(search)([primary], {}, {...source, name:'Unrelated Cafe'}, 'other');
    expect(result.place).toBeNull();
    expect(search).not.toHaveBeenCalled();
  });

  test('already Vietnamese mismatches, unrelated Latin accents, and empty results spend nothing', async () => {
    const search = jest.fn(), match = createPlaceMatcher(search);
    expect((await match([{...local, name:'Cà phê Sương'}], caption, source, 'wrong-name')).place).toBeNull();
    expect((await match([local], caption, {...source, city:'Saigon'}, 'wrong-city')).place).toBeNull();
    expect((await match([google('other', 'Unrelated', 'Paris, France')], {}, {name:'Café Central', city:'Paris'}, 'latin')).place).toBeNull();
    await match([], caption, source, 'empty');
    expect(search).not.toHaveBeenCalled();
  });

  test('decomposed Vietnamese spelling uses the same mismatch check', async () => {
    const search = jest.fn(async () => [local]);
    const result = await createPlaceMatcher(search)([primary], caption, {...source, name:source.name.normalize('NFD')}, 'ngam Hanoi');
    expect(result.place?.place_id).toBe('ngam');
    expect(search).toHaveBeenCalledTimes(1);
    const alreadyLocalized = jest.fn();
    await createPlaceMatcher(alreadyLocalized)([{...local, name:'Cà phê Sương'.normalize('NFD')}], caption, source, 'wrong-name');
    expect(alreadyLocalized).not.toHaveBeenCalled();
  });

  test('localized wrong-country evidence cannot replace a same-ID primary', async () => {
    const wrongCountry = {...local, formatted_address:'Hanoi, France', address_components:[
      component('Hanoi', 'Hanoi', 'locality'), component('France', 'FR', 'country'),
    ]};
    const search = jest.fn(async () => [wrongCountry]);
    expect((await createPlaceMatcher(search)([primary], caption, source, 'ngam Hanoi')).place).toBeNull();
    expect(search).toHaveBeenCalledTimes(1);
  });

  test('Vietnamese shares the existing lookup budget and failed-request memoization', async () => {
    const search = jest.fn(async () => { throw new EngineError('rate_limited', {provider:'google', stage:'matching'}); });
    const match = createPlaceMatcher(search, {maxLocalizedLookups:2});
    await match([english], evidence, extracted, 'chinese');
    await match([primary], caption, source, 'vietnamese');
    expect((await match([primary], caption, source, 'vietnamese')).localizationFailure.code).toBe('rate_limited');
    await match([primary], caption, source, 'over-budget');
    expect(search.mock.calls.map(call => call[3].languageCode)).toEqual(['zh-TW', 'vi']);
  });
});
