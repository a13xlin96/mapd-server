jest.mock('../lib/cache', () => ({redis:null}));
jest.mock('../lib/firestore', () => ({firestore:null}));
jest.mock('../lib/engineBudget', () => ({beginProviderObservation:jest.fn()}));
const {FakeFirestore} = require('./helpers/fakeFirestore');
const job = require('../lib/jobContext');
const {createSharedAiOperations,SERVER_PUBLIC_SCOPE} = require('../lib/sharedAiOperation');
const {COLLECTION,MEDIA_CONTROL} = require('../lib/sharedAiStore');
const {identity} = require('../lib/sharedAiIdentity');
const {withProvider} = require('../lib/providerRuntime');
const {beginProviderObservation} = require('../lib/engineBudget');
const gate = () => {let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve};};
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
let spend;
beforeEach(()=>{
  spend={id:'synthetic-observation',markDispatched:jest.fn(),settle:jest.fn(),releaseUnsent:jest.fn()};
  beginProviderObservation.mockReturnValue(spend);
});
function setup(kind='asr_chunk') {
  const db=new FakeFirestore();db.strictReadOrder=true;
  const operations=createSharedAiOperations({firestore:db,limits:{pollMs:5,subscriptionLeaseMs:1000}});
  const cfg={kind,scope:SERVER_PUBLIC_SCOPE,input:{digest:'a'.repeat(64)},model:'synthetic',
    promptVersion:1,schemaVersion:1,optionsVersion:1,timeoutMs:3000,validate:r=>r?.ok===true};
  const record=()=>db.read(COLLECTION,identity(cfg).key+'_1');
  const stop=value=>db.seed(MEDIA_CONTROL.collection,MEDIA_CONTROL.document,{schemaVersion:1,stopNewMediaDispatch:value});
  return {db,operations,cfg,record,stop};
}
// Insert the race after the real transactional marker has committed.
function afterAuthorization(sharedOperation, callback) {
  const authorize=sharedOperation.authorizeDispatch.bind(sharedOperation);
  sharedOperation.authorizeDispatch=async args=>{
    const marker=await authorize(args);await callback();return marker;
  };
}
// Only the last read uses this override; install it after transactional auth.
function controlRead(db, read) {
  const collection=db.collection.bind(db);
  db.collection=name=>{
    const result=collection(name);
    if(name===MEDIA_CONTROL.collection) {
      const doc=result.doc.bind(result);
      result.doc=id=>{const ref=doc(id);if(id===MEDIA_CONTROL.document)ref.get=read;return ref;};
    }
    return result;
  };
}

test.each(['asr_chunk','video_vision','media_fusion'])('late stop fences unsent %s and never automatically resends',async kind=>{
  const {operations,cfg,record,stop}=setup(kind), paid=jest.fn(async()=>({ok:true}));
  const provider=kind==='asr_chunk'?'openai':'anthropic';
  const stage=kind==='asr_chunk'?'transcription':kind;
  await expect(operations.runSharedAiOperation(cfg,async({sharedOperation})=>{
    afterAuthorization(sharedOperation,()=>stop(true));
    return withProvider(provider,paid,1,{stage});
  })).rejects.toMatchObject({code:'attempt_stopped',retryGeneration:1});
  expect(paid).not.toHaveBeenCalled();
  expect(record()).toMatchObject({state:'failed',dispatch:{id:expect.any(String)},failure:{code:'attempt_stopped'}});
  expect(spend.releaseUnsent).toHaveBeenCalledTimes(1);
  expect(spend.markDispatched).not.toHaveBeenCalled();expect(spend.settle).not.toHaveBeenCalled();
  stop(false);
  const work=()=>withProvider(provider,paid,1,{stage});
  await expect(operations.runSharedAiOperation(cfg,work)).rejects.toMatchObject({code:'attempt_stopped',retryGeneration:1});
  expect(paid).not.toHaveBeenCalled();
  expect(await operations.runSharedAiOperation({...cfg,retryGeneration:1},work)).toEqual({ok:true});
  expect(paid).toHaveBeenCalledTimes(1);
});

test.each(['reject','hang'])('a %s in the last read is bounded and retains the known committed authorization',async fault=>{
  const {db,operations,cfg,record}=setup(), late=gate(), paid=jest.fn(async()=>({ok:true}));
  const read=jest.fn(()=>fault==='reject'?Promise.reject(new Error('offline')):late.promise);
  const began=Date.now();
  expect(await operations.runSharedAiOperation(cfg,async({sharedOperation})=>{
    afterAuthorization(sharedOperation,()=>controlRead(db,read));
    return withProvider('openai',paid);
  })).toEqual({ok:true});
  expect(Date.now()-began).toBeLessThan(1500);
  expect(read).toHaveBeenCalledTimes(1);expect(paid).toHaveBeenCalledTimes(1);
  expect(record()).toMatchObject({state:'complete',dispatch:{id:expect.any(String)}});
  // A late stop response cannot revoke a call/result already sent/published.
  late.resolve({data:()=>({schemaVersion:1,stopNewMediaDispatch:true})});await wait(5);
  expect(record().state).toBe('complete');expect(spend.markDispatched).toHaveBeenCalledTimes(1);
});

test('cancellation during the last read prevents a send despite committed authorization',async()=>{
  const {db,operations,cfg,record}=setup(), reading=gate(), release=gate(), cancel=new AbortController();
  const paid=jest.fn(async()=>({ok:true}));
  const pending=job.run({deadline:Date.now()+2000,signal:cancel.signal},()=>operations.runSharedAiOperation(cfg,async({sharedOperation})=>{
    afterAuthorization(sharedOperation,()=>controlRead(db,()=>{reading.resolve();return release.promise;}));
    return withProvider('openai',paid);
  })).catch(error=>error);
  await reading.promise;cancel.abort();
  expect(await pending).toMatchObject({code:'attempt_stopped'});
  release.resolve({data:()=>undefined});await wait(20);
  expect(paid).not.toHaveBeenCalled();expect(record()).toMatchObject({state:'failed',dispatch:{id:expect.any(String)}});
});

test('initiating caller cancellation during recheck preserves a live remote subscriber',async()=>{
  const {db,operations,cfg,record}=setup();
  const remote=createSharedAiOperations({firestore:db,limits:{pollMs:5,subscriptionLeaseMs:60}});
  const entered=gate(), authorize=gate(), reading=gate(), release=gate(), cancel=new AbortController();
  const paid=jest.fn(async()=>({ok:true}));
  const work=async({sharedOperation})=>{
    entered.resolve();await authorize.promise;
    afterAuthorization(sharedOperation,()=>controlRead(db,()=>{reading.resolve();return release.promise;}));
    return withProvider('openai',paid);
  };
  const first=job.run({deadline:Date.now()+2000,signal:cancel.signal,validateProviderDispatch:async()=>{
    // Give the independent follower time to answer the new dispatch challenge;
    // merely registering a pre-challenge heartbeat grants no send authority.
    if(record()?.dispatchCheck && !record().dispatch) {
      while(!Object.keys(record().subscriberValidations || {}).length)await wait(5);
    }
  }},()=>operations.runSharedAiOperation(cfg,work)).catch(error=>error);
  await entered.promise;
  const second=job.run({deadline:Date.now()+2500},()=>remote.runSharedAiOperation(cfg,work));
  // The remote follower must be registered before the authorization challenge.
  while(Object.keys(record().subscribers).length<2)await wait(5);
  authorize.resolve();await reading.promise;cancel.abort();
  expect(await first).toMatchObject({code:'attempt_stopped'});
  release.resolve({data:()=>undefined});
  expect(await second).toEqual({ok:true});expect(paid).toHaveBeenCalledTimes(1);
  expect(record().state).toBe('complete');
});

test('the last check does not read control for nonmedia or gate already sent result publication',async()=>{
  const {db,operations,cfg,record,stop}=setup('caption'), read=jest.fn(()=>{throw new Error('must not read');});
  stop(true);controlRead(db,read);
  expect(await operations.runSharedAiOperation(cfg,()=>withProvider('anthropic',async()=>({ok:true})))).toEqual({ok:true});
  expect(read).not.toHaveBeenCalled();expect(record().state).toBe('complete');
  const media=setup();
  expect(await media.operations.runSharedAiOperation(media.cfg,()=>withProvider('openai',async()=>{
    media.stop(true);return {ok:true};
  }))).toEqual({ok:true});
  expect(media.record().state).toBe('complete');
});

test('production cannot replace durable authority with the local fallback',async()=>{
  const previous=process.env.NODE_ENV;process.env.NODE_ENV='production';
  try {
    const operations=createSharedAiOperations({allowLocal:true}), paid=jest.fn();
    await expect(operations.runSharedAiOperation(setup().cfg,paid)).rejects.toMatchObject({code:'dependency_error',provider:'firestore'});
    expect(paid).not.toHaveBeenCalled();
  } finally {process.env.NODE_ENV=previous;}
});
