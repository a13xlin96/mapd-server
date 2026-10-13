// Reconstructed incident inputs. Provider/process boundaries are mocked;
// matching, orchestration, persistence, selection and retry are real.
jest.mock('../lib/firestore',()=>({firestore:require('./helpers/fakeFirestore').getSharedFirestore(),admin:require('./helpers/fakeFirestore').makeAdmin()}));
jest.mock('../lib/extraction',()=>({extractPublicPost:jest.fn()}));
jest.mock('../lib/media/videoEvidence',()=>({collectVideoEvidence:jest.fn()}));
jest.mock('../lib/thumbnails',()=>({persistThumbnail:jest.fn(async()=> '')}));
jest.mock('../lib/vision',()=>({extractPlacesFromSlides:jest.fn(async()=>({places:[]}))}));
jest.mock('../enrich/ai',()=>({aiExtractPlaces:jest.fn(),aiExtractPlace:jest.fn(),aiVerifyPlace:jest.fn()}));
jest.mock('../enrich/places',()=>({searchGooglePlaces:jest.fn(),getCachedPlaceDetails:jest.fn(async()=>null)}));
jest.mock('../lib/push',()=>({sendPushForJob:jest.fn(async()=>{})}));
const mockPushSend=jest.fn(async()=>[{status:'ok'}]);
jest.mock('expo-server-sdk',()=>({Expo:class {
 static isExpoPushToken(){return true;}
 sendPushNotificationsAsync(messages){return mockPushSend(messages);}
}}));
jest.mock('../lib/interestProfile',()=>({recordPinSaved:jest.fn(async()=>{})}));
const {firestore:db}=require('../lib/firestore');
const {runEnrichment,saveSelectedPlaces}=require('../enrich');
const {extractPublicPost}=require('../lib/extraction');
const {collectVideoEvidence}=require('../lib/media/videoEvidence');
const {aiExtractPlaces}=require('../enrich/ai');
const {searchGooglePlaces}=require('../enrich/places');
const {createEngineFeatures}=require('../lib/engineFeatures');
const {EngineError}=require('../lib/engineError');
const {RECOVERY}=require('../lib/media/analysisRecovery');
const {isAudioOnly,validateMediaConfig}=require('../lib/media/mediaConfig');
const url='https://www.instagram.com/reel/Dd4TtrnTLCX/';
const policy=version=>createEngineFeatures({snapshotVersion:2,internalUids:['u'],flags:{mediaEvidence:true},mediaPolicy:{policyVersion:version,analysisMode:'audio-only'}}).forJob('u',undefined,['mediaRecoveryV1']);
const features=policy('media-v3');
const caption='A seasonal omakase dinner.\n📍 鮨 うら山 本店\nSakae, Nagoya, Aichi';
const place={name:'鮨 うら山 本店',city:'Nagoya',address:'',source:'caption'};
const google={place_id:'urayama-nagoya',name:place.name,formatted_address:'Sakae, Nagoya, Aichi, Japan',geometry:{location:{lat:35.165464,lng:136.909735}},types:['restaurant']};
const run=(f=features,id='job')=>runEnrichment(id,url,'u','',{features:f,deadline:Date.now()+120000});
beforeEach(()=>{
 db.reset();jest.clearAllMocks();db.seed('enrichmentJobs','job',{userId:'u',url,status:'processing'});
 extractPublicPost.mockResolvedValue({title:'Dinner',description:caption,webpage_url:url,subtitles:''});
 aiExtractPlaces.mockResolvedValue({places:[{...place}],count:1});searchGooglePlaces.mockResolvedValue([google]);
 collectVideoEvidence.mockResolvedValue({places:[],incomplete:false,coverage:{audio:{status:'complete'},visual:{status:'unavailable',reason:'disabled_by_policy'},fusion:{status:'complete',reason:'no_new_text'}}});
});
test('v3 verifies literal single-caption venue before media, saving with zero media calls',async()=>{
 await run();expect(db.read('enrichmentJobs','job').status).toBe('complete');
 expect((await db.collection('pins').get()).size).toBe(1);
 expect(searchGooglePlaces).toHaveBeenCalledTimes(1);expect(aiExtractPlaces).toHaveBeenCalledTimes(1);
 expect(collectVideoEvidence).not.toHaveBeenCalled();
});
test('recorded v2 still performs media; v3 never activates frames',async()=>{
 await run(policy('media-v2'));expect(collectVideoEvidence).toHaveBeenCalledTimes(1);
 expect(isAudioOnly(validateMediaConfig({policyVersion:'media-v3',analysisMode:'audio-only'}))).toBe(true);
 expect(()=>validateMediaConfig({policyVersion:'media-v3',analysisMode:'audio-video'})).toThrow();
});
test.each(['listicle','title listicle','unmarked','unknown name','weak Google','wrong country'])('%s does not take the selective shortcut',async kind=>{
 if(kind==='listicle')extractPublicPost.mockResolvedValue({description:'Top 3 restaurants\n'+caption});
 if(kind==='title listicle')extractPublicPost.mockResolvedValue({title:'Top 3 restaurants in Nagoya',description:caption});
 if(kind==='unmarked')extractPublicPost.mockResolvedValue({description:caption.replace('📍','')});
 if(kind==='unknown name')aiExtractPlaces.mockResolvedValue({places:[{...place,name:'Invented Sushi'}]});
 if(kind==='weak Google')searchGooglePlaces.mockResolvedValue([]);
 if(kind==='wrong country')searchGooglePlaces.mockResolvedValue([{...google,formatted_address:'Taipei, Taiwan'}]);
 await run();expect(collectVideoEvidence).toHaveBeenCalledTimes(1);
 if(['unknown name','weak Google','wrong country'].includes(kind))expect((await db.collection('pins').get()).size).toBe(0);
});
test('complete empty audio cannot turn caption validation failure into no-place-found',async()=>{
 aiExtractPlaces.mockRejectedValue(new EngineError('invalid_response',{stage:'ai',provider:'anthropic'}));
 await run();expect(db.read('enrichmentJobs','job')).toMatchObject({status:'failed',failure:{code:'invalid_response',stage:'ai'}});
 expect(searchGooglePlaces).not.toHaveBeenCalled();expect((await db.collection('pins').get()).size).toBe(0);
});
test('partial caption candidate survives for confirmation; saving keeps unfinished analysis retryable',async()=>{
 aiExtractPlaces.mockResolvedValue({places:[{...place}],count:1,incomplete:true});
 await run();expect(db.read('enrichmentJobs','job')).toMatchObject({status:'needs_selection',captionAnalysisIncomplete:true,analysisRecovery:RECOVERY});
 expect((await db.collection('pins').get()).size).toBe(0);
 const saved=await saveSelectedPlaces('job','u',[google.place_id]);
 expect(saved).toMatchObject({status:'complete',captionAnalysisIncomplete:true,analysisRecovery:RECOVERY,progress:{saved:1,total:1}});
});
test('caption recovery refreshes failed caption operation with media disabled and keeps saved pin',async()=>{
 aiExtractPlaces.mockResolvedValue({places:[{...place}],count:1,incomplete:true});
 await run();await saveSelectedPlaces('job','u',[google.place_id]);
 db.seed('enrichmentJobs','retry',{userId:'u',url,status:'processing',retryOf:'job',retryKind:'analysis'});
 aiExtractPlaces.mockResolvedValue({places:[{...place}],count:1});collectVideoEvidence.mockClear();
 await run(createEngineFeatures().forJob('u'),'retry');
 expect(aiExtractPlaces).toHaveBeenLastCalledWith(expect.anything(),expect.objectContaining({bypassCache:true}));
 expect(collectVideoEvidence).not.toHaveBeenCalled();expect((await db.collection('pins').get()).size).toBe(1);
 expect(db.read('enrichmentJobs','retry')).toMatchObject({status:'complete',captionAnalysisIncomplete:false,analysisRecovery:null});
});
test.each(['failed selected save','unfinished selection'])('%s retry keeps caption recovery until analysis actually runs',async kind=>{
 aiExtractPlaces.mockResolvedValue({places:[{...place}],count:1,incomplete:true});await run();
 if(kind==='failed selected save') {
   db.setWriteFailure(collection=>collection==='pins'?new Error('temporary save error'):null);
   await saveSelectedPlaces('job','u',[google.place_id]);db.setWriteFailure(null);
 }
 db.seed('enrichmentJobs','retry',{userId:'u',url,status:'processing',retryOf:'job',retryKind:'places'});
 aiExtractPlaces.mockClear();collectVideoEvidence.mockClear();extractPublicPost.mockClear();
 await run(features,'retry');
 expect(aiExtractPlaces).not.toHaveBeenCalled();expect(extractPublicPost).not.toHaveBeenCalled();
 expect(collectVideoEvidence).not.toHaveBeenCalled();
 expect(db.read('enrichmentJobs','retry')).toMatchObject({
   status:kind==='failed selected save'?'complete':'needs_selection',captionAnalysisIncomplete:true,analysisRecovery:RECOVERY,
 });
 expect((await db.collection('pins').get()).size).toBe(kind==='failed selected save'?1:0);
});
test('source failure during analysis retry preserves caption recovery while retaining an authorized selected save',async()=>{
 aiExtractPlaces.mockResolvedValue({places:[{...place}],count:1,incomplete:true});await run();
 db.setWriteFailure(collection=>collection==='pins'?new Error('temporary save error'):null);
 await saveSelectedPlaces('job','u',[google.place_id]);db.setWriteFailure(null);
 db.seed('enrichmentJobs','retry',{userId:'u',url,status:'processing',retryOf:'job',retryKind:'analysis'});
 aiExtractPlaces.mockClear();extractPublicPost.mockRejectedValue(new EngineError('source_unavailable',{stage:'source'}));
 await run(createEngineFeatures().forJob('u'),'retry');
 expect(aiExtractPlaces).not.toHaveBeenCalled();
 expect(db.read('enrichmentJobs','retry')).toMatchObject({captionAnalysisIncomplete:true,analysisRecovery:RECOVERY});
 expect((await db.collection('pins').get()).docs.map(p=>p.data().placeId)).toEqual([google.place_id]);
});
test('caption repair cannot clear separate unfinished media when media is disabled',async()=>{
 aiExtractPlaces.mockResolvedValue({places:[{...place}],count:1,incomplete:true});
 collectVideoEvidence.mockResolvedValue({places:[],incomplete:true,coverage:{audio:{status:'failed'}},
   error:new EngineError('dependency_timeout',{stage:'media'})});
 await run();await saveSelectedPlaces('job','u',[google.place_id]);
 expect(db.read('enrichmentJobs','job')).toMatchObject({captionAnalysisIncomplete:true,mediaAnalysisIncomplete:true});
 db.seed('enrichmentJobs','retry',{userId:'u',url,status:'processing',retryOf:'job',retryKind:'analysis'});
 aiExtractPlaces.mockResolvedValue({places:[{...place}],count:1});collectVideoEvidence.mockClear();
 await run(createEngineFeatures().forJob('u'),'retry');
 expect(collectVideoEvidence).not.toHaveBeenCalled();
 expect(db.read('enrichmentJobs','retry')).toMatchObject({status:'complete',captionAnalysisIncomplete:false,mediaAnalysisIncomplete:true,analysisRecovery:RECOVERY});
 expect((await db.collection('pins').get()).size).toBe(1);
});
test('failed analysis retry after a successful save emits saved-with-review notification',async()=>{
 aiExtractPlaces.mockResolvedValue({places:[{...place}],count:1,incomplete:true});
 await run();await saveSelectedPlaces('job','u',[google.place_id]);
 db.seed('enrichmentJobs','retry',{userId:'u',url,status:'processing',retryOf:'job',retryKind:'analysis'});
 db.seed('users','u',{expoPushToken:'synthetic-token'});
 aiExtractPlaces.mockRejectedValue(new EngineError('dependency_timeout',{stage:'ai'}));
 require('../lib/push').sendPushForJob.mockImplementationOnce(jest.requireActual('../lib/push').sendPushForJob);
 await run(features,'retry');
 expect(db.read('enrichmentJobs','retry')).toMatchObject({status:'complete',captionAnalysisIncomplete:true,analysisRecovery:RECOVERY});
 expect(mockPushSend).toHaveBeenCalledWith([expect.objectContaining({title:'1 place saved',
   body:"Couldn't finish checking this post. Your saved places are kept. Tap to review.",data:{type:'pin_failed',jobId:'retry'}})]);
 expect((await db.collection('pins').get()).size).toBe(1);
});
test('explicit analysis retry still runs media with strong caption match',async()=>{
 db.seed('enrichmentJobs','parent',{userId:'u',url,status:'failed',analysisRecovery:RECOVERY,outcomes:[]});
 db.seed('enrichmentJobs','job',{userId:'u',url,status:'processing',retryOf:'parent',retryKind:'analysis'});
 await run();expect(collectVideoEvidence).toHaveBeenCalledTimes(1);
});
test('dismissing partial caption selection clears recovery, without saving',async()=>{
 aiExtractPlaces.mockResolvedValue({places:[{...place}],incomplete:true,count:1});await run();
 const result=await saveSelectedPlaces('job','u',[]);
 expect(result.analysisRecovery).toBeNull();expect(result.captionAnalysisIncomplete).toBe(false);
 expect((await db.collection('pins').get()).size).toBe(0);
});

test.each(require('./engine/caption-incidents.json'))('$id reaches selection and saves the correct identity once',async fixture=>{
 extractPublicPost.mockResolvedValue({description:fixture.caption,webpage_url:url});
 aiExtractPlaces.mockResolvedValue({places:[{...fixture.place}],count:1});
 searchGooglePlaces.mockImplementation(async(_query,_bias,_restriction,options)=>[
   {...fixture.google,...(fixture.localizedName && options?.languageCode==='ja'?{name:fixture.localizedName}:{})},
 ]);
 await run();const job=db.read('enrichmentJobs','job');
 expect(job.status).toBe('needs_selection');expect(job.candidates.map(p=>p.placeId)).toEqual([fixture.expectedPlaceId]);
 expect((await db.collection('pins').get()).size).toBe(0);
 await saveSelectedPlaces('job','u',[fixture.expectedPlaceId]);await saveSelectedPlaces('job','u',[fixture.expectedPlaceId]);
 expect((await db.collection('pins').get()).docs.map(p=>p.data().placeId)).toEqual([fixture.expectedPlaceId]);
 expect(db.read('enrichmentJobs','job')).toMatchObject({status:'complete',progress:{saved:1,total:1}});
});
