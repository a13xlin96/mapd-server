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
const {runEnrichment}=require('../enrich');
const {extractPublicPost}=require('../lib/extraction');
const {collectVideoEvidence}=require('../lib/media/videoEvidence');
const {aiExtractPlaces}=require('../enrich/ai');
const {searchGooglePlaces}=require('../enrich/places');
const {createEngineFeatures}=require('../lib/engineFeatures');
const {RECOVERY}=require('../lib/media/analysisRecovery');
const {EngineError}=require('../lib/engineError');
const url='https://www.instagram.com/reel/MEDIA/';
const features=createEngineFeatures({snapshotVersion:2,internalUids:['u'],flags:{mediaEvidence:true}}).forJob('u',undefined,['mediaRecoveryV1']);
const google=(name,city='Kyoto')=>({place_id:name+city,name,formatted_address:'1 Main Street, '+city+', Japan',types:['restaurant'],geometry:{location:{lat:35,lng:135}}});
function result(places=[],incomplete=false){return {places,incomplete,attempted:true,coverage:{audio:{status:incomplete?'partial':'complete'},visual:{status:'complete'},fusion:{status:'complete'}},retryOperations:[],...(incomplete?{error:new EngineError('dependency_timeout',{stage:'media'})}:{})};}
const run=(f=features)=>runEnrichment('job',url,'u','',{features:f,deadline:Date.now()+120000});
beforeEach(()=>{
 db.reset();jest.clearAllMocks();db.seed('enrichmentJobs','job',{userId:'u',url,status:'processing'});
 extractPublicPost.mockResolvedValue({title:'Dinner',description:'',webpage_url:url,subtitles:''});
 aiExtractPlaces.mockResolvedValue({places:[]});collectVideoEvidence.mockResolvedValue(result([{name:'Tai Sushi',city:'Kyoto',source:'transcript',requiresSelection:true}]));
 searchGooglePlaces.mockImplementation(async q=>[google(q.startsWith('Tai Sushi')?'Tai Sushi':'Cafe A')]);
});
test('audio-only evidence reaches confirmation with no pin committed or raw evidence in candidates',async()=>{
 await run();const job=db.read('enrichmentJobs','job');expect(job.status).toBe('needs_selection');
 expect(job.candidates[0].placeName).toBe('Tai Sushi');expect((await db.collection('pins').get()).empty).toBe(true);
 expect(job.candidates[0].evidenceRefs).toBeUndefined();expect(job.analysisRecovery).toBeNull();
});
test('feature-off legacy jobs make zero media calls',async()=>{
 aiExtractPlaces.mockResolvedValue({places:[{name:'Tai Sushi',city:'Kyoto'}]});
 extractPublicPost.mockResolvedValue({title:'Tai Sushi Kyoto',description:'Tai Sushi Kyoto',webpage_url:url});
 await run(createEngineFeatures().forJob('u'));expect(collectVideoEvidence).not.toHaveBeenCalled();expect(db.read('enrichmentJobs','job').status).toBe('complete');
});
test('optional media failure preserves a well-grounded baseline save with separate recovery',async()=>{
 extractPublicPost.mockResolvedValue({title:'Tai Sushi Kyoto',description:'Tai Sushi Kyoto',webpage_url:url});
 aiExtractPlaces.mockResolvedValue({places:[{name:'Tai Sushi',city:'Kyoto'}]});collectVideoEvidence.mockResolvedValue(result([],true));
 await run();expect(db.read('enrichmentJobs','job')).toMatchObject({status:'complete',analysisRecovery:RECOVERY,progress:{saved:1,total:1}});
 expect((await db.collection('pins').get()).size).toBe(1);
});
test('provisional weak result escalates only once and reuses unchanged Google search',async()=>{
 extractPublicPost.mockResolvedValue({title:'Dinner',description:'A'.repeat(100),webpage_url:url,subtitles:'Tai Sushi',subtitle_tracks:[]});
 aiExtractPlaces.mockResolvedValue({places:[{name:'Tai Sushi',city:''}]});searchGooglePlaces.mockResolvedValue([]);
 collectVideoEvidence.mockResolvedValue(result([{name:'Tai Sushi',city:'',requiresSelection:true}]));
 await run();expect(collectVideoEvidence).toHaveBeenCalledTimes(1);expect(searchGooglePlaces).toHaveBeenCalledTimes(1);
});
test('new branch evidence downgrades baseline before any automatic commit',async()=>{
 extractPublicPost.mockResolvedValue({title:'Tai Sushi Kyoto',description:'Tai Sushi Kyoto',webpage_url:url});
 aiExtractPlaces.mockResolvedValue({places:[{name:'Tai Sushi',city:'Kyoto'}]});
 collectVideoEvidence.mockResolvedValue(result([{name:'Tai Sushi',city:'Tokyo',source:'transcript',requiresSelection:true}]));
 searchGooglePlaces.mockImplementation(async q=>[google('Tai Sushi',q.includes('Tokyo')?'Tokyo':'Kyoto')]);
 await run();expect(db.read('enrichmentJobs','job').status).toBe('needs_selection');expect((await db.collection('pins').get()).empty).toBe(true);
});
test('media incomplete with no candidate is a dependency failure, never a false no-place result',async()=>{
 collectVideoEvidence.mockResolvedValue(result([],true));await run();
 expect(db.read('enrichmentJobs','job')).toMatchObject({status:'failed',failure:{code:'dependency_timeout'},analysisRecovery:RECOVERY});
});
test('explicit analysis retry ignores source-level duplicate shortcut and preserves dismissed places',async()=>{
 db.seed('pins','saved',{userId:'u',url,placeId:'Tai SushiKyoto',placeName:'Tai Sushi',sources:[]});
 db.seed('enrichmentJobs','parent',{userId:'u',url,status:'complete',analysisRecovery:RECOVERY,outcomes:[{name:'Tai Sushi',placeId:'Tai SushiKyoto',pinId:'saved',status:'saved'},{name:'Cafe A',placeId:'Cafe AKyoto',status:'dismissed'}]});
 db.seed('enrichmentJobs','job',{userId:'u',url,status:'processing',retryOf:'parent',retryKind:'analysis'});
 collectVideoEvidence.mockResolvedValue(result([{name:'Tai Sushi',city:'Kyoto',requiresSelection:true},{name:'Cafe A',city:'Kyoto',requiresSelection:true}]));
 await run();expect(collectVideoEvidence).toHaveBeenCalledTimes(1);
 expect(db.read('enrichmentJobs','job').status).toBe('duplicate');expect((await db.collection('pins').get()).size).toBe(1);
});
test('rollout rollback cannot silently finish an analysis retry using the old text-only path',async()=>{
 db.seed('enrichmentJobs','parent',{userId:'u',url,status:'complete',analysisRecovery:RECOVERY,outcomes:[{name:'Tai Sushi',placeId:'Tai SushiKyoto',pinId:'saved',status:'saved'}]});
 db.seed('enrichmentJobs','job',{userId:'u',url,status:'processing',retryOf:'parent',retryKind:'analysis'});
 await run(createEngineFeatures().forJob('u'));
 expect(extractPublicPost).not.toHaveBeenCalled();expect(collectVideoEvidence).not.toHaveBeenCalled();
 expect(db.read('enrichmentJobs','job')).toMatchObject({status:'complete',analysisRecovery:RECOVERY,progress:{saved:1,total:1}});
});
test('explicit spoken correction downgrades the caption candidate even without a positive replacement',async()=>{
 extractPublicPost.mockResolvedValue({title:'Tai Sushi Kyoto',description:'Tai Sushi Kyoto',webpage_url:url});
 aiExtractPlaces.mockResolvedValue({places:[{name:'Tai Sushi',city:'Kyoto'}]});
 collectVideoEvidence.mockResolvedValue({...result([]),contradictions:[{name:'Tai Sushi',evidenceRefs:[{evidenceId:'audio:one',quote:'This is not Tai Sushi'}]}]});
 await run();expect(db.read('enrichmentJobs','job').status).toBe('needs_selection');expect((await db.collection('pins').get()).empty).toBe(true);
});
test('a media venue beyond the 40-candidate selection batch is retained as unresolved work',async()=>{
 const places=Array.from({length:40},(_,i)=>({name:'Place '+i,city:'Kyoto',requiresSelection:true}));
 aiExtractPlaces.mockResolvedValue({places});
 collectVideoEvidence.mockResolvedValue(result([{name:'Extra Cafe',city:'Kyoto',source:'transcript',requiresSelection:true,evidenceRefs:[{evidenceId:'audio:x',quote:'Extra Cafe',supports:'name'}]}]));
 searchGooglePlaces.mockImplementation(async q=>[google(q.replace(/ Kyoto$/,''))]);
 await run();const job=db.read('enrichmentJobs','job');
 expect(job.status).toBe('needs_selection');expect(job.candidates).toHaveLength(40);
 expect(job.outcomes).toEqual(expect.arrayContaining([expect.objectContaining({name:'Extra Cafe',status:'unresolved'})]));
 expect(job.outcomes.find(o=>o.name==='Extra Cafe').evidenceRefs).toBeUndefined();
});
test('fresh completed media analysis clears inherited recovery when normal retry reruns evidence',async()=>{
 db.seed('enrichmentJobs','parent',{userId:'u',url,status:'complete',analysisRecovery:RECOVERY,outcomes:[]});
 db.seed('enrichmentJobs','job',{userId:'u',url,status:'processing',retryOf:'parent'});
 await run();expect(db.read('enrichmentJobs','job').analysisRecovery).toBeNull();
});
test('media-enabled attempts deduplicate by verified place, not a previously saved source URL',async()=>{
 db.seed('pins','other',{userId:'u',url,placeId:'Cafe AKyoto',placeName:'Cafe A',sources:[]});
 extractPublicPost.mockResolvedValue({title:'Tai Sushi Kyoto',description:'Tai Sushi Kyoto',webpage_url:url});
 aiExtractPlaces.mockResolvedValue({places:[{name:'Tai Sushi',city:'Kyoto'}]});
 collectVideoEvidence.mockResolvedValue(result([]));
 await run();expect(db.read('enrichmentJobs','job').status).toBe('complete');
 expect((await db.collection('pins').get()).size).toBe(2);
});

test.each(['rollback','source failure','fresh empty analysis'])('analysis retry preserves a known unsaved place after %s',async scenario=>{
 db.seed('enrichmentJobs','parent',{userId:'u',url,status:'failed',analysisRecovery:RECOVERY,outcomes:[
  {name:'Tai Sushi',placeId:'Tai SushiKyoto',pinId:'saved',status:'saved'},
  {name:'Unresolved Cafe',city:'Kyoto',status:'unresolved'}]});
 db.seed('enrichmentJobs','job',{userId:'u',url,status:'processing',retryOf:'parent',retryKind:'analysis'});
 collectVideoEvidence.mockResolvedValue(result([],scenario==='source failure'));
 if(scenario==='source failure')extractPublicPost.mockRejectedValue(new EngineError('source_unavailable'));
 await run(scenario==='rollback'?createEngineFeatures().forJob('u'):features);
 expect(db.read('enrichmentJobs','job')).toMatchObject({status:'failed',progress:{saved:1,total:2},failure:{code:'partial_save'}});
 expect(db.read('enrichmentJobs','job').outcomes).toEqual(expect.arrayContaining([expect.objectContaining({name:'Unresolved Cafe',status:'unresolved'})]));
});
test('analysis retry fresh match replaces the old unresolved record without double counting',async()=>{
 db.seed('enrichmentJobs','parent',{userId:'u',url,status:'failed',analysisRecovery:RECOVERY,outcomes:[{name:'Tai Sushi',city:'Kyoto',status:'unresolved'}]});
 db.seed('enrichmentJobs','job',{userId:'u',url,status:'processing',retryOf:'parent',retryKind:'analysis'});
 await run();const job=db.read('enrichmentJobs','job');expect(job.status).toBe('needs_selection');
 expect(job.outcomes).toHaveLength(1);expect(job.outcomes[0].status).toBe('candidate');
});

test('a prior unresolved country-qualified venue is replaced when its existing pin is found',async()=>{
 db.seed('pins','saved',{userId:'u',url,placeId:'Tai SushiKyoto',placeName:'Tai Sushi',sources:[]});
 db.seed('enrichmentJobs','parent',{userId:'u',url,status:'failed',analysisRecovery:RECOVERY,outcomes:[{name:'Tai Sushi',city:'Kyoto',country:'Japan',status:'unresolved'}]});
 db.seed('enrichmentJobs','job',{userId:'u',url,status:'processing',retryOf:'parent',retryKind:'analysis'});
 extractPublicPost.mockResolvedValue({title:'Tai Sushi Kyoto Japan',description:'Tai Sushi Kyoto Japan',webpage_url:url});
 aiExtractPlaces.mockResolvedValue({places:[{name:'Tai Sushi',city:'Kyoto',country:'Japan'}]});
 collectVideoEvidence.mockResolvedValue(result([]));
 await run();const job=db.read('enrichmentJobs','job');expect(job.status).toBe('duplicate');
 expect(job.progress).toEqual({saved:1,total:1});expect(job.outcomes).toHaveLength(1);
});
test('repeated overflow discovery preserves one remaining venue rather than counting it twice',async()=>{
 db.seed('enrichmentJobs','parent',{userId:'u',url,status:'failed',analysisRecovery:RECOVERY,outcomes:[{name:'Extra Cafe',city:'Kyoto',status:'unresolved'}]});
 db.seed('enrichmentJobs','job',{userId:'u',url,status:'processing',retryOf:'parent',retryKind:'analysis'});
 aiExtractPlaces.mockResolvedValue({places:Array.from({length:40},(_,i)=>({name:'Place '+i,city:'Kyoto',requiresSelection:true}))});
 collectVideoEvidence.mockResolvedValue(result([{name:'Extra Cafe',city:'Kyoto',source:'transcript',requiresSelection:true}]));
 searchGooglePlaces.mockImplementation(async q=>[google(q.replace(/ Kyoto$/,''))]);
 await run();const job=db.read('enrichmentJobs','job');expect(job.status).toBe('needs_selection');
 expect(job.outcomes).toHaveLength(41);expect(job.outcomes.filter(o=>o.name==='Extra Cafe')).toHaveLength(1);
});
