const { FakeFirestore, FakeTimestamp, makeAdmin } = require('./helpers/fakeFirestore');
jest.mock('../lib/firestore', () => ({ admin: require('./helpers/fakeFirestore').makeAdmin() }));
const { createQueueMaintenance } = require('../lib/queueMaintenance');
const stamp = FakeTimestamp.fromMillis;

test('expires pending work independently of busy workers, repairs missing fields, and never restarts terminal jobs', async () => {
  const db = new FakeFirestore(), push = jest.fn();
  db.seed('enrichmentJobs', 'expired', { userId: 'u', status: 'pending', engineQueued: true, queueDeadline: stamp(1) });
  db.seed('enrichmentJobs', 'missing', { userId: 'u', status: 'pending', engineQueued: true, admittedAt: stamp(1) });
  db.seed('enrichmentJobs', 'no-admission', { userId: 'u', status: 'pending', engineQueued: true });
  db.seed('enrichmentJobs', 'future', { userId: 'u', status: 'pending', engineQueued: true, queueDeadline: stamp(200000) });
  db.seed('enrichmentJobs', 'done', { userId: 'u', status: 'failed', engineQueued: true });
  const service = createQueueMaintenance({ db, admin: makeAdmin(), push, now: () => 100000 });
  await service.sweep(); await service.sweep();
  for (const id of ['expired', 'missing', 'no-admission', 'done']) expect(db.read('enrichmentJobs', id)).toMatchObject({ status: 'failed', engineQueued: false });
  expect(db.read('enrichmentJobs', 'future').status).toBe('pending');
  expect(push).toHaveBeenCalledTimes(3);
});

test('cursor scan reaches missing ordering fields outside first page', async () => {
  const db = new FakeFirestore();
  for (let n = 0; n < 150; n++) db.seed('enrichmentJobs', `a${String(n).padStart(3, '0')}`, { userId: 'u', status: 'pending', engineQueued: true, queueDeadline: stamp(999999) });
  db.seed('enrichmentJobs', 'z', { userId: 'u', status: 'pending', engineQueued: true });
  const service = createQueueMaintenance({ db, admin: makeAdmin(), now: () => 100, pageSize: 100 });
  await service.sweep(); await service.sweep();
  expect(db.read('enrichmentJobs', 'z').status).toBe('failed');
});


test('expiry atomically persists one private timeout report with missing processing time', async () => {
  const db = new FakeFirestore(); db.strictReadOrder=true;
  db.seed('enrichmentJobs','j',{userId:'u',status:'pending',engineQueued:true,admittedAt:stamp(1000),queueDeadline:stamp(31000)});
  const service = createQueueMaintenance({db,admin:makeAdmin(),now:()=>40000});
  const realTransaction=db.runTransaction.bind(db);
  db.runTransaction=work=>realTransaction(async txn=>{
    const set=txn.set.bind(txn);
    txn.set=(ref,...args)=>{if(ref.collection==='engineMetrics' && ref.id==='j') throw new Error('metrics unavailable');return set(ref,...args);};
    return work(txn);
  });
  await expect(service.sweep()).rejects.toThrow('metrics unavailable');
  expect(db.read('enrichmentJobs','j').status).toBe('pending');
  db.runTransaction=realTransaction;
  await service.sweep();
  const report=db.read('engineMetrics','j');
  expect(report).toMatchObject({outcome:'timeout',queueMs:39000,processingMs:null,processingMissingReason:'not_started',terminalReason:'queue_expired',providerCalls:[]});
  await service.sweep();
  expect(db.read('engineMetrics','j').reportId).toBe(report.reportId);
  const summary=require('../lib/engineMetrics').summarizeMetrics([report]);
  expect(summary.overall.processingMs).toMatchObject({observed:0,missing:1,p50:null});
  expect(summary.overall.queueMs.p50).toBe(39000);
});
