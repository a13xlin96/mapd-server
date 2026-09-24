const {FakeFirestore} = require('./helpers/fakeFirestore');
const {createSharedAiOperations,SERVER_PUBLIC_SCOPE} = require('../lib/sharedAiOperation');
const {identity} = require('../lib/sharedAiIdentity');
const {createSharedAiStore,COLLECTION} = require('../lib/sharedAiStore');
const jobContext = require('../lib/jobContext');
const {EngineError} = require('../lib/engineError');
const wait = ms => new Promise(r=>setTimeout(r,ms));
const gate = () => {let resolve;return {promise:new Promise(r=>{resolve=r;}),release:value=>resolve(value)};};
const config = extra => ({kind:'test-ai', input:{text:'private evidence'}, scope:'user:alice', model:'model-a',promptVersion:'1',schemaVersion:1,optionsVersion:'1',validate:v=>typeof v?.answer==='string',...extra});
const good = {answer:'venue'};
function setup(extra={}) {
  const firestore=new FakeFirestore();
  const cache={getCached:jest.fn(async()=>null),setCache:jest.fn(async()=>{})};
  const coordinator=createSharedAiOperations({firestore,cache,limits:{pollMs:5},...extra});
  return {firestore,cache,...coordinator};
}
async function until(fn) {for(let i=0;i<200 && !fn();i++) await wait(2);expect(fn()).toBeTruthy();}
const dispatchWork = fn => async ({sharedOperation}) => {await sharedOperation.authorizeDispatch({reservationId:'observation-only'});return fn ? fn() : good;};

test('three same-process callers and a second coordinator dispatch once; durable warm read adds zero calls',async()=>{
  const a=setup(), b=createSharedAiOperations({firestore:a.firestore,cache:a.cache,limits:{pollMs:5}});
  const hold=gate(), work=jest.fn(dispatchWork(()=>hold.promise));
  const pending=[a.runSharedAiOperation(config(),work),a.runSharedAiOperation(config(),work),a.runSharedAiOperation(config(),work),b.runSharedAiOperation(config(),work)];
  await until(()=>work.mock.calls.length===1);
  hold.release(good);
  expect(await Promise.all(pending)).toEqual([good,good,good,good]);
  expect(await b.runSharedAiOperation(config(),work)).toEqual(good);
  expect(work).toHaveBeenCalledTimes(1);
  const records=[...a.firestore.collections.get(COLLECTION).values()];
  expect(JSON.stringify(records)).not.toContain('private evidence');
  expect(JSON.stringify(records)).not.toContain('alice');
  expect(records.find(r=>r.dispatch)?.dispatch.reservationId).toBe('observation-only');
});
test('full evidence, private user, model, kind and versions are independent identities',async()=>{
  const {runSharedAiOperation}=setup();
  const variants=[{}, {scope:'user:bob'}, {input:{text:'different'}}, {model:'model-b'}, {kind:'verification'}, {schemaVersion:2}, {optionsVersion:'2'}, {promptVersion:'2'}];
  const work=jest.fn(dispatchWork());
  await Promise.all(variants.map(v=>runSharedAiOperation(config(v),work)));
  expect(work).toHaveBeenCalledTimes(variants.length);
  expect(identity(config({input:{a:1,b:2}})).key).toBe(identity(config({input:{b:2,a:1}})).key);
});
test('public sharing requires server capability; missing/plain-public scopes isolate requests',async()=>{
  const {runSharedAiOperation}=setup();
  const work=jest.fn(dispatchWork());
  await Promise.all([1,2,3].map(()=>runSharedAiOperation(config({scope:SERVER_PUBLIC_SCOPE}),work)));
  expect(work).toHaveBeenCalledTimes(1);
  await Promise.all([undefined,undefined,'public','public'].map(scope=>runSharedAiOperation(config({scope}),work)));
  expect(work).toHaveBeenCalledTimes(5);
});
test('caller cancellation does not cancel shared work or retain first task authority',async()=>{
  const {runSharedAiOperation}=setup(), abort=new AbortController(), hold=gate();
  let context;
  const work=jest.fn(async ({sharedOperation})=>{context=jobContext.current();await sharedOperation.authorizeDispatch();return hold.promise;});
  const first=jobContext.run({userId:'alice',jobId:'first-job',beforeProviderDispatch:()=>{throw Error('obsolete task');},signal:abort.signal,deadline:Date.now()+10000},()=>runSharedAiOperation(config(),work));
  const rejected=expect(first).rejects.toMatchObject({code:'attempt_stopped'});
  const second=runSharedAiOperation(config(),work);
  await until(()=>!!context);
  abort.abort();
  await rejected;
  expect(context).toMatchObject({userId:'alice',originatingJobId:'first-job'});
  expect(context.leaseOwner).toBeUndefined();
  expect(context.beforeProviderDispatch).toBeUndefined();
  expect(context.signal.aborted).toBe(false);
  hold.release(good);
  expect(await second).toEqual(good);
  expect(work).toHaveBeenCalledTimes(1);
});
test('each caller checks cancellation before joining and after receiving a result',async()=>{
  const {runSharedAiOperation}=setup(), abort=new AbortController(), work=jest.fn(dispatchWork());
  abort.abort();
  await expect(runSharedAiOperation(config({signal:abort.signal}),work)).rejects.toMatchObject({code:'attempt_stopped'});
  expect(work).not.toHaveBeenCalled();
  const hold=gate();
  let expired=false;
  const spy=jest.spyOn(jobContext,'assertActive').mockImplementation(async()=>{if(expired) throw new EngineError('attempt_stopped');});
  const pending=runSharedAiOperation(config(),dispatchWork(()=>hold.promise));
  await wait(10);expired=true;hold.release(good);
  await expect(pending).rejects.toMatchObject({code:'attempt_stopped'});
  spy.mockRestore();
});
test('caller wait timeout leaves operation available to another subscriber',async()=>{
  const {runSharedAiOperation}=setup(), hold=gate();
  const work=jest.fn(dispatchWork(()=>hold.promise));
  const first=runSharedAiOperation(config({waitMs:5}),work);
  const second=runSharedAiOperation(config(),work);
  await expect(first).rejects.toMatchObject({code:'dependency_timeout'});
  hold.release(good);expect(await second).toEqual(good);
  expect(work).toHaveBeenCalledTimes(1);
});
test('expired pre-dispatch leader is fenced from dispatch and publication after replacement',async()=>{
  let now=1000;
  const a=setup({now:()=>now}), b=createSharedAiOperations({firestore:a.firestore,now:()=>now,limits:{pollMs:5}}), hold=gate();
  const sends=[];
  const first=a.runSharedAiOperation(config({leaseMs:10}),async({sharedOperation})=>{await hold.promise;await sharedOperation.authorizeDispatch();sends.push('a');return good;});
  const rejected=expect(first).rejects.toMatchObject({code:'attempt_stopped'});
  await until(()=>a.stats.leaders===1);
  now+=11;
  expect(await b.runSharedAiOperation(config(),dispatchWork(()=>{sends.push('b');return good;}))).toEqual(good);
  hold.release();await rejected;
  expect(sends).toEqual(['b']);
});
test('crash after dispatch remains uncertain across new callers, refresh explicitly creates a new generation',async()=>{
  let now=1000;
  const {firestore,runSharedAiOperation}=setup({now:()=>now});
  const store=createSharedAiStore({firestore,now:()=>now}), key=identity(config()).key;
  const claim=await store.claim({key,refresh:false,leaseMs:10,timeoutMs:20,subscription:{id:'crashed-process',expiresAt:now+20}});
  await store.authorizeDispatch(key,claim.record,{reservationId:'before-crash'});
  now+=21;
  const work=jest.fn(dispatchWork());
  await expect(runSharedAiOperation(config(),work)).rejects.toMatchObject({code:'dependency_timeout'});
  await expect(runSharedAiOperation(config(),work)).rejects.toMatchObject({code:'dependency_timeout'});
  expect(work).not.toHaveBeenCalled();
  expect(await runSharedAiOperation(config({bypassCache:true}),work)).toEqual(good);
  expect(firestore.read(COLLECTION,key).generation).toBe(2);
});
test('duplicate dispatch authorization cannot authorize another physical call',async()=>{
  const {runSharedAiOperation}=setup();
  await expect(runSharedAiOperation(config(),async ({sharedOperation})=>{
    await sharedOperation.authorizeDispatch({reservationId:'r'});
    await sharedOperation.authorizeDispatch({reservationId:'r'});
    return good;
  })).rejects.toMatchObject({code:'attempt_stopped'});
});
test('late results after execution deadline cannot become cached success',async()=>{
  jest.useFakeTimers({now:1000000});
  const hold=gate();
  try {
    const {runSharedAiOperation,cache,activeCount,firestore}=setup();
    const work=jest.fn(dispatchWork(()=>hold.promise));
    const outcome=runSharedAiOperation(config({timeoutMs:15}),work)
      .then(result=>({result}),error=>({error}));
    await jest.advanceTimersByTimeAsync(0);
    // Expire only after dispatch authorization; a busy real runner can use up
    // 15ms before dispatch, which correctly produces 'failed', not 'uncertain'.
    const key=identity(config()).key+'_1';
    expect(firestore.read(COLLECTION,key).dispatch).toBeDefined();
    expect(work).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(15);
    expect((await outcome).error).toMatchObject({code:'dependency_timeout'});
    hold.release(good);await jest.advanceTimersByTimeAsync(10);
    expect(cache.setCache).not.toHaveBeenCalled();
    expect(activeCount()).toBe(0);
    expect(firestore.read(COLLECTION,key).state).toBe('uncertain');
  } finally {
    hold.release(good);await jest.advanceTimersByTimeAsync(0);jest.useRealTimers();
  }
});
test('malformed results and provider failures stay typed and require explicit refresh',async()=>{
  for(const response of [{answer:42},new EngineError('rate_limited',{retryAfterSeconds:20})]) {
    const {runSharedAiOperation,cache}=setup();
    const work=jest.fn(dispatchWork(()=>{if(response instanceof Error) throw response;return response;}));
    const code=response instanceof Error ? 'rate_limited':'invalid_response';
    await expect(runSharedAiOperation(config(),work)).rejects.toMatchObject({code});
    await expect(runSharedAiOperation(config(),work)).rejects.toMatchObject({code});
    expect(work).toHaveBeenCalledTimes(1);expect(cache.setCache).not.toHaveBeenCalled();
  }
});
test('simultaneous refreshes coalesce and never consume warm normal cache',async()=>{
  const a=setup(), b=createSharedAiOperations({firestore:a.firestore,cache:a.cache,limits:{pollMs:5}});
  await a.runSharedAiOperation(config(),dispatchWork());
  a.cache.getCached.mockResolvedValue({answer:'stale'});
  a.cache.getCached.mockClear();
  const hold=gate(), work=jest.fn(dispatchWork(()=>hold.promise));
  const one=a.runSharedAiOperation(config({bypassCache:true}),work), two=b.runSharedAiOperation(config({bypassCache:true}),work);
  await until(()=>work.mock.calls.length===1 && b.stats.followers===1);
  hold.release({answer:'fresh'});
  expect(await Promise.all([one,two])).toEqual([{answer:'fresh'},{answer:'fresh'}]);
  expect(work).toHaveBeenCalledTimes(1);
  expect(a.cache.getCached).not.toHaveBeenCalled();
  expect(await b.runSharedAiOperation(config(),work)).toEqual({answer:'fresh'});
});
test('refresh behind an active normal generation waits then produces its own fresh generation',async()=>{
  const {runSharedAiOperation,stats}=setup(), hold=gate();
  const normal=runSharedAiOperation(config(),dispatchWork(()=>hold.promise));
  await until(()=>stats.leaders===1);
  const work=jest.fn(dispatchWork(()=>({answer:'fresh'})));
  const refresh=runSharedAiOperation(config({bypassCache:true}),work);
  await until(()=>stats.followers===1);
  expect(work).not.toHaveBeenCalled();hold.release(good);
  expect(await normal).toEqual(good);expect(await refresh).toEqual({answer:'fresh'});
});
test('result-cache outage/eviction never causes duplicate dispatch',async()=>{
  const {runSharedAiOperation,cache}=setup();
  cache.getCached.mockRejectedValue(Error('redis down'));cache.setCache.mockRejectedValue(Error('redis down'));
  const work=jest.fn(dispatchWork());
  expect(await runSharedAiOperation(config(),work)).toEqual(good);
  expect(await runSharedAiOperation(config(),work)).toEqual(good);
  expect(work).toHaveBeenCalledTimes(1);
});
test('Firestore outages fail closed, even when local fallback was requested',async()=>{
  const {runSharedAiOperation,firestore}=setup({allowLocal:true});
  firestore.runTransaction=async()=>{throw Error('down');};
  const work=jest.fn();
  await expect(runSharedAiOperation(config(),work)).rejects.toMatchObject({stage:'coordination',provider:'firestore'});
  expect(work).not.toHaveBeenCalled();
});
test('explicit development fallback coalesces but missing production storage refuses work',async()=>{
  const local=createSharedAiOperations({allowLocal:true}), work=jest.fn(async()=>good);
  await Promise.all([local.runSharedAiOperation(config(),work),local.runSharedAiOperation(config(),work)]);
  expect(work).toHaveBeenCalledTimes(1);
  const env=process.env.NODE_ENV;process.env.NODE_ENV='production';
  try {await expect(local.runSharedAiOperation(config({input:{changed:true}}),work)).rejects.toMatchObject({stage:'coordination'});}
  finally {process.env.NODE_ENV=env;}
});
test('bounded subscribers, operations and output avoid unbounded process or document growth',async()=>{
  const {runSharedAiOperation}=setup({limits:{maxFollowers:1,maxOperations:1}}), hold=gate();
  const first=runSharedAiOperation(config(),dispatchWork(()=>hold.promise));
  await wait(5);
  await expect(runSharedAiOperation(config(),dispatchWork())).rejects.toMatchObject({code:'queue_full'});
  await expect(runSharedAiOperation(config({input:{other:true}}),dispatchWork())).rejects.toMatchObject({code:'queue_full'});
  hold.release(good);await first;
  await expect(runSharedAiOperation(config({bypassCache:true,maxResultBytes:20}),dispatchWork(()=>({answer:'x'.repeat(100)})))).rejects.toMatchObject({code:'invalid_response'});
});
test('transaction retries reuse a dispatch identity and never execute work within the transaction',async()=>{
  const {runSharedAiOperation,firestore}=setup(), original=firestore.runTransaction.bind(firestore);
  firestore.runTransaction=async callback=>{
    await original(tx=>callback({...tx,set:()=>{},update:()=>{}}));
    return original(callback);
  };
  const work=jest.fn(dispatchWork());
  expect(await runSharedAiOperation(config(),work)).toEqual(good);
  expect(work).toHaveBeenCalledTimes(1);
});

test('non-AI callers can label validation and provider failures with their own stage/provider',async()=>{
  const {runSharedAiOperation}=setup();
  await expect(runSharedAiOperation(config({kind:'place-details',model:'google-places',stage:'details',provider:'google'}),dispatchWork(()=>({bad:true})))).rejects.toMatchObject({code:'invalid_response',stage:'details',provider:'google'});
});
function watchable(firestore) {
  const listeners=new Map();
  const counts={started:0,stopped:0};
  const collection=firestore.collection.bind(firestore),transaction=firestore.runTransaction.bind(firestore);
  firestore.collection=name=>{
    const col=collection(name),doc=col.doc.bind(col);
    col.doc=id=>{
      const ref=doc(id);
      ref.onSnapshot=(next,error)=>{
        counts.started++;
        const listener={next,error,id,name};listeners.set(listener,listener);
        queueMicrotask(()=>next({data:()=>firestore.read(name,id)}));
        return ()=>{if(listeners.delete(listener)) counts.stopped++;};
      };
      return ref;
    };
    return col;
  };
  firestore.runTransaction=async fn=>{
    const result=await transaction(fn);
    for(const l of listeners.values()) queueMicrotask(()=>l.next({data:()=>firestore.read(l.name,l.id)}));
    return result;
  };
  return {counts,listeners};
}
test('native Firestore subscriptions share one watcher per generation and unsubscribe on completion',async()=>{
  const a=setup(), watches=watchable(a.firestore), b=createSharedAiOperations({firestore:a.firestore});
  const hold=gate(), producer=a.runSharedAiOperation(config(),dispatchWork(()=>hold.promise));
  await until(()=>a.stats.leaders===1);
  const follower=b.runSharedAiOperation(config(),dispatchWork());
  const second=b.runSharedAiOperation(config(),dispatchWork());
  await until(()=>watches.counts.started===1);
  hold.release(good);
  expect(await Promise.all([producer,follower,second])).toEqual([good,good,good]);
  expect(watches.counts).toEqual({started:1,stopped:1});
});
test('bounded native follower deadline unsubscribes without cancelling the producer',async()=>{
  const a=setup(), watches=watchable(a.firestore), b=createSharedAiOperations({firestore:a.firestore});
  const hold=gate(), producer=a.runSharedAiOperation(config(),dispatchWork(()=>hold.promise));
  await until(()=>a.stats.leaders===1);
  await expect(b.runSharedAiOperation(config({timeoutMs:20}),dispatchWork())).rejects.toMatchObject({code:'dependency_timeout'});
  expect(watches.counts).toEqual({started:1,stopped:1});
  hold.release(good);expect(await producer).toEqual(good);
});

test('unsent coordination failures have a short lifetime without automatic work replay',async()=>{
  let now=1000;
  const {runSharedAiOperation}=setup({now:()=>now});
  const failed=jest.fn(async()=>{throw new EngineError('dependency_error',{stage:'coordination'});});
  await expect(runSharedAiOperation(config(),failed)).rejects.toMatchObject({code:'dependency_error'});
  const work=jest.fn(dispatchWork());
  await expect(runSharedAiOperation(config(),work)).rejects.toMatchObject({code:'dependency_error'});
  now+=5001;
  expect(work).not.toHaveBeenCalled();
  expect(await runSharedAiOperation(config(),work)).toEqual(good);
});

test('canonical identity accepts cross-realm JSON and null-prototype dictionaries but rejects instances',()=>{
  const vm=require('vm');
  const {canonical}=require('../lib/sharedAiIdentity');
  const crossRealm=vm.runInNewContext('({name:"Cafe", nested:{city:"Kyoto"}, list:[{x:1}]})');
  expect(canonical(crossRealm)).toBe(canonical({name:'Cafe',nested:{city:'Kyoto'},list:[{x:1}]}));
  const dict=Object.assign(Object.create(null),{name:'Cafe'});
  expect(canonical(dict)).toBe(canonical({name:'Cafe'}));
  for(const value of [new Date(),new (class Example {})(),Object.create({custom:true}),vm.runInNewContext('new (class Example {})()')]) {
    expect(()=>canonical(value)).toThrow(expect.objectContaining({code:'invalid_response'}));
  }
});

test('subscription expiry fences a crashed last subscriber without replacing its producer lease',async()=>{
  let now=1000;
  const firestore=new FakeFirestore(),store=createSharedAiStore({firestore,now:()=>now});
  const claim=await store.claim({key:'expired-subscriber',leaseMs:1000,timeoutMs:2000,
    subscription:{id:'dead-process',expiresAt:now+10}});
  now+=11;
  await expect(store.authorizeDispatch('expired-subscriber',claim.record)).rejects.toMatchObject({code:'attempt_stopped'});
  expect(firestore.read(COLLECTION,'expired-subscriber_1').dispatch).toBeNull();
});
test('cancelled local fallback cannot dispatch without subscribers',async()=>{
  const {runSharedAiOperation,activeCount}=createSharedAiOperations({allowLocal:true});
  const abort=new AbortController(),held=gate(),entered=gate(),paid=jest.fn();
  const pending=runSharedAiOperation(config({signal:abort.signal}),async({sharedOperation})=>{
    entered.release();await held.promise;await sharedOperation.authorizeDispatch();paid();return good;
  });
  const cancelled=expect(pending).rejects.toMatchObject({code:'attempt_stopped'});
  await entered.promise;abort.abort();await cancelled;held.release();
  await until(()=>activeCount()===0);expect(paid).not.toHaveBeenCalled();
});

test('subscription release outage cannot replace a completed caller result',async()=>{
  const {firestore,runSharedAiOperation}=setup();
  const collection=firestore.collection.bind(firestore);
  const cleanup=jest.fn(async()=>{throw Error('cleanup unavailable');});
  // Fail only after the durable result has reached this caller's final check.
  const active=jest.spyOn(jobContext,'assertActive').mockImplementation(async()=>{
    if (firestore.read(COLLECTION,identity(config()).key+'_1')?.state === 'complete') firestore.collection=name=>{
      const col=collection(name),doc=col.doc.bind(col);
      col.doc=id=>{const ref=doc(id);ref.get=cleanup;return ref;};return col;
    };
  });
  try {
    await expect(runSharedAiOperation(config(),dispatchWork())).resolves.toEqual(good);
    expect(cleanup).toHaveBeenCalled();
  } finally {active.mockRestore();firestore.collection=collection;}
});

test('subscription release outage cannot mask cancellation or restore dispatch authority',async()=>{
  const {firestore,runSharedAiOperation,activeCount}=setup();
  const transaction=firestore.runTransaction.bind(firestore),abort=new AbortController(),entered=gate(),held=gate();
  const paid=jest.fn(),cleanup=jest.fn(async()=>{throw Error('cleanup unavailable');});
  const pending=runSharedAiOperation(config({signal:abort.signal}),async({sharedOperation})=>{
    entered.release();await held.promise;await sharedOperation.authorizeDispatch();paid();return good;
  });
  const cancelled=expect(pending).rejects.toMatchObject({code:'attempt_stopped'});
  await entered.promise;firestore.runTransaction=cleanup;abort.abort();
  try {await cancelled;expect(cleanup).toHaveBeenCalled();}
  finally {firestore.runTransaction=transaction;held.release();}
  await until(()=>activeCount()===0);expect(paid).not.toHaveBeenCalled();
});

test('a new local follower renews membership after the last caller cancels while work is pending',async()=>{
  const {firestore,runSharedAiOperation}=setup({limits:{pollMs:5,subscriptionLeaseMs:60}});
  const abort=new AbortController(),entered=gate(),held=gate(),key=identity(config()).key;
  const paid=jest.fn();
  const work=jest.fn(async({sharedOperation})=>{
    entered.release();await held.promise;await sharedOperation.authorizeDispatch();paid();return good;
  });
  const first=runSharedAiOperation(config({signal:abort.signal}),work);
  const cancelled=expect(first).rejects.toMatchObject({code:'attempt_stopped'});
  const members=()=>firestore.read(COLLECTION,key+'_1').subscribers;
  await entered.promise;
  const originalId=Object.keys(members())[0];
  abort.abort();await cancelled;expect(members()).toEqual({});
  const second=runSharedAiOperation(config(),work);
  await until(()=>Object.keys(members()).length===1);
  const firstExpiry=members()[originalId];
  await until(()=>members()[originalId]>firstExpiry+60);
  expect(members()[originalId]).toBeGreaterThan(Date.now());
  expect(Object.keys(members())).toEqual([originalId]);
  held.release();expect(await second).toEqual(good);
  expect(work).toHaveBeenCalledTimes(1);expect(paid).toHaveBeenCalledTimes(1);
});

test.each(['none','live','cancelled'])('cancellation during dispatch acknowledgement rechecks demand: remote=%s',async remoteState=>{
  const leader=setup(),db=leader.firestore,remote=createSharedAiOperations({firestore:db,limits:{pollMs:5}});
  const transaction=db.runTransaction.bind(db),committed=gate(),ack=gate();
  const localAbort=new AbortController(),remoteAbort=new AbortController(),key=identity(config()).key;
  const paid=jest.fn();let held=false;
  db.runTransaction=async fn=>{
    const value=await transaction(fn);
    if(!held&&value?.id&&Number.isFinite(value.at)) {
      held=true;committed.release();await ack.promise;
    }
    return value;
  };
  const work=async({sharedOperation})=>{await sharedOperation.authorizeDispatch();paid();return good;};
  const first=leader.runSharedAiOperation(config({signal:localAbort.signal}),work);
  const firstCancelled=expect(first).rejects.toMatchObject({code:'attempt_stopped'});
  await committed.promise;
  let second,secondCancelled;
  if(remoteState!=='none') {
    second=remote.runSharedAiOperation(config({signal:remoteAbort.signal}),work);
    if(remoteState==='cancelled')secondCancelled=expect(second).rejects.toMatchObject({code:'attempt_stopped'});
    await until(()=>Object.keys(db.read(COLLECTION,key+'_1').subscribers).length===2);
  }
  localAbort.abort();await firstCancelled;
  if(remoteState==='cancelled'){remoteAbort.abort();await secondCancelled;}
  ack.release();
  if(remoteState==='live')expect(await second).toEqual(good);
  await until(()=>leader.activeCount()===0);
  expect(paid).toHaveBeenCalledTimes(remoteState==='live'?1:0);
  const record=db.read(COLLECTION,key+'_1');
  expect(record.dispatch).not.toBeNull();
  expect(record.state).toBe(remoteState==='live'?'complete':'failed');
});

test('remote demand that expires during its final acknowledgement cannot authorize dispatch',async()=>{
  let now=1000;
  const leader=setup({now:()=>now,limits:{pollMs:5,subscriptionLeaseMs:50}}),db=leader.firestore;
  const remote=createSharedAiOperations({firestore:db,now:()=>now,limits:{pollMs:5,subscriptionLeaseMs:50}});
  const transaction=db.runTransaction.bind(db),committed=gate(),ack=gate(),checked=gate(),checkAck=gate();
  const localAbort=new AbortController(),remoteAbort=new AbortController(),paid=jest.fn();
  db.runTransaction=async fn=>{
    const value=await transaction(fn);
    if(value?.id&&Number.isFinite(value.at)){committed.release();await ack.promise;}
    if(typeof value==='number'){checked.release(value);await checkAck.promise;}
    return value;
  };
  const work=async({sharedOperation})=>{await sharedOperation.authorizeDispatch();paid();return good;};
  const first=leader.runSharedAiOperation(config({signal:localAbort.signal}),work);
  const cancelled=expect(first).rejects.toMatchObject({code:'attempt_stopped'});
  await committed.promise;
  const second=remote.runSharedAiOperation(config({signal:remoteAbort.signal}),work);
  const remoteCancelled=expect(second).rejects.toMatchObject({code:'attempt_stopped'});
  const key=identity(config()).key;
  await until(()=>Object.keys(db.read(COLLECTION,key+'_1').subscribers).length===2);
  localAbort.abort();await cancelled;ack.release();
  const remoteUntil=await checked.promise;
  remoteAbort.abort();await remoteCancelled;
  now=remoteUntil+1;checkAck.release();
  await until(()=>leader.activeCount()===0);expect(paid).not.toHaveBeenCalled();
});
