const {randomUUID}=require('crypto');
const {admin}=require('./firestore');
const {withLease}=require('./providerRuntime');
const {ACTIVE_MS,releaseAdmission}=require('./enrichAdmission');
const {EngineError,failureOf}=require('./engineError');
const millis=value=>typeof value?.toMillis==='function'?value.toMillis():Number(value || 0);
const {assertQueueFleet,executionFeatures}=require('./engineRuntimeConfig');
const {recordTerminal,failAttempt}=require('./engineTelemetry');

async function prepareClaim(txn,db,ref,data,policy) {
  let failure,reason,features;
  if(millis(data.queueDeadline)<=Date.now()) {
    failure=failureOf(new EngineError('dependency_timeout',{stage:'admission'}));
    reason='queue_expired';
  } else {
    // The shared fleet fence is read in the same transaction as the claim.
    // A differently configured process cannot claim even matching old jobs.
    await assertQueueFleet(txn,db,policy);
    try {
      features=executionFeatures(data.engineFeatures);
      if(features.versions.queuePolicy!==policy) {
        reason='recorded_policy_mismatch';
        throw new EngineError('dependency_error',{stage:'queue_policy'});
      }
    } catch(error) {
      failure=failureOf(error);
      reason ||= 'invalid_execution_configuration';
    }
  }
  if(!failure) return {features};
  await recordTerminal(txn,db,ref,{...data,status:'failed',failure},{reason});
  txn.update(ref,{engineQueued:false,status:'failed',failure,
    completedAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()});
  return {terminal:true,data};
}

async function executeClaimed(db,runEnrichment,push,id,claimed) {
  const {data}=claimed;
  const options={leaseOwner:claimed.owner,deadline:claimed.deadline,features:claimed.features,
    workerQueuePolicy:claimed.features.versions.queuePolicy,
    queueMs:typeof data.admittedAt?.toMillis==='function'?Math.max(0,Date.now()-data.admittedAt.toMillis()):null};
  try {await runEnrichment(id,data.url,data.userId,data.captionText || '',options);}
  catch(error) {
    if(await failAttempt(db,id,data.userId,options,error)) await push(id,data.userId,'failed');
  }
}

function createLegacyWorker({db,runEnrichment,push=async()=>{},capacity=2}) {
  let draining=false,stopped=false,active=0;
  const tasks=new Set();
  async function claim(id) {
    const owner=randomUUID(), ref=db.collection('enrichmentJobs').doc(id);
    return db.runTransaction(async txn=>{
      const data=(await txn.get(ref)).data();
      if(!data || data.status!=='pending' || !data.engineQueued) return null;
      const prepared=await prepareClaim(txn,db,ref,data,'legacy');
      if(prepared.terminal) return prepared;
      const deadline=Date.now()+ACTIVE_MS;
      txn.update(ref,{engineQueued:false,status:'processing',workerOwner:owner,workerQueuePolicy:'legacy',processingStartedAt:admin.firestore.FieldValue.serverTimestamp(),engineDeadline:admin.firestore.Timestamp.fromMillis(deadline),updatedAt:admin.firestore.FieldValue.serverTimestamp()});
      return {data,owner,deadline,features:prepared.features};
    });
  }
  async function expire(id) {
    const ref=db.collection('enrichmentJobs').doc(id);
    return db.runTransaction(async txn=>{
      const data=(await txn.get(ref)).data();
      if(!data || data.status!=='pending' || !data.engineQueued || millis(data.queueDeadline)>Date.now()) return null;
      await prepareClaim(txn,db,ref,data,'legacy');return data;
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
            if(claimed.terminal) {await push(doc.id,data.userId,'failed');return;}
            await executeClaimed(db,runEnrichment,push,doc.id,claimed);
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
const FAIR_QUEUE_POLICY='fair-queue-v1';
const PAGE_SIZE=50, MAX_PAGES=4, GLOBAL_SLOTS=4, USER_SLOTS=1;
const LEASE_OPTIONS={waitMs:0,leaseSeconds:150};

// Opt in only after the pending/engineQueued/queueDeadline/__name__ index is
// ready and every admitted pending record has its server-owned queueDeadline.
// Ordering by deadline preserves admission order while queue waits are fixed.
// If they become variable, migrate to an immutable admission ordering field.
//
// Discovery is NOT the expiry service: a separate bounded sweeper must expire
// pending queueDeadline and processing engineDeadline records, reconcile stale
// engineQueued flags, release admission, and notify failures even when every
// worker is full/offline. Neither service may reset terminal work to pending.
function createFairWorker({db,runEnrichment,push=async()=>{},capacity=2,random=Math.random}) {
  if(!Number.isInteger(capacity) || capacity<1) throw new TypeError('Worker capacity must be a positive integer');
  capacity=Math.min(capacity,GLOBAL_SLOTS);
  let stopped=false,running=false,active=0,scanPromise=null,timer=null;
  let requested=false,queued=false,cursor=null,idleBase=1000;
  const tasks=new Set();
  const timestamp=()=>admin.firestore.FieldValue.serverTimestamp();
  const warn=(label,error)=>console.warn(label,error.code || error.message);
  const jitter=()=>Math.max(0,Math.min(1,Number(random()) || 0));

  async function claim(doc,expiryOnly=false) {
    const owner=randomUUID();
    return db.runTransaction(async txn=>{
      const data=(await txn.get(doc.ref)).data();
      if(stopped || !data || data.status!=='pending' || !data.engineQueued) return null;
      const expired=millis(data.queueDeadline)<=Date.now();
      if(expiryOnly && !expired) return null;
      // The leased account must still own the document at the atomic claim.
      if(!expired && data.userId!==doc.data().userId) return null;
      const prepared=await prepareClaim(txn,db,doc.ref,data,FAIR_QUEUE_POLICY);
      if(prepared.terminal) return prepared;
      const deadline=Date.now()+ACTIVE_MS;
      txn.update(doc.ref,{engineQueued:false,status:'processing',workerOwner:owner,workerQueuePolicy:FAIR_QUEUE_POLICY,processingStartedAt:timestamp(),engineDeadline:admin.firestore.Timestamp.fromMillis(deadline),updatedAt:timestamp()});
      return {data,owner,deadline,features:prepared.features};
    });
  }

  async function finishExpired(doc,claimed) {
    if(!claimed) return;
    try {await push(doc.id,claimed.data.userId,'failed');}
    finally {await releaseAdmission(db,claimed.data.userId,doc.id);}
  }

  // Wait only for lease acquisition and the transactional claim, not extraction.
  // This lets discovery page past a busy account without filling local slots
  // with doomed asynchronous lease attempts or waiting for a provider call.
  function launch(doc) {
    active++;
    let userHeld=false,globalHeld=false,claimedWork=false,settled=false,resolveReady,result='skipped';
    const ready=new Promise(resolve=>{resolveReady=resolve;});
    const signal=result=>{if(!settled){settled=true;resolveReady(result);}};
    const task=withLease(`worker-user:${encodeURIComponent(doc.data().userId)}`,()=>{
      userHeld=true;
      return withLease('worker-active',async()=>{
        globalHeld=true;
        const claimed=await claim(doc);
        if(!claimed) return;
        if(claimed.terminal) {await finishExpired(doc,claimed);result='expired';return;}
        claimedWork=true;
        signal('claimed');
        const {data}=claimed;
        try {
          await executeClaimed(db,runEnrichment,push,doc.id,claimed);
        } finally {await releaseAdmission(db,data.userId,doc.id);}
      },{...LEASE_OPTIONS,slots:GLOBAL_SLOTS});
    },{...LEASE_OPTIONS,slots:USER_SLOTS}).catch(error=>{
      const busy=error.code==='dependency_timeout';
      result=busy && !userHeld?'user-busy':busy && !globalHeld?'global-busy':'unavailable';
      if(!busy) warn('Worker admission failed:',error);
    }).finally(()=>{
      active--;
      tasks.delete(task);
      signal(result);
      // Failed lease acquisition must not recursively trigger another scan.
      // A completed attempt releases both distributed leases before this wake.
      if(claimedWork && running && !stopped) {requested=true;idleBase=1000;queueScan();}
    });
    tasks.add(task);
    return ready;
  }

  async function discover() {
    const blockedUsers=new Set();
    let madeProgress=false;
    for(let page=0;page<MAX_PAGES && !stopped && active<capacity;page++) {
      let query=db.collection('enrichmentJobs').where('status','==','pending').where('engineQueued','==',true)
        .orderBy('queueDeadline','asc').orderBy('__name__','asc').limit(PAGE_SIZE);
      if(cursor) query=query.startAfter(cursor);
      const snapshot=await query.get();
      for(const doc of snapshot.docs) {
        if(stopped || active>=capacity) {cursor=null;return true;}
        cursor=doc;
        const data=doc.data();
        if(millis(data.queueDeadline)<=Date.now()) {
          await finishExpired(doc,await claim(doc,true));
          madeProgress=true;
          continue;
        }
        if(blockedUsers.has(data.userId)) continue;
        const result=await launch(doc);
        if(result==='user-busy') blockedUsers.add(data.userId);
        // Other processes may own all leases. Poll recovery remains bounded,
        // but a wholly blocked queue or Redis outage gets idle backoff too.
        if(result==='global-busy' || result==='unavailable') {cursor=null;return false;}
        madeProgress ||= result==='claimed' || result==='expired';
        if(active>=capacity) {cursor=null;return true;}
      }
      if(snapshot.docs.length<PAGE_SIZE) {cursor=null;return madeProgress;}
      // A full page at the scan budget retains its snapshot cursor for the
      // next poll. Deleting/claiming the cursor document cannot reset progress.
    }
    return cursor!==null || madeProgress;
  }

  function armPoll(hadCandidates) {
    if(!running || stopped || active>=capacity) return;
    clearTimeout(timer);
    idleBase=hadCandidates?1000:Math.min(10000,idleBase*2);
    // Jitter the ramp; clamp at five seconds. Settled idle is one read/5s
    // (80% fewer queries than legacy polling), with bounded lost-nudge recovery.
    const delay=hadCandidates?100+Math.floor(150*jitter()):Math.min(5000,Math.floor(idleBase*(0.8+0.4*jitter())));
    timer=setTimeout(()=>{timer=null;nudge();},delay);
    timer.unref?.();
  }

  function tick() {
    if(stopped || !db || active>=capacity) return Promise.resolve();
    if(scanPromise) return scanPromise;
    requested=false;
    clearTimeout(timer);timer=null;
    let hadCandidates=false;
    scanPromise=discover().then(found=>{hadCandidates=found;}).finally(()=>{
      scanPromise=null;
      if(requested && active<capacity) queueScan();
      else armPoll(hadCandidates);
    });
    return scanPromise;
  }

  function queueScan() {
    if(stopped || queued || scanPromise || active>=capacity) return;
    queued=true;
    // Coalesce a synchronous admission burst into one scan, retaining one
    // follow-up when a nudge arrives during an in-flight discovery query.
    Promise.resolve().then(()=>{
      queued=false;
      if(!requested || stopped) return;
      void tick().catch(error=>warn('Worker scan failed:',error));
    });
  }

  function nudge() {
    if(stopped) return;
    requested=true;
    clearTimeout(timer);timer=null;
    queueScan();
  }

  async function idle() {
    // Includes claims still in flight and follow-ups already queued by nudges.
    do {
      await Promise.resolve();
      if(scanPromise) await scanPromise.catch(()=>{});
      await Promise.allSettled([...tasks]);
    } while(scanPromise || tasks.size || queued);
  }

  function stop() {stopped=true;running=false;requested=false;clearTimeout(timer);timer=null;}
  return {tick,nudge,idle,start(){if(!stopped && !running){running=true;nudge();}return stop;}};
}

function createWorker(options) {
  const policy=options.policy ?? 'legacy';
  if(policy==='legacy') return {...createLegacyWorker(options),policy};
  if(policy===FAIR_QUEUE_POLICY) return {...createFairWorker(options),policy};
  throw new TypeError(`Unknown worker policy: ${policy}`);
}
module.exports={createWorker,millis,FAIR_QUEUE_POLICY};
