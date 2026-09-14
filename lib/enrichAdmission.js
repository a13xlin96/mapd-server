const {admin}=require('./firestore');
const {failureOf,EngineError}=require('./engineError');
const VERSION=require('./engineVersion');
const QUEUE_MS=30000, ACTIVE_MS=120000, USER_LIMIT=5;
const ts=()=>admin.firestore.FieldValue.serverTimestamp();
const time=ms=>admin.firestore.Timestamp.fromMillis(ms);
async function admitEnrichmentJob(db,{jobId,userId,url,captionText,adminBypass,retryOf}) {
  if(typeof jobId!=='string' || !/^[A-Za-z0-9_-]{1,200}$/.test(jobId) || typeof userId!=='string' || typeof url!=='string' || !/^https?:\/\//.test(url) || url.length>=2048 || (captionText!=null && (typeof captionText!=='string' || captionText.length>=5000)) || (retryOf!=null && (typeof retryOf!=='string' || !/^[A-Za-z0-9_-]{1,200}$/.test(retryOf) || retryOf===jobId))) return {code:400,body:{error:'invalid_job'}};
  const ref=db.collection('enrichmentJobs').doc(jobId), quota=db.collection('engineAdmission').doc(userId);
  return db.runTransaction(async txn=>{
    const snap=await txn.get(ref), existing=snap.data();
    if(existing && (existing.userId!==userId || existing.url!==url)) return {code:403,body:{error:'request does not match stored job'}};
    if(!existing && adminBypass) return {code:403,body:{error:'admin bypass requires pre-existing pending doc'}};
    if(existing && existing.status!=='pending') return {code:existing.status==='processing'?202:200,body:{jobId,status:existing.status}};
    if(existing?.engineQueued) return {code:202,body:{jobId,status:'pending'}};
    const quotaData=(await txn.get(quota)).data() || {}, now=Date.now();
    const active=(quotaData.active || []).filter(item=>item.expires>now && item.id!==jobId);
    if(active.length>=USER_LIMIT) {
      // A durable failure cannot be resurrected by Cloud Function redelivery.
      const failure=failureOf(new EngineError('queue_full',{stage:'admission'}));
      txn.set(ref,{...(existing || {userId,url,captionText:captionText || '',...(retryOf?{retryOf}:{}),createdAt:ts()}),status:'failed',failure,error:failure.message,updatedAt:ts(),completedAt:ts()});
      return {code:200,body:{jobId,status:'failed',failure}};
    }
    active.push({id:jobId,expires:now+QUEUE_MS+ACTIVE_MS+30000});
    txn.set(quota,{active,updatedAt:ts()});
    txn.set(ref,{...(existing || {userId,url,captionText:captionText || '',...(retryOf?{retryOf}:{}),createdAt:ts()}),
      status:'pending',engineQueued:true,engineVersion:VERSION,admittedAt:ts(),queueDeadline:time(now+QUEUE_MS),updatedAt:ts()});
    return {code:202,body:{jobId,status:'pending'}};
  });
}
async function releaseAdmission(db,userId,jobId) {
  const ref=db.collection('engineAdmission').doc(userId);
  await db.runTransaction(async txn=>{
    const data=(await txn.get(ref)).data();if(!data)return;
    txn.update(ref,{active:(data.active || []).filter(item=>item.id!==jobId && item.expires>Date.now()),updatedAt:ts()});
  });
}
module.exports={admitEnrichmentJob,releaseAdmission,QUEUE_MS,ACTIVE_MS};
