const {EngineError} = require('./engineError');
async function getRetryContext(firestore,jobId,userId,url) {
  const job=(await firestore.collection('enrichmentJobs').doc(jobId).get()).data() || {};
  if(!job.retryOf) return {};
  if(typeof job.retryOf!=='string' || job.retryOf===jobId || job.retryOf.includes('/') || job.retryOf.length>200) throw new EngineError('invalid_response',{stage:'retry'});
  const parent=(await firestore.collection('enrichmentJobs').doc(job.retryOf).get()).data();
  // A failed delivery may never have created a server job. It has nothing
  // to resume, so process the new request normally with the cache bypassed.
  if(!parent) return {bypassCache:true};
  if(parent.userId!==userId || parent.url!==url) throw new EngineError('access_blocked',{stage:'retry'});
  if(!['failed','complete','duplicate','needs_selection'].includes(parent.status)) throw new EngineError('invalid_response',{stage:'retry'});
  const outcomes=Array.isArray(parent.outcomes)?parent.outcomes:[];
  const recovered=[];
  const selected=Array.isArray(parent.selectedPlaceIds)?new Set(parent.selectedPlaceIds):null;
  for(const outcome of outcomes.slice(0,80)) {
    if(outcome.status!=='candidate') {recovered.push(outcome);continue;}
    if(selected && !selected.has(outcome.placeId)) continue;
    if(outcome.placeId) {
      const pins=await firestore.collection('pins').where('userId','==',userId).where('placeId','==',outcome.placeId).limit(1).get();
      if(!pins.empty) {recovered.push({...outcome,status:'existing',pinId:pins.docs[0].id});continue;}
    }
    recovered.push({...outcome,status:'unresolved',...(selected && outcome.placeId?{confirmedPlaceId:outcome.placeId}:{}),requiresSelection:parent.status==='needs_selection' && !selected ? true : outcome.requiresSelection});
  }
  const unresolved=recovered.filter(o=>o.status==='unresolved' && typeof o.name==='string' && o.name.trim()).slice(0,40);
  if(!unresolved.length) return {bypassCache:true};
  return {bypassCache:true,resumePlaces:unresolved.map(({name,city,country,address,source,handle,requiresSelection,confirmedPlaceId})=>({name,city:city || '',country:country || '',address:address || '',source:source || 'caption',...(confirmedPlaceId?{confirmedPlaceId}:{}),...(handle?{handle}:{}),...(requiresSelection?{requiresSelection:true}:{})})),
    baseOutcomes:recovered.filter(o=>['saved','existing','dismissed'].includes(o.status)),
    ogData:{title:parent.ogTitle || '',description:parent.ogDescription || '',image:parent.ogImage || '',url,siteName:''}};
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
module.exports={getRetryContext,withOutcomeSummary};
