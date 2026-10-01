jest.mock('../lib/firestore',()=>({
  firestore:require('./helpers/fakeFirestore').getSharedFirestore(),
  admin:require('./helpers/fakeFirestore').makeAdmin(),
}));
jest.mock('../lib/cache',()=>({redis:null}));
const {firestore:db,admin}=require('../lib/firestore');
const {FakeTimestamp}=require('./helpers/fakeFirestore');
const {admitEnrichmentJob,releaseAdmission,QUEUE_MS,ACTIVE_MS,USER_LIMIT}=require('../lib/enrichAdmission');
const {createEngineFeatures}=require('../lib/engineFeatures');
const {createWorker}=require('../lib/enrichmentWorker');
const {createQueueMaintenance}=require('../lib/queueMaintenance');
const input=id=>({jobId:id,userId:'u',url:`https://www.instagram.com/reel/${id}/`,captionText:'Original caption'});
const flush=()=>new Promise(setImmediate);
let now,features;
beforeEach(()=>{
  db.reset();db.strictReadOrder=true;
  now=Date.now();jest.spyOn(Date,'now').mockImplementation(()=>now);
  features=createEngineFeatures();
});
afterEach(()=>jest.restoreAllMocks());
const admit=(id,controller=features)=>admitEnrichmentJob(db,input(id),{features:controller});
const quota=()=>db.read('engineAdmission','u').active;

test('observed 13-share burst waits past 30 seconds then runs once each with unchanged capacity two',async()=>{
  const admittedAt=now,ids=Array.from({length:13},(_,i)=>`burst${i}`);
  const replies=await Promise.all(ids.map(id=>admit(id)));
  expect(replies.every(r=>r.code===202 && r.body.status==='pending')).toBe(true);
  expect(quota()).toHaveLength(13);
  expect((await db.collection('engineMetrics').get()).size).toBe(0);
  for(const id of ids) {
    expect(db.read('enrichmentJobs',id)).toMatchObject({status:'pending',engineQueued:true});
    expect(db.read('enrichmentJobs',id).queueDeadline.toMillis()).toBe(admittedAt+900000);
  }
  now+=45000;
  await createQueueMaintenance({db,admin}).sweep();
  expect(ids.every(id=>db.read('enrichmentJobs',id).status==='pending')).toBe(true);
  let active=0,peak=0;
  const gates=new Map();
  const run=jest.fn(async(id,_url,_uid,_caption,options)=>{
    active++;peak=Math.max(peak,active);
    try {
      expect(options.deadline-now).toBe(120000);
      expect(options.queueMs).toBeGreaterThan(30000);
      await new Promise(resolve=>gates.set(id,resolve));
      await db.collection('enrichmentJobs').doc(id).update({status:'complete'});
    } finally {active--;gates.delete(id);}
  });
  const worker=createWorker({db,runEnrichment:run});
  try {
    await Promise.all([worker.tick(),worker.tick()]);await flush();
    expect(run).toHaveBeenCalledTimes(2);
    expect(active).toBe(2);
    expect(ids.filter(id=>db.read('enrichmentJobs',id).status==='pending')).toHaveLength(11);
    // Delivery while processing/pending must not create another attempt or
    // extend either the queue deadline or the quota's ownership window.
    const beforeQuota=structuredClone(quota());
    await Promise.all(ids.map(id=>admit(id)));
    expect(quota()).toEqual(beforeQuota);
    for(const id of ids) expect(db.read('enrichmentJobs',id).queueDeadline.toMillis()).toBe(admittedAt+QUEUE_MS);
    for(let batch=0;batch<7;batch++) {
      for(const finish of gates.values()) finish();
      await worker.idle();
      now+=1000;
      await worker.tick();await flush();
    }
    expect(run.mock.calls.map(([id])=>id).sort()).toEqual([...ids].sort());
    expect(peak).toBe(2);
    expect(ids.every(id=>db.read('enrichmentJobs',id).status==='complete')).toBe(true);
    expect(quota()).toEqual([]);
    await Promise.all(ids.map(id=>admit(id)));
    const replacement=createWorker({db,runEnrichment:run});
    await replacement.tick();await replacement.idle();
    expect(run).toHaveBeenCalledTimes(13);
  } finally {for(const finish of gates.values()) finish();await worker.idle();}
});

test('20 outstanding jobs is a hard limit; excess failures stay terminal after a slot is released',async()=>{
  expect(USER_LIMIT).toBe(20);expect(QUEUE_MS).toBe(900000);expect(ACTIVE_MS).toBe(120000);
  const replies=await Promise.all(Array.from({length:21},(_,i)=>admit(`limit${i}`)));
  expect(replies.filter(r=>r.body.status==='pending')).toHaveLength(20);
  expect(replies.filter(r=>r.body.failure?.code==='queue_full')).toHaveLength(1);
  expect(quota()).toHaveLength(20);
  const failedId=replies.find(r=>r.body.status==='failed').body.jobId;
  const failed=db.read('enrichmentJobs',failedId),report=db.read('engineMetrics',failedId);
  expect(report).toMatchObject({terminalReason:'queue_full',processingMissingReason:'not_started',providerCalls:[]});
  const releasedId=quota()[0].id;
  await db.collection('enrichmentJobs').doc(releasedId).update({status:'complete',engineQueued:false});
  await releaseAdmission(db,'u',releasedId);await releaseAdmission(db,'u',releasedId);
  expect(quota()).toHaveLength(19);
  expect((await admit(failedId)).body.status).toBe('failed');
  expect(db.read('enrichmentJobs',failedId)).toEqual(failed);
  expect(db.read('engineMetrics',failedId).reportId).toBe(report.reportId);
  expect((await admit('replacement')).body.status).toBe('pending');
  expect(quota()).toHaveLength(20);
});

test('quota covers the full wait, execution and cleanup allowance and expires at its exact bound',async()=>{
  const start=now;
  await Promise.all(Array.from({length:USER_LIMIT},(_,i)=>admit(`quota${i}`)));
  expect(quota().every(item=>item.expires===start+900000+120000+30000)).toBe(true);
  now=start+4*60*1000; // The old 180s quota must not disappear while jobs wait.
  expect((await admit('stillfull')).body.failure.code).toBe('queue_full');
  now=start+QUEUE_MS+ACTIVE_MS+30000-1;
  expect((await admit('lastmillisecond')).body.failure.code).toBe('queue_full');
  now++;
  expect((await admit('fresh')).body.status).toBe('pending');
  expect(quota()).toEqual([{id:'fresh',expires:now+QUEUE_MS+ACTIVE_MS+30000}]);
  // Expired quota entries do not renew their old jobs' queue deadlines.
  expect(db.read('enrichmentJobs','quota0').queueDeadline.toMillis()).toBe(start+QUEUE_MS);
  await createQueueMaintenance({db,admin}).sweep();
  expect(db.read('enrichmentJobs','quota0').failure.code).toBe('dependency_timeout');
  expect(quota().map(item=>item.id)).toEqual(['fresh']);
});

test('waiting expires at 15 minutes, releases quota once and cannot be extended by redelivery',async()=>{
  const start=now,push=jest.fn();
  await admit('waiting');
  const maintenance=createQueueMaintenance({db,admin,push});
  now=start+QUEUE_MS-1;
  await maintenance.sweep();
  expect((await admit('waiting')).body.status).toBe('pending');
  expect(db.read('enrichmentJobs','waiting').queueDeadline.toMillis()).toBe(start+900000);
  now++;
  await maintenance.sweep();await maintenance.sweep();
  expect(db.read('enrichmentJobs','waiting')).toMatchObject({status:'failed',engineQueued:false,failure:{code:'dependency_timeout',stage:'admission'}});
  expect(quota()).toEqual([]);expect(push).toHaveBeenCalledTimes(1);
  const report=db.read('engineMetrics','waiting');
  expect(report).toMatchObject({terminalReason:'queue_expired',queueMs:900000,processingMs:null,providerCalls:[]});
  expect((await admit('waiting')).body.status).toBe('failed');
  expect(db.read('engineMetrics','waiting').reportId).toBe(report.reportId);
  const run=jest.fn(),worker=createWorker({db,runEnrichment:run});
  await worker.tick();await worker.idle();expect(run).not.toHaveBeenCalled();
});

test('a claim near the waiting deadline still has only 120 seconds of active execution',async()=>{
  const start=now;
  await admit('lateclaim');now=start+QUEUE_MS-1;
  const run=jest.fn(async(id,_url,_uid,_caption,options)=>{
    expect(options.deadline).toBe(now+120000);
    expect(db.read('enrichmentJobs',id).engineDeadline.toMillis()).toBe(now+ACTIVE_MS);
    now+=30001;
    await createQueueMaintenance({db,admin}).sweep();
    expect(db.read('enrichmentJobs',id).status).toBe('processing');
    expect(quota()).toHaveLength(1);
    await db.collection('enrichmentJobs').doc(id).update({status:'complete'});
  });
  const worker=createWorker({db,runEnrichment:run});await worker.tick();await worker.idle();
  expect(run).toHaveBeenCalledTimes(1);expect(db.read('enrichmentJobs','lateclaim').status).toBe('complete');
  expect(quota()).toEqual([]);
});

test('admission stop blocks new work, preserves queued delivery and cannot revive old terminal failures',async()=>{
  await admit('accepted');
  const deadline=db.read('enrichmentJobs','accepted').queueDeadline.toMillis();
  const paused=createEngineFeatures({admission:{stopNewJobs:true}});
  now+=60000;
  const repeated=await admitEnrichmentJob(db,{...input('accepted'),captionText:'Replacement'},{features:paused});
  expect(repeated.body.status).toBe('pending');
  expect(db.read('enrichmentJobs','accepted').captionText).toBe('Original caption');
  expect(db.read('enrichmentJobs','accepted').queueDeadline.toMillis()).toBe(deadline);
  expect((await admit('stopped',paused)).body.status).toBe('failed');
  expect(db.read('engineMetrics','stopped').terminalReason).toBe('admission_paused');
  expect((await admit('stopped')).body.status).toBe('failed');
  db.seed('enrichmentJobs','oldfailure',{...input('oldfailure'),status:'failed',engineQueued:false,
    failure:{code:'queue_full',stage:'admission'},completedAt:FakeTimestamp.fromMillis(now-86400000)});
  expect((await admit('oldfailure')).body.status).toBe('failed');
  expect(quota().map(item=>item.id)).toEqual(['accepted']);
  const run=jest.fn(async id=>db.collection('enrichmentJobs').doc(id).update({status:'complete'}));
  const stoppedWorker=createWorker({db,runEnrichment:run});
  const stop=stoppedWorker.start();stop();await flush();
  await stoppedWorker.tick();await stoppedWorker.idle();expect(run).not.toHaveBeenCalled();
  const replacement=createWorker({db,runEnrichment:run});await replacement.tick();await replacement.idle();
  expect(run.mock.calls.map(([id])=>id)).toEqual(['accepted']);expect(quota()).toEqual([]);
});
