jest.mock('../lib/cache', () => ({redis:null}));
jest.mock('../lib/firestore', () => ({firestore:require('./helpers/fakeFirestore').getSharedFirestore()}));
const {FakeFirestore,getSharedFirestore} = require('./helpers/fakeFirestore');
const job = require('../lib/jobContext');
const {createMediaContext,withMediaContext} = require('../lib/media/mediaContext');
const {createSharedAiOperations,SERVER_PUBLIC_SCOPE} = require('../lib/sharedAiOperation');
const {createSharedAiStore,COLLECTION,MEDIA_CONTROL} = require('../lib/sharedAiStore');
const {withProvider,withLease} = require('../lib/providerRuntime');
const {identity} = require('../lib/sharedAiIdentity');
const gate = () => {let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve};};
const wait = ms => new Promise(r=>setTimeout(r,ms));
const options = kind => ({kind,scope:SERVER_PUBLIC_SCOPE,input:{digest:'a'.repeat(64)},model:'synthetic',
  promptVersion:1,schemaVersion:1,optionsVersion:1,timeoutMs:1000,validate:r=>r?.ok===true});
const setup = () => {const db=new FakeFirestore();db.strictReadOrder=true;
  return {db,operations:createSharedAiOperations({firestore:db,limits:{pollMs:5,subscriptionLeaseMs:60}})};};

test('child preserves parent lease checks and deadline; expiry/disposal never aborts parent save authority',async()=>{
  const controller = new AbortController(), parent={jobId:'media-parent',leaseOwner:'owner',
    signal:controller.signal,deadline:Date.now()+5000};
  const db=getSharedFirestore();db.seed('enrichmentJobs',parent.jobId,{status:'processing',workerOwner:'owner'});
  const scope=createMediaContext(parent,{reserveMs:1000,maxDurationMs:30});
  expect(scope.context).toMatchObject({jobId:parent.jobId,leaseOwner:'owner'});
  expect(scope.context.deadline).toBeLessThan(parent.deadline-1000);
  await scope.run(()=>job.assertActive());
  await wait(40);
  await expect(scope.run(()=>job.assertActive())).rejects.toMatchObject({code:'attempt_stopped'});
  scope.dispose();expect(parent.signal.aborted).toBe(false);
  await job.run(parent,()=>job.assertActive());
  const fresh=createMediaContext(parent,{reserveMs:1000});
  await db.collection('enrichmentJobs').doc(parent.jobId).update({workerOwner:'replacement'});
  await expect(fresh.run(()=>job.assertActive())).rejects.toMatchObject({code:'attempt_stopped'});
  fresh.dispose();
});

test('wrapper disposes on rejection, forwards parent cancellation, and honors shorter configured deadline',async()=>{
  const parent={deadline:Date.now()+120000,signal:new AbortController().signal};
  let child;
  await expect(withMediaContext(async ctx=>{child=ctx;throw new Error('failed');},{parent,maxDurationMs:1000,reserveMs:30000})).rejects.toThrow('failed');
  expect(child.signal.aborted).toBe(true);expect(parent.signal.aborted).toBe(false);
  const cancel=new AbortController(), scope=createMediaContext({...parent,signal:cancel.signal},{deadline:Date.now()+500});
  cancel.abort();expect(scope.context.signal.aborted).toBe(true);scope.dispose();
});

test.each(['asr_chunk','video_vision','media_fusion'])('stop blocks new %s dispatch marker, not completed results',async kind=>{
  const {db,operations}=setup(), cfg=options(kind), work=jest.fn(async ({sharedOperation})=>{
    await sharedOperation.authorizeDispatch();return {ok:true};
  });
  db.seed(MEDIA_CONTROL.collection,MEDIA_CONTROL.document,{schemaVersion:1,stopNewMediaDispatch:true});
  await expect(operations.runSharedAiOperation(cfg,work)).rejects.toMatchObject({code:'attempt_stopped'});
  expect(db.read(COLLECTION,identity(cfg).key+'_1').dispatch).toBeNull();
  db.seed(MEDIA_CONTROL.collection,MEDIA_CONTROL.document,{schemaVersion:1,stopNewMediaDispatch:false});
  expect(await operations.runSharedAiOperation({...cfg,retryGeneration:1},work)).toEqual({ok:true});
  db.seed(MEDIA_CONTROL.collection,MEDIA_CONTROL.document,{schemaVersion:1,stopNewMediaDispatch:true});
  const unused=jest.fn();
  expect(await operations.runSharedAiOperation(cfg,unused)).toEqual({ok:true});expect(unused).not.toHaveBeenCalled();
});

test('stop is read in the dispatch transaction; later stop cannot retract marker or prevent publication',async()=>{
  const {db}=setup(), store=createSharedAiStore({firestore:db});
  const {record}=await store.claim({key:'ordered',kind:'asr_chunk',timeoutMs:1000,leaseMs:1000,
    subscription:{id:'subscriber',expiresAt:Date.now()+1000}});
  expect(await store.authorizeDispatch('ordered',record)).toHaveProperty('id');
  db.seed(MEDIA_CONTROL.collection,MEDIA_CONTROL.document,{schemaVersion:1,stopNewMediaDispatch:true});
  expect(await store.publish('ordered',record,{result:{ok:true},ttlMs:1000})).toBe(true);
  expect(db.read(COLLECTION,'ordered_1').state).toBe('complete');
  const legacy=await store.claim({key:'legacy',timeoutMs:1000,leaseMs:1000,
    subscription:{id:'subscriber',expiresAt:Date.now()+1000}});
  expect(await store.authorizeDispatch('legacy',legacy.record)).toHaveProperty('id');
});

test.each([{schemaVersion:1},{schemaVersion:2,stopNewMediaDispatch:false},{schemaVersion:1,stopNewMediaDispatch:'false'}])(
  'malformed live stop fails closed only for media: %j',async value=>{
    const {db,operations}=setup();db.seed(MEDIA_CONTROL.collection,MEDIA_CONTROL.document,value);
    const invoke=kind=>operations.runSharedAiOperation(options(kind),async({sharedOperation})=>{
      await sharedOperation.authorizeDispatch();return {ok:true};
    });
    await expect(invoke('asr_chunk')).rejects.toMatchObject({code:'attempt_stopped'});
    expect(await invoke('old-text')).toEqual({ok:true});
  });

test('capacity wait expires media without a physical call or aborting parent',async()=>{
  const {operations}=setup(), occupied=gate(), entered=gate(), paid=jest.fn(async()=>({ok:true}));
  const held=withLease('provider:openai',async()=>{entered.resolve();await occupied.promise;});
  await entered.promise;
  const parent={deadline:Date.now()+5000}, scope=createMediaContext(parent,{maxDurationMs:40,reserveMs:1000});
  const pending=scope.run(()=>operations.runSharedAiOperation(options('asr_chunk'),()=>withProvider('openai',paid))).catch(e=>e);
  await wait(70);occupied.resolve();await held;
  expect(await pending).toHaveProperty('code');scope.dispose();
  await wait(220);expect(paid).not.toHaveBeenCalled();await job.run(parent,()=>job.assertActive());
});

test('physical media deadline uses live subscriber cutoff, not short heartbeat lease or initiating caller',async()=>{
  const {db,operations}=setup(), remote=createSharedAiOperations({firestore:db,limits:{pollMs:5,subscriptionLeaseMs:50}});
  const entered=gate(), release=gate(), cancel=new AbortController();let actualDeadline;
  const work=async({sharedOperation})=>{entered.resolve();await release.promise;
    await sharedOperation.authorizeDispatch();actualDeadline=job.current().deadline;await wait(100);return {ok:true};};
  const first=createMediaContext({deadline:Date.now()+5000,signal:cancel.signal},{maxDurationMs:150,reserveMs:1000});
  const second=createMediaContext({deadline:Date.now()+5000},{maxDurationMs:800,reserveMs:1000});
  const one=first.run(()=>operations.runSharedAiOperation(options('asr_chunk'),work)).catch(e=>e);
  await entered.promise;
  const two=second.run(()=>remote.runSharedAiOperation(options('asr_chunk'),work));
  await wait(20);cancel.abort();release.resolve();
  expect(await two).toEqual({ok:true});expect(await one).toMatchObject({code:'attempt_stopped'});
  expect(actualDeadline).toBeGreaterThan(Date.now()+100);
  expect(actualDeadline).toBeLessThanOrEqual(second.context.deadline);
  first.dispose();second.dispose();
});

test('OpenAI wrapper refuses unfenced paid media even without a live-stop datastore',async()=>{
  const paid=jest.fn();await expect(withProvider('openai',paid)).rejects.toMatchObject({code:'attempt_stopped'});
  expect(paid).not.toHaveBeenCalled();
});
