jest.mock('../lib/firestore',()=>({firestore:require('./helpers/fakeFirestore').getSharedFirestore()}));
const {FakeFirestore,getSharedFirestore}=require('./helpers/fakeFirestore');
const {createSharedAiOperations,SERVER_PUBLIC_SCOPE}=require('../lib/sharedAiOperation');
const {createSharedAiStore,COLLECTION}=require('../lib/sharedAiStore');
const {identity}=require('../lib/sharedAiIdentity');
const {EngineError}=require('../lib/engineError');
const jobContext=require('../lib/jobContext');
const gate=()=>{let release;return {promise:new Promise(r=>{release=r;}),release:v=>release(v)};};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<500;i++){if(await fn())return;await wait(2);}throw Error('condition not reached');}
const config=extra=>({kind:'authority-correctness',input:{text:'private evidence'},scope:SERVER_PUBLIC_SCOPE,model:'stub',
  promptVersion:1,schemaVersion:1,optionsVersion:1,timeoutMs:5000,validate:v=>typeof v?.answer==='string',...extra});
const good={answer:'venue'};
const dispatch=fn=>async({sharedOperation})=>{await sharedOperation.authorizeDispatch();return fn();};
function setup(){const firestore=new FakeFirestore();firestore.strictReadOrder=true;
  return {firestore,...createSharedAiOperations({firestore,limits:{pollMs:5,subscriptionLeaseMs:90}})};}

test('publication retires old joiners before optional cache I/O; cache keys fence late writes',async()=>{
  const db=new FakeFirestore(),held=gate(),started=gate(),values=new Map();
  const cache={getCached:async key=>values.get(key)??null,setCache:async(key,value)=>{
    if(value.answer==='old'){started.release();await held.promise;}values.set(key,value);
  }};
  const operations=createSharedAiOperations({firestore:db,cache,limits:{pollMs:5}});
  const first=operations.runSharedAiOperation(config(),dispatch(()=>({answer:'old'})));
  await started.promise;
  try {
    expect(await operations.runSharedAiOperation(config({bypassCache:true}),dispatch(()=>({answer:'fresh'})))).toEqual({answer:'fresh'});
    const unexpected=jest.fn();
    // Must resolve while the old write is still held, not merely afterwards.
    expect(await operations.runSharedAiOperation(config(),unexpected)).toEqual({answer:'fresh'});
    expect(unexpected).not.toHaveBeenCalled();
    held.release();expect(await first).toEqual({answer:'old'});
    expect([...values.values()]).toEqual([{answer:'fresh'},{answer:'old'}]);
    expect([...values.keys()].map(k=>k.split(':').at(-1))).toEqual(['2','1']);
    expect(await operations.runSharedAiOperation(config(),unexpected)).toEqual({answer:'fresh'});
  }finally{held.release();await first;}
});

test.each(['job','task','account','place'])('invalidating sole %s authority during the provider wait prevents dispatch',async kind=>{
  const a=setup(),entered=gate(),held=gate(),db=getSharedFirestore(),paid=jest.fn(()=>good);
  const jobId=`job-${kind}`;let active=true;
  db.seed('enrichmentJobs',jobId,{status:'processing',workerOwner:'owner'});
  const caller=kind==='job'?{jobId,leaseOwner:'owner'}:{validateProviderDispatch:async()=>{if(!active)throw new EngineError('attempt_stopped');}};
  const result=jobContext.run(caller,()=>a.runSharedAiOperation(config(),async arg=>{
    entered.release();await held.promise;return dispatch(paid)(arg);
  })).catch(e=>e);
  await entered.promise;active=false;await db.collection('enrichmentJobs').doc(jobId).delete();held.release();
  expect(await result).toMatchObject({code:'attempt_stopped'});expect(paid).not.toHaveBeenCalled();
  expect(a.firestore.read(COLLECTION,identity(config()).key+'_1').dispatch).toBeNull();
});

test.each([false,true])('valid follower survives initiating task invalidation (remote=%s)',async remote=>{
  const a=setup(),b=remote?createSharedAiOperations({firestore:a.firestore,limits:{pollMs:5,subscriptionLeaseMs:90}}):a;
  const entered=gate(),held=gate(),paid=jest.fn(()=>good);let initiator=true,checks=0;
  const work=async arg=>{entered.release();await held.promise;return dispatch(paid)(arg);};
  const first=jobContext.run({validateProviderDispatch:async()=>{if(!initiator)throw new EngineError('attempt_stopped');}},
    ()=>a.runSharedAiOperation(config(),work)).catch(e=>e);
  await entered.promise;
  const second=jobContext.run({validateProviderDispatch:async()=>{checks++;}},()=>b.runSharedAiOperation(config(),work));
  await until(()=>remote?b.stats.followers===1:checks>0);
  initiator=false;held.release();
  expect(await second).toEqual(good);expect(await first).toMatchObject({code:'attempt_stopped'});
  expect(paid).toHaveBeenCalledTimes(1);
});

test('remote heartbeat preceding dispatch cannot authorize a deleted task',async()=>{
  const a=setup(),b=createSharedAiOperations({firestore:a.firestore,limits:{pollMs:5,subscriptionLeaseMs:1000}});
  const entered=gate(),held=gate(),abort=new AbortController(),paid=jest.fn(()=>good);let remoteActive=true;
  const work=async arg=>{entered.release();await held.promise;return dispatch(paid)(arg);};
  const first=a.runSharedAiOperation(config({signal:abort.signal}),work).catch(e=>e);
  await entered.promise;
  const second=jobContext.run({validateProviderDispatch:async()=>{if(!remoteActive)throw new EngineError('attempt_stopped');}},
    ()=>b.runSharedAiOperation(config(),work)).catch(e=>e);
  await until(()=>Object.keys(a.firestore.read(COLLECTION,identity(config()).key+'_1').subscribers).length===2);
  abort.abort();expect(await first).toMatchObject({code:'attempt_stopped'});
  remoteActive=false;held.release();
  expect(await second).toMatchObject({code:'attempt_stopped'});expect(paid).not.toHaveBeenCalled();
});

test('authority is checked again when the dispatch commit acknowledgement was delayed',async()=>{
  const a=setup(),committed=gate(),ack=gate(),transaction=a.firestore.runTransaction.bind(a.firestore),paid=jest.fn(()=>good);
  let active=true;
  a.firestore.runTransaction=async work=>{const result=await transaction(work);if(result?.id&&Number.isFinite(result.at)){committed.release();await ack.promise;}return result;};
  const pending=jobContext.run({validateProviderDispatch:async()=>{if(!active)throw new EngineError('attempt_stopped');}},
    ()=>a.runSharedAiOperation(config(),dispatch(paid))).catch(e=>e);
  await committed.promise;active=false;ack.release();
  expect(await pending).toMatchObject({code:'attempt_stopped',retryGeneration:1});expect(paid).not.toHaveBeenCalled();
});

test.each([false,true])('repeated retry token has exactly one successor (retry fails=%s)',async fails=>{
  const a=setup(),b=createSharedAiOperations({firestore:a.firestore,limits:{pollMs:5}}),failed=jest.fn(()=>{throw new EngineError('dependency_error');});
  await expect(a.runSharedAiOperation(config(),dispatch(failed))).rejects.toMatchObject({retryGeneration:1});
  const held=gate(),started=gate(),paid=jest.fn(async()=>{started.release();await held.promise;if(fails)throw new EngineError('rate_limited');return good;});
  const opts=config({retryGeneration:1});
  const first=a.runSharedAiOperation(opts,dispatch(paid)).catch(e=>e);
  await started.promise;
  const second=b.runSharedAiOperation(opts,dispatch(paid)).catch(e=>e);held.release();
  const expected=fails?{code:'rate_limited',retryGeneration:2}:good;
  for(const result of await Promise.all([first,second]))expect(result).toMatchObject(expected);
  expect(await b.runSharedAiOperation(opts,dispatch(paid)).catch(e=>e)).toMatchObject(expected);
  expect(await a.runSharedAiOperation(config(),dispatch(paid)).catch(e=>e)).toMatchObject(expected);
  expect(paid).toHaveBeenCalledTimes(1);
  if(fails){
    expect(await a.runSharedAiOperation(config({retryGeneration:2}),dispatch(()=>good))).toEqual(good);
    expect(await a.runSharedAiOperation(opts,dispatch(paid)).catch(e=>e)).toMatchObject(expected);
    expect(paid).toHaveBeenCalledTimes(1);
  }
});

test('forged, running, successful, and other-private-user retry anchors do not authorize work',async()=>{
  const a=setup(),work=jest.fn(dispatch(()=>good));
  for(const retryGeneration of [0,-1,1.1,'1',NaN,Number.MAX_SAFE_INTEGER+1,1,20]) {
    await expect(a.runSharedAiOperation(config({retryGeneration}),work)).rejects.toBeInstanceOf(EngineError);
  }
  expect(work).not.toHaveBeenCalled();
  const held=gate(),started=gate();
  const normal=a.runSharedAiOperation(config(),dispatch(async()=>{started.release();return held.promise;}));
  await started.promise;
  await expect(a.runSharedAiOperation(config({retryGeneration:1}),work)).rejects.toMatchObject({code:'attempt_stopped'});
  held.release(good);await normal;
  await expect(a.runSharedAiOperation(config({retryGeneration:1}),work)).rejects.toMatchObject({code:'attempt_stopped'});
  await expect(a.runSharedAiOperation(config({scope:'user:alice'}),dispatch(()=>{throw new EngineError('dependency_error');}))).rejects.toMatchObject({retryGeneration:1});
  await expect(a.runSharedAiOperation(config({scope:'user:bob',retryGeneration:1}),work)).rejects.toMatchObject({code:'attempt_stopped'});
  expect(work).not.toHaveBeenCalled();
  expect(JSON.stringify([...a.firestore.collections.get(COLLECTION).values()])).not.toMatch(/private evidence|alice|bob/);
});

test('uncertain dispatched generation exposes a retry token without auto replay',async()=>{
  let now=1000;
  const db=new FakeFirestore(),store=createSharedAiStore({firestore:db,now:()=>now}),key=identity(config()).key;
  const claimed=await store.claim({key,leaseMs:10,timeoutMs:20,subscription:{id:'crashed',expiresAt:1020}});
  await store.authorizeDispatch(key,claimed.record);now=2000;
  const operations=createSharedAiOperations({firestore:db,now:()=>now}),work=jest.fn(dispatch(()=>good));
  await expect(operations.runSharedAiOperation(config(),work)).rejects.toMatchObject({retryGeneration:1});
  now+=86400000;
  await expect(operations.runSharedAiOperation(config(),work)).rejects.toMatchObject({retryGeneration:1});
  expect(work).not.toHaveBeenCalled();
  expect(await operations.runSharedAiOperation(config({retryGeneration:1}),work)).toEqual(good);
  expect(await operations.runSharedAiOperation(config({retryGeneration:1}),work)).toEqual(good);
  expect(work).toHaveBeenCalledTimes(1);
});

test('a dispatch challenge requires a fresh bounded acknowledgement, not a renewed membership lease',async()=>{
  let now=1000,validatedUntil=0;
  const db=new FakeFirestore(),store=createSharedAiStore({firestore:db,now:()=>now});
  const subscription={id:'remote',expiresAt:()=>now+1000,validatedUntil:()=>validatedUntil};
  const {record}=await store.claim({key:'freshness',leaseMs:5000,timeoutMs:5000,subscription});
  const validationId=await store.beginDispatchCheck('freshness',record);
  expect(await store.authorizeDispatch('freshness',record,{validationId})).toBeNull();
  validatedUntil=now+50;
  await store.updateSubscription('freshness',record,subscription,validationId);
  now+=51;
  // The process is live, but the earlier validated caller has expired. Even an
  // omitted challenge argument must not bypass a recorded dispatch challenge.
  expect(await store.authorizeDispatch('freshness',record)).toBeNull();
  await store.updateSubscription('freshness',record,subscription,validationId);
  expect(await store.authorizeDispatch('freshness',record,{validationId})).toBeNull();
  validatedUntil=now+50;
  await store.updateSubscription('freshness',record,subscription,validationId);
  expect(await store.authorizeDispatch('freshness',record,{validationId})).toMatchObject({id:expect.any(String)});
});
