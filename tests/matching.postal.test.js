const {rankPlaces}=require('../enrich/confidence');
const component=(long_name,type,short_name=long_name)=>({long_name,short_name,types:[type]});
const country=component('Vietnam','country','VN');
const city=component('Hồ Chí Minh','administrative_area_level_1');
const parts=[component('44','street_number'),component('Đặng Thị Nhu','route'),
  component('Bến Thành','sublocality_level_1'),city,country];
// Public Maps address observed for the reported failure. Coordinates and ID
// are synthetic. The historical search response was not retained.
const row=(address_components,formatted_address='44 Đặng Thị Nhu, Bến Thành, Hồ Chí Minh 700000, Vietnam')=>({
  place_id:'kuma-test',name:'Kuma Omakase',formatted_address,address_components,
  geometry:{location:{lat:10.77,lng:106.7}},
});
const place={name:'Kuma Omakase',city:'Ho Chi Minh City',
  address:'44 Dang Thi Nhu, Ben Thanh Ward, HCMC, Vietnam',source:'caption'};
const match=(candidate,overrides={})=>rankPlaces([candidate],{description:`${place.name} at ${place.address}`},{...place,...overrides});

test.each([undefined,[city,country],parts,[...parts,component('700000','postal_code')]])
('Vietnam city followed by six-digit postal code does not contradict house 44: %p',components=>{
  const candidate=row(components),result=match(candidate);
  expect(result.place).toBe(candidate);expect(result.requiresSelection).toBe(true);
  expect(result.ranked[0].evidence.addressConflict).toBe(false);
});

test.each(['45','700000','44/1','44-46'])('different house number %s remains a conflict despite postal recovery',number=>{
  const candidate=row([city,country],`${number} Đặng Thị Nhu, Bến Thành, Hồ Chí Minh 700000, Vietnam`);
  expect(match(candidate).place).toBeNull();
  expect(match(candidate).ranked[0].evidence.addressReasons).toContain('street_number_conflict');
});

test.each(['Hồ Chí Minh Street 700000','Đặng Thị Nhu 700000','700000 Đặng Thị Nhu'])
('six-digit number in route segment stays significant: %s',street=>{
  const candidate=row([city,country],`${street}, Bến Thành, Hồ Chí Minh, Vietnam`);
  expect(match(candidate).place).toBeNull();
  expect(match(candidate).ranked[0].evidence.addressReasons).toContain('street_number_conflict');
});

test('postal recovery cannot supply Vietnam geography to a different country',()=>{
  const candidate=row([component('USA','country','US')], '44 Đặng Thị Nhu, Ho Chi Minh 700000, USA');
  expect(match(candidate).place).toBeNull();
});

test('a route named after a different city cannot lose its trailing house number',()=>{
  const candidate=row([component('Hanoi','locality'),country], 'Ho Chi Minh 700000, Hanoi, Vietnam');
  const result=match(candidate,{city:'Hanoi',address:'44 Ho Chi Minh, Hanoi, Vietnam'});
  expect(result.place).toBeNull();
  expect(result.ranked[0].evidence.addressReasons).toContain('street_number_conflict');
});

test.each(['Vietnam, Hanoi, Ho Chi Minh 700000','Ho Chi Minh 700000, Vietnam'])
('structured route and street number override final-locality appearance: %s',address=>{
  const candidate=row([component('Hanoi','locality'),component('Ho Chi Minh','route'),
    component('700000','street_number'),country],address);
  const result=match(candidate,{city:'Hanoi',address:address.replace('700000','700001')});
  expect(result.place).toBeNull();
  expect(result.ranked[0].evidence.addressReasons).toContain('street_number_conflict');
});

test.each([undefined,{long_name:'Ho Chi Minh',types:'route'},null])
('a known six-digit house number protects differing hints with incomplete route data: %p',route=>{
  const candidate=row([component('Hanoi','locality'),component('700000','street_number'),
    country,...(route === undefined ? [] : [route])], 'Ho Chi Minh 700000, Vietnam');
  const result=match(candidate,{city:'Hanoi',address:'Ho Chi Minh 700001, Vietnam'});
  expect(result.place).toBeNull();
  expect(result.ranked[0].evidence.addressReasons).toContain('street_number_conflict');
});

test('city-only six-digit stripping also applies to the source address',()=>{
  const candidate=row(parts,'44 Đặng Thị Nhu, Bến Thành, Hồ Chí Minh, Vietnam');
  expect(match(candidate,{address:'44 Dang Thi Nhu, Ben Thanh Ward, Ho Chi Minh City 700000, Vietnam'}).place).toBe(candidate);
});
