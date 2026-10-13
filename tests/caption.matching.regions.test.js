const {rankPlaces}=require('../enrich/confidence');
const component=(long_name,type,short_name=long_name)=>({long_name,short_name,types:[type]});
// Reconstructed public Txispa locality/province, not a recorded provider row.
// This fixture tests hierarchy, not transliteration or geographic inference.
const base={place_id:'reconstructed-txispa',name:'Txispa',
  formatted_address:'Barrio San Juan 45, Atxondo, Bizkaia, Spain',
  geometry:{location:{lat:43.1,lng:-2.6}},address_components:[
    component('Atxondo','locality'),component('Bizkaia','administrative_area_level_2'),component('Spain','country','ES'),
  ]};
const clue={name:'Txispa',city:'Spanish Basque Country',source:'caption',handle:'txispa_restaurant'};
const assess=(row=base,extra={})=>rankPlaces([row],{description:'Txispa @txispa_restaurant in the Spanish Basque Country'}, {...clue,...extra});

describe('region evidence in the city slot is bounded and confirmation only',()=>{
  test.each([true,false])('a vetted province anchors Txispa with typed/cached data (%s)',typed=>{
    const row={...base,address_components:typed?base.address_components:undefined};
    const result=assess(row);
    expect(result.place).toBe(row);expect(result.requiresSelection).toBe(true);
    expect(result.ranked[0].evidence).toMatchObject({nameScore:1,cityMatches:true,aliasRecovery:true});
  });

  test.each(['Spanish Basque Country','Basque Country','País Vasco','Euskadi'])
  ('complete recognized regional spelling %s remains a candidate',city=>{
    expect(assess(base,{city})).toMatchObject({place:base,requiresSelection:true});
  });

  test.each(['Bizkaia','Biscay','Vizcaya','Gipuzkoa','Guipúzcoa','Araba','Álava','Araba/Álava'])
  ('known province %s provides hierarchical evidence without asserting a city',province=>{
    const row={...base,formatted_address:`Atxondo, ${province}, Spain`,address_components:[
      component('Atxondo','locality'),component(province,'administrative_area_level_2'),component('Spain','country','ES'),
    ]};
    expect(assess(row)).toMatchObject({place:row,requiresSelection:true});
  });

  test.each(['Basque Country','Euskadi','País Vasco'])('typed region %s supports omitted province',region=>{
    const row={...base,address_components:[component('Atxondo','locality'),component(region,'administrative_area_level_1'),component('Spain','country','ES')]};
    expect(assess(row)).toMatchObject({place:row,requiresSelection:true});
  });

  test.each(['Madrid','Catalonia','Navarre'])('conflicting typed parent %s cannot borrow a province or formatted address',region=>{
    const row={...base,address_components:[...base.address_components,component(region,'administrative_area_level_1')]};
    expect(assess(row).place).toBeNull();
  });

  test('conflicting typed province cannot borrow a matching parent',()=>{
    const row={...base,address_components:[component('Atxondo','locality'),component('Navarre','administrative_area_level_2'),
      component('Basque Country','administrative_area_level_1'),component('Spain','country','ES')]};
    expect(assess(row).place).toBeNull();
  });

  test.each(['Madrid','Atxondo','Bilbao'])('an unrecognized cached outer component %s does not prove the region',outer=>{
    const row={...base,formatted_address:`45 Main Road, ${outer}, Spain`,address_components:undefined};
    expect(assess(row).place).toBeNull();
  });

  test('a province-looking route, venue or locality is not typed administrative evidence',()=>{
    for (const kind of ['route','locality']) {
      const row={...base,formatted_address:'45 Bizkaia Road, Madrid, Spain',address_components:[
        component('Bizkaia',kind),component('Spain','country','ES'),
      ]};
      expect(assess(row).place).toBeNull();
    }
  });

  test.each(['French Basque Country','Spanish Basque Country Madrid','Madrid Basque Country','Atxondo Annex','Unknown Region'])
  ('unmatched geography is never dropped: %s',city=>{
    expect(assess(base,{city}).place).toBeNull();
  });

  test.each(['France','USA'])('wrong %s country cannot borrow a region/province name',country=>{
    const row={...base,formatted_address:`Atxondo, Bizkaia, ${country}`,address_components:[
      component('Atxondo','locality'),component('Bizkaia','administrative_area_level_2'),component(country,'country',country==='France'?'FR':'US'),
    ]};
    expect(assess(row).place).toBeNull();
    expect(assess(base,{country}).place).toBeNull();
  });

  test('missing country cannot authorize regional inference',()=>{
    const row={...base,formatted_address:'45 Main Road, Atxondo, Bizkaia',address_components:base.address_components.filter(c=>!c.types.includes('country'))};
    expect(assess(row).place).toBeNull();
  });

  test('conflicting formatted country cannot borrow Spanish typed components',()=>{
    expect(assess({...base,formatted_address:'45 Main Road, Atxondo, Bizkaia, France'}).place).toBeNull();
  });

  test('an explicit wrong address city remains a contradiction despite region recovery',()=>{
    expect(assess(base,{address:'Barrio San Juan 45, Madrid, Spain'}).place).toBeNull();
  });

  test('an unrelated venue name cannot borrow the right region',()=>{
    expect(assess({...base,name:'Other Restaurant'}).place).toBeNull();
  });

  test('a literal typed region containing a separately identified city requires confirmation',()=>{
    const row={...base,name:'Lantern Kitchen',formatted_address:'Albany, New York, USA',address_components:[
      component('Albany','locality'),component('New York','administrative_area_level_1'),component('USA','country','US'),
    ]};
    expect(rankPlaces([row],{description:'Lantern Kitchen in New York'},
      {name:row.name,city:'New York',source:'caption'})).toMatchObject({place:row,requiresSelection:true});
  });
});
