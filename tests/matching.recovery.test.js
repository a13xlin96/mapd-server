const {rankPlaces,calculateConfidence}=require('../enrich/confidence');
const {geography,addressEvidence}=require('../enrich/matchingEvidence');

// Synthetic regression fixtures reproduce the failed-share decision paths.
// They are not reconstructed or claimed to be historical Google responses.
const component=(long_name,type,short_name=long_name)=>({long_name,short_name,types:[type]});
const candidate=(formatted_address,address_components,extra={})=>({
  place_id:'venue',name:'Lumina Cafe',formatted_address,address_components,
  geometry:{location:{lat:10.77,lng:106.7}},...extra,
});
const hcm=component('Hồ Chí Minh','administrative_area_level_1');
const vn=component('Vietnam','country','VN');
const address='44 Main Street, Bến Thành, Hồ Chí Minh, Vietnam';
const components=[component('44','street_number'),component('Main Street','route'),
  component('Bến Thành','sublocality_level_1'),hcm,vn];
const match=(row,overrides={},description='Lumina Cafe in Hồ Chí Minh, Vietnam')=>
  rankPlaces([row],{description},{name:'Lumina Cafe',city:'Hồ Chí Minh',country:'Vietnam',
    address,source:'caption',...overrides});

test('identical full address with missing ward component becomes confirmation instead of failure',()=>{
  const full=candidate(address,components);
  const partial=candidate(address,components.filter(c=>!c.types.includes('sublocality_level_1')));
  const before=JSON.stringify(partial);
  expect(match(full)).toMatchObject({score:80,requiresSelection:false});
  const result=match(partial);
  expect(result.place).toBe(partial);
  expect(result.requiresSelection).toBe(true);
  expect(result.ranked[0].evidence).toMatchObject({addressMatches:true,addressConflict:false,
    addressStatus:'unknown',addressReasons:['geography_components_missing']});
  expect(JSON.stringify(partial)).toBe(before);
});

test.each(['668 Greenwich Street, West Village','668 Greenwich Street, West Village, New York, USA',
  '668 Greenwich Street, West Village, New York, NY, USA'])('missing neighborhood stays selectable when optional state is omitted: %s',hint=>{
  const row=candidate('668 Greenwich Street, New York, NY 10014, USA',[
    component('668','street_number'),component('Greenwich Street','route'),
    component('New York','locality'),component('New York','administrative_area_level_1','NY'),
    component('United States','country','US'),component('10014','postal_code'),
  ]);
  const result=match(row,{city:'New York',country:'US',address:hint},'Lumina Cafe in New York');
  expect(result.place).toBe(row);expect(result.requiresSelection).toBe(true);
  expect(result.ranked[0].evidence).toMatchObject({addressStatus:'unknown',addressConflict:false});
});

test.each([['Angola','AO','Austria'],['Burundi','BI','Belgium']])
('ISO %s / %s cannot acquire the unrelated %s country alias',(country,code,wrong)=>{
  const row=candidate(`1 Main Street, Example City, ${country}`,[component('Example City','locality'),component(country,'country',code)]);
  expect(match(row,{city:'Example City',country:wrong,address:''},'Lumina Cafe in Example City').place).toBeNull();
  expect(match(row,{city:'Example City',country:code,address:''},'Lumina Cafe in Example City').place).toBe(row);
});

test('a Vietnamese cuisine adjective does not independently establish a country',()=>{
  const row=candidate('1 Main Street, Paris, France',[component('Paris','locality'),component('France','country','FR')]);
  const result=rankPlaces([row],{description:'Lumina Cafe — ẩm thực Pháp'},{name:'Lumina Cafe'});
  expect(result.requiresSelection).toBe(true);
  expect(result.ranked[0].evidence.geoMention).toBe(false);
});

test.each([undefined,[hcm,vn],[hcm,component('Việt Nam','country','VN')]])
('Vietnam country spelling in cuisine prose cannot authorize automatic saving: %p',parts=>{
  const row=candidate('44 Main Street, Hồ Chí Minh, Vietnam',parts);
  const evidence={description:'Lumina Cafe — món Việt Nam'};
  for (const result of [rankPlaces([row],evidence,{name:'Lumina Cafe'}),calculateConfidence([row],evidence)]) {
    expect(result.place?.place_id).toBe(row.place_id);expect(result.requiresSelection).toBe(true);
    expect(result.ranked[0].evidence.geoMention).toBe(false);
  }
  expect(match(row,{country:'Việt Nam',address:''},'Lumina Cafe in Hồ Chí Minh').place).toBe(row);
});

test.each(['Ho Chi Minh City','Phường Bến Thành'])('literal Google geography %s is not downgraded by a shorter generated alias',location=>{
  const row=candidate(`44 Main Street, Phường Bến Thành, Ho Chi Minh City, Vietnam`,[
    component('44','street_number'),component('Main Street','route'),
    component('Phường Bến Thành','sublocality_level_1'),component('Ho Chi Minh City','locality'),vn,
  ]);
  const result=match(row,{city:'Ho Chi Minh City',address:''},`Lumina Cafe in ${location}`);
  expect(result.requiresSelection).toBe(false);
  expect(result.ranked[0].evidence.aliasRecovery).toBe(false);
});

test.each(['Ho Chi Minh City','HCMC','HCM','TP. Hồ Chí Minh','Thành phố Hồ Chí Minh','Saigon','Sài Gòn'])
('Vietnam-scoped %s city alias retains exact venue with confirmation',city=>{
  const row=candidate(address,components);
  const result=match(row,{city});
  expect(result.place).toBe(row);expect(result.requiresSelection).toBe(true);
  expect(result.ranked[0].evidence).toMatchObject({cityMatches:true,aliasRecovery:true});
});

test('country and ward spelling variants work without translating the venue name',()=>{
  const row=candidate('44 Main Street, Phường Bến Thành, Hồ Chí Minh, Việt Nam',[
    component('44','street_number'),component('Main Street','route'),
    component('Phường Bến Thành','administrative_area_level_3'),hcm,component('Việt Nam','country','VN'),
  ]);
  const result=match(row,{city:'Ho Chi Minh City',address:'44 Main Street, Ben Thanh Ward, HCMC, Vietnam'});
  expect(result.place).toBe(row);expect(result.requiresSelection).toBe(true);
  expect(result.ranked[0].evidence).toMatchObject({addressMatches:true,aliasRecovery:true});
  expect(match({...row,name:'Different Cafe'},{city:'Ho Chi Minh City'}).place).toBeNull();
});

test.each(['Hanoi','Hà Nội City','Thành phố Hà Nội'])('Hanoi spelling %s is country-scoped',city=>{
  const row=candidate('12 Main Street, Hà Nội, Vietnam',[component('Hà Nội','locality'),vn]);
  const result=match(row,{city,address:''},'Lumina Cafe in Hà Nội');
  expect(result.place).toBe(row);expect(result.requiresSelection).toBe(true);
});

test.each([
  ['wrong country','1 Main Street, Ho Chi Minh, USA',[component('Ho Chi Minh','locality'),component('USA','country','US')]],
  ['unknown country','1 Main Street, Ho Chi Minh',[component('Ho Chi Minh','locality')]],
  ['route name','1 Ho Chi Minh Road, Hanoi, Vietnam',[component('Ho Chi Minh Road','route'),component('Hanoi','locality'),vn]],
])('HCMC alias cannot lend city evidence to %s',(_label,formatted,parts)=>{
  expect(match(candidate(formatted,parts),{city:'HCMC',country:'',address:''}).place).toBeNull();
});

test('city name equivalence does not override conflicting country or confirmed ID',()=>{
  const row=candidate(address,components);
  expect(match(row,{city:'HCMC',country:'Japan'}).place).toBeNull();
  expect(match(row,{city:'HCMC',confirmedPlaceId:'another'}).place).toBeNull();
  expect(match(row,{city:'HCMC',confirmedPlaceId:'venue'}).requiresSelection).toBe(false);
});

test.each(['2 Main Street, Bến Thành, Hồ Chí Minh, Vietnam',
  '44 Main Street, Bến Thành, Hồ Chí Minh, Japan',
  '44 Main Street, Hanoi, Vietnam'])('known address contradiction remains rejected: %s',hint=>{
  const result=match(candidate(address,components),{address:hint});
  expect(result.place).toBeNull();
  expect(result.ranked[0].evidence).toMatchObject({addressStatus:'conflict',addressConflict:true});
});

test('a different street with the same number is not auto-saved as an exact address',()=>{
  const result=match(candidate(address,components),{address:'44 Other Street, Bến Thành, Hồ Chí Minh, Vietnam'});
  expect(result.place).not.toBeNull();expect(result.requiresSelection).toBe(true);
  expect(result.ranked[0].evidence.addressStatus).toBe('unknown');
});

test.each(['in 3 days','in the morning','in a hurry','in our next video'])
('caption prose %s cannot create a hard city restriction',phrase=>{
  const row=candidate(address,components);
  const result=match(row,{city:'',country:'',address:''},`Lumina Cafe ${phrase}. Great food!`);
  expect(result.place).toBe(row);expect(result.requiresSelection).toBe(true);
  expect(result.ranked[0].evidence).toMatchObject({cityMatches:true,cityHintSource:'caption_tentative',captionCityMatches:false});
});

test('a tentative city prefers a matching result and does not auto-save a wrong-city fallback',()=>{
  const right=candidate(address,components);
  const wrong=candidate('44 Main Street, Hanoi, Vietnam',[component('Hanoi','locality'),vn],{place_id:'other'});
  const evidence={description:'Lumina Cafe in Hồ Chí Minh, Vietnam'};
  const result=rankPlaces([wrong,right],evidence,{name:'Lumina Cafe',source:'caption'});
  expect(result.place).toBe(right);expect(result.requiresSelection).toBe(false);
  expect(rankPlaces([wrong],evidence,{name:'Lumina Cafe'}).requiresSelection).toBe(true);
  expect(calculateConfidence([wrong],evidence).requiresSelection).toBe(true);
});

test('an explicit wrong extracted city still vetoes the candidate',()=>{
  const result=match(candidate(address,components),{city:'Hanoi',address:''},'Lumina Cafe in 3 days');
  expect(result.place).toBeNull();
  expect(result.ranked[0].evidence).toMatchObject({cityMatches:false,cityHintSource:'extracted',captionCityMatches:null});
});

test('address diagnostics expose absence versus unknown versus contradiction',()=>{
  const profile=geography(candidate(address,components));
  expect(addressEvidence('',profile)).toMatchObject({status:'not_provided',conflict:false});
  expect(addressEvidence('44 Main Street, Unknown Neighborhood',profile)).toMatchObject({status:'unknown',requiresSelection:true});
  expect(addressEvidence('45 Main Street, Hồ Chí Minh, Vietnam',profile)).toMatchObject({status:'conflict',reasons:expect.arrayContaining(['street_number_conflict'])});
});

test.each([[false,true],[true,true],[true,false]])('a wrong address city before a matching state remains rejected (confirmed ID: %s, country in address: %s)',(confirmed,includeCountry)=>{
  const row=candidate('44 Main Street, Irvine, California, USA',[
    component('44','street_number'),component('Main Street','route'),component('Irvine','locality'),
    component('California','administrative_area_level_1','CA'),component('USA','country','US'),
  ]);
  const result=match(row,{city:'',country:'USA',address:`44 Main Street, Sacramento, California${includeCountry?', USA':''}`,
    ...(confirmed?{confirmedPlaceId:'venue'}:{})},'Lumina Cafe in California USA');
  expect(result.place).toBeNull();
  expect(result.ranked[0].evidence).toMatchObject({addressConflict:true,
    addressReasons:expect.arrayContaining(['address_region_conflict'])});
});

test.each(['Lumina Cafe in HCMC','Lumina Cafe, HCMC, Vietnam','Lumina Cafe in Saigon'])
('caption-only locality alias requires confirmation: %s',description=>{
  const row=candidate(address,components);
  for (const result of [rankPlaces([row],{description},{name:'Lumina Cafe'}),calculateConfidence([row],{description})]) {
    expect(result.place?.place_id).toBe(row.place_id);
    expect(result.requiresSelection).toBe(true);
    expect(result.ranked[0].evidence.aliasRecovery).toBe(true);
  }
});

test.each([null,{long_name:'California',types:{}},{long_name:'California',types:'country'}])
('malformed component %j cannot crash formatted-address fallback',bad=>{
  const row=candidate(address,[bad]);
  expect(()=>match(row)).not.toThrow();
  expect(match(row).place).toBe(row);
});

test.each(['44 Saigon Street, Hồ Chí Minh, Vietnam','44 Saigon, Hồ Chí Minh, Vietnam'])
('locality aliases cannot erase different route names: %s',hint=>{
  const suffix=hint.includes('Street')?' Street':'';
  const row=candidate(`44 HCMC${suffix}, Hồ Chí Minh, Vietnam`,[
    component('44','street_number'),component(`HCMC${suffix}`,'route'),hcm,vn,
  ]);
  const result=match(row,{address:hint},`Lumina Cafe at ${hint}`);
  expect(result.place).toBe(row);expect(result.requiresSelection).toBe(true);
  expect(result.ranked[0].evidence).toMatchObject({addressMatches:false,addressStatus:'unknown'});
});

describe('New York City and optional unit details',()=>{
  const parts=[component('12','street_number'),component('Main Street','route'),
    component('New York','locality'),component('New York','administrative_area_level_1','NY'),
    component('United States','country','US'),component('10001','postal_code')];
  const row=(street='12 Main Street',extra=[],typed=true)=>candidate(
    `${street}, New York, NY 10001, USA`,typed?[...parts,...extra]:undefined);
  const assess=(place,address='12 Main Street, New York, NY, USA',city='New York')=>
    match(place,{address,city,country:'US'},'Lumina Cafe in New York City, USA');

  test.each([true,false])('full city spelling recovers typed/cached geography: %s',typed=>{
    const place=row(undefined,[],typed);
    const result=assess(place,'12 Main Street, New York City, NY, USA','New York City, USA');
    expect(result.place).toBe(place);
    expect(result.requiresSelection).toBe(true);
    expect(result.ranked[0].evidence).toMatchObject({cityMatches:true,addressConflict:false});
  });
  test.each(['New York','NYC'])('full Google city spelling also supports %s',city=>{
    const place=candidate('12 Main Street, New York City, NY, USA',[
      ...parts.filter(p=>!p.types.includes('locality')),component('New York City','locality')]);
    expect(assess(place,'',city).place).toBe(place);
  });
  test.each(['New York City, California','New York City, Brooklyn','York','Yorkshire'])
  ('city spelling recovery cannot discard unmatched geography: %s',city=>{
    expect(assess(row(),'',city).place).toBeNull();
  });
  test.each([true,false])('New York state cannot stand in for New York City: %s',typed=>{
    const place=candidate('12 Main Street, Albany, New York, USA',typed?[
      ...parts.filter(p=>!p.types.includes('locality')),component('Albany','locality')]:undefined);
    expect(assess(place,'','New York City').place).toBeNull();
  });
  test('country-first cached addresses do not turn a state into the city',()=>{
    const place=candidate('USA, New York, Albany, 12 Main Street');
    expect(assess(place,'','New York City').place).toBeNull();
  });
  test('the city alias is country-scoped and excludes routes',()=>{
    const foreign=candidate('12 Main Street, New York, United Kingdom',[
      component('New York','locality'),component('United Kingdom','country','GB')]);
    expect(match(foreign,{city:'New York City',country:'GB',address:''},'Lumina Cafe in New York City').place).toBeNull();
    const road=candidate('12 New York City Road, Albany, NY, USA',[
      component('New York City Road','route'),component('Albany','locality'),parts[3],parts[4]]);
    expect(assess(road,'','New York City').place).toBeNull();
  });

  test.each([
    '12 Main Street, Suite 5','Suite 5, 12 Main Street','12 Main Street, Unit 5A',
    'Shop 17, 12 Main Street','12 Main Street, Floor 2','12 Main Street, 2nd Floor',
    '12 Main Street Suite 5','12 Main Street, Suite 5, Floor 2',
  ])('extra explicit detail remains selectable, not a house-number conflict: %s',street=>{
    for (const typed of [true,false]) {
      const place=row(street,[],typed);
      const result=assess(place);
      expect(result.place).toBe(place);expect(result.requiresSelection).toBe(true);
      expect(result.ranked[0].evidence).toMatchObject({addressConflict:false,addressStatus:'unknown',
        addressReasons:expect.arrayContaining(['unit_unverified'])});
      const reverse=assess(row(),`${street}, New York, NY, USA`);
      expect(reverse.place).not.toBeNull();expect(reverse.requiresSelection).toBe(true);
    }
  });
  test('matching unit and floor values are compared by type, not digit order',()=>{
    const result=assess(row('12 Main Street, Suite 5, Floor 2'),
      'Floor 2, Unit 5, 12 Main Street, New York, NY, USA');
    expect(result.place).not.toBeNull();
    expect(result.ranked[0].evidence).toMatchObject({addressConflict:false,addressStatus:'match'});
    expect(result.requiresSelection).toBe(true);
  });
  test.each([
    ['13 Main Street, Suite 5','12 Main Street','street_number_conflict'],
    ['12A Main Street, Suite 5','12B Main Street','street_number_conflict'],
    ['12/1 Main Street, Suite 5','12/2 Main Street','street_number_conflict'],
    ['12-14 Main Street, Suite 5','12-16 Main Street','street_number_conflict'],
    ['12 Main Street, Suite 5','12 Main Street, Suite 6','unit_conflict'],
    ['12 Main Street, Unit 5A','12 Main Street, Unit 5B','unit_conflict'],
    ['12 Main Street, Unit 5/1','12 Main Street, Unit 5-1','unit_conflict'],
    ['12 Main Street, Floor 2','12 Main Street, Floor 3','unit_conflict'],
  ])('different buildings or units still veto: %s vs %s',(actual,hint,reason)=>{
    const result=assess(row(actual),`${hint}, New York, NY, USA`);
    expect(result.place).toBeNull();
    expect(result.ranked[0].evidence.addressReasons).toContain(reason);
  });
  test.each(['13 Main Street, New York, USA','12 Main Street, Albany, NY, USA',
    '12 Main Street, New York, Japan'])('unit recovery cannot mask another contradiction: %s',hint=>{
    expect(assess(row('12 Main Street, Suite 5'),hint).place).toBeNull();
  });
  test('unit recovery does not authorize a different street or business',()=>{
    const result=assess(row('12 Main Street, Suite 5'),'12 Other Street, New York, NY, USA');
    expect(result.requiresSelection).toBe(true);
    expect(result.ranked[0].evidence.addressMatches).toBe(false);
    expect(assess({...row('12 Main Street, Suite 5'),name:'Another Venue'}).place).toBeNull();
  });
  test('a numbered route is not a unit and its number remains significant',()=>{
    const place=row('12 Unit 5 Road, Suite 8');
    expect(assess(place,'12 Unit 6 Road, New York, NY, USA').place).toBeNull();
  });
  test('structured route and unmarked numbers are not discarded as unit details',()=>{
    const place=row('12 Main Street, 5',[component('5','subpremise')]);
    expect(assess(place).place).toBeNull();
    const routeOnly=candidate('Unit 5, New York, USA',[
      component('Unit 5','route'),parts[2],parts[3],parts[4]]);
    expect(assess(routeOnly,'Unit 6, New York, USA').place).toBeNull();
  });
});
