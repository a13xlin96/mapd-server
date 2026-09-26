const {rankPlaces,calculateConfidence,validCoordinates,similarity} = require('../enrich/confidence');

const component=(long_name,type,short_name=long_name)=>({long_name,short_name,types:[type,'political']});
const place=(name='Tai Sushi',address='1 Main Street, Tokyo 150-0001, Japan',extra={})=>({
  place_id:'venue',name,formatted_address:address,geometry:{location:{lat:35.66,lng:139.7}},...extra,
});
const tokyoComponents=[component('1','street_number'),component('Main Street','route'),component('Tokyo','locality'),component('Japan','country','JP'),component('150-0001','postal_code')];
const match=(candidate,extracted={},description='Tai Sushi in Tokyo, Japan')=>rankPlaces([candidate],{description},{name:'Tai Sushi',city:'Tokyo',source:'caption',...extracted});
const chinese={name:'上好雞肉',city:'新北市中和區',country:'Taiwan',address:'235新北市中和區民治街8巷1號',source:'caption'};
const caption='上好雞肉，235新北市中和區民治街8巷1號';
const english=()=>place('Shang Hao Chicken','No. 1, Lane 8, Minzhi Street, Zhonghe District, New Taipei City, Taiwan 235',{
  geometry:{location:{lat:25.001,lng:121.472}},
  address_components:[component('1','street_number'),component('Lane 8, Minzhi Street','route'),component('Zhonghe District','administrative_area_level_3'),component('New Taipei City','administrative_area_level_1'),component('Taiwan','country','TW'),component('235','postal_code')],
});
const localized=(extra={})=>place('上好雞肉','235台灣新北市中和區民治街8巷1號',{
  geometry:{location:{lat:25.001,lng:121.472}},
  address_components:[component('1號','street_number'),component('民治街8巷','route'),component('中和區','administrative_area_level_3'),component('新北市','administrative_area_level_1'),component('台灣','country','TW'),component('235','postal_code')],...extra,
});

describe('whole geography components and cached formatted addresses',()=>{
  test.each(['Tokyo Japan','Japan Tokyo','Tokyo, Japan','Tokyo'])('postal code does not break %s',city=>{
    for (const address_components of [undefined,tokyoComponents]) {
      const result=match(place(undefined,undefined,{address_components}),{city,country:'Japan'});
      expect(result).toMatchObject({score:80,requiresSelection:false});
      expect(result.ranked[0].evidence).toEqual({nameScore:1,cityMatches:true,geoMention:true,addressMatches:false});
    }
  });
  test.each(['Japan, 〒150-0001 Tokyo, 1 Main Street','1 Main Street, Tokyo, Japan','Tokyo Japan','Japan Tokyo'])('cached geography survives address order: %s',address=>{
    expect(match(place(undefined,address),{city:'Tokyo Japan'})).toMatchObject({score:80,requiresSelection:false});
  });
  test.each([
    ['Paris','France','12 Rue Montorgueil, 75002 Paris, France'],
    ['Paris','France','12 Rue Montorgueil, 75002Paris, France'],
    ['Paris','France','France, 75002 Paris, 12 Rue Montorgueil'],
    ['Paris','France','France 75002Paris, 12 Rue Montorgueil'],
    ['Paris','France','75002Paris France, 12 Rue Montorgueil'],
    ['Berlin','Germany','Unter den Linden 12, 10117 Berlin, Germany'],
    ['Berlin','Germany','Unter den Linden 12, 10117Berlin, Germany'],
    ['Berlin','Germany','Germany, 10117 Berlin, Unter den Linden 12'],
    ['Berlin','Germany','Germany 10117Berlin, Unter den Linden 12'],
  ])('cached postal-prefix locality %s: %s / %s', (city,country,address)=>{
    const candidate=place('Sakura',address);
    const result=match(candidate,{name:'Sakura',city:`${city} ${country}`,country},`Sakura in ${city}, ${country}`);
    expect(result).toMatchObject({score:80,requiresSelection:false});
    expect(result.ranked[0].evidence.cityMatches).toBe(true);
  });
  test.each([
    ['75002 Paris Road, Lyon, France','Paris','France'],
    ['75002Paris Road, Lyon, France','Paris','France'],
    ['75002 Rue de Paris, Lyon, France','Rue de Paris','France'],
    ['10117 Berlinstrasse, Hamburg, Germany','Berlinstrasse','Germany'],
    ['10117 Berlin Straße, Hamburg, Germany','Berlin Straße','Germany'],
    ['Route 75002, Lyon, France','Route','France'],
  ])('postal parsing cannot turn a numbered route into a city: %s', (address,city,country)=>{
    expect(match(place('Sakura',address),{name:'Sakura',city,country},`Sakura in ${city}`).place).toBeNull();
  });
  test('postal-prefix addresses still compare the real street numbers',()=>{
    const candidate=place('Sakura','France 75002Paris, 12 Rue Montorgueil');
    const extracted={name:'Sakura',city:'Paris',country:'France',address:'12 Rue Montorgueil, Paris, France'};
    expect(match(candidate,extracted,'Sakura in Paris').ranked[0].evidence.addressMatches).toBe(true);
    expect(match(candidate,{...extracted,address:'13 Rue Montorgueil, Paris, France'},'Sakura in Paris').place).toBeNull();
    expect(match(place('Sakura','75002 Paris Road, Lyon, France'),{name:'Sakura',city:'Lyon',address:'75003 Paris Road, Lyon, France'},'Sakura in Lyon').place).toBeNull();
  });
  test('typed country ISO code bridges English and Japanese',()=>{
    const candidate=place('Tai Sushi','日本、東京都、1 Main Street',{address_components:[component('東京都','administrative_area_level_1'),component('日本','country','JP')]});
    expect(match(candidate,{city:'東京都',country:'Japan'},'Tai Sushi 東京都')).toMatchObject({score:80,requiresSelection:false});
  });
  test.each([
    ['York','1 Main Street, Yorkshire, United Kingdom','United Kingdom'],
    ['York','1 Main Street, New York, USA','USA'],
    ['Tokyo','1 Tokyo Road, Kyoto, Japan','Japan'],
    ['Tokyo','Tokyo Sushi, 1 Main Street, Kyoto, Japan','Japan'],
    ['New York','1 New Street, York, USA','USA'],
    ['Los Angeles','1 Los Road, Angeles, USA','USA'],
    ['Tokyo Osaka','1 Main Street, Tokyo, Japan','Japan'],
    ['Tokyo Russia','1 Main Street, Tokyo, Japan','Japan'],
  ])('rejects city %s in %s', (city,address,country)=>{
    expect(match(place('Tokyo Sushi',address),{name:'Tokyo Sushi',city,country},`Tokyo Sushi in ${city}`).place).toBeNull();
  });
  test.each(['US','USA','United States','United States of America'])('%s does not match Russia',country=>{
    expect(match(place(undefined,'1 Main Street, Moscow, Russia'),{city:'Moscow',country},'Tai Sushi in Moscow').place).toBeNull();
  });
  test.each(['US','USA','United States','United States of America'])('retains country alias %s',country=>{
    expect(match(place(undefined,'1 Main Street, Miami, FL 33101, USA'),{city:'Miami',country},'Tai Sushi in Miami').place).not.toBeNull();
  });
  test('an interior US state is not parsed as a conflicting country',()=>{
    expect(match(place(undefined,'1 Main Street, Savannah, Georgia 31401, USA'),{city:'Savannah Georgia',country:'US'},'Tai Sushi in Savannah')).toMatchObject({score:80,requiresSelection:false});
  });
  test.each([
    ['Springfield Illinois','1 Main Street, Springfield, Massachusetts, USA'],
    ['Tokyo Shinjuku','1 Main Street, Shibuya, Tokyo, Japan'],
  ])('does not discard a conflicting state or district: %s', (city,address)=>{
    expect(match(place(undefined,address),{city},`Tai Sushi in ${city}`).place).toBeNull();
  });
  test('typed geography excludes route and business names even when formatted address includes the hint',()=>{
    const candidate=place('Tokyo Sushi','Tokyo Sushi, 1 Tokyo Road, Kyoto, Japan',{address_components:[component('Tokyo Road','route'),component('Kyoto','locality'),component('Japan','country','JP')]});
    expect(match(candidate,{name:'Tokyo Sushi',city:'Tokyo'},'Tokyo Sushi in Tokyo').place).toBeNull();
  });
  test('typed state and district short names must also agree',()=>{
    const candidate=place(undefined,'1 Main Street, Springfield, MA, USA',{address_components:[component('Springfield','locality'),component('Massachusetts','administrative_area_level_1','MA'),component('United States','country','US')]});
    expect(match(candidate,{city:'Springfield IL',country:'US'},'Tai Sushi in Springfield IL').place).toBeNull();
    expect(match(candidate,{city:'Springfield MA',country:'US'},'Tai Sushi in Springfield MA').score).toBe(80);
  });
  test('ranks the exact name in the right city ahead of another city',()=>{
    const right=place(),wrong=place(undefined,'1 Main Street, Kyoto, Japan',{place_id:'wrong'});
    const result=rankPlaces([wrong,right],{description:'Tai Sushi in Tokyo Japan'},{name:'Tai Sushi',city:'Tokyo Japan'});
    expect(result.place).toBe(right);expect(result.ranked.find(r=>r.top===wrong).score).toBe(0);
  });
  test('cached CJK geography stays useful without a translation table',()=>{
    const candidate=localized({formatted_address:chinese.address,address_components:undefined});
    const result=rankPlaces([candidate],{description:caption},{...chinese,country:''});
    expect(result).toMatchObject({score:80,requiresSelection:false});
    expect(result.ranked[0].evidence.addressMatches).toBe(true);
  });
  test('cached Chinese country prefix and extra village retain whole city/district evidence',()=>{
    const candidate={...require('./engine/matching-localized-google.json'),address_components:undefined};
    const result=rankPlaces([candidate],{description:caption},chinese);
    expect(result).toMatchObject({score:80,requiresSelection:false});
    expect(result.ranked[0].evidence).toEqual({nameScore:1,cityMatches:true,geoMention:true,addressMatches:true});
    expect(rankPlaces([candidate],{description:caption},{...chinese,city:'新北市永和區'}).place).toBeNull();
  });
});

describe('complete localized Google evidence and identity',()=>{
  test('English alone cannot infer a Chinese business translation',()=>{
    expect(rankPlaces([english()],{description:caption},chinese).place).toBeNull();
  });
  test('same place ID localized row resolves name, CJK city and street address together',()=>{
    const primary=english();primary._matchingVariants=[localized()];
    const snapshot=JSON.stringify(primary),result=rankPlaces([primary],{description:caption},chinese);
    expect(result.place).toBe(primary);
    expect(result).toMatchObject({score:80,requiresSelection:true});
    expect(result.ranked[0].evidence).toEqual({nameScore:1,cityMatches:true,geoMention:true,addressMatches:true});
    expect(JSON.stringify(primary)).toBe(snapshot);
  });
  test('recorded Google row tolerates the village missing from the source address',()=>{
    const variant=require('./engine/matching-localized-google.json');
    const primary={...english(),place_id:variant.place_id,geometry:variant.geometry,_matchingVariants:[variant]};
    const result=rankPlaces([primary],{description:caption},chinese);
    expect(result.place).toBe(primary);expect(result.requiresSelection).toBe(true);
    expect(result.ranked[0].evidence).toEqual({nameScore:1,cityMatches:true,geoMention:true,addressMatches:true});
  });
  test.each([
    ['different ID',{place_id:'another'}],
    ['missing ID',{place_id:undefined}],
    ['far away',{geometry:{location:{lat:35,lng:135}}}],
    ['missing coordinates',{geometry:undefined}],
    ['invalid coordinates',{geometry:{location:{lat:NaN,lng:121.472}}}],
    ['different country',{address_components:[component('新北市','administrative_area_level_1'),component('中和區','administrative_area_level_3'),component('Japan','country','JP')]}],
  ])('ignores localized row with %s',(_label,extra)=>{
    const candidate=english();candidate._matchingVariants=[localized(extra)];
    expect(rankPlaces([candidate],{description:caption},chinese).place).toBeNull();
  });
  test('same ID with conflicting comparable city components cannot replace original geography',()=>{
    const primary=place('English Name','1 Main Street, Kyoto, Japan',{address_components:[component('Kyoto','locality'),component('Japan','country','JP')]});
    primary._matchingVariants=[place('Tai Sushi',undefined,{address_components:tokyoComponents})];
    expect(match(primary).place).toBeNull();
  });
  test('cached primary geography cannot be replaced by a conflicting Latin variant',()=>{
    const primary=place('English Name','1 Main Street, Kyoto, Japan');
    primary._matchingVariants=[place()];
    expect(match(primary).place).toBeNull();
  });
  test('does not combine a right-city unrelated name and a wrong-city exact name',()=>{
    const primary=english();
    primary._matchingVariants=[localized({formatted_address:'1 Main Street, 台北市, Taiwan',address_components:[component('台北市','administrative_area_level_1'),component('Taiwan','country','TW')]}),localized({name:'完全不同餐廳'})];
    expect(rankPlaces([primary],{description:caption},chinese).place).toBeNull();
  });
  test('model aliases and claimed verified identity are not Google evidence',()=>{
    expect(rankPlaces([english()],{description:caption},{...chinese,aliases:['Shang Hao Chicken'],googleName:'Shang Hao Chicken',verified:true}).place).toBeNull();
  });
  test('localized new IDs remain eligible through candidate ten',()=>{
    const candidates=Array.from({length:9},(_,i)=>place('Unrelated '+i,undefined,{place_id:'other'+i}));
    const last=localized({place_id:'new-localized'});candidates.push(last);
    const result=rankPlaces(candidates,{description:caption},{...chinese,requiresSelection:true});
    expect(result.place).toBe(last);expect(result.requiresSelection).toBe(true);expect(result.ranked).toHaveLength(10);
    expect(rankPlaces([...candidates.slice(0,9),candidates[0],last],{description:caption},chinese).place).toBeNull();
  });
});

describe('conservative name and street evidence',()=>{
  test.each([
    ['Tai Sushi','Tai Sushi Annex'],
    ['Maple Kitchen','Maple Kitchen East'],
    ['Sakuraya Cafe','Sakuraya Restaurant'],
    ['Mendokoro Haru','Men Haru'],
    ['上好雞肉','上好雞肉飯'],
  ])('meaningful overlap %s / %s is confirmation only', (name,googleName)=>{
    const result=match(place(googleName),{name},`${name} in Tokyo`);
    expect(result.place).not.toBeNull();expect(result.requiresSelection).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(40);expect(result.score).toBeLessThan(60);
    expect(result.ranked[0].evidence.nameScore).toBeGreaterThan(0);
  });
  test.each([
    ['Blue Bird Cafe','Blue Moon Cafe'],
    ['Blue Bird','Blue Moon'],
    ['The Sushi Bar','The Sushi House'],
    ['Tokyo Sushi','Tokyo Ramen'],
    ['上好雞肉','上好牛肉'],
    ['上好','上好雞肉'],
    ['上好雞肉','別家上好雞肉'],
  ])('weak overlap %s / %s cannot become a candidate', (name,googleName)=>{
    expect(match(place(googleName),{name},`${name} in Tokyo`).place).toBeNull();
  });
  test('partial names require matching location',()=>{
    expect(match(place('Tai Sushi Annex','1 Main Street, Kyoto, Japan')).place).toBeNull();
    expect(match(place('Tai Sushi Annex'),{city:''},'Tai Sushi').place).toBeNull();
  });
  test('full street address alone never proves an unrelated business',()=>{
    const result=match(place('Unrelated Hotel'),{address:'1 Main Street, Tokyo, Japan'});
    expect(result.place).toBeNull();expect(result.ranked[0].evidence.addressMatches).toBe(true);
  });
  test.each(['2 Main Street, Tokyo, Japan','12 Main Street, Tokyo, Japan','1B Main Street, Tokyo, Japan'])('conflicting street number %s rejects even exact names',address=>{
    const result=match(place(undefined,'1 Main Street, Tokyo, Japan'),{address});
    expect(result.place).toBeNull();expect(result.ranked[0].evidence.addressMatches).toBe(false);
  });
  test('retains three-digit street numbers when comparing addresses',()=>{
    expect(match(place(undefined,'388 Main Street, Tokyo, Japan'),{address:'389 Main Street, Tokyo, Japan'}).place).toBeNull();
  });
  test('CJK lane and house numbers both need to agree',()=>{
    for (const address of ['235新北市中和區民治街9巷1號','235新北市中和區民治街8巷2號']) {
      expect(rankPlaces([localized()],{description:caption},{...chinese,address}).place).toBeNull();
    }
  });
  test('a country or city conflict inside the address is not overridden by street overlap',()=>{
    for (const address of ['1 Main Street, Kyoto, Japan','1 Main Street, Tokyo, Russia']) {
      expect(match(place(),{address}).place).toBeNull();
    }
  });
});

describe('original safety and output contracts',()=>{
  test.each(['日本料理','日本酒','全日本料理','日本製','日本料理2'])('embedded country in %s cannot authorize automatic saving',compound=>{
    const candidate=place('Sakura','1 Main Street, Kyoto, Japan');
    for (const city of ['Kyoto','']) {
      const result=match(candidate,{name:'Sakura',city},`Sakura ${compound}`);
      expect(result.place).toBe(candidate);expect(result.requiresSelection).toBe(true);
      expect(result.ranked[0].evidence.geoMention).toBe(false);
    }
  });
  test.each([['東京','東京拉麵'],['京都市','京都市料理']])('embedded city in %s / %s remains unverified prose', (city,compound)=>{
    const candidate=place('Sakura',`${city}, Japan`,{address_components:[component(city,'locality'),component('Japan','country','JP')]});
    const result=match(candidate,{name:'Sakura',city},`Sakura ${compound}`);
    expect(result.place).toBe(candidate);expect(result.requiresSelection).toBe(true);
    expect(result.ranked[0].evidence.geoMention).toBe(false);
  });
  test.each(['日本','京都市','日本京都市'])('standalone or complete CJK geography remains evidence: %s',description=>{
    const candidate=place('Sakura','日本京都市1 Main Street',{address_components:[component('京都市','locality'),component('日本','country','JP')]});
    const result=match(candidate,{name:'Sakura',city:'京都市'},`Sakura ${description}`);
    expect(result.requiresSelection).toBe(false);expect(result.ranked[0].evidence.geoMention).toBe(true);
  });
  test.each(['新北市中和區','235新北市中和區民治街8巷1號','235台灣新北市中和區民治街8巷1號'])('CJK administrative/address run remains source evidence: %s',description=>{
    for (const address_components of [localized().address_components,undefined]) {
      const candidate=localized({address_components});
      const result=rankPlaces([candidate],{description:`上好雞肉 ${description}`},{...chinese,address:''});
      expect(result.requiresSelection).toBe(false);expect(result.ranked[0].evidence.geoMention).toBe(true);
    }
  });
  test.each([
    ['no source geography',{name:'Tai Sushi',city:'Tokyo'},'Tai Sushi'],
    ['invented name',{name:'Tai Sushi',city:'Tokyo'},'Lunch with friends in Tokyo'],
    ['handle-only',{name:'Tai Sushi',city:'Tokyo',source:'handle',handle:'taisushi'},'Tai Sushi in Tokyo'],
    ['mislabeled handle',{name:'Tai Sushi',city:'Tokyo',source:'caption'},'@tai.sushi in Tokyo'],
    ['vision',{name:'Tai Sushi',city:'Tokyo',source:'vision'},'Tai Sushi in Tokyo'],
    ['transcript',{name:'Tai Sushi',city:'Tokyo',source:'transcript'},'Tai Sushi in Tokyo'],
    ['explicit selection',{name:'Tai Sushi',city:'Tokyo',requiresSelection:true},'Tai Sushi in Tokyo'],
  ])('%s remains confirmation-only',(_label,extracted,description)=>{
    const result=match(place(),extracted,description);
    expect(result.place).not.toBeNull();expect(result.requiresSelection).toBe(true);
  });
  test('a business name mentioning the city is not independent source geography',()=>{
    const result=match(place('Tokyo Sushi'),{name:'Tokyo Sushi'},'Tokyo Sushi');
    expect(result.requiresSelection).toBe(true);expect(result.ranked[0].evidence.geoMention).toBe(false);
  });
  test('one word of a multiword city in source is not geography evidence',()=>{
    const result=match(place('York Cafe','1 Main Street, New York, USA'),{name:'York Cafe',city:'New York'},'York Cafe');
    expect(result.requiresSelection).toBe(true);expect(result.ranked[0].evidence.geoMention).toBe(false);
  });
  test('distinct ambiguous branch IDs still require selection',()=>{
    const result=rankPlaces([place(),place(undefined,undefined,{place_id:'other'})],{description:'Tai Sushi in Tokyo'},{name:'Tai Sushi',city:'Tokyo'});
    expect(result.requiresSelection).toBe(true);
  });
  test('confirmed IDs filter candidates without bypassing city and number conflicts',()=>{
    const result=match(place(),{confirmedPlaceId:'venue',source:'vision'},'Tai Sushi');
    expect(result.requiresSelection).toBe(false);
    expect(match(place(),{confirmedPlaceId:'other'}).place).toBeNull();
    expect(match(place(),{confirmedPlaceId:'venue',city:'Kyoto'}).place).toBeNull();
    expect(match(place(),{confirmedPlaceId:'venue',address:'2 Main Street, Tokyo, Japan'}).place).toBeNull();
  });
  test('invalid candidates are filtered and real zero coordinates remain valid',()=>{
    expect(rankPlaces([null,place(undefined,undefined,{place_id:''}),place('',undefined),place(undefined,undefined,{geometry:{location:{lat:null,lng:null}}})]).ranked).toEqual([]);
    expect(validCoordinates({geometry:{location:{lat:0,lng:0}}})).toBe(true);
    expect(validCoordinates({lat:91,lng:0})).toBe(false);
  });
  test('legacy wrapper, exports and evidence keys remain available',()=>{
    const candidate=place(),result=calculateConfidence([candidate],{description:'Tai Sushi in Tokyo'});
    expect(result.place).toMatchObject({place_id:'venue',lat:35.66,lng:139.7,geometry:candidate.geometry});
    expect(Object.keys(result).sort()).toEqual(['place','ranked','requiresSelection','score']);
    expect(Object.keys(result.ranked[0].evidence).sort()).toEqual(['addressMatches','cityMatches','geoMention','nameScore']);
    expect(similarity('tai sushi','tai sushi annex')).toBeCloseTo(2/3);
  });
});
