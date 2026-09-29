jest.mock('../lib/firestore',()=>({firestore:require('./helpers/fakeFirestore').getSharedFirestore(),admin:require('./helpers/fakeFirestore').makeAdmin()}));
jest.mock('../lib/push',()=>({sendPushForJob:jest.fn()}));
jest.mock('../lib/thumbnails',()=>({persistThumbnail:jest.fn(async()=> '')}));
jest.mock('../enrich/ai',()=>({aiExtractPlaces:jest.fn(),aiExtractPlace:jest.fn(),aiVerifyPlace:jest.fn()}));
jest.mock('../lib/extraction',()=>({extractPublicPost:jest.fn()}));
jest.mock('../enrich/places',()=>({searchGooglePlaces:jest.fn(),getCachedPlaceDetails:jest.fn(async()=>null)}));
jest.mock('../lib/vision',()=>({extractPlacesFromSlides:jest.fn(async()=>({places:[]}))}));
jest.mock('../lib/cache',()=>({redis:null,getCached:jest.fn(async()=>null),setCache:jest.fn(async()=>{})}));
const {firestore:db}=require('../lib/firestore');
const {runEnrichment,saveSelectedPlaces}=require('../enrich');
const {EngineError,failureOf}=require('../lib/engineError');
const ai=require('../enrich/ai'),places=require('../enrich/places'),source=require('../lib/extraction');
// Names, addresses and IDs are the recorded Google responses for the reported
// failures. Tokyo coordinates are synthetic valid values; these tests replay
// matching decisions, not Google's live ranking. The chicken-shop fixture also
// has a real localized response obtained during verification.
const fixtures=require('./engine/matching-google-results.json');
const localizedChicken=require('./engine/matching-localized-google.json');
const url='https://www.instagram.com/reel/MatchingRegression/';
const run=()=>runEnrichment('job',url,'u','');
const ogPlace={place_id:'tai-sushi',name:'Tai Sushi',formatted_address:'1 Main Street, Kyoto, Japan',geometry:{location:{lat:35,lng:135}},types:['restaurant']};
function seedExisting(place) {
  // A social short URL exercises the primary-URL upgrade as well as sources[].
  db.seed('pins','prior',{userId:'u',placeId:place.place_id,placeName:place.name,url:'https://www.tiktok.com/t/OldShare/',sources:[{url:'https://example.com/old-source'}],visited:true});
  return db.read('pins','prior');
}
beforeEach(()=>{
  db.reset();jest.clearAllMocks();db.seed('users','u',{});
  db.seed('enrichmentJobs','job',{userId:'u',url,status:'processing'});
  source.extractPublicPost.mockResolvedValue({title:'Restaurants',description:'',webpage_url:url});
  ai.aiExtractPlaces.mockResolvedValue({places:[]});
  ai.aiVerifyPlace.mockResolvedValue({match:false});
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

test.each([false,true])('localized recovery waits for confirmation before saving or attaching a source (existing pin: %s)',async existing=>{
  const p={name:'上好雞肉',city:'新北市中和區',address:'235新北市中和區民治街8巷1號',source:'caption'};
  source.extractPublicPost.mockResolvedValue({title:p.name,description:p.address,webpage_url:url});
  ai.aiExtractPlaces.mockResolvedValue({places:[p]});
  const recorded=fixtures.at(-1).results[0];
  const prior=existing ? seedExisting(recorded) : null;
  places.searchGooglePlaces.mockImplementation(async(_q,_bias,_restriction,options)=>options?.languageCode
    ? [localizedChicken] : [recorded]);
  await run();
  const job=db.read('enrichmentJobs','job');
  expect(job.status).toBe('needs_selection');expect(job.candidates).toHaveLength(1);
  expect(job.outcomes[0].requiresSelection).toBe(true);expect(places.searchGooglePlaces).toHaveBeenCalledTimes(2);
  expect(job.outcomes[0].ranking.candidates).toEqual(expect.arrayContaining([
    expect.objectContaining({placeId:recorded.place_id,addressStatus:'match',addressConflict:false,addressReasons:[]}),
  ]));
  expect((await db.collection('pins').get()).size).toBe(existing?1:0);
  if(existing)expect(db.read('pins','prior')).toEqual(prior);
  expect((await db.collection('pinContentIndex').get()).size).toBe(0);
  await saveSelectedPlaces('job','u',[recorded.place_id]);
  const saved=(await db.collection('pins').get()).docs;
  expect(saved).toHaveLength(1);
  expect(saved[0].data().sources.filter(s=>s.url===url)).toHaveLength(1);
  expect(db.read('enrichmentJobs','job')).toMatchObject({status:'complete',progress:{saved:1,total:1}});
  if(existing)expect(saved[0].id).toBe('prior');
  expect(places.searchGooglePlaces).toHaveBeenCalledTimes(2);
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

describe('OG fallback confirmation',()=>{
  test.each([
    ['missing geography',false,false,'Dinner'],['missing geography',true,false,'Dinner'],
    ['ambiguous branches',false,true,'Dinner in Kyoto'],['ambiguous branches',true,true,'Dinner in Kyoto'],
    ['tentative caption recovery',false,false,'Dinner in 3 days'],['tentative caption recovery',true,false,'Dinner in 3 days'],
  ])('%s waits for selection before pin/source mutations (existing pin: %s)',async(_label,existing,ambiguous,description)=>{
    source.extractPublicPost.mockResolvedValue({title:ogPlace.name,description,webpage_url:url});
    places.searchGooglePlaces.mockResolvedValue(ambiguous?[ogPlace,{...ogPlace,place_id:'other-branch'}]:[ogPlace]);
    const prior=existing ? seedExisting(ogPlace) : null;
    await run();
    const job=db.read('enrichmentJobs','job');
    expect(job.status).toBe('needs_selection');
    expect(job.candidates).toHaveLength(1);
    expect(job.candidates[0]).toMatchObject({placeId:ogPlace.place_id,userId:'u',url});
    expect((await db.collection('pins').get()).size).toBe(existing?1:0);
    if(existing)expect(db.read('pins','prior')).toEqual(prior);
    expect((await db.collection('pinContentIndex').get()).size).toBe(0);
    expect(require('../lib/push').sendPushForJob).toHaveBeenCalledWith('job','u','needs_selection');
    expect(places.searchGooglePlaces).toHaveBeenCalledTimes(1);
    await saveSelectedPlaces('job','u',[ogPlace.place_id]);
    await saveSelectedPlaces('job','u',[ogPlace.place_id]);
    const saved=(await db.collection('pins').get()).docs;
    expect(saved).toHaveLength(1);
    expect(saved[0].data().sources.filter(s=>s.url===url)).toHaveLength(1);
    expect(db.read('enrichmentJobs','job')).toMatchObject({status:'complete',progress:{saved:1,total:1}});
    if(existing) {
      expect(saved[0].id).toBe('prior');
      expect(saved[0].data()).toMatchObject({url,visited:true,sources:[prior.sources[0],expect.objectContaining({url})]});
    }
    expect(places.searchGooglePlaces).toHaveBeenCalledTimes(1);
  });

  test.each([false,true])('dismissal never saves or attaches an uncertain fallback (existing pin: %s)',async existing=>{
    source.extractPublicPost.mockResolvedValue({title:ogPlace.name,description:'Dinner',webpage_url:url});
    places.searchGooglePlaces.mockResolvedValue([ogPlace]);
    const prior=existing ? seedExisting(ogPlace) : null;
    await run();
    expect(db.read('enrichmentJobs','job').status).toBe('needs_selection');
    await saveSelectedPlaces('job','u',[]);
    expect(db.read('enrichmentJobs','job').status).toBe('complete');
    expect((await db.collection('pins').get()).size).toBe(existing?1:0);
    if(existing)expect(db.read('pins','prior')).toEqual(prior);
    expect((await db.collection('pinContentIndex').get()).size).toBe(0);
  });

  test('a verified high-confidence existing match remains an immediate duplicate',async()=>{
    source.extractPublicPost.mockResolvedValue({title:ogPlace.name,description:'Dinner in Kyoto',webpage_url:url});
    places.searchGooglePlaces.mockResolvedValue([ogPlace]);
    seedExisting(ogPlace);
    await run();
    expect(db.read('enrichmentJobs','job')).toMatchObject({status:'duplicate',existingPinId:'prior',sourceAdded:true});
    expect((await db.collection('pins').get()).size).toBe(1);
    expect(db.read('pins','prior')).toMatchObject({url,visited:true});
    expect(db.read('pins','prior').sources.filter(s=>s.url===url)).toHaveLength(1);
    expect(places.searchGooglePlaces).toHaveBeenCalledTimes(1);
    expect(places.getCachedPlaceDetails).not.toHaveBeenCalled();
    expect(ai.aiVerifyPlace).not.toHaveBeenCalled();
  });
});

test.each([false,true])('an unverified address needs confirmation even with a grounded name/city (existing pin: %s)',async existing=>{
  const p={name:ogPlace.name,city:'Kyoto',address:'1 Side Lane, Kyoto, Japan',source:'caption'};
  source.extractPublicPost.mockResolvedValue({title:p.name,description:p.address,webpage_url:url});
  ai.aiExtractPlaces.mockResolvedValue({places:[p]});
  places.searchGooglePlaces.mockResolvedValue([ogPlace]);
  const prior=existing ? seedExisting(ogPlace) : null;
  await run();
  const job=db.read('enrichmentJobs','job');
  expect(job).toMatchObject({status:'needs_selection',candidates:[{placeId:ogPlace.place_id}]});
  expect(job.outcomes[0]).toMatchObject({requiresSelection:true,ranking:{candidates:[{
    cityHintSource:'extracted',cityMatches:true,geoMention:true,addressStatus:'unknown',addressConflict:false,
    addressReasons:expect.arrayContaining(['street_unverified']),
  }]}});
  expect((await db.collection('pins').get()).size).toBe(existing?1:0);
  if(existing)expect(db.read('pins','prior')).toEqual(prior);
  expect((await db.collection('pinContentIndex').get()).size).toBe(0);
  await saveSelectedPlaces('job','u',[ogPlace.place_id]);
  const saved=(await db.collection('pins').get()).docs;
  expect(saved).toHaveLength(1);
  expect(saved[0].data().sources.filter(s=>s.url===url)).toHaveLength(1);
  if(existing)expect(saved[0].id).toBe('prior');
  expect(places.searchGooglePlaces).toHaveBeenCalledTimes(1);
});

test.each([false,true])('caption-only HCMC alias waits for approval before any pin or source write (existing pin: %s)',async existing=>{
  const place={...ogPlace,formatted_address:'1 Main Street, Hồ Chí Minh, Vietnam',address_components:[
    {long_name:'Hồ Chí Minh',types:['locality']},
    {long_name:'Vietnam',short_name:'VN',types:['country']},
  ]};
  source.extractPublicPost.mockResolvedValue({title:place.name,description:'Dinner in HCMC',webpage_url:url});
  places.searchGooglePlaces.mockResolvedValue([place]);
  const prior=existing?seedExisting(place):null;
  await run();
  expect(db.read('enrichmentJobs','job')).toMatchObject({status:'needs_selection',candidates:[{placeId:place.place_id}]});
  expect((await db.collection('pins').get()).size).toBe(existing?1:0);
  if(existing)expect(db.read('pins','prior')).toEqual(prior);
  expect(ai.aiVerifyPlace).not.toHaveBeenCalled();
  await saveSelectedPlaces('job','u',[place.place_id]);
  const saved=(await db.collection('pins').get()).docs;
  expect(saved).toHaveLength(1);
  expect(saved[0].data().sources.filter(s=>s.url===url)).toHaveLength(1);
});

describe('matching failure stages',()=>{
  test.each([
    ['invalid query',{name:'x'},[]],
    ['empty results',{name:'Unknown Cafe'},[]],
    ['rejected geography',{name:ogPlace.name,city:'Tokyo'},[ogPlace]],
  ])('%s reports an engine matching failure on the outcome and job',async(_label,p,results)=>{
    source.extractPublicPost.mockResolvedValue({title:'instagram',description:'',webpage_url:url});
    ai.aiExtractPlaces.mockResolvedValue({places:[p]});
    places.searchGooglePlaces.mockResolvedValue(results);
    await run();
    const job=db.read('enrichmentJobs','job');
    const failure={code:'no_verified_match',stage:'matching',provider:'engine'};
    expect(job).toMatchObject({status:'failed',failure});
    expect(job.outcomes).toHaveLength(1);
    expect(job.outcomes[0]).toMatchObject({status:'unresolved',failure});
    if(results.length)expect(job.outcomes[0].ranking.candidates[0]).toMatchObject({
      placeId:ogPlace.place_id,score:0,cityMatches:false,cityHintSource:'extracted',addressStatus:'not_provided',
    });
    expect((await db.collection('pins').get()).size).toBe(0);
  });

  test('no extracted place retains the extraction-stage no_place_found failure',async()=>{
    source.extractPublicPost.mockResolvedValue({title:'instagram',description:'',webpage_url:url});
    await run();
    expect(db.read('enrichmentJobs','job')).toMatchObject({status:'failed',failure:{code:'no_place_found',stage:'extraction',provider:'engine'}});
    expect(places.searchGooglePlaces).not.toHaveBeenCalled();
  });

  test('an independent source failure keeps its stage when matching also fails',async()=>{
    source.extractPublicPost.mockResolvedValue({title:'instagram',description:'',webpage_url:url,
      subtitle_failures:[{code:'rate_limited',retryAfterSeconds:23}]});
    ai.aiExtractPlaces.mockResolvedValue({places:[{name:'Unknown Cafe'}]});
    await run();
    const job=db.read('enrichmentJobs','job');
    expect(job).toMatchObject({status:'failed',failure:{code:'rate_limited',stage:'subtitles',provider:'instagram',retryAfterSeconds:23}});
    expect(job.outcomes[0].failure).toMatchObject({code:'no_verified_match',stage:'matching',provider:'engine'});
  });

  test.each([false,true])('preserves provider failure metadata (localized lookup: %s)',async localized=>{
    source.extractPublicPost.mockResolvedValue({title:'instagram',description:'',webpage_url:url});
    ai.aiExtractPlaces.mockResolvedValue({places:[localized
      ? {name:'上好雞肉',city:'新北市中和區',address:'235新北市中和區民治街8巷1號',source:'caption'}
      : {name:ogPlace.name,city:'Kyoto',source:'caption'}]});
    const error=new EngineError('rate_limited',{stage:'admission',provider:'google',retryAfterSeconds:17});
    places.searchGooglePlaces.mockImplementation(async(_q,_bias,_restriction,options)=>{
      if(!localized || options?.languageCode)throw error;
      return fixtures.at(-1).results;
    });
    await run();
    const job=db.read('enrichmentJobs','job');
    expect(job).toMatchObject({status:'failed',failure:failureOf(error)});
    expect(job.outcomes[0].failure).toEqual(failureOf(error));
    expect(places.searchGooglePlaces).toHaveBeenCalledTimes(localized?2:1);
  });
});
