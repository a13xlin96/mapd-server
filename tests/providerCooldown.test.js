jest.mock('../lib/cache', () => ({redis:null}));
const {createCooldownStore} = require('../lib/providerCooldown');
function serverClockRedis() {
  const state = {now:100000, until:0, expires:0};
  const redis = {eval:jest.fn(async (script, _keys, args) => {
    expect(script).toContain("redis.call('TIME')");
    if (state.expires <= state.now) state.until = 0;
    if (args.length) {
      expect(script).toContain('math.max(tonumber(old) or 0, now + tonumber(ARGV[1]))');
      expect(script).toContain("redis.call('PSETEX', KEYS[1], math.max(1, untilMs - now)");
      state.until = Math.max(state.until, state.now + args[0]);
      state.expires = state.until;
    }
    return Math.max(0, Math.ceil((state.until-state.now)/1000));
  })};
  return {state,redis};
}
test.each([[300,2],[2,300]])('atomic Redis max preserves %s then %s seconds despite worker clock skew', async (first,second) => {
  const {state,redis} = serverClockRedis();
  const a = createCooldownStore({redis, now:()=>-9999999});
  const b = createCooldownStore({redis, now:()=>99999999});
  await Promise.all([a.recordCooldown('anthropic',{code:'rate_limited',retryAfterSeconds:first}), b.recordCooldown('anthropic',{code:'rate_limited',retryAfterSeconds:second})]);
  expect(await a.cooldownRemaining('anthropic')).toBe(300);
  expect(state.expires).toBe(400000);
  state.now += 301000;
  expect(await b.cooldownRemaining('anthropic')).toBe(0);
  expect(redis.eval).toHaveBeenCalledTimes(4);
});
test('explicit local fallback preserves the max and expires without starting work',async()=>{
  let now=100;
  const store=createCooldownStore({now:()=>now,allowLocal:true});
  await store.recordCooldown('test',{code:'rate_limited',retryAfterSeconds:100});
  now+=1000;
  await store.recordCooldown('test',{code:'rate_limited',retryAfterSeconds:2});
  expect(await store.cooldownRemaining('test')).toBe(99);
  now+=99000;
  expect(await store.cooldownRemaining('test')).toBe(0);
});
test.each([undefined,NaN,'bad'])('missing/malformed retry-after %s defaults to 60 seconds',async value=>{
  const store=createCooldownStore({now:()=>0,allowLocal:true});
  await store.recordCooldown('a',{code:'rate_limited',retryAfterSeconds:value});
  expect(await store.cooldownRemaining('a')).toBe(60);
});
test('retry-after date, negative minimum and maximum retain existing bounds',async()=>{
  const store=createCooldownStore({now:()=>0,allowLocal:true});
  await store.recordCooldown('date',{code:'rate_limited',retryAfter:'Thu, 01 Jan 1970 00:02:00 GMT'});
  await store.recordCooldown('negative',{code:'rate_limited',retryAfterSeconds:-20});
  await store.recordCooldown('large',{code:'rate_limited',retryAfterSeconds:999999});
  expect(await store.cooldownRemaining('date')).toBe(120);
  expect(await store.cooldownRemaining('negative')).toBe(1);
  expect(await store.cooldownRemaining('large')).toBe(86400);
});
test('persistence failure surfaces and prevents local bypass until successfully persisted',async()=>{
  const {redis}=serverClockRedis();
  const store=createCooldownStore({redis,now:()=>0});
  const warning=jest.spyOn(console,'warn').mockImplementation(()=>{});
  redis.eval.mockRejectedValueOnce(new Error('outage'));
  await expect(store.recordCooldown('a',{code:'rate_limited',retryAfterSeconds:100})).rejects.toMatchObject({code:'dependency_error',stage:'coordination',provider:'redis'});
  await expect(store.cooldownRemaining('a')).rejects.toMatchObject({code:'dependency_error'});
  await store.recordCooldown('a',{code:'rate_limited',retryAfterSeconds:1});
  expect(await store.cooldownRemaining('a')).toBe(100);
  warning.mockRestore();
});
test('read outages and malformed Redis values fail closed',async()=>{
  for(const value of [undefined,'bad',-1]) {
    const store=createCooldownStore({redis:{eval:async()=>value},allowLocal:true});
    await expect(store.cooldownRemaining('a')).rejects.toMatchObject({provider:'redis'});
  }
  const store=createCooldownStore({redis:{eval:async()=>{throw new Error('down');}},allowLocal:true});
  await expect(store.cooldownRemaining('a')).rejects.toMatchObject({stage:'coordination'});
});
test('unconfigured production store needs explicit single-process fallback',async()=>{
  const env=process.env.NODE_ENV;
  process.env.NODE_ENV='production';
  try {
    await expect(createCooldownStore({allowLocal:false}).cooldownRemaining('a')).rejects.toMatchObject({stage:'coordination'});
    expect(await createCooldownStore({allowLocal:true}).cooldownRemaining('a')).toBe(0);
  } finally {process.env.NODE_ENV=env;}
});

test.each([false,true])('a failed long write is not erased by an in-flight short success (short first=%s)',async shortFirst=>{
  const gate=()=>{let release;return {promise:new Promise(r=>{release=r;}),release:()=>release()};};
  const long=gate(),short=gate();let now=1000,durableUntil=0;
  const redis={eval:jest.fn(async(_script,_keys,args)=>{
    if(!args.length)return Math.max(0,Math.ceil((durableUntil-now)/1000));
    if(args[0]===100000){await long.promise;throw Error('long failed');}
    await short.promise;durableUntil=Math.max(durableUntil,now+args[0]);return args[0]/1000;
  })};
  const store=createCooldownStore({redis,now:()=>now}),warning=jest.spyOn(console,'warn').mockImplementation(()=>{});
  try {
    const longer=store.recordCooldown('a',{code:'rate_limited',retryAfterSeconds:100}).catch(e=>e);
    const shorter=store.recordCooldown('a',{code:'rate_limited',retryAfterSeconds:1});
    expect(redis.eval.mock.calls.map(call=>call[2][0])).toEqual([100000,1000]);
    if(shortFirst){short.release();await shorter;long.release();}
    else {long.release();expect(await longer).toMatchObject({code:'dependency_error'});short.release();}
    await shorter;expect(await longer).toMatchObject({code:'dependency_error'});
    now+=2000;
    await expect(store.cooldownRemaining('a')).rejects.toMatchObject({code:'dependency_error'});
    // Recovery must persist the still-outstanding longer deadline.
    await store.recordCooldown('a',{code:'rate_limited',retryAfterSeconds:1});
    expect(await store.cooldownRemaining('a')).toBe(98);
  } finally {long.release();short.release();warning.mockRestore();}
});
