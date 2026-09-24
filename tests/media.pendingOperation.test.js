jest.mock('../lib/firestore',()=>({firestore:require('./helpers/fakeFirestore').getSharedFirestore()}));
const {getSharedFirestore}=require('./helpers/fakeFirestore');
const {createPendingGenerationResolver,resolveEvidenceOperation}=require('../lib/media/pendingOperation');
const {sharedEvidenceOptions,SERVER_PUBLIC_SCOPE,retryOperationsForError}=require('../lib/media/transcriptionService');
const {identity}=require('../lib/sharedAiIdentity');
const {COLLECTION}=require('../lib/sharedAiStore');
const {EngineError}=require('../lib/engineError');
const jobContext=require('../lib/jobContext');
const {RECOVERY}=require('../lib/media/analysisRecovery');
const {getRetryContext}=require('../lib/retryContext');
const db=getSharedFirestore();
const base={kind:'asr_chunk',provider:'openai',model:'fixture',promptVersion:'literal',schemaVersion:1,
  optionsVersion:'fixture',input:{audioHash:'a'.repeat(64)},scope:SERVER_PUBLIC_SCOPE,waitMs:500,timeoutMs:500};
const initial=sharedEvidenceOptions(base);
const marker={kind:base.kind,retryKey:initial.retryKey,generation:null};
const pending=()=>sharedEvidenceOptions(base,{retryOperations:[marker]});
const key=identity(base).key;
const context=()=>({jobId:'retry',userId:'u',leaseOwner:'worker',deadline:Date.now()+3000});
const resolver=createPendingGenerationResolver({firestore:db});
const run=(operation=pending(),resolve=resolver)=>jobContext.run(context(),()=>resolveEvidenceOperation(operation,resolve));
function seed(state='failed') {
  db.seed('enrichmentJobs','retry',{userId:'u',url:'https://example.test/post',retryOf:'parent',retryKind:'analysis',status:'processing',workerOwner:'worker'});
  db.seed('enrichmentJobs','parent',{userId:'u',url:'https://example.test/post',status:'failed',analysisRecovery:RECOVERY,mediaRetryOperations:[marker]});
  db.seed(COLLECTION,key,{generation:2});
  db.seed(COLLECTION,`${key}_2`,{kind:base.kind,generation:2,state});
}
beforeEach(()=>{db.reset();seed();});

test.each(['failed','uncertain'])('only a durable %s generation promotes a pending marker to retry authority',async state=>{
  seed(state);const transaction=jest.spyOn(db,'runTransaction');
  try {expect(await run()).toMatchObject({retryGeneration:2});expect(transaction).not.toHaveBeenCalled();}
  finally{transaction.mockRestore();}
});
test.each(['complete','running'])('%s remains an ordinary reuse/join, without bypass or fresh-generation authority',async state=>{
  seed(state);const result=await run();expect(result.retryGeneration).toBeUndefined();expect(result.bypassCache).toBeUndefined();
});
test.each([
  ()=>{db.read('enrichmentJobs','retry').userId='someone-else';},
  ()=>{db.read('enrichmentJobs','retry').workerOwner='replacement';},
  ()=>{db.read('enrichmentJobs','retry').status='failed';},
  ()=>{delete db.read('enrichmentJobs','retry').retryOf;},
  ()=>{db.read('enrichmentJobs','parent').userId='someone-else';},
  ()=>{db.read('enrichmentJobs','parent').url='https://example.test/another';},
  ()=>{db.read('enrichmentJobs','parent').status='processing';},
  ()=>{db.read('enrichmentJobs','parent').mediaRetryOperations=[];},
  ()=>{db.read('enrichmentJobs','parent').mediaRetryOperations=[{...marker,retryKey:'b'.repeat(64)}];},
  ()=>{db.read('enrichmentJobs','parent').mediaRetryOperations=[{...marker,generation:1}];},
])('nullable marker requires a verified processing retry and persisted matching parent marker',async mutate=>{
  mutate();await expect(run()).rejects.toHaveProperty('code');
});
test.each(['missing_generation','wrong_kind','wrong_generation','bad_state'])('%s fails closed rather than authorizing work',async mode=>{
  if(mode==='missing_generation')await db.collection(COLLECTION).doc(`${key}_2`).delete();
  if(mode==='wrong_kind')db.read(COLLECTION,`${key}_2`).kind='video_vision';
  if(mode==='wrong_generation')db.read(COLLECTION,`${key}_2`).generation=3;
  if(mode==='bad_state')db.read(COLLECTION,`${key}_2`).state='unknown';
  await expect(run()).rejects.toHaveProperty('code');
});
test('verified absent head uses an ordinary atomic claim, without invented retry generation',async()=>{
  await db.collection(COLLECTION).doc(key).delete();
  expect(await run()).toEqual(pending().sharedOptions);
  db.read('enrichmentJobs','parent').userId='someone-else';
  await expect(run()).rejects.toHaveProperty('code','access_blocked');
});
test.each([undefined,'places','analysis'])('explicit failed-media Retry kind %s resolves its immediate pending marker',async kind=>{
  if(kind===undefined)delete db.read('enrichmentJobs','retry').retryKind;
  else db.read('enrichmentJobs','retry').retryKind=kind;
  const retry=await getRetryContext(db,'retry','u','https://example.test/post');
  expect(retry.mediaRetryOperations).toEqual([marker]);
  expect(retry.resumePlaces).toBeUndefined();
  expect(await run(sharedEvidenceOptions(base,{retryOperations:retry.mediaRetryOperations}))).toMatchObject({retryGeneration:2});
});
test('ordinary calls, known generations and nonmatching pending keys never consult reconciliation',async()=>{
  const resolve=jest.fn();
  await run(initial,resolve);
  await run(sharedEvidenceOptions(base,{retryOperations:[{...marker,generation:1}]}),resolve);
  await run(sharedEvidenceOptions({...base,input:{audioHash:'b'.repeat(64)}},{retryOperations:[marker]}),resolve);
  await run(sharedEvidenceOptions({...base,scope:'user:u'},{retryOperations:[marker]}),resolve);
  expect(resolve).not.toHaveBeenCalled();
});
test('reconciliation receives only bounded identities, never raw audio/text or authority from nullable marker',async()=>{
  const resolve=jest.fn(async()=>({state:'uncertain',generation:2}));
  const result=await run(pending(),resolve);
  expect(resolve).toHaveBeenCalledWith({kind:base.kind,retryKey:marker.retryKey,operationKey:key});
  expect(result.retryGeneration).toBe(2);
});
test('unavailable or slow read preserves a nullable marker but grants no generation',async()=>{
  const operation=sharedEvidenceOptions({...base,waitMs:10},{retryOperations:[marker]});
  let error;try{await run(operation,async()=>new Promise(()=>{}));}catch(e){error=e;}
  expect(error).toMatchObject({code:'dependency_timeout'});
  expect(retryOperationsForError(error,base.kind,marker.retryKey)).toEqual([marker]);
});
test('cancellation during reconciliation cannot consume late failed-generation authority',async()=>{
  const signal=new AbortController();let resolveRead;
  const held=new Promise(r=>{resolveRead=r;});let entered;
  const started=new Promise(r=>{entered=r;});
  const operation=sharedEvidenceOptions({...base,signal:signal.signal},{retryOperations:[marker]});
  const reading=run(operation,async()=>{entered();return held;}).catch(e=>e);
  await started;signal.abort();resolveRead({state:'failed',generation:2});
  expect(await reading).toMatchObject({code:'attempt_stopped'});
});
test('pending records are bounded and conflicting generation authority is rejected',()=>{
  expect(()=>sharedEvidenceOptions(base,{retryOperations:Array(33).fill(marker)})).toThrow();
  for(const generation of [undefined,0,-1,'2',1.2])expect(()=>sharedEvidenceOptions(base,{retryOperations:[{...marker,generation}]})).toThrow();
  expect(()=>sharedEvidenceOptions(base,{retryOperations:[marker,{...marker,generation:1}]})).toThrow();
  expect(retryOperationsForError(new EngineError('invalid_response'),base.kind,marker.retryKey)).toEqual([]);
});

// A real recovery can sit behind failed explicit-analysis admission receipts.
// Compare selection with the production coordinator's independently owned walk.
function admissionChain(count=1) {
  let retryOf='parent';
  for(let i=0;i<count;i++) {
    const id=`admission-${i}`;
    db.seed('enrichmentJobs',id,{userId:'u',url:'https://example.test/post',status:'failed',retryKind:'analysis',retryOf});
    retryOf=id;
  }
  db.read('enrichmentJobs','retry').retryOf=retryOf;
  return db.read('enrichmentJobs',retryOf);
}
test.each([1,7])('matches retryContext through %s admission failures without modifying any receipts',async count=>{
  admissionChain(count);
  const transaction=jest.spyOn(db,'runTransaction');
  try {
    const retry=await getRetryContext(db,'retry','u','https://example.test/post');
    expect(retry.mediaRetryOperations).toEqual([marker]);
    expect(await run(sharedEvidenceOptions(base,{retryOperations:retry.mediaRetryOperations}))).toMatchObject({retryGeneration:2});
    expect(transaction).not.toHaveBeenCalled();
  } finally {transaction.mockRestore();}
});
test.each([undefined,'places'])('non-analysis retry %s cannot walk beyond its immediate admission parent',async kind=>{
  admissionChain();db.read('enrichmentJobs','retry').retryKind=kind;
  expect((await getRetryContext(db,'retry','u','https://example.test/post')).mediaRetryOperations).toBeUndefined();
  await expect(run()).rejects.toHaveProperty('code','access_blocked');
});
test.each([
  ['too deep',()=>admissionChain(8)],
  ['cycle',()=>{const head=admissionChain();head.retryOf='admission-0';}],
  ['current-job cycle',()=>{admissionChain().retryOf='retry';}],
  ['wrong owner',()=>{admissionChain().userId='other';}],
  ['wrong URL',()=>{admissionChain().url='https://example.test/different';}],
  ['still running',()=>{admissionChain().status='processing';}],
  ['missing parent',()=>{admissionChain().retryOf='absent';}],
  ['path-like ID',()=>{admissionChain().retryOf='bad/id';}],
])('%s ancestry cannot recover pending authority',async(_name,mutate)=>{
  mutate();await expect(run()).rejects.toHaveProperty('code');
  await expect(getRetryContext(db,'retry','u','https://example.test/post')).rejects.toHaveProperty('code');
});
test.each([
  ['explicit null',{analysisRecovery:null}],
  ['malformed recovery',{analysisRecovery:{version:1,status:'complete'}}],
  ['completed admission',{status:'complete'}],
  ['non-analysis admission',{retryKind:'places'}],
  ['no admission parent',{retryOf:null}],
])('%s stops traversal rather than resurrecting older recovery',async(_name,update)=>{
  Object.assign(admissionChain(),update);
  await expect(run()).rejects.toHaveProperty('code');
  await expect(getRetryContext(db,'retry','u','https://example.test/post')).rejects.toHaveProperty('code');
});
test('newest valid recovery is authoritative even when only an older recovery has the requested marker',async()=>{
  Object.assign(admissionChain(),{analysisRecovery:RECOVERY,mediaRetryOperations:[]});
  const retry=await getRetryContext(db,'retry','u','https://example.test/post');
  expect(retry.mediaRetryOperations).toEqual([]);
  await expect(run()).rejects.toHaveProperty('code','access_blocked');
});
test('a new matching recovery succeeds without reading an older invalid owner',async()=>{
  Object.assign(admissionChain(),{analysisRecovery:RECOVERY,mediaRetryOperations:[marker]});
  db.read('enrichmentJobs','parent').userId='someone-else';
  const retry=await getRetryContext(db,'retry','u','https://example.test/post');
  expect(retry.mediaRetryOperations).toEqual([marker]);
  expect(await run()).toMatchObject({retryGeneration:2});
});
