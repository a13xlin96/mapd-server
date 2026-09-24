jest.mock('../lib/cache', () => ({redis:null}));
jest.mock('../lib/firestore', () => ({firestore:null}));
jest.mock('../lib/engineBudget', () => ({beginProviderObservation:()=>({id:'synthetic',markDispatched(){},settle(){},releaseUnsent(){}})}));
const {FakeFirestore} = require('./helpers/fakeFirestore');
const job = require('../lib/jobContext');
const metrics = require('../lib/engineMetrics');
const {createSharedAiOperations,SERVER_PUBLIC_SCOPE} = require('../lib/sharedAiOperation');
const {withProvider} = require('../lib/providerRuntime');
const {EngineError} = require('../lib/engineError');
const gate = () => {let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve};};
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
const config = (kind='asr_chunk') => ({kind,provider:'openai',scope:SERVER_PUBLIC_SCOPE,input:{digest:'a'.repeat(64)},
  model:'synthetic',promptVersion:1,schemaVersion:1,optionsVersion:1,timeoutMs:2000,validate:r=>r?.ok===true});
const report = () => metrics.createMetrics();
const run = (operations,m,cfg,work) => job.run({deadline:Date.now()+3000,sharedMetrics:m},()=>operations.runSharedAiOperation(cfg,work));
const count = (value,key) => value.operations[key]?.sum || 0;

test('local and remote joins count once per caller while physical usage remains producer-only',async()=>{
  const db=new FakeFirestore();db.strictReadOrder=true;
  const first=createSharedAiOperations({firestore:db,limits:{pollMs:5}});
  const remote=createSharedAiOperations({firestore:db,limits:{pollMs:5}});
  const m=[report(),report(),report(),report(),report()], entered=gate(), release=gate();
  const paid=jest.fn(async()=>{entered.resolve();await release.promise;return {ok:true};});
  const work=()=>withProvider('openai',paid);
  const a=run(first,m[0],config(),work);await entered.promise;
  const b=run(first,m[1],config(),work), c=run(remote,m[2],config(),work), d=run(remote,m[3],config(),work);
  while(!remote.stats.followers)await wait(5);
  release.resolve();await Promise.all([a,b,c,d]);
  await run(remote,m[4],config(),work);
  const reports=m.map(value=>value.finish('success'));
  expect(reports.map(r=>count(r,'mediaCoalesced'))).toEqual([0,1,1,1,0]);
  expect(reports.map(r=>count(r,'mediaCacheHits'))).toEqual([0,0,0,0,1]);
  expect(reports.map(r=>r.providerCalls.length)).toEqual([1,0,0,0,0]);
  expect(paid).toHaveBeenCalledTimes(1);
});

test.each(['asr_chunk','video_vision','media_fusion'])('validated local artifact hit counts per %s invocation, with no provider calls',async kind=>{
  const cache={getCached:jest.fn(async()=>({ok:true})),setCache:jest.fn()};
  const operations=createSharedAiOperations({allowLocal:true,cache}), m=report(), work=jest.fn();
  await run(operations,m,config(kind),work);await run(operations,m,config(kind),work);
  const result=m.finish('success');
  expect(count(result,'mediaCacheHits')).toBe(2);expect(count(result,'mediaCoalesced')).toBe(0);
  expect(result.providerCalls).toEqual([]);expect(work).not.toHaveBeenCalled();
});

test('terminal failure reuse is not a cache hit and does not produce another physical observation',async()=>{
  const operations=createSharedAiOperations({firestore:new FakeFirestore()}), a=report(), b=report();
  const paid=jest.fn(async()=>{throw new EngineError('invalid_response');});
  const work=()=>withProvider('openai',paid);
  await expect(run(operations,a,config(),work)).rejects.toMatchObject({code:'invalid_response'});
  await expect(run(operations,b,config(),work)).rejects.toMatchObject({code:'invalid_response'});
  for(const r of [a.finish('failed'),b.finish('failed')]) {
    expect(count(r,'mediaCacheHits')).toBe(0);expect(count(r,'mediaCoalesced')).toBe(0);
  }
  expect(paid).toHaveBeenCalledTimes(1);
});

test('invalid artifacts and nonmedia cache returns do not increment media hits',async()=>{
  const m=report();
  const invalid=createSharedAiOperations({allowLocal:true,cache:{getCached:async()=>({ok:false})}});
  const work=jest.fn(async()=>({ok:true}));
  await run(invalid,m,config(),work);expect(work).toHaveBeenCalledTimes(1);
  const legacy=createSharedAiOperations({allowLocal:true,cache:{getCached:async()=>({ok:true})}});
  await run(legacy,m,config('caption'),work);
  const result=m.finish('success');expect(count(result,'mediaCacheHits')).toBe(0);
  expect(count(result,'mediaCoalesced')).toBe(0);
});
