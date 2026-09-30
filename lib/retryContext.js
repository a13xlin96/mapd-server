const {isAnalysisRecovery,validRetryOperations}=require('./media/analysisRecovery');
const {EngineError} = require('./engineError');
const {isReviewedDismissal,reviewedClueMatches}=require('./detectionReview');
// Only a server-stored matched candidate can supply coordinates on a retry.
// Neither an AI name nor a client retry request can manufacture this identity.
function validRetryPin(pin,userId) {
  return pin?.userId===userId && typeof pin.placeId==='string' && pin.placeId.length>0
    && typeof pin.placeName==='string' && pin.placeName.trim().length>0
    && Number.isFinite(pin.latitude) && Math.abs(pin.latitude)<=90
    && Number.isFinite(pin.longitude) && Math.abs(pin.longitude)<=180;
}

// Admission rejections and unclaimed queue expirations contain no execution
// result. Only these known receipts may inherit an ordinary retry's ancestor.
// Presence (even []/null) is authoritative for stored results and recovery.
function unstartedAdmissionFailure(job) {
  return job.status==='failed' && job.engineQueued===false && job.retryOf
    && (job.retryKind==null || job.retryKind==='places')
    && job.failure?.stage==='admission'
    && ['queue_full','dependency_error','dependency_timeout'].includes(job.failure.code)
    && !['processingStartedAt','workerOwner','workerQueuePolicy','engineDeadline','attempts','stageFailures',
      'outcomes','candidates','retryCandidates','selectedPlaceIds','progress','unresolvedCount',
      'pinId','existingPinId','sourceAdded','detectionReview','analysisRecovery','mediaRetryOperations','evidenceCoverage']
      .some(key=>Object.hasOwn(job,key));
}

async function getRetryContext(firestore,jobId,userId,url) {
  const job=(await firestore.collection('enrichmentJobs').doc(jobId).get()).data() || {};
  if(!job.retryOf) return {};
  // Analysis retries can follow failed delivery receipts; ordinary retries can
  // follow known unstarted admission failures. Both use the same bounded,
  // owner/URL-validated chain. Explicit null recovery never revives analysis.
  const visited=new Set([jobId]);
  let parentId=job.retryOf,parent;
  for(let depth=0;depth<8;depth++) {
    if(typeof parentId!=='string' || !parentId || visited.has(parentId) || parentId.includes('/') || parentId.length>200)
      throw new EngineError('invalid_response',{stage:'retry'});
    visited.add(parentId);
    parent=(await firestore.collection('enrichmentJobs').doc(parentId).get()).data();
    if(!parent) {
      if(job.retryKind==='analysis' || depth>0)throw new EngineError('invalid_response',{stage:'retry'});
      return {bypassCache:true};
    }
    if(parent.userId!==userId || parent.url!==url)throw new EngineError('access_blocked',{stage:'retry'});
    if(!['failed','complete','duplicate','needs_selection'].includes(parent.status))throw new EngineError('invalid_response',{stage:'retry'});
    if((job.retryKind==null || job.retryKind==='places') && unstartedAdmissionFailure(parent)) {
      parentId=parent.retryOf;
      parent=null;
      continue;
    }
    if(job.retryKind!=='analysis' || isAnalysisRecovery(parent.analysisRecovery) || Object.hasOwn(parent,'analysisRecovery'))break;
    if(parent.status!=='failed' || !parent.retryOf || parent.retryKind!=='analysis')break;
    parentId=parent.retryOf;
    parent=null;
  }
  if(!parent)throw new EngineError('invalid_response',{stage:'retry'});
  const recovery=isAnalysisRecovery(parent.analysisRecovery) ? {analysisRecovery:parent.analysisRecovery,mediaRetryOperations:validRetryOperations(parent.mediaRetryOperations)} : {};
  const outcomes=Array.isArray(parent.outcomes)?parent.outcomes:[];
  let recovered=[];
  const selected=Array.isArray(parent.selectedPlaceIds)?new Set(parent.selectedPlaceIds):null;
  const storedCandidates=[...(Array.isArray(parent.candidates)?parent.candidates:[]),...(Array.isArray(parent.retryCandidates)?parent.retryCandidates:[])]
    .filter(p=>validRetryPin(p,userId)).slice(0,80);
  const selectedOutcome=outcome=>selected?.has(outcome.placeId)
    ? {...outcome,confirmedPlaceId:outcome.placeId} : outcome;
  for(const outcome of outcomes.slice(0,160)) {
    if(outcome.status!=='candidate') {recovered.push(outcome.status==='unresolved'?selectedOutcome(outcome):outcome);continue;}
    if(selected && !selected.has(outcome.placeId)) continue;
    if(outcome.placeId) {
      const pins=await firestore.collection('pins').where('userId','==',userId).where('placeId','==',outcome.placeId).limit(1).get();
      if(!pins.empty) {recovered.push({...outcome,status:'existing',pinId:pins.docs[0].id});continue;}
    }
    recovered.push({...outcome,status:'unresolved',...(selected && outcome.placeId?{confirmedPlaceId:outcome.placeId}:{}),requiresSelection:parent.status==='needs_selection' && !selected ? true : outcome.requiresSelection});
  }
  // A worker may stop between selected saves. Preserve selected candidates
  // that were never reached, even if no outcome was written for them yet.
  for(const pin of storedCandidates) {
    if(selected?.has(pin.placeId) && !recovered.some(o=>o.placeId===pin.placeId))
      recovered.push({name:pin.placeName,city:pin.city || '',address:pin.formattedAddress || '',
        placeId:pin.placeId,confirmedPlaceId:pin.placeId,status:'unresolved'});
  }
  recovered=recovered.filter(o=>o.status!=='unresolved' || !recovered.some(d=>reviewedClueMatches(d,o)));
  const unresolved=recovered.filter(o=>o.status==='unresolved' && typeof o.name==='string' && o.name.trim());
  const recoveryCandidates=storedCandidates.filter(pin=>unresolved.some(o=>(o.confirmedPlaceId || o.placeId)===pin.placeId));
  const resumePlaces=unresolved.slice(0,40).map(({name,city,country,address,source,handle,requiresSelection,confirmedPlaceId,placeId})=>({name,city:city || '',country:country || '',address:address || '',source:source || 'caption',...(confirmedPlaceId?{confirmedPlaceId}:{}),...(placeId?{placeId}:{}),...(handle?{handle}:{}),...(requiresSelection?{requiresSelection:true}:{})}));
  if(job.retryKind==='analysis') {
    if(!isAnalysisRecovery(parent.analysisRecovery))throw new EngineError('invalid_response',{stage:'retry'});
    // Keep exact pending identities alongside fresh analysis. These are not a
    // reason to skip explicitly requested media or refresh successful AI work.
    const retained=resumePlaces.filter(p=>p.confirmedPlaceId || recoveryCandidates.some(pin=>pin.placeId===p.placeId));
    return {analysisRetry:true,reanalyzeIdentity:true,initialOutcomes:recovered,analysisRecovery:parent.analysisRecovery,
      recoveryCandidates,...(retained.length?{resumePlaces:retained}:{}),
      priorUnresolvedOutcomes:recovered.filter(o=>o.status==='unresolved'),
      baseOutcomes:recovered.filter(o=>['saved','existing','dismissed'].includes(o.status)),
      mediaRetryOperations:validRetryOperations(parent.mediaRetryOperations)};
  }
  if(!unresolved.length) return {...recovery,initialOutcomes:recovered,bypassCache:true,baseOutcomes:recovered.filter(o=>['saved','existing','dismissed'].includes(o.status))};
  // An unverified name is a hypothesis, not a save that can simply be resumed.
  // Re-examine it on an explicit retry; retain exact matched/selected identities.
  const reanalyzeIdentity=unresolved.some(o=>!recoveryCandidates.some(pin=>pin.placeId===(o.confirmedPlaceId || o.placeId)) && !o.confirmedPlaceId);
  return {...recovery,initialOutcomes:recovered,bypassCache:true,reanalyzeIdentity,recoveryCandidates,deferredOutcomes:unresolved.slice(40),resumePlaces,
    baseOutcomes:recovered.filter(o=>['saved','existing','dismissed'].includes(o.status)),
    ogData:{title:parent.ogTitle || '',description:parent.ogDescription || '',image:parent.ogImage || '',url,siteName:''}};
}
/** Keep previously identified unsaved places unless fresh matching actually
 * accounts for that same place. A failed/empty new analysis is not evidence
 * that an earlier identified place ceased to exist. */
function retainUnresolved(prior,current) {
  const normalize=value=>typeof value==='string'?value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' '):'';
  const identity=o=>['name','city','country','address'].map(k=>normalize(o[k])).join('\0');
  const accounted=old=>current.some(fresh=> {
    if(isReviewedDismissal(fresh))return reviewedClueMatches(fresh,old);
    const oldId=old.confirmedPlaceId || old.placeId, freshId=fresh.confirmedPlaceId || fresh.placeId;
    // Text coincidence cannot discharge an outstanding exact identity.
    if(oldId) return oldId===freshId;
    return normalize(old.name) && identity(old)===identity(fresh);
  });
  return (prior || []).filter(o=>o.status==='unresolved' && !accounted(o));
}
function withOutcomeSummary(data,context) {
  if(!context?.outcomes?.length || !['complete','duplicate','failed'].includes(data.status)) return data;
  const outcomes=context.outcomes.map(o=>o.status==='candidate' && ['complete','duplicate'].includes(data.status) ? {...o,status:'saved',pinId:data.pinId || data.existingPinId || ''}:o);
  const saved=outcomes.filter(o=>['saved','existing'].includes(o.status)).length;
  const unresolved=outcomes.filter(o=>o.status==='unresolved').length;
  const progress={saved,total:outcomes.filter(o=>o.status!=='dismissed').length};
  if(saved && unresolved) return {...data,status:'failed',outcomes,progress,failure:{code:'partial_save',stage:'places',provider:'engine',message:`Saved ${saved} of ${progress.total} places. Retry the remaining places or dismiss.`,requiresUserAction:true},error:'Some places remain unresolved'};
  return {...data,outcomes,progress};
}
module.exports={getRetryContext,withOutcomeSummary,retainUnresolved};
