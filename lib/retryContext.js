const {isAnalysisRecovery,validRetryOperations}=require('./media/analysisRecovery');
const {EngineError} = require('./engineError');
async function getRetryContext(firestore,jobId,userId,url) {
  const job=(await firestore.collection('enrichmentJobs').doc(jobId).get()).data() || {};
  if(!job.retryOf) return {};
  // A new explicit analysis receipt may follow a failed admission/delivery
  // receipt. Walk only that bounded, owner/URL-validated chain. An explicit
  // null recovery is authoritative and must never revive older analysis.
  const visited=new Set([jobId]);
  let parentId=job.retryOf,parent;
  for(let depth=0;depth<8;depth++) {
    if(typeof parentId!=='string' || !parentId || visited.has(parentId) || parentId.includes('/') || parentId.length>200)
      throw new EngineError('invalid_response',{stage:'retry'});
    visited.add(parentId);
    parent=(await firestore.collection('enrichmentJobs').doc(parentId).get()).data();
    if(!parent) {
      if(job.retryKind==='analysis')throw new EngineError('invalid_response',{stage:'retry'});
      return {bypassCache:true};
    }
    if(parent.userId!==userId || parent.url!==url)throw new EngineError('access_blocked',{stage:'retry'});
    if(!['failed','complete','duplicate','needs_selection'].includes(parent.status))throw new EngineError('invalid_response',{stage:'retry'});
    if(job.retryKind!=='analysis' || isAnalysisRecovery(parent.analysisRecovery) || Object.hasOwn(parent,'analysisRecovery'))break;
    if(parent.status!=='failed' || !parent.retryOf || parent.retryKind!=='analysis')break;
    parentId=parent.retryOf;
    parent=null;
  }
  if(!parent)throw new EngineError('invalid_response',{stage:'retry'});
  const recovery=isAnalysisRecovery(parent.analysisRecovery) ? {analysisRecovery:parent.analysisRecovery,mediaRetryOperations:validRetryOperations(parent.mediaRetryOperations)} : {};
  const outcomes=Array.isArray(parent.outcomes)?parent.outcomes:[];
  const recovered=[];
  const selected=Array.isArray(parent.selectedPlaceIds)?new Set(parent.selectedPlaceIds):null;
  for(const outcome of outcomes.slice(0,160)) {
    if(outcome.status!=='candidate') {recovered.push(outcome);continue;}
    if(selected && !selected.has(outcome.placeId)) continue;
    if(outcome.placeId) {
      const pins=await firestore.collection('pins').where('userId','==',userId).where('placeId','==',outcome.placeId).limit(1).get();
      if(!pins.empty) {recovered.push({...outcome,status:'existing',pinId:pins.docs[0].id});continue;}
    }
    recovered.push({...outcome,status:'unresolved',...(selected && outcome.placeId?{confirmedPlaceId:outcome.placeId}:{}),requiresSelection:parent.status==='needs_selection' && !selected ? true : outcome.requiresSelection});
  }
  if(job.retryKind==='analysis') {
    if(!isAnalysisRecovery(parent.analysisRecovery))throw new EngineError('invalid_response',{stage:'retry'});
    return {analysisRetry:true,initialOutcomes:recovered,analysisRecovery:parent.analysisRecovery,
      priorUnresolvedOutcomes:recovered.filter(o=>o.status==='unresolved'),
      baseOutcomes:recovered.filter(o=>['saved','existing','dismissed'].includes(o.status)),
      mediaRetryOperations:validRetryOperations(parent.mediaRetryOperations)};
  }
  const unresolved=recovered.filter(o=>o.status==='unresolved' && typeof o.name==='string' && o.name.trim());
  if(!unresolved.length) return {...recovery,initialOutcomes:recovered,bypassCache:true,baseOutcomes:recovered.filter(o=>['saved','existing','dismissed'].includes(o.status))};
  return {...recovery,initialOutcomes:recovered,bypassCache:true,deferredOutcomes:unresolved.slice(40),resumePlaces:unresolved.slice(0,40).map(({name,city,country,address,source,handle,requiresSelection,confirmedPlaceId})=>({name,city:city || '',country:country || '',address:address || '',source:source || 'caption',...(confirmedPlaceId?{confirmedPlaceId}:{}),...(handle?{handle}:{}),...(requiresSelection?{requiresSelection:true}:{})})),
    baseOutcomes:recovered.filter(o=>['saved','existing','dismissed'].includes(o.status)),
    ogData:{title:parent.ogTitle || '',description:parent.ogDescription || '',image:parent.ogImage || '',url,siteName:''}};
}
/** Keep previously identified unsaved places unless fresh matching actually
 * accounts for that same place. A failed/empty new analysis is not evidence
 * that an earlier identified place ceased to exist. */
function retainUnresolved(prior,current) {
  const normalize=value=>typeof value==='string'?value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' '):'';
  const identity=o=>['name','city','country','address'].map(k=>normalize(o[k])).join('\0');
  const accounted=old=>current.some(fresh=>
    (old.placeId && fresh.placeId && old.placeId===fresh.placeId) ||
    (normalize(old.name) && identity(old)===identity(fresh)));
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
