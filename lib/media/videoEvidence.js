'use strict';
const jobContext=require('../jobContext');
const metrics=require('../engineMetrics');
const {EngineError,asEngineError}=require('../engineError');
const {SERVER_PUBLIC_SCOPE}=require('../sharedAiIdentity');
const {mediaConfigForFeatures,isAudioOnly}=require('./mediaConfig');
const {withMediaContext}=require('./mediaContext');
const {mergeIntervals,missingIntervals}=require('./audioSegments');
const {mergeCandidates}=require('./mediaEligibility');
const manifest=require('./mediaEvidenceCache');
const {buildTranscriptionContext}=require('./transcriptionContext');
const unattempted=()=>({status:'unattempted',intervals:[]});
// Keep measurements independent of coverage decisions. In particular, a
// complete submillisecond tail still has a real, nonzero observed gap.
function timingIntervals(intervals,durationMs,limit) {
  if(!Number.isFinite(durationMs) || durationMs<=0 || durationMs>180000
    || !Array.isArray(intervals) || intervals.length>limit || intervals.some(v=>
    !Array.isArray(v) || v.length!==2 || !v.every(Number.isFinite)
    || v[0]<0 || v[1]<=v[0] || v[1]>durationMs))return null;
  return intervals.map(([startMs,endMs])=>({startMs,endMs}));
}
function subtitleEvidence(extracted,durationMs) {
  const track=extracted?.subtitle_tracks?.find(t=>!t.truncated && Array.isArray(t.segments) && t.segments.length);
  if(!track)return null;
  const segments=track.segments.filter(s=>s.startMs>=0 && s.endMs<=durationMs && s.endMs>s.startMs);
  if(!segments.length)return null;
  const intervals=mergeIntervals(segments.map(s=>[s.startMs,s.endMs]),durationMs);
  return {segments,language:track.language?.split('-')[0] || null,coverage:{status:'partial',intervals}};
}
function boundedText(ogData,transcript,visual=[]) {
  const all=[];
  if(ogData.title)all.push({evidenceId:'caption:title',modality:'caption',text:ogData.title});
  if(ogData.description)all.push({evidenceId:'caption:description',modality:'caption',text:ogData.description});
  for(const segment of transcript?.segments || [])all.push({evidenceId:segment.evidenceId,
    modality:segment.origin==='subtitle'?'subtitle':'transcript',text:segment.text,startMs:segment.startMs,endMs:segment.endMs});
  for(const [i,observation] of visual.entries())all.push({evidenceId:`${observation.evidenceId}:obs:${i}`,modality:'visual',text:observation.quote});
  const evidence=[];let truncated=false;
  for(const item of all) {
    if(!item.text?.trim())continue;
    if(item.text.length>16000 || evidence.length>=64 || Buffer.byteLength(JSON.stringify([...evidence,item]))>23500) {truncated=true;continue;}
    evidence.push(item);
  }
  return {evidence,truncated};
}
/** Up to two batches, each <=8 frames and 12MiB. A small set incurs one call.
 * Byte overflow remains unexamined coverage instead of silently dropping work. */
function frameBatches(frames,limit=8) {
  const ordered=frames.length<=limit ? [...frames] : [
    ...frames.filter((_,i)=>i%2===0),...frames.filter((_,i)=>i%2===1)];
  const batches=[[]];let bytes=0;
  for(const frame of ordered) {
    const size=frame.bytes?.length || 0;
    if(size>2*1024*1024)throw new EngineError('input_too_large',{stage:'frame_selection'});
    if(batches.at(-1).length>=limit || bytes+size>12*1024*1024) {
      if(batches.length===2)break;
      batches.push([]);bytes=0;
    }
    batches.at(-1).push(frame);bytes+=size;
  }
  return batches.filter(b=>b.length);
}
/** A single media escalation per job. Each provider dispatch remains a separate
 * shared operation; this coordinator never wraps several calls in one marker.
 * No raw bytes, transcript, URL, or local path leaves this boundary. */
function createVideoEvidence(deps={}) {
  const discover=deps.discover || require('./mediaSource').discoverMediaSource;
  const acquire=deps.acquire || require('./publicMediaDownload').acquireMedia;
  const acquireAudio=deps.acquireAudio || require('./publicMediaDownload').acquireSeparateAudio;
  const probe=deps.probe || require('./mediaProcess').processMedia;
  const frames=deps.frames || require('./frameSelector').selectFrames;
  const audio=deps.audio || ((input)=>require('./audioDecode').prepareAudioChunks(input));
  const transcribe=deps.transcribe || require('./transcriptionService').transcribeAudio;
  const fusion=deps.fusion || require('./fuseEvidence').fuseEvidence;
  const vision=deps.vision || require('./videoVision').analyzeVideoFrames;
  const scoped=deps.scoped || withMediaContext;
  return async function collectVideoEvidence({url,extracted,ogData={},reason,sourceError,retryOperations=[],baselinePlaces=[]}) {
    const parent=jobContext.current(),config=mediaConfigForFeatures(parent?.features);
    if(!config)return {places:[],attempted:false,incomplete:false,coverage:null,retryOperations:[]};
    const audioOnly=isAudioOnly(config);
    // Extracted fields come from the public post reader. ogData may contain
    // private shareText; neither it nor baseline guesses are spelling context.
    // Capture before awaits so cache identity and provider input stay identical.
    const transcriptionContext=buildTranscriptionContext({title:extracted?.title,description:extracted?.description});
    await jobContext.assertActive();
    const key=manifest.manifestKey({url,ogData,extracted,config,userId:parent.userId,baselinePlaces,transcriptionContext});
    const cached=await (deps.readManifest || manifest.readManifest)(key);
    await jobContext.assertActive();
    if(cached) {metrics.current()?.operation('mediaCacheHits',1);return cached;}
    const began=Date.now(),cpu=process.cpuUsage();
    const result={places:[],contradictions:[],attempted:true,reason,incomplete:false,
      coverage:{audio:unattempted(),visual:audioOnly
        ? {status:'unavailable',reason:'disabled_by_policy',intervals:[]} : unattempted(),fusion:unattempted()},retryOperations:[]};
    const failure=(modality,error)=>{
      const typed=asEngineError(error,{stage:'media'});
      result.error ||= typed;
      result.coverage[modality]={status:'failed',reason:typed.code,intervals:[]};
      result.retryOperations.push(...(error.retryOperations || []));
    };
    metrics.current()?.operation('mediaEscalations',1);
    try {
      await scoped(async child=>{
        let media,separateAudio;
        const common={signal:child.signal,deadline:child.deadline,config};
        const options={scope:ogData.shareText?`user:${parent.userId}`:SERVER_PUBLIC_SCOPE,
          signal:child.signal,retryOperations,policy:config,requestTimeoutMs:config.requestTimeoutMs};
        try {
          const descriptor=await discover({url,extracted,...common,sourceFailure:sourceError});
          for(const [name,value] of Object.entries(require('./mediaSource').readMediaSourceDiagnostics(descriptor))) {
            metrics.current()?.operation(name,value);
          }
          if(descriptor?.availability!=='available')throw new EngineError('source_unavailable',{stage:'media'});
          media=await acquire({descriptor,...common});
          result.mediaDigest=media.contentDigest;
          metrics.current()?.operation('downloadedBytes',media.bytes);
          const processed=await probe({media,...common});
          metrics.current()?.operation('mediaProbeHasAudio',Number(processed.hasAudio === true));
          result.timing={durationMs:processed.durationMs,...(processed.timing?{probe:processed.timing}:{})};
          const subtitles=subtitleEvidence(extracted,processed.durationMs);
          let transcript;
          const visualObservations=[];
          // Leave a bounded part of the media allowance for combining evidence.
          // Neither phase can consume the parent's matching/commit reserve.
          await withMediaContext(async phase=>{
            const phaseCommon={...common,signal:phase.signal,deadline:phase.deadline};
            const publicOptions={...options,scope:SERVER_PUBLIC_SCOPE,signal:phase.signal};
            let audioMedia=media,audioProcessed=processed,audioDigest=media.contentDigest;
            // Download/probe before frame files are produced: the one workspace
            // budget cannot race another writer. Failure is audio-only; frames
            // still get the remainder of the SAME media/phase deadline.
            if (!processed.hasAudio && descriptor.audioRendition) {
              try {
                await jobContext.assertActive();
                metrics.current()?.operation('mediaSeparateAudioAttempted',1);
                separateAudio=await acquireAudio({media,processed,...phaseCommon});
                metrics.current()?.operation('downloadedBytes',separateAudio.bytes);
                audioProcessed=await probe({media:separateAudio,audioForVideo:processed,...phaseCommon});
                if(audioProcessed.timing)result.timing.separateAudioProbe=audioProcessed.timing;
                metrics.current()?.operation('mediaSeparateAudioProbed',1);
                audioMedia=separateAudio;
                audioDigest=require('./audioDecode').audioEvidenceDigest(media.contentDigest,separateAudio.contentDigest,audioProcessed);
                result.mediaDigest=audioDigest;
              } catch(error) {failure('audio',error);}
            }
            const audioWork=(async()=>{
              try {
                if(result.coverage.audio.status==='failed')return;
                if(Number.isFinite(audioProcessed.audioStartMs) && audioProcessed.audioStartMs>=0
                  && audioProcessed.audioStartMs<=processed.durationMs)result.timing.audioStartMs=audioProcessed.audioStartMs;
                if(!audioProcessed.hasAudio)result.coverage.audio={status:'unavailable',reason:'no_audio_track',intervals:[]};
                else {
                  const chunks=await audio({media:audioMedia,processed:audioProcessed,subtitles,...phaseCommon});
                  // These are the actual decoded/sliced chunks offered to the
                  // facade, not a claim that subtitle-skipped audio was decoded.
                  const intervals=Array.isArray(chunks) && chunks.length<=32
                    ? timingIntervals(chunks.map(c=>[c?.startMs,c?.endMs]),processed.durationMs,32) : null;
                  if(intervals)Object.assign(result.timing,{preparedChunkCount:chunks.length,preparedIntervals:intervals});
                  try {transcript=await transcribe({durationMs:processed.durationMs,mediaDigest:audioDigest,
                    chunks,subtitles,provider:config.provider,...(transcriptionContext?{context:transcriptionContext}:{})},publicOptions);}
                  catch(error) {if(error.partialResult)transcript=error.partialResult;else throw error;}
                  result.coverage.audio=transcript.coverage;
                  result.retryOperations.push(...(transcript.retryOperations || []));
                }
              } catch(error) {failure('audio',error);}
            })();
            const frameWork=(async()=>{
              // Skip before allocating any decode work or provider subscription.
              // Intentionally disabled coverage is not a failure/retry target.
              if(audioOnly)return;
              try {
                const selected=await frames({media,processed,...phaseCommon,limit:Math.min(config.maxFrames,config.initialFrames*2)});
                metrics.current()?.operation('framesDecoded',selected.scannedFrames || 0);
                const batches=frameBatches(selected.frames,config.initialFrames);
                if(!batches.length) {result.coverage.visual={status:'complete',reason:'no_distinct_frames',intervals:[]};return;}
                // Both bounded batches share the SAME phase cutoff and still
                // acquire the existing global provider slots independently.
                // Drain every subscription before fusion/disposal; a rejected
                // batch must not discard useful evidence from its sibling.
                const outcomes=await Promise.allSettled(batches.map(batch=>vision({
                  mediaDigest:media.contentDigest,durationMs:processed.durationMs,
                  frames:batch,textEvidence:[]},publicOptions)));
                let count=0,hadGroundingOmissions=false,failedBatch=false;
                for(const [index,outcome] of outcomes.entries()) {
                  if(outcome.status==='rejected') {
                    failure('visual',outcome.reason);failedBatch=true;continue;
                  }
                  const found=outcome.value,batch=batches[index];
                  result.places.push(...found.places);visualObservations.push(...(found.observations || []));count+=batch.length;
                  hadGroundingOmissions ||= found.grounding?.omittedClaims > 0;
                  metrics.current()?.operation('framesSelected',batch.length);
                  metrics.current()?.operation('framePixels',batch.reduce((sum,f)=>sum+f.width*f.height,0));
                }
                // Reduce in input order so response timing cannot change
                // evidence IDs, fusion identity or the visible result.
                if(failedBatch) {
                  if(count)result.coverage.visual.status='partial';
                } else {
                  result.coverage.visual={status:hadGroundingOmissions || count<selected.frames.length?'partial':'complete',
                    reason:hadGroundingOmissions?'literal_claims_omitted':'sampled_frames_only',intervals:[]};
                }
              } catch(error) {
                const hadEvidence=result.coverage.visual.status==='partial';failure('visual',error);
                if(hadEvidence)result.coverage.visual.status='partial';
              }
            })();
            await Promise.all([audioWork,frameWork]);
          },{parent:child,reserveMs:0,deadline:Math.max(Date.now()+1,child.deadline-Math.min(15000,config.requestTimeoutMs))});
          const text=boundedText(ogData,transcript,visualObservations);
          try {
            if(!text.evidence.some(e=>e.modality!=='caption'))result.coverage.fusion={status:'complete',reason:'no_new_text',intervals:[]};
            else {
              const found=await fusion({mediaDigest:result.mediaDigest,durationMs:processed.durationMs,
                textEvidence:text.evidence,baselinePlaces:baselinePlaces.map(({name,city,country,address})=>({name,city:city || '',country:country || '',address:address || ''}))},options);
              const groundingOmitted=found.grounding?.omittedClaims > 0;
              // A successful fusion reconciles complementary visual/audio clues.
              // Retain valid standalone vision when fusion omitted claims,
              // some evidence exceeded bounds, or audio failed.
              result.places=text.truncated || groundingOmitted || result.coverage.audio.status==='failed'?[...result.places,...found.places]:found.places;
              result.contradictions=found.contradictions || [];
              result.coverage.fusion={status:text.truncated || groundingOmitted?'partial':'complete',
                reason:text.truncated?'text_bound':groundingOmitted?'literal_claims_omitted':'literal_evidence',intervals:[]};
            }
          } catch(error) {failure('fusion',error);}
        } finally {try {await separateAudio?.dispose();} finally {await media?.dispose();}}
      },{parent});
    } catch(error) {
      result.error=asEngineError(error,{stage:'media'});
      for(const key of Object.keys(result.coverage))if(result.coverage[key].status==='unattempted')failure(key,error);
    }
    // A child's time allowance can end; the parent still has matching/commit
    // time. A cancelled/replaced parent must never consume these late results.
    await jobContext.assertActive();
    if(result.timing && ['complete','partial','failed'].includes(result.coverage.audio.status)
      && timingIntervals(result.coverage.audio.intervals,result.timing.durationMs,1000)) {
      const gaps=missingIntervals(result.coverage.audio.intervals,result.timing.durationMs);
      result.timing.coverageGapCount=gaps.length;
      result.timing.coverageGaps=timingIntervals(gaps.slice(0,64),result.timing.durationMs,64);
    }
    if(result.error?.code==='attempt_stopped')result.error=new EngineError('dependency_timeout',{stage:'media'});
    result.places=mergeCandidates([],result.places,{limit:120,contradictions:result.contradictions,onOverflow:()=>{result.coverage.fusion={status:'partial',reason:'candidate_bound',intervals:[]};}}).sort((a,b)=>JSON.stringify([a.name,a.city,a.address]).localeCompare(JSON.stringify([b.name,b.city,b.address])));
    result.incomplete=Object.values(result.coverage).some(c=>!['complete','unavailable'].includes(c.status));
    result.retryOperations=[...new Map(result.retryOperations.map(r=>[`${r.kind}:${r.retryKey}`,r])).values()].slice(0,32);
    metrics.current()?.operation('mediaWallMs',Date.now()-began);
    metrics.current()?.recordStage('media',Date.now()-began,result.incomplete?'partial':'success');
    const used=process.cpuUsage(cpu);metrics.current()?.operation('mediaCpuMs',(used.user+used.system)/1000);
    if(!result.incomplete) {
      // Measurements describe this acquisition only. Keep reusable manifests'
      // existing shape/size bounds; a cache hit never triggers a timing re-probe.
      const {timing,...evidence}=result;
      await (deps.writeManifest || manifest.writeManifest)(key,evidence,{ttlSeconds:config.manifestTtlSeconds});
    }
    return result;
  };
}
let defaultCollector;
const collectVideoEvidence=input=>(defaultCollector ||= createVideoEvidence())(input);
module.exports={createVideoEvidence,collectVideoEvidence,subtitleEvidence,boundedText,frameBatches};
