const {rankPlaces}=require('../enrich/confidence');

const component=(long_name,type,short_name=long_name)=>({long_name,short_name,types:[type]});
// Reconstructed from the public address and caption in the Sun Kwai incident;
// not a retained Google API response. IDs/coordinates are synthetic. Every
// case below is local: no provider calls, credentials or production records.
const base={place_id:'reconstructed-sun-kwai',name:'Sun Kwai Heung',
  formatted_address:'Hong Kong, Hong Kong Island, Chai Wan, Chai Wan Rd, 345號地下17號舖',
  geometry:{location:{lat:22.2,lng:114.2}},address_components:[
    component('Hong Kong','country','HK'),component('Hong Kong Island','administrative_area_level_1'),
    component('Chai Wan','locality'),component('Chai Wan Road','route','Chai Wan Rd'),component('345','street_number'),
  ]};
const source={name:'sun kwai heung 新桂香燒臘',city:'Chai Wan',address:'345 Chai Wan Road, Chai Wan',source:'caption'};
const assess=(row=base,overrides={})=>{
  const clue={...source,...overrides};
  return rankPlaces([row],{description:`${clue.name} at ${clue.address}`},clue);
};
const withTail=(tail,components=base.address_components)=>({...base,
  formatted_address:base.formatted_address.replace('345號地下17號舖',tail),address_components:components});

describe('Chinese shop/floor suffixes remain separate from the building number',()=>{
  test.each([true,false])('Sun Kwai reaches confirmation with typed/cached address (%s)',typed=>{
    const row={...base,address_components:typed?base.address_components:undefined};
    const before=JSON.stringify(row),result=assess(row);
    expect(result.place).toBe(row);expect(result.requiresSelection).toBe(true);
    expect(result.ranked[0].evidence).toMatchObject({nameScore:0.75,cityMatches:true,addressConflict:false,addressStatus:'unknown'});
    expect(result.ranked[0].evidence.addressReasons).toEqual(expect.arrayContaining(['unit_unverified','unit_format_recovered']));
    expect(JSON.stringify(row)).toBe(before);
  });

  test.each(['345號地下17號舖','345号地下17号铺','345號2樓17號舖','345號2層17室',
    '345號, 地下17號舖','345 Chai Wan Road, 地下17號舖','345號地面17號舖','３４５號地下１７號舖'])
  ('explicit native unit notation preserves the house: %s',tail=>{
    const row=withTail(tail),result=assess(row);
    expect(result.place).toBe(row);expect(result.requiresSelection).toBe(true);
    expect(result.ranked[0].evidence.addressConflict).toBe(false);
  });

  test.each(['346','345A','345/1','345-347'])('wrong building %s still rejects',number=>{
    const row=withTail(`${number}號地下17號舖`,base.address_components.map(c=>
      c.types.includes('street_number')?component(number,'street_number'):c));
    const result=assess(row);
    expect(result.place).toBeNull();
    expect(result.ranked[0].evidence.addressReasons).toContain('street_number_conflict');
  });

  test.each(['18號舖','Shop 18','Unit 18','2樓17號舖','Floor 2, Shop 17'])
  ('contradictory supplied unit/floor %s still rejects',unit=>{
    const result=assess(base,{address:`345 Chai Wan Road, ${unit}, Chai Wan`});
    expect(result.place).toBeNull();
    expect(result.ranked[0].evidence.addressReasons).toContain('unit_conflict');
  });

  test.each(['345 Chai Wan Road, Shop 17, Chai Wan','345號地下17號舖, Chai Wan'])
  ('a consistent shop is retained but never auto-saved by normalization: %s',address=>{
    expect(assess(base,{address})).toMatchObject({place:base,requiresSelection:true});
  });

  test.each(['345號17號','345號17巷','345號17弄','345號第17座','345號, 17','345號地下17號舖路'])
  ('bare numbers, blocks and routes are not units: %s',tail=>{
    const result=assess(withTail(tail));
    expect(result.place).toBeNull();
    expect(result.ranked[0].evidence.addressReasons).toContain('street_number_conflict');
  });

  test.each(['route','street_number'])('typed %s cannot be erased by a unit-looking label',kind=>{
    const row=withTail('345號, 地下17號舖',[...base.address_components,component('地下17號舖',kind)]);
    expect(assess(row).place).toBeNull();
  });

  test('a route equal to only the shop portion cannot be consumed along with the floor',()=>{
    const row=withTail('345號, 地下17號舖',[...base.address_components,component('17號舖','route')]);
    expect(assess(row).place).toBeNull();
    expect(assess(row).ranked[0].evidence.addressReasons).not.toContain('unit_format_recovered');
  });

  test('typed district numbers stay geography rather than becoming shops',()=>{
    const row=withTail('345號, 地下17號舖',[...base.address_components,component('地下17號舖','sublocality_level_1')]);
    expect(assess(row).ranked[0].evidence.addressReasons).not.toContain('unit_format_recovered');
    expect(assess(row,{city:'Chai Wan 地下18號舖'}).place).toBeNull();
  });

  test('independent house evidence is required, even when a numbered route supplies digits',()=>{
    const row=withTail('Route 345, 地下17號舖',[
      component('Hong Kong','country','HK'),component('Chai Wan','locality'),component('Route 345','route'),
    ]);
    const result=assess(row,{address:'Route 345, Chai Wan'});
    expect(result.place).toBeNull();
    expect(result.ranked[0].evidence.addressReasons).toContain('street_number_conflict');
  });

  test('numbered route and district contradictions survive shop normalization',()=>{
    const row={...withTail('345號地下17號舖'),
      formatted_address:'Hong Kong, District 8, Route 17, 345號地下17號舖',
      address_components:[component('Hong Kong','country','HK'),component('District 8','locality'),
        component('Route 17','route'),component('345','street_number')]};
    expect(assess(row,{city:'District 8',address:'345 Route 18, District 8'}).place).toBeNull();
    expect(assess(row,{city:'District 9',address:'345 Route 17, District 9'}).place).toBeNull();
  });

  test.each([{city:'Kowloon'},{country:'Japan'},{address:'345 Chai Wan Road, Tokyo, Japan'}])
  ('geographic contradiction %j remains a veto',override=>{
    expect(assess(base,override).place).toBeNull();
    expect(assess(base,{...override,confirmedPlaceId:base.place_id}).place).toBeNull();
  });

  test('native normalization is independent of venue identity',()=>{
    const row={...base,name:'Lantern Kitchen',place_id:'synthetic-other'};
    expect(assess(row,{name:row.name})).toMatchObject({place:row,requiresSelection:true});
  });

  test('Taiwan basement notation is not equated with Hong Kong ground floor',()=>{
    const row={...base,formatted_address:'345號地下17號舖, Taipei, Taiwan',address_components:[
      component('Taiwan','country','TW'),component('Taipei','locality'),component('345','street_number'),
    ]};
    const result=assess(row,{city:'Taipei',address:'345號地面17號舖, Taipei, Taiwan'});
    expect(result.place).toBeNull();expect(result.ranked[0].evidence.addressReasons).toContain('unit_conflict');
  });
});
