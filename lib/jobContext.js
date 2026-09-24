const {AsyncLocalStorage} = require('async_hooks');
const {EngineError} = require('./engineError');
const storage = new AsyncLocalStorage();
const current = ()=>storage.getStore();
async function assertActive(txn, {allowExpired=false}={}) {
  const ctx=current();
  if (ctx?.signal?.aborted) throw new EngineError('attempt_stopped',{stage:'execution'});
  if(!allowExpired && ctx && Date.now()>=ctx.deadline) throw new EngineError('dependency_timeout',{stage:'execution'});
  if(!ctx?.leaseOwner) return;
  const {firestore}=require('./firestore');
  const ref=firestore.collection('enrichmentJobs').doc(ctx.jobId);
  const snap=txn ? await txn.get(ref) : await ref.get(), data=snap.data();
  if(!data || data.status!=='processing' || data.workerOwner!==ctx.leaseOwner) throw new EngineError('attempt_stopped',{stage:'execution'});
}
module.exports={current,assertActive,run:(context,work)=>storage.run(context,work)};
