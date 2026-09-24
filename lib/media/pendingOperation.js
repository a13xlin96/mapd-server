'use strict';
const jobContext=require('../jobContext');
const {identity}=require('../sharedAiIdentity');
const {EngineError}=require('../engineError');
const {COLLECTION}=require('../sharedAiStore');
const {isAnalysisRecovery}=require('./analysisRecovery');
const validId=value=>typeof value==='string' && value.length>0 && value.length<=200 && !value.includes('/');
const generation=value=>Number.isSafeInteger(value) && value>0;
const fail=code=>{throw new EngineError(code,{stage:'media_retry',provider:'firestore'});};

// Match retryContext's admission-failure ancestry: at most eight parents,
// same owner/URL throughout, and never skip a newer authoritative recovery
// field (including null or malformed data). Only failed analysis receipts
// without a recovery field may lead to an older parent.
async function recoveryParent(db,job,ctx) {
  const visited=new Set([ctx.jobId]);
  let parentId=job.retryOf;
  for(let depth=0;depth<8;depth++) {
    if(!validId(parentId) || visited.has(parentId))fail('access_blocked');
    visited.add(parentId);
    const parent=(await db.collection('enrichmentJobs').doc(parentId).get()).data();
    if(!parent || parent.userId!==ctx.userId || parent.url!==job.url ||
        !['failed','complete','duplicate','needs_selection'].includes(parent.status))fail('access_blocked');
    if(Object.hasOwn(parent,'analysisRecovery')) {
      if(!isAnalysisRecovery(parent.analysisRecovery))fail('access_blocked');
      return parent;
    }
    if(job.retryKind!=='analysis' || parent.status!=='failed' || parent.retryKind!=='analysis' || !parent.retryOf)fail('access_blocked');
    parentId=parent.retryOf;
  }
  fail('access_blocked');
}

/** Read-only reconciliation of a server-persisted pending marker. The current
 * processing job must be the same user's explicit retryOf receipt. Revalidate
 * the newest authoritative recovery parent through <=8 terminal same-URL
 * receipts (only analysis retries may traverse admission failures); its
 * persisted marker must match. No writes, promotion, or dispatch.
 * @returns {Function} ({operationKey,kind,retryKey}) -> {state,generation?}
 */
function createPendingGenerationResolver({firestore}={}) {
  return async ({operationKey,kind,retryKey})=>{
    const ctx=jobContext.current();
    if(!validId(ctx?.jobId) || !validId(ctx?.userId) || !/^[a-f0-9]{64}$/.test(operationKey))fail('access_blocked');
    await jobContext.assertActive();
    const db=firestore || require('../firestore').firestore;
    if(!db?.collection)fail('dependency_error');
    const job=(await db.collection('enrichmentJobs').doc(ctx.jobId).get()).data();
    if(!job || job.userId!==ctx.userId || job.status!=='processing' || typeof job.url!=='string' ||
        (ctx.leaseOwner && job.workerOwner!==ctx.leaseOwner) || !validId(job.retryOf) || job.retryOf===ctx.jobId)fail('access_blocked');
    const parent=await recoveryParent(db,job,ctx);
    if(!Array.isArray(parent.mediaRetryOperations) || parent.mediaRetryOperations.length>32 ||
        !parent.mediaRetryOperations.some(r=>r?.kind===kind && r.retryKey===retryKey && r.generation===null))fail('access_blocked');
    const head=(await db.collection(COLLECTION).doc(operationKey).get()).data();
    if(!head)return {state:'unattempted'};
    if(!generation(head.generation))fail('invalid_response');
    const record=(await db.collection(COLLECTION).doc(`${operationKey}_${head.generation}`).get()).data();
    // A head with no generation is corruption/uncertainty, not proof of no call.
    if(!record)fail('invalid_response');
    if(record.generation!==head.generation || record.kind!==kind ||
        !['complete','running','failed','uncertain'].includes(record.state))fail('invalid_response');
    await jobContext.assertActive();
    return {state:record.state,generation:record.generation};
  };
}
const defaultResolver=createPendingGenerationResolver();

/** Resolve only a matching nullable-generation marker supplied on explicit
 * retry. Durably absent heads use an ordinary atomic claim, completed
 * operations reuse and running ones join normally. Only a
 * durable failed/uncertain generation may be passed as retryGeneration; the
 * shared store still atomically fences successors. Never loops after failure.
 * Resolver is a trusted factory dependency, not a request/SDK option.
 */
async function resolveEvidenceOperation(operation,generationResolver=defaultResolver) {
  if(!operation.pendingRetry)return operation.sharedOptions;
  const options=operation.sharedOptions,ctx=jobContext.current();
  await jobContext.assertActive();
  if(options.signal?.aborted)fail('attempt_stopped');
  const id=identity(options);
  if(!id.cacheable)fail('access_blocked');
  const remaining=Math.min(2000,options.waitMs || 2000,(ctx?.deadline ?? Infinity)-Date.now());
  if(remaining<=0)fail('dependency_timeout');
  let timer,abort;
  const expiry=new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new EngineError('dependency_timeout',{stage:'media_retry'})),remaining);
    abort=()=>reject(new EngineError('attempt_stopped',{stage:'media_retry'}));
    options.signal?.addEventListener('abort',abort,{once:true});
  });
  try {
    const record=await Promise.race([expiry,Promise.resolve().then(()=>generationResolver({operationKey:id.key,kind:options.kind,retryKey:operation.retryKey}))]);
    await jobContext.assertActive();
    if(options.signal?.aborted)fail('attempt_stopped');
    if(record?.state==='unattempted')return options;
    if(!record || record.state==='missing')fail('dependency_error');
    if(!generation(record.generation) || !['complete','running','failed','uncertain'].includes(record.state))fail('invalid_response');
    return {...options,...(['failed','uncertain'].includes(record.state)?{retryGeneration:record.generation}:{})};
  } finally {clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}
}
module.exports={createPendingGenerationResolver,resolveEvidenceOperation};
