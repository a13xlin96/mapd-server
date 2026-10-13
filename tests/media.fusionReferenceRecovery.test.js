jest.mock('../lib/cache',()=>({redis:null}));
jest.mock('../lib/firestore',()=>({firestore:null}));
const {createEvidenceFusion}=require('../lib/media/fuseEvidence');
const {createSharedAiOperations,SERVER_PUBLIC_SCOPE}=require('../lib/sharedAiOperation');
const {validateVideoResponse}=require('../lib/media/videoVision');
const {FakeFirestore}=require('./helpers/fakeFirestore');
const jobContext=require('../lib/jobContext');

const evidence=[{evidenceId:'caption:1',modality:'caption',text:'上好雞肉 | Shang Hao Chicken Rice in New Taipei City.'},
  {evidenceId:'audio:1',modality:'transcript',text:'Then visit Cafe Other.'}];
const input={mediaDigest:'a'.repeat(64),durationMs:10000,textEvidence:evidence};
const ref=(evidenceId,quote,supports='name')=>({evidenceId,quote,supports});
const place=()=>({name:'Shang Hao',city:'New Taipei City',evidenceRefs:[
  ref('caption:1','Shang Hao'),ref('caption:1','New Taipei City','city')]});
const other=()=>({name:'Cafe Other',evidenceRefs:[ref('audio:1','Cafe Other')]});
const opts={scope:SERVER_PUBLIC_SCOPE,policy:{policyVersion:'media-v2',analysisMode:'audio-only'}};
function fixture(places) {
  const db=new FakeFirestore(),cache={getCached:jest.fn(),setCache:jest.fn()},
    shared=createSharedAiOperations({firestore:db,cache,limits:{pollMs:5}}),operations=[];
  const createMessage=jest.fn(async()=>({stop_reason:'tool_use',content:[
    {type:'tool_use',id:'toolu_test',name:'submit_places',input:{places,contradictions:[]}}]}));
  const fusion=createEvidenceFusion({sharedOperation:async(options,work)=>{operations.push(options);return shared.runSharedAiOperation(options,work);},
    providerCall:async(_provider,work)=>{await jobContext.current()?.sharedOperation?.authorizeDispatch();return work();},createMessage});
  return {fusion,createMessage,operations,db,cache};
}
test.each(['unknown-id','nonliteral-quote','text-region'])('fusion omits %s geography reference while retaining independently supported names',async kind=>{
  const venue=place();
  if(kind==='unknown-id')venue.evidenceRefs[1].evidenceId='audio:missing';
  if(kind==='nonliteral-quote')venue.evidenceRefs[1].quote='We are in New Taipei City';
  if(kind==='text-region')venue.evidenceRefs[1].region=[0,0,1,1];
  const f=fixture([venue,other()]),result=await f.fusion(input,opts);
  expect(result.places.map(p=>p.name)).toEqual(['Shang Hao','Cafe Other']);
  expect(result.places[0]).toMatchObject({city:'',requiresSelection:true,evidenceRefs:[ref('caption:1','Shang Hao')]});
  expect(result.grounding).toEqual({omittedClaims:1,omittedCandidates:0});
  const validate=f.operations[0].validate;
  const {retryOperations,...artifact}=result;
  expect(retryOperations).toEqual([{kind:'media_fusion',retryKey:expect.any(String),generation:1}]);
  expect(validate(artifact)).toBe(true);
  const corrupt=structuredClone(artifact);corrupt.places[0].evidenceRefs.push(venue.evidenceRefs[1]);
  expect(validate(corrupt)).toBe(false);
  await f.fusion(input,opts);
  expect(f.createMessage).toHaveBeenCalledTimes(1);
  expect(f.cache.setCache).not.toHaveBeenCalled();
  expect(f.operations[0]).toMatchObject({schemaVersion:5,promptVersion:'grounded-crossmodal-v3'});
});
test('partial fusion stays fenced and explicit duplicate retries share one new request',async()=>{
  const venue=place();venue.evidenceRefs[1].evidenceId='missing';
  const f=fixture([venue]),partial=await f.fusion(input,opts);
  expect(await f.fusion(input,opts)).toEqual(partial);
  expect(f.createMessage).toHaveBeenCalledTimes(1);
  f.createMessage.mockResolvedValue({stop_reason:'tool_use',content:[{type:'tool_use',id:'toolu_retry',
    name:'submit_places',input:{places:[place()],contradictions:[]}}]});
  const retryOptions={...opts,retryOperations:partial.retryOperations};
  const [one,two]=await Promise.all([f.fusion(input,retryOptions),f.fusion(input,retryOptions)]);
  expect(one).toEqual(two);expect(one.grounding).toEqual({omittedClaims:0,omittedCandidates:0});
  expect(one.retryOperations).toBeUndefined();
  expect(f.createMessage).toHaveBeenCalledTimes(2);
  await f.fusion(input,retryOptions);await f.fusion(input,opts);
  expect(f.createMessage).toHaveBeenCalledTimes(2);
});
test('corrupt durable partial evidence fails closed without another provider call',async()=>{
  const venue=place();venue.evidenceRefs[1].evidenceId='missing';const f=fixture([venue]);
  await f.fusion(input,opts);
  const collection=require('../lib/sharedAiStore').COLLECTION;
  const entries=[...f.db.collections.get(collection).entries()];
  const [id,record]=entries.find(([,value])=>value.partialResult);
  record.partialResult.places[0].evidenceRefs[0].quote='invented';f.db.seed(collection,id,record);
  await expect(f.fusion(input,opts)).rejects.toMatchObject({code:'invalid_response',retryOperations:[
    {kind:'media_fusion',retryKey:expect.any(String),generation:1}]});
  expect(f.createMessage).toHaveBeenCalledTimes(1);
});
test('an invalid name reference cannot become a candidate or inherit another evidence source',async()=>{
  const venue=place();venue.evidenceRefs[0]=ref('audio:1','Shang Hao');
  const f=fixture([venue,other()]),result=await f.fusion(input,opts);
  expect(result.places.map(p=>p.name)).toEqual(['Cafe Other']);
  expect(result.grounding).toEqual({omittedClaims:1,omittedCandidates:1});
});
test('all invalid name references yield partial empty evidence, never a fabricated place',async()=>{
  const venue=place();venue.evidenceRefs=[ref('missing','Shang Hao')];
  const result=await fixture([venue]).fusion(input,opts);
  expect(result.places).toEqual([]);
  expect(result.grounding).toEqual({omittedClaims:2,omittedCandidates:1});
});
test('independent valid references may retain a claim, but rejected references still mark partial coverage',async()=>{
  const venue=place();venue.evidenceRefs.push(ref('missing','Shang Hao'));
  const result=await fixture([venue]).fusion(input,opts);
  expect(result.places[0]).toMatchObject({name:'Shang Hao',city:'New Taipei City',requiresSelection:true});
  expect(result.places[0].evidenceRefs).toHaveLength(2);
  expect(result.grounding).toEqual({omittedClaims:1,omittedCandidates:0});
});
test.each([
  p=>{p.evidenceRefs[0].supports='invented';},
  p=>{p.evidenceRefs[0].extra='private';},
  p=>{p.evidenceRefs[0].quote='';},
  p=>{p.evidenceRefs=Array(17).fill(ref('caption:1','Shang Hao'));},
  p=>{p.evidenceRefs=[];},
])('malformed/bounded reference contracts still fail with the correct fusion stage %#',async mutate=>{
  const venue=place();mutate(venue);const f=fixture([venue,other()]);
  await expect(f.fusion(input,opts)).rejects.toMatchObject({code:'invalid_response',stage:'media_fusion',aiResponseReason:'media_reference'});
  expect(f.createMessage).toHaveBeenCalledTimes(1);
});
test('the strict shared validator never performs reference recovery',()=>{
  const venue=place();venue.evidenceRefs[0].evidenceId='missing';
  expect(()=>validateVideoResponse({places:[venue],observations:[]},[],evidence)).toThrow();
});
test('invalid fusion input is attributed to fusion before any provider request',async()=>{
  const f=fixture([place()]);
  await expect(f.fusion({...input,textEvidence:[{...evidence[0],extra:true}]},opts))
    .rejects.toMatchObject({code:'invalid_response',stage:'media_fusion',aiResponseReason:'media_input'});
  expect(f.createMessage).not.toHaveBeenCalled();
});
