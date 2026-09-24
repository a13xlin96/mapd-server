jest.mock('../lib/firestore',()=>({firestore:require('./helpers/fakeFirestore').getSharedFirestore(),admin:require('./helpers/fakeFirestore').makeAdmin()}));
const {getSharedFirestore}=require('./helpers/fakeFirestore');
const {getRetryContext,withOutcomeSummary}=require('../lib/retryContext');
const {withAnalysisRecovery,RECOVERY}=require('../lib/media/analysisRecovery');
const db=getSharedFirestore();
beforeEach(()=>db.reset());
test('equal saved/total remains complete and offers separate bounded analysis recovery',()=>{
 const ctx={mediaIncomplete:true,mediaCoverage:{audio:{status:'partial',intervals:[[0,1]]}},outcomes:[{name:'A',status:'saved',pinId:'p'}]};
 const job=withAnalysisRecovery(withOutcomeSummary({status:'complete'},ctx),ctx);
 expect(job).toMatchObject({status:'complete',progress:{saved:1,total:1},analysisRecovery:RECOVERY});
 expect(job.failure).toBeUndefined();expect(job.evidenceCoverage).toEqual({audio:{status:'partial'}});
});
test('unresolved identified places keep strict partial_save and analysis can also remain incomplete',()=>{
 const ctx={mediaIncomplete:true,outcomes:[{name:'A',status:'saved'},{name:'B',status:'unresolved'}]};
 expect(withAnalysisRecovery(withOutcomeSummary({status:'complete'},ctx),ctx)).toMatchObject({status:'failed',progress:{saved:1,total:2},failure:{code:'partial_save'},analysisRecovery:RECOVERY});
});
test('failed new analysis preserves previously committed pins and explicit dismissal clears recovery',()=>{
 const ctx={mediaIncomplete:true,outcomes:[{name:'A',status:'saved'}]};
 expect(withAnalysisRecovery(withOutcomeSummary({status:'failed'},ctx),ctx)).toMatchObject({status:'complete',analysisRecovery:RECOVERY});
 expect(withAnalysisRecovery({status:'complete'},{analysisRecovery:null})).toMatchObject({analysisRecovery:null});
});
test('analysis retry keeps known outcomes, reuses successes, and only advances specific failed operations',async()=>{
 const record={kind:'asr_chunk',retryKey:'a'.repeat(64),generation:2};
 db.seed('enrichmentJobs','old',{url:'https://example.test/video',userId:'u',status:'complete',analysisRecovery:RECOVERY,
  mediaRetryOperations:[record],outcomes:[{status:'saved',name:'A',placeId:'A'},{status:'dismissed',name:'B',placeId:'B'}]});
 db.seed('enrichmentJobs','new',{retryOf:'old',retryKind:'analysis'});
 const ctx=await getRetryContext(db,'new','u','https://example.test/video');
 expect(ctx).toMatchObject({analysisRetry:true,mediaRetryOperations:[record]});
 expect(ctx.baseOutcomes).toHaveLength(2);expect(ctx.resumePlaces).toBeUndefined();expect(ctx.bypassCache).toBeUndefined();
 await expect(getRetryContext(db,'new','other','https://example.test/video')).rejects.toMatchObject({code:'access_blocked'});
});
test('arbitrary completed jobs cannot authorize analysis retry generations',async()=>{
 db.seed('enrichmentJobs','old',{url:'x',userId:'u',status:'complete'});db.seed('enrichmentJobs','new',{retryOf:'old',retryKind:'analysis'});
 await expect(getRetryContext(db,'new','u','x')).rejects.toMatchObject({code:'invalid_response'});
});
test('places retry preserves pending analysis recovery for a later explicit analysis retry',async()=>{
 db.seed('enrichmentJobs','old',{url:'x',userId:'u',status:'failed',analysisRecovery:RECOVERY,
  outcomes:[{name:'A',status:'saved',placeId:'A'},{name:'B',status:'unresolved'}]});
 db.seed('enrichmentJobs','new',{retryOf:'old'});
 const ctx=await getRetryContext(db,'new','u','x');
 expect(ctx.analysisRecovery).toEqual(RECOVERY);expect(ctx.resumePlaces).toHaveLength(1);
});

test('analysis retry walks failed delivery ancestry but never revives an explicitly cleared recovery',async()=>{
 const record={kind:'asr_chunk',retryKey:'a'.repeat(64),generation:3};
 db.seed('enrichmentJobs','A',{userId:'u',url:'x',status:'failed',analysisRecovery:RECOVERY,mediaRetryOperations:[record],
  outcomes:[{name:'Saved',status:'saved'},{name:'Remaining',status:'unresolved'}]});
 db.seed('enrichmentJobs','B',{userId:'u',url:'x',status:'failed',retryOf:'A',retryKind:'analysis'});
 db.seed('enrichmentJobs','C',{retryOf:'B',retryKind:'analysis'});
 const retry=await getRetryContext(db,'C','u','x');
 expect(retry.mediaRetryOperations).toEqual([record]);expect(retry.initialOutcomes).toHaveLength(2);
 expect(retry.priorUnresolvedOutcomes).toEqual([{name:'Remaining',status:'unresolved'}]);
 db.seed('enrichmentJobs','B',{userId:'u',url:'x',status:'failed',retryOf:'A',retryKind:'analysis',analysisRecovery:null});
 await expect(getRetryContext(db,'C','u','x')).rejects.toMatchObject({code:'invalid_response'});
});
test('retry ancestry validates every hop and rejects cycles and unbounded chains',async()=>{
 db.seed('enrichmentJobs','C',{retryOf:'B',retryKind:'analysis'});
 db.seed('enrichmentJobs','B',{userId:'u',url:'x',status:'failed',retryOf:'A',retryKind:'analysis'});
 db.seed('enrichmentJobs','A',{userId:'other',url:'x',status:'failed',analysisRecovery:RECOVERY});
 await expect(getRetryContext(db,'C','u','x')).rejects.toMatchObject({code:'access_blocked'});
 db.seed('enrichmentJobs','A',{userId:'u',url:'x',status:'failed',retryOf:'B',retryKind:'analysis'});
 await expect(getRetryContext(db,'C','u','x')).rejects.toMatchObject({code:'invalid_response'});
 for(let i=0;i<10;i++)db.seed('enrichmentJobs','hop'+i,{userId:'u',url:'x',status:'failed',retryOf:'hop'+(i+1),retryKind:'analysis'});
 db.seed('enrichmentJobs','C',{retryOf:'hop0',retryKind:'analysis'});
 await expect(getRetryContext(db,'C','u','x')).rejects.toMatchObject({code:'invalid_response'});
});
test('fresh matching replaces only the same prior unresolved place, preserving another branch',()=>{
 const {retainUnresolved}=require('../lib/retryContext');
 const old=[{name:'Cafe',city:'Kyoto',status:'unresolved'}, {name:'Cafe',city:'Tokyo',status:'unresolved'}, {name:'Old spelling',placeId:'p',status:'unresolved'}];
 expect(retainUnresolved(old,[{name:'CAFE',city:'Kyoto',status:'candidate'}, {name:'New spelling',placeId:'p',status:'existing'}]))
  .toEqual([old[1]]);
});

test('pending operation identity survives publication without granting a fabricated retry generation',()=>{
 const pending={kind:'asr_chunk',retryKey:'b'.repeat(64),generation:null};
 const invalid={...pending,generation:0};
 const job=withAnalysisRecovery({status:'failed'},{mediaIncomplete:true,mediaRetryOperations:[pending,invalid]});
 expect(job.mediaRetryOperations).toEqual([pending]);
});
