const {rankPlaces}=require('../enrich/confidence');
const recorded=require('./engine/kuma-google-response.json').result;
const component=(long_name,type,short_name=long_name)=>({long_name,short_name,types:[type]});
const clues=[
  {name:'Kuma Omakase',city:'Ho Chi Minh City',address:'44 Dang Thi Nhu, Ben Thanh Ward, HCMC, Vietnam',source:'caption'},
  {name:'Kuma Omakase',city:'HCMC',country:'Vietnam',address:'44 Dang Thi Nhu, Ben Thanh Ward',source:'caption'},
];
const match=(row=recorded,clue=clues[0])=>rankPlaces([row],{description:'Kuma Omakase at 44 Dang Thi Nhu, Ben Thanh Ward, HCMC, Vietnam'},clue);

test.each(clues)('recorded Google floor detail does not contradict the extracted street: %j',clue=>{
  const result=match(recorded,clue);
  expect(result.place?.place_id).toBe(recorded.place_id);
  expect(result.requiresSelection).toBe(true);
  expect(result.ranked[0].evidence).toMatchObject({addressConflict:false,addressStatus:'unknown'});
  expect(result.ranked[0].evidence.addressReasons).toContain('unit_unverified');
});

test.each(['45','44/1','44-46','44A'])('different house %s still fails with a Google floor',number=>{
  const result=match(recorded,{...clues[0],address:clues[0].address.replace('44 ',number+' ')});
  expect(result.place).toBeNull();
  expect(result.ranked[0].evidence.addressReasons).toContain('street_number_conflict');
});

test.each(['Tầng 3','Floor 3','Unit 3'])('a conflicting or unverified unit %s cannot auto-save',unit=>{
  const result=match(recorded,{...clues[0],address:`${unit}, ${clues[0].address}`});
  if(unit==='Unit 3') expect(result.requiresSelection || !result.place).toBe(true);
  else {
    expect(result.place).toBeNull();
    expect(result.ranked[0].evidence.addressReasons).toContain('unit_conflict');
  }
});

test.each([
  ['Japan','JP','2F','subpremise'],
  ['France','FR','Étage 2','floor'],
  ['Mexico','MX','Local 2','subpremise'],
  ['Taiwan','TW','2樓','floor'],
  ['Vietnam','VN','Tầng 2','subpremise'],
])('Google-labeled unit in %s is independent of the building number', (country,code,unit,kind)=>{
  const row={...recorded,name:'Test Venue',formatted_address:`${unit}, 44 Example Road, Example City, ${country}`,
    address_components:[component(unit,kind),component('44','street_number'),component('Example Road','route'),
      component('Example City','locality'),component(country,'country',code)]};
  const clue={name:row.name,city:'Example City',country,address:`44 Example Road, Example City, ${country}`,source:'caption'};
  const result=match(row,clue);
  expect(result.place).toBe(row);expect(result.requiresSelection).toBe(true);
  expect(result.ranked[0].evidence.addressConflict).toBe(false);
});

test('a known numbered route cannot be stripped as a unit',()=>{
  const row={...recorded,formatted_address:'Tầng 2, 44 Other Street, Hồ Chí Minh, Vietnam',
    address_components:[component('Tầng 2','route'),component('44','street_number'),component('Hồ Chí Minh','locality'),component('Vietnam','country','VN')]};
  expect(match(row).place).toBeNull();
});

test('a bare numeric address part without typed unit evidence is not discarded',()=>{
  expect(match({...recorded,formatted_address:recorded.formatted_address.replace('Tầng 2','2'),
    address_components:recorded.address_components.filter(c=>!c.types.includes('subpremise'))}).place).toBeNull();
});

const usRow=(address,extra=[])=>({...recorded,name:'Test Venue',formatted_address:address,
  address_components:[component('44','street_number'),component('Main Street','route'),
    component('Example City','locality'),component('USA','country','US'),...extra]});
const usMatch=(row,address)=>match(row,{name:'Test Venue',city:'Example City',address,source:'caption'});
test('an explicit unit label wins over contradictory floor metadata',()=>{
  const row=usRow('Unit 5, 44 Main Street, Example City, USA',[component('Unit 5','floor')]);
  const result=usMatch(row,'Unit 6, 44 Main Street, Example City, USA');
  expect(result.place).toBeNull();
  expect(result.ranked[0].evidence.addressReasons).toContain('unit_conflict');
});
test('a component also labeled as the house number cannot be stripped',()=>{
  const row=usRow('44, Route 5, Example City, USA',[component('44','subpremise'),component('Route 5','route')]);
  expect(usMatch(row,'Route 5, Example City, USA').place).toBeNull();
});
test.each(['Japan','Example City'])('geography %s cannot be removed as a purported unit',label=>{
  const row=usRow('44 Main Street, Example City, USA',[component(label,'subpremise')]);
  const hint=label==='Japan'?'44 Main Street, Example City, Japan':'44 Main Street, Other City, USA';
  expect(usMatch(row,hint).place).toBeNull();
});
test('a numbered route alone does not supply independent house evidence',()=>{
  const row={...usRow('2, Route 5, Example City, USA',[component('2','subpremise'),component('Route 5','route')]),
    address_components:[component('2','subpremise'),component('Route 5','route'),component('Example City','locality'),component('USA','country','US')]};
  expect(usMatch(row,'Route 5, Example City, USA').place).toBeNull();
});
test('decomposed Vietnamese floor labels retain floor conflicts',()=>{
  const row={...recorded,formatted_address:recorded.formatted_address.normalize('NFD')};
  const result=match(row,{...clues[0],address:'Tầng 3, '+clues[0].address});
  expect(result.place).toBeNull();
  expect(result.ranked[0].evidence.addressReasons).toContain('unit_conflict');
});
