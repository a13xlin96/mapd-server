jest.mock('../lib/firestore',()=>({admin:require('./helpers/fakeFirestore').makeAdmin()}));
jest.mock('../lib/cache',()=>({redis:{set:jest.fn(),get:jest.fn(),eval:jest.fn()}}));
const {WorkerFirestore}=require('./helpers/workerFirestore');
const {FakeTimestamp}=require('./helpers/fakeFirestore');
const {redis}=require('../lib/cache');
const {withLease,withProvider}=require('../lib/providerRuntime');
const {EngineError}=require('../lib/engineError');
const {createWorker,FAIR_QUEUE_POLICY}=require('../lib/enrichmentWorker');
const {createHash}=require('crypto');
const {createEngineFeatures}=require('../lib/engineFeatures');
const fairFeatures=createEngineFeatures({}, {queuePolicy:FAIR_QUEUE_POLICY}).forJob('server-owner');

let db,leases,warnings;
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const flush=async()=>{for(let i=0;i<100;i++) await Promise.resolve();};
const worker=options=>createWorker({db,policy:FAIR_QUEUE_POLICY,runEnrichment:jest.fn(),...options});
function seed(id,userId,deadline=Date.now()+30000,extra={}) {
  db.seed('enrichmentJobs',id,{userId,url:'https://example.test/post',captionText:'Original',engineFeatures:fairFeatures,status:'pending',engineQueued:true,queueDeadline:FakeTimestamp.fromMillis(deadline),...extra});
}
function leaseValue(key) {
  const entry=leases.get(key);
  if(entry && entry.expires<=Date.now()) {leases.delete(key);return null;}
  return entry?.value ?? null;
}
beforeEach(()=>{
  db=new WorkerFirestore();db.strictReadOrder=true;leases=new Map();
  db.seed('engineControl','queueRollout',{schemaVersion:1,policy:FAIR_QUEUE_POLICY});
  redis.set.mockReset().mockImplementation(async(key,value,options={})=>{
    if(options.nx && leaseValue(key)!==null) return null;
    leases.set(key,{value,expires:Date.now()+(options.ex || 3600)*1000});return 'OK';
  });
  redis.get.mockReset().mockImplementation(async key=>leaseValue(key));
  redis.eval.mockReset().mockImplementation(async(_script,[key],[owner])=>{
    if(leaseValue(key)!==owner) return 0;
    leases.delete(key);return 1;
  });
  warnings=jest.spyOn(console,'warn').mockImplementation(()=>{});
});
afterEach(()=>{warnings.mockRestore();jest.useRealTimers();});

test('globally orders 137 shuffled IDs before limiting, including deterministic ties',async()=>{
  const jobs=Array.from({length:137},(_,i)=>({id:createHash('sha256').update(`random-seed-${i}`).digest('hex').slice(0,20),deadline:Date.now()+10000+Math.floor(i/3)}));
  // Insertion and document-name order both disagree with arrival order.
  for(const job of [...jobs].sort((a,b)=>a.id<b.id?-1:1)) seed(job.id,job.id,job.deadline);
  const expected=[...jobs].sort((a,b)=>a.deadline-b.deadline || (a.id<b.id?-1:1)).map(job=>job.id);
  const run=jest.fn(async id=>db.collection('enrichmentJobs').doc(id).update({status:'complete'}));
  const one=worker({capacity:1,runEnrichment:run});
  for(let i=0;i<jobs.length;i++) {await one.tick();await one.idle();}
  expect(run.mock.calls.map(([id])=>id)).toEqual(expected);
  expect(db.queries[0]).toMatchObject({filters:[{field:'status',op:'==',target:'pending'},{field:'engineQueued',op:'==',target:true}],orders:[{field:'queueDeadline',direction:'asc'},{field:'__name__',direction:'asc'}],limit:50});
});

test('bounds each scan to 200 rows and resumes beyond blocked accounts across scans',async()=>{
  const hold=deferred(),held=deferred();
  const lease=withLease('worker-user:heavy',async()=>{held.resolve();await hold.promise;},{slots:1,waitMs:0,leaseSeconds:150});
  await held.promise;
  for(let i=0;i<260;i++) seed(`blocked-${String(i).padStart(3,'0')}`,'heavy',Date.now()+10000+i);
  seed('eligible-tail','other',Date.now()+20000);
  const run=jest.fn(),one=worker({capacity:1,runEnrichment:run});
  try {
    await one.tick();
    expect(db.queries).toHaveLength(4);expect(run).not.toHaveBeenCalled();
    const boundary=db.queries[3];
    // Cursor snapshot ordering still works when its underlying row disappears.
    db.collections.get('enrichmentJobs').delete('blocked-199');
    await one.tick();await one.idle();
    expect(db.queries[4].cursor.id).toBe('blocked-199');
    expect(boundary.limit).toBe(50);
    expect(run).toHaveBeenCalledTimes(1);expect(run.mock.calls[0][0]).toBe('eligible-tail');
  } finally {hold.resolve();await lease;}
  await one.tick();await one.idle();
  expect(run.mock.calls[1][0]).toBe('blocked-000');
});

test('independent worker runtimes share one per-user slot and four global slots',async()=>{
  // Separate module instances have separate providerRuntime local maps; only
  // the stub Redis backend is shared, as it would be across processes.
  let otherCreate;
  jest.isolateModules(()=>{otherCreate=require('../lib/enrichmentWorker').createWorker;});
  const hold=deferred();
  for(let i=0;i<16;i++) seed(`j${String(i).padStart(2,'0')}`,`u${Math.floor(i/2)}`,Date.now()+10000+i);
  let active=0,peak=0;const byUser=new Map(),userPeaks=new Map();
  const run=jest.fn(async(id,_url,uid)=>{
    active++;peak=Math.max(peak,active);byUser.set(uid,(byUser.get(uid) || 0)+1);
    userPeaks.set(uid,Math.max(userPeaks.get(uid) || 0,byUser.get(uid)));
    await hold.promise;
    byUser.set(uid,byUser.get(uid)-1);active--;
    await db.collection('enrichmentJobs').doc(id).update({status:'complete'});
  });
  const one=worker({capacity:9,runEnrichment:run});
  const two=otherCreate({db,policy:FAIR_QUEUE_POLICY,capacity:9,runEnrichment:run});
  try {
    await Promise.all([one.tick(),two.tick()]);
    expect(active).toBe(4);expect(peak).toBe(4);expect(run).toHaveBeenCalledTimes(4);
    expect([...userPeaks.values()]).toEqual([1,1,1,1]);
    const reads=db.queries.length;
    await Promise.all([one.tick(),two.tick()]);
    expect(active).toBe(4);
    // A process with spare local slots can check shared capacity; whichever
    // process is locally full cannot issue an extraction-discovery query.
    expect(db.queries.length-reads).toBeLessThanOrEqual(2);
    expect(redis.set.mock.calls.some(([key])=>key.startsWith('engine:lease:worker-user:'))).toBe(true);
    expect(redis.set.mock.calls.filter(([key])=>key.startsWith('engine:lease:worker-active:')).every(([key])=>Number(key.split(':').pop())<4)).toBe(true);
  } finally {hold.resolve();await Promise.all([one.idle(),two.idle()]);}
});

test('full local capacity causes zero scans; release immediately dispatches pending work',async()=>{
  jest.useFakeTimers();
  seed('first','u1');seed('second','u2');
  const hold=deferred();
  const run=jest.fn(async id=>{if(id==='first') await hold.promise;await db.collection('enrichmentJobs').doc(id).update({status:'complete'});});
  const one=worker({capacity:1,runEnrichment:run}),stop=one.start();
  await flush();expect(run.mock.calls.map(([id])=>id)).toEqual(['first']);
  const reads=db.queries.length;
  for(let i=0;i<50;i++) one.nudge();
  await one.tick();await jest.advanceTimersByTimeAsync(10000);
  expect(db.queries).toHaveLength(reads);
  hold.resolve();await flush();
  expect(run.mock.calls.map(([id])=>id)).toEqual(['first','second']);
  stop();await one.idle();
});

test('idle ramp is jittered, settles at 80% fewer reads, and recovers a lost nudge within 5s',async()=>{
  jest.useFakeTimers();
  const random=jest.fn().mockReturnValue(0);
  const run=jest.fn(),one=worker({random,runEnrichment:run}),stop=one.start();
  await flush();expect(db.queries).toHaveLength(1);
  await jest.advanceTimersByTimeAsync(1599);expect(db.queries).toHaveLength(1);
  await jest.advanceTimersByTimeAsync(1);expect(db.queries).toHaveLength(2);
  await jest.advanceTimersByTimeAsync(30000);
  const reads=db.queries.length;
  await jest.advanceTimersByTimeAsync(60000);
  expect(db.queries.length-reads).toBe(12);
  seed('missed','new-account');
  await jest.advanceTimersByTimeAsync(5000);
  expect(run).toHaveBeenCalledTimes(1);expect(random).toHaveBeenCalled();
  stop();await one.idle();
});

test('coalesces bursts and retains a nudge during an in-flight empty snapshot',async()=>{
  const entered=deferred(),release=deferred();
  db.onQuery=jest.fn(async()=>{if(db.queries.length===1){entered.resolve();await release.promise;}});
  const run=jest.fn(),one=worker({runEnrichment:run});
  for(let i=0;i<100;i++) one.nudge();
  await entered.promise;
  expect(db.queries).toHaveLength(1);
  seed('new','u');
  for(let i=0;i<100;i++) one.nudge();
  release.resolve();await one.idle();
  expect(db.queries).toHaveLength(2);expect(run).toHaveBeenCalledTimes(1);
});

test('global saturation backs off and a lost release nudge recovers without a lease retry loop',async()=>{
  jest.useFakeTimers();
  for(let i=0;i<4;i++) leases.set(`engine:lease:worker-active:${i}`,{value:`other-${i}`,expires:Date.now()+150000});
  seed('waiting','u',Date.now()+300000);
  const run=jest.fn(),one=worker({runEnrichment:run,random:()=>0}),stop=one.start();
  await flush();
  expect(run).not.toHaveBeenCalled();expect(db.queries).toHaveLength(1);
  await jest.advanceTimersByTimeAsync(30000);
  const reads=db.queries.length;
  await jest.advanceTimersByTimeAsync(60000);
  expect(db.queries.length-reads).toBe(12);
  leases.clear();
  await jest.advanceTimersByTimeAsync(5000);
  expect(run).toHaveBeenCalledTimes(1);
  stop();await one.idle();
});

test('stop during an in-flight query prevents claims and further discovery',async()=>{
  const entered=deferred(),release=deferred();
  seed('still-pending','u');
  db.onQuery=async()=>{entered.resolve();await release.promise;};
  const run=jest.fn(),one=worker({runEnrichment:run}),stop=one.start();
  await entered.promise;stop();release.resolve();await one.idle();
  one.nudge();await one.tick();await one.idle();
  expect(db.queries).toHaveLength(1);expect(run).not.toHaveBeenCalled();
  expect(db.read('enrichmentJobs','still-pending').status).toBe('pending');
});

test('expired pending jobs fail and release admission; terminal and orphaned processing never run',async()=>{
  seed('expired','u',Date.now()-1);
  seed('failed','u',Date.now()+10000,{status:'failed'});
  seed('complete','u',Date.now()+10000,{status:'complete'});
  seed('killed','u',Date.now()+10000,{status:'processing',engineDeadline:FakeTimestamp.fromMillis(Date.now()-1)});
  db.seed('engineAdmission','u',{active:[{id:'expired',expires:Date.now()+10000}]});
  const run=jest.fn(),push=jest.fn(),one=worker({runEnrichment:run,push});
  await one.tick();await one.idle();
  expect(db.read('enrichmentJobs','expired')).toMatchObject({status:'failed',engineQueued:false,failure:{code:'dependency_timeout'}});
  expect(db.read('engineAdmission','u').active).toEqual([]);
  expect(push).toHaveBeenCalledWith('expired','u','failed');
  await one.tick();await one.idle();expect(run).not.toHaveBeenCalled();
});

test('expiry is checked again at claim and a concurrent terminal write cannot be resurrected',async()=>{
  seed('expired-in-query','u1');seed('failed-in-query','u2');
  db.onQuery=async()=>{
    await db.collection('enrichmentJobs').doc('expired-in-query').update({queueDeadline:FakeTimestamp.fromMillis(Date.now()-1)});
    await db.collection('enrichmentJobs').doc('failed-in-query').update({status:'failed'});
    db.onQuery=null;
  };
  const run=jest.fn(),one=worker({runEnrichment:run});
  await one.tick();await one.idle();
  expect(db.read('enrichmentJobs','expired-in-query').status).toBe('failed');
  expect(db.read('enrichmentJobs','failed-in-query').status).toBe('failed');
  expect(run).not.toHaveBeenCalled();
});

test('Redis outage fails closed, bounds scanning, and recovery never re-extracts a failed attempt',async()=>{
  seed('waiting','u');
  redis.set.mockRejectedValue(new Error('Redis unavailable'));
  const run=jest.fn(async id=>db.collection('enrichmentJobs').doc(id).update({status:'failed'}));
  const one=worker({runEnrichment:run});
  await one.tick();await one.idle();
  expect(db.queries).toHaveLength(1);expect(run).not.toHaveBeenCalled();
  expect(db.read('enrichmentJobs','waiting').status).toBe('pending');
  redis.set.mockImplementation(async(key,value,{ex})=>{if(leaseValue(key)!==null)return null;leases.set(key,{value,expires:Date.now()+ex*1000});return 'OK';});
  await one.tick();await one.idle();expect(run).toHaveBeenCalledTimes(1);
  leases.clear();one.nudge();await one.idle();await one.tick();await one.idle();
  expect(run).toHaveBeenCalledTimes(1);
});

test('expired crash leases free new jobs, replaced owners are not unlocked, and old attempts stay stopped',async()=>{
  jest.useFakeTimers();
  leases.set('engine:lease:worker-user:u:0',{value:'dead-process',expires:Date.now()+1000});
  seed('new','u',Date.now()+20000);
  seed('old','u',Date.now()+20000,{status:'processing',engineQueued:false});
  const run=jest.fn(async id=>{
    await db.collection('enrichmentJobs').doc(id).update({status:'failed'});
    leases.set('engine:lease:worker-user:u:0',{value:'replacement-owner',expires:Date.now()+150000});
    leases.set('engine:lease:worker-active:0',{value:'replacement-global',expires:Date.now()+150000});
  });
  const one=worker({runEnrichment:run});
  await one.tick();await one.idle();expect(run).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1001);
  await one.tick();await one.idle();
  expect(run).toHaveBeenCalledTimes(1);
  expect(leaseValue('engine:lease:worker-user:u:0')).toBe('replacement-owner');
  expect(leaseValue('engine:lease:worker-active:0')).toBe('replacement-global');
  leases.clear();await one.tick();await one.idle();expect(run).toHaveBeenCalledTimes(1);
});

test('Redis loss after extraction cannot retry the attempt, and failed unlocks recover by TTL',async()=>{
  jest.useFakeTimers();
  seed('extracted','u',Date.now()+300000);
  const run=jest.fn(async id=>{
    await db.collection('enrichmentJobs').doc(id).update({status:'failed'});
    redis.get.mockRejectedValue(new Error('Lost Redis during owner check'));
    redis.eval.mockRejectedValue(new Error('Lost Redis during release'));
  });
  const one=worker({runEnrichment:run});
  await one.tick();await one.idle();
  expect(run).toHaveBeenCalledTimes(1);expect(leases.size).toBe(2);
  await jest.advanceTimersByTimeAsync(150001);
  redis.get.mockImplementation(async key=>leaseValue(key));
  redis.eval.mockImplementation(async(_script,[key],[owner])=>{if(leaseValue(key)!==owner)return 0;leases.delete(key);return 1;});
  seed('after-crash','u');
  const next=jest.fn(),replacement=worker({runEnrichment:next});
  await replacement.tick();await replacement.idle();
  expect(next).toHaveBeenCalledTimes(1);expect(next.mock.calls[0][0]).toBe('after-crash');
  expect(run).toHaveBeenCalledTimes(1);
});

test('provider 429 cooldown expiry does not restart the failed social extraction',async()=>{
  jest.useFakeTimers();
  seed('limited','u');
  const extract=jest.fn(async()=>{throw new EngineError('rate_limited',{provider:'worker-test',stage:'source',retryAfterSeconds:1});});
  const run=jest.fn(async id=>{
    try {await withProvider('worker-test',extract);}
    catch {await db.collection('enrichmentJobs').doc(id).update({status:'failed'});}
  });
  const one=worker({runEnrichment:run});
  await one.tick();await one.idle();
  expect(extract).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(2000);
  one.nudge();await one.idle();
  expect(extract).toHaveBeenCalledTimes(1);expect(run).toHaveBeenCalledTimes(1);
});

test('policy defaults to legacy and rejects unknown policies',async()=>{
  expect(()=>worker({policy:'unreleased'})).toThrow('Unknown worker policy');
  const legacy=createWorker({db,runEnrichment:jest.fn()});
  await legacy.tick();
  expect(db.queries[0].orders).toEqual([]);
  expect(()=>worker({capacity:0})).toThrow('capacity');
});


test.each([
  ['legacy', FAIR_QUEUE_POLICY],
  [FAIR_QUEUE_POLICY, 'legacy'],
  [FAIR_QUEUE_POLICY, undefined],
  ['legacy', 'malformed'],
])('worker %s terminally rejects recorded policy %s without execution or replay', async (policy, recorded) => {
  db.seed('engineControl','queueRollout',{schemaVersion:1,policy});
  const features = recorded === undefined ? undefined : recorded === 'malformed' ? {schemaVersion:99}
    : createEngineFeatures({}, {queuePolicy:recorded}).forJob('u');
  seed('mismatch','u',Date.now()+30000,{engineFeatures:features,admittedAt:FakeTimestamp.fromMillis(Date.now()-250)});
  db.seed('engineAdmission','u',{active:[{id:'mismatch',expires:Date.now()+10000}]});
  const run=jest.fn(),one=worker({policy,runEnrichment:run});
  await one.tick();await one.idle();
  const report=db.read('engineMetrics','mismatch');
  expect(db.read('enrichmentJobs','mismatch')).toMatchObject({status:'failed',engineQueued:false,failure:{code:'dependency_error'}});
  expect(db.read('enrichmentJobs','mismatch').workerQueuePolicy).toBeUndefined();
  expect(db.read('engineAdmission','u').active).toEqual([]);
  expect(report).toMatchObject({processingMs:null,processingMissingReason:'not_started',workerQueuePolicy:null});
  expect(report.queueMs).toBeGreaterThanOrEqual(250);
  await one.tick();await one.idle();
  expect(run).not.toHaveBeenCalled();
  expect(db.read('engineMetrics','mismatch').reportId).toBe(report.reportId);
});

test.each(['legacy', FAIR_QUEUE_POLICY])('a mixed fleet fences %s before it can claim matching jobs', async policy => {
  db.seed('engineControl','queueRollout',{schemaVersion:1,policy:policy==='legacy'?FAIR_QUEUE_POLICY:'legacy'});
  seed('waiting','u',Date.now()+30000,{engineFeatures:createEngineFeatures({}, {queuePolicy:policy}).forJob('u')});
  const run=jest.fn(),one=worker({policy,runEnrichment:run});
  expect(one.policy).toBe(policy);
  await one.tick();await one.idle();
  expect(run).not.toHaveBeenCalled();
  expect(db.read('enrichmentJobs','waiting')).toMatchObject({status:'pending',engineQueued:true});
  expect(db.read('enrichmentJobs','waiting').workerOwner).toBeUndefined();
});

test('recorded execution survives invalid live rollout; escaping initialization errors cannot strand claims', async () => {
  const previous=process.env.ENGINE_ROLLOUT_JSON;
  process.env.ENGINE_ROLLOUT_JSON='{';
  try {
    seed('recorded','u');
    const run=jest.fn(async (_id,_url,_uid,_caption,options) => {
      expect(options.features).toEqual(fairFeatures);
      expect(options.workerQueuePolicy).toBe(FAIR_QUEUE_POLICY);
      throw new EngineError('dependency_error',{stage:'configuration'});
    });
    const one=worker({runEnrichment:run});
    await one.tick();await one.idle();await one.tick();await one.idle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(db.read('enrichmentJobs','recorded')).toMatchObject({status:'failed',failure:{stage:'configuration'}});
    expect(db.read('engineMetrics','recorded')).toMatchObject({processingMs:null,processingMissingReason:'not_observed',workerQueuePolicy:FAIR_QUEUE_POLICY});
  } finally {if(previous===undefined) delete process.env.ENGINE_ROLLOUT_JSON;else process.env.ENGINE_ROLLOUT_JSON=previous;}
});
