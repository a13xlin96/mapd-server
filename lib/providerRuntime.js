const {assertActive} = require('./jobContext');
const {randomUUID} = require('crypto');
const {redis} = require('./cache');
const {EngineError,asEngineError} = require('./engineError');
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
async function withProvider(provider, work, slots=1) {
  const check = async()=>{const remaining=await cooldownRemaining(provider);if(remaining)throw new EngineError('rate_limited',{stage:'admission',provider,retryAfterSeconds:remaining});};
  await assertActive();
  await check();
  return withLease(`provider:${provider}`,async()=>{
    await check();
    try {await assertActive();const result=await work();await assertActive();return result;}
    catch(error) {
      const e=asEngineError(error,{stage:'source',provider});
      if(e.code==='rate_limited') {
        const seconds=Math.max(1,e.retryAfterSeconds ?? 60), until=Date.now()+seconds*1000;
        if(redis) {try{await redis.set(`engine:cooldown:${provider}`,until,{ex:seconds});}catch{}}
        else cooldowns.set(provider,until);
      }
      throw e;
    }
  },{slots});
}
module.exports={withLease,withProvider,cooldownRemaining};
