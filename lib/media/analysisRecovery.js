'use strict';
const RECOVERY=Object.freeze({version:1,status:'incomplete',reason:'media_incomplete',canRetry:true});
const isAnalysisRecovery=value=>value?.version===1 && value.status==='incomplete' && value.reason==='media_incomplete' && value.canRetry===true;
function validRetryOperations(value) {
  if(!Array.isArray(value))return [];
  return value.filter(r=>r && ['asr_chunk','video_vision','media_fusion'].includes(r.kind)
    && /^[a-f0-9]{64}$/.test(r.retryKey) && (r.generation===null || (Number.isSafeInteger(r.generation) && r.generation>0)))
    .slice(0,32).map(({kind,retryKey,generation})=>({kind,retryKey,generation}));
}
/** Additive mobile contract. Keep complete when all known places saved; the
 * existing partial_save validator still requires saved < total. Internal
 * coverage carries statuses only, never transcript/frame bodies or URLs. */
function withAnalysisRecovery(data,context) {
  if(!context)return data;
  const recovery=context.mediaIncomplete || isAnalysisRecovery(context.analysisRecovery) ? {...RECOVERY} : null;
  const active=context.mediaCoverage || Object.hasOwn(context,'analysisRecovery') || context.mediaIncomplete;
  if(!active)return data;
  const coverage=context.mediaCoverage ? Object.fromEntries(Object.entries(context.mediaCoverage).map(([key,value])=>[key,
    {status:value.status,...(value.reason?{reason:value.reason}:{})}])) : undefined;
  const completed=recovery && data.status==='failed' && data.progress?.saved>0 && data.progress.saved===data.progress.total
    ? {...data,status:'complete',failure:null,error:null} : data;
  return {...completed,analysisRecovery:recovery,
    ...(coverage?{evidenceCoverage:coverage}:{}),mediaRetryOperations:validRetryOperations(context.mediaRetryOperations)};
}
module.exports={RECOVERY,isAnalysisRecovery,validRetryOperations,withAnalysisRecovery};
