const {rankPlaces,similarity}=require('../enrich/confidence');
const {geography,nameEvidence}=require('../enrich/matchingEvidence');
const {createPlaceMatcher}=require('../enrich/placeMatching');
const {normalizePlaceName}=require('../lib/placeNameNormalize');
const wholeSimilarity=(a,b)=>similarity(normalizePlaceName(a),normalizePlaceName(b));

const component=(long_name,type,short_name=long_name)=>({long_name,short_name,types:[type]});
// Reported public name/ID/address; coordinates and structured components are
// synthetic. This is an offline regression, not a newly fetched Google row.
const google=(extra={})=>({place_id:'ChIJHVqKATADaDQR5GIuap1vifA',name:'Shang Hao',
  formatted_address:'No. 1, Lane 8, Minzhi Street, Zhonghe District, New Taipei City, Taiwan',
  geometry:{location:{lat:25.001,lng:121.472}},address_components:[
    component('1','street_number'),component('Lane 8, Minzhi Street','route'),
    component('Zhonghe District','administrative_area_level_3'),
    component('New Taipei City','administrative_area_level_1'),component('Taiwan','country','TW')],...extra});
const source=(extra={})=>({name:'上好雞肉 | Shang Hao Chicken Rice',city:'New Taipei City',
  address:'No.1 Lane8 Minzhi Street Zhonghe District Taiwan',source:'caption',...extra});
const assess=(row=google(),extra={})=>{
  const extracted=source(extra);
  return rankPlaces([row],{description:`${extracted.name}, ${extracted.address}, ${extracted.city}`},extracted);
};
const names=(wanted,actual)=>nameEvidence(wanted,actual,geography(google()),similarity);
const selectable=result=>{
  expect(result.place).not.toBeNull();
  expect(result.requiresSelection).toBe(true);
  expect(result.score).toBeGreaterThanOrEqual(40);
  expect(result.score).toBeLessThan(60);
};

describe('explicit bilingual venue names',()=>{
  test('the reported combined caption recovers Shang Hao only for selection',()=>{
    const row=google(),extracted=source(),before=JSON.stringify({row,extracted});
    expect(similarity('上好雞肉 shang hao chicken rice','shang hao')).toBe(0.4);
    const result=rankPlaces([row],{description:`${extracted.name} ${extracted.address}`},extracted);
    selectable(result);
    expect(result.place).toBe(row);
    expect(result.place.place_id).toBe('ChIJHVqKATADaDQR5GIuap1vifA');
    expect(result.ranked[0].evidence).toMatchObject({nameScore:0.5,cityMatches:true,addressConflict:false});
    expect(JSON.stringify({row,extracted})).toBe(before);
  });

  test.each([
    '上好雞肉 | Shang Hao Chicken Rice',
    'Shang Hao Chicken Rice | 上好雞肉',
    '上好雞肉（Shang Hao Chicken Rice）',
    'Shang Hao Chicken Rice (上好雞肉)',
    '上好雞肉 ｜ Shang Hao Chicken Rice',
  ])('the comparable Latin alias can match independently: %s',name=>{
    for (const actual of ['Shang Hao','Shang Hao Chicken Rice']) {
      const result=assess(google({name:actual}),{name});
      selectable(result);
      expect(result.ranked[0].evidence.nameScore).toBeLessThan(1);
    }
  });

  test.each(['上好雞肉 | Shang Hao Chicken Rice','Shang Hao Chicken Rice (上好雞肉)'])
  ('raw Google alias boundaries survive confidence normalization: %s',actual=>{
    const result=assess(google({name:actual}),{name:'Shang Hao'});
    selectable(result);
    expect(result.ranked[0].evidence.nameScore).toBe(0.5);
  });

  test('both scripts must agree when both names supply aliases',()=>{
    selectable(assess(google({name:'Shang Hao | 上好雞肉飯'})));
    for (const name of ['別家餐廳 | Shang Hao Chicken Rice','上好雞肉 | Unrelated Kitchen']) {
      expect(assess(google({name})).place).toBeNull();
    }
  });

  test('a different explicit bilingual venue works without a name or ID exception',()=>{
    selectable(assess(google({name:'Lantern Grove',place_id:'synthetic-other'}),
      {name:'燈籠食堂 | Lantern Grove Chicken Rice'}));
  });

  test('no translation is invented from a single script or model aliases',()=>{
    expect(assess(google(),{name:'上好雞肉',aliases:['Shang Hao'],googleName:'Shang Hao',verified:true}).place).toBeNull();
    expect(assess(google({name:'Unrelated Hotel'})).place).toBeNull();
  });

  test.each([
    ['上好雞肉店 | Shang Hao Chicken Rice','Shang Hao Chicken Rice',55],
    ['上好雞肉 | Shang Hao East Branch','Shang Hao East Branch',55],
    ['王品 | Wang Steak','Wang Steak',53],
    ['上好雞肉 | Shang Hao Chicken Rice Restaurant','上好雞肉 | Shang Hao',50],
  ])('unavailable alias evidence preserves prior whole-name selection: %s', (a,b,score)=>{
    for (const [wanted,actual] of [[a,b],[b,a]]) {
      const result=assess(google({name:actual}),{name:wanted});
      selectable(result);expect(result.score).toBe(score);
    }
  });

  test('recovery uses the supplied candidate without another lookup',async()=>{
    const search=jest.fn(()=>{throw new Error('Unexpected provider lookup');});
    const result=await createPlaceMatcher(search)([google()],
      {description:`${source().name} ${source().address}`},source(),'unused query');
    selectable(result);
    expect(search).not.toHaveBeenCalled();
  });

  test('literal full names keep their prior exact score',()=>{
    expect(names(source().name,source().name)).toEqual({score:1,partial:false});
    expect(assess(google(),{name:'Shang Hao',address:''})).toMatchObject({score:80,requiresSelection:false});
  });
});

describe('alias safety and generic descriptors',()=>{
  test.each([
    ['上好雞肉 | Shang Hao Chicken Rice','Chicken Rice'],
    ['Chicken Rice','上好雞肉 | Shang Hao Chicken Rice'],
    ['上好雞肉 | Chicken Rice','Chicken Rice'],
    ['雞肉飯 | Chicken Rice','雞肉飯'],
    ['餐廳 | Restaurant','Restaurant'],
    ['咖啡 | Cafe','Cafe'],
    ['Shang Hao Chicken Rice','Chicken Rice'],
    ['上好雞肉 | New Taipei City','New Taipei City'],
  ])('generic or geographic names do not establish identity: %s / %s',(wanted,actual)=>{
    expect(assess(google({name:actual}),{name:wanted}).place).toBeNull();
  });

  test.each([
    'Shang Hao Chicken Rice | Lantern Grove Kitchen',
    '上好雞肉 | 別家餐廳',
    '上好雞肉 | Shang Hao Chicken Rice | Lantern Grove Kitchen',
    '上好雞肉 | Shang Hao Chicken Rice, Lantern Grove Kitchen',
    '上好雞肉 | Shang Hao Chicken Rice and Lantern Grove Kitchen',
    '上好雞肉 | Shang Hao Chicken Rice / Lantern Grove Kitchen',
    '上好雞肉 (Shang Hao Chicken Rice) (Lantern Grove Kitchen)',
    '上好雞肉\nShang Hao Chicken Rice',
    '上好雞肉 / Shang Hao Chicken Rice',
    '上好雞肉, Shang Hao Chicken Rice',
    '上好雞肉 — Shang Hao Chicken Rice',
    '上好雞肉 Shang Hao Chicken Rice',
  ])('no arbitrary list or implicit alias splitting: %s',name=>{
    expect(assess(google(),{name}).place).toBeNull();
  });

  test.each([
    ['Lantern Grove | Maple Kitchen','Lantern Grove'],
    ['上好雞肉 | 別家餐廳','上好雞肉'],
  ])('a same-script list retains its whole-name partial score: %s', (wanted,actual)=>{
    // The existing matcher can surface this overlap for selection, but must
    // not treat the delimiter as independent aliases or raise its score.
    expect(names(wanted,actual)).toEqual({score:0.5,partial:true});
    selectable(assess(google({name:actual}),{name:wanted}));
  });

  test.each(['上好雞肉 | Shang Hao - Other','上好雞肉 | Shang Hao or Other'])
  ('list punctuation gets no alias boost: %s',name=>{
    expect(names(name,'Shang Hao').score).toBe(wholeSimilarity(name,'Shang Hao'));
    const result=assess(google(),{name});
    if (result.place) expect(result.requiresSelection).toBe(true);
  });

  test.each([
    ['上好雞肉中和店 | Shang Hao Chicken Rice','Shang Hao'],
    ['上好雞肉 | Shang Hao Chicken Rice East Branch','上好雞肉'],
    ['上好雞肉 (永和店) | Shang Hao Chicken Rice','Shang Hao'],
    ['上好雞肉 | Shang Hao Chicken Rice (West Branch)','Shang Hao'],
    ['上好雞肉 | Shang Hao Chicken Rice','Shang Hao East Branch'],
    ['上好雞肉 | Shang Hao Chicken Rice','上好雞肉永和店'],
    ['上好雞肉 | Shang Hao Zhonghe','上好雞肉'],
    ['上好雞肉二店 | Shang Hao','Shang Hao'],
    ['上好雞肉 | Shang Hao 2','上好雞肉'],
    ['上好雞肉 | Shang Hao','Shang Hao 2'],
    ['上好雞肉本館 | Shang Hao','Shang Hao'],
  ])('branch qualifiers receive only prior whole-name evidence: %s / %s',(wanted,actual)=>{
    expect(names(wanted,actual).score).toBe(wholeSimilarity(wanted,actual));
    const result=assess(google({name:actual}),{name:wanted});
    if (result.place) expect(result.requiresSelection).toBe(true);
  });

  test.each([
    ['上好雞肉 | Shang Hao Banqiao','上好雞肉'],
    ['上好雞肉板橋 | Shang Hao Chicken Rice','Shang Hao'],
    ['上好雞肉 | Shang Hao Banqiao','Shang Hao'],
    ['上好雞肉 | Shang Hao','Shang Hao XY'],
    ['雞肉飯餐廳 | Shang Hao Chicken Rice','雞肉飯餐廳'],
    ['雞肉飯餐廳 | Shang Hao Chicken Rice','Shang Hao'],
    ['上好雞肉・別家餐廳 | Shang Hao Chicken Rice','Shang Hao'],
  ])('unknown branches, generic compounds and multi-business names get no new match: %s / %s',(a,b)=>{
    for(const [wanted,actual] of [[a,b],[b,a]]) {
      const result=assess(google({name:actual}),{name:wanted});
      expect(names(wanted,actual).score).toBe(wholeSimilarity(wanted,actual));
      if(result.place) expect(result.requiresSelection).toBe(true);
    }
  });

  test('partial name thresholds outside explicit aliases are unchanged',()=>{
    expect(names('Shang Hao Chicken Rice','Shang Hao')).toEqual({score:0.5,partial:true});
    expect(names('Shang Hao Excellent Chicken Rice','Shang Hao')).toEqual({score:0.4,partial:false});
    expect(names('Blue Bird Cafe','Blue Moon Cafe').partial).toBe(false);
    expect(names('上好雞肉','上好雞肉飯')).toEqual({score:0.64,partial:true});
  });
});

describe('independent geography remains required',()=>{
  test.each([
    {city:'Taipei City'},
    {city:'New Taipei City Yonghe District'},
    {country:'Japan'},
    {address:'No. 2, Lane 8, Minzhi Street, Zhonghe District, New Taipei City, Taiwan'},
    {address:'No. 1, Lane 9, Minzhi Street, Zhonghe District, New Taipei City, Taiwan'},
    {address:'No. 1, Lane 8, Minzhi Street, Zhonghe District, Taipei City, Taiwan'},
    {address:'No. 1, Lane 8, Minzhi Street, Zhonghe District, New Taipei City, Japan'},
  ])('a conflicting city, street, or country still rejects: %j',extra=>{
    for (const confirmedPlaceId of [undefined,google().place_id]) {
      expect(assess(google(),{...extra,confirmedPlaceId}).place).toBeNull();
    }
  });

  test('aliases alone supply no independent location evidence',()=>{
    const result=rankPlaces([google()],{description:source().name},source({city:'',address:''}));
    expect(result.place).toBeNull();
  });

  test('unknown street text remains unverified and cannot authorize an automatic save',()=>{
    // Existing address policy treats a differing unverified route as unknown,
    // rather than inventing a translation or asserting a hard contradiction.
    const result=assess(google(),{address:'No. 1, Lane 8, Other Street, Zhonghe District, New Taipei City, Taiwan'});
    selectable(result);
    expect(result.ranked[0].evidence).toMatchObject({addressMatches:false,addressStatus:'unknown'});
  });

  test('a candidate in a wrong city cannot outrank the correct candidate',()=>{
    const right=google(),wrong=google({place_id:'wrong-city',formatted_address:'1 Main Street, Taipei City, Taiwan',
      address_components:[component('Taipei City','locality'),component('Taiwan','country','TW')]});
    const result=rankPlaces([wrong,right],{description:source().name+' New Taipei City'},source());
    selectable(result);
    expect(result.place).toBe(right);
    expect(result.ranked.find(r=>r.top===wrong).score).toBe(0);
  });

  test('ambiguous IDs remain selection-only even with exact alias text',()=>{
    const result=rankPlaces([google(),google({place_id:'another-branch'})],
      {description:source().name+' New Taipei City'},source());
    selectable(result);
    expect(result.ranked).toHaveLength(2);
  });
});
