jest.mock('../lib/firestore',()=>({firestore:null,admin:null}));
const jobContext=require('../lib/jobContext');
const {createEngineFeatures}=require('../lib/engineFeatures');
const {createVideoEvidence}=require('../lib/media/videoEvidence');
const {EngineError}=require('../lib/engineError');
const features=createEngineFeatures({snapshotVersion:2,internalUids:['u'],flags:{mediaEvidence:true}}).forJob('u',undefined,['mediaRecoveryV1']);
const context=()=>({features,userId:'u',deadline:Date.now()+120000});
const frames=Array.from({length:16},(_,i)=>({digest:String(i),timestampMs:i*100,width:10,height:10}));
function fixture(overrides={}) {
 const deps={discover:jest.fn(async()=>({availability:'available'})),acquire:jest.fn(async()=>({contentDigest:'a'.repeat(64),bytes:500,dispose:jest.fn()})),
 probe:jest.fn(async()=>({durationMs:3000,hasAudio:true})),audio:jest.fn(async()=>[]),
 transcribe:jest.fn(async()=>({segments:[{text:'Cafe A',evidenceId:'a:1',startMs:0,endMs:3000,origin:'audio'}],coverage:{status:'complete',intervals:[[0,3000]]}})),
 frames:jest.fn(async()=>({frames,scannedFrames:18})),fusion:jest.fn(async()=>({places:[{name:'Cafe A',requiresSelection:true},{name:'Cafe B',requiresSelection:true}]})),
 vision:jest.fn(async()=>({places:[{name:'Cafe B',requiresSelection:true}]})),...overrides};
 return {deps,run:()=>jobContext.run(context(),()=>createVideoEvidence(deps)({url:'x',ogData:{},reason:'thin_text'}))};
}
test('feature off makes no new media calls',async()=>{
 const f=fixture();await jobContext.run({...context(),features:null},()=>createVideoEvidence(f.deps)({url:'x'}));
 expect(f.deps.discover).not.toHaveBeenCalled();
});
test('concurrent modalities preserve distinct venues and two bounded full-timeline frame batches',async()=>{
 const f=fixture(),result=await f.run();
 expect(result.incomplete).toBe(false);expect(result.places.map(p=>p.name).sort()).toEqual(['Cafe A','Cafe B']);
 expect(f.deps.vision).toHaveBeenCalledTimes(2);
 expect(f.deps.vision.mock.calls[0][0].frames.map(f=>f.timestampMs)).toEqual([0,200,400,600,800,1000,1200,1400]);
 expect((await f.deps.acquire.mock.results[0].value).dispose).toHaveBeenCalledTimes(1);
});
test('optional visual timeout preserves successful spoken venue and marks coverage incomplete',async()=>{
 const f=fixture({vision:jest.fn(async()=>{throw new EngineError('dependency_timeout',{stage:'video_vision'});})});
 const result=await f.run();expect(result.places[0].name).toBe('Cafe A');expect(result.incomplete).toBe(true);
 expect(result.coverage.visual.status).toBe('failed');
});
test('source rejection cannot become successful empty analysis or invoke paid stages',async()=>{
 const f=fixture({discover:jest.fn(async()=>{throw new EngineError('rate_limited',{stage:'source'});})});
 const result=await f.run();expect(result.incomplete).toBe(true);expect(result.error.code).toBe('rate_limited');
 expect(f.deps.transcribe).not.toHaveBeenCalled();expect(f.deps.vision).not.toHaveBeenCalled();
});
test('cancelled parent cannot consume late evidence',async()=>{
 const abort=new AbortController();const f=fixture({fusion:jest.fn(async()=>{abort.abort();return {places:[{name:'late'}]};})});
 await expect(jobContext.run({...context(),signal:abort.signal},()=>createVideoEvidence(f.deps)({url:'x'}))).rejects.toMatchObject({code:'attempt_stopped'});
});
test('small frame sets use one paid call and public evidence remains shareable with private notes',async()=>{
 const f=fixture({frames:jest.fn(async()=>({frames:frames.slice(0,2)}))});
 await jobContext.run(context(),()=>createVideoEvidence(f.deps)({url:'x',ogData:{shareText:'my private note',description:'my private note'}}));
 expect(f.deps.vision).toHaveBeenCalledTimes(1);
 expect(f.deps.vision.mock.calls[0][1].scope).toBe(require('../lib/sharedAiIdentity').SERVER_PUBLIC_SCOPE);
 expect(f.deps.transcribe.mock.calls[0][1].scope).toBe(require('../lib/sharedAiIdentity').SERVER_PUBLIC_SCOPE);
 expect(f.deps.fusion.mock.calls[0][1].scope).toBe('user:u');
});
test('fusion receives literal visual observations together with speech and baseline identity context',async()=>{
 const f=fixture({vision:jest.fn(async()=>({places:[],observations:[{evidenceId:'frame:a',quote:'寿司 太',region:[0,0,1,1]}]})),
  fusion:jest.fn(async input=>({places:[{name:'寿司 太',city:'Kyoto',requiresSelection:true}],contradictions:[{name:'Wrong Cafe',evidenceRefs:[{evidenceId:'a:1',quote:'not Wrong Cafe'}]}]}))});
 const result=await jobContext.run(context(),()=>createVideoEvidence(f.deps)({url:'x',baselinePlaces:[{name:'Wrong Cafe'}]}));
 expect(f.deps.fusion).toHaveBeenCalledTimes(1);
 expect(f.deps.fusion.mock.calls[0][0].textEvidence).toEqual(expect.arrayContaining([expect.objectContaining({modality:'visual',text:'寿司 太'}),expect.objectContaining({modality:'transcript'})]));
 expect(f.deps.fusion.mock.calls[0][0].baselinePlaces).toEqual([expect.objectContaining({name:'Wrong Cafe'})]);
 expect(result.contradictions).toHaveLength(1);
});
