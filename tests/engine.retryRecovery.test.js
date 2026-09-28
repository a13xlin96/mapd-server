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
test('explicit retry of an unverified generic name gathers fresh evidence and can recover through media',async()=>{
 db.seed('enrichmentJobs','parent',{userId:'u',url,status:'failed',ogTitle:'Michelin pho',outcomes:[{name:'Michelin pho',city:'Ho Chi Minh City',status:'unresolved',failure:{code:'no_verified_match'}}]});child();
 collectVideoEvidence.mockResolvedValue(collected([{name:'Actual Restaurant',city:'Kyoto',source:'transcript',requiresSelection:true}]));
 searchGooglePlaces.mockResolvedValue([google('actual','Actual Restaurant')]);
 await run(media);
 const j=db.read('enrichmentJobs','child');
 expect(extractPublicPost).toHaveBeenCalledTimes(1);expect(aiExtractPlaces).toHaveBeenCalledTimes(1);
 expect(aiExtractPlaces.mock.calls[0][1]).toMatchObject({bypassCache:true});expect(collectVideoEvidence).toHaveBeenCalledTimes(1);
 expect(j).toMatchObject({status:'needs_selection',candidates:[{placeId:'actual'}]});
 expect(j.outcomes.some(o=>o.name==='Michelin pho')).toBe(false);expect((await db.collection('pins').get()).size).toBe(0);
});
test('fresh source/AI failure does not erase old unresolved names or previously saved outcomes',async()=>{
 db.seed('enrichmentJobs','parent',{userId:'u',url,status:'failed',outcomes:[{name:'Saved',placeId:'saved',pinId:'p',status:'saved'},{name:'Still unknown',status:'unresolved'}]});child();
 extractPublicPost.mockRejectedValue(new EngineError('access_blocked'));
 await run();
 expect(db.read('enrichmentJobs','child')).toMatchObject({status:'failed',progress:{saved:1,total:2},failure:{code:'partial_save'}});
 expect(db.read('enrichmentJobs','child').outcomes).toContainEqual(expect.objectContaining({name:'Still unknown',status:'unresolved'}));
});
test('an explicit retry retains selected exact IDs and does not call AI or Google again',async()=>{
 const candidates=[pin('a','Same-name Kyoto'),pin('b','Second place')];
 db.seed('enrichmentJobs','parent',{userId:'u',url,status:'needs_selection',candidates,outcomes:candidates.map(p=>({name:p.placeName,placeId:p.placeId,status:'candidate'}))});
 db.setWriteFailure(c=>c==='pins'?new Error('simulated save failure'):null);
 const failed=await saveSelectedPlaces('parent','u',['a','b']);
 expect(failed.status).toBe('failed');expect(failed.outcomes.every(o=>o.confirmedPlaceId===o.placeId)).toBe(true);
 db.setWriteFailure(null);child();await run(media);
 expect(db.read('enrichmentJobs','child')).toMatchObject({status:'complete',progress:{saved:2,total:2}});
 expect((await db.collection('pins').get()).docs.map(d=>d.data().placeId).sort()).toEqual(['a','b']);
 expect(extractPublicPost).not.toHaveBeenCalled();expect(aiExtractPlaces).not.toHaveBeenCalled();expect(searchGooglePlaces).not.toHaveBeenCalled();expect(collectVideoEvidence).not.toHaveBeenCalled();
});
test('selected save retry coexists with fresh recovery without resaving or resurrecting other outcomes',async()=>{
 db.seed('pins','saved',{...pin('saved'),sources:[]});
 db.seed('enrichmentJobs','parent',{userId:'u',url,status:'failed',selectedPlaceIds:['chosen'],candidates:[pin('chosen')],outcomes:[
  {name:'saved',placeId:'saved',pinId:'saved',status:'saved'},
  {name:'chosen',placeId:'chosen',status:'unresolved'},
  {name:'dismissed',placeId:'dismissed',status:'dismissed'},
  {name:'generic food',status:'unresolved'}]});child();
 aiExtractPlaces.mockResolvedValue({places:[{name:'New place',city:'Kyoto'},{name:'dismissed',city:'Kyoto'}]});
 searchGooglePlaces.mockImplementation(async q=>[q.startsWith('New place')?google('new','New place'):google('dismissed')]);
 await run(media);
 const j=db.read('enrichmentJobs','child');
 expect(j.status).toBe('needs_selection');expect(j.candidates.map(p=>p.placeId)).toEqual(['new']);
 expect(j.outcomes).toContainEqual(expect.objectContaining({placeId:'chosen',status:'saved'}));
 expect(j.outcomes).toContainEqual(expect.objectContaining({placeId:'dismissed',status:'dismissed'}));
 expect((await db.collection('pins').get()).docs.map(d=>d.data().placeId).sort()).toEqual(['chosen','saved']);
});
test('a second failed selected-save retry retains exact snapshot for the next explicit retry',async()=>{
 db.seed('enrichmentJobs','parent',{userId:'u',url,status:'failed',selectedPlaceIds:['chosen'],candidates:[pin('chosen')],outcomes:[{name:'chosen',placeId:'chosen',status:'unresolved'}]});child();
 db.setWriteFailure(c=>c==='pins'?new Error('simulated save failure'):null);await run();
 expect(db.read('enrichmentJobs','child')).toMatchObject({status:'failed',candidates:[{placeId:'chosen'}]});
 db.setWriteFailure(null);db.seed('enrichmentJobs','third',{userId:'u',url,status:'processing',retryOf:'child'});
 const retry=await getRetryContext(db,'third','u',url);expect(retry.recoveryCandidates.map(p=>p.placeId)).toEqual(['chosen']);
 await runEnrichment('third',url,'u','');expect(db.read('enrichmentJobs','third').status).toBe('complete');
 expect(searchGooglePlaces).not.toHaveBeenCalled();
});
test('interrupted selection keeps unattempted selected candidate but never unselected ones',async()=>{
 db.seed('enrichmentJobs','parent',{userId:'u',url,status:'failed',selectedPlaceIds:['saved','not-reached'],candidates:[pin('saved'),pin('not-reached'),pin('not-chosen')],outcomes:[{name:'saved',placeId:'saved',pinId:'p',status:'saved'}]});child();
 const retry=await getRetryContext(db,'child','u',url);
 expect(retry.resumePlaces).toEqual([expect.objectContaining({placeId:'not-reached',confirmedPlaceId:'not-reached'})]);
 expect(retry.reanalyzeIdentity).toBe(false);
});
test('a mixed retry with another failed selected save retains its snapshot when new choices appear',async()=>{
 db.seed('enrichmentJobs','parent',{userId:'u',url,status:'failed',selectedPlaceIds:['chosen'],candidates:[pin('chosen')],outcomes:[
  {name:'chosen',placeId:'chosen',status:'unresolved'}, {name:'unknown',status:'unresolved'}]});child();
 aiExtractPlaces.mockResolvedValue({places:[{name:'New place',city:'Kyoto'}]});
 searchGooglePlaces.mockResolvedValue([google('new','New place')]);
 db.setWriteFailure(c=>c==='pins'?new Error('save unavailable'):null);
 await run(media);
 const j=db.read('enrichmentJobs','child');
 expect(j.status).toBe('needs_selection');expect(j.retryCandidates.map(p=>p.placeId)).toEqual(['chosen']);
 expect(j.outcomes).toContainEqual(expect.objectContaining({placeId:'chosen',confirmedPlaceId:'chosen',status:'unresolved'}));
 db.setWriteFailure(null);await saveSelectedPlaces('child','u',['new']);
 db.seed('enrichmentJobs','third',{userId:'u',url,status:'processing',retryOf:'child'});
 await runEnrichment('third',url,'u','');
 expect(db.read('enrichmentJobs','third')).toMatchObject({status:'complete',progress:{saved:2,total:2}});
 expect((await db.collection('pins').get()).docs.map(d=>d.data().placeId).sort()).toEqual(['chosen','new']);
});
