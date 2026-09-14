const {randomUUID}=require('crypto');
const {admin}=require('./firestore');
const {withLease}=require('./providerRuntime');
const {ACTIVE_MS,releaseAdmission}=require('./enrichAdmission');
const {EngineError,failureOf}=require('./engineError');
const millis=value=>typeof value?.toMillis==='function'?value.toMillis():Number(value || 0);
function createWorker({db,runEnrichment,push=async()=>{},capacity=2}) {
  let draining=false,stopped=false,active=0;
  const tasks=new Set();
  async function claim(id) {
    const owner=randomUUID(), ref=db.collection('enrichmentJobs').doc(id);
    return db.runTransaction(async txn=>{
      const data=(await txn.get(ref)).data();
      if(!data || data.status!=='pending' || !data.engineQueued) return null;
      if(millis(data.queueDeadline)<=Date.now()) {
        txn.update(ref,{engineQueued:false,status:'failed',failure:failureOf(new EngineError('dependency_timeout',{stage:'admission'})),completedAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()});
        return {expired:true,data};
      }
      const deadline=Date.now()+ACTIVE_MS;
      txn.update(ref,{engineQueued:false,status:'processing',workerOwner:owner,engineDeadline:admin.firestore.Timestamp.fromMillis(deadline),updatedAt:admin.firestore.FieldValue.serverTimestamp()});
      return {data,owner,deadline};
    });
  }
  async function expire(id) {
    const ref=db.collection('enrichmentJobs').doc(id);
    return db.runTransaction(async txn=>{
      const data=(await txn.get(ref)).data();
      if(!data || data.status!=='pending' || !data.engineQueued || millis(data.queueDeadline)>Date.now()) return null;
      txn.update(ref,{engineQueued:false,status:'failed',failure:failureOf(new EngineError('dependency_timeout',{stage:'admission'})),completedAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()});return data;
    });
  }
  async function tick() {
    if(stopped || draining || !db) return;
    draining=true;
    try {
      // Only server-admitted pending jobs are discoverable work. Terminal
      // jobs and expired processing attempts are never re-queued.
      const snapshot=await db.collection('enrichmentJobs').where('engineQueued','==',true).limit(50).get();
      const docs=[...snapshot.docs].sort((a,b)=>millis(a.data().queueDeadline)-millis(b.data().queueDeadline));
      for(const doc of docs) {
        if(stopped) break;
        if(doc.data().status!=='pending') {
          await db.runTransaction(async txn=>{const data=(await txn.get(doc.ref)).data();if(data && data.status!=='pending' && data.engineQueued)txn.update(doc.ref,{engineQueued:false});});
          await releaseAdmission(db,doc.data().userId,doc.id);continue;
        }
        if(millis(doc.data().queueDeadline)<=Date.now()) {
          const data=await expire(doc.id);
          if(data) {await releaseAdmission(db,data.userId,doc.id);await push(doc.id,data.userId,'failed');}continue;
        }
        if(active>=capacity) continue;
        active++;
        const task=withLease('worker-active',async()=>{
          const claimed=await claim(doc.id);if(!claimed)return;
          const {data}=claimed;
          try {
            if(claimed.expired) {await push(doc.id,data.userId,'failed');return;}
            await runEnrichment(doc.id,data.url,data.userId,data.captionText || '',{leaseOwner:claimed.owner,deadline:claimed.deadline});
          } finally {await releaseAdmission(db,data.userId,doc.id);}
        },{slots:4,waitMs:0,leaseSeconds:150}).catch(error=>{
          // Capacity/coordination failure leaves the durable pending record
          // discoverable until its queue deadline. No extraction was started.
          if(error.code!=='dependency_timeout') console.warn('Worker admission failed:',error.code || error.message);
        }).finally(()=>{active--;tasks.delete(task);});
        tasks.add(task);
      }
    } finally {draining=false;}
  }
  const nudge=()=>{void tick().catch(error=>console.warn('Worker scan failed:',error.code || error.message));};
  return {tick,nudge,idle:()=>Promise.allSettled([...tasks]),start(){const timer=setInterval(nudge,1000);timer.unref?.();nudge();return()=>{stopped=true;clearInterval(timer);};}};
}
module.exports={createWorker,millis};
