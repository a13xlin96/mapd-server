jest.mock('../lib/firestore',()=>({firestore:require('./helpers/fakeFirestore').getSharedFirestore(),admin:require('./helpers/fakeFirestore').makeAdmin()}));
jest.mock('../lib/push',()=>({sendPushForJob:jest.fn()}));
jest.mock('../lib/thumbnails',()=>({persistThumbnail:jest.fn(async()=> '')}));
jest.mock('../enrich/ai',()=>({aiExtractPlaces:jest.fn(),aiExtractPlace:jest.fn(),aiVerifyPlace:jest.fn()}));
jest.mock('../lib/extraction',()=>({extractPublicPost:jest.fn()}));
jest.mock('../enrich/places',()=>({searchGooglePlaces:jest.fn(),getCachedPlaceDetails:jest.fn(async()=>null)}));
jest.mock('../lib/vision',()=>({extractPlacesFromSlides:jest.fn(async()=>({places:[]}))}));
const {firestore:db}=require('../lib/firestore');
const {runEnrichment,saveSelectedPlaces}=require('../enrich');
const ai=require('../enrich/ai'),places=require('../enrich/places'),source=require('../lib/extraction');
// Names, addresses and IDs are the recorded Google responses for the reported
// failures. Tokyo coordinates are synthetic valid values; these tests replay
// matching decisions, not Google's live ranking. The chicken-shop fixture also
// has a real localized response obtained during verification.
const fixtures=require('./engine/matching-google-results.json');
const localizedChicken=require('./engine/matching-localized-google.json');
const url='https://www.instagram.com/reel/MatchingRegression/';
const run=()=>runEnrichment('job',url,'u','');
beforeEach(()=>{
  db.reset();jest.clearAllMocks();db.seed('users','u',{});
  db.seed('enrichmentJobs','job',{userId:'u',url,status:'processing'});
  source.extractPublicPost.mockResolvedValue({title:'Restaurants',description:'',webpage_url:url});
  ai.aiExtractPlaces.mockResolvedValue({places:[]});
  places.searchGooglePlaces.mockImplementation(async query=>fixtures.find(f=>f.query===query)?.results || []);
});

test('reported Tokyo names reach selection, English/Japanese aliases count once, with no new Google-language calls',async()=>{
  const names=['Oudouya Chokkei IEKEI TOKYO','王道家直系 IEKEI TOKYO','Shisen Tantanmen Aun Yushima honten','Craft Ramen BiT'];
  ai.aiExtractPlaces.mockResolvedValue({places:names.map(name=>({name,city:'Tokyo, Japan',source:'vision',requiresSelection:true}))});
  await run();
  const job=db.read('enrichmentJobs','job');
  expect(job.status).toBe('needs_selection');
  expect(job.candidates).toHaveLength(3);
  expect(job.outcomes).toHaveLength(3);
  expect(job.outcomes.every(o=>o.status==='candidate')).toBe(true);
  expect(places.searchGooglePlaces).toHaveBeenCalledTimes(4);
  expect(places.searchGooglePlaces.mock.calls.every(call=>call.length===1)).toBe(true);
  expect((await db.collection('pins').get()).size).toBe(0);
  await saveSelectedPlaces('job','u',job.candidates.map(p=>p.placeId));
  expect(db.read('enrichmentJobs','job').progress).toEqual({saved:3,total:3});
  expect((await db.collection('pins').get()).size).toBe(3);
});

test('Chinese name with English Google result recovers to a confirmation card, not a failed or automatically saved pin',async()=>{
  const p={name:'上好雞肉',city:'新北市中和區',address:'235新北市中和區民治街8巷1號',source:'caption'};
  source.extractPublicPost.mockResolvedValue({title:p.name,description:p.address,webpage_url:url});
  ai.aiExtractPlaces.mockResolvedValue({places:[p]});
  const recorded=fixtures.at(-1).results[0];
  places.searchGooglePlaces.mockImplementation(async(_q,_bias,_restriction,options)=>options?.languageCode
    ? [localizedChicken] : [recorded]);
  await run();
  const job=db.read('enrichmentJobs','job');
  expect(job.status).toBe('needs_selection');expect(job.candidates).toHaveLength(1);
  expect(job.outcomes[0].requiresSelection).toBe(true);expect(places.searchGooglePlaces).toHaveBeenCalledTimes(2);
  expect((await db.collection('pins').get()).size).toBe(0);
});

test('a plausible name variant stays selectable alongside an unresolved place, without silently dropping either',async()=>{
  source.extractPublicPost.mockResolvedValue({title:'Tokyo restaurants',description:'Mendokoro Haru, Unknown Cafe, Tokyo Japan',webpage_url:url});
  ai.aiExtractPlaces.mockResolvedValue({places:[{name:'Mendokoro Haru',city:'Tokyo, Japan',source:'caption'},{name:'Unknown Cafe',city:'Tokyo, Japan',source:'caption'}]});
  await run();
  const job=db.read('enrichmentJobs','job');
  expect(job.status).toBe('needs_selection');expect(job.candidates).toHaveLength(1);
  expect(job.outcomes.find(o=>o.name==='Unknown Cafe').status).toBe('unresolved');
  expect(job.outcomes.find(o=>o.name==='Mendokoro Haru').requiresSelection).toBe(true);
  expect((await db.collection('pins').get()).size).toBe(0);
  await saveSelectedPlaces('job','u',job.candidates.map(p=>p.placeId));
  const saved=db.read('enrichmentJobs','job');
  expect(saved.progress).toEqual({saved:1,total:2});expect(saved.failure.code).toBe('partial_save');
});

test.each([
  ['English first',false,false],['Chinese first',true,false],
  ['English first, existing pin',false,true],['Chinese first, existing pin',true,true],
])('%s: duplicate aliases retain confirmation before saving or attaching a source',async(_label,reverse,existing)=>{
  const english={name:'Shang Hao',city:'New Taipei City',country:'Taiwan',source:'caption'};
  const chinese={name:'上好雞肉',city:'新北市中和區',address:'235新北市中和區民治街8巷1號',source:'caption'};
  const recorded=fixtures.at(-1).results[0];
  source.extractPublicPost.mockResolvedValue({title:'Dinner',description:'Shang Hao in New Taipei City, Taiwan. 上好雞肉 235新北市中和區民治街8巷1號',webpage_url:url});
  ai.aiExtractPlaces.mockResolvedValue({places:reverse?[chinese,english]:[english,chinese]});
  places.searchGooglePlaces.mockImplementation(async(_q,_bias,_restriction,options)=>options?.languageCode ? [localizedChicken] : [recorded]);
  if(existing)db.seed('pins','prior',{userId:'u',placeId:recorded.place_id,placeName:recorded.name,url:'https://example.com/old',sources:[]});
  await run();
  const job=db.read('enrichmentJobs','job');
  expect(job.status).toBe('needs_selection');expect(job.candidates).toHaveLength(1);
  expect(job.outcomes).toHaveLength(1);expect(job.outcomes[0].requiresSelection).toBe(true);
  expect((await db.collection('pins').get()).size).toBe(existing?1:0);
  if(existing)expect(db.read('pins','prior')).toMatchObject({url:'https://example.com/old',sources:[]});
});
