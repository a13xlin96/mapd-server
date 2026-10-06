jest.mock('../lib/firestore',()=>({firestore:require('./helpers/fakeFirestore').getSharedFirestore(),admin:require('./helpers/fakeFirestore').makeAdmin()}));
jest.mock('../lib/extraction',()=>({extractPublicPost:jest.fn()}));
jest.mock('../lib/media/videoEvidence',()=>({collectVideoEvidence:jest.fn()}));
jest.mock('../lib/thumbnails',()=>({persistThumbnail:jest.fn(async()=> '')}));
jest.mock('../lib/vision',()=>({extractPlacesFromSlides:jest.fn(async()=>({places:[]}))}));
jest.mock('../enrich/ai',()=>({aiExtractPlaces:jest.fn(),aiExtractPlace:jest.fn(),aiVerifyPlace:jest.fn()}));
jest.mock('../enrich/places',()=>({searchGooglePlaces:jest.fn(),getCachedPlaceDetails:jest.fn(async()=>null)}));
jest.mock('../lib/push',()=>({sendPushForJob:jest.fn(async()=>{})}));
jest.mock('../lib/interestProfile',()=>({recordPinSaved:jest.fn(async()=>{})}));
const {firestore:db}=require('../lib/firestore');
const {runEnrichment,saveSelectedPlaces}=require('../enrich');
const {getRetryContext}=require('../lib/retryContext');
const {extractPublicPost}=require('../lib/extraction');
const {collectVideoEvidence}=require('../lib/media/videoEvidence');
const {aiExtractPlaces}=require('../enrich/ai');
const {searchGooglePlaces}=require('../enrich/places');
const {createEngineFeatures}=require('../lib/engineFeatures');
const {EngineError}=require('../lib/engineError');
const url='https://www.instagram.com/reel/RetryEvidence/';
const media=createEngineFeatures({snapshotVersion:2,internalUids:['u'],flags:{mediaEvidence:true}}).forJob('u',undefined,['mediaRecoveryV1']);
const pin=(id,name=id)=>({placeId:id,placeName:name,userId:'u',url,ogTitle:'Dinner',ogImage:'',sourceApp:'instagram',sourceDomain:'instagram.com',category:'restaurant',city:'Kyoto',country:'Japan',latitude:35,longitude:135});
const google=(id,name=id)=>({place_id:id,name,formatted_address:'Kyoto, Japan',types:['restaurant'],geometry:{location:{lat:35,lng:135}}});
const collected=places=>({places,incomplete:false,attempted:true,coverage:{audio:{status:'complete'},visual:{status:'complete'},fusion:{status:'complete'}},retryOperations:[]});
function child(parent='parent'){db.seed('enrichmentJobs','child',{userId:'u',url,status:'processing',retryOf:parent});}
const run=(features)=>runEnrichment('child',url,'u','',{features,deadline:Date.now()+120000});
beforeEach(()=>{
 db.reset();jest.clearAllMocks();db.seed('users','u',{});
 extractPublicPost.mockResolvedValue({title:'Dinner in Kyoto',description:'',webpage_url:url});
 aiExtractPlaces.mockResolvedValue({places:[]});collectVideoEvidence.mockResolvedValue(collected([]));
 searchGooglePlaces.mockResolvedValue([]);
});

test('ordinary retry past a missing original reanalyzes and confirms without duplicating an existing pin',async()=>{
 db.seed('enrichmentJobs','parent',{userId:'u',url,status:'failed',retryOf:'expired-original',
  engineQueued:false,failure:{code:'dependency_timeout',stage:'admission'}});child();
 db.seed('pins','already-saved',{...pin('known','Known Cafe'),sources:[]});
 collectVideoEvidence.mockResolvedValue(collected([{name:'Known Cafe',city:'Kyoto',source:'transcript',requiresSelection:true}]));
 searchGooglePlaces.mockResolvedValue([google('known','Known Cafe')]);
 await run(media);
 expect(aiExtractPlaces).toHaveBeenCalledTimes(1);
 expect(aiExtractPlaces.mock.calls[0][1].bypassCache).toBe(true);
 expect(collectVideoEvidence).toHaveBeenCalledTimes(1);
 expect(db.read('enrichmentJobs','child')).toMatchObject({status:'needs_selection',candidates:[{placeId:'known'}]});
 expect((await db.collection('pins').get()).size).toBe(1);
 await saveSelectedPlaces('child','u',['known']);
 expect((await db.collection('pins').get()).size).toBe(1);
 expect(db.read('enrichmentJobs','child')).toMatchObject({status:'complete',progress:{saved:1,total:1}});
});

test('distinct selected IDs with identical evidence must both survive retry',async()=>{
 const candidates=[pin('branch-a','Same Cafe'),{...pin('branch-b','Same Cafe'),latitude:35.02,longitude:135.03}];
 db.seed('enrichmentJobs','parent',{userId:'u',url,status:'failed',selectedPlaceIds:['branch-a','branch-b'],candidates,
  outcomes:candidates.map(p=>({name:'Same Cafe',city:'Kyoto',placeId:p.placeId,status:'unresolved'}))});child();
 await run();
 const j=db.read('enrichmentJobs','child');
 expect((await db.collection('pins').get()).docs.map(d=>d.data().placeId).sort()).toEqual(['branch-a','branch-b']);
});
test('blocked fresh source must not prevent independent confirmed save',async()=>{
 db.seed('enrichmentJobs','parent',{userId:'u',url,status:'failed',selectedPlaceIds:['chosen'],candidates:[pin('chosen')],outcomes:[
  {name:'chosen',placeId:'chosen',status:'unresolved'}, {name:'unknown',status:'unresolved'}]});child();
 extractPublicPost.mockRejectedValue(new EngineError('access_blocked'));
 await run();
 const j=db.read('enrichmentJobs','child');
 expect((await db.collection('pins').get()).docs.map(d=>d.data().placeId)).toEqual(['chosen']);
 expect(j).toMatchObject({status:'failed',progress:{saved:1,total:2},failure:{code:'partial_save'}});
 expect(aiExtractPlaces).not.toHaveBeenCalled();expect(searchGooglePlaces).not.toHaveBeenCalled();
 expect(collectVideoEvidence).not.toHaveBeenCalled();
});
test('failed carousel evidence must not erase unresolved sibling and declare success',async()=>{
 db.seed('enrichmentJobs','parent',{userId:'u',url,status:'failed',selectedPlaceIds:['chosen'],candidates:[pin('chosen')],outcomes:[
  {name:'chosen',placeId:'chosen',status:'unresolved'}, {name:'unknown',status:'unresolved'}]});child();
 extractPublicPost.mockResolvedValue({title:'Dinner',description:'',webpage_url:url,is_carousel:true,slide_thumbnails:['https://example.com/a','https://example.com/b']});
 require('../lib/vision').extractPlacesFromSlides.mockRejectedValueOnce(new EngineError('dependency_timeout'));
 await run();
 const j=db.read('enrichmentJobs','child');
 expect(j.outcomes).toContainEqual(expect.objectContaining({name:'unknown',status:'unresolved'}));
 expect(j.status).toBe('failed');
});
test('legacy confirmed identity with no snapshot must not fall back to saving another ID',async()=>{
 db.seed('enrichmentJobs','parent',{userId:'u',url,status:'failed',selectedPlaceIds:['chosen'],ogTitle:'Other Cafe Kyoto',ogDescription:'Other Cafe Kyoto, Japan',outcomes:[
  {name:'Other Cafe',city:'Kyoto',placeId:'chosen',status:'unresolved'}]});child();
 searchGooglePlaces.mockResolvedValue([google('wrong','Other Cafe')]);
 require('../enrich/ai').aiVerifyPlace.mockResolvedValue({match:true,betterQuery:null});
 await run();
 const j=db.read('enrichmentJobs','child');
 expect((await db.collection('pins').get()).size).toBe(0);
 expect(j.status).toBe('failed');
});
test('fresh reanalysis must not resurrect a dismissed place through OG fallback',async()=>{
 db.seed('enrichmentJobs','parent',{userId:'u',url,status:'failed',outcomes:[
  {name:'unknown',status:'unresolved'}, {name:'Other Cafe',city:'Kyoto',placeId:'dismissed',status:'dismissed'}]});child();
 extractPublicPost.mockResolvedValue({title:'Other Cafe Kyoto',description:'Other Cafe Kyoto, Japan',webpage_url:url});
 aiExtractPlaces.mockResolvedValue({places:[{name:'Other Cafe',city:'Kyoto'}]});
 searchGooglePlaces.mockResolvedValue([google('dismissed','Other Cafe')]);
 require('../enrich/ai').aiVerifyPlace.mockResolvedValue({match:true,betterQuery:null});
 await run();
 const j=db.read('enrichmentJobs','child');
 expect((await db.collection('pins').get()).size).toBe(0);
});

test.each(['normal mixed retry','explicit analysis retry'])('%s keeps two exact branches through media merge and discovers another',async kind=>{
 const candidates=[pin('branch-a','Same Cafe'),{...pin('branch-b','Same Cafe'),latitude:35.02,longitude:135.03}];
 const analysis=kind==='explicit analysis retry';
 const outcomes=candidates.map(p=>({name:'Same Cafe',city:'Kyoto',placeId:p.placeId,status:'unresolved'}));
 if(!analysis)outcomes.push({name:'generic food',status:'unresolved'});
 db.seed('enrichmentJobs','parent',{userId:'u',url,status:'failed',selectedPlaceIds:['branch-a','branch-b'],candidates,outcomes,
  ...(analysis?{analysisRecovery:require('../lib/media/analysisRecovery').RECOVERY}: {})});
 child();if(analysis)await db.collection('enrichmentJobs').doc('child').update({retryKind:'analysis'});
 collectVideoEvidence.mockResolvedValue({...collected([{name:'Same Cafe',city:'Kyoto',source:'transcript',requiresSelection:true}]),
  contradictions:[{name:'Same Cafe'}]});
 searchGooglePlaces.mockResolvedValue([google('branch-c','Same Cafe')]);
 await run(media);
 const j=db.read('enrichmentJobs','child');
 expect(j).toMatchObject({status:'needs_selection',progress:{saved:2,total:3}});
 expect((await db.collection('pins').get()).docs.map(d=>d.data().placeId).sort()).toEqual(['branch-a','branch-b']);
 expect(j.candidates.map(p=>p.placeId)).toEqual(['branch-c']);
 expect(j.outcomes.filter(o=>o.status==='saved').map(o=>o.placeId).sort()).toEqual(['branch-a','branch-b']);
 expect(collectVideoEvidence).toHaveBeenCalledTimes(1);expect(aiExtractPlaces).toHaveBeenCalledTimes(1);
 expect(aiExtractPlaces.mock.calls[0][1].bypassCache).toBe(analysis?undefined:true);
 if(analysis)expect(collectVideoEvidence.mock.calls[0][0].reason).toBe('explicit_analysis_retry');
 expect(searchGooglePlaces).toHaveBeenCalledTimes(1);
});

test('saved and dismissed evidence cannot hide another selected ID with the same text',async()=>{
 const evidence={name:'Same Cafe',city:'Kyoto',country:'Japan',address:''};
 db.seed('pins','saved',{...pin('saved','Same Cafe'),sources:[]});
 db.seed('enrichmentJobs','parent',{userId:'u',url,status:'failed',selectedPlaceIds:['chosen'],candidates:[pin('chosen','Same Cafe')],outcomes:[
  {...evidence,placeId:'saved',pinId:'saved',status:'saved'},
  {...evidence,placeId:'dismissed',status:'dismissed'},
  {...evidence,placeId:'chosen',status:'unresolved'}]});child();
 await run();
 const j=db.read('enrichmentJobs','child');
 expect(j).toMatchObject({status:'complete',progress:{saved:2,total:2}});
 expect(j.outcomes).toContainEqual(expect.objectContaining({placeId:'dismissed',status:'dismissed'}));
 expect((await db.collection('pins').get()).docs.map(d=>d.data().placeId).sort()).toEqual(['chosen','saved']);
 expect(searchGooglePlaces).not.toHaveBeenCalled();expect(aiExtractPlaces).not.toHaveBeenCalled();
});

test('media exception preserves a selected save and an unresolved sibling without a repair call',async()=>{
 db.seed('enrichmentJobs','parent',{userId:'u',url,status:'failed',selectedPlaceIds:['chosen'],candidates:[pin('chosen')],outcomes:[
  {name:'chosen',placeId:'chosen',status:'unresolved'}, {name:'unknown',status:'unresolved'}]});child();
 collectVideoEvidence.mockRejectedValueOnce(new EngineError('dependency_timeout',{stage:'media'}));
 await run(media);
 const j=db.read('enrichmentJobs','child');
 expect(j).toMatchObject({status:'failed',progress:{saved:1,total:2},analysisRecovery:require('../lib/media/analysisRecovery').RECOVERY});
 expect(j.outcomes).toContainEqual(expect.objectContaining({name:'unknown',status:'unresolved'}));
 expect((await db.collection('pins').get()).docs.map(d=>d.data().placeId)).toEqual(['chosen']);
 expect(collectVideoEvidence).toHaveBeenCalledTimes(1);expect(searchGooglePlaces).not.toHaveBeenCalled();
});

test.each(['source','media'])('stopped %s attempt cannot authorize a retained save',async stage=>{
 db.seed('enrichmentJobs','parent',{userId:'u',url,status:'failed',selectedPlaceIds:['chosen'],candidates:[pin('chosen')],outcomes:[
  {name:'chosen',placeId:'chosen',status:'unresolved'}, {name:'unknown',status:'unresolved'}]});child();
 (stage==='source'?extractPublicPost:collectVideoEvidence).mockRejectedValueOnce(new EngineError('attempt_stopped'));
 await run(media);
 expect((await db.collection('pins').get()).size).toBe(0);
 expect(db.read('enrichmentJobs','child').status).toBe('processing');
});

test('failed analysis admission carries selected snapshots for a later normal retry',async()=>{
 const recovery=require('../lib/media/analysisRecovery').RECOVERY;
 db.seed('enrichmentJobs','parent',{userId:'u',url,status:'failed',analysisRecovery:recovery,selectedPlaceIds:['chosen'],candidates:[pin('chosen')],outcomes:[
  {name:'chosen',placeId:'chosen',status:'unresolved'}]});child();
 await db.collection('enrichmentJobs').doc('child').update({retryKind:'analysis'});
 await run(); // Media is disabled; selection identity must still survive.
 expect(db.read('enrichmentJobs','child')).toMatchObject({status:'failed',retryCandidates:[{placeId:'chosen'}],analysisRecovery:recovery});
 db.seed('enrichmentJobs','third',{userId:'u',url,status:'processing',retryOf:'child'});
 await runEnrichment('third',url,'u','');
 expect(db.read('enrichmentJobs','third')).toMatchObject({status:'complete',progress:{saved:1,total:1}});
 expect((await db.collection('pins').get()).docs.map(d=>d.data().placeId)).toEqual(['chosen']);
 expect(extractPublicPost).not.toHaveBeenCalled();expect(searchGooglePlaces).not.toHaveBeenCalled();
});

test('outcome retention cannot account for an exact ID with another same-name branch',()=>{
 const {retainUnresolved}=require('../lib/retryContext');
 const old={name:'Same Cafe',city:'Kyoto',placeId:'chosen',confirmedPlaceId:'chosen',status:'unresolved'};
 expect(retainUnresolved([old],[{name:'Same Cafe',city:'Kyoto',placeId:'other',status:'saved'}])).toEqual([old]);
 expect(retainUnresolved([old],[{name:'Same Cafe',city:'Kyoto',status:'candidate'}])).toEqual([old]);
});


test.each([false,true])('checkpoint survives process interruption with selected snapshot=%s',async withCandidate=>{
 const recovery=require('../lib/media/analysisRecovery').RECOVERY;
 const operations=[{kind:'asr_chunk',retryKey:'a'.repeat(64),generation:1}];
 db.seed('enrichmentJobs','parent',{userId:'u',url,status:'failed',analysisRecovery:recovery,mediaRetryOperations:operations,
  ...(withCandidate?{selectedPlaceIds:['chosen'],candidates:[pin('chosen')]}:{}),outcomes:[
   ...(withCandidate?[{name:'chosen',placeId:'chosen',status:'unresolved'}]:[]),
   {name:'unknown',status:'unresolved'}, {name:'Never again',placeId:'dismissed',status:'dismissed'}]});child();
 collectVideoEvidence.mockRejectedValueOnce(new EngineError('attempt_stopped'));
 await run(media);
 expect(db.read('enrichmentJobs','child')).toMatchObject({status:'processing',analysisRecovery:recovery,mediaRetryOperations:operations});
 // The stale-job sweeper cannot reconstruct the stopped worker's memory.
 await db.collection('enrichmentJobs').doc('child').set({status:'failed',failure:{code:'dependency_timeout'}},{merge:true});
 db.seed('enrichmentJobs','third',{userId:'u',url,status:'processing',retryOf:'child'});
 const next=await getRetryContext(db,'third','u',url);
 if(withCandidate)expect(next.resumePlaces).toContainEqual(expect.objectContaining({confirmedPlaceId:'chosen'}));
 expect(next.baseOutcomes).toContainEqual(expect.objectContaining({placeId:'dismissed',status:'dismissed'}));
 expect(next.initialOutcomes).toContainEqual(expect.objectContaining({name:'unknown',status:'unresolved'}));
 expect(next.analysisRecovery).toEqual(recovery);expect(next.mediaRetryOperations).toEqual(operations);
 expect((await db.collection('pins').get()).size).toBe(0);
});
