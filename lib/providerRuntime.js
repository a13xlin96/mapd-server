const {assertActive} = require('./jobContext');
const {randomUUID} = require('crypto');
const {redis} = require('./cache');
const {EngineError,asEngineError} = require('./engineError');
const metrics = require('./engineMetrics');
const local = new Map(), cooldowns = new Map();
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
// This lease bounds admission, not authorization. Redis failures fail closed;
// the local fallback is only for an explicitly single-process installation.
async function withLease(key, work, {slots=1,waitMs=30000,leaseSeconds=90} = {}) {
  if(!redis && process.env.NODE_ENV==='production' && process.env.ENGINE_SINGLE_PROCESS!=='true') throw new EngineError('dependency_error',{stage:'coordination',provider:'redis'});
  const owner = randomUUID(), started = Date.now(); let held;
  do {
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
async function cooldownRemaining(provider) {
  let until;
  if (redis) {
    try {until = await redis.get(`engine:cooldown:${provider}`);} catch(e){throw asEngineError(e,{stage:'admission',provider:'redis'});}
  } else until = cooldowns.get(provider);
  return Math.max(0,Math.ceil((Number(until || 0)-Date.now())/1000));
}
async function recordCooldown(provider, error) {
  if(error?.code!=='rate_limited') return;
  metrics.current()?.operation('providerRejections',1);
  const seconds=Math.max(1,error.retryAfterSeconds ?? 60), until=Date.now()+seconds*1000;
  metrics.current()?.operation('cooldownMs',seconds*1000);
  if(redis) {try{await redis.set(`engine:cooldown:${provider}`,until,{ex:seconds});}catch{}}
  else cooldowns.set(provider,until);
}
async function withProvider(provider, work, slots=1, observation={}) {
  const check = async()=>{const remaining=await cooldownRemaining(provider);if(remaining)throw new EngineError('rate_limited',{stage:'admission',provider,retryAfterSeconds:remaining});};
  await assertActive();
  await check();
  return withLease(`provider:${provider}`,async()=>{
    await check();
    let attempted=false;
    const stage=observation.stage || (provider==='anthropic'?'ai':provider==='google'?'matching':'source');
    const record=(result,outcome)=>{
      const usage=result?.usage;
      metrics.current()?.providerCall({provider,stage,rateKey:observation.rateKey || (provider==='anthropic'?'haiku':provider==='google'?'places_search':'source_extract'),outcome,
        tokens:{input:usage?.input_tokens,output:usage?.output_tokens,cacheRead:usage?.cache_read_input_tokens,cacheWrite:usage?.cache_creation_input_tokens}});
    };
    try {
      await assertActive();attempted=true;
      const result=metrics.current() ? await metrics.current().stage(stage,work) : await work();
      record(result,'success');attempted=false;
      // A bounded optional subtitle read may fail after usable metadata was
      // fetched. Preserve that evidence while still respecting a real 429.
      for(const diagnostic of (result?.subtitle_failures || []).slice(0,2)) await recordCooldown(provider,diagnostic);
      await assertActive();return result;
    }
    catch(error) {
      const e=asEngineError(error,{stage:'source',provider});
      if(attempted) record(null,e.code==='rate_limited'?'rate_limited':'failed');
      await recordCooldown(provider,e);
      throw e;
    }
  },{slots});
}
module.exports={withLease,withProvider,cooldownRemaining};
