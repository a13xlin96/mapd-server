'use strict';
// Run with a loopback Firestore emulator; provider adapters are entirely stubbed.
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const path=require('node:path');
assert.match(process.env.FIRESTORE_EMULATOR_HOST||'',/^(127\.0\.0\.1|localhost):\d+$/,'loopback emulator required');
const projectId=process.env.GCLOUD_PROJECT||'demo-mapd-shared-tests';
assert.match(projectId,/^demo-/,'live projects forbidden');
process.env.NODE_ENV='test';process.env.METADATA_SERVER_DETECTION='none';
const admin=require('firebase-admin');
const app=admin.initializeApp({projectId},`shared-tests-${randomUUID()}`),db=app.firestore();
const root=path.resolve(__dirname,'../..');
function stub(name,exports){const filename=require.resolve(path.join(root,name));require.cache[filename]={id:filename,filename,loaded:true,exports};}
stub('lib/firestore.js',{firestore:db});
stub('lib/cache.js',{redis:null});
stub('lib/engineBudget.js',{beginProviderObservation:()=>({id:'observe-only',markDispatched:async()=>{},settle:async()=>{},releaseUnsent:async()=>{}})});
const jobContext=require('../../lib/jobContext');
const {withProvider}=require('../../lib/providerRuntime');
const {createSharedAiOperations,SERVER_PUBLIC_SCOPE}=require('../../lib/sharedAiOperation');
const {identity}=require('../../lib/sharedAiIdentity');
const {COLLECTION,createSharedAiStore,MEDIA_CONTROL}=require('../../lib/sharedAiStore');
const {EngineError}=require('../../lib/engineError');
const gate=()=>{let release;return {promise:new Promise(r=>{release=r;}),release:v=>release(v)};};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<500;i++){if(await fn())return;await wait(10);}throw Error('condition not reached');}
const config=()=>({kind:'shared-correctness',input:{id:randomUUID()},scope:SERVER_PUBLIC_SCOPE,model:'stub',
  promptVersion:1,schemaVersion:1,optionsVersion:1,timeoutMs:15000,validate:v=>typeof v?.answer==='string'});
const coordinator=()=>createSharedAiOperations({firestore:db,limits:{subscriptionLeaseMs:300,pollMs:10}});
const job=id=>({jobId:id,leaseOwner:'owner',deadline:Date.now()+15000});
const good={answer:'venue'};
after(async()=>{await app.delete();});

test('live media stop orders before new dispatch and never gates completed publication',{timeout:30000},async()=>{
  const control=db.collection(MEDIA_CONTROL.collection).doc(MEDIA_CONTROL.document);
  const store=createSharedAiStore({firestore:db}), key=randomUUID();
  const subscription={id:'synthetic',expiresAt:Date.now()+15000};
  try {
    await control.set({schemaVersion:1,stopNewMediaDispatch:false});
    const first=await store.claim({key,kind:'asr_chunk',subscription,leaseMs:15000,timeoutMs:15000});
    // The job/operation was admitted before the stop; admission is not dispatch.
    await control.set({schemaVersion:1,stopNewMediaDispatch:true});
    await assert.rejects(store.authorizeDispatch(key,first.record),{code:'attempt_stopped'});
    assert.equal((await store.read(key,first.record.generation)).dispatch,null);
    await control.set({schemaVersion:1,stopNewMediaDispatch:false});
    await store.authorizeDispatch(key,first.record);
    await control.set({schemaVersion:1,stopNewMediaDispatch:true});
    assert.equal(await store.publish(key,first.record,{result:good,ttlMs:1000}),true);
    const oldKey=randomUUID(),legacy=await store.claim({key:oldKey,subscription,leaseMs:15000,timeoutMs:15000});
    assert.ok((await store.authorizeDispatch(oldKey,legacy.record)).id);
  } finally {await control.delete();}
});

for(const demand of ['deleted-sole-job','valid-remote-follower','deleted-remote-follower']){
  test(`provider capacity wait revalidates ${demand}`,{timeout:30000},async()=>{
    const options=config(),a=coordinator(),b=coordinator(),held=gate(),abort=new AbortController();
    const firstId=randomUUID(),secondId=randomUUID(),firstRef=db.collection('enrichmentJobs').doc(firstId),secondRef=db.collection('enrichmentJobs').doc(secondId);
    await firstRef.set({status:'processing',workerOwner:'owner'});await secondRef.set({status:'processing',workerOwner:'owner'});
    let occupied=0,calls=0;
    const blockers=Array.from({length:4},()=>withProvider('anthropic',async()=>{occupied++;await held.promise;},4));
    let first,second;
    try{
      await until(()=>occupied===4);
      const work=()=>withProvider('anthropic',async()=>{calls++;return good;},4);
      first=jobContext.run({...job(firstId),signal:abort.signal},()=>a.runSharedAiOperation(options,work)).catch(e=>e);
      await until(async()=>{const row=(await db.collection(COLLECTION).doc(identity(options).key+'_1').get()).data();return row?.state==='running'&&!row.dispatch;});
      if(demand!=='deleted-sole-job'){
        second=jobContext.run(job(secondId),()=>b.runSharedAiOperation(options,work)).catch(e=>e);
        await until(async()=>Object.keys((await db.collection(COLLECTION).doc(identity(options).key+'_1').get()).data()?.subscribers||{}).length===2);
      }
      await firstRef.delete();
      if(demand==='deleted-remote-follower')await secondRef.delete();
      held.release();await Promise.all(blockers);
      assert.equal((await first).code,'attempt_stopped');
      if(second){if(demand==='valid-remote-follower')assert.deepEqual(await second,good);else assert.equal((await second).code,'attempt_stopped');}
      assert.equal(calls,demand==='valid-remote-follower'?1:0);
    }finally{held.release();abort.abort();await Promise.allSettled([...blockers,first,second]);await firstRef.delete();await secondRef.delete();}
  });
}

test('completed refresh is authoritative while the old optional cache write is held',{timeout:30000},async()=>{
  const held=gate(),started=gate(),values=new Map(),options=config();
  const a=createSharedAiOperations({firestore:db,cache:{getCached:async()=>null,setCache:async(key,value)=>{
    if(value.answer==='old'){started.release();await held.promise;}values.set(key,value);
  }}});
  const work=value=>async({sharedOperation})=>{await sharedOperation.authorizeDispatch();return {answer:value};};
  const first=a.runSharedAiOperation(options,work('old'));
  await started.promise;
  try{
    assert.deepEqual(await a.runSharedAiOperation({...options,bypassCache:true},work('fresh')),{answer:'fresh'});
    assert.deepEqual(await a.runSharedAiOperation(options,()=>{throw Error('must use head');}),{answer:'fresh'});
    held.release();assert.deepEqual(await first,{answer:'old'});
    assert.deepEqual([...values.keys()].map(k=>k.split(':').at(-1)),['2','1']);
  }finally{held.release();await first;}
});

test('concurrent/repeated anchored retries use one durable successor',{timeout:30000},async()=>{
  const options=config(),a=coordinator(),b=coordinator(),held=gate(),started=gate();let calls=0;
  const fail=async({sharedOperation})=>{await sharedOperation.authorizeDispatch();calls++;throw new EngineError('dependency_error');};
  await assert.rejects(a.runSharedAiOperation(options,fail),{retryGeneration:1});
  const work=async({sharedOperation})=>{await sharedOperation.authorizeDispatch();calls++;started.release();await held.promise;throw new EngineError('rate_limited');};
  const retry={...options,retryGeneration:1};
  const first=a.runSharedAiOperation(retry,work).catch(e=>e);await started.promise;
  const second=b.runSharedAiOperation(retry,work).catch(e=>e);held.release();
  for(const e of await Promise.all([first,second]))assert.equal(e.retryGeneration,2);
  await assert.rejects(b.runSharedAiOperation(retry,work),{retryGeneration:2});
  await assert.rejects(a.runSharedAiOperation(options,work),{retryGeneration:2});
  assert.equal(calls,2);
  await assert.rejects(a.runSharedAiOperation({...options,retryGeneration:99},work),{code:'attempt_stopped'});
  assert.equal(calls,2);
});

test('new caller after refresh cannot join old generation on a follower with delayed watch delivery',{timeout:30000},async()=>{
  const opt=config(),key=identity(opt).key,held=gate(),started=gate();
  let heldNotification=null,watching=false;
  const followerDb={runTransaction:db.runTransaction.bind(db)};
  followerDb.collection=name=>new Proxy(db.collection(name),{get(target,prop){
    if(prop==='doc')return id=>new Proxy(target.doc(id),{get(ref,member){
      if(member==='onSnapshot' && id===key+'_1')return (next,error)=>{watching=true;return ref.onSnapshot(snap=>{
        if(snap.data()?.state==='complete')heldNotification=()=>next(snap);else next(snap);
      },error);};
      const value=Reflect.get(ref,member);return typeof value==='function'?value.bind(ref):value;
    }});
    const value=Reflect.get(target,prop);return typeof value==='function'?value.bind(target):value;
  }});
  const leader=coordinator(),follower=createSharedAiOperations({firestore:followerDb,limits:{pollMs:15,subscriptionLeaseMs:300}});
  const work=value=>async({sharedOperation})=>{await sharedOperation.authorizeDispatch();return {answer:value};};
  const original=leader.runSharedAiOperation(opt,async arg=>{await arg.sharedOperation.authorizeDispatch();started.release();await held.promise;return {answer:'old'};});
  await started.promise;
  const oldFollower=follower.runSharedAiOperation(opt,()=>assert.fail('follower became paid producer'));
  await until(()=>watching);held.release();await original;await until(()=>heldNotification!==null);
  assert.deepEqual(await leader.runSharedAiOperation({...opt,bypassCache:true},work('new')),{answer:'new'});
  const newArrival=follower.runSharedAiOperation(opt,()=>assert.fail('unexpected paid replay'));
  // Ensure this caller has registered before releasing the delayed older result.
  await wait(50);heldNotification();
  assert.deepEqual(await oldFollower,{answer:'old'});
  const actual=await newArrival;
  assert.deepEqual(actual,{answer:'new'},'new caller must consult current head rather than a stale follower entry');
});
