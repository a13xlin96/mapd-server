// Only source/model responses, media and remote storage are replaced. The
// shipped parser, ranking, orchestration, selection, retry and save code run.
jest.mock('../lib/firestore',()=>({firestore:require('./helpers/fakeFirestore').getSharedFirestore(),admin:require('./helpers/fakeFirestore').makeAdmin()}));
jest.mock('../lib/cache',()=>({redis:null,getCached:jest.fn(async()=>null),setCache:jest.fn(async()=>{})}));
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
const {extractPublicPost}=require('../lib/extraction');
const {collectVideoEvidence}=require('../lib/media/videoEvidence');
const {aiExtractPlaces}=require('../enrich/ai');
const {searchGooglePlaces}=require('../enrich/places');
const {createEngineFeatures}=require('../lib/engineFeatures');
const {parseCaptionResponse,normalizeCaptionResult}=require('../lib/captionResponse');
const {cases,frozenLookup}=require('./engine/historical-caption-cases.cjs');
const {RECOVERY}=require('../lib/media/analysisRecovery');
const {EngineError}=require('../lib/engineError');
const policy=version=>createEngineFeatures({snapshotVersion:2,internalUids:['u'],flags:{mediaEvidence:true},
 mediaPolicy:{policyVersion:version,analysisMode:'audio-only'}}).forJob('u',undefined,['mediaRecoveryV1']);
const result=clues=>normalizeCaptionResult(parseCaptionResponse({stop_reason:'tool_use',content:[{
 type:'tool_use',id:'synthetic-response',name:'submit_caption_places',input:{places:JSON.parse(JSON.stringify(clues))}}]}));
const outputs=[];
const unresolvedOutcome=p=>({...p,status:'unresolved',failure:{code:'no_verified_match',stage:'matching'}});
beforeEach(()=>{db.reset();jest.clearAllMocks();
 collectVideoEvidence.mockResolvedValue({places:[],incomplete:false,coverage:{audio:{status:'complete'},
   visual:{status:'unavailable',reason:'disabled_by_policy'}}});
});
async function replay(fixture,version='media-v2',retry=false,partial=false,priorOnly=[]) {
 const features=policy(version);
 db.seed('enrichmentJobs','job',{userId:'u',url:fixture.url,status:'processing',...(retry?{retryOf:'parent'}:{})});
 if(retry)db.seed('enrichmentJobs','parent',{userId:'u',url:fixture.url,status:'failed',outcomes:[...fixture.clues,...priorOnly].map(unresolvedOutcome)});
 extractPublicPost.mockResolvedValue({title:'Saved places',description:fixture.caption,webpage_url:fixture.url});
 aiExtractPlaces.mockImplementation(async()=>result(partial?[...fixture.clues,{name:'Invalid extra',placeId:'model-forged-id'}]:fixture.clues));
 searchGooglePlaces.mockImplementation(frozenLookup(fixture));
 await runEnrichment('job',fixture.url,'u','',{features,deadline:Date.now()+120000});
 // Lookup exceptions can be caught by production recovery; they must still
 // fail the replay instead of silently standing in for a recorded response.
 for(const lookup of searchGooglePlaces.mock.results)await expect(lookup.value).resolves.toEqual(expect.any(Array));
 const job=db.read('enrichmentJobs','job');
 const candidateIds=(job.candidates||[]).map(p=>p.placeId);
 const savedIds=(await db.collection('pins').get()).docs.map(p=>p.data().placeId);
 expect(['needs_selection','complete','duplicate']).toContain(job.status);
 expect(job.outcomes?.filter(o=>o.status==='unresolved')||[]).toEqual(priorOnly.map(unresolvedOutcome));
 expect([...new Set([...candidateIds,...savedIds])].sort()).toEqual([...fixture.expectedIds].sort());
 if(partial) {
   expect(job).toMatchObject({status:'needs_selection',analysisRecovery:RECOVERY,captionAnalysisIncomplete:true,
     progress:{saved:0,total:fixture.expectedIds.length+priorOnly.length}});
   expect(job.outcomes.filter(o=>o.status==='candidate')).toHaveLength(fixture.expectedIds.length);
   expect(job.outcomes.filter(o=>o.status==='candidate').every(o=>o.requiresSelection===true)).toBe(true);
   expect(job.outcomes.some(o=>o.name==='Invalid extra' || o.placeId==='model-forged-id')).toBe(false);
 }
 if(job.status==='needs_selection') {
   expect([...candidateIds].sort()).toEqual([...fixture.expectedIds].sort());
   expect(savedIds).toEqual([]);
   await saveSelectedPlaces('job','u',candidateIds);
   await saveSelectedPlaces('job','u',candidateIds);
 }
 const committed=(await db.collection('pins').get()).docs.map(p=>p.data());
 expect(committed.map(p=>p.placeId).sort()).toEqual([...fixture.expectedIds].sort());
 expect(committed.every(p=>p.sources.filter(s=>s.url===fixture.url).length===1)).toBe(true);
 const finalJob=db.read('enrichmentJobs','job');
 expect(finalJob).toMatchObject({status:priorOnly.length?'failed':'complete',
   progress:{saved:fixture.expectedIds.length,total:fixture.expectedIds.length+priorOnly.length}});
 expect(finalJob.outcomes.filter(o=>o.status==='unresolved')).toEqual(priorOnly.map(unresolvedOutcome));
 expect(finalJob.outcomes.filter(o=>['saved','existing'].includes(o.status)).map(o=>o.placeId).sort()).toEqual([...fixture.expectedIds].sort());
 if(priorOnly.length)expect(finalJob.failure).toMatchObject({code:'partial_save'});
 else expect(finalJob.failure?.code).not.toBe('partial_save');
 if(partial)expect(finalJob).toMatchObject({analysisRecovery:RECOVERY,captionAnalysisIncomplete:true});
 outputs.push({id:fixture.id,name:fixture.name,version,retry,partial,initialStatus:job.status,
   priorUnresolved:priorOnly.length,finalStatus:finalJob.status,progress:finalJob.progress,
   uniquePins:committed.length,googleLookups:searchGooglePlaces.mock.calls.length,mediaPasses:collectVideoEvidence.mock.calls.length,
   provenance:fixture.provenance});
 return features;
}
for(const version of ['media-v2','media-v3'])for(const retry of [false,true])
 test.each(cases)(`${version} ${retry?'explicit retry':'fresh share'}: $name matches and saves each identity once`,f=>replay(f,version,retry));
test.each(cases.filter(c=>['kuma','tokyo'].includes(c.id)))('$name survives an invalid sibling without claiming full analysis',async f=>{
 await replay(f,'media-v2',true,true);
 expect(db.read('enrichmentJobs','job').outcomes.some(o=>o.placeId==='model-forged-id')).toBe(false);
});
test('incomplete caption retry retains a genuinely unresolved prior venue after saving all matched aliases',async()=>{
 const f=cases.find(c=>c.id==='tokyo');
 await replay(f,'media-v2',true,true,[{name:'Unknown prior ramen shop',city:'Tokyo, Japan',source:'caption'}]);
});
test('a matched alias cannot discharge a different exact prior Places ID with the same text',async()=>{
 const f=cases.find(c=>c.id==='kuma');
 await replay(f,'media-v2',true,true,[{...f.clues[1],placeId:'different-prior-place'}]);
});
test.each(['caption','media'])('Kuma retry preserves an already saved primary and resolves its alias during incomplete %s analysis',async incomplete=>{
 const f=cases.find(c=>c.id==='kuma');
 await replay(f);
 const saved=db.read('enrichmentJobs','job').outcomes.find(o=>o.status==='saved');
 expect(saved).toMatchObject({...f.clues[0],placeId:f.expectedIds[0]});
 const originalPins=(await db.collection('pins').get()).docs.map(p=>({id:p.id,sources:p.data().sources}));
 // Reconstruct the saved-primary/unresolved-alias shape. These frozen rows
 // now match both clues; this does not attribute the older live failure,
 // whose alias ranking reported an address conflict, to alias accounting.
 db.seed('enrichmentJobs','parent',{userId:'u',url:f.url,status:'failed',progress:{saved:1,total:2},
   failure:{code:'partial_save'},outcomes:[saved,unresolvedOutcome(f.clues[1])]});
 db.seed('enrichmentJobs','retry',{userId:'u',url:f.url,status:'processing',retryOf:'parent'});
 jest.clearAllMocks();
 aiExtractPlaces.mockImplementation(async()=>result(incomplete==='caption'
   ? [...f.clues,{name:'Invalid extra',placeId:'model-forged-id'}] : f.clues));
 if(incomplete==='media')collectVideoEvidence.mockResolvedValue({places:[],incomplete:true,
   error:new EngineError('dependency_timeout',{stage:'media'}),
   coverage:{audio:{status:'failed'},visual:{status:'unavailable',reason:'disabled_by_policy'}}});
 await runEnrichment('retry',f.url,'u','',{features:policy('media-v2'),deadline:Date.now()+120000});
 expect(aiExtractPlaces).toHaveBeenCalledTimes(1);
 expect(searchGooglePlaces).toHaveBeenCalledWith(f.entries[1].query);
 for(const lookup of searchGooglePlaces.mock.results)await expect(lookup.value).resolves.toEqual(expect.any(Array));
 const job=db.read('enrichmentJobs','retry');
 expect(job).toMatchObject({status:'duplicate',sourceAdded:false,progress:{saved:1,total:1},analysisRecovery:RECOVERY,
   captionAnalysisIncomplete:incomplete==='caption',mediaAnalysisIncomplete:incomplete==='media'});
 expect(job.failure?.code).not.toBe('partial_save');
 expect(job.outcomes).toEqual([expect.objectContaining({status:'existing',placeId:f.expectedIds[0]})]);
 const pins=(await db.collection('pins').get()).docs;
 expect(pins.map(p=>p.data().placeId)).toEqual(f.expectedIds);
 expect(pins.map(p=>({id:p.id,sources:p.data().sources}))).toEqual(originalPins);
 expect(pins[0].data().sources.filter(s=>s.url===f.url)).toHaveLength(1);
});
test('Tokyo roundup saves selected pins and retains recovery after optional media fails',async()=>{
 const f=cases.find(c=>c.id==='tokyo');
 collectVideoEvidence.mockResolvedValue({places:[],incomplete:true,error:new EngineError('dependency_timeout',{stage:'media'}),
   coverage:{audio:{status:'failed'},visual:{status:'unavailable',reason:'disabled_by_policy'}}});
 await replay(f);
 expect(db.read('enrichmentJobs','job')).toMatchObject({analysisRecovery:RECOVERY,mediaAnalysisIncomplete:true});
});
afterAll(()=>{
 // Optional private report for a controlled local run; normal CI writes none.
 if(process.env.MAPD_HISTORICAL_REPLAY_REPORT)require('fs').writeFileSync(process.env.MAPD_HISTORICAL_REPLAY_REPORT,
   JSON.stringify({scope:'Offline replay of captured Google responses with reconstructed source/model inputs; zero live provider requests and no production writes',cases:outputs},null,2),{mode:0o600});
});
