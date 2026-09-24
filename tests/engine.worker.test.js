jest.mock('../lib/firestore',()=>{
  const {getSharedFirestore,makeAdmin}=require('./helpers/fakeFirestore');return {firestore:getSharedFirestore(),admin:makeAdmin()};
});
const {firestore:db}=require('../lib/firestore');
const {FakeTimestamp}=require('./helpers/fakeFirestore');
const {admitEnrichmentJob}=require('../lib/enrichAdmission');
const {createWorker}=require('../lib/enrichmentWorker');
const context=require('../lib/jobContext');
const input=id=>({jobId:id,userId:'u',url:'https://www.instagram.com/reel/TEST/',captionText:'Dinner'});
beforeEach(()=>db.reset());
test('accepted job survives the response/worker handoff gap; duplicate nudges claim once',async()=>{
  expect((await admitEnrichmentJob(db,input('a'))).code).toBe(202);
  expect(db.read('enrichmentJobs','a')).toMatchObject({status:'pending',engineQueued:true});
  const run=jest.fn(async(id,_url,_uid,_caption,options)=>{
    expect(options.leaseOwner).toEqual(expect.any(String));
    await db.collection('enrichmentJobs').doc(id).update({status:'complete'});
  });
  const one=createWorker({db,runEnrichment:run}),two=createWorker({db,runEnrichment:run});
  await Promise.all([one.tick(),two.tick()]);await Promise.all([one.idle(),two.idle()]);
  expect(run).toHaveBeenCalledTimes(1);expect(db.read('enrichmentJobs','a').status).toBe('complete');
  await one.tick();await one.idle();expect(run).toHaveBeenCalledTimes(1);
});
test('unique burst is bounded per user and excess requests become durable failures',async()=>{
  await Promise.all(Array.from({length:12},(_,i)=>admitEnrichmentJob(db,input('burst'+i))));
  const jobs=await db.collection('enrichmentJobs').get();
  expect(jobs.docs.filter(d=>d.data().status==='pending')).toHaveLength(5);
  expect(jobs.docs.filter(d=>d.data().failure?.code==='queue_full')).toHaveLength(7);
  const reports=await db.collection('engineMetrics').get();
  expect(reports.docs).toHaveLength(7);
  for(const report of reports.docs) expect(report.data()).toMatchObject({terminalReason:'queue_full',processingMs:null,processingMissingReason:'not_started',queueMs:null});
});
test('expired queued work fails without any provider execution',async()=>{
  await admitEnrichmentJob(db,input('old'));
  await db.collection('enrichmentJobs').doc('old').update({queueDeadline:FakeTimestamp.fromMillis(Date.now()-1)});
  const run=jest.fn(),worker=createWorker({db,runEnrichment:run});
  await worker.tick();await worker.idle();
  expect(run).not.toHaveBeenCalled();expect(db.read('enrichmentJobs','old').failure.code).toBe('dependency_timeout');
});
test('a killed processing worker is never picked up again',async()=>{
  await admitEnrichmentJob(db,input('dead'));
  const run=jest.fn(async()=>{}),worker=createWorker({db,runEnrichment:run});
  await worker.tick();await worker.idle();
  expect(db.read('enrichmentJobs','dead').status).toBe('processing');
  const replacement=createWorker({db,runEnrichment:run});await replacement.tick();await replacement.idle();
  expect(run).toHaveBeenCalledTimes(1);
});
test('terminal state, expired execution and replaced owner revoke write authorization',async()=>{
  const deadline=Date.now()+10000;
  db.seed('enrichmentJobs','fence',{status:'processing',workerOwner:'owner'});
  await context.run({jobId:'fence',leaseOwner:'owner',deadline},async()=>{
    await expect(context.assertActive()).resolves.toBeUndefined();
    await db.collection('enrichmentJobs').doc('fence').update({status:'failed'});
    await expect(context.assertActive()).rejects.toMatchObject({code:'attempt_stopped'});
    await db.collection('enrichmentJobs').doc('fence').update({status:'processing',workerOwner:'other'});
    await expect(context.assertActive()).rejects.toMatchObject({code:'attempt_stopped'});
  });
  await context.run({jobId:'fence',leaseOwner:'other',deadline:Date.now()-1},async()=>{
    await expect(context.assertActive()).rejects.toMatchObject({code:'dependency_timeout'});
    await expect(context.assertActive(undefined,{allowExpired:true})).resolves.toBeUndefined();
  });
});
test('redelivery cannot restart a failed job or change its stored caption',async()=>{
  await admitEnrichmentJob(db,input('immutable'));
  await db.collection('enrichmentJobs').doc('immutable').update({status:'failed',engineQueued:false});
  const response=await admitEnrichmentJob(db,{...input('immutable'),captionText:'replacement'});
  expect(response.body.status).toBe('failed');expect(db.read('enrichmentJobs','immutable').captionText).toBe('Dinner');
});
