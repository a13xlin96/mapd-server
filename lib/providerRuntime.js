const jobContext = require('./jobContext');
const {assertActive} = jobContext;
const {randomUUID} = require('crypto');
const {redis} = require('./cache');
const {EngineError,asEngineError} = require('./engineError');
const metrics = require('./engineMetrics');
const {cooldownRemaining,recordCooldown} = require('./providerCooldown');
const {beginProviderObservation} = require('./engineBudget');
const {usageFrom} = require('./engineBudgetPolicy');
const {isMediaOperation} = require('./media/mediaContext');
const MEDIA_STAGES = Object.freeze(['transcription','video_vision','media_fusion']);
const local = new Map();
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
// This lease bounds admission, not authorization. Redis failures fail closed;
// the local fallback is only for an explicitly single-process installation.
async function withLease(key, work, {slots=1,waitMs=30000,leaseSeconds=90} = {}) {
  if(!redis && process.env.NODE_ENV==='production' && process.env.ENGINE_SINGLE_PROCESS!=='true') throw new EngineError('dependency_error',{stage:'coordination',provider:'redis'});
  const owner = randomUUID(), started = Date.now(); let held;
  do {
    const ctx=jobContext.current();
    if(ctx?.signal?.aborted) throw new EngineError('attempt_stopped',{stage:'admission'});
    if(Number.isFinite(ctx?.deadline) && Date.now() >= ctx.deadline) throw new EngineError('dependency_timeout',{stage:'admission'});
    for(let i=0;i<slots;i++) {
      const slot = `engine:lease:${key}:${i}`;
      if (redis) {
        try {if (await redis.set(slot,owner,{nx:true,ex:leaseSeconds})) {held=slot;break;}}
        catch(e) {throw asEngineError(e,{stage:'admission',provider:'redis'});}
      } else if (!local.has(slot) || local.get(slot).expires < Date.now()) {
        local.set(slot,{owner,expires:Date.now()+leaseSeconds*1000});held=slot;break;
      }
    }
    if (held) break;
    if(Date.now()-started >= waitMs) throw new EngineError('dependency_timeout',{stage:'admission'});
    await sleep(200);
  } while(true);
  try {
    const result=await work();
    const stillOwner=redis ? await redis.get(held)===owner : local.get(held)?.owner===owner && local.get(held)?.expires>Date.now();
    if(!stillOwner) throw new EngineError('attempt_stopped',{stage:'coordination'});
    return result;
  }
  finally {
    if (redis) {try {await redis.eval(RELEASE,[held],[owner]);} catch { /* expires; never unlock another owner */ }}
    else if(local.get(held)?.owner===owner) local.delete(held);
  }
}
async function withProvider(provider, work, slots=1, observation={}) {
  // New paid media is always a separately fenced shared operation. The live
  // stop is checked by that operation's transaction and bounded last read,
  // never by budget policy.
  if ((provider === 'openai' || MEDIA_STAGES.includes(observation.stage)) &&
      !isMediaOperation(jobContext.current()?.sharedOperation?.kind)) {
    throw new EngineError('attempt_stopped',{stage:'coordination',provider});
  }
  const check = async()=>{const remaining=await cooldownRemaining(provider);if(remaining)throw new EngineError('rate_limited',{stage:'admission',provider,retryAfterSeconds:remaining});};
  await assertActive();
  await check();
  return withLease(`provider:${provider}`,async()=>{
    await check();
    let attempted=false, dispatched=false;
    const stage=observation.stage || (provider==='openai'?'transcription':provider==='anthropic'?'ai':provider==='google'?'matching':'source');
    const rateKey=observation.rateKey || (provider==='openai'?'openai_mini_transcribe':provider==='anthropic'?'haiku':provider==='google'?'places_search':'source_extract');
    let spend;
    const telemetry=metrics.current() || jobContext.current()?.sharedMetrics;
    const record=(result,outcome,error)=>{
      telemetry?.providerCall({provider,stage,rateKey,outcome,
        tokens:usageFrom(result,error,provider), submittedAudioSeconds:observation.descriptor?.submittedAudioSeconds ?? observation.descriptor?.audioSeconds});
    };
    try {
      await assertActive();
      spend=beginProviderObservation({provider,stage,rateKey,descriptor:observation.descriptor,context:jobContext.current()});
      await jobContext.current()?.beforeProviderDispatch?.();
      await jobContext.current()?.sharedOperation?.authorizeDispatch({reservationId:spend.id});
      const invoke=async()=>{
        await jobContext.current()?.sharedOperation?.recheckMediaDispatch?.();
        await assertActive();
        // An observed late stop leaves the operation marker fenced but never
        // marks the unsent provider observation as a billed physical attempt.
        void spend.markDispatched();
        attempted=true;dispatched=true;
        return work({signal:jobContext.current()?.signal,deadline:jobContext.current()?.deadline});
      };
      const result=telemetry ? await telemetry.stage(stage,invoke) : await invoke();
      void spend.settle({result,dispatched:true});
      record(result,'success');attempted=false;
      // A bounded optional subtitle read may fail after usable metadata was
      // fetched. Preserve that evidence while still respecting a real 429.
      for(const diagnostic of (result?.subtitle_failures || []).slice(0,2)) await recordCooldown(provider,diagnostic);
      await assertActive();return result;
    }
    catch(error) {
      const e=asEngineError(error,{stage,provider});
      if(attempted) {void spend?.settle({error,dispatched:true});record(null,e.code==='rate_limited'?'rate_limited':'failed',error);}
      else if(spend && !dispatched) void spend.releaseUnsent();
      await recordCooldown(provider,e);
      throw e;
    }
  },{slots});
}
module.exports={withLease,withProvider,cooldownRemaining,MEDIA_STAGES};
