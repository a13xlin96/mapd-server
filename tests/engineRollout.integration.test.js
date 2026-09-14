const { FakeFirestore, makeAdmin } = require('./helpers/fakeFirestore');
jest.mock('../lib/firestore', () => ({ admin: require('./helpers/fakeFirestore').makeAdmin() }));
const { createEngineFeatures } = require('../lib/engineFeatures');
const { admitEnrichmentJob } = require('../lib/enrichAdmission');

test('admission records server-assigned versions once, ignoring client claims and later rollout changes', async () => {
  const db = new FakeFirestore();
  const flags = createEngineFeatures({ internalUids: ['alice'], flags: { languageRouting: true } });
  const request = { jobId: 'j', userId: 'alice', url: 'https://youtu.be/abc', engineFeatures: { all: true } };
  await admitEnrichmentJob(db, request, { features: flags });
  const recorded = db.read('enrichmentJobs', 'j').engineFeatures;
  expect(recorded.versions.languageRouting).toBe('multilingual-v1');
  expect(recorded.versions.contentIndexReader).toBe('legacy');
  await admitEnrichmentJob(db, request, { features: createEngineFeatures() });
  expect(db.read('enrichmentJobs', 'j').engineFeatures).toEqual(recorded);
});

test('kill admission stops new work durably but keeps existing/terminal results readable', async () => {
  const db = new FakeFirestore(), features = createEngineFeatures({ admission: { stopNewJobs: true } });
  const request = { jobId: 'new', userId: 'u', url: 'https://youtu.be/abc' };
  const result = await admitEnrichmentJob(db, request, { features });
  expect(result.body.status).toBe('failed');
  const report=db.read('engineMetrics','new');
  expect(report).toMatchObject({terminalReason:'admission_paused',processingMs:null,processingMissingReason:'not_started'});
  await admitEnrichmentJob(db, request, { features: createEngineFeatures() });
  expect(db.read('enrichmentJobs', 'new').status).toBe('failed');
  expect(db.read('engineMetrics','new').reportId).toBe(report.reportId);
  db.seed('enrichmentJobs', 'done', { userId: 'u', url: request.url, status: 'complete', pinId: 'p' });
  expect((await admitEnrichmentJob(db, { ...request, jobId: 'done' }, { features })).body.status).toBe('complete');
});


test('invalid live admission config leaves queued/results readable and records new terminal rejections', async () => {
  const db=new FakeFirestore(),request={jobId:'queued',userId:'u',url:'https://youtu.be/abc'};
  await admitEnrichmentJob(db,request);
  db.seed('enrichmentJobs','done',{userId:'u',url:request.url,status:'complete',pinId:'saved'});
  const previous=process.env.ENGINE_ROLLOUT_JSON;
  process.env.ENGINE_ROLLOUT_JSON='{';
  try {
    expect((await admitEnrichmentJob(db,request)).body.status).toBe('pending');
    expect((await admitEnrichmentJob(db,{...request,jobId:'done'})).body.status).toBe('complete');
    expect((await admitEnrichmentJob(db,{...request,jobId:'new'})).body.status).toBe('failed');
    expect(db.read('engineMetrics','new')).toMatchObject({terminalReason:'invalid_admission_configuration',processingMs:null,queueMs:null});
  } finally {if(previous===undefined) delete process.env.ENGINE_ROLLOUT_JSON;else process.env.ENGINE_ROLLOUT_JSON=previous;}
});

test('admission records actual fair policy for control accounts and fails closed on fleet mismatch', async () => {
  const db=new FakeFirestore(),request={jobId:'fair',userId:'control',url:'https://youtu.be/abc'};
  db.seed('engineControl','queueRollout',{schemaVersion:1,policy:'fair-queue-v1'});
  const features=createEngineFeatures({}, {queuePolicy:'fair-queue-v1'});
  await admitEnrichmentJob(db,request,{features});
  const stored=db.read('enrichmentJobs','fair').engineFeatures;
  expect(stored).toMatchObject({cohort:'control',versions:{queuePolicy:'fair-queue-v1',languageRouting:'legacy'}});
  await admitEnrichmentJob(db,request,{features:createEngineFeatures()});
  expect(db.read('enrichmentJobs','fair').engineFeatures).toEqual(stored);
  await admitEnrichmentJob(db,{...request,jobId:'mixed'},{features:createEngineFeatures()});
  expect(db.read('engineMetrics','mixed')).toMatchObject({terminalReason:'fleet_policy_mismatch',processingMs:null});
});
