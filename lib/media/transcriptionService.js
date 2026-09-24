'use strict';
const {createHash} = require('crypto');
const {digest} = require('../sharedAiIdentity');
const {runSharedAiOperation, SERVER_PUBLIC_SCOPE} = require('../sharedAiOperation');
const {withProvider} = require('../providerRuntime');
const jobContext = require('../jobContext');
const {EngineError,asEngineError} = require('../engineError');
const {DEFAULT_MEDIA_CONFIG,validateMediaConfig} = require('./mediaConfig');
const {validateTranscript} = require('./evidenceContract');
const {createOpenAITranscription} = require('./providers/openaiTranscription');
const {mergeIntervals,missingIntervals,transcriptText,reusableSubtitles} = require('./audioSegments');
const {resolveEvidenceOperation} = require('./pendingOperation');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const problem = code => new EngineError(code,{stage:'transcription'});
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value);

/** Trusted recorded policy only; legacy requestTimeoutMs can tighten, never widen. */
function adapterPolicy(options={}) {
  const policy=options.policy === undefined ? DEFAULT_MEDIA_CONFIG : validateMediaConfig(options.policy);
  if (options.requestTimeoutMs !== undefined && (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1)) {
    throw problem('invalid_response');
  }
  return {policy,timeoutMs:Math.min(policy.requestTimeoutMs,options.requestTimeoutMs ?? policy.requestTimeoutMs)};
}
/** Output schema/policy and freshness partition artifacts; capacity/timeouts do
 * not change evidence identity or authorize a fresh paid request on their own. */
function evidencePolicyIdentity(policy) {
  return {schemaVersion:policy.schemaVersion,policyVersion:policy.policyVersion,artifactTtlSeconds:policy.artifactTtlSeconds};
}

/** Stable server-only failure key; payload/paths never enter retry records. */
function sharedEvidenceOptions(base, options={}) {
  const retryKey = digest({kind:base.kind,model:base.model,promptVersion:base.promptVersion,
    schemaVersion:base.schemaVersion,optionsVersion:base.optionsVersion,input:base.input,
    scope:base.scope === SERVER_PUBLIC_SCOPE ? 'server-public' : base.scope || null});
  const records = options.retryOperations || [];
  if (!Array.isArray(records) || records.length > 32 || records.some(r=>!r ||
      !['asr_chunk','video_vision','media_fusion'].includes(r.kind) || !/^[a-f0-9]{64}$/.test(r.retryKey) ||
      (r.generation !== null && (!Number.isSafeInteger(r.generation) || r.generation < 1)))) throw problem('invalid_response');
  const matches = records.filter(r=>r.kind===base.kind && r.retryKey===retryKey);
  if (new Set(matches.map(r=>r.generation)).size > 1) throw problem('invalid_response');
  return {retryKey,pendingRetry:matches[0]?.generation===null,
    sharedOptions:{...base,...(matches.length && matches[0].generation!==null ? {retryGeneration:matches[0].generation} : {})}};
}
/** Null preserves identity after an unobserved outcome; it grants NO generation
 * authority. Only an explicit retry can reconcile it against durable state. */
function retryOperationsForError(error,kind,retryKey) {
  return Number.isSafeInteger(error?.retryGeneration) && error.retryGeneration>0
    ? [{kind,retryKey,generation:error.retryGeneration}]
    : ['dependency_timeout','dependency_error','attempt_stopped'].includes(error?.code) ? [{kind,retryKey,generation:null}] : [];
}

/**
 * Validate the provider-independent result. Optional native segments must be
 * absolute source offsets inside this chunk. No timestamps are inferred.
 */
function chunkEvidence(result, chunk, adapter) {
  if (!result || typeof result.text !== 'string' || result.text.length > 16000 ||
      (result.language != null && !/^[a-zA-Z-]{2,20}$/.test(result.language))) throw problem('invalid_response');
  const text = result.text.trim();
  const segments = result.segments ?? (text ? [{text,startMs:chunk.startMs,endMs:chunk.endMs,timing:'chunk'}] : []);
  const evidence = {provider:adapter.id,model:adapter.model,language:result.language || null,
    segments,coverage:{status:'complete',intervals:[[chunk.startMs,chunk.endMs]]}};
  validateTranscript(evidence,chunk.endMs);
  if (segments.some(s => s.startMs < chunk.startMs || s.endMs > chunk.endMs || !s.text.trim()) ||
      (!!text !== !!segments.length) || (segments.length && segments.map(s=>s.text).join(' ').replace(/\s+/g,' ').trim() !== text.replace(/\s+/g,' ').trim())) {
    throw problem('invalid_response');
  }
  // Construct an allowlisted result: never cache provider usage or metadata.
  return {...evidence,segments:segments.map(s=>({text:s.text,startMs:s.startMs,endMs:s.endMs,timing:s.timing}))};
}
function ownedChunk(raw, durationMs, policy) {
  if (!raw || !Buffer.isBuffer(raw.audioBytes || raw.bytes)) throw problem('invalid_response');
  const audioBytes = Buffer.from(raw.audioBytes || raw.bytes);
  const audioSha256 = hash(audioBytes), claimed = raw.audioSha256 || raw.digest;
  if (audioBytes.length < 12 || audioBytes.length > 2*1024*1024 || audioBytes.toString('ascii',0,4) !== 'RIFF' ||
      audioBytes.toString('ascii',8,12) !== 'WAVE' || (claimed && claimed !== audioSha256) ||
      !Number.isFinite(raw.startMs) || raw.startMs < 0 || !Number.isFinite(raw.endMs) ||
      raw.endMs <= raw.startMs || raw.endMs > durationMs || raw.endMs-raw.startMs > policy.audioChunkMs) throw problem('invalid_response');
  return {audioBytes,audioSha256,startMs:raw.startMs,endMs:raw.endMs};
}
function active(signal) {
  if (jobContext.current()?.parentContext?.signal?.aborted) throw problem('attempt_stopped');
  const stopped = signal?.aborted ? signal : jobContext.current()?.signal;
  if (stopped?.aborted) throw problem(stopped.reason?.code === 'dependency_timeout' ? 'dependency_timeout' : 'attempt_stopped');
  return jobContext.assertActive();
}

/**
 * Provider-neutral facade. Registry is injected by trusted server code, never
 * request JSON; adapters implement {id,model,version,transcribeChunk(args)}.
 * transcribe({durationMs,mediaDigest,chunks,subtitles?,provider?,languageHint?},
 *   {scope?,signal?,retryOperations?,policy?,requestTimeoutMs?}) returns
 * transcript evidence + failures; no billing data/paths/raw bytes are returned.
 * chunks are prepared local PCM WAV buffers with absolute source offsets.
 * Buffers are copied before sharing so cancelled callers cannot free/mutate
 * producer input. At most two ASR chunks are in flight per invocation.
 * Rejected stopped/deadline errors retain known .retryOperations; only a child
 * dependency_timeout exposes .partialResult. Neither authorizes auto-replay.
 */
function createTranscriptionService({providers={openai:createOpenAITranscription()},
  sharedOperation=runSharedAiOperation, providerCall=withProvider,generationResolver} = {}) {
  const registry = new Map(Object.entries(providers));
  for (const [key,adapter] of registry) if (!id(key) || adapter?.id !== key || !id(adapter.model) ||
      !id(adapter.version) || typeof adapter.transcribeChunk !== 'function') throw problem('invalid_response');
  return Object.freeze({
    async transcribe({durationMs,mediaDigest,chunks=[],subtitles=null,provider='openai',languageHint=null} = {}, options={}) {
      await active(options.signal);
      const {policy,timeoutMs} = adapterPolicy(options);
      const adapter = registry.get(provider);
      if (!adapter || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > policy.maxDurationMs ||
          !/^[a-f0-9]{64}$/.test(mediaDigest) || !Array.isArray(chunks) || chunks.length > 32 ||
          (languageHint !== null && (typeof languageHint !== 'string' || !/^[a-z]{2,3}$/.test(languageHint)))) throw problem('invalid_response');
      if (options.policy !== undefined && (adapter.id !== policy.provider || adapter.model !== policy.model)) throw problem('invalid_response');
      const reused = reusableSubtitles(subtitles,durationMs);
      const seen = new Set();
      const prepared = chunks.map(raw=>ownedChunk(raw,durationMs,policy)).filter(chunk=>{
        const key = `${chunk.audioSha256}:${chunk.startMs}:${chunk.endMs}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return !reused.coveredIntervals.some(([lo,hi])=>lo<=chunk.startMs && hi>=chunk.endMs);
      }).sort((a,b)=>a.startMs-b.startMs || a.endMs-b.endMs);
      const segments = [...reused.segments], intervals = [...reused.coveredIntervals], failures = [], retryOperations = [];
      const languages = new Set();
      let next = 0;
      const settled = await Promise.allSettled(Array.from({length:policy.audioConcurrency},async()=>{
        while (true) {
          await active(options.signal);
          const index = next++;
          if (index >= prepared.length) return;
          const chunk = prepared[index];
          let operation;
          try {
            const validate = value => {
              try {
                const rebuilt = chunkEvidence({...value,text:value?.segments?.map(s=>s.text).join(' ')},chunk,adapter);
                return JSON.stringify(rebuilt) === JSON.stringify(value);
              } catch {return false;}
            };
            operation = sharedEvidenceOptions({kind:'asr_chunk',provider:adapter.id,stage:'transcription',
              scope:options.scope,signal:options.signal,model:adapter.model,promptVersion:'literal-transcription-v1',
              schemaVersion:1,optionsVersion:`${adapter.version}:pcm16k-mono-v1`,
              input:{policy:evidencePolicyIdentity(policy),mediaDigest,audioSha256:chunk.audioSha256,startMs:chunk.startMs,endMs:chunk.endMs,languageHint},
              timeoutMs,waitMs:timeoutMs,validate,ttlSeconds:value=>value.segments.length ? policy.artifactTtlSeconds : Math.min(300,policy.artifactTtlSeconds)}, options);
            const sharedOptions=await resolveEvidenceOperation(operation,generationResolver);
            const evidence = await sharedOperation(sharedOptions, async()=>{
              const result = await providerCall(adapter.id,()=>adapter.transcribeChunk({...chunk,languageHint,
                signal:jobContext.current()?.signal,deadline:Math.min(Date.now()+timeoutMs,jobContext.current()?.deadline || Infinity)}),
              policy.providerSlots,{stage:'transcription',rateKey:adapter.rateKey || 'openai_mini_transcribe',descriptor:{
                model:adapter.model,audioSeconds:(chunk.endMs-chunk.startMs)/1000,cacheEnabled:false,
              }});
              return chunkEvidence(result,chunk,adapter);
            });
            if (evidence.language) languages.add(evidence.language);
            evidence.segments.forEach((segment,i)=>segments.push({...segment,
              evidenceId:`audio:${chunk.audioSha256}:${chunk.startMs}:${i}`,audioSha256:chunk.audioSha256,origin:'audio'}));
            intervals.push([chunk.startMs,chunk.endMs]);
            // The next loop checks cancellation outside this failure handler:
            // a completed chunk must not acquire a pending retry marker just
            // because the caller's child deadline elapsed after publication.
          } catch (error) {
            const e = asEngineError(error,{stage:'transcription',provider:adapter.id});
            if (operation) retryOperations.push(...retryOperationsForError(e,'asr_chunk',operation.retryKey));
            failures.push({audioSha256:chunk.audioSha256,startMs:chunk.startMs,endMs:chunk.endMs,code:e.code,
              ...(Number.isSafeInteger(e.retryGeneration) ? {retryGeneration:e.retryGeneration} : {})});
            await active(options.signal);
            if (e.code === 'attempt_stopped') throw e;
          }
        }
      }));
      let stopped = settled.find(item=>item.status==='rejected')?.reason;
      try {await active(options.signal);} catch(error) {stopped=error;}
      segments.sort((a,b)=>a.startMs-b.startMs || a.endMs-b.endMs);
      const covered = mergeIntervals(intervals,durationMs), missing = missingIntervals(covered,durationMs);
      // Native subtitle language is preserved; no language is invented for mini.
      if (subtitles?.language) languages.add(subtitles.language);
      const result = {provider:adapter.id,model:adapter.model,adapterVersion:adapter.version,mediaDigest,
        language:languages.size === 1 ? [...languages][0] : null,segments,text:transcriptText(segments),
        coverage:{status:missing.length ? (covered.length ? 'partial' : failures.length ? 'failed' : 'unattempted') : 'complete',
          intervals:covered,...(missing.length ? {reason:failures.length ? 'audio_chunk_failed' : 'audio_unread'} : {})},failures,retryOperations};
      validateTranscript(result,durationMs);
      if (stopped) {
        // A shared producer's deadline can surface as attempt_stopped after
        // terminal publication. Keep its known retry authority even while
        // rejecting; never turn parent cancellation into partial success.
        stopped.retryOperations = retryOperations;
        if (stopped.code === 'dependency_timeout') stopped.partialResult = result;
        throw stopped;
      }
      return result;
    },
  });
}
let defaultService;
const transcribeAudio = (input,options) => (defaultService ||= createTranscriptionService()).transcribe(input,options);
module.exports = {createTranscriptionService,transcribeAudio,sharedEvidenceOptions,retryOperationsForError,adapterPolicy,evidencePolicyIdentity,SERVER_PUBLIC_SCOPE};
