const { outcomeOf, start, persist } = require('../lib/engineTelemetry');
const jobContext = require('../lib/jobContext');
const { FakeFirestore } = require('./helpers/fakeFirestore');

test.each([
  [{status:'failed', failure:{code:'partial_save'}, progress:{saved:1,total:2}}, 'partial'],
  [{status:'failed', failure:{code:'dependency_error'}, progress:{saved:1,total:2}}, 'partial'],
  [{status:'failed', failure:{code:'rate_limited'}}, 'rate_limited'],
  [{status:'failed', failure:{code:'access_blocked'}}, 'blocked'],
  [{status:'failed', failure:{code:'no_place_found'}}, 'no_place'],
  [{status:'failed', failure:{code:'dependency_timeout'}}, 'timeout'],
  [{status:'needs_selection', progress:{saved:1,total:2}}, 'confirmation'],
  [{status:'complete'}, 'success'],
  [{status:'duplicate'}, 'duplicate'],
  [{status:'complete',analysisRecovery:{version:1,status:'incomplete',canRetry:true}}, 'partial'],
  [{status:'duplicate',analysisRecovery:{version:1,status:'incomplete',canRetry:true}}, 'partial'],
  [{status:'complete',analysisRecovery:{version:1,status:'complete'}}, 'success'],
  [{status:'processing'}, 'unknown'],
])('classifies actual stored terminal state %j', (data, expected) => {
  expect(outcomeOf(data)).toBe(expected);
});

test('private persistence uses real outcome summary and rejects replaced owners', async () => {
  const db = new FakeFirestore();
  db.seed('enrichmentJobs','job',{userId:'alice',workerOwner:'lease-a',status:'failed',failure:{code:'partial_save'},progress:{saved:1,total:2}});
  await jobContext.run({jobId:'job',userId:'alice',leaseOwner:'lease-a'},async () => {
    start('instagram',25); await persist(db);
  });
  expect(db.read('engineMetrics','job')).toMatchObject({outcome:'partial',queueMs:25});
  const original = db.read('engineMetrics','job').reportId;
  await db.collection('enrichmentJobs').doc('job').update({workerOwner:'lease-b',status:'complete'});
  await jobContext.run({jobId:'job',userId:'alice',leaseOwner:'lease-a'},async () => {
    start('instagram',0); await persist(db);
  });
  expect(db.read('engineMetrics','job').reportId).toBe(original);
});

test.each(['{', '{"schemaVersion":99}'])('invalid price config %s preserves saved results and reports unavailable cost', async raw => {
  const db=new FakeFirestore(),previous=process.env.ENGINE_PRICE_TABLE_JSON;
  process.env.ENGINE_PRICE_TABLE_JSON=raw;
  try {
    db.seed('enrichmentJobs','saved',{userId:'u',workerOwner:'lease',status:'processing'});
    await jobContext.run({jobId:'saved',userId:'u',leaseOwner:'lease'},async()=>{
      start('youtube',20);
      require('../lib/engineMetrics').current().providerCall({provider:'anthropic',rateKey:'test',stage:'ai',outcome:'success',tokens:{input:1,output:2,cacheRead:0,cacheWrite:0}});
      await db.collection('enrichmentJobs').doc('saved').update({status:'complete',pinId:'p'});
      await persist(db);
      const first=db.read('engineMetrics','saved').reportId;
      await persist(db);
      expect(db.read('engineMetrics','saved').reportId).toBe(first);
    });
    expect(db.read('enrichmentJobs','saved')).toMatchObject({status:'complete',pinId:'p'});
    const report=db.read('engineMetrics','saved');
    expect(report).toMatchObject({outcome:'success',priceConfiguration:'invalid',estimatedCost:{complete:false,totalUsd:null,reasons:expect.arrayContaining(['invalid_price_configuration'])}});
    expect(report.providerCalls).toHaveLength(1);
    expect(require('../lib/engineMetrics').summarizeMetrics([report]).overall.cost).toMatchObject({totalUsd:null,unknownAttempts:1});
  } finally {if(previous===undefined) delete process.env.ENGINE_PRICE_TABLE_JSON;else process.env.ENGINE_PRICE_TABLE_JSON=previous;}
});

test('initialization fallback is owner-fenced, idempotent, and preserves saved progress', async () => {
  const {failAttempt}=require('../lib/engineTelemetry');
  const {EngineError}=require('../lib/engineError');
  const db=new FakeFirestore();
  db.seed('enrichmentJobs','j',{userId:'u',workerOwner:'lease',status:'processing',progress:{saved:1,total:2},pinIds:['p']});
  const error=new EngineError('dependency_error',{stage:'configuration'});
  expect(await failAttempt(db,'j','u',{},error,'not_started')).toBe(false);
  expect(await failAttempt(db,'j','u',{leaseOwner:'lease'},error,'not_started')).toBe(true);
  const report=db.read('engineMetrics','j');
  expect(report).toMatchObject({outcome:'partial',processingMs:null,processingMissingReason:'not_started'});
  expect(db.read('enrichmentJobs','j')).toMatchObject({status:'failed',pinIds:['p'],progress:{saved:1,total:2}});
  expect(await failAttempt(db,'j','u',{leaseOwner:'lease'},error,'not_started')).toBe(false);
  expect(db.read('engineMetrics','j').reportId).toBe(report.reportId);
});
