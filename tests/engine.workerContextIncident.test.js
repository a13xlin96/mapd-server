jest.mock('../lib/firestore',()=>({admin:require('./helpers/fakeFirestore').makeAdmin()}));
jest.mock('../lib/cache',()=>({redis:null}));
const {WorkerFirestore}=require('./helpers/workerFirestore');
const {admitEnrichmentJob,ACTIVE_MS}=require('../lib/enrichAdmission');
const {createEngineFeatures}=require('../lib/engineFeatures');
const {createWorker}=require('../lib/enrichmentWorker');
const context=require('../lib/jobContext');
const flush=()=>new Promise(setImmediate);

test('an HTTP nudge drains several valid jobs after the initiating request deadline',async()=>{
  const db=new WorkerFirestore();db.strictReadOrder=true;
  const start=Date.now();let now=start;
  jest.spyOn(Date,'now').mockImplementation(()=>now);
  const policy='fair-queue-v1',features=createEngineFeatures({}, {queuePolicy:policy});
  db.seed('engineControl','queueRollout',{schemaVersion:1,policy});
  const gates=new Map();
  const run=jest.fn(async(id,_url,_user,_caption,options)=>{
    expect(context.current()).toBeUndefined();
    expect(options.deadline).toBe(now+ACTIVE_MS);
    await new Promise(resolve=>gates.set(id,resolve));
    gates.delete(id);
    await db.collection('enrichmentJobs').doc(id).update({status:'complete'});
  });
  const worker=createWorker({db,policy,capacity:1,runEnrichment:run});
  const stop=worker.start();await worker.tick();
  try {
    for(let i=0;i<3;i++) await admitEnrichmentJob(db,{jobId:`job${i}`,userId:'u',url:`https://www.instagram.com/reel/${i}/`},{features});
    await context.run({userId:'u',attemptId:'http:test',deadline:start+ACTIVE_MS},async()=>{
      worker.nudge();await worker.tick();
    });
    await flush();expect(run).toHaveBeenCalledTimes(1);
    now=start+90000;gates.get('job0')();await flush();
    expect(run).toHaveBeenCalledTimes(2);
    now=start+180000;gates.get('job1')();await flush();
    // No fresh request is required to rescue job 3 from a stale HTTP context.
    expect(run).toHaveBeenCalledTimes(3);
    expect(db.read('enrichmentJobs','job2').status).toBe('processing');
    gates.get('job2')();await worker.idle();
    expect(run.mock.calls.map(([id])=>id)).toEqual(['job0','job1','job2']);
    expect(db.read('engineAdmission','u').active).toEqual([]);
  } finally {stop();for(const finish of gates.values())finish();await worker.idle();jest.restoreAllMocks();}
});

test.each(['legacy','fair-queue-v1'])('%s scheduler ignores an expired and aborted caller, retaining the claimed job deadline',async policy=>{
  const db=new WorkerFirestore();db.strictReadOrder=true;
  const features=createEngineFeatures({}, {queuePolicy:policy});
  db.seed('engineControl','queueRollout',{schemaVersion:1,policy});
  await admitEnrichmentJob(db,{jobId:'job',userId:'u',url:'https://www.instagram.com/reel/one/'},{features});
  const controller=new AbortController();controller.abort();
  const run=jest.fn(async(id,_url,_user,_caption,options)=>{
    expect(context.current()).toBeUndefined();
    expect(options.deadline).toBeGreaterThan(Date.now());
    await db.collection('enrichmentJobs').doc(id).update({status:'complete'});
  });
  const worker=createWorker({db,policy,runEnrichment:run});let stop;
  try {
    await context.run({deadline:Date.now()-1,signal:controller.signal},async()=>{
      stop=worker.start();worker.nudge();await worker.tick();
    });
    await worker.idle();expect(run).toHaveBeenCalledTimes(1);
    expect(db.read('enrichmentJobs','job').status).toBe('complete');
  } finally {stop?.();await worker.idle();}
});
