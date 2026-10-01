const {rankPlaces,similarity}=require('../enrich/confidence');
const {geography,addressEvidence,nameEvidence}=require('../enrich/matchingEvidence');
const fixture=require('./engine/vietnam-address-incident.json');

const google=extra=>({...structuredClone(fixture.google),...extra});
const source=extra=>({...fixture.source,...extra});
const assess=(row=google(),extra={})=>rankPlaces([row],
  {description:'Tầm Vị — 4B Yên Thế, Đống Đa, Hà Nội, Việt Nam'},source(extra));
const address=(hint,row=google())=>addressEvidence(hint,geography(row));
const changeComponent=(kind,patch)=>google({address_components:fixture.google.address_components.map(c=>
  c.types.includes(kind)?{...c,...patch}:c)});

describe('recorded Tầm Vị address incident',()=>{
  test('same structured street and Hanoi retain the real place for user confirmation',()=>{
    const row=google(),before=JSON.stringify(row),result=assess(row);
    expect(result.place).toBe(row);
    expect(result.place.place_id).toBe('ChIJq43P62mrNTERNsxL8Wjpvjs');
    expect(result.requiresSelection).toBe(true);
    expect(result.ranked[0].evidence).toMatchObject({cityMatches:true,addressMatches:true,
      addressStatus:'unknown',addressConflict:false,
      addressReasons:expect.arrayContaining(['geography_components_missing','lower_area_unverified'])});
    expect(JSON.stringify(row)).toBe(before);
  });

  test('the lower-area recovery itself requires selection even with an exact name and literal city',()=>{
    const result=assess(google({name:'Tầm Vị'}),{city:'Hà Nội'});
    expect(result.place).not.toBeNull();expect(result.requiresSelection).toBe(true);
    expect(result.ranked[0].evidence).toMatchObject({nameScore:1,aliasRecovery:false,addressStatus:'unknown'});
    expect(address(fixture.source.address)).toMatchObject({matches:true,conflict:false,requiresSelection:true});
  });

  test.each(['','Phố ','P. ','Đường ','Đ. ','Duong ','D. '])
  ('only the Vietnamese route prefix is optional: %s',prefix=>{
    expect(address(`4B ${prefix}Yên Thế, Đống Đa, Hà Nội`))
      .toMatchObject({matches:true,conflict:false,status:'unknown',requiresSelection:true});
  });

  test.each(['Yên Thế','Phố Yên Thế','P. Yên Thế','Đường Yên Thế','Đ. Yên Thế'])
  ('complete structured route accepts %s',route=>{
    const row=changeComponent('route',{long_name:route,short_name:route});
    expect(assess(row)).toMatchObject({place:row,requiresSelection:true});
  });

  test.each(['Hanoi','Hà Nội City','Thành phố Hà Nội'])('complete city spelling %s anchors the address',city=>{
    expect(address(`4B Yên Thế, Đống Đa, ${city}`))
      .toMatchObject({matches:true,conflict:false,requiresSelection:true});
  });

  test.each(['Đống Đa','Dong Da','Quận Đống Đa','Dong Da District'])('recognized district label %s stays unresolved',district=>{
    expect(address(`4B Yên Thế, ${district}, Hà Nội`))
      .toMatchObject({matches:true,status:'unknown',requiresSelection:true});
  });

  test.each(['Quận Ba Đình','Phường Ba Đình','Ba Dinh District','Ba Dinh Ward'])
  ('explicit lower-area marker %s can remain unknown under the same city',district=>{
    expect(address(`4B Yên Thế, ${district}, Hà Nội`))
      .toMatchObject({matches:true,status:'unknown',requiresSelection:true});
  });

  test('explicit district recovery also requires a typed city in a different Vietnam city',()=>{
    const row=google({formatted_address:'4b P. Yên Thế, Phường Bến Thành, Hồ Chí Minh, Việt Nam',
      address_components:fixture.google.address_components.map(c=>c.types.includes('administrative_area_level_1')
        ? {...c,long_name:'Hồ Chí Minh',short_name:'Hồ Chí Minh'} : c)});
    expect(address('4B Yên Thế, Quận Bình Thạnh, Hồ Chí Minh',row))
      .toMatchObject({matches:true,status:'unknown',requiresSelection:true});
    expect(address('4B Yên Thế, Đống Đa, Hồ Chí Minh',row)).toMatchObject({conflict:true});
  });

  test('the old district is not asserted to be an alias of the new ward',()=>{
    expect(geography(google()).groups.flatMap(g=>g.aliases)).not.toContain('đong đa');
  });
});

describe('Vietnam address contradictions remain vetoes',()=>{
  test.each([
    ['country','4B Yên Thế, Đống Đa, Hà Nội, Japan','country_conflict'],
    ['house number','5B Yên Thế, Đống Đa, Hà Nội','street_number_conflict'],
    ['house suffix','4C Yên Thế, Đống Đa, Hà Nội','street_number_conflict'],
    ['missing suffix','4 Yên Thế, Đống Đa, Hà Nội','street_number_conflict'],
    ['compound house','4B/1 Yên Thế, Đống Đa, Hà Nội','street_number_conflict'],
    ['house range','4B-4C Yên Thế, Đống Đa, Hà Nội','street_number_conflict'],
    ['compound house digits','4B1 Yên Thế, Đống Đa, Hà Nội','street_number_conflict'],
    ['route','4B Nguyễn Thái Học, Đống Đa, Hà Nội','address_region_conflict'],
    ['route suffix','4B Yên Thế Mới, Đống Đa, Hà Nội','address_region_conflict'],
    ['route prefix compound','4B Ngõ Yên Thế, Đống Đa, Hà Nội','address_region_conflict'],
    ['route substring','4B Yên Thếx, Đống Đa, Hà Nội','address_region_conflict'],
    ['wrong city','4B Yên Thế, Đống Đa, Hồ Chí Minh, Việt Nam','address_region_conflict'],
    ['wrong city before Hanoi','4B Yên Thế, Hải Phòng, Hà Nội','address_region_conflict'],
    ['additional city','4B Yên Thế, Đống Đa, Đà Nẵng, Hà Nội','address_region_conflict'],
    ['unrecognized district','4B Yên Thế, Ba Đình, Hà Nội','address_region_conflict'],
    ['district compound','4B Yên Thế, Đống Đa Annex, Hà Nội','address_region_conflict'],
  ])('%s cannot borrow the exact street or venue identity',(_label,hint,reason)=>{
    for (const confirmedPlaceId of [undefined,fixture.google.place_id]) {
      const result=assess(google(),{address:hint,confirmedPlaceId});
      expect(result.place).toBeNull();
      expect(result.ranked[0].evidence).toMatchObject({addressMatches:false,addressConflict:true,
        addressReasons:expect.arrayContaining([reason])});
    }
  });

  test.each([{city:'Hồ Chí Minh'},{city:'Hải Phòng'},{country:'Japan'},{confirmedPlaceId:'other-place'}])
  ('explicit extraction contradiction %j still rejects',override=>{
    expect(assess(google(),override).place).toBeNull();
  });

  test.each(['street_number','route','administrative_area_level_1'])
  ('missing structured %s cannot authorize the recovery',kind=>{
    const row=google({address_components:fixture.google.address_components.filter(c=>!c.types.includes(kind))});
    expect(assess(row).place).toBeNull();
    expect(address(fixture.source.address,row).reasons).not.toContain('lower_area_unverified');
  });

  test.each([
    ['house',{long_name:'5b',short_name:'5b'},'street_number'],
    ['route',{long_name:'Phố Nguyễn Thái Học',short_name:'P. Nguyễn Thái Học'},'route'],
    ['city',{long_name:'Hồ Chí Minh',short_name:'Hồ Chí Minh'},'administrative_area_level_1'],
    ['country',{long_name:'Japan',short_name:'JP'},'country'],
    ['route alias',{short_name:'P. Yên Thế Mới'},'route'],
  ])('conflicting structured %s cannot recover the candidate',(_label,patch,kind)=>{
    expect(assess(changeComponent(kind,patch)).place).toBeNull();
  });

  test('formatted and structured city must agree for lower-area recovery',()=>{
    const row=google({formatted_address:fixture.google.formatted_address.replace('Hà Nội','Hồ Chí Minh')});
    expect(assess(row,{address:fixture.source.address+', Việt Nam'}).place).toBeNull();
  });

  test.each(['4B Yên Thế, Đống Đa','4B Yên Thế, Đống Đa, Việt Nam'])
  ('city outside the address cannot authorize lower-area recovery: %s',hint=>{
    const result=address(hint);
    expect(result.reasons).not.toContain('lower_area_unverified');
    expect(result.matches).toBe(false);
  });

  test.each(['Yen The Street','Yen The St.','Y.T.','Yên Thế Mới'])
  ('unverified route representation %s does not add a new veto outside recovery',route=>{
    const hint=`4B ${route}, Văn Miếu - Quốc Tử Giám, Hà Nội`;
    const result=assess(google(),{address:hint});
    expect(result.place).not.toBeNull();expect(result.requiresSelection).toBe(true);
    expect(result.ranked[0].evidence).toMatchObject({addressMatches:false,addressConflict:false,addressStatus:'unknown'});
    expect(assess(google(),{address:`4B ${route}, Đống Đa, Hà Nội`}).place).toBeNull();
  });
});

describe('Vietnamese business descriptor is not identity evidence',()=>{
  test.each([['Tầm Vị','Nhà hàng Tầm Vị'],['Nhà hàng Tầm Vị','Tầm Vị'],['Tam Vi','Nha hang Tam Vi']])
  ('complete remaining name %s / %s is confirmation only',(wanted,actual)=>{
    const name=nameEvidence(wanted,actual,geography(google()),similarity);
    expect(name.score).toBeGreaterThanOrEqual(0.5);expect(name.partial).toBe(true);
    const row=google({name:actual});
    const result=assess(row,{name:wanted,address:'',city:'Hà Nội'});
    expect(result.place).toBe(row);expect(result.requiresSelection).toBe(true);
  });

  test.each([
    ['Tầm Vị','Nhà hàng Tầm An'],
    ['Nhà hàng An Nam','Nhà hàng An Mai'],
    ['Nhà hàng Tầm Vị','Nhà hàng Tầm An'],
    ['Nhà hàng','Nhà hàng Tầm Vị'],
    ['Nhà hàng Hà Nội','Hà Nội'],
    ['Nhà hàng Cafe','Cafe'],
    ['restaurant','Nhà hàng Tầm Vị'],
    ['Nhà hàng Restaurant','Restaurant'],
    ['Nhà hàng Restaurant','Nhà hàng Cafe'],
    ['Nhà hàng Blue Red','Blue Red'],
    ['Tầm Vị','Khách sạn Khác'],
  ])('generic or incomplete overlap %s / %s cannot identify the business',(wanted,actual)=>{
    const result=assess(google({name:actual}),{name:wanted});
    expect(result.place).toBeNull();
  });

  test('the address recovery does not special-case the incident venue name or ID',()=>{
    const row=google({name:'Lantern Kitchen',place_id:'synthetic-other-venue'});
    const result=assess(row,{name:'Lantern Kitchen',city:'Hà Nội'});
    expect(result.place).toBe(row);expect(result.requiresSelection).toBe(true);
  });
});
