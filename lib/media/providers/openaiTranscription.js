'use strict';
const {createHash} = require('crypto');
const {EngineError, retryAfter} = require('../../engineError');
const MODEL = 'gpt-4o-mini-transcribe-2025-12-15';
const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const MAX_RESPONSE = 65536;
const problem = (code, extra={}) => new EngineError(code,{stage:'transcription',provider:'openai',...extra});
const token = n => Number.isSafeInteger(n) && n >= 0 ? n : null;

/** Physical-call usage only. Null means unreported, never a free request. */
function normalizeUsage(usage, submittedSeconds) {
  if (!usage || typeof usage !== 'object') return null;
  if (usage.type === 'duration') return {type:'duration', seconds:Number.isFinite(usage.seconds) && usage.seconds >= 0 ? usage.seconds : null,
    submitted_seconds:submittedSeconds};
  return {type:'tokens', input_tokens:token(usage.input_tokens), output_tokens:token(usage.output_tokens),
    total_tokens:token(usage.total_tokens), input_token_details:{
      audio_tokens:token(usage.input_token_details?.audio_tokens), text_tokens:token(usage.input_token_details?.text_tokens)},
    submitted_seconds:submittedSeconds};
}
async function readJson(response, signal) {
  if (Number(response.headers?.get?.('content-length')) > MAX_RESPONSE) throw problem('invalid_response');
  let text;
  if (response.body?.getReader) {
    const reader = response.body.getReader(), parts = []; let length = 0;
    try {
      while (true) {
        if (signal.aborted) throw signal.reason;
        const {done,value} = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_RESPONSE) throw problem('invalid_response');
        parts.push(Buffer.from(value));
      }
      text = Buffer.concat(parts).toString('utf8');
    } finally { await reader.cancel().catch(()=>{}); }
  } else {
    text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE) throw problem('invalid_response');
  }
  try { return JSON.parse(text); } catch { throw problem('invalid_response'); }
}

/**
 * Stateless provider adapter. Caller supplies bounded immutable audio bytes,
 * never an upload URL. The caller must wrap this in withProvider and one
 * runSharedAiOperation per chunk. No retries or fallback model/provider.
 * @returns {{id:string,model:string,version:string,capabilities:Object,transcribeChunk:Function}}
 */
function createOpenAITranscription({fetchImpl=(...args)=>fetch(...args), getApiKey=()=>process.env.OPENAI_API_KEY} = {}) {
  return Object.freeze({id:'openai', model:MODEL, version:'openai-json-v1',
    capabilities:{timing:'chunk', language:false},
    async transcribeChunk({audioBytes, audioSha256, startMs, endMs, languageHint=null,
      signal, deadline=Date.now()+20000, model=MODEL} = {}) {
      if (signal?.aborted) throw problem('attempt_stopped');
      if (model !== MODEL || !Buffer.isBuffer(audioBytes) || !audioBytes.length || audioBytes.length >= 25*1024*1024 ||
          createHash('sha256').update(audioBytes).digest('hex') !== audioSha256 ||
          !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs || endMs-startMs > 20000 ||
          (languageHint !== null && (typeof languageHint !== 'string' || !/^[a-z]{2,3}$/.test(languageHint)))) throw problem('invalid_response');
      if (!Number.isFinite(deadline) || deadline <= Date.now()) throw problem('dependency_timeout');
      const key = getApiKey();
      if (typeof key !== 'string' || !key) throw problem('dependency_error');
      const controller = new AbortController();
      const cancel = () => controller.abort(problem('attempt_stopped'));
      signal?.addEventListener('abort',cancel,{once:true});
      const timer = setTimeout(()=>controller.abort(problem('dependency_timeout')),Math.min(20000,Math.max(1,deadline-Date.now())));
      let reportedUsage=null;
      try {
        const form = new FormData();
        form.append('model',MODEL);
        form.append('response_format','json');
        // No guessed spellings, private notes, translation, or invented timestamps.
        if (languageHint) form.append('language',languageHint);
        form.append('file',new Blob([audioBytes],{type:'audio/wav'}),'chunk.wav');
        if (signal?.aborted) cancel();
        if (controller.signal.aborted) throw controller.signal.reason;
        const response = await fetchImpl(ENDPOINT,{method:'POST',headers:{Authorization:`Bearer ${key}`},
          body:form,signal:controller.signal,redirect:'error'});
        if (controller.signal.aborted) throw controller.signal.reason;
        if (!response.ok) {
          const code = response.status === 429 ? 'rate_limited' : [401,403].includes(response.status) ? 'access_blocked' :
            response.status === 413 ? 'input_too_large' : [400,404,422].includes(response.status) ? 'invalid_response' : 'dependency_error';
          await response.body?.cancel?.().catch(()=>{});
          throw problem(code,{retryAfterSeconds:retryAfter(response.headers?.get?.('retry-after'))});
        }
        const data = await readJson(response,controller.signal);
        reportedUsage=normalizeUsage(data?.usage,(endMs-startMs)/1000);
        if (controller.signal.aborted) throw controller.signal.reason;
        if (!data || typeof data.text !== 'string' || data.text.length > 16000) throw problem('invalid_response');
        const text = data.text.trim();
        return {text,language:null,segments:text ? [{text,startMs,endMs,timing:'chunk'}] : [],
          usage:reportedUsage};
      } catch (error) {
        const failure=controller.signal.aborted ? controller.signal.reason : error instanceof EngineError ? error : problem('dependency_error',{cause:error});
        // Keep reported physical usage even when transcript validation fails.
        // Shared-operation failures/cache payloads allowlist it back out.
        if(reportedUsage)failure.usage=reportedUsage;
        throw failure;
      } finally {clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
    }});
}
module.exports = {createOpenAITranscription, normalizeUsage, MODEL};
